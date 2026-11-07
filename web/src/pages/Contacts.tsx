import { useState, type ChangeEvent, type FormEvent } from 'react';
import { api } from '../lib/api';
import { Empty, Modal, PageHead, useApp, useData } from '../lib/ui';

export function Contacts() {
  const { me, toast } = useApp();
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const { data, refresh } = useData<any[]>(() => api.get(`/contacts?q=${encodeURIComponent(q)}`), [q]);
  const { data: channels } = useData<any[]>(() => api.get('/channels'));
  const lead = me.role !== 'agent';

  const add = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      await api.post('/contacts', { name: f.get('name'), phone: f.get('phone'), email: f.get('email'), optedIn: f.get('optedIn') === 'on' });
      setAdding(false);
      refresh();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  const importCsv = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const optedIn = confirm('Have all of these people agreed to receive WhatsApp messages from you?\n\nOK marks them as opted in. Cancel imports them without consent, so they will not get broadcasts.');
    const r = await api.post('/contacts/import', { csv: await file.text(), optedIn });
    toast(`Imported ${r.imported} contacts${r.skipped ? `, skipped ${r.skipped} without a valid phone` : ''}`);
    refresh();
  };

  const open = async (id: number) => {
    const channel = channels?.find((c) => c.enabled);
    if (!channel) return toast('Add a channel first', 'error');
    const r = await api.post(`/contacts/${id}/conversation`, { channelId: channel.id });
    location.hash = `#/inbox/${r.id}`;
  };

  return (
    <div className="page">
      <PageHead title="Contacts" sub={`${data?.length ?? 0} people`}>
        <input type="search" placeholder="Search" aria-label="Search contacts" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 200 }} />
        {lead && <>
          <label className="btn">Import CSV<input type="file" accept=".csv,text/csv" hidden onChange={importCsv} /></label>
          <a className="btn" href="/api/contacts/export">Export</a>
        </>}
        <button className="btn primary" onClick={() => setAdding(true)}>Add contact</button>
      </PageHead>
      <div className="card table-wrap">
        {data?.length === 0 ? <Empty emoji="👥" title="No contacts found">Import a CSV with name, phone, email and tags columns. Extra columns become custom fields.</Empty> : (
          <table>
            <thead><tr><th>Name</th><th>Phone</th><th>Tags</th><th>Broadcasts</th><th /></tr></thead>
            <tbody>
              {data?.map((c) => (
                <tr key={c.id}>
                  <td>{c.name || '–'}</td>
                  <td>{c.phone}</td>
                  <td><div className="chips">{c.tags.map((t: string) => <em className="tag" key={t}>{t}</em>)}</div></td>
                  <td>{c.opted_out_at ? 'Opted out' : c.opted_in ? '✓ Opted in' : 'No consent'}</td>
                  <td className="row">
                    <button className="btn small" onClick={() => open(c.id)}>Open chat</button>
                    {lead && <button className="btn small danger" onClick={() => { if (confirm(`Delete ${c.name || c.phone} and their chats?`)) api.del(`/contacts/${c.id}`).then(refresh); }}>Delete</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {adding && (
        <Modal title="Add contact" onClose={() => setAdding(false)}>
          <form className="form" onSubmit={add}>
            <label>Name<input name="name" /></label>
            <label>Phone (with country code)<input name="phone" required placeholder="+15550100" /></label>
            <label>Email<input name="email" type="email" /></label>
            <label className="row"><input type="checkbox" name="optedIn" style={{ width: 'auto' }} /> This person agreed to receive broadcasts</label>
            <button className="btn primary">Save</button>
          </form>
        </Modal>
      )}
    </div>
  );
}
