import { all, get, getSettings, insert, parse, run, tx } from './db.ts';
import { publish } from './events.ts';
import { ensureConversation, send } from './messaging.ts';

export interface Rule { field: string; op: string; value?: string }
export interface Contact { id: number; name: string; phone: string; email: string; tags: string; fields: string; opted_in: number; opted_out_at: number | null; created_at: number }

export function ruleMatches(c: Contact, r: Rule, now = Date.now()): boolean {
  const want = String(r.value ?? '').toLowerCase();
  if (r.field === 'tag') {
    const has = parse<string[]>(c.tags, []).some((t) => t.toLowerCase() === want);
    return r.op === 'not_equals' ? !has : has;
  }
  if (r.field === 'created_days') return (now - c.created_at) / 864e5 <= Number(r.value);
  const fields = parse<Record<string, string>>(c.fields, {});
  const raw = r.field in c && ['name', 'phone', 'email'].includes(r.field) ? (c as any)[r.field] : fields[r.field];
  const actual = String(raw ?? '').toLowerCase();
  switch (r.op) {
    case 'equals': return actual === want;
    case 'not_equals': return actual !== want;
    case 'exists': return actual !== '';
    default: return actual.includes(want);
  }
}

export function segmentContacts(segmentId: number | null): Contact[] {
  const contacts = all<Contact>('SELECT * FROM contacts');
  if (!segmentId) return contacts;
  const s = get<{ match: string; rules: string }>('SELECT match, rules FROM segments WHERE id = ?', segmentId);
  if (!s) return [];
  const rules = parse<Rule[]>(s.rules, []);
  if (!rules.length) return contacts;
  return contacts.filter((c) => (s.match === 'any' ? rules.some((r) => ruleMatches(c, r)) : rules.every((r) => ruleMatches(c, r))));
}

/** Why a contact must not get this broadcast. Consent and frequency limits are not optional. */
export function suppressionReason(c: Contact, capHours: number, now = Date.now()): string | null {
  if (c.opted_out_at) return 'opted_out';
  if (!c.opted_in) return 'no_opt_in';
  if (capHours > 0) {
    const recent = get(
      `SELECT 1 FROM broadcast_recipients r JOIN messages m ON m.id = r.message_id JOIN broadcasts b ON b.id = r.broadcast_id
       WHERE r.contact_id = ? AND r.state = 'sent' AND m.created_at > ? LIMIT 1`,
      c.id, now - capHours * 3600e3,
    );
    if (recent) return 'frequency_cap';
  }
  return null;
}

/** Freezes the audience and starts sending on the next scheduler tick. */
export function launch(broadcastId: number, audience?: Contact[]) {
  const b = get<any>('SELECT * FROM broadcasts WHERE id = ?', broadcastId);
  if (!b) throw new Error('Broadcast not found');
  const t = get<{ status: string }>('SELECT status FROM templates WHERE id = ?', b.template_id);
  if (t?.status !== 'APPROVED') throw new Error('Only approved templates can be broadcast');
  const cap = getSettings().broadcast_cap_hours;
  tx(() => {
    for (const c of audience ?? segmentContacts(b.segment_id)) {
      const reason = suppressionReason(c, cap);
      run(
        'INSERT OR IGNORE INTO broadcast_recipients(broadcast_id, contact_id, state, reason) VALUES(?, ?, ?, ?)',
        broadcastId, c.id, reason ? 'skipped' : 'pending', reason,
      );
    }
    run("UPDATE broadcasts SET status = 'sending', started_at = ? WHERE id = ?", Date.now(), broadcastId);
  });
  publish({ type: 'broadcast', id: broadcastId });
}

/** Scheduler entry: starts due broadcasts and sends a rate-limited slice of each active one. */
export async function tickBroadcasts() {
  for (const b of all<{ id: number }>("SELECT id FROM broadcasts WHERE status = 'scheduled' AND scheduled_at <= ?", Date.now())) {
    try {
      launch(b.id);
    } catch (e) {
      run("UPDATE broadcasts SET status = 'failed' WHERE id = ?", b.id);
      console.warn(`Broadcast ${b.id} failed to start: ${(e as Error).message}`);
    }
  }
  let budget = getSettings().broadcast_rate_per_tick;
  for (const b of all<any>("SELECT * FROM broadcasts WHERE status = 'sending' ORDER BY id")) {
    const pending = all<{ id: number; contact_id: number }>("SELECT id, contact_id FROM broadcast_recipients WHERE broadcast_id = ? AND state = 'pending' LIMIT ?", b.id, budget);
    for (const r of pending) {
      budget--;
      // Re-checked at send time: the contact may have opted out since the audience froze.
      if (get<{ o: number | null }>('SELECT opted_out_at o FROM contacts WHERE id = ?', r.contact_id)?.o) {
        run("UPDATE broadcast_recipients SET state = 'skipped', reason = 'opted_out' WHERE id = ?", r.id);
        continue;
      }
      try {
        const conversationId = ensureConversation(r.contact_id, b.channel_id);
        const messageId = await send(conversationId, { kind: 'template', templateId: b.template_id }, { via: 'broadcast' });
        const failed = get<{ error: string }>("SELECT error FROM messages WHERE id = ? AND status = 'failed'", messageId);
        run('UPDATE broadcast_recipients SET message_id = ?, state = ?, reason = ? WHERE id = ?', messageId, failed ? 'failed' : 'sent', failed?.error ?? null, r.id);
      } catch (e) {
        run("UPDATE broadcast_recipients SET state = 'failed', reason = ? WHERE id = ?", (e as Error).message, r.id);
      }
    }
    if (!get("SELECT 1 FROM broadcast_recipients WHERE broadcast_id = ? AND state = 'pending' LIMIT 1", b.id)) {
      run("UPDATE broadcasts SET status = 'done', finished_at = ? WHERE id = ?", Date.now(), b.id);
    }
    publish({ type: 'broadcast', id: b.id });
    if (budget <= 0) break;
  }
}

export function broadcastStats(id: number) {
  const r = get<any>(
    `SELECT COUNT(*) total,
      SUM(r.state = 'skipped') skipped, SUM(r.state = 'pending') pending,
      SUM(r.state = 'failed' OR m.status = 'failed') failed,
      SUM(m.status IN ('sent','delivered','read','acted')) sent,
      SUM(m.status IN ('delivered','read','acted')) delivered,
      SUM(m.status IN ('read','acted')) read,
      SUM(m.status = 'acted') acted
     FROM broadcast_recipients r LEFT JOIN messages m ON m.id = r.message_id WHERE r.broadcast_id = ?`, id,
  );
  const out: Record<string, number> = {};
  for (const k of Object.keys(r)) out[k] = Number(r[k] ?? 0);
  return out;
}

const RETARGET: Record<string, string> = {
  not_read: "m.status IN ('sent','delivered')",
  read_no_action: "m.status = 'read'",
  acted: "m.status = 'acted'",
};

/** Creates a follow-up draft aimed at one slice of the funnel. */
export function retarget(id: number, audience: string, templateId: number, userId: number) {
  const where = RETARGET[audience];
  if (!where) throw new Error('Unknown audience');
  const b = get<any>('SELECT * FROM broadcasts WHERE id = ?', id);
  if (!b) throw new Error('Broadcast not found');
  const contacts = all<Contact>(
    `SELECT k.* FROM broadcast_recipients r JOIN messages m ON m.id = r.message_id JOIN contacts k ON k.id = r.contact_id WHERE r.broadcast_id = ? AND ${where}`, id,
  );
  const newId = insert(
    "INSERT INTO broadcasts(name, template_id, channel_id, status, parent_id, created_by, created_at) VALUES(?, ?, ?, 'draft', ?, ?, ?)",
    `${b.name} (retarget: ${audience.replaceAll('_', ' ')})`, templateId, b.channel_id, id, userId, Date.now(),
  );
  launch(newId, contacts);
  return newId;
}
