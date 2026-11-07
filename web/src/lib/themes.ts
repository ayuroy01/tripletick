export interface Theme {
  id: string; name: string; tagline: string; dark: boolean;
  bg: string; surface: string; surface2: string; text: string; muted: string; border: string;
  accent: string; accentText: string; bubbleIn: string; bubbleInText: string; bubbleOut: string; bubbleOutText: string;
  tick: string; danger: string; radius: string; borderWidth: string; shadow: string; font: string; display: string;
}

const SANS = "'Inter', system-ui, sans-serif";
const GROTESK = "'Space Grotesk', system-ui, sans-serif";
const ROUND = "'Fredoka', system-ui, sans-serif";
const MONO = "'JetBrains Mono', ui-monospace, monospace";
const SERIF = "'Fraunces', Georgia, serif";

export const THEMES: Theme[] = [
  { id: 'grape', name: 'Grape Soda', tagline: 'The house flavour', dark: false, bg: '#f4f0ff', surface: '#ffffff', surface2: '#ece5ff', text: '#1f1537', muted: '#5f5478', border: '#d9cffa',
    accent: '#6d28d9', accentText: '#ffffff', bubbleIn: '#ffffff', bubbleInText: '#1f1537', bubbleOut: '#6d28d9', bubbleOutText: '#ffffff', tick: '#fde047', danger: '#c81e4a',
    radius: '16px', borderWidth: '1px', shadow: '0 2px 10px rgb(76 29 149 / .1)', font: GROTESK, display: ROUND },
  { id: 'arcade', name: 'Neon Arcade', tagline: 'Insert coin to reply', dark: true, bg: '#0b0720', surface: '#150e33', surface2: '#21174b', text: '#f3edff', muted: '#b1a4d8', border: '#3f2f7d',
    accent: '#ff2e93', accentText: '#10061f', bubbleIn: '#21174b', bubbleInText: '#f3edff', bubbleOut: '#14e0d3', bubbleOutText: '#04211f', tick: '#7a0a4a', danger: '#ff7a90',
    radius: '6px', borderWidth: '2px', shadow: '0 0 18px rgb(255 46 147 / .28)', font: GROTESK, display: "'Press Start 2P', monospace" },
  { id: 'bubblegum', name: 'Bubblegum Pop', tagline: 'Chew on this', dark: false, bg: '#ffe6f2', surface: '#fff8fc', surface2: '#ffd5e8', text: '#4a0d2e', muted: '#83395f', border: '#ffb3d4',
    accent: '#c81e7e', accentText: '#ffffff', bubbleIn: '#ffffff', bubbleInText: '#4a0d2e', bubbleOut: '#c81e7e', bubbleOutText: '#ffffff', tick: '#fff176', danger: '#b3122e',
    radius: '24px', borderWidth: '2px', shadow: '0 4px 0 #ffb3d4', font: ROUND, display: ROUND },
  { id: 'terminal', name: 'Terminal', tagline: '$ sudo reply --fast', dark: true, bg: '#050a05', surface: '#0a130a', surface2: '#112011', text: '#b6ffb6', muted: '#7fcf7f', border: '#245024',
    accent: '#39ff14', accentText: '#031003', bubbleIn: '#112011', bubbleInText: '#b6ffb6', bubbleOut: '#1d3d1d', bubbleOutText: '#d6ffd6', tick: '#f8ff3c', danger: '#ff8a7a',
    radius: '0px', borderWidth: '1px', shadow: 'none', font: MONO, display: MONO },
  { id: 'paper', name: 'Paper & Ink', tagline: 'Letters, but fast', dark: false, bg: '#f6efe0', surface: '#fffaf0', surface2: '#efe5cf', text: '#2b2118', muted: '#655543', border: '#d8c9ab',
    accent: '#8c2f1b', accentText: '#fffaf0', bubbleIn: '#fffaf0', bubbleInText: '#2b2118', bubbleOut: '#2b2118', bubbleOutText: '#f6efe0', tick: '#f2b84b', danger: '#a11d1d',
    radius: '4px', borderWidth: '1px', shadow: '0 1px 2px rgb(43 33 24 / .14)', font: SERIF, display: SERIF },
  { id: 'vapor', name: 'Vaporwave', tagline: 'ａｅｓｔｈｅｔｉｃ', dark: true, bg: '#1b0b3a', surface: '#2a1458', surface2: '#3b1f75', text: '#ffeafd', muted: '#d9b8e8', border: '#6a3cb0',
    accent: '#ff71ce', accentText: '#26063d', bubbleIn: '#3b1f75', bubbleInText: '#ffeafd', bubbleOut: '#01cdfe', bubbleOutText: '#04222e', tick: '#7a0f6e', danger: '#ff9db0',
    radius: '12px', borderWidth: '1px', shadow: '0 6px 22px rgb(1 205 254 / .18)', font: GROTESK, display: GROTESK },
  { id: 'banana', name: 'Brutal Banana', tagline: 'Loud on purpose', dark: false, bg: '#ffe135', surface: '#fffbe0', surface2: '#fff2a0', text: '#000000', muted: '#3d3a1f', border: '#000000',
    accent: '#000000', accentText: '#ffe135', bubbleIn: '#ffffff', bubbleInText: '#000000', bubbleOut: '#000000', bubbleOutText: '#ffe135', tick: '#ff5ca8', danger: '#a80000',
    radius: '0px', borderWidth: '3px', shadow: '5px 5px 0 #000', font: GROTESK, display: GROTESK },
  { id: 'comic', name: 'Comic Book', tagline: 'KA-POW! Replied!', dark: false, bg: '#fdf3d1', surface: '#ffffff', surface2: '#ffe9a8', text: '#111111', muted: '#4b4536', border: '#111111',
    accent: '#c81414', accentText: '#ffffff', bubbleIn: '#ffffff', bubbleInText: '#111111', bubbleOut: '#0b4fb3', bubbleOutText: '#ffffff', tick: '#ffe14d', danger: '#a30f0f',
    radius: '14px', borderWidth: '3px', shadow: '4px 4px 0 #111', font: ROUND, display: "'Bangers', cursive" },
  { id: 'midnight', name: 'Midnight', tagline: 'Calm. Dark. Focused.', dark: true, bg: '#0f1420', surface: '#171e2e', surface2: '#212a3e', text: '#e6ebf5', muted: '#a3aec4', border: '#2f3a52',
    accent: '#7aa2ff', accentText: '#0b1020', bubbleIn: '#212a3e', bubbleInText: '#e6ebf5', bubbleOut: '#2f4d91', bubbleOutText: '#f2f6ff', tick: '#ffd166', danger: '#ff8f8f',
    radius: '10px', borderWidth: '1px', shadow: 'none', font: SANS, display: SANS },
  { id: 'clarity', name: 'High Contrast', tagline: 'Maximum legibility', dark: false, bg: '#ffffff', surface: '#ffffff', surface2: '#f0f0f0', text: '#000000', muted: '#333333', border: '#000000',
    accent: '#0000c8', accentText: '#ffffff', bubbleIn: '#ffffff', bubbleInText: '#000000', bubbleOut: '#000000', bubbleOutText: '#ffffff', tick: '#ffff00', danger: '#b00000',
    radius: '6px', borderWidth: '2px', shadow: 'none', font: "'Atkinson Hyperlegible', system-ui, sans-serif", display: "'Atkinson Hyperlegible', system-ui, sans-serif" },
];

export const FONTS = [
  { id: 'theme', name: 'Theme default', css: '' },
  { id: 'inter', name: 'Inter', css: SANS },
  { id: 'grotesk', name: 'Space Grotesk', css: GROTESK },
  { id: 'fredoka', name: 'Fredoka', css: ROUND },
  { id: 'fraunces', name: 'Fraunces', css: SERIF },
  { id: 'mono', name: 'JetBrains Mono', css: MONO },
  { id: 'caveat', name: 'Caveat (handwritten)', css: "'Caveat', cursive" },
  { id: 'atkinson', name: 'Atkinson Hyperlegible', css: "'Atkinson Hyperlegible', system-ui, sans-serif" },
];

export const WALLPAPERS = ['none', 'dots', 'grid', 'stripes', 'waves', 'confetti'] as const;
export const BUBBLES = ['classic', 'pill', 'square', 'speech'] as const;

export interface Prefs {
  theme: string; font: string; textSize: number; bubble: string; wallpaper: string; sound: string; motion: boolean;
  custom?: Partial<Pick<Theme, 'accent' | 'accentText' | 'bg' | 'surface' | 'bubbleOut' | 'bubbleOutText' | 'tick'>>;
}

export const DEFAULT_PREFS: Prefs = { theme: 'grape', font: 'theme', textSize: 15, bubble: 'classic', wallpaper: 'dots', sound: 'pop', motion: true };

const kebab = (k: string) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

export function applyPrefs(p: Prefs) {
  const base = THEMES.find((t) => t.id === p.theme) ?? THEMES[0];
  const t: Theme = { ...base, ...p.custom };
  const root = document.documentElement;
  for (const [k, v] of Object.entries(t)) {
    if (typeof v === 'string' && !['id', 'name', 'tagline'].includes(k)) root.style.setProperty(`--${kebab(k)}`, v);
  }
  const font = FONTS.find((f) => f.id === p.font)?.css;
  if (font) root.style.setProperty('--font', font);
  root.style.setProperty('--text-size', `${p.textSize}px`);
  root.style.colorScheme = t.dark ? 'dark' : 'light';
  root.dataset.bubble = p.bubble;
  root.dataset.wallpaper = p.wallpaper;
  root.dataset.motion = p.motion ? 'on' : 'off';
  root.dataset.theme = t.id;
}

/** WCAG contrast ratio between two #rrggbb colours. */
export function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const n = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * n[0] + 0.7152 * n[1] + 0.0722 * n[2];
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Share codes let people trade custom themes as a short string. */
export const encodeTheme = (p: Prefs) => btoa(unescape(encodeURIComponent(JSON.stringify({ theme: p.theme, custom: p.custom, font: p.font, bubble: p.bubble, wallpaper: p.wallpaper }))));

export function decodeTheme(code: string): Partial<Prefs> | null {
  try {
    const raw = JSON.parse(decodeURIComponent(escape(atob(code.trim()))));
    const hex = /^#[0-9a-f]{6}$/i;
    const custom = Object.fromEntries(Object.entries(raw.custom ?? {}).filter(([, v]) => typeof v === 'string' && hex.test(v)));
    return {
      theme: THEMES.some((t) => t.id === raw.theme) ? raw.theme : undefined,
      font: FONTS.some((f) => f.id === raw.font) ? raw.font : undefined,
      bubble: (BUBBLES as readonly string[]).includes(raw.bubble) ? raw.bubble : undefined,
      wallpaper: (WALLPAPERS as readonly string[]).includes(raw.wallpaper) ? raw.wallpaper : undefined,
      custom,
    };
  } catch {
    return null;
  }
}
