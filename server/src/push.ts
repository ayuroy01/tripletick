import type { FastifyInstance } from 'fastify';
import webpush from 'web-push';
import { config } from './config.ts';
import { all, get, run } from './db.ts';
import { subscribe } from './events.ts';
import { anyone, fail } from './http.ts';
import { vaultGet, vaultSet } from './secrets.ts';

interface Sub { id: number; user_id: number; endpoint: string; keys: string }
export interface Notice { title: string; url: string }

type Sender = (sub: { endpoint: string; keys: any }, payload: string) => Promise<unknown>;
let sender: Sender | undefined;
export const setPushSender = (fn: Sender) => { sender = fn; };

function vapid() {
  let keys = vaultGet('vapid');
  if (!keys) {
    keys = JSON.stringify(webpush.generateVAPIDKeys());
    vaultSet('vapid', keys);
  }
  return JSON.parse(keys) as { publicKey: string; privateKey: string };
}

function defaultSender(): Sender {
  const v = vapid();
  webpush.setVapidDetails(config.publicUrl.startsWith('https') ? config.publicUrl : 'https://tripletick.invalid', v.publicKey, v.privateKey);
  return (sub, payload) => webpush.sendNotification(sub, payload);
}

/** Notices carry a name at most, never message text, so content stays off third-party push services. */
export async function notify(userIds: number[] | 'all', notice: Notice) {
  const subs = userIds === 'all'
    ? all<Sub>('SELECT s.* FROM push_subscriptions s JOIN users u ON u.id = s.user_id WHERE u.active = 1')
    : all<Sub>(`SELECT * FROM push_subscriptions WHERE user_id IN (${userIds.map(() => '?').join(',') || 'NULL'})`, ...userIds);
  if (!subs.length) return;
  sender ??= defaultSender();
  for (const s of subs) {
    await sender({ endpoint: s.endpoint, keys: JSON.parse(s.keys) }, JSON.stringify(notice)).catch((e: any) => {
      if (e.statusCode === 404 || e.statusCode === 410) run('DELETE FROM push_subscriptions WHERE id = ?', s.id); // the device unsubscribed
    });
  }
}

const who = (conversationId: number) =>
  get<{ name: string; assignee_id: number | null }>('SELECT k.name, c.assignee_id FROM conversations c JOIN contacts k ON k.id = c.contact_id WHERE c.id = ?', conversationId);

let started = false;

export function startPush() {
  if (started) return;
  started = true;
  subscribe((e) => {
    if (!get('SELECT 1 FROM push_subscriptions LIMIT 1')) return;
    if (e.type === 'reminder') void notify([e.userId], { title: `Reminder: ${e.text}`.slice(0, 80), url: `/#/inbox/${e.conversationId}` });
    if (e.type === 'message') {
      if (get<{ d: string }>('SELECT direction d FROM messages WHERE id = ?', e.id)?.d !== 'in') return;
      const c = who(e.conversationId);
      if (c) void notify(c.assignee_id ? [c.assignee_id] : 'all', { title: `New message from ${c.name || 'a customer'}`, url: `/#/inbox/${e.conversationId}` });
    }
    if (e.type === 'call') {
      const call = get<{ conversation_id: number; status: string; direction: string }>('SELECT conversation_id, status, direction FROM calls WHERE id = ?', e.id);
      if (call?.status !== 'ringing' || call.direction !== 'in') return;
      const c = who(call.conversation_id);
      if (c) void notify(c.assignee_id ? [c.assignee_id] : 'all', { title: `📞 ${c.name || 'A customer'} is calling`, url: `/#/inbox/${call.conversation_id}` });
    }
  });
}

export function registerPushRoutes(app: FastifyInstance) {
  app.get('/api/push/key', { preHandler: anyone }, () => ({ publicKey: vapid().publicKey }));

  app.post('/api/push/subscribe', { preHandler: anyone }, (req) => {
    const { endpoint, keys } = req.body as any;
    if (!endpoint || !keys?.p256dh || !keys?.auth) fail(400, 'That is not a valid subscription');
    if (new URL(String(endpoint)).protocol !== 'https:') fail(400, 'Push endpoints must use https');
    run(
      'INSERT INTO push_subscriptions(user_id, endpoint, keys) VALUES(?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, keys = excluded.keys',
      req.user.id, String(endpoint), JSON.stringify(keys),
    );
    return { ok: true };
  });

  app.post('/api/push/unsubscribe', { preHandler: anyone }, (req) => {
    run('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?', String((req.body as any).endpoint), req.user.id);
    return { ok: true };
  });
}
