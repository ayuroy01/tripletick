import { all, get } from './db.ts';

const num = (v: unknown) => Number(v ?? 0);

export function overview(days: number) {
  const since = Date.now() - days * 864e5;
  const t = get<any>(
    `SELECT COUNT(*) conversations, SUM(status = 'open') open, SUM(status = 'resolved') resolved, SUM(sla_breached) breached,
       AVG(CASE WHEN first_response_at IS NOT NULL THEN first_response_at - first_inbound_at END) avg_first_response
     FROM conversations WHERE last_message_at >= ?`, since,
  );
  const m = get<any>(
    `SELECT SUM(direction = 'in') inbound, SUM(direction = 'out') outbound, SUM(via = 'bot') bot, SUM(via = 'ai') ai,
       SUM(direction = 'out' AND status = 'acted') acted, SUM(direction = 'out' AND status != 'failed') delivered_base
     FROM messages WHERE created_at >= ?`, since,
  );
  const perDay = all<any>(
    `SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') day, SUM(direction = 'in') inbound, SUM(direction = 'out') outbound
     FROM messages WHERE created_at >= ? GROUP BY day ORDER BY day`, since,
  );
  const agents = all<any>(
    `SELECT u.id, u.name, u.xp, u.streak,
       (SELECT COUNT(*) FROM messages x WHERE x.user_id = u.id AND x.direction = 'out' AND x.created_at >= ?) replies,
       (SELECT COUNT(*) FROM conversations c WHERE c.assignee_id = u.id AND c.status = 'resolved' AND c.resolved_at >= ?) resolved,
       (SELECT AVG(c.first_response_at - c.first_inbound_at) FROM conversations c WHERE c.assignee_id = u.id AND c.first_response_at IS NOT NULL AND c.last_message_at >= ?) avg_first_response,
       (SELECT COUNT(*) FROM conversations c WHERE c.assignee_id = u.id AND c.sla_breached = 1 AND c.last_message_at >= ?) breaches
     FROM users u WHERE u.active = 1 ORDER BY resolved DESC, replies DESC`, since, since, since, since,
  );
  const tagCounts = new Map<string, number>();
  for (const r of all<{ tag: string }>(
    `SELECT j.value tag FROM conversations c JOIN contacts k ON k.id = c.contact_id, json_each(k.tags) j WHERE c.last_message_at >= ?`, since,
  )) tagCounts.set(r.tag, (tagCounts.get(r.tag) ?? 0) + 1);
  const moods = all<any>('SELECT mood, COUNT(*) n FROM conversations WHERE last_message_at >= ? GROUP BY mood', since);
  const calls = get<any>("SELECT COUNT(*) total, SUM(outcome = 'completed') completed, SUM(outcome = 'missed') missed FROM calls WHERE created_at >= ?", since);
  const sales = get<any>('SELECT COUNT(*) n, SUM(value) value FROM conversions WHERE created_at >= ?', since);
  const conversations = num(t.conversations);
  const outbound = num(m.delivered_base);
  return {
    totals: {
      conversations, open: num(t.open), resolved: num(t.resolved), breached: num(t.breached),
      slaMet: conversations ? 1 - num(t.breached) / conversations : 1,
      avgFirstResponseMs: num(t.avg_first_response), inbound: num(m.inbound), outbound: num(m.outbound),
      automated: num(m.bot) + num(m.ai), calls: num(calls.total), callsCompleted: num(calls.completed), callsMissed: num(calls.missed),
      conversions: num(sales.n), conversionValue: num(sales.value), thirdTickRate: outbound ? num(m.acted) / outbound : 0,
    },
    perDay: perDay.map((d) => ({ day: d.day, inbound: num(d.inbound), outbound: num(d.outbound) })),
    agents: agents.map((a) => ({ ...a, avg_first_response: a.avg_first_response === null ? null : num(a.avg_first_response) })),
    topics: [...tagCounts].map(([tag, n]) => ({ tag, n })).sort((a, b) => b.n - a.n).slice(0, 8),
    moods,
  };
}

/** Visits per node, so a flow's drop-off points are visible on the canvas. */
export function botJourney(botId: number) {
  const runs = all<any>('SELECT status, COUNT(*) n FROM bot_runs WHERE bot_id = ? GROUP BY status', botId);
  const nodes = all<any>(
    `SELECT l.node_id, COUNT(DISTINCT l.run_id) visits FROM bot_log l JOIN bot_runs r ON r.id = l.run_id
     WHERE r.bot_id = ? AND l.event = 'enter' GROUP BY l.node_id`, botId,
  );
  const log = all<any>(
    `SELECT l.*, r.conversation_id FROM bot_log l JOIN bot_runs r ON r.id = l.run_id WHERE r.bot_id = ? ORDER BY l.id DESC LIMIT 100`, botId,
  );
  return { runs, nodes, log };
}

export function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const cell = (v: unknown) => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // stops spreadsheet formula injection from customer text
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n');
}

export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [], cur = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
    } else cur += ch;
  }
  row.push(cur);
  if (row.some((c) => c !== '')) rows.push(row);
  const [head, ...body] = rows;
  if (!head) return [];
  const keys = head.map((h) => h.trim().toLowerCase());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}
