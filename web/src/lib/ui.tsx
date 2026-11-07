import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { onLive } from './api';
import type { Prefs } from './themes';

export interface Me { id: number; name: string; email: string; role: 'admin' | 'manager' | 'agent'; xp: number; streak: number; workspace: string; funMode: boolean; aiMode: string; prefs: Partial<Prefs> }

export const AppContext = createContext<{
  me: Me; prefs: Prefs; setPrefs: (p: Partial<Prefs>) => void; toast: (text: string, kind?: 'ok' | 'error') => void; signOut: () => void;
}>(null as never);
export const useApp = () => useContext(AppContext);

/** Loads data and refreshes it when a matching live event arrives. */
export function useData<T>(load: () => Promise<T>, deps: unknown[] = [], liveTypes: string[] = []) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const latest = useRef(load);
  latest.current = load;
  const seq = useRef(0);
  const refresh = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const d = await latest.current();
      if (mine === seq.current) { setData(d); setError(undefined); }
    } catch (e) {
      if (mine === seq.current) setError((e as Error).message);
    }
  }, []);
  useEffect(() => { refresh(); }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!liveTypes.length) return;
    return onLive((e) => { if (liveTypes.includes(e.type)) refresh(); });
  }, [liveTypes.join()]); // eslint-disable-line react-hooks/exhaustive-deps
  return { data, error, refresh, setData };
}

export function useHashRoute(): [string, string[]] {
  const [hash, setHash] = useState(location.hash.slice(2));
  useEffect(() => {
    const on = () => setHash(location.hash.slice(2));
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  const [path] = hash.split('?');
  const parts = path.split('/').filter(Boolean);
  return [parts[0] ?? 'inbox', parts.slice(1)];
}

/** Three stacked ticks. The third lights up when the customer actually reacts. */
export function Ticks({ status }: { status: string }) {
  if (status === 'failed') return <span className="ticks failed" title="Failed to send" role="img" aria-label="Failed to send">!</span>;
  if (status === 'queued') return <span className="ticks" title="Sending" role="img" aria-label="Sending">…</span>;
  const n = status === 'sent' ? 1 : status === 'delivered' || status === 'read' ? 2 : 3;
  const label = { sent: 'Sent', delivered: 'Delivered', read: 'Read', acted: 'Replied: the third tick' }[status] ?? status;
  return (
    <svg className={`ticks s-${status}`} viewBox="0 0 44 14" width="33" height="11" role="img" aria-label={label}>
      <title>{label}</title>
      {Array.from({ length: n }, (_, i) => (
        <path key={i} className={i === 2 ? 'third' : ''} d={`M${1 + i * 12} 7.5l3.5 4 7-9`} fill="none" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      ))}
    </svg>
  );
}

export const Logo = ({ size = 28 }: { size?: number }) => <img src="/icon.svg" width={size} height={size} alt="" />;

export function Empty({ emoji, title, children }: { emoji: string; title: string; children?: ReactNode }) {
  return <div className="empty"><div className="empty-emoji" aria-hidden>{emoji}</div><h3>{title}</h3>{children && <p>{children}</p>}</div>;
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return (
    <dialog ref={ref} className={wide ? 'modal wide' : 'modal'} onClose={onClose} onClick={(e) => { if (e.target === ref.current) onClose(); }}>
      <header><h2>{title}</h2><button className="btn ghost icon" aria-label="Close" onClick={onClose}>✕</button></header>
      {children}
    </dialog>
  );
}

export const PageHead = ({ title, sub, children }: { title: string; sub?: string; children?: ReactNode }) => (
  <header className="page-head"><div><h1>{title}</h1>{sub && <p>{sub}</p>}</div><div className="row">{children}</div></header>
);

export const timeAgo = (t: number | null | undefined) => {
  if (!t) return '';
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};

export const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export const duration = (ms: number | null | undefined) => {
  if (!ms) return '–';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
};

export const money = (n: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(n);

export const MOODS: Record<string, string> = { happy: '😄', upset: '😠', neutral: '😐' };

/** WhatsApp's own markup. Built from React nodes, so customer text can't inject HTML. */
export function Rich({ text }: { text: string }) {
  const out: ReactNode[] = [];
  const re = /```([\s\S]+?)```|\*([^*\n]+)\*|_([^_\n]+)_|~([^~\n]+)~|(https?:\/\/[^\s]+)/g;
  let last = 0, m: RegExpExecArray | null, i = 0;
  while ((m = re.exec(text))) {
    out.push(text.slice(last, m.index));
    const k = i++;
    if (m[1]) out.push(<code key={k}>{m[1]}</code>);
    else if (m[2]) out.push(<strong key={k}>{m[2]}</strong>);
    else if (m[3]) out.push(<em key={k}>{m[3]}</em>);
    else if (m[4]) out.push(<s key={k}>{m[4]}</s>);
    else out.push(<a key={k} href={m[5]} target="_blank" rel="noreferrer noopener">{m[5]}</a>);
    last = re.lastIndex;
  }
  out.push(text.slice(last));
  return <>{out}</>;
}
