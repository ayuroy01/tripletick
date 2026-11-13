import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { all, get, insert, run } from './db.ts';

export type Role = 'admin' | 'manager' | 'agent';
export const API_SCOPES = ['conversations:read', 'messages:send', 'contacts:read', 'contacts:write', 'broadcasts:write', 'admin'] as const;
export type Scope = (typeof API_SCOPES)[number];
export interface ApiKeyIdentity { id: number; name: string; scopes: Scope[] }
export interface User {
  id: number; name: string; email: string; phone: string | null; role: Role; manager_id: number | null; prefs: string; xp: number; streak: number; active: number;
  /** Set when the request came in with an API key rather than a session. */
  apiKey?: ApiKeyIdentity;
}

const SESSION_MS = 14 * 864e5;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${scryptSync(password, salt, 64).toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  return timingSafeEqual(scryptSync(password, Buffer.from(salt, 'hex'), 64), Buffer.from(hash, 'hex'));
}

export function createSession(userId: number): string {
  const token = randomBytes(32).toString('base64url');
  run('DELETE FROM sessions WHERE expires_at < ?', Date.now());
  run('INSERT INTO sessions(token_hash, user_id, expires_at) VALUES(?, ?, ?)', sha(token), userId, Date.now() + SESSION_MS);
  return token;
}

export const destroySession = (token: string) => run('DELETE FROM sessions WHERE token_hash = ?', sha(token));

export function userFromSession(token: string): User | undefined {
  return get<User>(
    'SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1',
    sha(token), Date.now(),
  );
}

export function createApiKey(name: string, scopes: Scope[], createdBy: number, expiresAt: number | null = null): { id: number; key: string } {
  const key = `tt_${randomBytes(24).toString('base64url')}`;
  const id = insert(
    'INSERT INTO api_keys(name, key_hash, prefix, scopes, expires_at, created_by, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)',
    name, sha(key), key.slice(0, 7), JSON.stringify(scopes), expiresAt, createdBy, Date.now(),
  );
  return { id, key };
}

/**
 * A key acts as the admin who created it, limited to its scopes. It stops working when it
 * expires or that person stops being an active admin. Keys from before scopes existed
 * have no creator and act as the first admin, as they always did.
 */
export function userFromApiKey(key: string): User | undefined {
  const row = get<{ id: number; name: string; scopes: string; expires_at: number | null; created_by: number | null }>('SELECT * FROM api_keys WHERE key_hash = ?', sha(key));
  if (!row || (row.expires_at && row.expires_at <= Date.now())) return undefined;
  const user = row.created_by
    ? get<User>("SELECT * FROM users WHERE id = ? AND role = 'admin' AND active = 1", row.created_by)
    : get<User>("SELECT * FROM users WHERE role = 'admin' AND active = 1 ORDER BY id LIMIT 1");
  if (!user) return undefined;
  run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', Date.now(), row.id);
  const scopes = (JSON.parse(row.scopes || '[]') as string[]).filter((x): x is Scope => (API_SCOPES as readonly string[]).includes(x));
  return { ...user, apiKey: { id: row.id, name: row.name, scopes } };
}

/** Which scope an API key needs for a route. Anything not listed needs admin. */
const SCOPE_RULES: [string, RegExp, Scope][] = [
  ['GET', /^\/api\/(conversations|channels|templates|quick-replies|events)(\/|$)/, 'conversations:read'],
  ['POST', /^\/api\/conversations\/:id\/(messages|notes|form|read)$/, 'messages:send'],
  ['PATCH', /^\/api\/conversations\/:id$/, 'messages:send'],
  ['GET', /^\/api\/contacts$/, 'contacts:read'],
  ['POST', /^\/api\/contacts(\/:id\/conversation)?$/, 'contacts:write'],
  ['PATCH', /^\/api\/contacts\/:id$/, 'contacts:write'],
  ['*', /^\/api\/(broadcasts|segments)(\/|$)/, 'broadcasts:write'],
];

export function scopeAllows(scopes: Scope[], method: string, route: string): boolean {
  if (scopes.includes('admin')) return true;
  const rule = SCOPE_RULES.find(([m, re]) => (m === '*' || m === method) && re.test(route));
  return !!rule && scopes.includes(rule[2]);
}

/** Everyone in this user's reporting tree, including themselves. */
export function teamIds(userId: number): number[] {
  const rows = all<{ id: number; manager_id: number | null }>('SELECT id, manager_id FROM users');
  const seen = new Set([userId]);
  for (let grew = true; grew;) {
    grew = false;
    for (const r of rows) {
      if (r.manager_id !== null && seen.has(r.manager_id) && !seen.has(r.id)) {
        seen.add(r.id);
        grew = true;
      }
    }
  }
  return [...seen];
}

/** SQL filter limiting conversations to the ones this user may see. Unassigned chats are visible to all. */
export function visibilityClause(user: User): { sql: string; params: number[] } {
  if (user.role === 'admin') return { sql: '1 = 1', params: [] };
  const ids = user.role === 'manager' ? teamIds(user.id) : [user.id];
  return { sql: `(c.assignee_id IS NULL OR c.assignee_id IN (${ids.map(() => '?').join(',')}))`, params: ids };
}

export function canSeeConversation(user: User, conversationId: number): boolean {
  const v = visibilityClause(user);
  return !!get(`SELECT 1 FROM conversations c WHERE c.id = ? AND ${v.sql}`, conversationId, ...v.params);
}

export function publicUser(u: User) {
  const { id, name, email, phone, role, manager_id, xp, streak, active } = u;
  return { id, name, email, phone, role, manager_id, xp, streak, active, prefs: JSON.parse(u.prefs || '{}') };
}
