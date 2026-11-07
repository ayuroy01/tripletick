import { useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { Modal, PageHead, useApp, useData } from '../lib/ui';

export function Settings() {
  const { me, signOut } = useApp();
  const admin = me.role === 'admin';
  const tabs = admin ? ['workspace', 'channels', 'integrations', 'team', 'developers', 'audit log'] : ['team'];
  const [tab, setTab] = useState(tabs[0]);
  return (
    <div className="page">
      <PageHead title="Settings"><button className="btn" onClick={signOut}>Sign out</button></PageHead>
      <div className="tabs" role="tablist">
        {tabs.map((t) => <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t[0].toUpperCase() + t.slice(1)}</button>)}
      </div>
      {tab === 'workspace' && <Workspace />}
      {tab === 'channels' && <Channels />}
      {tab === 'integrations' && <Integrations />}
      {tab === 'team' && <Team admin={admin} />}
      {tab === 'developers' && <Developers />}
      {tab === 'audit log' && <Audit />}
    </div>
  );
}

function Workspace() {
  const { toast } = useApp();
  const { data: s, setData } = useData<any>(() => api.get('/settings'));
  if (!s) return null;
  const save = (patch: object) => api.patch('/settings', patch).then((r) => { setData(r); toast('Saved'); }).catch((e) => toast(e.message, 'error'));
  const hours = s.working_hours;
  const Toggle = ({ k, label }: { k: string; label: string }) => (
    <label className="row"><input type="checkbox" checked={s[k]} style={{ width: 'auto' }} onChange={(e) => save({ [k]: e.target.checked })} /> {label}</label>
  );
  return (
    <div className="grid-2">
      <section className="card form">
        <h3>Inbox rules</h3>
        <label>SLA for first reply (minutes)<input type="number" min={1} defaultValue={s.sla_minutes} onBlur={(e) => save({ sla_minutes: Number(e.target.value) })} /></label>
        <Toggle k="auto_assign" label="Auto-assign new chats (round robin)" />
        <Toggle k="mask_for_agents" label="Mask customer phone, email and card numbers from agents" />
        <Toggle k="block_agent_contact_sharing" label="Block agents from sharing their own contact details" />
        <Toggle k="fun_mode" label="Fun mode: XP, badges, the Arena and confetti" />
      </section>
      <section className="card form">
        <h3>Broadcast safety</h3>
        <label>Messages per 2-second tick<input type="number" min={1} max={500} defaultValue={s.broadcast_rate_per_tick} onBlur={(e) => save({ broadcast_rate_per_tick: Number(e.target.value) })} /></label>
        <label>Minimum hours between broadcasts to the same person<input type="number" min={0} defaultValue={s.broadcast_cap_hours} onBlur={(e) => save({ broadcast_cap_hours: Number(e.target.value) })} /></label>
      </section>
      <section className="card form">
        <h3>Working hours</h3>
        <label className="row"><input type="checkbox" checked={hours.enabled} style={{ width: 'auto' }} onChange={(e) => save({ working_hours: { ...hours, enabled: e.target.checked } })} /> Only auto-assign during working hours</label>
        <label>Time zone<input defaultValue={hours.timezone} onBlur={(e) => save({ working_hours: { ...hours, timezone: e.target.value } })} /></label>
        <div className="row">
          <label className="grow">Opens<input type="time" defaultValue={hours.start} onBlur={(e) => save({ working_hours: { ...hours, start: e.target.value } })} /></label>
          <label className="grow">Closes<input type="time" defaultValue={hours.end} onBlur={(e) => save({ working_hours: { ...hours, end: e.target.value } })} /></label>
        </div>
        <label>Away message<textarea rows={2} defaultValue={hours.away_message} onBlur={(e) => save({ working_hours: { ...hours, away_message: e.target.value } })} /></label>
      </section>
    </div>
  );
}

function Channels() {
  const { toast } = useApp();
  const { data, refresh } = useData<any[]>(() => api.get('/channels'));
  const [adding, setAdding] = useState(false);
  const add = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const { name, phone, ...config } = Object.fromEntries(new FormData(e.currentTarget));
    try {
      await api.post('/channels', { type: 'whatsapp_cloud', name, phone, config });
      setAdding(false);
      refresh();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  return (
    <>
      <div className="row">
        <button className="btn primary" onClick={() => setAdding(true)}>Connect WhatsApp number</button>
        <button className="btn" onClick={() => api.post('/channels', { type: 'simulator', name: 'Simulator', phone: '+15550100' }).then(refresh)}>Add simulator</button>
      </div>
      <div className="card table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Type</th><th>Phone</th><th>Status</th><th /></tr></thead>
          <tbody>{data?.map((c) => (
            <tr key={c.id}>
              <td>{c.name}</td><td>{c.type === 'simulator' ? 'Simulator' : 'WhatsApp Cloud API'}</td><td>{c.phone}</td><td>{c.enabled ? 'On' : 'Off'}</td>
              <td className="row">
                <button className="btn small" onClick={() => api.patch(`/channels/${c.id}`, { enabled: c.enabled ? 0 : 1 }).then(refresh)}>{c.enabled ? 'Disable' : 'Enable'}</button>
                {c.type === 'whatsapp_cloud' && <button className="btn small" onClick={() => api.post(`/channels/${c.id}/sync-templates`).then((r) => toast(`Synced ${r.synced} templates`)).catch((e) => toast(e.message, 'error'))}>Sync templates</button>}
              </td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      {adding && (
        <Modal title="Connect a WhatsApp number" onClose={() => setAdding(false)}>
          <form className="form" onSubmit={add}>
            <p className="muted small">From your Meta developer app. Point its webhook at <code>{location.origin}/webhooks/whatsapp</code>. Meta bills conversations directly.</p>
            <label>Name<input name="name" required /></label>
            <label>Display phone<input name="phone" required /></label>
            <label>Phone number ID<input name="phoneNumberId" required /></label>
            <label>WhatsApp Business Account ID<input name="wabaId" required /></label>
            <label>Access token<input name="accessToken" type="password" required autoComplete="off" /></label>
            <label>App secret<input name="appSecret" type="password" required autoComplete="off" /></label>
            <label>Webhook verify token (make one up)<input name="verifyToken" required autoComplete="off" /></label>
            <button className="btn primary">Connect</button>
          </form>
        </Modal>
      )}
    </>
  );
}

const CONNECTORS: Record<string, { icon: string; label: string; about: string; fields: [string, string, string?][] }> = {
  hubspot: { icon: '🧡', label: 'HubSpot', about: 'Syncs contacts with an email address every hour.', fields: [['accessToken', 'Private app token', 'password']] },
  salesforce: { icon: '☁️', label: 'Salesforce', about: 'Syncs contacts every hour. Add an external ID field called TripleTick_Id__c to Contact first.', fields: [['instanceUrl', 'Instance URL'], ['accessToken', 'Access token', 'password']] },
  zoho: { icon: '🟥', label: 'Zoho CRM', about: 'Syncs contacts with an email address every hour.', fields: [['region', 'Region (com, eu, in, com.au, jp, ca, sa)'], ['accessToken', 'OAuth token', 'password']] },
  shopify: { icon: '🛍️', label: 'Shopify', about: 'Abandoned cart reminders and order messages, to customers who gave consent.', fields: [['secret', 'Webhook signing secret', 'password'], ['channelId', 'Channel ID to send from'], ['cartTemplateId', 'Cart reminder template ID'], ['cartDelayMinutes', 'Minutes before a reminder'], ['orderTemplateId', 'Order message template ID (optional)']] },
  meta_capi: { icon: '📊', label: 'Meta Ads conversions', about: 'Reports logged sales from click-to-WhatsApp ads back to Meta.', fields: [['datasetId', 'Dataset ID'], ['wabaId', 'WhatsApp Business Account ID'], ['accessToken', 'Access token', 'password']] },
  inbound: { icon: '🚪', label: 'Inbound hook', about: 'A private URL that adds contacts from Tally, Pabbly, Zapier, Make, Google Sheets or anything that can POST JSON.', fields: [] },
};

function Integrations() {
  const { toast } = useApp();
  const { data, refresh } = useData<any[]>(() => api.get('/connectors'));
  const [adding, setAdding] = useState<string>();
  const [url, setUrl] = useState<string>();

  const add = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    try {
      const r = await api.post('/connectors', { type: adding, name: CONNECTORS[adding!].label, config: Object.fromEntries(new FormData(e.currentTarget)) });
      setAdding(undefined);
      if (r.path) setUrl(location.origin + r.path);
      refresh();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  const sync = (id: number) => api.post(`/connectors/${id}/sync`).then((c) => { toast(c.last_status); refresh(); }).catch((e) => toast(e.message, 'error'));

  return (
    <>
      <div className="grid-2">
        {Object.entries(CONNECTORS).map(([k, c]) => (
          <article className="card" key={k}>
            <h3>{c.icon} {c.label}</h3>
            <p className="muted small">{c.about}</p>
            <button className="btn small" onClick={() => setAdding(k)}>Connect</button>
          </article>
        ))}
      </div>
      {!!data?.length && (
        <div className="card table-wrap">
          <table>
            <thead><tr><th>Connected</th><th>Last result</th><th /></tr></thead>
            <tbody>{data.map((c) => (
              <tr key={c.id}>
                <td>{CONNECTORS[c.type]?.icon} {c.name}</td><td>{c.last_status ?? '–'}</td>
                <td className="row">
                  {['hubspot', 'salesforce', 'zoho'].includes(c.type) && <button className="btn small" onClick={() => sync(c.id)}>Sync now</button>}
                  <button className="btn small danger" onClick={() => { if (confirm(`Disconnect ${c.name}?`)) api.del(`/connectors/${c.id}`).then(refresh); }}>Disconnect</button>
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {adding && (
        <Modal title={`Connect ${CONNECTORS[adding].label}`} onClose={() => setAdding(undefined)}>
          <form className="form" onSubmit={add}>
            <p className="muted small">{CONNECTORS[adding].about}</p>
            {CONNECTORS[adding].fields.map(([name, label, type]) => <label key={name}>{label}<input name={name} type={type ?? 'text'} autoComplete="off" /></label>)}
            <button className="btn primary">Connect</button>
          </form>
        </Modal>
      )}
      {url && (
        <Modal title="Your webhook URL" onClose={() => setUrl(undefined)}>
          <p>Paste this into the other service. Treat it like a password.</p>
          <pre className="snippet">{url}</pre>
        </Modal>
      )}
    </>
  );
}

function Team({ admin }: { admin: boolean }) {
  const { toast } = useApp();
  const { data, refresh } = useData<any[]>(() => api.get('/users'));
  const [adding, setAdding] = useState(false);
  const add = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    try {
      await api.post('/users', { ...f, managerId: f.managerId ? Number(f.managerId) : null });
      setAdding(false);
      refresh();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  const patch = (id: number, b: object) => api.patch(`/users/${id}`, b).then(refresh).catch((e) => toast(e.message, 'error'));
  return (
    <>
      {admin && <div className="row"><button className="btn primary" onClick={() => setAdding(true)}>Add teammate</button></div>}
      <div className="card table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Reports to</th><th /></tr></thead>
          <tbody>{data?.map((u) => (
            <tr key={u.id} style={u.active ? undefined : { opacity: .55 }}>
              <td>{u.name}</td><td>{u.email}</td>
              <td>{admin
                ? <select aria-label={`Role for ${u.name}`} value={u.role} onChange={(e) => patch(u.id, { role: e.target.value })}><option>admin</option><option>manager</option><option>agent</option></select>
                : u.role}</td>
              <td>{admin
                ? <select aria-label={`Manager for ${u.name}`} value={u.manager_id ?? ''} onChange={(e) => patch(u.id, { managerId: e.target.value ? Number(e.target.value) : null })}>
                    <option value="">Nobody</option>
                    {data.filter((m) => m.id !== u.id).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                : data.find((m) => m.id === u.manager_id)?.name ?? '–'}</td>
              <td>{admin && <button className="btn small" onClick={() => patch(u.id, { active: u.active ? 0 : 1 })}>{u.active ? 'Deactivate' : 'Reactivate'}</button>}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      {adding && (
        <Modal title="Add teammate" onClose={() => setAdding(false)}>
          <form className="form" onSubmit={add}>
            <label>Name<input name="name" required /></label>
            <label>Email<input name="email" type="email" required /></label>
            <label>Temporary password<input name="password" type="password" required minLength={8} autoComplete="new-password" /></label>
            <label>Role<select name="role" defaultValue="agent"><option>agent</option><option>manager</option><option>admin</option></select></label>
            <label>Reports to<select name="managerId"><option value="">Nobody</option>{data?.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
            <button className="btn primary">Add</button>
          </form>
        </Modal>
      )}
    </>
  );
}

function Developers() {
  const { toast } = useApp();
  const { data: keys, refresh } = useData<any[]>(() => api.get('/api-keys'));
  const { data: hooks, refresh: refreshHooks } = useData<any[]>(() => api.get('/webhooks'));
  const [secret, setSecret] = useState<{ label: string; value: string }>();
  const newKey = async () => {
    const name = prompt('What is this key for?');
    if (!name) return;
    const r = await api.post('/api-keys', { name });
    setSecret({ label: 'API key', value: r.key });
    refresh();
  };
  const addHook = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    try {
      const r = await api.post('/webhooks', { url: new FormData(form).get('url') });
      setSecret({ label: 'Signing secret', value: r.secret });
      form.reset();
      refreshHooks();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  return (
    <div className="grid-2">
      <section className="card form">
        <h3>API keys</h3>
        <p className="muted small">Send as <code>Authorization: Bearer …</code> to any <code>/api</code> route.</p>
        <button className="btn small" onClick={newKey}>New key</button>
        <table><tbody>{keys?.map((k) => <tr key={k.id}><td>{k.name}</td><td><code>{k.prefix}…</code></td><td><button className="btn small danger" onClick={() => api.del(`/api-keys/${k.id}`).then(refresh)}>Revoke</button></td></tr>)}</tbody></table>
      </section>
      <section className="card form">
        <h3>Webhooks</h3>
        <p className="muted small">Works with Zapier, Make, n8n or your own server. Payloads are signed in <code>x-tripletick-signature</code>.</p>
        <form className="row" onSubmit={addHook}><input className="grow" name="url" type="url" required placeholder="https://…" aria-label="Webhook URL" style={{ width: 200 }} /><button className="btn small">Add</button></form>
        <table><tbody>{hooks?.map((h) => <tr key={h.id}><td style={{ overflowWrap: 'anywhere' }}>{h.url}</td><td>{h.last_status ?? '–'}</td><td><button className="btn small danger" onClick={() => api.del(`/webhooks/${h.id}`).then(refreshHooks)}>Delete</button></td></tr>)}</tbody></table>
      </section>
      {secret && (
        <Modal title={`Your new ${secret.label.toLowerCase()}`} onClose={() => setSecret(undefined)}>
          <p>Copy it now. You won't see it again.</p>
          <pre className="snippet">{secret.value}</pre>
        </Modal>
      )}
    </div>
  );
}

function Audit() {
  const { data } = useData<any[]>(() => api.get('/audit'));
  return (
    <div className="card table-wrap">
      <table>
        <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th></tr></thead>
        <tbody>{data?.map((a) => <tr key={a.id}><td>{new Date(a.at).toLocaleString()}</td><td>{a.user_name ?? 'System'}</td><td>{a.action}</td><td>{a.target}</td></tr>)}</tbody>
      </table>
    </div>
  );
}
