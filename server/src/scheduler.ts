import { tickBroadcasts } from './broadcasts.ts';
import { expireRinging } from './calls.ts';
import { tickConnectors } from './connectors.ts';
import { wakeSleepingBots } from './bots.ts';
import { all, run } from './db.ts';
import { publish, emitWebhook } from './events.ts';
import { addSystemNote } from './messaging.ts';

export async function tick(now = Date.now()) {
  for (const r of all<any>('SELECT * FROM reminders WHERE done = 0 AND due_at <= ?', now)) {
    run('UPDATE reminders SET done = 1 WHERE id = ?', r.id);
    addSystemNote(r.conversation_id, `Reminder: ${r.text}`);
    publish({ type: 'reminder', userId: r.user_id, conversationId: r.conversation_id, text: r.text });
  }
  for (const c of all<{ id: number }>("SELECT id FROM conversations WHERE status = 'snoozed' AND snooze_until <= ?", now)) {
    run("UPDATE conversations SET status = 'open', snooze_until = NULL WHERE id = ?", c.id);
    publish({ type: 'conversation', id: c.id });
  }
  for (const c of all<{ id: number }>(
    "SELECT id FROM conversations WHERE sla_breached = 0 AND status = 'open' AND first_response_at IS NULL AND sla_due_at IS NOT NULL AND sla_due_at <= ?", now,
  )) {
    run('UPDATE conversations SET sla_breached = 1 WHERE id = ?', c.id);
    addSystemNote(c.id, 'SLA breached: nobody replied in time');
    emitWebhook('sla.breached', { conversationId: c.id });
    publish({ type: 'conversation', id: c.id });
  }
  await expireRinging(now);
  await wakeSleepingBots();
  await tickConnectors(now);
  await tickBroadcasts();
}

export function startScheduler(intervalMs = 2000) {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return; // a slow tick must never overlap the next one, or broadcasts could double-send
    busy = true;
    try {
      await tick();
    } catch (e) {
      console.error('Scheduler tick failed:', e);
    } finally {
      busy = false;
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
