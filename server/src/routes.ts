import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, createReadStream, existsSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { admins, anyone, cookieToken, fail, HttpError, leads, setCookie } from './http.ts';
import { aiMode, magicReplies, rewrite, summarize } from './ai.ts';
import { botJourney, overview, parseCsv, toCsv } from './analytics.ts';
import {
  canSeeConversation, createApiKey, createSession, destroySession, hashPassword, publicUser, teamIds,
  verifyPassword, visibilityClause, type User,
} from './auth.ts';
import { broadcastStats, launch, retarget, segmentContacts, type Rule } from './broadcasts.ts';
import { channelConfig, getChannel, publicChannel, type Channel } from './channels/index.ts';
import { downloadMedia, fetchTemplates, parseWebhook, submitTemplate, verifySignature, type WhatsAppConfig } from './channels/whatsapp.ts';
import { config } from './config.ts';
import { all, audit, DEFAULT_SETTINGS, get, getSettings, insert, parse, run, setSetting, tx } from './db.ts';
import { publish, subscribe, type LiveEvent } from './events.ts';
import { sealSecret } from './secrets.ts';
import { onCallEvent, onCallStatus } from './calls.ts';
import { recordConversion } from './connectors.ts';
import { ACHIEVEMENTS, awardResolve } from './gamification.ts';
import { addNote, addSystemNote, applyStatus, assign, ensureConversation, normalizePhone, receiveInbound, send, SendBlocked, upsertContact, windowOpen, type Draft } from './messaging.ts';

const MEDIA_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'application/pdf': 'pdf' };

// --- Masking: agents see just enough of a customer's details to do the job ---
export const maskPhone = (p: string) => (p.length > 6 ? `${p.slice(0, 3)}${'•'.repeat(p.length - 6)}${p.slice(-3)}` : '•••');
export const maskEmail = (e: string) => (e ? `${e[0]}•••@${e.split('@')[1] ?? '•••'}` : '');

function luhn(digits: string) {
  let sum = 0;
  [...digits].reverse().forEach((d, i) => {
    let n = Number(d);
    if (i % 2) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
  });
  return sum % 10 === 0;
}

export const maskCards = (text: string) =>
  text.replace(/\b\d(?:[ -]?\d){12,18}\b/g, (m) => {
    const d = m.replace(/\D/g, '');
    return luhn(d) ? `•••• •••• •••• ${d.slice(-4)}` : m;
  });

export const masks = (u: User) => u.role === 'agent' && getSettings().mask_for_agents;

function viewContact(u: User, c: any) {
  const out = { ...c, tags: parse(c.tags, []), fields: parse(c.fields, {}) };
  if (masks(u)) { out.phone = maskPhone(c.phone); out.email = maskEmail(c.email); }
  return out;
}

function viewMessage(u: User, m: any) {
  return { ...m, payload: parse(m.payload, {}), body: masks(u) ? maskCards(m.body) : m.body };
}

function conversationRow(u: User, c: any) {
  const { k_name, k_phone, k_tags, assignee_name, channel_name, ...rest } = c;
  return {
    ...rest,
    last_preview: masks(u) ? maskCards(c.last_preview) : c.last_preview,
    contact: { name: k_name, phone: masks(u) ? maskPhone(k_phone) : k_phone, tags: parse(k_tags, []) },
    assignee_name, channel_name, window_open: windowOpen(c), awaiting_reply: (c.last_inbound_at ?? 0) > (c.last_outbound_at ?? 0),
  };
}

const CONV_SELECT = `SELECT c.*, k.name k_name, k.phone k_phone, k.tags k_tags, u.name assignee_name, ch.name channel_name
  FROM conversations c JOIN contacts k ON k.id = c.contact_id LEFT JOIN users u ON u.id = c.assignee_id JOIN channels ch ON ch.id = c.channel_id`;

export function seeConversation(req: FastifyRequest) {
  const id = Number((req.params as any).id);
  if (!canSeeConversation(req.user, id)) fail(404, 'Conversation not found');
  return id;
}

const lines = (id: number) =>
  all('SELECT direction, kind, body FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 60', id).reverse();

export function crud(app: FastifyInstance, path: string, table: string, cols: string[], guard = leads, map: (r: any) => any = (r) => r) {
  app.get(`/api/${path}`, { preHandler: anyone }, () => all(`SELECT * FROM ${table} ORDER BY id DESC`).map(map));
  const encode = (b: any, c: string) => (b[c] !== null && typeof b[c] === 'object' ? JSON.stringify(b[c]) : b[c]);
  app.post(`/api/${path}`, { preHandler: guard }, (req) => {
    const b = req.body as any;
    const used = cols.filter((c) => b[c] !== undefined);
    const hasCreated = !!get(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = 'created_at'`);
    const names = [...used, ...(hasCreated ? ['created_at'] : [])];
    const id = insert(
      `INSERT INTO ${table}(${names.join(',')}) VALUES(${names.map(() => '?').join(',')})`,
      ...used.map((c) => encode(b, c)), ...(hasCreated ? [Date.now()] : []),
    );
    audit(req.user.id, `${table}.create`, String(id));
    return map(get(`SELECT * FROM ${table} WHERE id = ?`, id));
  });
  app.patch(`/api/${path}/:id`, { preHandler: guard }, (req) => {
    const b = req.body as any;
    const id = Number((req.params as any).id);
    const used = cols.filter((c) => b[c] !== undefined);
    if (used.length) run(`UPDATE ${table} SET ${used.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, ...used.map((c) => encode(b, c)), id);
    audit(req.user.id, `${table}.update`, String(id));
    return map(get(`SELECT * FROM ${table} WHERE id = ?`, id) ?? fail(404, 'Not found'));
  });
  app.delete(`/api/${path}/:id`, { preHandler: guard }, (req) => {
    const id = Number((req.params as any).id);
    run(`DELETE FROM ${table} WHERE id = ?`, id);
    audit(req.user.id, `${table}.delete`, String(id));
    return { ok: true };
  });
}

const attempts = new Map<string, { n: number; until: number }>();
function throttle(key: string) {
  const a = attempts.get(key);
  if (a && a.until > Date.now() && a.n >= 8) fail(429, 'Too many attempts. Try again in a few minutes.');
}
function recordFailure(key: string) {
  const a = attempts.get(key);
  attempts.set(key, { n: a && a.until > Date.now() ? a.n + 1 : 1, until: Date.now() + 5 * 60e3 });
}

export function registerRoutes(app: FastifyInstance) {
  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof SendBlocked) return reply.status(422).send({ error: err.message, code: err.code });
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    if (/constraint failed/i.test(err.message ?? '')) return reply.status(409).send({ error: 'That is already in use, or something else still depends on it' });
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: err.message });
    app.log.error(err);
    return reply.status(500).send({ error: 'Something went wrong on the server' });
  });

  // --- Auth ---
  app.get('/api/auth/state', () => ({ needsSetup: !get('SELECT 1 FROM users LIMIT 1'), demo: config.demo }));

  app.post('/api/auth/setup', (req, reply) => {
    if (get('SELECT 1 FROM users LIMIT 1')) fail(409, 'This workspace is already set up');
    const { name, email, password } = req.body as any;
    if (!name || !email || String(password ?? '').length < 8) fail(400, 'Name, email and a password of at least 8 characters are required');
    const id = insert("INSERT INTO users(name, email, pass_hash, role, created_at) VALUES(?, ?, ?, 'admin', ?)", name, email, hashPassword(password), Date.now());
    if (!get('SELECT 1 FROM channels LIMIT 1')) {
      insert("INSERT INTO channels(type, name, phone, created_at) VALUES('simulator', 'Simulator', '+10000000000', ?)", Date.now());
    }
    setCookie(reply, createSession(id), 14 * 86400);
    return publicUser(get<User>('SELECT * FROM users WHERE id = ?', id)!);
  });

  app.post('/api/auth/login', (req, reply) => {
    const { email, password } = req.body as any;
    const key = `${req.ip}:${String(email).toLowerCase()}`;
    throttle(key);
    const u = get<User & { pass_hash: string }>('SELECT * FROM users WHERE email = ? AND active = 1', String(email));
    if (!u || !verifyPassword(String(password), u.pass_hash)) {
      recordFailure(key);
      fail(401, 'That email and password combination is not right');
    }
    attempts.delete(key);
    setCookie(reply, createSession(u!.id), 14 * 86400);
    audit(u!.id, 'auth.login');
    return publicUser(u!);
  });

  app.post('/api/auth/logout', (req, reply) => {
    const t = cookieToken(req);
    if (t) destroySession(t);
    setCookie(reply, '', 0);
    return { ok: true };
  });

  app.get('/api/me', { preHandler: anyone }, (req) => ({
    ...publicUser(req.user),
    workspace: getSettings().workspace_name, funMode: getSettings().fun_mode, aiMode: aiMode(),
  }));

  app.patch('/api/me/prefs', { preHandler: anyone }, (req) => {
    const prefs = { ...parse(req.user.prefs, {}), ...(req.body as object) };
    if (JSON.stringify(prefs).length > 20000) fail(413, 'Preferences are too large');
    run('UPDATE users SET prefs = ? WHERE id = ?', JSON.stringify(prefs), req.user.id);
    return prefs;
  });

  // --- Live events ---
  app.get('/api/events', { preHandler: anyone }, (req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const uid = req.user.id;
    const write = (e: LiveEvent) => {
      if ('userId' in e && e.userId !== uid) return;
      reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);
    };
    const off = subscribe(write);
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25000);
    req.raw.on('close', () => { off(); clearInterval(ping); });
  });

  // --- Conversations ---
  app.get('/api/conversations', { preHandler: anyone }, (req) => {
    const q = req.query as Record<string, string>;
    const v = visibilityClause(req.user);
    const where = [v.sql];
    const params: (string | number)[] = [...v.params];
    if (q.status && q.status !== 'all') { where.push('c.status = ?'); params.push(q.status); }
    if (q.assignee === 'me') { where.push('c.assignee_id = ?'); params.push(req.user.id); }
    else if (q.assignee === 'none') where.push('c.assignee_id IS NULL');
    else if (q.assignee) { where.push('c.assignee_id = ?'); params.push(Number(q.assignee)); }
    if (q.channel) { where.push('c.channel_id = ?'); params.push(Number(q.channel)); }
    if (q.mood) { where.push('c.mood = ?'); params.push(q.mood); }
    if (q.awaiting === '1') where.push('COALESCE(c.last_inbound_at, 0) > COALESCE(c.last_outbound_at, 0)');
    if (q.breached === '1') where.push('c.sla_breached = 1');
    if (q.tag) { where.push('EXISTS (SELECT 1 FROM json_each(k.tags) j WHERE j.value = ?)'); params.push(q.tag); }
    if (q.q) {
      where.push(`(k.name LIKE ? OR ${masks(req.user) ? '0' : 'k.phone LIKE ?'} OR EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.body LIKE ?))`);
      const like = `%${q.q}%`;
      params.push(...(masks(req.user) ? [like, like] : [like, like, like]));
    }
    return all(`${CONV_SELECT} WHERE ${where.join(' AND ')} ORDER BY c.last_message_at DESC LIMIT 200`, ...params).map((c) => conversationRow(req.user, c));
  });

  app.get('/api/conversations/:id', { preHandler: anyone }, (req) => {
    const id = seeConversation(req);
    const c = get(`${CONV_SELECT} WHERE c.id = ?`, id);
    const contact = get('SELECT k.* FROM contacts k JOIN conversations c ON c.contact_id = k.id WHERE c.id = ?', id);
    const messages = all(
      'SELECT m.*, u.name user_name FROM messages m LEFT JOIN users u ON u.id = m.user_id WHERE m.conversation_id = ? ORDER BY m.id DESC LIMIT 300', id,
    ).reverse();
    return {
      conversation: conversationRow(req.user, c),
      contact: viewContact(req.user, contact),
      messages: messages.map((m) => viewMessage(req.user, m)),
      reminders: all('SELECT * FROM reminders WHERE conversation_id = ? AND done = 0 ORDER BY due_at', id),
    };
  });

  app.post('/api/conversations/:id/read', { preHandler: anyone }, (req) => {
    const id = seeConversation(req);
    run('UPDATE conversations SET unread = 0 WHERE id = ?', id);
    publish({ type: 'conversation', id });
    return { ok: true };
  });

  app.post('/api/conversations/:id/messages', { preHandler: anyone }, async (req) => {
    const id = seeConversation(req);
    const b = req.body as any;
    let draft: Draft;
    if (b.templateId) draft = { kind: 'template', templateId: Number(b.templateId) };
    else if (b.mediaFile) {
      const file = basename(String(b.mediaFile));
      if (!existsSync(join(config.mediaDir, file))) fail(400, 'That attachment no longer exists');
      draft = { kind: 'media', body: String(b.body ?? ''), mediaFile: file, mime: String(b.mime), fileName: String(b.fileName ?? file) };
    } else {
      if (!String(b.body ?? '').trim()) fail(400, 'Message is empty');
      draft = { kind: 'text', body: String(b.body) };
    }
    return { id: await send(id, draft, { userId: req.user.id, via: req.headers.authorization ? 'api' : 'agent' }) };
  });

  app.post('/api/conversations/:id/notes', { preHandler: anyone }, (req) => {
    const id = seeConversation(req);
    const { body } = req.body as any;
    if (!String(body ?? '').trim()) fail(400, 'Note is empty');
    return { id: addNote(id, req.user.id, String(body)) };
  });

  app.patch('/api/conversations/:id', { preHandler: anyone }, (req) => {
    const id = seeConversation(req);
    const b = req.body as any;
    if (b.assigneeId !== undefined) {
      const target = b.assigneeId === null ? null : Number(b.assigneeId);
      if (req.user.role === 'agent' && target !== null && target !== req.user.id) fail(403, 'Agents can only assign chats to themselves');
      if (req.user.role === 'manager' && target !== null && !teamIds(req.user.id).includes(target)) fail(403, 'That person is not on your team');
      assign(id, target, req.user.id);
    }
    if (b.status === 'resolved') {
      run("UPDATE conversations SET status = 'resolved', resolved_at = ?, snooze_until = NULL WHERE id = ?", Date.now(), id);
      addSystemNote(id, `Resolved by ${req.user.name}`);
      awardResolve(req.user.id);
    } else if (b.status === 'open') {
      run("UPDATE conversations SET status = 'open', resolved_at = NULL, snooze_until = NULL WHERE id = ?", id);
      addSystemNote(id, `Reopened by ${req.user.name}`);
    } else if (b.status === 'snoozed') {
      run("UPDATE conversations SET status = 'snoozed', snooze_until = ? WHERE id = ?", Number(b.snoozeUntil), id);
      addSystemNote(id, `Snoozed until ${new Date(Number(b.snoozeUntil)).toLocaleString()}`);
    }
    publish({ type: 'conversation', id });
    return { ok: true };
  });

  app.post('/api/conversations/:id/reminders', { preHandler: anyone }, (req) => {
    const id = seeConversation(req);
    const { text, dueAt } = req.body as any;
    return { id: insert('INSERT INTO reminders(conversation_id, user_id, text, due_at) VALUES(?, ?, ?, ?)', id, req.user.id, String(text), Number(dueAt)) };
  });

  app.post('/api/conversations/:id/summary', { preHandler: anyone }, async (req) => {
    const id = seeConversation(req);
    const summary = await summarize(lines(id));
    run('UPDATE conversations SET summary = ? WHERE id = ?', summary, id);
    return { summary };
  });

  app.post('/api/conversations/:id/magic-replies', { preHandler: anyone }, async (req) => ({ replies: await magicReplies(lines(seeConversation(req))) }));

  app.post('/api/ai/rewrite', { preHandler: anyone }, async (req) => {
    const { mode, text, language } = req.body as any;
    return { text: await rewrite(String(mode), String(text), language) };
  });

  // --- Contacts ---
  app.get('/api/contacts', { preHandler: anyone }, (req) => {
    const q = (req.query as any).q as string | undefined;
    const like = `%${q ?? ''}%`;
    const rows = masks(req.user)
      ? all('SELECT * FROM contacts WHERE name LIKE ? ORDER BY id DESC LIMIT 500', like)
      : all('SELECT * FROM contacts WHERE name LIKE ? OR phone LIKE ? OR email LIKE ? ORDER BY id DESC LIMIT 500', like, like, like);
    return rows.map((c) => viewContact(req.user, c));
  });

  app.post('/api/contacts', { preHandler: anyone }, (req) => {
    const b = req.body as any;
    const id = upsertContact(String(b.phone ?? ''), String(b.name ?? ''));
    // Adding someone who already exists must not wipe their details or override a STOP.
    run(
      "UPDATE contacts SET email = CASE WHEN ? != '' THEN ? ELSE email END, opted_in = CASE WHEN ? AND opted_out_at IS NULL THEN 1 ELSE opted_in END WHERE id = ?",
      String(b.email ?? ''), String(b.email ?? ''), b.optedIn ? 1 : 0, id,
    );
    audit(req.user.id, 'contacts.create', String(id));
    return viewContact(req.user, get('SELECT * FROM contacts WHERE id = ?', id));
  });

  app.patch('/api/contacts/:id', { preHandler: anyone }, (req) => {
    const id = Number((req.params as any).id);
    const b = req.body as any;
    const c = get<any>('SELECT * FROM contacts WHERE id = ?', id) ?? fail(404, 'Contact not found');
    run(
      'UPDATE contacts SET name = ?, tags = ?, fields = ?, email = ? WHERE id = ?',
      b.name ?? c.name, JSON.stringify(b.tags ?? parse(c.tags, [])), JSON.stringify(b.fields ?? parse(c.fields, {})),
      masks(req.user) ? c.email : (b.email ?? c.email), id,
    );
    // Only the customer can undo a STOP, by replying START.
    if (b.optedIn !== undefined && req.user.role !== 'agent') run('UPDATE contacts SET opted_in = ? WHERE id = ? AND opted_out_at IS NULL', b.optedIn ? 1 : 0, id);
    for (const conv of all<{ id: number }>('SELECT id FROM conversations WHERE contact_id = ?', id)) publish({ type: 'conversation', id: conv.id });
    return viewContact(req.user, get('SELECT * FROM contacts WHERE id = ?', id));
  });

  app.delete('/api/contacts/:id', { preHandler: leads }, (req) => {
    const id = Number((req.params as any).id);
    run('DELETE FROM contacts WHERE id = ?', id);
    audit(req.user.id, 'contacts.delete', String(id));
    return { ok: true };
  });

  app.post('/api/contacts/import', { preHandler: leads }, (req) => {
    const { csv, optedIn } = req.body as any;
    const rows = parseCsv(String(csv ?? ''));
    let imported = 0, skipped = 0;
    tx(() => {
      for (const r of rows) {
        if (!normalizePhone(r.phone ?? '')) { skipped++; continue; }
        const { name = '', phone, email = '', tags = '', ...fields } = r;
        const id = upsertContact(phone, name);
        const existing = get<any>('SELECT * FROM contacts WHERE id = ?', id);
        const merged = [...new Set([...parse<string[]>(existing.tags, []), ...tags.split(/[;|]/).map((t) => t.trim()).filter(Boolean)])];
        run(
          'UPDATE contacts SET email = ?, tags = ?, fields = ?, opted_in = CASE WHEN ? AND opted_out_at IS NULL THEN 1 ELSE opted_in END WHERE id = ?',
          email || existing.email, JSON.stringify(merged), JSON.stringify({ ...parse(existing.fields, {}), ...fields }), optedIn ? 1 : 0, id,
        );
        imported++;
      }
    });
    audit(req.user.id, 'contacts.import', `${imported} rows`);
    return { imported, skipped };
  });

  app.get('/api/contacts/export', { preHandler: leads }, (req, reply) => {
    audit(req.user.id, 'contacts.export');
    const rows = all<any>('SELECT name, phone, email, tags, opted_in, opted_out_at FROM contacts').map((c) => ({ ...c, tags: parse<string[]>(c.tags, []).join(';') }));
    return reply.header('content-type', 'text/csv').header('content-disposition', 'attachment; filename="contacts.csv"').send(toCsv(rows));
  });

  app.post('/api/contacts/:id/conversation', { preHandler: anyone }, (req) => {
    const { channelId } = req.body as any;
    return { id: ensureConversation(Number((req.params as any).id), Number(channelId)) };
  });

  // --- Templates ---
  const viewTemplate = (t: any) => ({ ...t, buttons: parse(t.buttons, []), variables: parse(t.variables, []) });
  crud(app, 'templates', 'templates', ['name', 'language', 'category', 'header', 'body', 'footer', 'buttons', 'variables', 'channel_id'], leads, viewTemplate);

  app.post('/api/templates/:id/submit', { preHandler: leads }, async (req) => {
    const id = Number((req.params as any).id);
    const t = get<any>('SELECT * FROM templates WHERE id = ?', id) ?? fail(404, 'Template not found');
    const channel = t.channel_id ? getChannel(t.channel_id) : undefined;
    if (channel?.type === 'whatsapp_cloud') {
      const res = await submitTemplate(channelConfig<WhatsAppConfig>(channel), {
        ...t, buttons: parse<string[]>(t.buttons, []), samples: parse<string[]>(t.variables, []).map((v) => `sample ${v}`),
      }).catch((e) => fail(502, `Meta rejected the template: ${e.message}`));
      run('UPDATE templates SET status = ?, external_id = ? WHERE id = ?', res.status ?? 'PENDING', res.id ?? null, id);
    } else {
      run("UPDATE templates SET status = 'APPROVED' WHERE id = ?", id); // the simulator has no review queue
    }
    audit(req.user.id, 'templates.submit', String(id));
    return viewTemplate(get('SELECT * FROM templates WHERE id = ?', id));
  });

  app.post('/api/channels/:id/sync-templates', { preHandler: leads }, async (req) => {
    const id = Number((req.params as any).id);
    const channel = getChannel(id) ?? fail(404, 'Channel not found');
    if (channel.type !== 'whatsapp_cloud') fail(400, 'Only WhatsApp channels have templates to sync');
    const remote = await fetchTemplates(channelConfig<WhatsAppConfig>(channel)).catch((e) => fail(502, e.message));
    tx(() => {
      for (const r of remote) {
        const part = (type: string) => r.components?.find((c: any) => c.type === type);
        const body = part('BODY')?.text ?? '';
        const vars = [...new Set<string>(body.match(/\{\{\d+\}\}/g) ?? [])].map(() => 'name');
        const found = get<{ id: number; variables: string }>('SELECT id, variables FROM templates WHERE channel_id = ? AND name = ? AND language = ?', id, r.name, r.language);
        if (found) run('UPDATE templates SET status = ?, external_id = ?, body = ? WHERE id = ?', r.status, r.id, body, found.id);
        else {
          insert(
            'INSERT INTO templates(name, language, category, header, body, footer, buttons, variables, status, channel_id, external_id, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
            r.name, r.language, r.category, part('HEADER')?.text ?? '', body, part('FOOTER')?.text ?? '',
            JSON.stringify((part('BUTTONS')?.buttons ?? []).map((b: any) => b.text)), JSON.stringify(vars), r.status, id, r.id, Date.now(),
          );
        }
      }
    });
    return { synced: remote.length };
  });

  crud(app, 'quick-replies', 'quick_replies', ['shortcut', 'body'], leads);

  crud(app, 'forms', 'forms', ['name', 'body', 'cta', 'fields', 'meta_flow_id', 'screen'], leads, (f) => ({ ...f, fields: parse(f.fields, []) }));
  app.post('/api/conversations/:id/form', { preHandler: anyone }, async (req) => ({
    id: await send(seeConversation(req), { kind: 'form', formId: Number((req.body as any).formId) }, { userId: req.user.id }),
  }));

  app.post('/api/conversations/:id/conversion', { preHandler: anyone }, async (req) => {
    const id = seeConversation(req);
    const b = req.body as any;
    const value = Number(b.value ?? 0);
    if (!Number.isFinite(value) || value < 0) fail(400, 'Enter a valid amount');
    const contact = get<{ contact_id: number }>('SELECT contact_id FROM conversations WHERE id = ?', id)!;
    audit(req.user.id, 'conversions.create', `conversation:${id}`);
    return recordConversion({ conversationId: id, contactId: contact.contact_id, eventName: String(b.eventName || 'Purchase'), value, currency: String(b.currency || 'USD').toUpperCase(), source: 'agent' });
  });

  // --- Segments ---
  const viewSegment = (s: any) => ({ ...s, rules: parse<Rule[]>(s.rules, []), size: segmentContacts(s.id).length });
  crud(app, 'segments', 'segments', ['name', 'match', 'rules'], leads, viewSegment);

  // --- Saved views ---
  app.get('/api/views', { preHandler: anyone }, (req) =>
    all('SELECT * FROM views WHERE user_id = ?', req.user.id).map((v) => ({ ...v, filters: parse(v.filters, {}) })));
  app.post('/api/views', { preHandler: anyone }, (req) => {
    const { name, filters } = req.body as any;
    return { id: insert('INSERT INTO views(user_id, name, filters) VALUES(?, ?, ?)', req.user.id, String(name), JSON.stringify(filters ?? {})) };
  });
  app.delete('/api/views/:id', { preHandler: anyone }, (req) => {
    run('DELETE FROM views WHERE id = ? AND user_id = ?', Number((req.params as any).id), req.user.id);
    return { ok: true };
  });

  // --- Broadcasts ---
  app.get('/api/broadcasts', { preHandler: leads }, () =>
    all('SELECT b.*, t.name template_name, s.name segment_name FROM broadcasts b JOIN templates t ON t.id = b.template_id LEFT JOIN segments s ON s.id = b.segment_id ORDER BY b.id DESC')
      .map((b: any) => ({ ...b, stats: broadcastStats(b.id) })));

  app.post('/api/broadcasts', { preHandler: leads }, (req) => {
    const b = req.body as any;
    if (!b.name || !b.templateId || !b.channelId) fail(400, 'Name, template and channel are required');
    const id = insert(
      'INSERT INTO broadcasts(name, template_id, channel_id, segment_id, status, scheduled_at, created_by, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)',
      b.name, Number(b.templateId), Number(b.channelId), b.segmentId ? Number(b.segmentId) : null,
      b.scheduledAt ? 'scheduled' : 'draft', b.scheduledAt ? Number(b.scheduledAt) : null, req.user.id, Date.now(),
    );
    audit(req.user.id, 'broadcasts.create', String(id));
    if (!b.scheduledAt) { try { launch(id); } catch (e) { run('DELETE FROM broadcasts WHERE id = ?', id); fail(400, (e as Error).message); } }
    return { id };
  });

  app.post('/api/broadcasts/:id/cancel', { preHandler: leads }, (req) => {
    const id = Number((req.params as any).id);
    run("UPDATE broadcasts SET status = 'cancelled' WHERE id = ? AND status IN ('scheduled', 'sending')", id);
    run("UPDATE broadcast_recipients SET state = 'skipped', reason = 'cancelled' WHERE broadcast_id = ? AND state = 'pending'", id);
    publish({ type: 'broadcast', id });
    return { ok: true };
  });

  app.post('/api/broadcasts/:id/retarget', { preHandler: leads }, (req) => {
    const { audience, templateId } = req.body as any;
    try {
      return { id: retarget(Number((req.params as any).id), String(audience), Number(templateId), req.user.id) };
    } catch (e) {
      return fail(400, (e as Error).message);
    }
  });

  app.get('/api/broadcasts/:id/skipped', { preHandler: leads }, (req) =>
    all("SELECT reason, COUNT(*) n FROM broadcast_recipients WHERE broadcast_id = ? AND state IN ('skipped','failed') GROUP BY reason", Number((req.params as any).id)));

  // --- Bots ---
  const viewBot = (b: any) => ({ ...b, trigger: parse(b.trigger, {}), graph: parse(b.graph, { nodes: [], edges: [] }) });
  crud(app, 'bots', 'bots', ['name', 'enabled', 'trigger', 'graph'], leads, viewBot);
  app.get('/api/bots/:id/journey', { preHandler: leads }, (req) => botJourney(Number((req.params as any).id)));

  crud(app, 'knowledge', 'knowledge', ['title', 'content'], leads);

  // --- Analytics and fun ---
  app.get('/api/analytics', { preHandler: leads }, (req) => overview(Math.min(Number((req.query as any).days) || 14, 365)));
  app.get('/api/analytics/agents.csv', { preHandler: leads }, (req, reply) =>
    reply.header('content-type', 'text/csv').header('content-disposition', 'attachment; filename="agents.csv"')
      .send(toCsv(overview(Math.min(Number((req.query as any).days) || 14, 365)).agents)));

  app.get('/api/leaderboard', { preHandler: anyone }, () => ({
    enabled: getSettings().fun_mode,
    catalog: ACHIEVEMENTS,
    users: all<any>('SELECT id, name, xp, streak FROM users WHERE active = 1 ORDER BY xp DESC').map((u) => ({
      ...u, achievements: all<{ key: string }>('SELECT key FROM achievements WHERE user_id = ?', u.id).map((a) => a.key),
    })),
  }));

  // --- Admin ---
  app.get('/api/settings', { preHandler: anyone }, () => getSettings());
  app.patch('/api/settings', { preHandler: admins }, (req) => {
    for (const [k, v] of Object.entries(req.body as object)) {
      if (k in DEFAULT_SETTINGS) setSetting(k, v);
    }
    audit(req.user.id, 'settings.update');
    return getSettings();
  });

  app.get('/api/users', { preHandler: anyone }, (req) => all<User>('SELECT * FROM users ORDER BY name').map((u) => {
    const { prefs, ...rest } = publicUser(u);
    return req.user.role === 'agent' ? { id: rest.id, name: rest.name, role: rest.role, active: rest.active } : rest;
  }));

  app.post('/api/users', { preHandler: admins }, (req) => {
    const b = req.body as any;
    if (!b.name || !b.email || String(b.password ?? '').length < 8) fail(400, 'Name, email and a password of at least 8 characters are required');
    if (get('SELECT 1 FROM users WHERE email = ?', b.email)) fail(409, 'That email is already in use');
    const id = insert(
      'INSERT INTO users(name, email, phone, pass_hash, role, manager_id, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)',
      b.name, b.email, b.phone ?? null, hashPassword(b.password), ['admin', 'manager', 'agent'].includes(b.role) ? b.role : 'agent', b.managerId ?? null, Date.now(),
    );
    audit(req.user.id, 'users.create', String(id));
    return { id };
  });

  app.patch('/api/users/:id', { preHandler: admins }, (req) => {
    const id = Number((req.params as any).id);
    const b = req.body as any;
    const u = get<any>('SELECT * FROM users WHERE id = ?', id) ?? fail(404, 'User not found');
    if (b.managerId && teamIds(id).includes(Number(b.managerId))) fail(400, 'That would create a reporting loop');
    if (id === req.user.id && (b.active === 0 || (b.role && b.role !== 'admin'))) fail(400, "You can't remove your own admin access");
    run(
      'UPDATE users SET role = ?, manager_id = ?, active = ?, phone = ? WHERE id = ?',
      b.role ?? u.role, b.managerId === undefined ? u.manager_id : b.managerId, b.active ?? u.active, b.phone ?? u.phone, id,
    );
    if (b.active === 0) run('DELETE FROM sessions WHERE user_id = ?', id);
    audit(req.user.id, 'users.update', String(id));
    return { ok: true };
  });

  app.get('/api/channels', { preHandler: anyone }, (req) =>
    all<Channel>('SELECT * FROM channels ORDER BY id').map((c) => (req.user.role === 'admin' ? publicChannel(c) : { id: c.id, type: c.type, name: c.name, phone: c.phone, enabled: c.enabled })));

  app.post('/api/channels', { preHandler: admins }, (req) => {
    const b = req.body as any;
    if (!['simulator', 'whatsapp_cloud'].includes(b.type)) fail(400, 'Unknown channel type');
    const id = insert('INSERT INTO channels(type, name, phone, config, created_at) VALUES(?, ?, ?, ?, ?)', b.type, String(b.name), String(b.phone ?? ''), sealSecret(JSON.stringify(b.config ?? {})), Date.now());
    audit(req.user.id, 'channels.create', String(id));
    return publicChannel(getChannel(id)!);
  });

  app.patch('/api/channels/:id', { preHandler: admins }, (req) => {
    const id = Number((req.params as any).id);
    const c = getChannel(id) ?? fail(404, 'Channel not found');
    const b = req.body as any;
    const merged: Record<string, unknown> = { ...channelConfig(c) };
    for (const [k, v] of Object.entries(b.config ?? {})) if (v !== '' && typeof v === 'string') merged[k] = v; // blank keeps the stored secret
    run('UPDATE channels SET name = ?, phone = ?, enabled = ?, config = ? WHERE id = ?', b.name ?? c.name, b.phone ?? c.phone, b.enabled ?? c.enabled, sealSecret(JSON.stringify(merged)), id);
    audit(req.user.id, 'channels.update', String(id));
    return publicChannel(getChannel(id)!);
  });

  app.get('/api/api-keys', { preHandler: admins }, () => all('SELECT id, name, prefix, created_at, last_used_at FROM api_keys ORDER BY id DESC'));
  app.post('/api/api-keys', { preHandler: admins }, (req) => {
    audit(req.user.id, 'api_keys.create');
    return createApiKey(String((req.body as any).name || 'API key'));
  });
  app.delete('/api/api-keys/:id', { preHandler: admins }, (req) => {
    run('DELETE FROM api_keys WHERE id = ?', Number((req.params as any).id));
    audit(req.user.id, 'api_keys.delete');
    return { ok: true };
  });

  app.get('/api/webhooks', { preHandler: admins }, () => all('SELECT id, url, events, enabled, last_status FROM webhooks').map((w: any) => ({ ...w, events: parse(w.events, []) })));
  app.post('/api/webhooks', { preHandler: admins }, (req) => {
    const b = req.body as any;
    const url = new URL(String(b.url));
    if (!['http:', 'https:'].includes(url.protocol)) fail(400, 'Webhook URLs must use http or https');
    const secret = randomBytes(24).toString('base64url');
    audit(req.user.id, 'webhooks.create', url.host);
    return { id: insert('INSERT INTO webhooks(url, secret, events) VALUES(?, ?, ?)', url.href, sealSecret(secret), JSON.stringify(b.events ?? ['*'])), secret };
  });
  app.delete('/api/webhooks/:id', { preHandler: admins }, (req) => {
    run('DELETE FROM webhooks WHERE id = ?', Number((req.params as any).id));
    return { ok: true };
  });

  app.get('/api/audit', { preHandler: admins }, () =>
    all('SELECT a.*, u.name user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 200'));

  // --- Media ---
  app.post('/api/media', { preHandler: anyone }, (req) => {
    const { name, mime, data } = req.body as any;
    const ext = MEDIA_TYPES[mime];
    if (!ext) fail(415, 'Attach a PNG, JPG, WEBP or PDF file');
    const buf = Buffer.from(String(data), 'base64');
    if (buf.length > 8 * 1024 * 1024) fail(413, 'Files can be up to 8 MB');
    const file = saveMedia(buf, ext);
    return { mediaFile: file, mime, fileName: basename(String(name || file)) };
  });

  app.get('/api/media/:file', { preHandler: anyone }, (req, reply) => {
    const file = basename((req.params as any).file);
    const path = join(config.mediaDir, file);
    if (!existsSync(path)) fail(404, 'File not found');
    const ext = file.split('.').pop() ?? '';
    const mime = Object.entries(MEDIA_TYPES).find(([, e]) => e === ext)?.[0] ?? 'application/octet-stream';
    reply.header('content-type', mime);
    if (!mime.startsWith('image/')) reply.header('content-disposition', `attachment; filename="${file}"`);
    return reply.send(createReadStream(path));
  });

  // --- Simulator: play the customer ---
  app.post('/api/simulator/inbound', { preHandler: anyone }, async (req) => {
    const { channelId, from, name, body, form } = req.body as any;
    const channel = getChannel(Number(channelId));
    if (channel?.type !== 'simulator') fail(400, 'Pick a simulator channel');
    if (!normalizePhone(String(from ?? '')) || !(String(body ?? '').trim() || form)) fail(400, 'A phone number and a message are required');
    return receiveInbound({ channelId: channel!.id, from: String(from), name: String(name ?? ''), body: String(body ?? ''), form });
  });

  app.get('/api/simulator/thread', { preHandler: anyone }, (req) => {
    const { channelId, from } = req.query as any;
    // Simulator only: this bypasses inbox permissions, so it must never read a real channel.
    if (getChannel(Number(channelId))?.type !== 'simulator') fail(400, 'Pick a simulator channel');
    return all(
      `SELECT m.id, m.direction, m.kind, m.body, m.payload, m.status, m.created_at FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN contacts k ON k.id = c.contact_id
       WHERE c.channel_id = ? AND k.phone = ? AND m.direction != 'internal' ORDER BY m.id DESC LIMIT 100`,
      Number(channelId), normalizePhone(String(from)),
    ).reverse().map((m: any) => ({ ...m, payload: parse(m.payload, {}) }));
  });

  // --- Meta webhook ---
  app.get('/webhooks/whatsapp', (req, reply) => {
    const q = req.query as Record<string, string>;
    const tokens = all<Channel>("SELECT * FROM channels WHERE type = 'whatsapp_cloud'").map((c) => channelConfig<WhatsAppConfig>(c).verifyToken);
    if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] && tokens.includes(q['hub.verify_token'])) {
      return reply.type('text/plain').send(q['hub.challenge']);
    }
    return reply.status(403).send({ error: 'Verification failed' });
  });

  app.post('/webhooks/whatsapp', async (req, reply) => {
    const raw = req.rawBody ?? Buffer.alloc(0);
    const { messages, statuses, calls, callStatuses } = parseWebhook(req.body);
    const channels = all<Channel>("SELECT * FROM channels WHERE type = 'whatsapp_cloud' AND enabled = 1");
    const ids = new Set([...messages.map((m) => m.phoneNumberId), ...parsedPhoneIds(req.body)]);
    const owners = channels.filter((c) => ids.has(channelConfig<WhatsAppConfig>(c).phoneNumberId));
    // The signature decides trust. The payload only says which channel's secret to check it with.
    if (!owners.length || !owners.every((c) => verifySignature(raw, req.headers['x-hub-signature-256'], channelConfig<WhatsAppConfig>(c).appSecret))) {
      return reply.status(401).send({ error: 'Bad signature' });
    }
    for (const s of statuses) applyStatus(s.externalId, s.status, s.error);
    for (const c of calls) {
      const channel = owners.find((o) => channelConfig<WhatsAppConfig>(o).phoneNumberId === c.phoneNumberId);
      if (channel) onCallEvent(channel.id, c);
    }
    for (const s of callStatuses) onCallStatus(s.externalId, s.status);
    for (const m of messages) {
      const channel = owners.find((c) => channelConfig<WhatsAppConfig>(c).phoneNumberId === m.phoneNumberId)!;
      const payload: Record<string, unknown> = {};
      if (m.mediaId) {
        const ext = MEDIA_TYPES[(m.mime ?? '').split(';')[0]];
        if (ext) {
          const buf = await downloadMedia(channelConfig<WhatsAppConfig>(channel), m.mediaId).catch(() => null);
          if (buf) Object.assign(payload, { mediaFile: saveMedia(buf, ext), mime: m.mime, fileName: m.fileName ?? 'attachment' });
        }
      }
      await receiveInbound({ channelId: channel.id, from: m.from, name: m.name, body: m.body, kind: m.kind, payload, externalId: m.externalId, referral: m.referral, form: m.form });
    }
    return { ok: true };
  });
}

function parsedPhoneIds(body: any): string[] {
  return (body?.entry ?? []).flatMap((e: any) => (e?.changes ?? []).map((c: any) => String(c?.value?.metadata?.phone_number_id ?? '')));
}

export function saveMedia(buf: Buffer, ext: string) {
  mkdirSync(config.mediaDir, { recursive: true });
  const file = `${randomUUID()}.${ext}`;
  writeFileSync(join(config.mediaDir, file), buf);
  return file;
}
