import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { canSeeConversation, type User } from './auth.ts';
import { segmentContacts } from './broadcasts.ts';
import { channelConfig, getChannel, type Channel } from './channels/index.ts';
import { callAction, type ParsedCall, type WhatsAppConfig } from './channels/whatsapp.ts';
import { all, audit, get, insert, run, tx } from './db.ts';
import { publish } from './events.ts';
import { anyone, fail, leads } from './http.ts';
import { addSystemNote, ensureConversation, hasConsent, normalizePhone, send, SendBlocked, upsertContact } from './messaging.ts';
import { maskPhone, masks, seeConversation } from './routes.ts';

const RING_MS = 60e3;
const NO_PERMISSION = 138006;

interface Call {
  id: number; conversation_id: number; external_id: string | null; direction: 'in' | 'out'; status: string; outcome: string | null;
  user_id: number | null; sdp_offer: string | null; sdp_answer: string | null; created_at: number; answered_at: number | null; ended_at: number | null;
}

const getCall = (id: number) => get<Call>('SELECT * FROM calls WHERE id = ?', id);

function channelOf(call: Call): Channel {
  const c = get<{ channel_id: number }>('SELECT channel_id FROM conversations WHERE id = ?', call.conversation_id)!;
  return getChannel(c.channel_id)!;
}

function surface(conversationId: number, text: string) {
  run("UPDATE conversations SET status = 'open', last_message_at = ?, last_preview = ? WHERE id = ?", Date.now(), text, conversationId);
  publish({ type: 'conversation', id: conversationId });
}

const seconds = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}`;

/** Idempotent, because hang-up and Meta's terminate webhook can both arrive for one call. */
function finishCall(id: number, outcome: string) {
  const now = Date.now();
  const res = run("UPDATE calls SET status = 'ended', outcome = ?, ended_at = ? WHERE id = ? AND status != 'ended'", outcome, now, id);
  if (!res.changes) return;
  const c = getCall(id)!;
  const text = outcome === 'completed'
    ? `📞 Call ended after ${seconds(now - (c.answered_at ?? now))}`
    : `📞 ${{ missed: 'Missed', declined: 'Declined', failed: 'Failed' }[outcome] ?? 'Ended'} call`;
  addSystemNote(c.conversation_id, text);
  surface(c.conversation_id, text);
  publish({ type: 'call', id });
}

function ring(conversationId: number, externalId: string, sdp: string | undefined) {
  const res = run(
    "INSERT OR IGNORE INTO calls(conversation_id, external_id, direction, sdp_offer, created_at) VALUES(?, ?, 'in', ?, ?)",
    conversationId, externalId, sdp ?? null, Date.now(),
  );
  if (!res.changes) return undefined;
  const id = Number(res.lastInsertRowid);
  addSystemNote(conversationId, '📞 Incoming call');
  surface(conversationId, '📞 Incoming call');
  publish({ type: 'call', id });
  return id;
}

/** Meta doesn't guarantee webhook order, so a terminate may be the first thing we hear about a call. */
export function onCallEvent(channelId: number, e: ParsedCall) {
  const existing = get<Call>('SELECT * FROM calls WHERE external_id = ?', e.externalId);
  const outbound = e.direction === 'BUSINESS_INITIATED';
  if (e.event === 'connect') {
    if (outbound && existing) {
      run('UPDATE calls SET sdp_answer = ? WHERE id = ?', e.sdp ?? null, existing.id);
      publish({ type: 'call', id: existing.id });
    } else if (!outbound) {
      ring(ensureConversation(upsertContact(e.from, e.name), channelId), e.externalId, e.sdp);
    }
  } else if (e.event === 'terminate') {
    let call = existing;
    if (!call && !outbound) {
      const id = ring(ensureConversation(upsertContact(e.from, e.name), channelId), e.externalId, undefined);
      call = id ? getCall(id) : undefined;
    }
    if (!call) return;
    finishCall(call.id, e.status?.toUpperCase() === 'FAILED' ? 'failed' : call.answered_at ? 'completed' : call.direction === 'in' ? 'missed' : 'declined');
  }
}

export function onCallStatus(externalId: string, status: string) {
  const c = get<Call>('SELECT * FROM calls WHERE external_id = ?', externalId);
  if (!c) return;
  if (status === 'ACCEPTED' && c.status !== 'ended') {
    run("UPDATE calls SET status = 'active', answered_at = COALESCE(answered_at, ?) WHERE id = ?", Date.now(), c.id);
    publish({ type: 'call', id: c.id });
  } else if (status === 'REJECTED') finishCall(c.id, 'declined');
}

async function tellMeta(call: Call, action: string, session?: object) {
  const channel = channelOf(call);
  if (channel.type !== 'whatsapp_cloud') return;
  await callAction(channelConfig<WhatsAppConfig>(channel), { call_id: call.external_id, action, ...(session ? { session } : {}) });
}

/** Scheduler entry: an unanswered call must not ring forever. */
export async function expireRinging(now = Date.now()) {
  for (const c of all<Call>("SELECT * FROM calls WHERE status = 'ringing' AND created_at <= ?", now - RING_MS)) {
    await tellMeta(c, c.direction === 'in' ? 'reject' : 'terminate').catch(() => {});
    finishCall(c.id, 'missed');
  }
}

function visibleCall(req: FastifyRequest, id: number) {
  const c = getCall(id);
  if (!c || !canSeeConversation(req.user, c.conversation_id)) fail(404, 'Call not found');
  return c!;
}

function viewCall(u: User, c: Call) {
  const k = get<{ name: string; phone: string }>('SELECT k.name, k.phone FROM contacts k JOIN conversations v ON v.contact_id = k.id WHERE v.id = ?', c.conversation_id);
  return { ...c, contact: k?.name || (k ? (masks(u) ? maskPhone(k.phone) : k.phone) : '') };
}

function simCall(id: number) {
  const c = getCall(id);
  if (!c || channelOf(c).type !== 'simulator') fail(404, 'Call not found');
  return c!;
}

export function registerCallRoutes(app: FastifyInstance) {
  app.get('/api/calls/config', { preHandler: anyone }, () => {
    let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
    try {
      if (process.env.TT_ICE_SERVERS) iceServers = JSON.parse(process.env.TT_ICE_SERVERS);
    } catch {
      console.warn('TT_ICE_SERVERS is not valid JSON, using the default');
    }
    return { iceServers };
  });

  app.get('/api/calls/active', { preHandler: anyone }, (req) =>
    all<Call>("SELECT * FROM calls WHERE status != 'ended'").filter((c) => canSeeConversation(req.user, c.conversation_id)).map((c) => viewCall(req.user, c)));

  app.get('/api/calls/:id', { preHandler: anyone }, (req) => viewCall(req.user, visibleCall(req, Number((req.params as any).id))));

  app.post('/api/conversations/:id/calls', { preHandler: anyone }, async (req) => {
    const id = seeConversation(req);
    const { sdp } = req.body as any;
    if (!sdp) fail(400, 'Missing call offer');
    const conv = get<{ channel_id: number; phone: string; opted_out_at: number | null }>(
      'SELECT c.channel_id, k.phone, k.opted_out_at FROM conversations c JOIN contacts k ON k.id = c.contact_id WHERE c.id = ?', id,
    )!;
    const channel = getChannel(conv.channel_id)!;
    if (!channel.enabled) fail(422, 'This channel is disabled');
    // A STOP covers calls too. Meta's own call permission is checked separately on WhatsApp.
    if (conv.opted_out_at) throw new SendBlocked('consent_required', 'This customer replied STOP, so calls are off.');
    if (get("SELECT 1 FROM calls WHERE conversation_id = ? AND status != 'ended'", id)) fail(409, 'There is already a call on this chat');
    let externalId = `simcall_${randomUUID()}`;
    if (channel.type === 'whatsapp_cloud') {
      try {
        const res = await callAction(channelConfig<WhatsAppConfig>(channel), {
          to: conv.phone.replace(/\D/g, ''), action: 'connect', session: { sdp_type: 'offer', sdp: String(sdp) },
        });
        externalId = res.calls?.[0]?.id ?? externalId;
      } catch (e: any) {
        if (e.code === NO_PERMISSION) throw new SendBlocked('call_permission_needed', 'This customer has not allowed calls yet.');
        return fail(502, `WhatsApp refused the call: ${e.message}`);
      }
    }
    const callId = insert(
      "INSERT INTO calls(conversation_id, external_id, direction, user_id, sdp_offer, created_at) VALUES(?, ?, 'out', ?, ?, ?)",
      id, externalId, req.user.id, String(sdp), Date.now(),
    );
    addSystemNote(id, `📞 ${req.user.name} is calling`);
    audit(req.user, 'calls.start', `conversation:${id}`);
    publish({ type: 'call', id: callId });
    return { id: callId };
  });

  app.post('/api/conversations/:id/call-permission', { preHandler: anyone }, async (req) => ({
    id: await send(seeConversation(req), { kind: 'call_permission', body: 'Can we call you on WhatsApp about this?' }, { userId: req.user.id }),
  }));

  app.post('/api/calls/:id/answer', { preHandler: anyone }, async (req) => {
    const c = visibleCall(req, Number((req.params as any).id));
    const { sdp } = req.body as any;
    if (!sdp) fail(400, 'Missing call answer');
    // The first agent to answer wins. Everyone else's ring stops on the next event.
    const claimed = run("UPDATE calls SET status = 'connecting', user_id = ? WHERE id = ? AND status = 'ringing' AND direction = 'in'", req.user.id, c.id);
    if (!claimed.changes) fail(409, 'Someone else already took this call');
    const session = { sdp_type: 'answer', sdp: String(sdp) };
    try {
      // Meta requires pre_accept first, and accept must repeat the same SDP.
      await tellMeta(c, 'pre_accept', session);
      await tellMeta(c, 'accept', session);
    } catch (e) {
      finishCall(c.id, 'failed');
      return fail(502, `WhatsApp refused the answer: ${(e as Error).message}`);
    }
    run("UPDATE calls SET status = 'active', sdp_answer = ?, answered_at = ? WHERE id = ?", String(sdp), Date.now(), c.id);
    addSystemNote(c.conversation_id, `📞 ${req.user.name} answered`);
    publish({ type: 'call', id: c.id });
    return { ok: true };
  });

  app.post('/api/calls/:id/hangup', { preHandler: anyone }, async (req) => {
    const c = visibleCall(req, Number((req.params as any).id));
    if (c.status === 'ended') return { ok: true };
    const declining = c.direction === 'in' && c.status === 'ringing';
    await tellMeta(c, declining ? 'reject' : 'terminate').catch((e) => console.warn(`Call end failed: ${e.message}`));
    finishCall(c.id, c.answered_at ? 'completed' : declining ? 'declined' : 'missed');
    return { ok: true };
  });

  // --- Simulator: the customer's side of a call ---
  app.post('/api/simulator/call', { preHandler: anyone }, (req) => {
    const { channelId, from, name, sdp } = req.body as any;
    const channel = getChannel(Number(channelId));
    if (channel?.type !== 'simulator') fail(400, 'Pick a simulator channel');
    if (!normalizePhone(String(from ?? '')) || !sdp) fail(400, 'A phone number and a call offer are required');
    const id = ring(ensureConversation(upsertContact(String(from), String(name ?? '')), channel!.id), `simcall_${randomUUID()}`, String(sdp));
    return { id };
  });

  app.get('/api/simulator/calls', { preHandler: anyone }, (req) => {
    const { channelId, from } = req.query as any;
    if (getChannel(Number(channelId))?.type !== 'simulator') fail(400, 'Pick a simulator channel');
    return all<Call>(
      `SELECT l.* FROM calls l JOIN conversations c ON c.id = l.conversation_id JOIN contacts k ON k.id = c.contact_id
       WHERE c.channel_id = ? AND k.phone = ? AND l.status != 'ended'`,
      Number(channelId), normalizePhone(String(from)),
    );
  });

  app.post('/api/simulator/calls/:id/answer', { preHandler: anyone }, (req) => {
    const c = simCall(Number((req.params as any).id));
    const res = run("UPDATE calls SET status = 'active', sdp_answer = ?, answered_at = ? WHERE id = ? AND status = 'ringing' AND direction = 'out'", String((req.body as any).sdp), Date.now(), c.id);
    if (!res.changes) fail(409, 'That call is no longer ringing');
    publish({ type: 'call', id: c.id });
    return { ok: true };
  });

  app.post('/api/simulator/calls/:id/hangup', { preHandler: anyone }, (req) => {
    const c = simCall(Number((req.params as any).id));
    finishCall(c.id, c.answered_at ? 'completed' : 'declined');
    return { ok: true };
  });

  // --- Call lists: people dialling people ---
  app.get('/api/call-lists', { preHandler: leads }, () =>
    all<any>('SELECT l.*, ch.name channel_name FROM call_lists l JOIN channels ch ON ch.id = l.channel_id ORDER BY l.id DESC').map((l) => {
      const n = get<any>("SELECT COUNT(*) total, SUM(state = 'pending') pending, SUM(state = 'done') done FROM call_list_items WHERE list_id = ?", l.id);
      const outcomes = all('SELECT outcome, COUNT(*) n FROM call_list_items WHERE list_id = ? AND outcome IS NOT NULL GROUP BY outcome', l.id);
      return { ...l, total: Number(n.total), pending: Number(n.pending ?? 0), done: Number(n.done ?? 0), outcomes };
    }));

  app.post('/api/call-lists', { preHandler: leads }, (req) => {
    const b = req.body as any;
    if (!b.name || !b.channelId) fail(400, 'Name and channel are required');
    const audience = segmentContacts(b.segmentId ? Number(b.segmentId) : null).filter((c) => c.opted_in && !c.opted_out_at);
    const id = tx(() => {
      const listId = insert('INSERT INTO call_lists(name, channel_id, script, created_at) VALUES(?, ?, ?, ?)', String(b.name), Number(b.channelId), String(b.script ?? ''), Date.now());
      for (const c of audience) insert('INSERT INTO call_list_items(list_id, contact_id) VALUES(?, ?)', listId, c.id);
      return listId;
    });
    audit(req.user, 'call_lists.create', String(id));
    return { id, size: audience.length };
  });

  app.delete('/api/call-lists/:id', { preHandler: leads }, (req) => {
    run('DELETE FROM call_lists WHERE id = ?', Number((req.params as any).id));
    return { ok: true };
  });

  app.post('/api/call-lists/:id/next', { preHandler: leads }, (req) => {
    const list = get<any>('SELECT * FROM call_lists WHERE id = ?', Number((req.params as any).id)) ?? fail(404, 'Call list not found');
    return tx(() => {
      for (;;) {
        const item = get<any>("SELECT * FROM call_list_items WHERE list_id = ? AND state = 'pending' ORDER BY id LIMIT 1", list.id);
        if (!item) return { done: true };
        // Re-checked at dial time: consent may have changed since the list was built.
        const k = get<{ opted_in: number; opted_out_at: number | null }>('SELECT opted_in, opted_out_at FROM contacts WHERE id = ?', item.contact_id);
        if (!k || !hasConsent(k)) {
          run("UPDATE call_list_items SET state = 'done', outcome = ? WHERE id = ?", k?.opted_out_at ? 'opted_out' : 'no_opt_in', item.id);
          continue;
        }
        run("UPDATE call_list_items SET state = 'calling', user_id = ? WHERE id = ?", req.user.id, item.id);
        const name = get<{ name: string }>('SELECT name FROM contacts WHERE id = ?', item.contact_id)?.name;
        return { itemId: item.id, name, script: list.script, conversationId: ensureConversation(item.contact_id, list.channel_id) };
      }
    });
  });

  app.post('/api/call-list-items/:id/outcome', { preHandler: leads }, (req) => {
    run("UPDATE call_list_items SET state = 'done', outcome = ? WHERE id = ?", String((req.body as any).outcome), Number((req.params as any).id));
    return { ok: true };
  });
}
