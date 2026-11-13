import { createHmac } from 'node:crypto';
import { all, parse, run } from './db.ts';
import { postGuarded } from './netguard.ts';
import { openSecret } from './secrets.ts';

/**
 * Live events carry ids only. Clients refetch through the authorised API, so one
 * shared stream can't leak a conversation to an agent who isn't allowed to see it.
 */
export type LiveEvent =
  | { type: 'conversation'; id: number }
  | { type: 'message'; conversationId: number; id: number }
  | { type: 'broadcast'; id: number }
  | { type: 'call'; id: number }
  | { type: 'reminder'; userId: number; conversationId: number; text: string }
  | { type: 'celebrate'; userId: number; xp: number; achievement?: string };

type Listener = (e: LiveEvent) => void;
const listeners = new Set<Listener>();

export function subscribe(fn: Listener) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function publish(e: LiveEvent) {
  for (const fn of listeners) fn(e);
}

export function signPayload(secret: string, body: string) {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/** Fire-and-forget delivery to user-configured webhooks, signed so receivers can verify the sender. */
export function emitWebhook(event: string, data: unknown) {
  for (const h of all<{ id: number; url: string; secret: string; events: string }>('SELECT * FROM webhooks WHERE enabled = 1')) {
    const wanted = parse<string[]>(h.events, ['*']);
    if (!wanted.includes('*') && !wanted.includes(event)) continue;
    const body = JSON.stringify({ event, data, at: Date.now() });
    postGuarded(h.url, body, { 'content-type': 'application/json', 'x-tripletick-signature': signPayload(openSecret(h.secret), body) })
      .then((status) => run('UPDATE webhooks SET last_status = ? WHERE id = ?', status, h.id))
      .catch(() => run('UPDATE webhooks SET last_status = 0 WHERE id = ?', h.id));
  }
}
