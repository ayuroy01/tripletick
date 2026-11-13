// Regression tests for the Phase 1 audit (docs/AUDIT.md). Each one failed before its fix.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, it, mock } from 'node:test';

process.env.TT_SECRET_KEY = 'test-key';
const { createApp } = await import('../src/app.ts');
const { setSimulatorDelays } = await import('../src/channels/simulator.ts');
const { get, insert, MIGRATIONS, openDb, run, schemaVersion, setSetting } = await import('../src/db.ts');
const { sealSecret } = await import('../src/secrets.ts');
const { receiveInbound } = await import('../src/messaging.ts');
const { emitWebhook } = await import('../src/events.ts');
const { checkOutboundUrl, isPrivateAddress, postGuarded } = await import('../src/netguard.ts');
const { seedDemo } = await import('../src/seed.ts');

setSimulatorDelays({ delivered: 3_600_000, read: 3_600_000 });

let app: Awaited<ReturnType<typeof createApp>>;
async function login(email: string) {
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'tripletick' } });
  return r.headers['set-cookie'] as string;
}
const api = (cookie: string, method: any, url: string, payload?: object) => app.inject({ method, url, payload, headers: { cookie } });
const sim = () => get<any>("SELECT id FROM channels WHERE type = 'simulator' LIMIT 1").id;
const userId = (email: string) => get<any>('SELECT id FROM users WHERE email = ?', email).id;
const marketing = () => get<any>("SELECT id FROM templates WHERE status = 'APPROVED' AND category = 'MARKETING' LIMIT 1").id;

beforeEach(async () => {
  openDb(':memory:');
  seedDemo();
  app = await createApp();
});

describe('consent', () => {
  it('blocks an agent from sending a marketing template after STOP', async () => {
    const r = await receiveInbound({ channelId: sim(), from: '+15559990001', body: 'STOP' });
    const sky = await login('sky@tripletick.local');
    const res = await api(sky, 'POST', `/api/conversations/${r!.conversationId}/messages`, { templateId: marketing() });
    assert.equal(res.statusCode, 422);
    assert.equal(res.json().code, 'consent_required');
  });

  it('blocks an outbound call after STOP', async () => {
    const r = await receiveInbound({ channelId: sim(), from: '+15559990001', body: 'STOP' });
    const sky = await login('sky@tripletick.local');
    const res = await api(sky, 'POST', `/api/conversations/${r!.conversationId}/calls`, { sdp: 'v=0' });
    assert.equal(res.statusCode, 422);
    assert.equal(res.json().code, 'consent_required');
  });
});

describe('contact privacy', () => {
  const noorContact = () => get<any>('SELECT contact_id FROM conversations WHERE assignee_id = ? LIMIT 1', userId('noor@tripletick.local')).contact_id;

  it("hides another agent's customer from the contact list, edits and new chats", async () => {
    const id = noorContact();
    const sky = await login('sky@tripletick.local');
    assert.ok(!(await api(sky, 'GET', '/api/contacts')).json().some((c: any) => c.id === id));
    assert.equal((await api(sky, 'PATCH', `/api/contacts/${id}`, { name: 'Renamed' })).statusCode, 404);
    assert.notEqual(get<any>('SELECT name FROM contacts WHERE id = ?', id).name, 'Renamed');
    assert.equal((await api(sky, 'POST', `/api/contacts/${id}/conversation`, { channelId: sim() })).statusCode, 404);
  });

  it("doesn't reveal or change a hidden contact when an agent adds the same number", async () => {
    const id = noorContact();
    const before = get<any>('SELECT * FROM contacts WHERE id = ?', id);
    const sky = await login('sky@tripletick.local');
    const res = (await api(sky, 'POST', '/api/contacts', { phone: before.phone, name: 'X', email: 'x@x.x', optedIn: true })).json();
    assert.deepEqual(res, { id, existing: true });
    assert.deepEqual(get<any>('SELECT * FROM contacts WHERE id = ?', id), before);
  });

  it('still lets the manager and admin see the contact', async () => {
    const id = noorContact();
    for (const email of ['robin@tripletick.local', 'demo@tripletick.local']) {
      assert.ok((await api(await login(email), 'GET', '/api/contacts')).json().some((c: any) => c.id === id), email);
    }
  });

  it('hides sensitive fields and form answers from agents, and keeps them safe from agent edits', async () => {
    setSetting('sensitive_fields', ['home_address']);
    const r = await receiveInbound({ channelId: sim(), from: '+15559990002', body: '', form: { home_address: '1 Secret Lane', size: '9' } });
    const contactId = get<any>('SELECT contact_id FROM conversations WHERE id = ?', r!.conversationId).contact_id;
    run('UPDATE conversations SET assignee_id = ? WHERE id = ?', userId('sky@tripletick.local'), r!.conversationId);
    const sky = await login('sky@tripletick.local');
    const chat = (await api(sky, 'GET', `/api/conversations/${r!.conversationId}`)).json();
    assert.equal(chat.contact.fields.home_address, '•••');
    assert.equal(chat.contact.fields.size, '9');
    const form = chat.messages.find((m: any) => m.payload.answers);
    assert.equal(form.payload.answers.home_address, '•••');
    assert.ok(!form.body.includes('Secret'));
    await api(sky, 'PATCH', `/api/contacts/${contactId}`, { fields: { size: '10' } });
    assert.deepEqual(JSON.parse(get<any>('SELECT fields FROM contacts WHERE id = ?', contactId).fields), { home_address: '1 Secret Lane', size: '10' });
    const admin = await login('demo@tripletick.local');
    assert.equal((await api(admin, 'GET', `/api/conversations/${r!.conversationId}`)).json().contact.fields.home_address, '1 Secret Lane');
  });

  it('rejects settings of the wrong type', async () => {
    const admin = await login('demo@tripletick.local');
    assert.equal((await api(admin, 'PATCH', '/api/settings', { sensitive_fields: 'address' })).statusCode, 400);
    assert.equal((await api(admin, 'PATCH', '/api/settings', { sla_minutes: '15' })).statusCode, 400);
  });
});

async function listen(handler: (url: string) => [number, Record<string, string>?]) {
  const hits: string[] = [];
  const srv = createServer((q, s) => { hits.push(q.url!); const [code, headers] = handler(q.url!); s.writeHead(code, headers).end(); }).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  return { hits, url: `http://127.0.0.1:${(srv.address() as any).port}`, close: () => srv.close() };
}

describe('outbound webhooks (SSRF)', () => {
  it('classifies internal addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.31.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::10.0.0.1']) {
      assert.ok(isPrivateAddress(ip), ip);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700::1111', '::ffff:8.8.8.8']) assert.ok(!isPrivateAddress(ip), ip);
  });

  it('refuses to save webhooks aimed at internal addresses or with credentials', async () => {
    const admin = await login('demo@tripletick.local');
    for (const url of ['http://127.0.0.1:8080/x', 'http://localhost/x', 'http://[::1]/x', 'http://169.254.169.254/latest/meta-data', 'ftp://example.com', 'https://user:pw@example.com']) {
      assert.equal((await api(admin, 'POST', '/api/webhooks', { url })).statusCode, 400, url);
    }
    assert.equal(get<any>('SELECT COUNT(*) n FROM webhooks').n, 0);
  });

  it('refuses at send time too, even for a webhook stored before the check existed', async () => {
    const srv = await listen(() => [200]);
    insert("INSERT INTO webhooks(url, secret, events) VALUES(?, 'plain', '[\"*\"]')", `${srv.url}/hook`);
    emitWebhook('message.received', {});
    await new Promise((r) => setTimeout(r, 200));
    srv.close();
    assert.equal(srv.hits.length, 0);
    assert.equal(get<any>('SELECT last_status FROM webhooks').last_status, 0);
    await assert.rejects(postGuarded(srv.url.replace('127.0.0.1', 'localhost'), '{}', {}));
  });

  it('never follows a redirect', async () => {
    process.env.TT_ALLOW_PRIVATE_WEBHOOKS = '1'; // lets the test use a local receiver
    try {
      const target = await listen(() => [200]);
      const hop = await listen(() => [302, { location: `${target.url}/stolen` }]);
      assert.equal(await postGuarded(`${hop.url}/hook`, '{}', {}), 302);
      assert.equal(target.hits.length, 0);
      await checkOutboundUrl(`${hop.url}/hook`);
      hop.close(); target.close();
    } finally {
      delete process.env.TT_ALLOW_PRIVATE_WEBHOOKS;
    }
  });
});

describe('migrations and inbound idempotency', () => {
  it('upgrades a database from before migrations, removing duplicate message ids', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'tt-')), 'old.db');
    const old = new DatabaseSync(path);
    old.exec(MIGRATIONS[0]);
    old.exec("INSERT INTO channels(type, name, created_at) VALUES('simulator', 'S', 0); INSERT INTO contacts(phone, created_at) VALUES('+1', 0); INSERT INTO conversations(contact_id, channel_id, created_at) VALUES(1, 1, 0)");
    old.exec("INSERT INTO messages(conversation_id, direction, external_id, created_at) VALUES(1, 'in', 'wamid.dup', 0), (1, 'in', 'wamid.dup', 0)");
    old.exec("INSERT INTO api_keys(name, key_hash, prefix, created_at) VALUES('old', 'h', 'tt_', 0)");
    old.close();
    openDb(path);
    assert.equal(schemaVersion(), MIGRATIONS.length);
    assert.equal(get<any>("SELECT COUNT(*) n FROM messages WHERE external_id = 'wamid.dup'").n, 1);
    assert.equal(get<any>('SELECT COUNT(*) n FROM messages').n, 2); // nothing is deleted
    assert.deepEqual(JSON.parse(get<any>('SELECT scopes FROM api_keys').scopes), ['admin']); // old keys keep working
    assert.throws(() => run("INSERT INTO messages(conversation_id, direction, external_id, created_at) VALUES(1, 'in', 'wamid.dup', 0)"), /UNIQUE/);
    openDb(path); // a second start changes nothing
    assert.equal(schemaVersion(), MIGRATIONS.length);
  });

  it('refuses to open a database from a newer version', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'tt-')), 'new.db');
    const db = new DatabaseSync(path);
    db.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);
    db.close();
    assert.throws(() => openDb(path), /newer Triple Tick/);
    openDb(':memory:');
  });

  it('downloads media once when Meta retries the same webhook', async () => {
    insert("INSERT INTO channels(type, name, config, created_at) VALUES('whatsapp_cloud', 'WA', ?, 0)",
      sealSecret(JSON.stringify({ phoneNumberId: '123', appSecret: 'app-secret', accessToken: 'tok' })));
    const fetches: string[] = [];
    const m = mock.method(globalThis, 'fetch', async (url: any) => {
      fetches.push(String(url));
      return String(url).includes('/m1') ? new Response(JSON.stringify({ url: 'https://cdn.example/m1.png' })) : new Response(Buffer.from('png'));
    });
    const body = JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: '123' }, messages: [{ from: '15550001', id: 'wamid.media', type: 'image', image: { id: 'm1', mime_type: 'image/png' } }] } }] }] });
    const sig = `sha256=${createHmac('sha256', 'app-secret').update(body).digest('hex')}`;
    try {
      for (let i = 0; i < 2; i++) {
        const r = await app.inject({ method: 'POST', url: '/webhooks/whatsapp', payload: body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig } });
        assert.equal(r.statusCode, 200);
      }
    } finally { m.mock.restore(); }
    assert.equal(get<any>("SELECT COUNT(*) n FROM messages WHERE external_id = 'wamid.media'").n, 1);
    assert.equal(fetches.filter((u) => u.includes('cdn.example')).length, 1);
  });
});

describe('API key scopes', () => {
  const bearer = (key: string, method: any, url: string, payload?: object) =>
    app.inject({ method, url, payload, headers: { authorization: `Bearer ${key}` } });
  async function newKey(scopes: string[], extra: object = {}) {
    const admin = await login('demo@tripletick.local');
    const r = await api(admin, 'POST', '/api/api-keys', { name: 'zapier', scopes, ...extra });
    assert.equal(r.statusCode, 200, r.body);
    return r.json().key as string;
  }

  it('limits a key to its scopes', async () => {
    const key = await newKey(['conversations:read', 'messages:send']);
    assert.equal((await bearer(key, 'GET', '/api/conversations')).statusCode, 200);
    const conv = get<any>('SELECT id FROM conversations WHERE last_inbound_at IS NOT NULL ORDER BY last_inbound_at DESC LIMIT 1').id;
    run('UPDATE conversations SET last_inbound_at = ? WHERE id = ?', Date.now(), conv);
    assert.equal((await bearer(key, 'POST', `/api/conversations/${conv}/messages`, { body: 'hi from zapier' })).statusCode, 200);
    for (const [method, url, payload] of [
      ['POST', '/api/users', { name: 'Backdoor', email: 'x@y.z', password: 'password123', role: 'admin' }],
      ['GET', '/api/contacts'], ['GET', '/api/audit'], ['PATCH', '/api/settings', { fun_mode: false }],
      ['POST', '/api/webhooks', { url: 'https://example.com' }], ['GET', '/api/contacts/export'],
    ] as const) {
      assert.equal((await bearer(key, method, url, payload as any)).statusCode, 403, `${method} ${url}`);
    }
    assert.equal(get<any>("SELECT COUNT(*) n FROM users WHERE email = 'x@y.z'").n, 0);
  });

  it('requires at least one known scope', async () => {
    const admin = await login('demo@tripletick.local');
    assert.equal((await api(admin, 'POST', '/api/api-keys', { name: 'x' })).statusCode, 400);
    assert.equal((await api(admin, 'POST', '/api/api-keys', { name: 'x', scopes: ['root'] })).statusCode, 400);
  });

  it("can't mint new keys, even with admin scope", async () => {
    const key = await newKey(['admin']);
    assert.equal((await bearer(key, 'POST', '/api/api-keys', { name: 'x', scopes: ['admin'] })).statusCode, 403);
    assert.equal((await bearer(key, 'GET', '/api/audit')).statusCode, 200);
  });

  it('stops working when it expires, or when its creator loses admin', async () => {
    const key = await newKey(['conversations:read'], { expiresInDays: 1 });
    run('UPDATE api_keys SET expires_at = ?', Date.now() - 1);
    assert.equal((await bearer(key, 'GET', '/api/conversations')).statusCode, 401);
    const key2 = await newKey(['conversations:read']);
    run("UPDATE users SET role = 'agent' WHERE email = 'demo@tripletick.local'");
    assert.equal((await bearer(key2, 'GET', '/api/conversations')).statusCode, 401);
  });

  it('names the key in the audit log', async () => {
    const key = await newKey(['contacts:write']);
    await bearer(key, 'POST', '/api/contacts', { phone: '+15550123', name: 'Via API' });
    const row = get<any>("SELECT a.user_id, k.name FROM audit_log a JOIN api_keys k ON k.id = a.api_key_id WHERE a.action = 'contacts.create'");
    assert.equal(row.name, 'zapier');
    assert.equal(row.user_id, userId('demo@tripletick.local'));
  });
});
