import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { api, closeLive, onLive } from './lib/api';
import { confetti, playSound } from './lib/fun';
import { applyPrefs, DEFAULT_PREFS, THEMES, type Prefs } from './lib/themes';
import { AppContext, Logo, useApp, useHashRoute, type Me } from './lib/ui';
import { CallDock } from './CallDock';
import { Analytics } from './pages/Analytics';
import { Campaigns } from './pages/Campaigns';
import { Contacts } from './pages/Contacts';
import { Inbox } from './pages/Inbox';
import { Knowledge } from './pages/Knowledge';
import { Leaderboard } from './pages/Leaderboard';
import { Settings } from './pages/Settings';
import { Simulator } from './pages/Simulator';
import { Tools } from './pages/Tools';
import { Vibe } from './pages/Vibe';

// The flow editor is the heaviest page, so it loads only when someone opens Bots.
const Bots = lazy(() => import('./pages/Bots').then((m) => ({ default: m.Bots })));

const NAV = [
  { id: 'inbox', icon: '💬', label: 'Inbox' },
  { id: 'contacts', icon: '👥', label: 'Contacts' },
  { id: 'campaigns', icon: '📣', label: 'Campaigns', lead: true },
  { id: 'bots', icon: '🤖', label: 'Bots', lead: true },
  { id: 'knowledge', icon: '🧠', label: 'AI brain', lead: true },
  { id: 'analytics', icon: '📈', label: 'Analytics', lead: true },
  { id: 'arena', icon: '🏆', label: 'Arena' },
  { id: 'vibe', icon: '🎨', label: 'Vibe Studio' },
  { id: 'simulator', icon: '📱', label: 'Simulator' },
  { id: 'tools', icon: '🧰', label: 'Tools' },
  { id: 'settings', icon: '⚙️', label: 'Settings', lead: true },
];

const storedPrefs = (): Prefs => {
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem('tt_prefs') ?? '{}') };
  } catch {
    return DEFAULT_PREFS;
  }
};

export function App() {
  const [me, setMe] = useState<Me | null | undefined>();
  const [prefs, setPrefsState] = useState<Prefs>(storedPrefs);
  const [toasts, setToasts] = useState<{ id: number; text: string; kind: string }[]>([]);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  useEffect(() => { applyPrefs(prefs); }, [prefs]);

  const loadMe = useCallback(async () => {
    try {
      const u = await api.get<Me>('/me');
      setMe(u);
      setPrefsState((p) => ({ ...p, ...u.prefs }));
    } catch {
      setMe(null);
    }
  }, []);
  useEffect(() => { loadMe(); }, [loadMe]);

  const toast = useCallback((text: string, kind: 'ok' | 'error' = 'ok') => {
    const id = Math.random();
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);

  const setPrefs = useCallback((p: Partial<Prefs>) => {
    setPrefsState((old) => {
      const next = { ...old, ...p };
      try { localStorage.setItem('tt_prefs', JSON.stringify(next)); } catch { /* private mode */ }
      return next;
    });
    api.patch('/me/prefs', p).catch(() => {});
  }, []);

  const signOut = useCallback(async () => {
    await api.post('/auth/logout').catch(() => {});
    closeLive();
    setMe(null);
  }, []);

  useEffect(() => {
    if (!me) return;
    return onLive((e) => {
      if (e.type === 'celebrate') {
        if (e.achievement) { toast(`Achievement unlocked: ${e.achievement.replaceAll('_', ' ')}! 🏅`); confetti(); playSound(prefsRef.current.sound, 'win'); }
        setMe((m) => (m ? { ...m, xp: m.xp + e.xp } : m));
      }
      if (e.type === 'reminder') toast(`⏰ ${e.text}`);
    });
  }, [me?.id, toast]); // eslint-disable-line react-hooks/exhaustive-deps

  const ctx = useMemo(() => (me ? { me, prefs, setPrefs, toast, signOut } : null), [me, prefs, setPrefs, toast, signOut]);

  if (me === undefined) return <div className="boot"><Logo size={64} /></div>;
  if (!me || !ctx) return <Login onDone={loadMe} />;
  return (
    <AppContext.Provider value={ctx}>
      <Shell />
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}
      </div>
    </AppContext.Provider>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [state, setState] = useState<{ needsSetup: boolean; demo: boolean }>();
  const [error, setError] = useState('');
  useEffect(() => { api.get('/auth/state').then(setState); }, []);
  if (!state) return null;
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget));
    try {
      await api.post(state.needsSetup ? '/auth/setup' : '/auth/login', f);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <main className="login">
      <form className="card login-card" onSubmit={submit}>
        <div className="brand"><Logo size={44} /><span>Triple Tick</span></div>
        <p className="muted">{state.needsSetup ? 'Create the first admin account to get started.' : 'Sent. Delivered. Read. And the third tick: replied.'}</p>
        {state.needsSetup && <label>Your name<input name="name" required autoComplete="name" /></label>}
        <label>Email<input name="email" type="email" required autoComplete="username" defaultValue={state.demo ? 'demo@tripletick.local' : ''} /></label>
        <label>Password<input name="password" type="password" required minLength={state.needsSetup ? 8 : 1} autoComplete={state.needsSetup ? 'new-password' : 'current-password'} defaultValue={state.demo ? 'tripletick' : ''} /></label>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="btn primary">{state.needsSetup ? 'Create workspace' : 'Sign in'}</button>
        {state.demo && <p className="muted small">Demo mode: all the data here is made up.</p>}
      </form>
    </main>
  );
}

function Shell() {
  const [page, rest] = useHashRoute();
  const { me, signOut, prefs, setPrefs } = useApp();
  const [palette, setPalette] = useState(false);
  const embed = location.hash.includes('embed=1');
  const isLead = me.role !== 'agent';

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((p) => !p); }
    };
    addEventListener('keydown', on);
    return () => removeEventListener('keydown', on);
  }, []);

  const nav = NAV.filter((n) => (!n.lead || isLead) && (n.id !== 'arena' || me.funMode));
  return (
    <div className={embed ? 'shell embed' : 'shell'}>
      {!embed && (
        <nav className="rail" aria-label="Main">
          <a className="rail-logo" href="#/inbox" aria-label="Triple Tick home"><Logo size={36} /></a>
          {nav.map((n) => (
            <a key={n.id} href={`#/${n.id}`} className={page === n.id ? 'active' : ''} aria-current={page === n.id ? 'page' : undefined}>
              <span aria-hidden>{n.icon}</span><small>{n.label}</small>
            </a>
          ))}
          <div className="rail-foot">
            <button className="btn ghost small" onClick={() => setPalette(true)} title="Command palette (⌘K)">⌘K</button>
            {me.funMode && <span className="xp" title={`${me.xp} XP`}>{me.xp} XP</span>}
            <button className="btn ghost small" onClick={signOut}>Sign out</button>
          </div>
        </nav>
      )}
      <main className="content">
        {page === 'inbox' && <Inbox conversationId={rest[0] ? Number(rest[0]) : undefined} />}
        {page === 'contacts' && <Contacts />}
        {page === 'campaigns' && isLead && <Campaigns />}
        {page === 'bots' && isLead && <Suspense fallback={null}><Bots botId={rest[0] ? Number(rest[0]) : undefined} /></Suspense>}
        {page === 'knowledge' && isLead && <Knowledge />}
        {page === 'analytics' && isLead && <Analytics />}
        {page === 'arena' && <Leaderboard />}
        {page === 'vibe' && <Vibe />}
        {page === 'simulator' && <Simulator />}
        {page === 'tools' && <Tools />}
        {page === 'settings' && isLead && <Settings />}
      </main>
      <CallDock hidden={page === 'simulator'} />
      {palette && <Palette nav={nav} close={() => setPalette(false)} setTheme={(id) => setPrefs({ theme: id, custom: undefined })} current={prefs.theme} />}
    </div>
  );
}

function Palette({ nav, close, setTheme }: { nav: typeof NAV; close: () => void; setTheme: (id: string) => void; current: string }) {
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const items = [
    ...nav.map((n) => ({ label: `Go to ${n.label}`, icon: n.icon, run: () => { location.hash = `#/${n.id}`; } })),
    ...THEMES.map((t) => ({ label: `Theme: ${t.name}`, icon: '🎨', run: () => setTheme(t.id) })),
  ].filter((x) => x.label.toLowerCase().includes(q.toLowerCase()));
  const pick = (n: number) => { items[n]?.run(); close(); };
  return (
    <div className="palette-back" onClick={close}>
      <div className="palette card" role="dialog" aria-label="Command palette" onClick={(e) => e.stopPropagation()}>
        <input
          autoFocus placeholder="Jump anywhere or switch vibes…" aria-label="Search commands" value={q}
          onChange={(e) => { setQ(e.target.value); setI(0); }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') close();
            if (e.key === 'ArrowDown') { e.preventDefault(); setI((v) => Math.min(v + 1, items.length - 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setI((v) => Math.max(v - 1, 0)); }
            if (e.key === 'Enter') pick(i);
          }}
        />
        <ul>{items.slice(0, 9).map((x, n) => (
          <li key={x.label}><button className={n === i ? 'hot' : ''} onClick={() => pick(n)}><span aria-hidden>{x.icon}</span> {x.label}</button></li>
        ))}</ul>
      </div>
    </div>
  );
}
