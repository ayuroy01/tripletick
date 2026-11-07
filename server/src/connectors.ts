import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { config } from './config.ts';
import { all, audit, get, insert, parse, run } from './db.ts';
import { emitWebhook } from './events.ts';
import { admins, fail } from './http.ts';
import { ensureConversation, normalizePhone, send, upsertContact } from './messaging.ts';
import { openSecret, sealSecret } from './secrets.ts';

interface Connector { id: number; type: string; name: string; config: string; enabled: number; last_status: string | null; last_synced_at: number | null }
interface Contact { id: number; name: string; phone: string; email: string }

const SECRET_KEYS = ['accessToken', 'secret', 'token'];
const SYNC_EVERY_MS = 3600e3;
const TYPES = ['hubspot', 'salesforce', 'zoho', 'shopify', 'inbound', 'meta_capi'];
const ZOHO_REGIONS = ['com', 'eu', 'in', 'com.au', 'jp', 'ca', 'sa'];

const cfg = <T = Record<string, any>>(c: Connector) => parse<T>(openSecret(c.config), {} as T);

function publicConnector(c: Connector) {
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cfg(c))) safe[k] = SECRET_KEYS.includes(k) ? !!v : v;
  return { ...c, config: safe };
}

const splitName = (name: string) => {
  const [first, ...rest] = name.trim().split(/\s+/);
  return { first: rest.length ? first : '', last: rest.join(' ') || first || 'Unknown' };
};

async function request(url: string, init: RequestInit) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`${new URL(url).host} returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res;
}

const chunks = <T>(items: T[], size: number) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

/** The URL is checked here because it's used with a stored token. It must stay on Salesforce. */
export function salesforceBase(instanceUrl: string) {
  const u = new URL(instanceUrl);
  if (u.protocol !== 'https:' || !/\.(salesforce|force)\.com$/.test(u.hostname)) throw new Error('The instance URL must be an https salesforce.com address');
  return u.origin;
}

const pushers: Record<string, (c: Record<string, any>, contacts: Contact[]) => Promise<number>> = {
  async hubspot(c, contacts) {
    const withEmail = contacts.filter((k) => k.email);
    for (const batch of chunks(withEmail, 100)) {
      await request('https://api.hubapi.com/crm/v3/objects/contacts/batch/upsert', {
        method: 'POST',
        headers: { authorization: `Bearer ${c.accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          inputs: batch.map((k) => {
            const n = splitName(k.name);
            return { id: k.email, idProperty: 'email', properties: { email: k.email, firstname: n.first, lastname: n.last, phone: k.phone } };
          }),
        }),
      });
    }
    return withEmail.length;
  },
  async zoho(c, contacts) {
    if (!ZOHO_REGIONS.includes(c.region)) throw new Error('Unknown Zoho region');
    const withEmail = contacts.filter((k) => k.email);
    for (const batch of chunks(withEmail, 100)) {
      await request(`https://www.zohoapis.${c.region}/crm/v6/Contacts/upsert`, {
        method: 'POST',
        headers: { authorization: `Zoho-oauthtoken ${c.accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          duplicate_check_fields: ['Email'],
          data: batch.map((k) => {
            const n = splitName(k.name);
            return { First_Name: n.first, Last_Name: n.last, Email: k.email, Phone: k.phone };
          }),
        }),
      });
    }
    return withEmail.length;
  },
  /** Upserts by the TripleTick_Id__c external ID field, which must exist on Contact. */
  async salesforce(c, contacts) {
    const base = salesforceBase(c.instanceUrl);
    for (const k of contacts) {
      const n = splitName(k.name);
      await request(`${base}/services/data/v62.0/sobjects/Contact/TripleTick_Id__c/${k.id}`, {
        method: 'PATCH',
        headers: { authorization: `Bearer ${c.accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ FirstName: n.first, LastName: n.last, Phone: k.phone, ...(k.email ? { Email: k.email } : {}) }),
      });
    }
    return contacts.length;
  },
};

const syncing = new Set<number>();

export async function syncConnector(c: Connector) {
  const push = pushers[c.type];
  if (!push || syncing.has(c.id)) return;
  syncing.add(c.id);
  try {
    const n = await push(cfg(c), all<Contact>('SELECT id, name, phone, email FROM contacts'));
    run('UPDATE connectors SET last_status = ?, last_synced_at = ? WHERE id = ?', `Synced ${n} contacts`, Date.now(), c.id);
  } catch (e) {
    run('UPDATE connectors SET last_status = ?, last_synced_at = ? WHERE id = ?', `Failed: ${(e as Error).message}`, Date.now(), c.id);
  } finally {
    syncing.delete(c.id);
  }
}

/** Scheduler entry: hourly CRM sync and abandoned cart follow-ups. */
export async function tickConnectors(now = Date.now()) {
  for (const c of all<Connector>("SELECT * FROM connectors WHERE enabled = 1 AND type IN ('hubspot', 'zoho', 'salesforce') AND COALESCE(last_synced_at, 0) <= ?", now - SYNC_EVERY_MS)) {
    void syncConnector(c);
  }
  for (const cart of all<any>("SELECT * FROM carts WHERE state = 'pending' AND due_at <= ?", now)) {
    const connector = get<Connector>('SELECT * FROM connectors WHERE id = ? AND enabled = 1', cart.connector_id);
    const shop = connector ? cfg(connector) : {};
    const contact = get<any>('SELECT opted_in, opted_out_at FROM contacts WHERE id = ?', cart.contact_id);
    if (!shop.cartTemplateId || !shop.channelId || !contact?.opted_in || contact.opted_out_at) {
      run("UPDATE carts SET state = 'skipped' WHERE id = ?", cart.id);
      continue;
    }
    run("UPDATE carts SET state = 'sent' WHERE id = ?", cart.id);
    await send(ensureConversation(cart.contact_id, Number(shop.channelId)), { kind: 'template', templateId: Number(shop.cartTemplateId) }, { via: 'api' })
      .catch((e) => run("UPDATE carts SET state = 'failed' WHERE id = ?", cart.id) && console.warn(`Cart reminder failed: ${e.message}`));
  }
}

export function verifyShopify(raw: Buffer, header: unknown, secret: string) {
  if (typeof header !== 'string' || !secret) return false;
  const expected = createHmac('sha256', secret).update(raw).digest();
  const actual = Buffer.from(header, 'base64');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const shopifyPhone = (o: any): string =>
  normalizePhone(o.phone || o.customer?.phone || o.billing_address?.phone || o.shipping_address?.phone || '');

function shopifyContact(o: any, phone: string) {
  const name = [o.customer?.first_name, o.customer?.last_name].filter(Boolean).join(' ');
  const id = upsertContact(phone, name);
  const email = o.email || o.customer?.email;
  if (email) run("UPDATE contacts SET email = ? WHERE id = ? AND email = ''", String(email), id);
  // Shopify's marketing checkbox is real consent, but it can never override a STOP.
  if (o.buyer_accepts_marketing) run('UPDATE contacts SET opted_in = 1 WHERE id = ? AND opted_out_at IS NULL', id);
  return id;
}

function mergeFields(contactId: number, fields: Record<string, string>) {
  const c = get<{ fields: string }>('SELECT fields FROM contacts WHERE id = ?', contactId)!;
  run('UPDATE contacts SET fields = ? WHERE id = ?', JSON.stringify({ ...parse(c.fields, {}), ...fields }), contactId);
}

export async function handleShopify(c: Connector, topic: string, o: any) {
  const shop = cfg(c);
  const phone = shopifyPhone(o);
  if (!phone) return;
  if (topic === 'checkouts/create' || topic === 'checkouts/update') {
    if (o.completed_at || !o.token) return;
    const id = shopifyContact(o, phone);
    mergeFields(id, { cart_url: String(o.abandoned_checkout_url ?? ''), cart_total: String(o.total_price ?? '') });
    run(
      'INSERT OR IGNORE INTO carts(connector_id, token, contact_id, due_at) VALUES(?, ?, ?, ?)',
      c.id, String(o.token), id, Date.now() + Number(shop.cartDelayMinutes || 60) * 60e3,
    );
  } else if (topic === 'orders/create') {
    const id = shopifyContact(o, phone);
    if (o.checkout_token) run("UPDATE carts SET state = 'recovered' WHERE connector_id = ? AND token = ? AND state = 'pending'", c.id, String(o.checkout_token));
    mergeFields(id, { last_order: String(o.name ?? ''), last_order_total: String(o.total_price ?? '') });
    // Meta wants website sales on the web Conversions API, so this one stays in Triple Tick's own reports.
    await recordConversion({ contactId: id, eventName: 'Purchase', value: Number(o.total_price) || 0, currency: String(o.currency || 'USD'), source: 'shopify' });
    const contact = get<any>('SELECT opted_in, opted_out_at FROM contacts WHERE id = ?', id);
    if (shop.orderTemplateId && shop.channelId && contact.opted_in && !contact.opted_out_at) {
      await send(ensureConversation(id, Number(shop.channelId)), { kind: 'template', templateId: Number(shop.orderTemplateId) }, { via: 'api' })
        .catch((e) => console.warn(`Order message failed: ${e.message}`));
    }
  }
}

interface ConversionInput { conversationId?: number; contactId: number; eventName: string; value: number; currency: string; source: string }

/** Always saved locally. Sent to Meta only for chats that really came from a click-to-WhatsApp ad. */
export async function recordConversion(input: ConversionInput) {
  const id = insert(
    'INSERT INTO conversions(conversation_id, contact_id, event_name, value, currency, source, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)',
    input.conversationId ?? null, input.contactId, input.eventName, input.value, input.currency, input.source, Date.now(),
  );
  emitWebhook('conversion.created', { id, ...input });
  let metaStatus = 'not_sent';
  const capi = get<Connector>("SELECT * FROM connectors WHERE type = 'meta_capi' AND enabled = 1 LIMIT 1");
  const clickId = parse<Record<string, string>>(get<{ fields: string }>('SELECT fields FROM contacts WHERE id = ?', input.contactId)?.fields, {}).ctwa_clid;
  if (capi && input.source === 'agent') {
    if (!clickId) metaStatus = 'no_ad_click';
    else {
      const c = cfg(capi);
      try {
        await request(`https://graph.facebook.com/${config.graphVersion}/${encodeURIComponent(c.datasetId)}/events`, {
          method: 'POST',
          headers: { authorization: `Bearer ${c.accessToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            data: [{
              event_name: input.eventName, event_time: Math.floor(Date.now() / 1000), event_id: `tt_${id}`,
              action_source: 'business_messaging', messaging_channel: 'whatsapp',
              user_data: { whatsapp_business_account_id: c.wabaId, ctwa_clid: clickId },
              custom_data: { currency: input.currency, value: input.value },
            }],
          }),
        });
        metaStatus = 'sent';
      } catch (e) {
        metaStatus = 'failed';
        console.warn(`Conversions API failed: ${(e as Error).message}`);
      }
    }
  }
  run('UPDATE conversions SET meta_status = ? WHERE id = ?', metaStatus, id);
  return { id, metaStatus };
}

export function registerConnectorRoutes(app: FastifyInstance) {
  app.get('/api/connectors', { preHandler: admins }, () => all<Connector>('SELECT * FROM connectors ORDER BY id DESC').map(publicConnector));

  app.post('/api/connectors', { preHandler: admins }, (req) => {
    const b = req.body as any;
    if (!TYPES.includes(b.type)) fail(400, 'Unknown connector');
    const settings: Record<string, unknown> = { ...b.config };
    if (b.type === 'salesforce') {
      try { settings.instanceUrl = salesforceBase(String(settings.instanceUrl)); } catch (e) { fail(400, (e as Error).message); }
    }
    if (b.type === 'zoho' && !ZOHO_REGIONS.includes(String(settings.region))) fail(400, 'Unknown Zoho region');
    if (b.type === 'inbound') settings.token = randomBytes(24).toString('base64url');
    const id = insert('INSERT INTO connectors(type, name, config, created_at) VALUES(?, ?, ?, ?)', b.type, String(b.name || b.type), sealSecret(JSON.stringify(settings)), Date.now());
    audit(req.user.id, 'connectors.create', b.type);
    const path = b.type === 'inbound' ? `/hooks/in/${settings.token}` : b.type === 'shopify' ? `/hooks/shopify/${id}` : undefined;
    return { id, path };
  });

  app.post('/api/connectors/:id/sync', { preHandler: admins }, async (req) => {
    const c = get<Connector>('SELECT * FROM connectors WHERE id = ?', Number((req.params as any).id)) ?? fail(404, 'Connector not found');
    if (!pushers[c.type]) fail(400, 'This connector does not sync contacts');
    await syncConnector(c);
    return publicConnector(get<Connector>('SELECT * FROM connectors WHERE id = ?', c.id)!);
  });

  app.delete('/api/connectors/:id', { preHandler: admins }, (req) => {
    run('DELETE FROM connectors WHERE id = ?', Number((req.params as any).id));
    audit(req.user.id, 'connectors.delete');
    return { ok: true };
  });

  app.post('/hooks/shopify/:id', async (req, reply) => {
    const c = get<Connector>("SELECT * FROM connectors WHERE id = ? AND type = 'shopify' AND enabled = 1", Number((req.params as any).id));
    if (!c || !verifyShopify(req.rawBody ?? Buffer.alloc(0), req.headers['x-shopify-hmac-sha256'], cfg(c).secret)) {
      return reply.status(401).send({ error: 'Bad signature' });
    }
    await handleShopify(c, String(req.headers['x-shopify-topic'] ?? ''), req.body);
    return { ok: true };
  });

  /** A universal door for Tally, Pabbly, Zapier, Make, Google Sheets scripts, or your own code. */
  app.post('/hooks/in/:token', (req, reply) => {
    const given = Buffer.from(String((req.params as any).token));
    const c = all<Connector>("SELECT * FROM connectors WHERE type = 'inbound' AND enabled = 1").find((x) => {
      const want = Buffer.from(String(cfg(x).token ?? ''));
      return want.length === given.length && timingSafeEqual(want, given);
    });
    if (!c) return reply.status(404).send({ error: 'Not found' });
    const b = req.body as any;
    if (!normalizePhone(String(b.phone ?? ''))) return reply.status(400).send({ error: 'A phone number is required' });
    const id = upsertContact(String(b.phone), String(b.name ?? ''));
    const existing = get<any>('SELECT * FROM contacts WHERE id = ?', id);
    const tags = [...new Set([...parse<string[]>(existing.tags, []), ...(Array.isArray(b.tags) ? b.tags.map(String) : [])])];
    run(
      "UPDATE contacts SET email = CASE WHEN ? != '' THEN ? ELSE email END, tags = ?, opted_in = CASE WHEN ? AND opted_out_at IS NULL THEN 1 ELSE opted_in END WHERE id = ?",
      String(b.email ?? ''), String(b.email ?? ''), JSON.stringify(tags), b.opted_in === true ? 1 : 0, id,
    );
    if (b.fields && typeof b.fields === 'object') mergeFields(id, Object.fromEntries(Object.entries(b.fields).map(([k, v]) => [k, String(v)])));
    return { id };
  });
}
