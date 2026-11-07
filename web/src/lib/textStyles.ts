/**
 * Message text styles. These swap letters for Unicode look-alikes, so the style
 * survives the trip to the customer's phone, unlike app-only fonts.
 */
export interface TextStyle { id: string; label: string; apply: (s: string) => string }

const A = 65, a = 97, ZERO = 48;

/** Maps A-Z, a-z and optionally 0-9 onto a contiguous Unicode block. */
function block(upper: number, lower: number, digits?: number, exceptions: Record<string, string> = {}) {
  return (s: string) =>
    [...s].map((ch) => {
      if (exceptions[ch]) return exceptions[ch];
      const c = ch.codePointAt(0)!;
      if (c >= A && c <= A + 25) return String.fromCodePoint(upper + c - A);
      if (c >= a && c <= a + 25) return String.fromCodePoint(lower + c - a);
      if (digits !== undefined && c >= ZERO && c <= ZERO + 9) return String.fromCodePoint(digits + c - ZERO);
      return ch;
    }).join('');
}

const lookup = (from: string, to: string) => {
  const src = [...from], dst = [...to];
  const map = new Map(src.map((c, i) => [c, dst[i]]));
  return (s: string) => [...s].map((c) => map.get(c) ?? c).join('');
};

const ABC = 'abcdefghijklmnopqrstuvwxyz';
const smallCaps = lookup(ABC, 'ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘǫʀsᴛᴜᴠᴡxʏᴢ');
const flip = lookup(`${ABC}.,!?'`, 'ɐqɔpǝɟƃɥᴉɾʞlɯuodbɹsʇnʌʍxʎz˙\'¡¿,');

const overlay = (mark: string) => (s: string) => [...s].map((c) => (c === ' ' ? c : c + mark)).join('');

export const TEXT_STYLES: TextStyle[] = [
  { id: 'bold', label: 'Bold', apply: block(0x1d5d4, 0x1d5ee, 0x1d7ec) },
  { id: 'italic', label: 'Italic', apply: block(0x1d608, 0x1d622) },
  { id: 'serif', label: 'Serif bold', apply: block(0x1d400, 0x1d41a, 0x1d7ce) },
  { id: 'script', label: 'Script', apply: block(0x1d4d0, 0x1d4ea) },
  { id: 'gothic', label: 'Gothic', apply: block(0x1d56c, 0x1d586) },
  { id: 'double', label: 'Double', apply: block(0x1d538, 0x1d552, 0x1d7d8, { C: 'ℂ', H: 'ℍ', N: 'ℕ', P: 'ℙ', Q: 'ℚ', R: 'ℝ', Z: 'ℤ' }) },
  { id: 'mono', label: 'Typewriter', apply: block(0x1d670, 0x1d68a, 0x1d7f6) },
  { id: 'bubble', label: 'Bubbles', apply: block(0x24b6, 0x24d0) },
  { id: 'square', label: 'Squares', apply: block(0x1f130, 0x1f130) },
  { id: 'vapor', label: 'Vaporwave', apply: (s) => [...s].map((c) => {
    const n = c.codePointAt(0)!;
    return c === ' ' ? '　' : n > 32 && n < 127 ? String.fromCodePoint(n + 0xfee0) : c;
  }).join('') },
  { id: 'smallcaps', label: 'Small caps', apply: (s) => smallCaps(s.toLowerCase()) },
  { id: 'flip', label: 'Upside down', apply: (s) => [...flip(s.toLowerCase())].reverse().join('') },
  { id: 'strike', label: 'Strikeout', apply: overlay('̶') },
  { id: 'under', label: 'Underline', apply: overlay('̲') },
  { id: 'spongy', label: 'sPoNgY', apply: (s) => [...s].map((c, i) => (i % 2 ? c.toUpperCase() : c.toLowerCase())).join('') },
  { id: 'sparkle', label: 'Sparkle', apply: (s) => `✨ ${s} ✨` },
];

export const styleById = (id: string) => TEXT_STYLES.find((t) => t.id === id);
