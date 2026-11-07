import { addEdge, Background, Controls, Handle, Position, ReactFlow, useEdgesState, useNodesState, type Connection, type Edge, type Node, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { createContext, useContext, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { Empty, PageHead, useApp, useData } from '../lib/ui';

const TYPES: Record<string, { icon: string; label: string; data: object }> = {
  message: { icon: '💬', label: 'Message', data: { text: 'Hello {{first_name}}!' } },
  buttons: { icon: '🔘', label: 'Buttons', data: { text: 'Pick one', options: ['Yes', 'No'] } },
  question: { icon: '❓', label: 'Question', data: { text: 'What is your city?', saveTo: 'city' } },
  condition: { icon: '🔀', label: 'Condition', data: { field: 'tag', op: 'equals', value: 'vip' } },
  form: { icon: '📋', label: 'Form', data: { formId: '' } },
  tag: { icon: '🏷️', label: 'Add tag', data: { tag: 'lead' } },
  set_field: { icon: '✏️', label: 'Set field', data: { field: 'stage', value: 'qualified' } },
  delay: { icon: '⏳', label: 'Delay', data: { seconds: 60 } },
  ai: { icon: '🧠', label: 'AI answer', data: {} },
  handoff: { icon: '🙋', label: 'Hand to human', data: { text: 'Connecting you with the team!' } },
};

const Hits = createContext<Record<string, number>>({});

function outputs(type: string, data: any): { id: string; label: string }[] {
  if (type === 'buttons') return [...(data.options ?? []).map((o: string, i: number) => ({ id: `opt${i}`, label: o })), { id: 'other', label: 'anything else' }];
  if (type === 'condition') return [{ id: 'true', label: 'true' }, { id: 'false', label: 'false' }];
  if (type === 'ai') return [{ id: 'answered', label: 'answered' }, { id: 'unsure', label: 'unsure' }];
  return [];
}

function FlowNode({ id, type, data, selected }: NodeProps) {
  const hits = useContext(Hits);
  const d = data as any;
  const meta = type === 'start' ? { icon: '🚀', label: 'Start' } : TYPES[type!];
  const outs = outputs(type!, d);
  const terminal = type === 'handoff';
  return (
    <div className={selected ? 'node sel' : 'node'}>
      {type !== 'start' && <Handle type="target" position={Position.Left} />}
      {hits[id] ? <span className="hits" title="Visits">{hits[id]}</span> : null}
      <b>{meta?.icon} {meta?.label}</b>
      <div className="txt">{d.text ?? d.tag ?? (d.field ? `${d.field} ${d.op ?? '='} ${d.value ?? ''}` : d.seconds ? `${d.seconds}s` : '')}</div>
      {outs.length > 0
        ? <div className="outs">{outs.map((o) => (
          <div className="out-row" key={o.id}>{o.label}<Handle id={o.id} type="source" position={Position.Right} /></div>
        ))}</div>
        : !terminal && <Handle type="source" position={Position.Right} />}
    </div>
  );
}

const nodeTypes = Object.fromEntries(['start', ...Object.keys(TYPES)].map((t) => [t, FlowNode]));

export function Bots({ botId }: { botId?: number }) {
  const { toast } = useApp();
  const { data, refresh } = useData<any[]>(() => api.get('/bots'), [botId]);
  const bot = data?.find((b) => b.id === botId);

  const create = async () => {
    const name = prompt('Name your bot');
    if (!name) return;
    const b = await api.post('/bots', {
      name, enabled: 0, trigger: { type: 'keyword', keywords: ['hello'] },
      graph: { nodes: [{ id: 'start', type: 'start', position: { x: 40, y: 120 }, data: {} }], edges: [] },
    });
    location.hash = `#/bots/${b.id}`;
  };

  if (botId && bot) return <Builder key={bot.id} bot={bot} onSaved={refresh} />;
  return (
    <div className="page">
      <PageHead title="Bots" sub="Drag-and-drop flows that handle the repetitive stuff."><button className="btn primary" onClick={create}>New bot</button></PageHead>
      {data?.length === 0 && <div className="card"><Empty emoji="🤖" title="No bots yet">Start with a menu that routes people to the right place.</Empty></div>}
      <div className="grid-2">
        {data?.map((b) => (
          <article className="card" key={b.id}>
            <h3>{b.name}</h3>
            <p className="muted small">{b.enabled ? '🟢 Live' : '⚪ Off'} · {b.trigger.type === 'keyword' ? `keywords: ${(b.trigger.keywords ?? []).join(', ')}` : b.trigger.type.replaceAll('_', ' ')}</p>
            <div className="row">
              <a className="btn small" href={`#/bots/${b.id}`}>Edit</a>
              <button className="btn small" onClick={() => api.patch(`/bots/${b.id}`, { enabled: b.enabled ? 0 : 1 }).then(refresh)}>{b.enabled ? 'Turn off' : 'Turn on'}</button>
              <button className="btn small danger" onClick={() => { if (confirm(`Delete ${b.name}?`)) api.del(`/bots/${b.id}`).then(refresh).catch((e) => toast(e.message, 'error')); }}>Delete</button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

function Builder({ bot, onSaved }: { bot: any; onSaved: () => void }) {
  const { toast } = useApp();
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(bot.graph.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(bot.graph.edges.map((e: any, i: number) => ({ id: e.id ?? `e${i}`, ...e })));
  const [trigger, setTrigger] = useState(bot.trigger);
  const { data: forms } = useData<any[]>(() => api.get('/forms'));
  const { data: journey } = useData<any>(() => api.get(`/bots/${bot.id}/journey`), [bot.id]);
  const hits = useMemo(() => Object.fromEntries((journey?.nodes ?? []).map((n: any) => [n.node_id, n.visits])) as Record<string, number>, [journey]);
  const selected = nodes.find((n) => n.selected);

  const add = (type: string) => setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), {
    id: `${type}_${Date.now().toString(36)}`, type, selected: true, data: { ...TYPES[type].data }, position: { x: 200 + (ns.length % 4) * 60, y: 60 + (ns.length % 6) * 50 },
  }]);
  const edit = (patch: object) => setNodes((ns) => ns.map((n) => (n.id === selected?.id ? { ...n, data: { ...n.data, ...patch } } : n)));

  const save = async () => {
    try {
      await api.patch(`/bots/${bot.id}`, {
        trigger,
        graph: {
          nodes: nodes.map(({ id, type, data, position }) => ({ id, type, data, position })),
          edges: edges.map(({ id, source, target, sourceHandle }) => ({ id, source, target, sourceHandle })),
        },
      });
      toast('Bot saved');
      onSaved();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const d: any = selected?.data ?? {};
  return (
    <div className="page" style={{ maxWidth: 'none' }}>
      <PageHead title={bot.name} sub={`Runs: ${(journey?.runs ?? []).map((r: any) => `${r.n} ${r.status}`).join(', ') || 'none yet'}`}>
        <a className="btn" href="#/bots">Back</a>
        <button className="btn primary" onClick={save}>Save</button>
      </PageHead>
      <div className="palette-nodes">
        {Object.entries(TYPES).map(([k, v]) => <button key={k} className="chip" onClick={() => add(k)}>{v.icon} {v.label}</button>)}
      </div>
      <div className="flow-layout">
        <div className="flow">
          <Hits.Provider value={hits}>
            <ReactFlow
              nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
              onConnect={(c: Connection) => setEdges((es) => addEdge(c, es))} fitView deleteKeyCode={['Backspace', 'Delete']}
            >
              <Background /><Controls />
            </ReactFlow>
          </Hits.Provider>
        </div>
        <aside className="card form">
          <h3>Trigger</h3>
          <label>When<select value={trigger.type} onChange={(e) => setTrigger({ ...trigger, type: e.target.value })}>
            <option value="keyword">Message has a keyword</option>
            <option value="new_conversation">A new conversation starts</option>
            <option value="outside_hours">Outside working hours</option>
          </select></label>
          {trigger.type === 'keyword' && <label>Keywords<input value={(trigger.keywords ?? []).join(', ')} onChange={(e) => setTrigger({ ...trigger, keywords: e.target.value.split(',').map((s) => s.trim()) })} /></label>}
          <h3>{selected ? 'Selected step' : 'Select a step to edit it'}</h3>
          {selected && d.text !== undefined && <label>Text<textarea rows={3} value={d.text} onChange={(e) => edit({ text: e.target.value })} /></label>}
          {selected?.type === 'buttons' && <label>Options (max 3, comma separated)<input value={(d.options ?? []).join(',')} onChange={(e) => edit({ options: e.target.value.split(',') })} /></label>}
          {selected?.type === 'question' && <label>Save answer to field<input value={d.saveTo} onChange={(e) => edit({ saveTo: e.target.value })} /></label>}
          {selected?.type === 'form' && <label>Form<select value={d.formId} onChange={(e) => edit({ formId: e.target.value })}><option value="">Pick a form</option>{forms?.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label>}
          {selected?.type === 'tag' && <label>Tag<input value={d.tag} onChange={(e) => edit({ tag: e.target.value })} /></label>}
          {selected?.type === 'delay' && <label>Seconds<input type="number" min={1} value={d.seconds} onChange={(e) => edit({ seconds: Number(e.target.value) })} /></label>}
          {(selected?.type === 'condition' || selected?.type === 'set_field') && <>
            <label>Field<input value={d.field} onChange={(e) => edit({ field: e.target.value })} /></label>
            {selected.type === 'condition' && <label>Test<select value={d.op} onChange={(e) => edit({ op: e.target.value })}><option value="equals">equals</option><option value="not_equals">is not</option><option value="contains">contains</option><option value="exists">exists</option></select></label>}
            <label>Value<input value={d.value} onChange={(e) => edit({ value: e.target.value })} /></label>
          </>}
          {selected?.type === 'ai' && <p className="muted small">Answers from your AI brain. Connect "unsure" to a human so nobody gets stuck.</p>}
          {selected && selected.type !== 'start' && <button className="btn small danger" onClick={() => { setNodes((ns) => ns.filter((n) => n.id !== selected.id)); setEdges((es) => es.filter((e) => e.source !== selected.id && e.target !== selected.id)); }}>Delete step</button>}
          <p className="muted small">Use {'{{first_name}}'} or any saved field in text.</p>
        </aside>
      </div>
      <section className="card">
        <h3>Run log</h3>
        <div className="log">
          {(journey?.log ?? []).length === 0 && <p className="muted">No runs yet. Try it from the Simulator.</p>}
          {(journey?.log ?? []).map((l: any) => <div key={l.id}>{new Date(l.at).toLocaleTimeString()} · run {l.run_id} · {l.node_id} · {l.event} {l.detail}</div>)}
        </div>
      </section>
    </div>
  );
}
