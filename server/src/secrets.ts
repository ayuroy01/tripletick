import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.ts';
import { all, get, run } from './db.ts';

const PREFIX = 'enc:v1:';
let key: Buffer | undefined;

/** Uses TT_SECRET_KEY if set, otherwise a key file created beside the database on first use. */
function encryptionKey(): Buffer {
  if (key) return key;
  if (process.env.TT_SECRET_KEY) return (key = createHash('sha256').update(process.env.TT_SECRET_KEY).digest());
  const path = join(config.dataDir, 'secret.key');
  if (!existsSync(path)) {
    mkdirSync(config.dataDir, { recursive: true });
    writeFileSync(path, randomBytes(32).toString('base64'), { mode: 0o600 });
    chmodSync(path, 0o600);
  }
  return (key = Buffer.from(readFileSync(path, 'utf8').trim(), 'base64'));
}

export function sealSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}

/** Plain values pass through, so rows written before encryption still read correctly. */
export function openSecret(value: string): string {
  if (!value.startsWith(PREFIX)) return value;
  const raw = Buffer.from(value.slice(PREFIX.length), 'base64');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}

/** One-time upgrade for databases created before secrets were encrypted. */
export function encryptStoredSecrets() {
  for (const [table, col] of [['channels', 'config'], ['connectors', 'config'], ['webhooks', 'secret']]) {
    for (const row of all<any>(`SELECT id, ${col} v FROM ${table}`)) {
      if (!String(row.v).startsWith(PREFIX)) run(`UPDATE ${table} SET ${col} = ? WHERE id = ?`, sealSecret(row.v), row.id);
    }
  }
}

export function vaultGet(k: string): string | undefined {
  const row = get<{ value: string }>('SELECT value FROM vault WHERE key = ?', k);
  return row ? openSecret(row.value) : undefined;
}

export function vaultSet(k: string, value: string) {
  run('INSERT INTO vault(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, sealSecret(value));
}
