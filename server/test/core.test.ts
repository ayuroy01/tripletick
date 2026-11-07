import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { beforeEach, describe, it, mock } from 'node:test';
import { createApp } from '../src/app.ts';
import { broadcastStats, launch, retarget, tickBroadcasts } from '../src/broadcasts.ts';
import { matches } from '../src/bots.ts';
import { setSimulatorDelays } from '../src/channels/simulator.ts';
import { parseWebhook, toCloudPayload, verifySignature } from '../src/channels/whatsapp.ts';
import { get, all, insert, openDb, run, setSetting } from '../src/db.ts';
import { applyStatus, receiveInbound, send, SESSION_WINDOW_MS } from '../src/messaging.ts';
import { maskCards, maskPhone } from '../src/routes.ts';
import { parseCsv, toCsv } from '../src/analytics.ts';
import { detectMood, searchKnowledge } from '../src/ai.ts';
import { tick } from '../src/scheduler.ts';
import { seedDemo } from '../src/seed.ts';

setSimulatorDelays({ delivered: 3_600_000, read: 3_600_000 });

let app: Awaited<ReturnType<typeof createApp>>;
let channel: number;
const SECRET = 'app-secret';

async function login(email: string) {
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'tripletick' } });
  assert.equal(r.statusCode, 200);
  return r.headers['set-cookie'] as string;
}
const api = async (cookie: string, method: any, url: string, payload?: object) =>
  app.inject({ method, url, payload, headers: { cookie } });

beforeEach(async () => {
  openDb(':memory:');
  channel = insert("INSERT INTO channels(type, name, created_at) VALUES('simulator', 'Sim', 0)");
  app = await createApp();
});

function approvedTemplate() {
  return insert("INSERT INTO templates(name, body, variables, status, created_at) VALUES('t', 'Hi {{1}}', '[\"first_name\"]', 'APPROVED', 0)");
}

describe('messaging rules', () => {
  it('blocks free text outside the 24-hour window but allows approved templates', async () => {
    const r = await receiveInbound({ channelId: channel, from: '+15550001', name: 'Test Person', body: 'hello' });
    await send(r!.conversationId, { kind: 'text', body: 'inside window' });
    run('UPDATE conversations SET last_inbound_at = ?', Date.now() - SESSION_WINDOW_MS - 1000);
    await assert.rejects(send(r!.conversationId, { kind: 'text', body: 'too late' }), { code: 'window_closed' });
    const id = await send(r!.conversationId, { kind: 'template', templateId: approvedTemplate() });
    assert.equal(get<any>('SELECT body FROM messages WHERE id = ?', id).body, 'Hi Test');
  });

  it('refuses unapproved templates', async () => {
    const r = await receiveInbound({ channelId: channel, from: '+15550001', body: 'hello' });
    const t = insert("INSERT INTO templates(name, body, created_at) VALUES('d', 'x', 0)");
    await assert.rejects(send(r!.conversationId, { kind: 'template', templateId: t }), { code: 'template_not_approved' });
  });

  it('ignores duplicate webhook deliveries', async () => {
    const m = { channelId: channel, from: '+15550001', body: 'hi', externalId: 'wamid.1' };
    assert.ok(await receiveInbound(m));
    assert.equal(await receiveInbound(m), null);
    assert.equal(get<any>('SELECT COUNT(*) n FROM messages').n, 1);
  });

  it('moves statuses forward only and awards the third tick on reply', async () => {
    const r = await receiveInbound({ channelId: channel, from: '+15550001', body: 'hi' });
    const id = await send(r!.conversationId, { kind: 'text', body: 'yo' });
    const ext = get<any>('SELECT external_id e FROM messages WHERE id = ?', id).e;
    const status = () => get<any>('SELECT status s FROM messages WHERE id = ?', id).s;
    applyStatus(ext, 'read');
    applyStatus(ext, 'delivered'); // out-of-order receipt
    assert.equal(status(), 'read');
    await receiveInbound({ channelId: channel, from: '+15550001', body: 'nice' });
    assert.equal(status(), 'acted');
  });

  it('handles STOP and START', async () => {
    await receiveInbound({ channelId: channel, from: '+15550001', body: 'hi' });
    await receiveInbound({ channelId: channel, from: '+15550001', body: ' stop! ' });
    assert.ok(get<any>('SELECT opted_out_at o FROM contacts').o);
    await receiveInbound({ channelId: channel, from: '+15550001', body: 'START' });
    const c = get<any>('SELECT opted_out_at o, opted_in i FROM contacts');
    assert.equal(c.o, null);
    assert.equal(c.i, 1);
  });

  it('does not treat a sentence containing stop as an opt-out', async () => {
    await receiveInbound({ channelId: channel, from: '+15550001', body: "please don't stop the order" });
    assert.equal(get<any>('SELECT opted_out_at o FROM contacts').o, null);
  });

  it('flags an SLA breach only while nobody has replied', async () => {
    const a = await receiveInbound({ channelId: channel, from: '+15550001', body: 'hi' });
    const b = await receiveInbound({ channelId: channel, from: '+15550002', body: 'hi' });
    run("INSERT INTO users(name, email, pass_hash, created_at) VALUES('A', 'a@x.io', 'x', 0)");
    await send(b!.conversationId, { kind: 'text', body: 'on it' }, { userId: 1 });
    await tick(Date.now() + 3600e3);
    assert.equal(get<any>('SELECT sla_breached s FROM conversations WHERE id = ?', a!.conversationId).s, 1);
    assert.equal(get<any>('SELECT sla_breached s FROM conversations WHERE id = ?', b!.conversationId).s, 0);
  });
});

describe('bots', () => {
  const graph = {
    nodes: [
      { id: 's', type: 'start', data: {} },
      { id: 'b', type: 'buttons', data: { text: 'Pick', options: ['Sales', 'Help'] } },
      { id: 'q', type: 'question', data: { text: 'Your city?', saveTo: 'city' } },
      { id: 'c', type: 'condition', data: { field: 'city', op: 'equals', value: 'pune' } },
      { id: 'y', type: 'message', data: { text: 'Hello {{city}}' } },
      { id: 'n', type: 'tag', data: { tag: 'elsewhere' } },
      { id: 'h', type: 'handoff', data: {} },
    ],
    edges: [
      { source: 's', target: 'b' }, { source: 'b', sourceHandle: 'opt0', target: 'q' }, { source: 'b', sourceHandle: 'opt1', target: 'h' },
      { source: 'q', target: 'c' }, { source: 'c', sourceHandle: 'true', target: 'y' }, { source: 'c', sourceHandle: 'false', target: 'n' },
    ],
  };
  const addBot = (g: object = graph) => insert("INSERT INTO bots(name, enabled, trigger, graph, created_at) VALUES('b', 1, ?, ?, 0)", '{"type":"keyword","keywords":["menu"]}', JSON.stringify(g));
  const bodies = () => all<any>("SELECT body FROM messages WHERE direction = 'out' ORDER BY id").map((m) => m.body);

  it('walks branches, saves answers and fills variables', async () => {
    addBot();
    const from = '+15550001';
    await receiveInbound({ channelId: channel, from, body: 'menu please' });
    await receiveInbound({ channelId: channel, from, body: 'sales' });
    await receiveInbound({ channelId: channel, from, body: 'Pune' });
    assert.deepEqual(bodies(), ['Pick', 'Your city?', 'Hello Pune']);
    assert.equal(get<any>('SELECT status s FROM bot_runs').s, 'done');
  });

  it('takes the false branch', async () => {
    addBot();
    const from = '+15550001';
    for (const body of ['menu', 'Sales', 'Oslo']) await receiveInbound({ channelId: channel, from, body });
    assert.deepEqual(JSON.parse(get<any>('SELECT tags t FROM contacts').t), ['elsewhere']);
  });

  it('stops a looping flow instead of spamming the customer', async () => {
    addBot({
      nodes: [{ id: 's', type: 'start', data: {} }, { id: 'm', type: 'message', data: { text: 'again' } }],
      edges: [{ source: 's', target: 'm' }, { source: 'm', target: 'm' }],
    });
    await receiveInbound({ channelId: channel, from: '+15550001', body: 'menu' });
    assert.equal(get<any>('SELECT status s FROM bot_runs').s, 'failed');
    assert.ok(bodies().length <= 50);
  });

  it('stays out of chats a human owns', async () => {
    addBot();
    const r = await receiveInbound({ channelId: channel, from: '+15550001', body: 'hi' });
    const u = insert("INSERT INTO users(name, email, pass_hash, created_at) VALUES('A', 'a@x.io', 'x', 0)");
    run('UPDATE conversations SET assignee_id = ? WHERE id = ?', u, r!.conversationId);
    await receiveInbound({ channelId: channel, from: '+15550001', body: 'menu' });
    assert.equal(get<any>('SELECT COUNT(*) n FROM bot_runs').n, 0);
  });

  it('matches whole keywords only', () => {
    const t = { type: 'keyword' as const, keywords: ['menu'] };
    assert.ok(matches(t, 'show MENU!', false, true));
    assert.ok(!matches(t, 'menus', false, true));
  });
});

describe('broadcasts', () => {
  const contact = (phone: string, optIn: number, optedOut: number | null = null) =>
    insert('INSERT INTO contacts(name, phone, opted_in, opted_out_at, created_at) VALUES(?, ?, ?, ?, 0)', 'Pat', phone, optIn, optedOut);
  const create = (t: number) => insert("INSERT INTO broadcasts(name, template_id, channel_id, created_at) VALUES('b', ?, ?, 0)", t, channel);

  it('only reaches consenting contacts', async () => {
    const t = approvedTemplate();
    contact('+15550001', 1);
    contact('+15550002', 0);
    contact('+15550003', 1, 123);
    const b = create(t);
    launch(b);
    await tickBroadcasts();
    const s = broadcastStats(b);
    assert.equal(s.sent, 1);
    assert.equal(s.skipped, 2);
    assert.equal(get<any>('SELECT status s FROM broadcasts WHERE id = ?', b).s, 'done');
  });

  it('skips someone who opted out after the audience froze', async () => {
    const t = approvedTemplate();
    const c = contact('+15550001', 1);
    const b = create(t);
    launch(b);
    run('UPDATE contacts SET opted_out_at = 1 WHERE id = ?', c);
    await tickBroadcasts();
    assert.equal(broadcastStats(b).sent, 0);
  });

  it('applies the frequency cap across broadcasts', async () => {
    const t = approvedTemplate();
    contact('+15550001', 1);
    const first = create(t);
    launch(first);
    await tickBroadcasts();
    const second = create(t);
    launch(second);
    await tickBroadcasts();
    assert.equal(broadcastStats(second).sent, 0);
    assert.equal(get<any>('SELECT reason r FROM broadcast_recipients WHERE broadcast_id = ?', second).r, 'frequency_cap');
  });

  it('respects the per-tick rate limit', async () => {
    setSetting('broadcast_rate_per_tick', 2);
    const t = approvedTemplate();
    for (let i = 0; i < 5; i++) contact(`+1555000${i}`, 1);
    const b = create(t);
    launch(b);
    await tickBroadcasts();
    assert.equal(broadcastStats(b).sent, 2);
    await tickBroadcasts();
    await tickBroadcasts();
    assert.equal(broadcastStats(b).sent, 5);
  });

  it('retargets one slice of the funnel', async () => {
    setSetting('broadcast_cap_hours', 0);
    const t = approvedTemplate();
    contact('+15550001', 1);
    contact('+15550002', 1);
    const b = create(t);
    launch(b);
    await tickBroadcasts();
    const ext = all<any>("SELECT external_id e FROM messages WHERE direction = 'out' ORDER BY id");
    applyStatus(ext[0].e, 'read');
    const next = retarget(b, 'read_no_action', t, 0 || insert("INSERT INTO users(name, email, pass_hash, created_at) VALUES('A', 'a@x.io', 'x', 0)"));
    assert.equal(all('SELECT 1 FROM broadcast_recipients WHERE broadcast_id = ?', next).length, 1);
  });
});

describe('WhatsApp Cloud adapter', () => {
  const webhook = {
    entry: [{ changes: [{ value: {
      metadata: { phone_number_id: '123' },
      contacts: [{ wa_id: '15550001', profile: { name: 'Pat' } }],
      messages: [
        { from: '15550001', id: 'wamid.A', type: 'text', text: { body: 'hello' } },
        { from: '15550001', id: 'wamid.B', type: 'interactive', interactive: { button_reply: { title: 'Sales' } }, referral: { source_type: 'ad', headline: 'Sale' } },
      ],
      statuses: [{ id: 'wamid.C', status: 'read' }, { id: 'wamid.D', status: 'failed', errors: [{ title: 'Bad number' }] }],
    } }] }],
  };

  it('parses messages, button replies, ad referrals and statuses', () => {
    const { messages, statuses } = parseWebhook(webhook);
    assert.equal(messages[0].from, '+15550001');
    assert.equal(messages[0].name, 'Pat');
    assert.equal(messages[1].body, 'Sales');
    assert.equal(messages[1].referral?.source, 'ad');
    assert.equal(statuses[1].error, 'Bad number');
  });

  it('verifies signatures', () => {
    const raw = Buffer.from('{"a":1}');
    const good = `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}`;
    assert.ok(verifySignature(raw, good, SECRET));
    assert.ok(!verifySignature(Buffer.from('{"a":2}'), good, SECRET));
    assert.ok(!verifySignature(raw, 'sha256=short', SECRET));
    assert.ok(!verifySignature(raw, undefined, SECRET));
    assert.ok(!verifySignature(raw, good, ''));
  });

  it('caps reply buttons at Meta limits and strips the plus sign', async () => {
    const p: any = await toCloudPayload({} as any, { kind: 'buttons', to: '+1 555-0001', body: 'x', options: ['a', 'b', 'c', 'd', 'x'.repeat(30)] });
    assert.equal(p.to, '15550001');
    assert.equal(p.interactive.action.buttons.length, 3);
  });

  it('rejects an unsigned webhook and accepts a signed one end to end', async () => {
    const wa = insert(
      "INSERT INTO channels(type, name, config, created_at) VALUES('whatsapp_cloud', 'WA', ?, 0)",
      JSON.stringify({ phoneNumberId: '123', appSecret: SECRET, accessToken: 'tok', verifyToken: 'vt' }),
    );
    const body = JSON.stringify(webhook);
    const headers = { 'content-type': 'application/json' };
    const bad = await app.inject({ method: 'POST', url: '/webhooks/whatsapp', payload: body, headers: { ...headers, 'x-hub-signature-256': 'sha256=00' } });
    assert.equal(bad.statusCode, 401);
    assert.equal(get<any>('SELECT COUNT(*) n FROM messages').n, 0);
    const sig = `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
    const ok = await app.inject({ method: 'POST', url: '/webhooks/whatsapp', payload: body, headers: { ...headers, 'x-hub-signature-256': sig } });
    assert.equal(ok.statusCode, 200);
    assert.equal(get<any>("SELECT COUNT(*) n FROM messages WHERE direction = 'in'").n, 2);
    assert.equal(get<any>('SELECT channel_id c FROM conversations').c, wa);
    assert.equal(JSON.parse(get<any>('SELECT fields f FROM contacts').f).ad_source, 'ad');
  });

  it('answers the verification challenge only with the right token', async () => {
    insert("INSERT INTO channels(type, name, config, created_at) VALUES('whatsapp_cloud', 'WA', ?, 0)", JSON.stringify({ verifyToken: 'vt' }));
    const url = (t: string) => `/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${t}&hub.challenge=42`;
    assert.equal((await app.inject({ url: url('vt') })).body, '42');
    assert.equal((await app.inject({ url: url('no') })).statusCode, 403);
  });

  it('sends through the Graph API', async () => {
    const wa = insert(
      "INSERT INTO channels(type, name, config, created_at) VALUES('whatsapp_cloud', 'WA', ?, 0)",
      JSON.stringify({ phoneNumberId: '123', accessToken: 'tok' }),
    );
    const f = mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ messages: [{ id: 'wamid.X' }] })));
    const r = await receiveInbound({ channelId: wa, from: '+15550001', body: 'hi' });
    const id = await send(r!.conversationId, { kind: 'text', body: 'hey' });
    f.mock.restore();
    const [url, init] = f.mock.calls[0].arguments as [string, RequestInit];
    assert.match(url, /graph\.facebook\.com\/v\d+\.0\/123\/messages/);
    assert.equal((init.headers as any).authorization, 'Bearer tok');
    assert.equal(get<any>('SELECT external_id e FROM messages WHERE id = ?', id).e, 'wamid.X');
  });

  it('records a provider failure on the message', async () => {
    const wa = insert("INSERT INTO channels(type, name, config, created_at) VALUES('whatsapp_cloud', 'WA', ?, 0)", JSON.stringify({ phoneNumberId: '123', accessToken: 'bad' }));
    const f = mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: { message: 'Invalid token' } }), { status: 401 }));
    const r = await receiveInbound({ channelId: wa, from: '+15550001', body: 'hi' });
    const id = await send(r!.conversationId, { kind: 'text', body: 'hey' });
    f.mock.restore();
    const m = get<any>('SELECT status, error FROM messages WHERE id = ?', id);
    assert.equal(m.status, 'failed');
    assert.equal(m.error, 'Invalid token');
  });
});

describe('access control', () => {
  beforeEach(() => {
    openDb(':memory:');
    seedDemo();
  });

  it('requires sign-in', async () => {
    assert.equal((await app.inject({ url: '/api/conversations' })).statusCode, 401);
  });

  it('hides other agents chats and masks customer details from agents', async () => {
    const sky = await login('sky@tripletick.local');
    const list = (await api(sky, 'GET', '/api/conversations')).json();
    assert.ok(list.every((c: any) => c.assignee_name === 'Sky Agent' || c.assignee_name === null));
    assert.ok(list.every((c: any) => c.contact.phone.includes('•')));
    const noorChat = get<any>("SELECT c.id FROM conversations c JOIN users u ON u.id = c.assignee_id WHERE u.name = 'Noor Agent'");
    assert.equal((await api(sky, 'GET', `/api/conversations/${noorChat.id}`)).statusCode, 404);
    const lead = await login('robin@tripletick.local');
    assert.equal((await api(lead, 'GET', `/api/conversations/${noorChat.id}`)).statusCode, 200);
  });

  it('cannot find a contact by phone number through masked search', async () => {
    const sky = await login('sky@tripletick.local');
    assert.equal((await api(sky, 'GET', '/api/conversations?q=%2B15550142')).json().length, 0);
    assert.equal((await api(sky, 'GET', '/api/contacts?q=%2B15550142')).json().length, 0);
  });

  it('keeps admin and lead routes away from agents', async () => {
    const sky = await login('sky@tripletick.local');
    for (const [m, url] of [['GET', '/api/audit'], ['GET', '/api/api-keys'], ['GET', '/api/contacts/export'], ['GET', '/api/analytics'], ['PATCH', '/api/settings']]) {
      assert.equal((await api(sky, m, url, m === 'PATCH' ? {} : undefined)).statusCode, 403, url);
    }
  });

  it('never returns channel secrets', async () => {
    const admin = await login('demo@tripletick.local');
    await api(admin, 'POST', '/api/channels', { type: 'whatsapp_cloud', name: 'WA', config: { accessToken: 'super-secret', appSecret: 'also-secret' } });
    const body = (await api(admin, 'GET', '/api/channels')).body;
    assert.ok(!body.includes('super-secret') && !body.includes('also-secret'));
  });

  it('blocks agents from sharing their own contact details', async () => {
    const sky = await login('sky@tripletick.local');
    const c = get<any>("SELECT c.id FROM conversations c JOIN contacts k ON k.id = c.contact_id WHERE k.name = 'Maya Fictional'");
    const r = await api(sky, 'POST', `/api/conversations/${c.id}/messages`, { body: 'email me at sky@tripletick.local' });
    assert.equal(r.statusCode, 422);
    assert.equal(r.json().code, 'contact_sharing_blocked');
  });

  it('accepts API keys and rejects bad ones', async () => {
    const admin = await login('demo@tripletick.local');
    const { key } = (await api(admin, 'POST', '/api/api-keys', { name: 'zap' })).json();
    assert.equal((await app.inject({ url: '/api/contacts', headers: { authorization: `Bearer ${key}` } })).statusCode, 200);
    assert.equal((await app.inject({ url: '/api/contacts', headers: { authorization: 'Bearer nope' } })).statusCode, 401);
  });

  it('locks out repeated bad logins', async () => {
    let last = 0;
    for (let i = 0; i < 10; i++) {
      last = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'lockout@x.io', password: 'nope' } })).statusCode;
    }
    assert.equal(last, 429);
  });

  it('refuses a second first-run setup', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { name: 'x', email: 'x@x.io', password: 'longenough' } });
    assert.equal(r.statusCode, 409);
  });
});

describe('regressions', () => {
  beforeEach(() => {
    openDb(':memory:');
    seedDemo();
  });
  const sim = () => get<any>("SELECT id FROM channels WHERE type = 'simulator' LIMIT 1").id;

  it('never lets the simulator read a real channel', async () => {
    const admin = await login('demo@tripletick.local');
    const wa = (await api(admin, 'POST', '/api/channels', { type: 'whatsapp_cloud', name: 'WA', config: {} })).json();
    await receiveInbound({ channelId: wa.id, from: '+15559999', body: 'private' });
    const sky = await login('sky@tripletick.local');
    const r = await api(sky, 'GET', `/api/simulator/thread?channelId=${wa.id}&from=%2B15559999`);
    assert.equal(r.statusCode, 400);
    assert.ok(!r.body.includes('private'));
  });

  it('keeps details and opt-outs when a contact is added again', async () => {
    const admin = await login('demo@tripletick.local');
    await api(admin, 'POST', '/api/contacts', { phone: '+15550142', optedIn: true });
    assert.equal(get<any>("SELECT email e FROM contacts WHERE phone = '+15550142'").e, 'maya@example.com');
    run("UPDATE contacts SET opted_out_at = 1, opted_in = 0 WHERE phone = '+15550142'");
    await api(admin, 'POST', '/api/contacts', { phone: '+15550142', optedIn: true });
    const id = get<any>("SELECT id FROM contacts WHERE phone = '+15550142'").id;
    await api(admin, 'PATCH', `/api/contacts/${id}`, { optedIn: true });
    const c = get<any>('SELECT opted_in i, opted_out_at o FROM contacts WHERE id = ?', id);
    assert.equal(c.i, 0);
    assert.equal(c.o, 1);
  });

  it('answers 409, not 500, when something is still in use', async () => {
    const admin = await login('demo@tripletick.local');
    const t = get<any>('SELECT id FROM templates LIMIT 1').id;
    insert("INSERT INTO broadcasts(name, template_id, channel_id, created_at) VALUES('b', ?, ?, 0)", t, sim());
    assert.equal((await api(admin, 'DELETE', `/api/templates/${t}`)).statusCode, 409);
    assert.equal((await api(admin, 'POST', '/api/quick-replies', { shortcut: 'hours', body: 'dup' })).statusCode, 409);
  });

  it('stops a waiting bot when a human steps in', async () => {
    const from = '+15550333';
    const r = await receiveInbound({ channelId: sim(), from, body: 'menu' });
    assert.equal(get<any>('SELECT status s FROM bot_runs').s, 'waiting');
    await send(r!.conversationId, { kind: 'text', body: 'I can help' }, { userId: 3 });
    const before = get<any>("SELECT COUNT(*) n FROM messages WHERE direction = 'out'").n;
    await receiveInbound({ channelId: sim(), from, body: 'Track order' });
    assert.equal(get<any>("SELECT COUNT(*) n FROM messages WHERE direction = 'out'").n, before);
    assert.equal(get<any>('SELECT status s FROM bot_runs').s, 'handoff');
  });

  it('does not breach SLA on a bot-handled chat, but restarts the clock on handoff', async () => {
    const from = '+15550334';
    const r = await receiveInbound({ channelId: sim(), from, body: 'menu' });
    await tick(Date.now() + 3600e3);
    assert.equal(get<any>('SELECT sla_breached s FROM conversations WHERE id = ?', r!.conversationId).s, 0);
    await receiveInbound({ channelId: sim(), from, body: 'Talk to a human' });
    const c = get<any>('SELECT first_response_at f, sla_due_at d, assignee_id a FROM conversations WHERE id = ?', r!.conversationId);
    assert.equal(c.f, null);
    assert.ok(c.a);
    await tick(Date.now() + 3600e3);
    assert.equal(get<any>('SELECT sla_breached s FROM conversations WHERE id = ?', r!.conversationId).s, 1);
  });
});

describe('helpers', () => {
  it('masks real card numbers but not order numbers', () => {
    assert.equal(maskCards('card 4242 4242 4242 4242 ok'), 'card •••• •••• •••• 4242 ok');
    assert.equal(maskCards('order 1234567890123456'), 'order 1234567890123456');
    assert.equal(maskPhone('+15550142'), '+15•••142');
  });

  it('round-trips CSV and neutralises spreadsheet formulas', () => {
    const csv = toCsv([{ name: 'A, "B"', note: '=HYPERLINK("x")' }]);
    assert.ok(csv.includes(`"'=HYPERLINK(""x"")"`));
    assert.equal(parseCsv(csv)[0].name, 'A, "B"');
  });

  it('reads mood and searches the knowledge base offline', () => {
    assert.equal(detectMood('this is terrible'), 'upset');
    assert.equal(detectMood('thanks so much'), 'happy');
    insert("INSERT INTO knowledge(title, content, created_at) VALUES('Shipping', 'Takes 3 days', 0)");
    assert.equal(searchKnowledge('how long is shipping')[0]?.title, 'Shipping');
    assert.equal(searchKnowledge('zebra').length, 0);
  });
});
