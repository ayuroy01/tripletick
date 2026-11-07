import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { config } from '../config.ts';
import { channelConfig, type Channel, type ChannelAdapter, type Outbound } from './index.ts';

export interface WhatsAppConfig { phoneNumberId: string; wabaId: string; accessToken: string; appSecret: string; verifyToken: string }

const graph = (path: string) => `https://graph.facebook.com/${config.graphVersion}/${path}`;

async function call(cfg: WhatsAppConfig, path: string, init: RequestInit = {}) {
  const res = await fetch(graph(path), {
    ...init,
    headers: { authorization: `Bearer ${cfg.accessToken}`, ...init.headers },
    signal: AbortSignal.timeout(20000),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json?.error?.message ?? `WhatsApp API returned ${res.status}`), { code: json?.error?.code });
  return json;
}

const postJson = (cfg: WhatsAppConfig, path: string, body: unknown) =>
  call(cfg, path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function uploadMedia(cfg: WhatsAppConfig, m: Extract<Outbound, { kind: 'media' }>): Promise<string> {
  const form = new FormData();
  form.set('messaging_product', 'whatsapp');
  form.set('file', new Blob([await readFile(m.filePath)], { type: m.mime }), m.fileName);
  return (await call(cfg, `${cfg.phoneNumberId}/media`, { method: 'POST', body: form })).id;
}

/** Builds the Cloud API message body. WhatsApp allows at most 3 reply buttons of 20 characters. */
export async function toCloudPayload(cfg: WhatsAppConfig, m: Outbound) {
  const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to: m.to.replace(/\D/g, '') };
  switch (m.kind) {
    case 'text':
      return { ...base, type: 'text', text: { body: m.body, preview_url: true } };
    case 'media': {
      const id = await uploadMedia(cfg, m);
      return m.mime.startsWith('image/')
        ? { ...base, type: 'image', image: { id, caption: m.body } }
        : { ...base, type: 'document', document: { id, caption: m.body, filename: m.fileName } };
    }
    case 'buttons':
      return {
        ...base,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: m.body },
          action: { buttons: m.options.slice(0, 3).map((title, i) => ({ type: 'reply', reply: { id: `opt_${i}`, title: title.slice(0, 20) } })) },
        },
      };
    case 'flow':
      return {
        ...base,
        type: 'interactive',
        interactive: {
          type: 'flow',
          body: { text: m.body },
          action: {
            name: 'flow',
            parameters: {
              flow_message_version: '3', flow_id: m.flowId, flow_cta: m.cta, flow_token: m.token, flow_action: 'navigate',
              ...(m.screen ? { flow_action_payload: { screen: m.screen } } : {}),
            },
          },
        },
      };
    case 'call_permission':
      return { ...base, type: 'interactive', interactive: { type: 'call_permission_request', body: { text: m.body }, action: { name: 'call_permission_request' } } };
    case 'template':
      return {
        ...base,
        type: 'template',
        template: {
          name: m.name,
          language: { code: m.language },
          components: m.params.length ? [{ type: 'body', parameters: m.params.map((text) => ({ type: 'text', text })) }] : [],
        },
      };
  }
}

export const whatsappCloud: ChannelAdapter = {
  async send(channel: Channel, message: Outbound) {
    const cfg = channelConfig<WhatsAppConfig>(channel);
    const res = await postJson(cfg, `${cfg.phoneNumberId}/messages`, await toCloudPayload(cfg, message));
    return { externalId: res.messages?.[0]?.id ?? '' };
  },
};

/** Meta signs the raw body with the app secret. The comparison must be constant time. */
export function verifySignature(raw: Buffer, header: unknown, appSecret: string): boolean {
  if (typeof header !== 'string' || !appSecret) return false;
  const expected = Buffer.from(`sha256=${createHmac('sha256', appSecret).update(raw).digest('hex')}`);
  const actual = Buffer.from(header);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export interface ParsedInbound {
  phoneNumberId: string; from: string; name: string; externalId: string;
  kind: 'text' | 'media'; body: string; mediaId?: string; mime?: string; fileName?: string;
  referral?: { source: string; headline: string; clickId?: string };
  form?: Record<string, unknown>;
}
export interface ParsedCall { phoneNumberId: string; externalId: string; event: string; direction: string; from: string; to: string; name: string; sdp?: string; status?: string }
export interface ParsedCallStatus { externalId: string; status: string }
export interface ParsedStatus { externalId: string; status: string; error?: string }

/** Flattens a Cloud API webhook into inbound messages and delivery statuses. */
export function parseWebhook(payload: any) {
  const messages: ParsedInbound[] = [];
  const statuses: ParsedStatus[] = [];
  const calls: ParsedCall[] = [];
  const callStatuses: ParsedCallStatus[] = [];
  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const v = change?.value;
      const phoneNumberId = String(v?.metadata?.phone_number_id ?? '');
      const names = new Map<string, string>((v?.contacts ?? []).map((c: any) => [c.wa_id, c.profile?.name ?? '']));
      for (const m of v?.messages ?? []) {
        const media = m[m.type]?.id ? m[m.type] : undefined;
        const flow = m.interactive?.nfm_reply;
        const body = m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? media?.caption ?? '';
        messages.push({
          phoneNumberId, from: `+${m.from}`, name: names.get(m.from) ?? '', externalId: m.id,
          form: flow ? parseFormReply(flow.response_json) : undefined,
          kind: media ? 'media' : 'text', body: body || (media || flow ? '' : `[unsupported ${m.type} message]`),
          mediaId: media?.id, mime: media?.mime_type, fileName: media?.filename,
          referral: m.referral ? { source: m.referral.source_type ?? 'ad', headline: m.referral.headline ?? '', clickId: m.referral.ctwa_clid } : undefined,
        });
      }
      for (const s of v?.statuses ?? []) {
        if (s.type === 'call') callStatuses.push({ externalId: s.id, status: s.status });
        else statuses.push({ externalId: s.id, status: s.status, error: s.errors?.[0]?.title });
      }
      for (const c of v?.calls ?? []) {
        calls.push({
          phoneNumberId, externalId: c.id, event: c.event, direction: c.direction, from: `+${c.from}`, to: `+${c.to}`,
          name: names.get(c.from) ?? '', sdp: c.session?.sdp, status: c.status,
        });
      }
    }
  }
  return { messages, statuses, calls, callStatuses };
}

function parseFormReply(json: unknown): Record<string, unknown> {
  try {
    const { flow_token: _token, ...answers } = JSON.parse(String(json));
    return answers;
  } catch {
    return {};
  }
}

/** One endpoint drives the whole call lifecycle. The action field picks the step. */
export const callAction = (cfg: WhatsAppConfig, body: Record<string, unknown>) =>
  postJson(cfg, `${cfg.phoneNumberId}/calls`, { messaging_product: 'whatsapp', ...body });

export async function downloadMedia(cfg: WhatsAppConfig, mediaId: string): Promise<Buffer> {
  const meta = await call(cfg, mediaId);
  const res = await fetch(meta.url, { headers: { authorization: `Bearer ${cfg.accessToken}` }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`Media download failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function fetchTemplates(cfg: WhatsAppConfig): Promise<any[]> {
  return (await call(cfg, `${cfg.wabaId}/message_templates?limit=200&fields=name,status,category,language,components,id`)).data ?? [];
}

export async function submitTemplate(cfg: WhatsAppConfig, t: { name: string; language: string; category: string; header: string; body: string; footer: string; buttons: string[]; samples: string[] }) {
  const components: unknown[] = [];
  if (t.header) components.push({ type: 'HEADER', format: 'TEXT', text: t.header });
  components.push({ type: 'BODY', text: t.body, ...(t.samples.length ? { example: { body_text: [t.samples] } } : {}) });
  if (t.footer) components.push({ type: 'FOOTER', text: t.footer });
  if (t.buttons.length) components.push({ type: 'BUTTONS', buttons: t.buttons.map((text) => ({ type: 'QUICK_REPLY', text })) });
  return postJson(cfg, `${cfg.wabaId}/message_templates`, { name: t.name, language: t.language, category: t.category, components });
}
