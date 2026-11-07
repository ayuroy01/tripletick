import { useState } from 'react';
import { playSound, SOUND_PACKS, confetti } from '../lib/fun';
import { TEXT_STYLES } from '../lib/textStyles';
import { BUBBLES, contrast, decodeTheme, encodeTheme, FONTS, THEMES, WALLPAPERS } from '../lib/themes';
import { PageHead, Ticks, useApp } from '../lib/ui';

const COLOURS = [['accent', 'Accent'], ['accentText', 'Text on accent'], ['bg', 'Background'], ['surface', 'Panels'], ['bubbleOut', 'Your bubbles'], ['bubbleOutText', 'Your bubble text'], ['tick', 'Third tick']] as const;

export function Vibe() {
  const { prefs, setPrefs, toast } = useApp();
  const [code, setCode] = useState('');
  const [sample, setSample] = useState('Your order is on the way');
  const base = THEMES.find((t) => t.id === prefs.theme) ?? THEMES[0];
  const value = (k: (typeof COLOURS)[number][0]) => prefs.custom?.[k] ?? base[k];
  const low = contrast(value('accentText'), value('accent')) < 4.5 || contrast(value('bubbleOutText'), value('bubbleOut')) < 4.5;

  return (
    <div className="page">
      <PageHead title="Vibe Studio" sub="Make it yours. Everyone on the team gets their own look." />
      <section>
        <h2>Themes</h2>
        <div className="theme-grid" style={{ marginTop: '.6em' }}>
          {THEMES.map((t) => (
            <button
              key={t.id} className={`theme-card ${prefs.theme === t.id ? 'on' : ''}`} aria-pressed={prefs.theme === t.id}
              style={{ background: t.bg, color: t.text, border: `${t.borderWidth} solid ${t.border}`, borderRadius: t.radius, fontFamily: t.font, boxShadow: prefs.theme === t.id ? undefined : t.shadow }}
              onClick={() => setPrefs({ theme: t.id, custom: undefined })}
            >
              <b style={{ fontFamily: t.display }}>{t.name}</b>
              <small>{t.tagline}</small>
              <span className="mini">
                <span style={{ background: t.bubbleIn, color: t.bubbleInText, borderRadius: t.radius }}>Hey!</span>
                <span style={{ background: t.bubbleOut, color: t.bubbleOutText, borderRadius: t.radius }}>Hi there ✓✓✓</span>
              </span>
            </button>
          ))}
        </div>
      </section>

      <div className="grid-2">
        <section className="card form">
          <h3>Look and feel</h3>
          <label>Font<select value={prefs.font} onChange={(e) => setPrefs({ font: e.target.value })}>{FONTS.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label>
          <label>Text size: {prefs.textSize}px<input type="range" min={13} max={20} value={prefs.textSize} onChange={(e) => setPrefs({ textSize: Number(e.target.value) })} /></label>
          <label>Bubble shape<select value={prefs.bubble} onChange={(e) => setPrefs({ bubble: e.target.value })}>{BUBBLES.map((b) => <option key={b}>{b}</option>)}</select></label>
          <label>Chat wallpaper<select value={prefs.wallpaper} onChange={(e) => setPrefs({ wallpaper: e.target.value })}>{WALLPAPERS.map((w) => <option key={w}>{w}</option>)}</select></label>
          <label>Sound pack<select value={prefs.sound} onChange={(e) => { setPrefs({ sound: e.target.value }); playSound(e.target.value, 'win'); }}>{SOUND_PACKS.map((s) => <option key={s}>{s}</option>)}</select></label>
          <label className="row"><input type="checkbox" checked={prefs.motion} style={{ width: 'auto' }} onChange={(e) => setPrefs({ motion: e.target.checked })} /> Animations and confetti</label>
          <button type="button" className="btn small" onClick={confetti}>Test confetti 🎉</button>
        </section>
        <section className="card">
          <h3>Preview</h3>
          <div className="preview messages">
            <div className="bubble in"><div className="body">Is my order ready?</div></div>
            <div className="bubble out"><div className="body">{sample}</div><div className="stamp"><time>10:24</time><Ticks status="read" /></div></div>
            <div className="bubble in"><div className="body">Yay, thank you!</div></div>
            <div className="bubble out"><div className="body">Anytime! 💛</div><div className="stamp"><time>10:25</time><Ticks status="acted" /></div></div>
          </div>
        </section>
      </div>

      <section className="card form">
        <h3>Build your own theme</h3>
        <div className="swatches">
          {COLOURS.map(([k, label]) => (
            <label key={k}>{label}<input type="color" value={value(k)} onChange={(e) => setPrefs({ custom: { ...prefs.custom, [k]: e.target.value } })} /></label>
          ))}
        </div>
        {low && <p className="error">Some text is hard to read with these colours. Try more contrast.</p>}
        <div className="row">
          <button className="btn small" onClick={() => setPrefs({ custom: undefined })}>Reset colours</button>
          <button className="btn small" onClick={() => { navigator.clipboard.writeText(encodeTheme(prefs)); toast('Theme code copied'); }}>Copy share code</button>
          <input className="grow" style={{ width: 180 }} placeholder="Paste a theme code" aria-label="Theme code" value={code} onChange={(e) => setCode(e.target.value)} />
          <button className="btn small" onClick={() => {
            const t = decodeTheme(code);
            if (!t) return toast("That code doesn't look right", 'error');
            setPrefs(Object.fromEntries(Object.entries(t).filter(([, v]) => v !== undefined)));
            setCode('');
          }}>Apply</button>
        </div>
      </section>

      <section className="card form">
        <h3>Text styles</h3>
        <p className="muted small">These travel with the message and reach the customer styled. Find them under Style in the composer.</p>
        <label>Try it<input value={sample} onChange={(e) => setSample(e.target.value)} /></label>
        <div className="style-grid" style={{ maxHeight: 'none' }}>
          {TEXT_STYLES.map((s) => <span key={s.id} title={s.label}>{s.apply(sample.slice(0, 20))}</span>)}
        </div>
      </section>
    </div>
  );
}
