import { useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { api, onLive } from '../lib/api';
import { dial } from '../lib/call';
import { confetti, playSound } from '../lib/fun';
import { TEXT_STYLES } from '../lib/textStyles';
import { clock, Empty, MOODS, Modal, Rich, Ticks, timeAgo, useApp, useData } from '../lib/ui';

const QUICK: { id: string; label: string; q: Record<string, string> }[] = [
  { id: 'open', label: 'Open', q: { status: 'open' } },
  { id: 'mine', label: 'Mine', q: { status: 'open', assignee: 'me' } },
  { id: 'none', label: 'Unassigned', q: { status: 'open', assignee: 'none' } },
  { id: 'await', label: 'Awaiting reply', q: { status: 'open', awaiting: '1' } },
  { id: 'upset', label: 'Upset 😠', q: { status: 'open', mood: 'upset' } },
  { id: 'sla', label: 'SLA breached', q: { breached: '1' } },
  { id: 'snoozed', label: 'Snoozed', q: { status: 'snoozed' } },
  { id: 'done', label: 'Resolved', q: { status: 'resolved' } },
];

export function Inbox({ conversationId }: { conversationId?: number }) {
  const { toast, prefs } = useApp();
  const [filter, setFilter] = useState<Record<string, string>>(QUICK[0].q);
  const [active, setActive] = useState('open');
  const [search, setSearch] = useState('');
  const query = new URLSearchParams({ ...filter, ...(search ? { q: search } : {}) }).toString();
  const { data: list } = useData<any[]>(() => api.get(`/conversations?${query}`), [query], ['conversation', 'message']);
  const { data: views, refresh: refreshViews } = useData<any[]>(() => api.get('/views'));

  const saveView = async () => {
    const name = prompt('Name this view');
    if (!name) return;
    await api.post('/views', { name, filters: filter });
    refreshViews();
    toast('View saved');
  };

  // A new unread message from any chat plays the receive sound.
  const unread = list?.reduce((n, c) => n + c.unread, 0) ?? 0;
  const prev = useRef(unread);
  useEffect(() => {
    if (unread > prev.current) playSound(prefs.sound, 'receive');
    prev.current = unread;
  }, [unread, prefs.sound]);

  return (
    <div className={conversationId ? 'inbox has-chat' : 'inbox'}>
      <section className="chat-list" aria-label="Conversations">
        <div className="list-head">
          <input type="search" placeholder="Search chats and messages" aria-label="Search chats" value={search} onChange={(e) => setSearch(e.target.value)} />
          <div className="chips">
            {QUICK.map((f) => (
              <button key={f.id} className={active === f.id ? 'chip on' : 'chip'} aria-pressed={active === f.id} onClick={() => { setActive(f.id); setFilter(f.q); }}>{f.label}</button>
            ))}
            {views?.map((v) => (
              <span key={v.id} className={active === `v${v.id}` ? 'chip on' : 'chip'}>
                <button onClick={() => { setActive(`v${v.id}`); setFilter(v.filters); }}>★ {v.name}</button>
                <button aria-label={`Delete view ${v.name}`} onClick={() => api.del(`/views/${v.id}`).then(refreshViews)}>×</button>
              </span>
            ))}
            <button className="chip" onClick={saveView}>+ Save view</button>
          </div>
        </div>
        {list?.length === 0 && <Empty emoji="🌴" title="Nothing here">Enjoy the quiet, or open the Simulator and play a customer.</Empty>}
        <ul>
          {list?.map((c) => (
            <li key={c.id}>
              <a href={`#/inbox/${c.id}`} className={c.id === conversationId ? 'chat-row on' : 'chat-row'}>
                <span className="avatar" aria-hidden>{(c.contact.name || '#')[0]}<i className="mood">{MOODS[c.mood]}</i></span>
                <span className="chat-main">
                  <span className="chat-top"><b>{c.contact.name || c.contact.phone}</b><time>{timeAgo(c.last_message_at)}</time></span>
                  <span className="chat-prev">{c.last_preview}</span>
                  <span className="chat-meta">
                    {c.sla_breached ? <em className="tag danger">SLA</em> : null}
                    {c.contact.tags.slice(0, 2).map((t: string) => <em key={t} className="tag">{t}</em>)}
                    <em className="by">{c.assignee_name ?? 'Unassigned'} · {c.channel_name}</em>
                  </span>
                </span>
                {c.unread > 0 && <span className="badge" aria-label={`${c.unread} unread`}>{c.unread}</span>}
              </a>
            </li>
          ))}
        </ul>
      </section>
      {conversationId
        ? <Thread key={conversationId} id={conversationId} />
        : <section className="thread"><Empty emoji="✓✓✓" title="Pick a chat">The third tick lights up when a customer replies to you.</Empty></section>}
    </div>
  );
}

function Thread({ id }: { id: number }) {
  const { me, toast, prefs } = useApp();
  const { data, refresh, error } = useData<any>(() => api.get(`/conversations/${id}`), [id], []);
  const { data: users } = useData<any[]>(() => api.get('/users'));
  const scroller = useRef<HTMLDivElement>(null);
  const [details, setDetails] = useState(false);

  useEffect(() => onLive((e) => {
    if ((e.type === 'message' && e.conversationId === id) || (e.type === 'conversation' && e.id === id)) refresh();
  }), [id, refresh]);

  useEffect(() => { api.post(`/conversations/${id}/read`).catch(() => {}); }, [id, data?.messages.length]);
  useEffect(() => { scroller.current?.scrollTo({ top: 1e9 }); }, [data?.messages.length]);

  if (error) return <section className="thread"><Empty emoji="🚫" title="Can't open this chat">{error}</Empty></section>;
  if (!data) return <section className="thread" />;
  const { conversation: c, contact, messages, reminders } = data;
  const patch = (b: object) => api.patch(`/conversations/${id}`, b).then(refresh).catch((e) => toast(e.message, 'error'));
  const resolve = async () => {
    await patch({ status: 'resolved' });
    if (me.funMode) { confetti(); playSound(prefs.sound, 'win'); }
    toast('Resolved. Nice one! 🎉');
  };
  const snooze = (hours: number) => patch({ status: 'snoozed', snoozeUntil: Date.now() + hours * 3600e3 });

  return (
    <>
      <section className="thread" aria-label="Conversation">
        <header className="thread-head">
          <a className="btn ghost icon back" href="#/inbox" aria-label="Back to chats">←</a>
          <button className="who" onClick={() => setDetails((d) => !d)}>
            <span className="avatar" aria-hidden>{(contact.name || '#')[0]}</span>
            <span><b>{contact.name || contact.phone}</b><small>{MOODS[c.mood]} {contact.phone} · {c.channel_name}</small></span>
          </button>
          <div className="row">
            <label className="sr" htmlFor="assignee">Assignee</label>
            <select id="assignee" value={c.assignee_id ?? ''} onChange={(e) => patch({ assigneeId: e.target.value ? Number(e.target.value) : null })}>
              <option value="">Unassigned</option>
              {users?.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
            {c.status === 'resolved'
              ? <button className="btn" onClick={() => patch({ status: 'open' })}>Reopen</button>
              : <>
                <button className="btn" onClick={() => dial(id)} title="Call this customer">📞 Call</button>
                <button className="btn" onClick={() => snooze(4)} title="Snooze for 4 hours">💤 Snooze</button>
                <button className="btn primary" onClick={resolve}>✓ Resolve</button>
              </>}
          </div>
        </header>
        <div className="messages" ref={scroller} role="log" aria-live="polite">
          {messages.map((m: any) => <Bubble key={m.id} m={m} />)}
        </div>
        <Composer conversation={c} onSent={refresh} />
      </section>
      <Details open={details} id={id} contact={contact} conversation={c} reminders={reminders} refresh={refresh} />
    </>
  );
}

function Bubble({ m }: { m: any }) {
  if (m.kind === 'system') return <div className="sys">{m.body}</div>;
  if (m.kind === 'note') return <div className="note"><b>📝 {m.user_name}</b><Rich text={m.body} /></div>;
  const out = m.direction === 'out';
  const media = m.payload?.mediaFile;
  return (
    <div className={`bubble ${out ? 'out' : 'in'}`}>
      {m.payload?.header && <b>{m.payload.header}</b>}
      {media && (m.payload.mime?.startsWith('image/')
        ? <img src={`/api/media/${media}`} alt={m.payload.fileName ?? 'Attachment'} loading="lazy" />
        : <a href={`/api/media/${media}`}>📎 {m.payload.fileName}</a>)}
      {m.payload?.form && <b>📋 {m.payload.form.name}</b>}
      {m.body && <div className="body"><Rich text={m.body} /></div>}
      {m.payload?.footer && <small className="foot">{m.payload.footer}</small>}
      {[...(m.payload?.options ?? []), ...(m.payload?.buttons ?? [])].length > 0 && (
        <div className="opts">{[...(m.payload?.options ?? []), ...(m.payload?.buttons ?? [])].map((o: string) => <span key={o}>{o}</span>)}</div>
      )}
      <div className="stamp">
        {m.via !== 'agent' && m.via !== 'customer' && <span className="via">{m.via}</span>}
        {out && m.user_name && <span>{m.user_name} ·</span>}
        <time>{clock(m.created_at)}</time>
        {out && <Ticks status={m.status} />}
      </div>
      {m.status === 'failed' && <small className="err">{m.error}</small>}
    </div>
  );
}

function Composer({ conversation: c, onSent }: { conversation: any; onSent: () => void }) {
  const { toast, prefs, me } = useApp();
  const id = c.id;
  const [text, setText] = useState('');
  const [mode, setMode] = useState<'reply' | 'note'>('reply');
  const [menu, setMenu] = useState<'style' | 'ai' | null>(null);
  const [templates, setTemplates] = useState(false);
  const [forms, setForms] = useState(false);
  const [replies, setReplies] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const { data: quick } = useData<any[]>(() => api.get('/quick-replies'));

  const slash = text.startsWith('/') ? text.slice(1).toLowerCase() : null;
  const matches = useMemo(() => (slash === null ? [] : quick?.filter((q) => q.shortcut.startsWith(slash)) ?? []), [slash, quick]);

  const sendNow = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      await api.post(`/conversations/${id}/${mode === 'note' ? 'notes' : 'messages'}`, { body });
      setText('');
      setReplies([]);
      if (mode === 'reply') playSound(prefs.sound, 'send');
      onSent();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (matches[0]) setText(matches[0].body);
      else sendNow();
    }
  };

  /** Styles the selection, or everything if nothing is selected. */
  const applyStyle = (fn: (s: string) => string) => {
    const el = box.current!;
    const [a, b] = [el.selectionStart, el.selectionEnd];
    setText(a === b ? fn(text) : text.slice(0, a) + fn(text.slice(a, b)) + text.slice(b));
    setMenu(null);
    el.focus();
  };

  const rewrite = async (m: string, language?: string) => {
    setMenu(null);
    if (!text.trim()) return toast('Write something first', 'error');
    setBusy(true);
    try {
      setText((await api.post('/ai/rewrite', { mode: m, text, language })).text);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const magic = async () => {
    setBusy(true);
    try {
      setReplies((await api.post(`/conversations/${id}/magic-replies`)).replies);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const attach = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = await new Promise<string>((ok, no) => {
        const r = new FileReader();
        r.onload = () => ok(String(r.result).split(',')[1]);
        r.onerror = () => no(new Error('Could not read that file'));
        r.readAsDataURL(file);
      });
      const up = await api.post('/media', { name: file.name, mime: file.type, data });
      await api.post(`/conversations/${id}/messages`, { ...up, body: text });
      setText('');
      onSent();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  const closed = !c.window_open && mode === 'reply';
  return (
    <footer className={`composer ${mode}`}>
      {replies.length > 0 && (
        <div className="magic">{replies.map((r) => <button key={r} className="chip" onClick={() => { setText(r); setReplies([]); box.current?.focus(); }}>{r}</button>)}</div>
      )}
      {matches.length > 0 && (
        <ul className="popover slash">{matches.map((q) => <li key={q.id}><button onClick={() => setText(q.body)}><b>/{q.shortcut}</b> {q.body}</button></li>)}</ul>
      )}
      {menu === 'style' && (
        <div className="popover styles" role="menu">
          <p className="small muted">Real Unicode, so it reaches the customer styled. Screen readers may read it oddly, so keep it for short flourishes.</p>
          <div className="style-grid">
            {TEXT_STYLES.map((s) => (
              <button key={s.id} role="menuitem" onClick={() => applyStyle(s.apply)} title={s.label}>{s.apply(text.slice(0, 14) || 'Triple Tick')}</button>
            ))}
          </div>
        </div>
      )}
      {menu === 'ai' && (
        <div className="popover ai" role="menu">
          {[['polish', '✍️ Polish'], ['shorter', '✂️ Shorter'], ['friendly', '🤗 Friendlier'], ['funky', '🕺 Funkier']].map(([k, label]) => (
            <button key={k} role="menuitem" onClick={() => rewrite(k)}>{label}</button>
          ))}
          <button role="menuitem" onClick={() => { const l = prompt('Translate into which language?'); if (l) rewrite('translate', l); }}>🌍 Translate</button>
          {me.aiMode === 'offline' && <p className="small muted">Offline helpers. Add a Claude API key for full AI.</p>}
        </div>
      )}
      <div className="mode-tabs" role="tablist">
        <button role="tab" aria-selected={mode === 'reply'} className={mode === 'reply' ? 'on' : ''} onClick={() => setMode('reply')}>Reply</button>
        <button role="tab" aria-selected={mode === 'note'} className={mode === 'note' ? 'on' : ''} onClick={() => setMode('note')}>Internal note</button>
        {closed && <span className="window">24h window closed: templates only</span>}
      </div>
      {closed
        ? <button className="btn primary" onClick={() => setTemplates(true)}>Send a template</button>
        : (
          <>
            <textarea
              ref={box} rows={2} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey}
              aria-label={mode === 'note' ? 'Internal note' : 'Message'}
              placeholder={mode === 'note' ? 'Only your team sees this' : 'Type a message, or / for quick replies'}
            />
            <div className="tools">
              <button className="btn ghost" aria-expanded={menu === 'style'} onClick={() => setMenu(menu === 'style' ? null : 'style')} title="Text styles">𝓐𝓪 Style</button>
              <button className="btn ghost" aria-expanded={menu === 'ai'} onClick={() => setMenu(menu === 'ai' ? null : 'ai')}>✨ Rewrite</button>
              <button className="btn ghost" onClick={magic} disabled={busy}>🪄 Magic reply</button>
              <button className="btn ghost" onClick={() => setTemplates(true)}>📄 Template</button>
              <button className="btn ghost" onClick={() => setForms(true)}>📋 Form</button>
              <label className="btn ghost">📎<span className="sr">Attach a file</span><input type="file" hidden accept="image/png,image/jpeg,image/webp,application/pdf" onChange={attach} /></label>
              <button className="btn primary send" onClick={sendNow} disabled={busy || !text.trim()}>{mode === 'note' ? 'Add note' : 'Send'}</button>
            </div>
          </>
        )}
      {templates && <TemplatePicker id={id} close={() => setTemplates(false)} onSent={onSent} />}
      {forms && <FormPicker id={id} close={() => setForms(false)} onSent={onSent} />}
    </footer>
  );
}

function TemplatePicker({ id, close, onSent }: { id: number; close: () => void; onSent: () => void }) {
  const { toast } = useApp();
  const { data } = useData<any[]>(() => api.get('/templates'));
  const approved = data?.filter((t) => t.status === 'APPROVED');
  const send = async (templateId: number) => {
    try {
      await api.post(`/conversations/${id}/messages`, { templateId });
      onSent();
      close();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return (
    <Modal title="Send a template" onClose={close}>
      {approved?.length === 0 && <p className="muted">No approved templates yet. Create one under Campaigns.</p>}
      <ul className="picks">{approved?.map((t) => <li key={t.id}><button onClick={() => send(t.id)}><b>{t.name}</b><span>{t.body}</span></button></li>)}</ul>
    </Modal>
  );
}

function FormPicker({ id, close, onSent }: { id: number; close: () => void; onSent: () => void }) {
  const { toast } = useApp();
  const { data } = useData<any[]>(() => api.get('/forms'));
  const send = async (formId: number) => {
    try {
      await api.post(`/conversations/${id}/form`, { formId });
      onSent();
      close();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return (
    <Modal title="Send a form" onClose={close}>
      {data?.length === 0 && <p className="muted">No forms yet. Create one under Campaigns.</p>}
      <ul className="picks">{data?.map((f) => <li key={f.id}><button onClick={() => send(f.id)}><b>{f.name}</b><span>{f.body}</span></button></li>)}</ul>
    </Modal>
  );
}

function Details({ open, id, contact, conversation, reminders, refresh }: any) {
  const { toast } = useApp();
  const [tag, setTag] = useState('');
  const [summary, setSummary] = useState<string | null>(conversation.summary);
  const [busy, setBusy] = useState(false);
  const saveTags = (tags: string[]) => api.patch(`/contacts/${contact.id}`, { tags }).then(refresh).catch((e) => toast(e.message, 'error'));
  const summarize = async () => {
    setBusy(true);
    setSummary((await api.post(`/conversations/${id}/summary`)).summary);
    setBusy(false);
  };
  const convert = async () => {
    const raw = prompt('Sale value (leave empty for none)', '');
    if (raw === null) return;
    try {
      const r = await api.post(`/conversations/${id}/conversion`, { eventName: 'Purchase', value: Number(raw || 0) });
      toast(r.metaStatus === 'sent' ? 'Sale logged and reported to Meta Ads 💰' : 'Sale logged 💰');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const remind = async () => {
    const text = prompt('Remind me to…');
    if (!text) return;
    await api.post(`/conversations/${id}/reminders`, { text, dueAt: Date.now() + 3600e3 });
    toast('Reminder set for 1 hour from now');
    refresh();
  };
  return (
    <aside className={open ? 'details open' : 'details'} aria-label="Contact details">
      <h3>{contact.name || 'No name'}</h3>
      <dl>
        <dt>Phone</dt><dd>{contact.phone}</dd>
        {contact.email && <><dt>Email</dt><dd>{contact.email}</dd></>}
        <dt>Broadcasts</dt><dd>{contact.opted_out_at ? 'Opted out' : contact.opted_in ? 'Opted in' : 'No consent yet'}</dd>
        {Object.entries(contact.fields).map(([k, v]) => <div key={k} className="pair"><dt>{k.replaceAll('_', ' ')}</dt><dd>{String(v)}</dd></div>)}
      </dl>
      <h4>Tags</h4>
      <div className="chips">
        {contact.tags.map((t: string) => (
          <span key={t} className="chip">{t}<button aria-label={`Remove tag ${t}`} onClick={() => saveTags(contact.tags.filter((x: string) => x !== t))}>×</button></span>
        ))}
      </div>
      <form className="row" onSubmit={(e) => { e.preventDefault(); if (tag.trim()) { saveTags([...new Set([...contact.tags, tag.trim()])]); setTag(''); } }}>
        <input placeholder="Add a tag" aria-label="Add a tag" value={tag} onChange={(e) => setTag(e.target.value)} />
      </form>
      <h4>AI summary</h4>
      {summary && <p className="summary">{summary}</p>}
      <button className="btn small" onClick={summarize} disabled={busy}>{busy ? 'Thinking…' : summary ? 'Refresh summary' : 'Summarise chat'}</button>
      <h4>Reminders</h4>
      <ul className="plain">{reminders.map((r: any) => <li key={r.id}>⏰ {r.text} <small className="muted">{new Date(r.due_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small></li>)}</ul>
      <button className="btn small" onClick={remind}>+ Add reminder</button>
      <h4>Sales</h4>
      <button className="btn small" onClick={convert}>💰 Log a sale</button>
    </aside>
  );
}
