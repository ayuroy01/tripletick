import { useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { dial } from '../lib/call';
import { Empty, Modal, PageHead, useApp, useData } from '../lib/ui';

export function Campaigns() {
  const [tab, setTab] = useState('broadcasts');
  return (
    <div className="page">
      <PageHead title="Campaigns" sub="Reach people who asked to hear from you." />
      <div className="tabs" role="tablist">
        {['broadcasts', 'call lists', 'templates', 'forms', 'segments', 'quick replies'].map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t[0].toUpperCase() + t.slice(1)}</button>
        ))}
      </div>
      {tab === 'broadcasts' && <Broadcasts />}
      {tab === 'call lists' && <CallLists />}
      {tab === 'forms' && <Forms />}
      {tab === 'templates' && <Templates />}
      {tab === 'segments' && <Segments />}
      {tab === 'quick replies' && <QuickReplies />}
    </div>
  );
}

function Funnel({ s }: { s: Record<string, number> }) {
  const top = Math.max(s.total - s.skipped, 1);
  const rows: [string, number, boolean?][] = [['Sent', s.sent], ['Delivered', s.delivered], ['Read', s.read], ['✓✓✓ Replied', s.acted, true]];
  return (
    <div className="funnel">
      {rows.map(([label, n, hot]) => (
        <div key={label}><span>{label}</span><span className="bar"><i className={hot ? 'hot' : ''} style={{ width: `${(n / top) * 100}%` }} /></span><span>{n} ({Math.round((n / top) * 100)}%)</span></div>
      ))}
    </div>
  );
}

function Broadcasts() {
  const { toast } = useApp();
  const [creating, setCreating] = useState(false);
  const [retargeting, setRetargeting] = useState<any>();
  const { data, refresh } = useData<any[]>(() => api.get('/broadcasts'), [], ['broadcast', 'message']);
  const { data: templates } = useData<any[]>(() => api.get('/templates'));
  const { data: segments } = useData<any[]>(() => api.get('/segments'));
  const { data: channels } = useData<any[]>(() => api.get('/channels'));
  const approved = templates?.filter((t) => t.status === 'APPROVED') ?? [];

  const create = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    try {
      await api.post('/broadcasts', { ...f, scheduledAt: f.when ? new Date(f.when).getTime() : undefined });
      setCreating(false);
      refresh();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  const retarget = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget));
    try {
      await api.post(`/broadcasts/${retargeting.id}/retarget`, f);
      setRetargeting(undefined);
      refresh();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  return (
    <>
      <div className="row"><button className="btn primary" onClick={() => setCreating(true)}>New broadcast</button></div>
      {data?.length === 0 && <div className="card"><Empty emoji="📣" title="No broadcasts yet">Only opted-in contacts receive them, and STOP replies are honoured automatically.</Empty></div>}
      {data?.map((b) => (
        <article key={b.id} className="card">
          <div className="page-head">
            <div><h3>{b.name}</h3><p className="muted small">{b.template_name} · {b.segment_name ?? 'All contacts'} · <b>{b.status}</b>{b.scheduled_at && b.status === 'scheduled' ? ` for ${new Date(b.scheduled_at).toLocaleString()}` : ''}</p></div>
            <div className="row">
              {['scheduled', 'sending'].includes(b.status) && <button className="btn small" onClick={() => api.post(`/broadcasts/${b.id}/cancel`).then(refresh)}>Cancel</button>}
              {b.status === 'done' && <button className="btn small" onClick={() => setRetargeting(b)}>🎯 Retarget</button>}
            </div>
          </div>
          <Funnel s={b.stats} />
          {b.stats.skipped > 0 && <Skipped id={b.id} count={b.stats.skipped} />}
        </article>
      ))}
      {creating && (
        <Modal title="New broadcast" onClose={() => setCreating(false)}>
          <form className="form" onSubmit={create}>
            <label>Name<input name="name" required /></label>
            <label>Template (approved only)<select name="templateId" required>{approved.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
            <label>Send from<select name="channelId" required>{channels?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
            <label>Audience<select name="segmentId"><option value="">All contacts</option>{segments?.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.size})</option>)}</select></label>
            <label>Schedule (leave empty to send now)<input type="datetime-local" name="when" /></label>
            <p className="muted small">People without consent, or who got a broadcast recently, are skipped automatically.</p>
            <button className="btn primary">Create broadcast</button>
          </form>
        </Modal>
      )}
      {retargeting && (
        <Modal title="Retarget" onClose={() => setRetargeting(undefined)}>
          <form className="form" onSubmit={retarget}>
            <label>Who<select name="audience">
              <option value="read_no_action">Read it but didn't reply</option>
              <option value="not_read">Haven't read it</option>
              <option value="acted">Replied (the third tick crowd)</option>
            </select></label>
            <label>Template<select name="templateId">{approved.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
            <button className="btn primary">Send follow-up</button>
          </form>
        </Modal>
      )}
    </>
  );
}

const REASONS: Record<string, string> = { no_opt_in: 'No consent', opted_out: 'Opted out', frequency_cap: 'Messaged recently', cancelled: 'Cancelled' };

function Skipped({ id, count }: { id: number; count: number }) {
  const { data } = useData<any[]>(() => api.get(`/broadcasts/${id}/skipped`), [id, count]);
  return <p className="muted small">Skipped: {data?.map((r) => `${REASONS[r.reason] ?? r.reason} (${r.n})`).join(', ')}</p>;
}

function Templates() {
  const { toast } = useApp();
  const { data, refresh } = useData<any[]>(() => api.get('/templates'));
  const { data: channels } = useData<any[]>(() => api.get('/channels'));
  const [creating, setCreating] = useState(false);

  const create = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    try {
      await api.post('/templates', {
        ...f, name: f.name.toLowerCase().replace(/\W+/g, '_'),
        channel_id: f.channel_id ? Number(f.channel_id) : null,
        buttons: f.buttons.split(',').map((s) => s.trim()).filter(Boolean),
        variables: f.variables.split(',').map((s) => s.trim()).filter(Boolean),
      });
      setCreating(false);
      refresh();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  return (
    <>
      <div className="row"><button className="btn primary" onClick={() => setCreating(true)}>New template</button></div>
      <div className="card table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Category</th><th>Body</th><th>Status</th><th /></tr></thead>
          <tbody>{data?.map((t) => (
            <tr key={t.id}>
              <td>{t.name}</td><td>{t.category}</td><td>{t.body}</td><td>{t.status}</td>
              <td className="row">
                {t.status === 'DRAFT' && <button className="btn small" onClick={() => api.post(`/templates/${t.id}/submit`).then(refresh).catch((e) => toast(e.message, 'error'))}>Submit</button>}
                <button className="btn small danger" onClick={() => { if (confirm(`Delete ${t.name}?`)) api.del(`/templates/${t.id}`).then(refresh).catch((e) => toast(e.message, 'error')); }}>Delete</button>
              </td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      {creating && (
        <Modal title="New template" onClose={() => setCreating(false)}>
          <form className="form" onSubmit={create}>
            <label>Name<input name="name" required placeholder="spring_sale" /></label>
            <label>Category<select name="category"><option>MARKETING</option><option>UTILITY</option><option>AUTHENTICATION</option></select></label>
            <label>Channel<select name="channel_id"><option value="">Simulator (instant approval)</option>{channels?.filter((c) => c.type === 'whatsapp_cloud').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
            <label>Body, with {'{{1}}'} style placeholders<textarea name="body" required rows={3} /></label>
            <label>Placeholder values, in order<input name="variables" placeholder="first_name, city" /></label>
            <label>Footer<input name="footer" defaultValue="Reply STOP to unsubscribe" /></label>
            <label>Quick reply buttons, comma separated<input name="buttons" /></label>
            <button className="btn primary">Save draft</button>
          </form>
        </Modal>
      )}
    </>
  );
}

function Segments() {
  const { toast } = useApp();
  const { data, refresh } = useData<any[]>(() => api.get('/segments'));
  const [rules, setRules] = useState<any[] | null>(null);
  const [name, setName] = useState('');
  const [match, setMatch] = useState('all');
  const edit = (i: number, k: string, v: string) => setRules((r) => r!.map((x, n) => (n === i ? { ...x, [k]: v } : x)));

  const save = async (e: FormEvent) => {
    e.preventDefault();
    await api.post('/segments', { name, match, rules }).catch((err) => toast(err.message, 'error'));
    setRules(null);
    setName('');
    refresh();
  };

  return (
    <>
      <div className="row"><button className="btn primary" onClick={() => setRules([{ field: 'tag', op: 'equals', value: '' }])}>New segment</button></div>
      <div className="grid-2">
        {data?.map((s) => (
          <article className="card" key={s.id}>
            <h3>{s.name}</h3>
            <p className="muted">{s.size} contacts · match {s.match}</p>
            <p className="small">{s.rules.map((r: any) => `${r.field} ${r.op.replace('_', ' ')} ${r.value ?? ''}`).join(' · ')}</p>
            <button className="btn small danger" onClick={() => { if (confirm(`Delete ${s.name}?`)) api.del(`/segments/${s.id}`).then(refresh).catch((e) => toast(e.message, 'error')); }}>Delete</button>
          </article>
        ))}
      </div>
      {rules && (
        <Modal title="New segment" onClose={() => setRules(null)}>
          <form className="form" onSubmit={save}>
            <label>Name<input required value={name} onChange={(e) => setName(e.target.value)} /></label>
            <label>Match<select value={match} onChange={(e) => setMatch(e.target.value)}><option value="all">All rules</option><option value="any">Any rule</option></select></label>
            {rules.map((r, i) => (
              <div className="row" key={i}>
                <input className="grow" aria-label="Field" value={r.field} onChange={(e) => edit(i, 'field', e.target.value)} placeholder="tag, city, name…" style={{ width: 100 }} />
                <select aria-label="Operator" value={r.op} onChange={(e) => edit(i, 'op', e.target.value)} style={{ width: 120 }}>
                  <option value="equals">equals</option><option value="not_equals">is not</option><option value="contains">contains</option><option value="exists">exists</option>
                </select>
                <input className="grow" aria-label="Value" value={r.value} onChange={(e) => edit(i, 'value', e.target.value)} style={{ width: 100 }} />
              </div>
            ))}
            <button type="button" className="btn small" onClick={() => setRules([...rules, { field: 'tag', op: 'equals', value: '' }])}>+ Add rule</button>
            <button className="btn primary">Save segment</button>
          </form>
        </Modal>
      )}
    </>
  );
}

const OUTCOMES = [['interested', '🔥 Interested'], ['callback', '🔁 Call back'], ['not_interested', '🙅 Not interested'], ['no_answer', '📵 No answer']];

function CallLists() {
  const { toast } = useApp();
  const { data, refresh } = useData<any[]>(() => api.get('/call-lists'));
  const { data: segments } = useData<any[]>(() => api.get('/segments'));
  const { data: channels } = useData<any[]>(() => api.get('/channels'));
  const [creating, setCreating] = useState(false);
  const [current, setCurrent] = useState<any>();

  const create = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    try {
      const r = await api.post('/call-lists', Object.fromEntries(new FormData(e.currentTarget)));
      toast(`List created with ${r.size} people who gave consent`);
      setCreating(false);
      refresh();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  const next = async (id: number) => {
    const r = await api.post(`/call-lists/${id}/next`);
    if (r.done) toast('That list is finished. Nice work! 🎉');
    setCurrent(r.done ? undefined : r);
    refresh();
  };
  const finish = async (outcome: string) => {
    await api.post(`/call-list-items/${current.itemId}/outcome`, { outcome });
    setCurrent(undefined);
    refresh();
  };

  return (
    <>
      <div className="row"><button className="btn primary" onClick={() => setCreating(true)}>New call list</button></div>
      {current && (
        <section className="card form">
          <h3>Now calling: {current.name || 'Customer'}</h3>
          {current.script && <p className="summary">{current.script}</p>}
          <div className="row">
            <button className="btn primary" onClick={() => dial(current.conversationId)}>📞 Start call</button>
            <a className="btn" href={`#/inbox/${current.conversationId}`}>Open chat</a>
          </div>
          <div className="chips">{OUTCOMES.map(([k, label]) => <button key={k} className="chip" onClick={() => finish(k)}>{label}</button>)}</div>
        </section>
      )}
      {data?.length === 0 && <div className="card"><Empty emoji="📞" title="No call lists yet">Build a list from a segment and work through it, one call at a time.</Empty></div>}
      {data?.map((l) => (
        <article className="card" key={l.id}>
          <div className="page-head">
            <div><h3>{l.name}</h3><p className="muted small">{l.channel_name} · {l.done} of {l.total} done</p></div>
            <div className="row">
              <button className="btn small primary" disabled={!l.pending || !!current} onClick={() => next(l.id)}>Next call</button>
              <button className="btn small danger" onClick={() => { if (confirm(`Delete ${l.name}?`)) api.del(`/call-lists/${l.id}`).then(refresh); }}>Delete</button>
            </div>
          </div>
          <span className="bar" style={{ display: 'block' }}><i style={{ width: `${l.total ? (l.done / l.total) * 100 : 0}%` }} /></span>
          {l.outcomes.length > 0 && <p className="muted small">{l.outcomes.map((o: any) => `${o.outcome.replaceAll('_', ' ')}: ${o.n}`).join(' · ')}</p>}
        </article>
      ))}
      {creating && (
        <Modal title="New call list" onClose={() => setCreating(false)}>
          <form className="form" onSubmit={create}>
            <label>Name<input name="name" required /></label>
            <label>Call from<select name="channelId" required>{channels?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
            <label>Who<select name="segmentId"><option value="">All contacts</option>{segments?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
            <label>Call script<textarea name="script" rows={3} placeholder="Hi, this is… I'm calling about…" /></label>
            <p className="muted small">Only opted-in contacts are added. WhatsApp also asks each customer to allow calls.</p>
            <button className="btn primary">Create list</button>
          </form>
        </Modal>
      )}
    </>
  );
}

function Forms() {
  const { toast } = useApp();
  const { data, refresh } = useData<any[]>(() => api.get('/forms'));
  const [fields, setFields] = useState<any[] | null>(null);
  const edit = (i: number, k: string, v: unknown) => setFields((f) => f!.map((x, n) => (n === i ? { ...x, [k]: v } : x)));

  const save = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget));
    const clean = fields!.filter((x) => x.label).map((x) => ({ ...x, name: x.label.toLowerCase().replace(/\W+/g, '_') }));
    try {
      await api.post('/forms', { ...f, fields: clean });
      setFields(null);
      refresh();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  return (
    <>
      <div className="row"><button className="btn primary" onClick={() => setFields([{ label: '', type: 'text' }])}>New form</button></div>
      {data?.length === 0 && <div className="card"><Empty emoji="📋" title="No forms yet">Collect bookings, leads and feedback inside the chat. Answers land on the contact.</Empty></div>}
      <div className="grid-2">
        {data?.map((f) => (
          <article className="card" key={f.id}>
            <h3>{f.name}</h3>
            <p className="muted small">{f.fields.map((x: any) => x.label).join(', ')}</p>
            <p className="small">{f.meta_flow_id ? `✓ Linked to Meta Flow ${f.meta_flow_id}` : 'Simulator only until you add a Meta Flow ID'}</p>
            <button className="btn small danger" onClick={() => { if (confirm(`Delete ${f.name}?`)) api.del(`/forms/${f.id}`).then(refresh); }}>Delete</button>
          </article>
        ))}
      </div>
      {fields && (
        <Modal title="New form" onClose={() => setFields(null)}>
          <form className="form" onSubmit={save}>
            <label>Name<input name="name" required /></label>
            <label>Message<input name="body" required placeholder="Book your slot with us!" /></label>
            <label>Button text<input name="cta" defaultValue="Open form" maxLength={20} /></label>
            {fields.map((x, i) => (
              <div className="row" key={i}>
                <input className="grow" aria-label="Question" placeholder="Question" value={x.label} onChange={(e) => edit(i, 'label', e.target.value)} style={{ width: 140 }} />
                <select aria-label="Answer type" value={x.type} onChange={(e) => edit(i, 'type', e.target.value)} style={{ width: 100 }}><option value="text">Text</option><option value="select">Choice</option></select>
                {x.type === 'select' && <input className="grow" aria-label="Choices" placeholder="Choices, comma separated" value={(x.options ?? []).join(',')} onChange={(e) => edit(i, 'options', e.target.value.split(','))} style={{ width: 140 }} />}
              </div>
            ))}
            <button type="button" className="btn small" onClick={() => setFields([...fields, { label: '', type: 'text' }])}>+ Add question</button>
            <label>Meta Flow ID (for real WhatsApp)<input name="meta_flow_id" placeholder="Build the Flow in WhatsApp Manager, then paste its ID" /></label>
            <label>First screen ID<input name="screen" /></label>
            <button className="btn primary">Save form</button>
          </form>
        </Modal>
      )}
    </>
  );
}

function QuickReplies() {
  const { toast } = useApp();
  const { data, refresh } = useData<any[]>(() => api.get('/quick-replies'));
  const add = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = Object.fromEntries(new FormData(form));
    await api.post('/quick-replies', f).then(() => { form.reset(); refresh(); }).catch((err) => toast(err.message, 'error'));
  };
  return (
    <div className="card">
      <form className="row" onSubmit={add}>
        <input name="shortcut" required placeholder="shortcut" aria-label="Shortcut" style={{ width: 140 }} />
        <input className="grow" name="body" required placeholder="Reply text" aria-label="Reply text" style={{ width: 200 }} />
        <button className="btn primary">Add</button>
      </form>
      <table><tbody>{data?.map((q) => (
        <tr key={q.id}><td><b>/{q.shortcut}</b></td><td>{q.body}</td><td><button className="btn small danger" onClick={() => api.del(`/quick-replies/${q.id}`).then(refresh)}>Delete</button></td></tr>
      ))}</tbody></table>
    </div>
  );
}
