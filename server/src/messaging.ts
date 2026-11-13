import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { adapterFor, getChannel, type Outbound } from './channels/index.ts';
import { config } from './config.ts';
import { audit, get, getSettings, insert, parse, run, all } from './db.ts';
import { emitWebhook, publish } from './events.ts';
import { detectMood } from './ai.ts';
import { awardReply } from './gamification.ts';

export const SESSION_WINDOW_MS = 24 * 3600e3;
export const STATUS_RANK: Record<string, number> = { queued: 0, sent: 1, delivered: 2, read: 3, acted: 4 };

export class SendBlocked extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export const normalizePhone = (raw: string) => {
  const digits = String(raw).replace(/\D/g, '');
  return digits ? `+${digits}` : '';
};

export const windowOpen = (c: { last_inbound_at: number | null }, now = Date.now()) =>
  !!c.last_inbound_at && now - c.last_inbound_at < SESSION_WINDOW_MS;

/** A customer who opted in and hasn't since said STOP. Only the customer can change the second part. */
export const hasConsent = (k: { opted_in: number; opted_out_at: number | null }) => !!k.opted_in && !k.opted_out_at;

/**
 * Why a template may not go to this contact, or null when it may. Marketing always needs
 * consent. Any template that opens a conversation (the window is closed) needs it too,
 * so only replies inside an open window can skip it, and only for utility or login codes.
 */
export function templateConsentProblem(
  contact: { opted_in: number; opted_out_at: number | null; last_inbound_at: number | null }, category: string, now = Date.now(),
): string | null {
  if (hasConsent(contact)) return null;
  if (String(category).toUpperCase() === 'MARKETING') {
    return contact.opted_out_at ? 'This customer replied STOP, so marketing messages are off.' : "This customer hasn't opted in to marketing messages.";
  }
  if (!windowOpen(contact, now)) {
    return contact.opted_out_at ? 'This customer replied STOP. Wait for them to message you first.' : "This customer hasn't opted in, so you can't message them first.";
  }
  return null;
}

export function upsertContact(phone: string, name = ''): number {
  const p = normalizePhone(phone);
  if (!p) throw new Error('A valid phone number is required');
  const found = get<{ id: number; name: string }>('SELECT id, name FROM contacts WHERE phone = ?', p);
  if (found) {
    if (name && !found.name) run('UPDATE contacts SET name = ? WHERE id = ?', name, found.id);
    return found.id;
  }
  return insert('INSERT INTO contacts(name, phone, created_at) VALUES(?, ?, ?)', name, p, Date.now());
}

export function ensureConversation(contactId: number, channelId: number): number {
  const c = get<{ id: number }>('SELECT id FROM conversations WHERE contact_id = ? AND channel_id = ?', contactId, channelId);
  return c?.id ?? insert('INSERT INTO conversations(contact_id, channel_id, created_at) VALUES(?, ?, ?)', contactId, channelId, Date.now());
}

const preview = (kind: string, body: string) => (body || (kind === 'media' ? 'Attachment' : '')).slice(0, 120);

export function addSystemNote(conversationId: number, body: string) {
  const id = insert(
    "INSERT INTO messages(conversation_id, direction, kind, body, status, via, created_at) VALUES(?, 'internal', 'system', ?, 'sent', 'system', ?)",
    conversationId, body, Date.now(),
  );
  publish({ type: 'message', conversationId, id });
  return id;
}

export function addNote(conversationId: number, userId: number, body: string) {
  const id = insert(
    "INSERT INTO messages(conversation_id, direction, kind, body, status, user_id, via, created_at) VALUES(?, 'internal', 'note', ?, 'sent', ?, 'agent', ?)",
    conversationId, body, userId, Date.now(),
  );
  publish({ type: 'message', conversationId, id });
  return id;
}

/** Least-recently-assigned active agent. Round robin that survives restarts. */
export function pickAgent(): number | null {
  const u = get<{ id: number }>("SELECT id FROM users WHERE active = 1 AND role != 'admin' ORDER BY last_assigned_at, id LIMIT 1")
    ?? get<{ id: number }>('SELECT id FROM users WHERE active = 1 ORDER BY last_assigned_at, id LIMIT 1');
  return u?.id ?? null;
}

/** A human stepping in ends any bot flow, so the two never answer over each other. */
function stopBots(conversationId: number) {
  run("UPDATE bot_runs SET status = 'handoff', ended_at = ?, wake_at = NULL WHERE conversation_id = ? AND status IN ('waiting', 'sleeping')", Date.now(), conversationId);
}

export function assign(conversationId: number, userId: number | null, actor: Parameters<typeof audit>[0] = null) {
  run('UPDATE conversations SET assignee_id = ? WHERE id = ?', userId, conversationId);
  if (userId) {
    run('UPDATE users SET last_assigned_at = ? WHERE id = ?', Date.now(), userId);
    stopBots(conversationId);
  }
  const name = userId ? get<{ name: string }>('SELECT name FROM users WHERE id = ?', userId)?.name : null;
  addSystemNote(conversationId, name ? `Assigned to ${name}` : 'Unassigned');
  audit(actor, 'conversation.assign', `conversation:${conversationId} -> ${userId}`);
  publish({ type: 'conversation', id: conversationId });
}

/** The SLA clock restarts when a bot passes a customer to a person. */
export function restartSla(conversationId: number) {
  run(
    'UPDATE conversations SET first_response_at = NULL, first_inbound_at = ?, sla_due_at = ? WHERE id = ?',
    Date.now(), Date.now() + getSettings().sla_minutes * 60e3, conversationId,
  );
}

export function isWithinWorkingHours(now = new Date()): boolean {
  const h = getSettings().working_hours;
  if (!h.enabled) return true;
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: h.timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now);
  const part = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(part('weekday'));
  const time = `${part('hour').replace('24', '00')}:${part('minute')}`;
  return h.days.includes(day) && time >= h.start && time < h.end;
}

const OPT_OUT = /^\s*(stop|unsubscribe|opt[ -]?out)\s*[.!]*\s*$/i;
const OPT_IN = /^\s*(start|subscribe|opt[ -]?in)\s*[.!]*\s*$/i;

export interface Inbound {
  channelId: number; from: string; name?: string; body: string; kind?: 'text' | 'media';
  payload?: Record<string, unknown>; externalId?: string; referral?: { source: string; headline: string; clickId?: string };
  form?: Record<string, unknown>;
}

/** Keeps form answers to plain short values, because they come straight from outside. */
function cleanAnswers(form: Record<string, unknown>) {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(form).slice(0, 50)) {
    if (/^[\w -]{1,60}$/.test(k) && ['string', 'number', 'boolean'].includes(typeof v)) out[k] = String(v).slice(0, 500);
  }
  return out;
}

/** Hooks registered at startup. Bots and AI sit on top of messaging, not inside it. */
type InboundHook = (conversationId: number, text: string, isNew: boolean) => Promise<void>;
let inboundHook: InboundHook = async () => {};
export const setInboundHook = (fn: InboundHook) => { inboundHook = fn; };

export async function receiveInbound(m: Inbound): Promise<{ conversationId: number; messageId: number } | null> {
  if (m.externalId && get('SELECT 1 FROM messages WHERE external_id = ?', m.externalId)) return null; // Meta retries webhooks
  const now = Date.now();
  const contactId = upsertContact(m.from, m.name);
  const conversationId = ensureConversation(contactId, m.channelId);
  const before = get<any>('SELECT * FROM conversations WHERE id = ?', conversationId);
  const isNew = !before.last_inbound_at || before.status === 'resolved';
  const kind = m.kind ?? 'text';
  const answers = m.form ? cleanAnswers(m.form) : undefined;
  if (answers) {
    m.body = `📋 Form submitted\n${Object.entries(answers).map(([k, v]) => `${k.replaceAll('_', ' ')}: ${v}`).join('\n')}`;
    m.payload = { ...m.payload, answers };
  }
  // The unique index is the real guard against a retried webhook: nothing below runs twice.
  const inserted = run(
    `INSERT INTO messages(conversation_id, direction, kind, body, payload, status, external_id, via, created_at) VALUES(?, 'in', ?, ?, ?, 'read', ?, 'customer', ?)
     ON CONFLICT(external_id) WHERE external_id IS NOT NULL DO NOTHING`,
    conversationId, kind, m.body, JSON.stringify(m.payload ?? {}), m.externalId ?? null, now,
  );
  if (!inserted.changes) return null;
  const messageId = Number(inserted.lastInsertRowid);
  if (answers) {
    const c = get<{ fields: string }>('SELECT fields FROM contacts WHERE id = ?', contactId)!;
    run('UPDATE contacts SET fields = ? WHERE id = ?', JSON.stringify({ ...parse(c.fields, {}), ...answers }), contactId);
  }

  // The third tick: a reply means every outbound message before it got a real reaction.
  const acted = all<{ id: number }>(
    "SELECT id FROM messages WHERE conversation_id = ? AND direction = 'out' AND status IN ('sent', 'delivered', 'read')", conversationId,
  );
  run("UPDATE messages SET status = 'acted' WHERE conversation_id = ? AND direction = 'out' AND status IN ('sent', 'delivered', 'read')", conversationId);
  for (const a of acted) publish({ type: 'message', conversationId, id: a.id });

  const s = getSettings();
  run(
    `UPDATE conversations SET status = 'open', snooze_until = NULL, unread = unread + 1, last_inbound_at = ?, last_message_at = ?, last_preview = ?, mood = ?,
       first_inbound_at = CASE WHEN ? THEN ? ELSE first_inbound_at END,
       first_response_at = CASE WHEN ? THEN NULL ELSE first_response_at END,
       sla_due_at = CASE WHEN ? THEN ? ELSE sla_due_at END,
       sla_breached = CASE WHEN ? THEN 0 ELSE sla_breached END,
       resolved_at = NULL WHERE id = ?`,
    now, now, preview(kind, m.body), detectMood(m.body),
    isNew ? 1 : 0, now, isNew ? 1 : 0, isNew ? 1 : 0, now + s.sla_minutes * 60e3, isNew ? 1 : 0, conversationId,
  );
  if (m.referral) {
    const c = get<{ fields: string }>('SELECT fields FROM contacts WHERE id = ?', contactId)!;
    run('UPDATE contacts SET fields = ? WHERE id = ?', JSON.stringify({ ...parse(c.fields, {}), ad_source: m.referral.source, ad_headline: m.referral.headline, ...(m.referral.clickId ? { ctwa_clid: m.referral.clickId } : {}) }), contactId);
  }

  publish({ type: 'message', conversationId, id: messageId });
  publish({ type: 'conversation', id: conversationId });
  emitWebhook('message.received', { conversationId, messageId, from: normalizePhone(m.from), body: m.body });

  if (OPT_OUT.test(m.body)) {
    run('UPDATE contacts SET opted_out_at = ?, opted_in = 0 WHERE id = ?', now, contactId);
    addSystemNote(conversationId, 'Contact opted out of broadcasts');
    await send(conversationId, { kind: 'text', body: "You're unsubscribed. Reply START any time to opt back in." }, { via: 'system' });
    return { conversationId, messageId };
  }
  if (OPT_IN.test(m.body)) {
    run('UPDATE contacts SET opted_out_at = NULL, opted_in = 1 WHERE id = ?', contactId);
    addSystemNote(conversationId, 'Contact opted in to broadcasts');
    await send(conversationId, { kind: 'text', body: "You're subscribed. Thanks for coming back!" }, { via: 'system' });
    return { conversationId, messageId };
  }

  await inboundHook(conversationId, m.body, isNew);
  return { conversationId, messageId };
}

export type Draft =
  | { kind: 'text'; body: string }
  | { kind: 'media'; body: string; mediaFile: string; mime: string; fileName: string }
  | { kind: 'buttons'; body: string; options: string[] }
  | { kind: 'template'; templateId: number }
  | { kind: 'form'; formId: number }
  | { kind: 'call_permission'; body: string };

interface SendOpts { userId?: number; via?: 'agent' | 'bot' | 'ai' | 'broadcast' | 'system' | 'api' }

export function renderTemplate(t: { body: string; variables: string }, contact: { name: string; phone: string; email: string; fields: string }) {
  const vars = parse<string[]>(t.variables, []);
  const fields = parse<Record<string, string>>(contact.fields, {});
  const firstName = contact.name.split(' ')[0] || 'there';
  const params = vars.map((v) => {
    if (v === 'name') return contact.name || 'there';
    if (v === 'first_name') return firstName;
    if (v === 'phone') return contact.phone;
    if (v === 'email') return contact.email;
    return fields[v] ?? '';
  });
  return { params, text: t.body.replace(/\{\{(\d+)\}\}/g, (_, n) => params[Number(n) - 1] ?? '') };
}

/** Every outbound message goes through here, so the policy rules can't be bypassed. */
export async function send(conversationId: number, draft: Draft, opts: SendOpts = {}): Promise<number> {
  const c = get<any>(
    'SELECT c.*, k.phone, k.name, k.email, k.fields, k.opted_in, k.opted_out_at FROM conversations c JOIN contacts k ON k.id = c.contact_id WHERE c.id = ?', conversationId,
  );
  if (!c) throw new SendBlocked('not_found', 'Conversation not found');
  const channel = getChannel(c.channel_id);
  if (!channel?.enabled) throw new SendBlocked('channel_disabled', 'This channel is disabled');
  const via = opts.via ?? 'agent';

  if (draft.kind !== 'template' && !windowOpen(c)) {
    throw new SendBlocked('window_closed', 'The 24-hour window is closed. Send an approved template instead.');
  }
  if (via === 'agent' && (draft.kind === 'text' || draft.kind === 'media') && opts.userId && getSettings().block_agent_contact_sharing) {
    const me = get<{ email: string; phone: string | null }>('SELECT email, phone FROM users WHERE id = ?', opts.userId)!;
    const text = draft.body.toLowerCase();
    const digits = draft.body.replace(/\D/g, '');
    const myDigits = (me.phone ?? '').replace(/\D/g, '');
    if (text.includes(me.email.toLowerCase()) || (myDigits.length >= 7 && digits.includes(myDigits))) {
      throw new SendBlocked('contact_sharing_blocked', "Agents can't share their personal phone or email with customers.");
    }
  }

  let outbound: Outbound;
  let body: string;
  let kind: string = draft.kind;
  let payload: Record<string, unknown> = {};
  const to = c.phone as string;
  if (draft.kind === 'template') {
    const t = get<any>('SELECT * FROM templates WHERE id = ?', draft.templateId);
    if (!t) throw new SendBlocked('not_found', 'Template not found');
    if (t.status !== 'APPROVED') throw new SendBlocked('template_not_approved', 'Only approved templates can be sent');
    const problem = templateConsentProblem(c, t.category);
    if (problem) throw new SendBlocked('consent_required', problem);
    const r = renderTemplate(t, c);
    body = r.text;
    payload = { template: t.name, header: t.header, footer: t.footer, buttons: parse(t.buttons, []) };
    outbound = { kind: 'template', to, name: t.name, language: t.language, params: r.params };
  } else if (draft.kind === 'form') {
    const f = get<any>('SELECT * FROM forms WHERE id = ?', draft.formId);
    if (!f) throw new SendBlocked('not_found', 'Form not found');
    if (channel.type === 'whatsapp_cloud' && !f.meta_flow_id) throw new SendBlocked('form_not_linked', 'Add the Meta Flow ID to this form before sending it on WhatsApp.');
    body = f.body;
    const token = randomUUID();
    payload = { form: { id: f.id, name: f.name, cta: f.cta, fields: parse(f.fields, []), token } };
    outbound = { kind: 'flow', to, body, cta: f.cta, flowId: f.meta_flow_id, screen: f.screen, token };
  } else if (draft.kind === 'call_permission') {
    body = draft.body;
    payload = { options: ['Allow calls'] };
    outbound = { kind: 'call_permission', to, body };
  } else if (draft.kind === 'buttons') {
    body = draft.body;
    payload = { options: draft.options };
    outbound = { kind: 'buttons', to, body, options: draft.options };
  } else if (draft.kind === 'media') {
    body = draft.body;
    payload = { mediaFile: draft.mediaFile, mime: draft.mime, fileName: draft.fileName };
    outbound = { kind: 'media', to, body, filePath: join(config.mediaDir, draft.mediaFile), mime: draft.mime, fileName: draft.fileName };
  } else {
    body = draft.body;
    outbound = { kind: 'text', to, body };
  }

  const now = Date.now();
  const id = insert(
    "INSERT INTO messages(conversation_id, direction, kind, body, payload, status, user_id, via, created_at) VALUES(?, 'out', ?, ?, ?, 'queued', ?, ?, ?)",
    conversationId, kind, body, JSON.stringify(payload), opts.userId ?? null, via, now,
  );
  publish({ type: 'message', conversationId, id });
  try {
    const { externalId } = await adapterFor(channel.type).send(channel, outbound);
    run("UPDATE messages SET status = 'sent', external_id = ? WHERE id = ?", externalId, id);
  } catch (e) {
    run("UPDATE messages SET status = 'failed', error = ? WHERE id = ?", (e as Error).message, id);
    publish({ type: 'message', conversationId, id });
    return id;
  }

  // Bots and AI count as a first response: a chat they fully handled hasn't breached anything.
  const firstReply = ['agent', 'bot', 'ai', 'api'].includes(via) && !c.first_response_at && c.first_inbound_at;
  if (via === 'agent') stopBots(conversationId);
  run(
    `UPDATE conversations SET last_outbound_at = ?, last_message_at = ?, last_preview = ?, unread = CASE WHEN ? THEN 0 ELSE unread END,
       first_response_at = CASE WHEN ? THEN ? ELSE first_response_at END, sla_due_at = CASE WHEN ? THEN NULL ELSE sla_due_at END WHERE id = ?`,
    now, now, preview(kind, body), via === 'agent' ? 1 : 0, firstReply ? 1 : 0, now, firstReply ? 1 : 0, conversationId,
  );
  if (via === 'agent' && opts.userId) awardReply(opts.userId, firstReply ? now - c.first_inbound_at : null);
  publish({ type: 'message', conversationId, id });
  publish({ type: 'conversation', id: conversationId });
  emitWebhook('message.sent', { conversationId, messageId: id, to, body, via });
  return id;
}

/** Applies a delivery receipt. Receipts can arrive out of order, so status only ever moves forward. */
export function applyStatus(externalId: string, status: string, error?: string) {
  const m = get<{ id: number; conversation_id: number; status: string }>('SELECT id, conversation_id, status FROM messages WHERE external_id = ?', externalId);
  if (!m) return;
  if (status === 'failed') {
    run("UPDATE messages SET status = 'failed', error = ? WHERE id = ?", error ?? 'Delivery failed', m.id);
  } else {
    if ((STATUS_RANK[status] ?? -1) <= (STATUS_RANK[m.status] ?? 99)) return;
    run('UPDATE messages SET status = ? WHERE id = ?', status, m.id);
  }
  publish({ type: 'message', conversationId: m.conversation_id, id: m.id });
  emitWebhook('message.status', { messageId: m.id, status });
}
