import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone TEXT, pass_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'agent',
  manager_id INTEGER REFERENCES users(id), prefs TEXT NOT NULL DEFAULT '{}',
  xp INTEGER NOT NULL DEFAULT 0, streak INTEGER NOT NULL DEFAULT 0, last_active_day TEXT,
  active INTEGER NOT NULL DEFAULT 1, last_assigned_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS api_keys (id INTEGER PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER);
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '',
  config TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL UNIQUE, email TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]', fields TEXT NOT NULL DEFAULT '{}',
  opted_in INTEGER NOT NULL DEFAULT 0, opted_out_at INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY, contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  channel_id INTEGER NOT NULL REFERENCES channels(id), status TEXT NOT NULL DEFAULT 'open',
  assignee_id INTEGER REFERENCES users(id), snooze_until INTEGER, unread INTEGER NOT NULL DEFAULT 0,
  last_inbound_at INTEGER, last_outbound_at INTEGER, last_message_at INTEGER NOT NULL DEFAULT 0, last_preview TEXT NOT NULL DEFAULT '',
  first_inbound_at INTEGER, first_response_at INTEGER, sla_due_at INTEGER, sla_breached INTEGER NOT NULL DEFAULT 0,
  mood TEXT NOT NULL DEFAULT 'neutral', summary TEXT, resolved_at INTEGER, created_at INTEGER NOT NULL,
  UNIQUE(contact_id, channel_id)
);
CREATE INDEX IF NOT EXISTS idx_conv_list ON conversations(status, last_message_at DESC);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direction TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'text', body TEXT NOT NULL DEFAULT '', payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued', error TEXT, external_id TEXT, user_id INTEGER REFERENCES users(id), via TEXT NOT NULL DEFAULT 'agent', created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, id);
CREATE INDEX IF NOT EXISTS idx_msg_ext ON messages(external_id);
CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id), text TEXT NOT NULL, due_at INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, language TEXT NOT NULL DEFAULT 'en', category TEXT NOT NULL DEFAULT 'MARKETING',
  header TEXT NOT NULL DEFAULT '', body TEXT NOT NULL, footer TEXT NOT NULL DEFAULT '', buttons TEXT NOT NULL DEFAULT '[]',
  variables TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'DRAFT', channel_id INTEGER REFERENCES channels(id), external_id TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS quick_replies (id INTEGER PRIMARY KEY, shortcut TEXT NOT NULL UNIQUE, body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS segments (id INTEGER PRIMARY KEY, name TEXT NOT NULL, match TEXT NOT NULL DEFAULT 'all', rules TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS views (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, filters TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS broadcasts (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, template_id INTEGER NOT NULL REFERENCES templates(id), channel_id INTEGER NOT NULL REFERENCES channels(id),
  segment_id INTEGER REFERENCES segments(id), status TEXT NOT NULL DEFAULT 'draft', scheduled_at INTEGER, started_at INTEGER, finished_at INTEGER,
  parent_id INTEGER REFERENCES broadcasts(id), created_by INTEGER REFERENCES users(id), created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS broadcast_recipients (
  id INTEGER PRIMARY KEY, broadcast_id INTEGER NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE, contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  message_id INTEGER REFERENCES messages(id), state TEXT NOT NULL DEFAULT 'pending', reason TEXT, UNIQUE(broadcast_id, contact_id)
);
CREATE TABLE IF NOT EXISTS bots (id INTEGER PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, trigger TEXT NOT NULL DEFAULT '{}', graph TEXT NOT NULL DEFAULT '{"nodes":[],"edges":[]}', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS bot_runs (
  id INTEGER PRIMARY KEY, bot_id INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE, conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  node_id TEXT, status TEXT NOT NULL DEFAULT 'running', wake_at INTEGER, started_at INTEGER NOT NULL, ended_at INTEGER
);
CREATE TABLE IF NOT EXISTS bot_log (id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES bot_runs(id) ON DELETE CASCADE, node_id TEXT NOT NULL, event TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS knowledge (id INTEGER PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY, user_id INTEGER, action TEXT NOT NULL, target TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS webhooks (id INTEGER PRIMARY KEY, url TEXT NOT NULL, secret TEXT NOT NULL, events TEXT NOT NULL DEFAULT '["*"]', enabled INTEGER NOT NULL DEFAULT 1, last_status INTEGER);
CREATE TABLE IF NOT EXISTS forms (id INTEGER PRIMARY KEY, name TEXT NOT NULL, body TEXT NOT NULL, cta TEXT NOT NULL DEFAULT 'Open form', fields TEXT NOT NULL DEFAULT '[]', meta_flow_id TEXT NOT NULL DEFAULT '', screen TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, external_id TEXT UNIQUE, direction TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ringing', outcome TEXT, user_id INTEGER REFERENCES users(id), sdp_offer TEXT, sdp_answer TEXT,
  created_at INTEGER NOT NULL, answered_at INTEGER, ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_calls_status ON calls(status);
CREATE TABLE IF NOT EXISTS call_lists (id INTEGER PRIMARY KEY, name TEXT NOT NULL, channel_id INTEGER NOT NULL REFERENCES channels(id), script TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS call_list_items (
  id INTEGER PRIMARY KEY, list_id INTEGER NOT NULL REFERENCES call_lists(id) ON DELETE CASCADE, contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'pending', outcome TEXT, user_id INTEGER REFERENCES users(id), UNIQUE(list_id, contact_id)
);
CREATE TABLE IF NOT EXISTS connectors (id INTEGER PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL, config TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1, last_status TEXT, last_synced_at INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS carts (id INTEGER PRIMARY KEY, connector_id INTEGER NOT NULL REFERENCES connectors(id) ON DELETE CASCADE, token TEXT NOT NULL, contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE, due_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending', UNIQUE(connector_id, token));
CREATE TABLE IF NOT EXISTS conversions (id INTEGER PRIMARY KEY, conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL, contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE, event_name TEXT NOT NULL, value REAL NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'USD', meta_status TEXT NOT NULL DEFAULT 'not_sent', source TEXT NOT NULL DEFAULT 'agent', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS push_subscriptions (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, endpoint TEXT NOT NULL UNIQUE, keys TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS vault (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS achievements (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, key TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(user_id, key));
`;

/**
 * Ordered schema changes. Each runs once, in a transaction, and PRAGMA user_version
 * records how many have run. Never edit or reorder a shipped entry: append a new one.
 * The first entry is the original schema. It only creates what's missing, so
 * databases from before migrations existed (user_version 0) upgrade cleanly.
 */
export const MIGRATIONS: string[] = [
  SCHEMA,
  // Meta retries webhooks, so an inbound message id must be stored at most once.
  `UPDATE messages SET external_id = NULL WHERE external_id IS NOT NULL
     AND id NOT IN (SELECT MIN(id) FROM messages WHERE external_id IS NOT NULL GROUP BY external_id);
   DROP INDEX IF EXISTS idx_msg_ext;
   CREATE UNIQUE INDEX idx_msg_ext ON messages(external_id) WHERE external_id IS NOT NULL;`,
  // Scoped API keys. Existing keys keep full access until an admin narrows them.
  `ALTER TABLE api_keys ADD COLUMN scopes TEXT NOT NULL DEFAULT '["admin"]';
   ALTER TABLE api_keys ADD COLUMN expires_at INTEGER;
   ALTER TABLE api_keys ADD COLUMN created_by INTEGER REFERENCES users(id);
   ALTER TABLE audit_log ADD COLUMN api_key_id INTEGER;`,
];

let db: DatabaseSync | undefined;

export function openDb(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  db?.close();
  db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate();
  return db;
}

export const schemaVersion = () => Number((conn().prepare('PRAGMA user_version').get() as { user_version: number }).user_version);

function migrate() {
  const from = schemaVersion();
  if (from > MIGRATIONS.length) throw new Error(`This database is from a newer Triple Tick (schema ${from}). Upgrade the app instead of downgrading.`);
  for (let v = from; v < MIGRATIONS.length; v++) {
    tx(() => {
      conn().exec(MIGRATIONS[v]);
      conn().exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

function conn(): DatabaseSync {
  if (!db) throw new Error('Database is not open');
  return db;
}

export type Param = SQLInputValue;
export const get = <T = any>(sql: string, ...p: Param[]) => conn().prepare(sql).get(...p) as T | undefined;
export const all = <T = any>(sql: string, ...p: Param[]) => conn().prepare(sql).all(...p) as T[];
export const run = (sql: string, ...p: Param[]) => conn().prepare(sql).run(...p);
export const insert = (sql: string, ...p: Param[]) => Number(run(sql, ...p).lastInsertRowid);

export function tx<T>(fn: () => T): T {
  conn().exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    conn().exec('COMMIT');
    return out;
  } catch (e) {
    conn().exec('ROLLBACK');
    throw e;
  }
}

export function parse<T>(json: unknown, fallback: T): T {
  try {
    return typeof json === 'string' ? (JSON.parse(json) as T) : fallback;
  } catch {
    return fallback;
  }
}

export const DEFAULT_SETTINGS = {
  workspace_name: 'Triple Tick',
  working_hours: { enabled: false, timezone: 'UTC', start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5], away_message: "Thanks for reaching out! We're away right now and will reply when we're back." },
  sla_minutes: 15,
  auto_assign: true,
  mask_for_agents: true,
  // Custom field keys that agents never see or change, such as an address or a date of birth.
  sensitive_fields: [] as string[],
  block_agent_contact_sharing: true,
  ai_agent_enabled: false,
  ai_persona: 'Friendly, concise and helpful.',
  broadcast_rate_per_tick: 20,
  broadcast_cap_hours: 24,
  fun_mode: true,
};
export type Settings = typeof DEFAULT_SETTINGS;

export function getSettings(): Settings {
  const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const r of all<{ key: string; value: string }>('SELECT key, value FROM settings')) {
    if (r.key in DEFAULT_SETTINGS) out[r.key] = parse(r.value, out[r.key]);
  }
  return out as Settings;
}

export function setSetting(key: string, value: unknown) {
  if (!(key in DEFAULT_SETTINGS)) throw new Error(`Unknown setting: ${key}`);
  run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
}

/** Records who did what. Pass the request's user so actions taken with an API key name the key. */
export function audit(actor: number | null | { id: number; apiKey?: { id: number } }, action: string, target = '') {
  const userId = typeof actor === 'object' && actor ? actor.id : actor;
  const keyId = typeof actor === 'object' && actor ? actor.apiKey?.id ?? null : null;
  run('INSERT INTO audit_log(user_id, api_key_id, action, target, at) VALUES(?, ?, ?, ?, ?)', userId, keyId, action, target, Date.now());
}
