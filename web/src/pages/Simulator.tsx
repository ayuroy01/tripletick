import { useEffect, useRef, useState } from 'react';
import { api, onLive } from '../lib/api';
import { connect, createPeer, finishGathering, type Peer } from '../lib/call';
import { clock, PageHead, Rich, useApp, useData } from '../lib/ui';

/** Play the customer. Messages take the same path through the system as real ones. */
export function Simulator() {
  const { toast } = useApp();
  const { data: channels } = useData<any[]>(() => api.get('/channels'));
  const sims = channels?.filter((c) => c.type === 'simulator') ?? [];
  const [channelId, setChannelId] = useState<number>();
  const [from, setFrom] = useState('+15550199');
  const [name, setName] = useState('Casey Tester');
  const [text, setText] = useState('');
  const channel = channelId ?? sims[0]?.id;
  const { data: thread, refresh } = useData<any[]>(
    () => (channel ? api.get(`/simulator/thread?channelId=${channel}&from=${encodeURIComponent(from)}`) : Promise.resolve([])), [channel, from],
  );
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => onLive((e) => { if (e.type === 'message') refresh(); }), [refresh]);
  useEffect(() => { scroller.current?.scrollTo({ top: 1e9 }); }, [thread?.length]);

  // The customer's end of a call. Real audio over WebRTC, with this page as the phone.
  const peer = useRef<Peer | undefined>(undefined);
  const [call, setCall] = useState<{ id: number; state: string } | null>(null);
  const [ringing, setRinging] = useState<any>();
  const hangupLocal = () => { peer.current?.close(); peer.current = undefined; setCall(null); };

  const checkCalls = async () => {
    if (!channel) return;
    const live: any[] = await api.get(`/simulator/calls?channelId=${channel}&from=${encodeURIComponent(from)}`);
    const mine = callRef.current;
    const current = live.find((c) => c.id === mine?.id);
    if (mine && !current) hangupLocal();
    if (mine && current?.status === 'active' && current.direction === 'in' && current.sdp_answer && peer.current?.pc.signalingState === 'have-local-offer') {
      await connect(peer.current, 'answer', current.sdp_answer);
      setCall({ id: mine.id, state: 'Connecting…' });
    }
    setRinging(live.find((c) => c.direction === 'out' && c.status === 'ringing'));
  };
  const callRef = useRef(call);
  callRef.current = call;
  useEffect(() => { checkCalls(); return onLive((e) => { if (e.type === 'call') checkCalls(); }); }, [channel, from]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => hangupLocal, []);

  /** The label follows the real connection, so it can't claim audio that isn't flowing. */
  const watch = (p: Peer) => p.pc.addEventListener('connectionstatechange', () => {
    const state = { connected: 'Connected', failed: 'No audio: blocked by a firewall' }[p.pc.connectionState as string];
    if (state) setCall((c) => c && { ...c, state });
  });

  const callBusiness = async () => {
    try {
      const { iceServers } = await api.get('/calls/config');
      const p = await createPeer(iceServers);
      peer.current = p;
      watch(p);
      await p.pc.setLocalDescription(await p.pc.createOffer());
      await finishGathering(p.pc);
      const { id } = await api.post('/simulator/call', { channelId: channel, from, name, sdp: p.pc.localDescription!.sdp });
      setCall({ id, state: 'Ringing…' });
    } catch (e) {
      hangupLocal();
      toast((e as Error).message, 'error');
    }
  };

  const pickUp = async () => {
    try {
      const { iceServers } = await api.get('/calls/config');
      const p = await createPeer(iceServers);
      peer.current = p;
      watch(p);
      await connect(p, 'offer', ringing.sdp_offer);
      await p.pc.setLocalDescription(await p.pc.createAnswer());
      await finishGathering(p.pc);
      await api.post(`/simulator/calls/${ringing.id}/answer`, { sdp: p.pc.localDescription!.sdp });
      setCall({ id: ringing.id, state: 'Connecting…' });
      setRinging(undefined);
    } catch (e) {
      hangupLocal();
      toast((e as Error).message, 'error');
    }
  };

  const endCall = async (id: number) => {
    await api.post(`/simulator/calls/${id}/hangup`).catch(() => {});
    hangupLocal();
    setRinging(undefined);
  };

  const say = async (body: string) => {
    if (!body.trim()) return;
    try {
      await api.post('/simulator/inbound', { channelId: channel, from, name, body });
      setText('');
      refresh();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const submitForm = async (form: Record<string, string>) => {
    try {
      await api.post('/simulator/inbound', { channelId: channel, from, name, form });
      refresh();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <div className="page">
      <PageHead title="Simulator" sub="A pretend customer phone. Test bots, the inbox and broadcasts without a Meta account." />
      <div className="grid-2">
        <section className="card form">
          <h3>Who are you playing?</h3>
          <label>Channel<select value={channel ?? ''} onChange={(e) => setChannelId(Number(e.target.value))}>{sims.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          <label>Name<input value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label>Phone<input value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <h3>Try saying</h3>
          <div className="chips">
            {['menu', 'How long does shipping take?', 'This is terrible, I want a refund', 'STOP', 'START'].map((s) => <button key={s} className="chip" onClick={() => say(s)}>{s}</button>)}
          </div>
          <p className="muted small">Open the Inbox in another tab to reply as the team. The ticks update live.</p>
        </section>
        <div className="phone" aria-label="Simulated phone">
          <header className="row" style={{ justifyContent: 'space-between' }}>
            <span>{sims.find((c) => c.id === channel)?.name ?? 'Business'}</span>
            {!call && !ringing && <button className="btn small" onClick={callBusiness}>📞 Call</button>}
          </header>
          {ringing && !call && (
            <div className="sim-call"><b>📞 The business is calling</b>
              <div className="row"><button className="btn small primary" onClick={pickUp}>Answer</button><button className="btn small" onClick={() => endCall(ringing.id)}>Decline</button></div>
            </div>
          )}
          {call && <div className="sim-call"><b data-testid="sim-call-state">{call.state}</b><button className="btn small" onClick={() => endCall(call.id)}>Hang up</button></div>}
          <div className="messages" ref={scroller}>
            {thread?.map((m) => (
              <div key={m.id} className={`bubble ${m.direction === 'in' ? 'out' : 'in'}`}>
                <div className="body"><Rich text={m.body} /></div>
                {m.payload.form && <SimForm form={m.payload.form} onSubmit={(answers) => submitForm(answers)} />}
                {[...(m.payload.options ?? []), ...(m.payload.buttons ?? [])].length > 0 && (
                  <div className="opts">{[...(m.payload.options ?? []), ...(m.payload.buttons ?? [])].map((o: string) => <button key={o} className="opt" onClick={() => say(o)}>{o}</button>)}</div>
                )}
                <div className="stamp"><time>{clock(m.created_at)}</time></div>
              </div>
            ))}
          </div>
          <form onSubmit={(e) => { e.preventDefault(); say(text); }}>
            <input placeholder="Message" aria-label="Customer message" value={text} onChange={(e) => setText(e.target.value)} />
            <button className="btn primary">Send</button>
          </form>
        </div>
      </div>
    </div>
  );
}

function SimForm({ form, onSubmit }: { form: any; onSubmit: (answers: Record<string, string>) => void }) {
  const [open, setOpen] = useState(false);
  if (!open) return <div className="opts"><button className="opt" onClick={() => setOpen(true)}>{form.cta}</button></div>;
  return (
    <form
      className="sim-form"
      onSubmit={(e) => { e.preventDefault(); onSubmit(Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>); setOpen(false); }}
    >
      {form.fields.map((f: any) => (
        <label key={f.name}>{f.label}
          {f.type === 'select'
            ? <select name={f.name}>{f.options?.map((o: string) => <option key={o}>{o}</option>)}</select>
            : <input name={f.name} required />}
        </label>
      ))}
      <button className="btn small primary">Submit</button>
    </form>
  );
}
