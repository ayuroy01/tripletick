import { answerFromKnowledge } from './ai.ts';
import { all, get, getSettings, insert, parse, run } from './db.ts';
import { addSystemNote, assign, isWithinWorkingHours, pickAgent, restartSla, send, windowOpen } from './messaging.ts';
import { publish } from './events.ts';

export interface BotNode { id: string; type: string; data: Record<string, any>; position?: { x: number; y: number } }
export interface BotEdge { id?: string; source: string; target: string; sourceHandle?: string | null }
export interface Graph { nodes: BotNode[]; edges: BotEdge[] }
export interface Trigger { type: 'keyword' | 'new_conversation' | 'outside_hours'; keywords?: string[] }

const MAX_STEPS = 50; // a looped flow must not spam a customer

const log = (runId: number, nodeId: string, event: string, detail = '') =>
  run('INSERT INTO bot_log(run_id, node_id, event, detail, at) VALUES(?, ?, ?, ?, ?)', runId, nodeId, event, detail, Date.now());

function next(g: Graph, nodeId: string, handle?: string): BotNode | undefined {
  const edge = g.edges.find((e) => e.source === nodeId && (handle === undefined || (e.sourceHandle ?? '') === handle));
  return edge ? g.nodes.find((n) => n.id === edge.target) : undefined;
}

function finish(runId: number, status: 'done' | 'handoff' | 'failed') {
  run('UPDATE bot_runs SET status = ?, ended_at = ?, wake_at = NULL WHERE id = ?', status, Date.now(), runId);
}

const history = (conversationId: number) =>
  all<{ direction: string; kind: string; body: string }>('SELECT direction, kind, body FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 20', conversationId).reverse();

function contactOf(conversationId: number) {
  return get<any>('SELECT k.* FROM contacts k JOIN conversations c ON c.contact_id = k.id WHERE c.id = ?', conversationId)!;
}

function fill(text: string, contact: any) {
  const fields = parse<Record<string, string>>(contact.fields, {});
  return String(text ?? '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => {
    if (key === 'name') return contact.name || 'there';
    if (key === 'first_name') return contact.name.split(' ')[0] || 'there';
    return fields[key] ?? '';
  });
}

function evaluate(data: Record<string, any>, contact: any, lastText: string): boolean {
  const fields = parse<Record<string, string>>(contact.fields, {});
  const tags = parse<string[]>(contact.tags, []);
  const want = String(data.value ?? '').toLowerCase();
  if (data.field === 'tag') return tags.map((t) => t.toLowerCase()).includes(want);
  if (data.field === 'hours') return isWithinWorkingHours();
  const actual = String(data.field === 'last_message' ? lastText : (fields[data.field] ?? '')).toLowerCase();
  switch (data.op) {
    case 'equals': return actual === want;
    case 'not_equals': return actual !== want;
    case 'exists': return actual !== '';
    default: return actual.includes(want);
  }
}

/** Walks the graph until the flow waits for the customer, sleeps, or ends. */
async function walk(runId: number, g: Graph, start: BotNode | undefined, conversationId: number, lastText: string) {
  let node = start;
  for (let steps = 0; node; steps++) {
    if (steps >= MAX_STEPS) {
      log(runId, node.id, 'error', 'Step limit reached. The flow may contain a loop.');
      finish(runId, 'failed');
      return;
    }
    run('UPDATE bot_runs SET node_id = ? WHERE id = ?', node.id, runId);
    log(runId, node.id, 'enter', node.type);
    const contact = contactOf(conversationId);
    const d = node.data ?? {};
    switch (node.type) {
      case 'start':
        node = next(g, node.id);
        break;
      case 'message':
        await send(conversationId, { kind: 'text', body: fill(d.text, contact) }, { via: 'bot' });
        node = next(g, node.id);
        break;
      case 'buttons': {
        const options = (d.options as string[] ?? []).filter(Boolean).slice(0, 3);
        await send(conversationId, { kind: 'buttons', body: fill(d.text, contact), options }, { via: 'bot' });
        run("UPDATE bot_runs SET status = 'waiting' WHERE id = ?", runId);
        return;
      }
      case 'form':
        await send(conversationId, { kind: 'form', formId: Number(d.formId) }, { via: 'bot' });
        run("UPDATE bot_runs SET status = 'waiting' WHERE id = ?", runId);
        return;
      case 'question':
        await send(conversationId, { kind: 'text', body: fill(d.text, contact) }, { via: 'bot' });
        run("UPDATE bot_runs SET status = 'waiting' WHERE id = ?", runId);
        return;
      case 'condition':
        node = next(g, node.id, evaluate(d, contact, lastText) ? 'true' : 'false');
        break;
      case 'tag': {
        const tags = new Set(parse<string[]>(contact.tags, []));
        if (d.tag) tags.add(String(d.tag));
        run('UPDATE contacts SET tags = ? WHERE id = ?', JSON.stringify([...tags]), contact.id);
        publish({ type: 'conversation', id: conversationId });
        node = next(g, node.id);
        break;
      }
      case 'set_field': {
        run('UPDATE contacts SET fields = ? WHERE id = ?', JSON.stringify({ ...parse(contact.fields, {}), [d.field]: fill(d.value, contact) }), contact.id);
        node = next(g, node.id);
        break;
      }
      case 'delay': {
        const seconds = Math.max(1, Number(d.seconds) || 60);
        const after = next(g, node.id);
        if (!after) { finish(runId, 'done'); return; }
        run("UPDATE bot_runs SET status = 'sleeping', node_id = ?, wake_at = ? WHERE id = ?", after.id, Date.now() + seconds * 1000, runId);
        return;
      }
      case 'ai': {
        const answer = await answerFromKnowledge(history(conversationId), lastText);
        if (answer) {
          await send(conversationId, { kind: 'text', body: answer }, { via: 'ai' });
          node = next(g, node.id, 'answered');
        } else {
          log(runId, node.id, 'ai_unsure');
          node = next(g, node.id, 'unsure');
        }
        break;
      }
      case 'handoff': {
        const agent = d.userId ? Number(d.userId) : pickAgent();
        if (d.text) await send(conversationId, { kind: 'text', body: fill(d.text, contact) }, { via: 'bot' });
        if (agent) assign(conversationId, agent);
        restartSla(conversationId);
        finish(runId, 'handoff');
        return;
      }
      default:
        log(runId, node.id, 'error', `Unknown node type: ${node.type}`);
        finish(runId, 'failed');
        return;
    }
  }
  finish(runId, 'done');
}

export async function startBot(botId: number, conversationId: number, text: string) {
  const bot = get<{ graph: string }>('SELECT graph FROM bots WHERE id = ?', botId);
  if (!bot) return;
  const g = parse<Graph>(bot.graph, { nodes: [], edges: [] });
  const start = g.nodes.find((n) => n.type === 'start');
  if (!start) return;
  const runId = insert('INSERT INTO bot_runs(bot_id, conversation_id, node_id, started_at) VALUES(?, ?, ?, ?)', botId, conversationId, start.id, Date.now());
  await guarded(runId, conversationId, () => walk(runId, g, start, conversationId, text));
}

async function guarded(runId: number, conversationId: number, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (e) {
    log(runId, 'engine', 'error', (e as Error).message);
    finish(runId, 'failed');
    addSystemNote(conversationId, `Bot stopped: ${(e as Error).message}`);
  }
}

async function resume(r: { id: number; bot_id: number; node_id: string; conversation_id: number }, text: string) {
  const g = parse<Graph>(get<{ graph: string }>('SELECT graph FROM bots WHERE id = ?', r.bot_id)?.graph, { nodes: [], edges: [] });
  const node = g.nodes.find((n) => n.id === r.node_id);
  if (!node) return finish(r.id, 'failed');
  log(r.id, node.id, 'reply', text.slice(0, 200));
  run("UPDATE bot_runs SET status = 'running' WHERE id = ?", r.id);
  let target: BotNode | undefined;
  if (node.type === 'buttons') {
    const i = (node.data.options as string[] ?? []).findIndex((o) => o.toLowerCase() === text.trim().toLowerCase());
    target = i >= 0 ? (next(g, node.id, `opt${i}`) ?? next(g, node.id, '')) : next(g, node.id, 'other');
  } else {
    if (node.data.saveTo) {
      const contact = contactOf(r.conversation_id);
      run('UPDATE contacts SET fields = ? WHERE id = ?', JSON.stringify({ ...parse(contact.fields, {}), [node.data.saveTo]: text }), contact.id);
    }
    target = next(g, node.id);
  }
  await guarded(r.id, r.conversation_id, () => walk(r.id, g, target, r.conversation_id, text));
}

export function matches(t: Trigger, text: string, isNew: boolean, withinHours: boolean): boolean {
  if (t.type === 'new_conversation') return isNew;
  if (t.type === 'outside_hours') return !withinHours;
  if (t.type === 'keyword') {
    const words = text.toLowerCase();
    return (t.keywords ?? []).some((k) => k.trim() && new RegExp(`(^|\\W)${k.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|\\W)`).test(words));
  }
  return false;
}

/** Decides who handles an inbound message: a waiting bot, a new bot, the AI agent, or a human. */
export async function onInbound(conversationId: number, text: string, isNew: boolean) {
  const waiting = get<any>("SELECT * FROM bot_runs WHERE conversation_id = ? AND status = 'waiting' ORDER BY id DESC LIMIT 1", conversationId);
  if (waiting) return resume(waiting, text);

  const conv = get<{ assignee_id: number | null }>('SELECT assignee_id FROM conversations WHERE id = ?', conversationId)!;
  if (conv.assignee_id) return; // a human owns this chat, so automation stays out of it

  const hours = isWithinWorkingHours();
  for (const b of all<{ id: number; trigger: string }>('SELECT id, trigger FROM bots WHERE enabled = 1 ORDER BY id')) {
    if (matches(parse<Trigger>(b.trigger, { type: 'keyword' }), text, isNew, hours)) return startBot(b.id, conversationId, text);
  }

  const s = getSettings();
  if (!hours && isNew) await send(conversationId, { kind: 'text', body: s.working_hours.away_message }, { via: 'system' });
  if (s.ai_agent_enabled && hours) {
    const answer = await answerFromKnowledge(history(conversationId), text);
    if (answer) {
      await send(conversationId, { kind: 'text', body: answer }, { via: 'ai' });
      return;
    }
  }
  if (s.auto_assign && hours) {
    const agent = pickAgent();
    if (agent) assign(conversationId, agent);
  }
}

/** Scheduler entry: wakes delayed flows. The customer may have gone quiet past the window. */
export async function wakeSleepingBots() {
  for (const r of all<any>("SELECT * FROM bot_runs WHERE status = 'sleeping' AND wake_at <= ?", Date.now())) {
    const conv = get<any>('SELECT last_inbound_at FROM conversations WHERE id = ?', r.conversation_id);
    if (!conv || !windowOpen(conv)) {
      log(r.id, r.node_id, 'error', 'The 24-hour window closed during the delay');
      finish(r.id, 'failed');
      continue;
    }
    const g = parse<Graph>(get<{ graph: string }>('SELECT graph FROM bots WHERE id = ?', r.bot_id)?.graph, { nodes: [], edges: [] });
    run("UPDATE bot_runs SET status = 'running', wake_at = NULL WHERE id = ?", r.id);
    await guarded(r.id, r.conversation_id, () => walk(r.id, g, g.nodes.find((n) => n.id === r.node_id), r.conversation_id, ''));
  }
}
