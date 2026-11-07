import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { beforeEach, describe, it, mock } from 'node:test';

process.env.TT_SECRET_KEY = 'test-key';
const { createApp } = await import('../src/app.ts');
const { setSimulatorDelays } = await import('../src/channels/simulator.ts');
const { parseWebhook, toCloudPayload } = await import('../src/channels/whatsapp.ts');
const { handleShopify, recordConversion, salesforceBase, syncConnector, tickConnectors, verifyShopify } = await import('../src/connectors.ts');
const { all, get, insert, openDb, run } = await import('../src/db.ts');
const { receiveInbound, send } = await import('../src/messaging.ts');
const { notify, setPushSender } = await import('../src/push.ts');
const { tick } = await import('../src/scheduler.ts');
const { encryptStoredSecrets, openSecret, sealSecret, vaultGet, vaultSet } = await import('../src/secrets.ts');
const { seedDemo } = await import('../src/seed.ts');

setSimulatorDelays({ delivered: 3_600_000, read: 3_600_000 });

let app: Awaited<ReturnType<typeof createApp>>;
const SECRET = 'app-secret';

async function login(email: string) {
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'tripletick' } });
  return r.headers['set-cookie'] as string;
}
const api = (cookie: string, method: any, url: string, payload?: object) => app.inject({ method, url, payload, headers: { cookie } });
const sim = () => get<any>("SELECT id FROM channels WHERE type = 'simulator' LIMIT 1").id;
const addWa = () => insert(
  "INSERT INTO channels(type, name, config, created_at) VALUES('whatsapp_cloud', 'WA', ?, 0)",
  sealSecret(JSON.stringify({ phoneNumberId: '123', appSecret: SECRET, accessToken: 'tok', wabaId: 'waba' })),
);

function metaWebhook(value: object) {
  const body = JSON.stringify({ entry: [{ changes: [{ field: 'calls', value: { metadata: { phone_number_id: '123' }, ...value } }] }] });
  return app.inject({
    method: 'POST', url: '/webhooks/whatsapp', payload: body,
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}` },
  });
}

function fakeFetch(res: (url: string, init: any) => Response = () => new Response('{}')) {
  const calls: { url: string; init: any; body: any }[] = [];
  const m = mock.method(globalThis, 'fetch', async (url: any, init: any) => {
    calls.push({ url: String(url), init, body: init?.body ? JSON.parse(init.body) : undefined });
    return res(String(url), init);
  });
  return { calls, restore: () => m.mock.restore() };
}

beforeEach(async () => {
  openDb(':memory:');
  seedDemo();
  app = await createApp();
});

describe('secrets', () => {
  it('round-trips, detects tampering and passes old plain values through', () => {
    const sealed = sealSecret('hello');
    assert.ok(!sealed.includes('hello'));
    assert.notEqual(sealed, sealSecret('hello'));
    assert.equal(openSecret(sealed), 'hello');
    assert.equal(openSecret('{"plain":true}'), '{"plain":true}');
    const raw = Buffer.from(sealed.slice(7), 'base64');
    raw[raw.length - 1] ^= 1;
    assert.throws(() => openSecret(`enc:v1:${raw.toString('base64')}`));
  });

  it('stores channel tokens encrypted and upgrades old rows', async () => {
    const admin = await login('demo@tripletick.local');
    await api(admin, 'POST', '/api/channels', { type: 'whatsapp_cloud', name: 'WA', config: { accessToken: 'super-secret' } });
    assert.ok(!all<any>('SELECT config FROM channels').some((c) => c.config.includes('super-secret')));
    run("INSERT INTO channels(type, name, config, created_at) VALUES('whatsapp_cloud', 'Old', '{\"accessToken\":\"old-secret\"}', 0)");
    encryptStoredSecrets();
    const row = get<any>("SELECT config FROM channels WHERE name = 'Old'");
    assert.ok(row.config.startsWith('enc:v1:'));
    assert.match(openSecret(row.config), /old-secret/);
    encryptStoredSecrets();
    assert.equal(get<any>("SELECT config FROM channels WHERE name = 'Old'").config, row.config);
  });

  it('never stores vault values in plain text', () => {
    vaultSet('k', 'value');
    assert.ok(!get<any>('SELECT value FROM vault').value.includes('value'));
    assert.equal(vaultGet('k'), 'value');
  });
});

describe('calls', () => {
  const ringFromMeta = (id = 'wacid.1') => metaWebhook({
    contacts: [{ wa_id: '15550777', profile: { name: 'Pat Caller' } }],
    calls: [{ id, from: '15550777', to: '15550100', event: 'connect', direction: 'USER_INITIATED', session: { sdp_type: 'offer', sdp: 'OFFER' } }],
  });

  it('answers with pre_accept then accept, using the same SDP', async () => {
    addWa();
    await ringFromMeta();
    const call = get<any>('SELECT * FROM calls');
    assert.equal(call.sdp_offer, 'OFFER');
    const admin = await login('demo@tripletick.local');
    const f = fakeFetch();
    const r = await api(admin, 'POST', `/api/calls/${call.id}/answer`, { sdp: 'ANSWER' });
    f.restore();
    assert.equal(r.statusCode, 200);
    assert.deepEqual(f.calls.map((c) => c.body.action), ['pre_accept', 'accept']);
    assert.match(f.calls[0].url, /\/123\/calls$/);
    assert.deepEqual(f.calls[0].body.session, { sdp_type: 'answer', sdp: 'ANSWER' });
    assert.deepEqual(f.calls[0].body.session, f.calls[1].body.session);
    assert.equal(f.calls[0].body.call_id, 'wacid.1');
    assert.equal(get<any>('SELECT status s FROM calls').s, 'active');
  });

  it('lets only one agent take a call', async () => {
    const admin = await login('demo@tripletick.local');
    const lead = await login('robin@tripletick.local');
    const { id } = (await api(admin, 'POST', '/api/simulator/call', { channelId: sim(), from: '+15550778', sdp: 'O' })).json();
    const [a, b] = await Promise.all([api(admin, 'POST', `/api/calls/${id}/answer`, { sdp: 'A' }), api(lead, 'POST', `/api/calls/${id}/answer`, { sdp: 'B' })]);
    assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 409]);
  });

  it('survives a terminate arriving before the connect', async () => {
    addWa();
    await metaWebhook({ calls: [{ id: 'wacid.2', from: '15550777', to: '1', event: 'terminate', direction: 'USER_INITIATED', status: 'COMPLETED' }] });
    await ringFromMeta('wacid.2');
    const c = all<any>('SELECT * FROM calls');
    assert.equal(c.length, 1);
    assert.equal(c[0].status, 'ended');
    assert.equal(c[0].outcome, 'missed');
  });

  it('places an outbound call and applies the answer from the webhook', async () => {
    const wa = addWa();
    const r = await receiveInbound({ channelId: wa, from: '+15550777', body: 'hi' });
    const admin = await login('demo@tripletick.local');
    const f = fakeFetch(() => new Response(JSON.stringify({ calls: [{ id: 'wacid.3' }] })));
    const res = await api(admin, 'POST', `/api/conversations/${r!.conversationId}/calls`, { sdp: 'OFFER' });
    f.restore();
    assert.equal(res.statusCode, 200);
    assert.equal(f.calls[0].body.action, 'connect');
    assert.equal(f.calls[0].body.to, '15550777');
    assert.equal(f.calls[0].body.session.sdp_type, 'offer');
    await metaWebhook({ calls: [{ id: 'wacid.3', from: '1', to: '15550777', event: 'connect', direction: 'BUSINESS_INITIATED', session: { sdp_type: 'answer', sdp: 'REMOTE' } }] });
    assert.equal(get<any>('SELECT sdp_answer s FROM calls').s, 'REMOTE');
    await metaWebhook({ statuses: [{ id: 'wacid.3', type: 'call', status: 'ACCEPTED' }] });
    assert.equal(get<any>('SELECT status s FROM calls').s, 'active');
    await metaWebhook({ calls: [{ id: 'wacid.3', from: '1', to: '15550777', event: 'terminate', direction: 'BUSINESS_INITIATED', status: 'COMPLETED' }] });
    assert.equal(get<any>('SELECT outcome o FROM calls').o, 'completed');
  });

  it('asks for permission when Meta refuses with 138006', async () => {
    const wa = addWa();
    const r = await receiveInbound({ channelId: wa, from: '+15550777', body: 'hi' });
    const admin = await login('demo@tripletick.local');
    const f = fakeFetch(() => new Response(JSON.stringify({ error: { code: 138006, message: 'no permission' } }), { status: 400 }));
    const res = await api(admin, 'POST', `/api/conversations/${r!.conversationId}/calls`, { sdp: 'O' });
    f.restore();
    assert.equal(res.statusCode, 422);
    assert.equal(res.json().code, 'call_permission_needed');
    assert.equal(get<any>('SELECT COUNT(*) n FROM calls').n, 0);
  });

  it('sends a real permission request to the customer', async () => {
    const wa = addWa();
    const r = await receiveInbound({ channelId: wa, from: '+15550777', body: 'hi' });
    const admin = await login('demo@tripletick.local');
    const f = fakeFetch(() => new Response(JSON.stringify({ messages: [{ id: 'wamid.P' }] })));
    const res = await api(admin, 'POST', `/api/conversations/${r!.conversationId}/call-permission`);
    f.restore();
    assert.equal(res.statusCode, 200);
    assert.equal(f.calls[0].body.interactive.type, 'call_permission_request');
    assert.equal(get<any>('SELECT kind k FROM messages ORDER BY id DESC LIMIT 1').k, 'call_permission');
  });

  it('stops ringing after a minute and rejects it on Meta', async () => {
    addWa();
    await ringFromMeta();
    const f = fakeFetch();
    await tick(Date.now() + 61e3);
    f.restore();
    assert.equal(get<any>('SELECT outcome o FROM calls').o, 'missed');
    assert.equal(f.calls[0].body.action, 'reject');
  });

  it('hides calls on chats an agent cannot see', async () => {
    const noorChat = get<any>("SELECT c.id FROM conversations c JOIN users u ON u.id = c.assignee_id WHERE u.name = 'Noor Agent'").id;
    const id = insert("INSERT INTO calls(conversation_id, direction, created_at) VALUES(?, 'in', ?)", noorChat, Date.now());
    const sky = await login('sky@tripletick.local');
    assert.equal((await api(sky, 'GET', `/api/calls/${id}`)).statusCode, 404);
    assert.equal((await api(sky, 'POST', `/api/calls/${id}/hangup`)).statusCode, 404);
    assert.ok(!(await api(sky, 'GET', '/api/calls/active')).json().some((c: any) => c.id === id));
  });

  it('keeps simulator call controls off real channels', async () => {
    const wa = addWa();
    const r = await receiveInbound({ channelId: wa, from: '+15550777', body: 'hi' });
    const id = insert("INSERT INTO calls(conversation_id, direction, created_at) VALUES(?, 'out', ?)", r!.conversationId, Date.now());
    const sky = await login('sky@tripletick.local');
    assert.equal((await api(sky, 'POST', `/api/simulator/calls/${id}/hangup`)).statusCode, 404);
    assert.equal((await api(sky, 'GET', `/api/simulator/calls?channelId=${wa}&from=%2B15550777`)).statusCode, 400);
  });

  it('builds call lists from consenting contacts and skips later opt-outs', async () => {
    const admin = await login('demo@tripletick.local');
    const { id, size } = (await api(admin, 'POST', '/api/call-lists', { name: 'L', channelId: sim() })).json();
    assert.equal(size, get<any>('SELECT COUNT(*) n FROM contacts WHERE opted_in = 1').n);
    const first = get<any>('SELECT contact_id c FROM call_list_items WHERE list_id = ? ORDER BY id LIMIT 1', id).c;
    run('UPDATE contacts SET opted_out_at = 1 WHERE id = ?', first);
    const next = (await api(admin, 'POST', `/api/call-lists/${id}/next`)).json();
    assert.ok(next.conversationId);
    assert.equal(get<any>('SELECT outcome o FROM call_list_items WHERE contact_id = ?', first).o, 'opted_out');
    await api(admin, 'POST', `/api/call-list-items/${next.itemId}/outcome`, { outcome: 'interested' });
    assert.equal(get<any>('SELECT state s FROM call_list_items WHERE id = ?', next.itemId).s, 'done');
  });
});

describe('forms', () => {
  const form = () => get<any>('SELECT id FROM forms LIMIT 1').id;

  it('builds a valid Flow message and parses the reply', async () => {
    const p: any = await toCloudPayload({} as any, { kind: 'flow', to: '+15550001', body: 'b', cta: 'Go', flowId: '9', screen: 'S', token: 't' });
    assert.equal(p.interactive.type, 'flow');
    assert.deepEqual(p.interactive.action.parameters, { flow_message_version: '3', flow_id: '9', flow_cta: 'Go', flow_token: 't', flow_action: 'navigate', flow_action_payload: { screen: 'S' } });
    const { messages } = parseWebhook({ entry: [{ changes: [{ value: { metadata: { phone_number_id: '1' }, messages: [{ from: '1', id: 'x', type: 'interactive', interactive: { type: 'nfm_reply', nfm_reply: { response_json: '{"flow_token":"t","city":"Pune"}' } } }] } }] }] });
    assert.deepEqual(messages[0].form, { city: 'Pune' });
  });

  it('saves answers to the contact and drops unsafe values', async () => {
    const r = await receiveInbound({ channelId: sim(), from: '+15550801', body: 'hi' });
    await send(r!.conversationId, { kind: 'form', formId: form() });
    await receiveInbound({ channelId: sim(), from: '+15550801', body: '', form: { shoe_size: '9', nested: { a: 1 }, 'bad<key>': 'x' } });
    const fields = JSON.parse(get<any>("SELECT fields f FROM contacts WHERE phone = '+15550801'").f);
    assert.deepEqual(fields, { shoe_size: '9' });
  });

  it('refuses to send an unlinked form on real WhatsApp', async () => {
    const r = await receiveInbound({ channelId: addWa(), from: '+15550777', body: 'hi' });
    await assert.rejects(send(r!.conversationId, { kind: 'form', formId: form() }), { code: 'form_not_linked' });
  });

  it('runs as a bot step', async () => {
    const graph = { nodes: [{ id: 's', type: 'start', data: {} }, { id: 'f', type: 'form', data: { formId: form() } }, { id: 'm', type: 'message', data: { text: 'Size {{shoe_size}}' } }], edges: [{ source: 's', target: 'f' }, { source: 'f', target: 'm' }] };
    run('UPDATE bots SET enabled = 0');
    insert("INSERT INTO bots(name, enabled, trigger, graph, created_at) VALUES('f', 1, '{\"type\":\"keyword\",\"keywords\":[\"book\"]}', ?, 0)", JSON.stringify(graph));
    await receiveInbound({ channelId: sim(), from: '+15550802', body: 'book' });
    await receiveInbound({ channelId: sim(), from: '+15550802', body: '', form: { shoe_size: '10' } });
    assert.equal(get<any>("SELECT body FROM messages WHERE direction = 'out' ORDER BY id DESC LIMIT 1").body, 'Size 10');
  });
});

describe('Meta conversions', () => {
  const capi = () => insert("INSERT INTO connectors(type, name, config, created_at) VALUES('meta_capi', 'c', ?, 0)", sealSecret(JSON.stringify({ datasetId: 'ds1', accessToken: 'tok', wabaId: 'waba1' })));
  const contact = (fields: object) => insert("INSERT INTO contacts(phone, fields, created_at) VALUES('+15550901', ?, 0)", JSON.stringify(fields));

  it('sends the click id, unhashed, with business messaging fields', async () => {
    capi();
    const f = fakeFetch();
    const r = await recordConversion({ contactId: contact({ ctwa_clid: 'CLICK' }), eventName: 'Purchase', value: 20, currency: 'USD', source: 'agent' });
    f.restore();
    assert.equal(r.metaStatus, 'sent');
    assert.match(f.calls[0].url, /\/ds1\/events$/);
    const e = f.calls[0].body.data[0];
    assert.equal(e.action_source, 'business_messaging');
    assert.equal(e.messaging_channel, 'whatsapp');
    assert.deepEqual(e.user_data, { whatsapp_business_account_id: 'waba1', ctwa_clid: 'CLICK' });
    assert.deepEqual(e.custom_data, { currency: 'USD', value: 20 });
  });

  it('never tells Meta about chats that did not come from an ad', async () => {
    capi();
    const f = fakeFetch();
    const r = await recordConversion({ contactId: contact({}), eventName: 'Purchase', value: 1, currency: 'USD', source: 'agent' });
    f.restore();
    assert.equal(r.metaStatus, 'no_ad_click');
    assert.equal(f.calls.length, 0);
  });

  it('captures the click id from an ad referral', async () => {
    const { messages } = parseWebhook({ entry: [{ changes: [{ value: { metadata: {}, messages: [{ from: '1', id: 'x', type: 'text', text: { body: 'hi' }, referral: { source_type: 'ad', ctwa_clid: 'CLK' } }] } }] }] });
    await receiveInbound({ channelId: sim(), from: '+15550902', body: 'hi', referral: messages[0].referral });
    assert.equal(JSON.parse(get<any>("SELECT fields f FROM contacts WHERE phone = '+15550902'").f).ctwa_clid, 'CLK');
  });
});

describe('connectors', () => {
  const add = (type: string, cfg: object) => {
    const id = insert('INSERT INTO connectors(type, name, config, created_at) VALUES(?, ?, ?, 0)', type, type, sealSecret(JSON.stringify(cfg)));
    return get<any>('SELECT * FROM connectors WHERE id = ?', id);
  };

  it('upserts to HubSpot in batches, skipping contacts without email', async () => {
    const c = add('hubspot', { accessToken: 'hs' });
    const f = fakeFetch();
    await syncConnector(c);
    f.restore();
    assert.match(f.calls[0].url, /batch\/upsert$/);
    assert.equal(f.calls[0].init.headers.authorization, 'Bearer hs');
    assert.ok(f.calls[0].body.inputs.every((i: any) => i.idProperty === 'email' && i.id));
    const maya = f.calls[0].body.inputs.find((i: any) => i.id === 'maya@example.com');
    assert.equal(maya.properties.firstname, 'Maya');
    assert.equal(maya.properties.lastname, 'Fictional');
    assert.match(get<any>('SELECT last_status s FROM connectors').s, /^Synced/);
  });

  it('records a CRM failure instead of crashing', async () => {
    const c = add('zoho', { accessToken: 'z', region: 'com' });
    const f = fakeFetch(() => new Response('bad token', { status: 401 }));
    await syncConnector(c);
    f.restore();
    assert.match(f.calls[0].url, /zohoapis\.com\/crm\/v6\/Contacts\/upsert/);
    assert.match(get<any>('SELECT last_status s FROM connectors').s, /^Failed.*401/);
  });

  it('only sends a Salesforce token to Salesforce', () => {
    assert.equal(salesforceBase('https://acme.my.salesforce.com/x'), 'https://acme.my.salesforce.com');
    for (const bad of ['http://acme.salesforce.com', 'https://evil.com', 'https://salesforce.com.evil.com']) assert.throws(() => salesforceBase(bad));
  });

  it('auto-syncs at most hourly', async () => {
    add('hubspot', { accessToken: 'hs' });
    const f = fakeFetch();
    await tickConnectors();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 20));
    const n = f.calls.length;
    await tickConnectors();
    await new Promise((r) => setTimeout(r, 20));
    f.restore();
    assert.ok(n >= 1);
    assert.equal(f.calls.length, n);
  });

  it('verifies Shopify signatures end to end', async () => {
    const c = add('shopify', { secret: 'shh' });
    const body = JSON.stringify({ phone: '+15550950', token: 't1', buyer_accepts_marketing: false });
    const headers = { 'content-type': 'application/json', 'x-shopify-topic': 'checkouts/create' };
    const hmac = createHmac('sha256', 'shh').update(body).digest('base64');
    assert.ok(verifyShopify(Buffer.from(body), hmac, 'shh'));
    assert.equal((await app.inject({ method: 'POST', url: `/hooks/shopify/${c.id}`, payload: body, headers: { ...headers, 'x-shopify-hmac-sha256': 'bad' } })).statusCode, 401);
    assert.equal(get<any>('SELECT COUNT(*) n FROM carts').n, 0);
    assert.equal((await app.inject({ method: 'POST', url: `/hooks/shopify/${c.id}`, payload: body, headers: { ...headers, 'x-shopify-hmac-sha256': hmac } })).statusCode, 200);
    assert.equal(get<any>('SELECT COUNT(*) n FROM carts').n, 1);
  });

  describe('abandoned carts', () => {
    const shop = () => add('shopify', { secret: 's', channelId: sim(), cartTemplateId: get<any>('SELECT id FROM templates LIMIT 1').id, cartDelayMinutes: 1 });
    const later = () => Date.now() + 120e3;

    it('reminds a consenting customer after the delay', async () => {
      const c = shop();
      await handleShopify(c, 'checkouts/create', { phone: '+15550951', token: 'a', buyer_accepts_marketing: true, abandoned_checkout_url: 'https://x/y' });
      await tickConnectors(Date.now());
      assert.equal(get<any>('SELECT state s FROM carts').s, 'pending');
      await tickConnectors(later());
      assert.equal(get<any>('SELECT state s FROM carts').s, 'sent');
      assert.equal(JSON.parse(get<any>("SELECT fields f FROM contacts WHERE phone = '+15550951'").f).cart_url, 'https://x/y');
    });

    it('skips customers without consent', async () => {
      await handleShopify(shop(), 'checkouts/create', { phone: '+15550952', token: 'b', buyer_accepts_marketing: false });
      await tickConnectors(later());
      assert.equal(get<any>('SELECT state s FROM carts').s, 'skipped');
    });

    it('cancels the reminder when they buy', async () => {
      const c = shop();
      await handleShopify(c, 'checkouts/create', { phone: '+15550953', token: 'c', buyer_accepts_marketing: true });
      await handleShopify(c, 'orders/create', { phone: '+15550953', checkout_token: 'c', total_price: '40.00', currency: 'EUR', name: '#1001' });
      await tickConnectors(later());
      assert.equal(get<any>('SELECT state s FROM carts').s, 'recovered');
      const conv = get<any>('SELECT * FROM conversions');
      assert.equal(conv.value, 40);
      assert.equal(conv.source, 'shopify');
      assert.equal(conv.meta_status, 'not_sent');
    });

    it('cannot override a STOP through the marketing checkbox', async () => {
      insert("INSERT INTO contacts(phone, opted_out_at, created_at) VALUES('+15550954', 1, 0)");
      await handleShopify(shop(), 'checkouts/create', { phone: '+15550954', token: 'd', buyer_accepts_marketing: true });
      await tickConnectors(later());
      assert.equal(get<any>('SELECT opted_in i FROM contacts WHERE phone = ?', '+15550954').i, 0);
      assert.equal(get<any>('SELECT state s FROM carts').s, 'skipped');
    });
  });

  it('accepts contacts through an inbound hook only with the token', async () => {
    const admin = await login('demo@tripletick.local');
    const { path } = (await api(admin, 'POST', '/api/connectors', { type: 'inbound', name: 'Tally' })).json();
    assert.equal((await app.inject({ method: 'POST', url: '/hooks/in/wrong', payload: { phone: '+15550960' } })).statusCode, 404);
    const r = await app.inject({ method: 'POST', url: path, payload: { phone: '+15550960', name: 'Tess', tags: ['tally'], fields: { plan: 'pro' } } });
    assert.equal(r.statusCode, 200);
    const c = get<any>("SELECT * FROM contacts WHERE phone = '+15550960'");
    assert.equal(c.opted_in, 0);
    assert.deepEqual(JSON.parse(c.tags), ['tally']);
    assert.equal(JSON.parse(c.fields).plan, 'pro');
  });

  it('never returns connector secrets, and keeps them away from agents', async () => {
    const admin = await login('demo@tripletick.local');
    await api(admin, 'POST', '/api/connectors', { type: 'hubspot', name: 'H', config: { accessToken: 'very-secret' } });
    assert.ok(!(await api(admin, 'GET', '/api/connectors')).body.includes('very-secret'));
    assert.ok(!get<any>('SELECT config c FROM connectors').c.includes('very-secret'));
    const sky = await login('sky@tripletick.local');
    assert.equal((await api(sky, 'GET', '/api/connectors')).statusCode, 403);
  });
});

describe('push', () => {
  const subscribeUser = (userId: number, endpoint: string) => run('INSERT INTO push_subscriptions(user_id, endpoint, keys) VALUES(?, ?, ?)', userId, endpoint, '{"p256dh":"a","auth":"b"}');

  it('notifies without including message text, and drops dead subscriptions', async () => {
    const sent: string[] = [];
    setPushSender(async (sub, payload) => {
      if (sub.endpoint.includes('dead')) throw Object.assign(new Error('gone'), { statusCode: 410 });
      sent.push(payload);
    });
    subscribeUser(1, 'https://push.example/live');
    subscribeUser(1, 'https://push.example/dead');
    await receiveInbound({ channelId: sim(), from: '+15550970', name: 'Pat', body: 'my secret order details' });
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(sent.length >= 1);
    assert.ok(sent.every((s) => !s.includes('secret order')));
    assert.match(sent[0], /New message from Pat/);
    assert.equal(get<any>('SELECT COUNT(*) n FROM push_subscriptions').n, 1);
  });

  it('only notifies the chosen users', async () => {
    const sent: string[] = [];
    setPushSender(async (sub) => { sent.push(sub.endpoint); });
    subscribeUser(1, 'https://push.example/a');
    subscribeUser(2, 'https://push.example/b');
    await notify([2], { title: 't', url: '/' });
    assert.deepEqual(sent, ['https://push.example/b']);
  });

  it('rejects non-https push endpoints', async () => {
    const admin = await login('demo@tripletick.local');
    const r = await api(admin, 'POST', '/api/push/subscribe', { endpoint: 'http://localhost/x', keys: { p256dh: 'a', auth: 'b' } });
    assert.equal(r.statusCode, 400);
  });
});
