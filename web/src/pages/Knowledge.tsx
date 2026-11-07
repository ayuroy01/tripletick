import { type FormEvent } from 'react';
import { api } from '../lib/api';
import { Empty, PageHead, useApp, useData } from '../lib/ui';

export function Knowledge() {
  const { me, toast } = useApp();
  const { data, refresh } = useData<any[]>(() => api.get('/knowledge'));
  const { data: settings, refresh: refreshSettings } = useData<any>(() => api.get('/settings'));
  const admin = me.role === 'admin';

  const add = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    await api.post('/knowledge', Object.fromEntries(new FormData(form))).then(() => { form.reset(); refresh(); }).catch((err) => toast(err.message, 'error'));
  };
  const save = (patch: object) => api.patch('/settings', patch).then(refreshSettings).catch((e) => toast(e.message, 'error'));

  return (
    <div className="page">
      <PageHead title="AI brain" sub={me.aiMode === 'claude' ? 'Claude answers from these articles, and hands off to a person when unsure.' : 'Running offline: answers are matched from these articles. Set ANTHROPIC_API_KEY for full Claude-powered replies.'} />
      {settings && (
        <section className="card form">
          <label className="row"><input type="checkbox" disabled={!admin} checked={settings.ai_agent_enabled} style={{ width: 'auto' }} onChange={(e) => save({ ai_agent_enabled: e.target.checked })} /> AI agent answers new chats before a human</label>
          <label>Personality<input disabled={!admin} defaultValue={settings.ai_persona} onBlur={(e) => { if (e.target.value !== settings.ai_persona) save({ ai_persona: e.target.value }); }} /></label>
        </section>
      )}
      <form className="card form" onSubmit={add}>
        <h3>Teach it something</h3>
        <label>Title<input name="title" required placeholder="Shipping times" /></label>
        <label>What should it know?<textarea name="content" required rows={3} /></label>
        <button className="btn primary">Add article</button>
      </form>
      {data?.length === 0 && <div className="card"><Empty emoji="🧠" title="The brain is empty">Add your FAQs, policies and hours above.</Empty></div>}
      <div className="grid-2">
        {data?.map((k) => (
          <article className="card" key={k.id}>
            <h3>{k.title}</h3>
            <p>{k.content}</p>
            <button className="btn small danger" onClick={() => api.del(`/knowledge/${k.id}`).then(refresh)}>Delete</button>
          </article>
        ))}
      </div>
    </div>
  );
}
