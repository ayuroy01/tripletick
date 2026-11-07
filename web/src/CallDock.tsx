import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api, onLive } from './lib/api';
import { connect, createPeer, finishGathering, type Peer } from './lib/call';
import { playSound } from './lib/fun';
import { useApp } from './lib/ui';

interface LiveCall { id: number; conversation_id: number; direction: string; status: string; user_id: number | null; contact: string; sdp_offer: string | null; sdp_answer: string | null; answered_at: number | null }

const clockOf = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/** Floats over every page, so a call survives moving around the app. */
export function CallDock({ hidden }: { hidden: boolean }) {
  const { me, toast, prefs } = useApp();
  const [calls, setCalls] = useState<LiveCall[]>([]);
  const [mineId, setMineId] = useState<number>();
  const [net, setNet] = useState('');
  const [muted, setMuted] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const peer = useRef<Peer | undefined>(undefined);
  const mineRef = useRef(mineId);
  mineRef.current = mineId;

  const cleanup = useCallback(() => {
    peer.current?.close();
    peer.current = undefined;
    setMineId(undefined);
    setNet('');
    setMuted(false);
    setElapsed(0);
  }, []);

  const start = useCallback(async () => {
    const { iceServers } = await api.get('/calls/config');
    const p = await createPeer(iceServers);
    peer.current = p;
    p.pc.addEventListener('connectionstatechange', () => setNet(p.pc.connectionState));
    return p;
  }, []);

  const refresh = useCallback(async () => {
    const live = await api.get<LiveCall[]>('/calls/active').catch(() => null);
    if (!live) return;
    setCalls(live);
    const id = mineRef.current;
    if (!id) return;
    const mine = live.find((c) => c.id === id);
    if (!mine) return cleanup(); // the other side hung up
    if (mine.direction === 'out' && mine.sdp_answer && peer.current?.pc.signalingState === 'have-local-offer') {
      await connect(peer.current, 'answer', mine.sdp_answer);
    }
  }, [cleanup]);

  useEffect(() => { refresh(); return onLive((e) => { if (e.type === 'call') refresh(); }); }, [refresh]);
  useEffect(() => cleanup, [cleanup]);

  const incoming = calls.find((c) => c.direction === 'in' && c.status === 'ringing' && !mineId);
  const incomingId = incoming?.id;
  useEffect(() => { if (incomingId && !hidden) playSound(prefs.sound, 'receive'); }, [incomingId, hidden, prefs.sound]);

  const mine = calls.find((c) => c.id === mineId);
  const answeredAt = mine?.answered_at;
  useEffect(() => {
    if (!answeredAt) return;
    const t = setInterval(() => setElapsed(Math.max(0, Math.round((Date.now() - answeredAt) / 1000))), 1000);
    return () => clearInterval(t);
  }, [answeredAt]);

  useEffect(() => {
    const onDial = async (e: Event) => {
      const conversationId = (e as CustomEvent<number>).detail;
      if (mineRef.current) return toast('Finish your current call first', 'error');
      try {
        const p = await start();
        await p.pc.setLocalDescription(await p.pc.createOffer());
        await finishGathering(p.pc);
        const { id } = await api.post(`/conversations/${conversationId}/calls`, { sdp: p.pc.localDescription!.sdp });
        setMineId(id);
        refresh();
      } catch (err) {
        cleanup();
        if (err instanceof ApiError && err.code === 'call_permission_needed') {
          if (confirm('This customer has not allowed calls yet. Send them a permission request?')) {
            await api.post(`/conversations/${conversationId}/call-permission`).catch((x) => toast(x.message, 'error'));
          }
        } else toast((err as Error).message, 'error');
      }
    };
    addEventListener('tt-dial', onDial);
    return () => removeEventListener('tt-dial', onDial);
  }, [start, cleanup, refresh, toast]);

  const answer = async (c: LiveCall) => {
    try {
      const p = await start();
      await connect(p, 'offer', c.sdp_offer!);
      await p.pc.setLocalDescription(await p.pc.createAnswer());
      await finishGathering(p.pc);
      setMineId(c.id);
      await api.post(`/calls/${c.id}/answer`, { sdp: p.pc.localDescription!.sdp });
      location.hash = `#/inbox/${c.conversation_id}`;
      refresh();
    } catch (err) {
      cleanup();
      toast((err as Error).message, 'error');
    }
  };

  const hangup = async (id: number) => {
    await api.post(`/calls/${id}/hangup`).catch((e) => toast(e.message, 'error'));
    if (id === mineRef.current) cleanup();
    refresh();
  };

  if (hidden) return null;
  if (mineId) {
    const label = net === 'connected' ? `Connected ${clockOf(elapsed)}` : net === 'failed' ? 'No audio: a firewall is blocking the call' : mine?.status === 'ringing' ? 'Ringing…' : 'Connecting…';
    return (
      <aside className="call-dock" aria-label="Current call">
        <div><b>📞 {mine?.contact || 'Call'}</b><br /><small data-testid="call-state" data-net={net}>{label}</small></div>
        <div className="row">
          <button className="btn small" aria-pressed={muted} onClick={() => { peer.current?.setMuted(!muted); setMuted(!muted); }}>{muted ? '🔇 Unmute' : '🎙️ Mute'}</button>
          <button className="btn small end" onClick={() => hangup(mineId)}>Hang up</button>
        </div>
      </aside>
    );
  }
  if (incoming && incoming.sdp_offer) {
    return (
      <aside className="call-dock ringing" role="alertdialog" aria-label="Incoming call">
        <div><b>📞 {incoming.contact || 'A customer'}</b><br /><small>is calling {me.name.split(' ')[0]}'s team</small></div>
        <div className="row">
          <button className="btn small primary" onClick={() => answer(incoming)}>Answer</button>
          <button className="btn small end" onClick={() => hangup(incoming.id)}>Decline</button>
        </div>
      </aside>
    );
  }
  return null;
}
