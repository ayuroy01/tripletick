let audio: AudioContext | undefined;

function tone(freq: number, at: number, length: number, type: OscillatorType = 'sine', volume = 0.08) {
  audio ??= new AudioContext();
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  const start = audio.currentTime + at;
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(volume, start);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
  osc.connect(gain).connect(audio.destination);
  osc.start(start);
  osc.stop(start + length);
}

const PACKS: Record<string, Record<string, [number, number, number, OscillatorType?][]>> = {
  pop: { send: [[520, 0, 0.09]], receive: [[660, 0, 0.08], [880, 0.08, 0.1]], win: [[523, 0, 0.1], [659, 0.1, 0.1], [784, 0.2, 0.18]] },
  arcade: { send: [[440, 0, 0.06, 'square'], [660, 0.05, 0.06, 'square']], receive: [[880, 0, 0.06, 'square'], [660, 0.06, 0.06, 'square']], win: [[523, 0, 0.08, 'square'], [659, 0.08, 0.08, 'square'], [784, 0.16, 0.08, 'square'], [1046, 0.24, 0.2, 'square']] },
  marimba: { send: [[392, 0, 0.14, 'triangle']], receive: [[587, 0, 0.14, 'triangle'], [784, 0.1, 0.18, 'triangle']], win: [[392, 0, 0.14, 'triangle'], [494, 0.12, 0.14, 'triangle'], [587, 0.24, 0.24, 'triangle']] },
};
export const SOUND_PACKS = ['off', ...Object.keys(PACKS)];

export function playSound(pack: string, name: 'send' | 'receive' | 'win') {
  try {
    for (const [f, at, len, type] of PACKS[pack]?.[name] ?? []) tone(f, at, len, type);
  } catch {
    // Browsers block audio until the first click. Missing a sound is harmless.
  }
}

/** Canvas confetti with no dependency. Skipped when the viewer prefers reduced motion. */
export function confetti() {
  if (document.documentElement.dataset.motion === 'off' || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:999';
  canvas.width = innerWidth;
  canvas.height = innerHeight;
  document.body.append(canvas);
  const ctx = canvas.getContext('2d')!;
  const style = getComputedStyle(document.documentElement);
  const colors = ['--accent', '--tick', '--bubble-out'].map((v) => style.getPropertyValue(v).trim());
  const bits = Array.from({ length: 110 }, () => ({
    x: innerWidth / 2, y: innerHeight * 0.55, vx: (Math.random() - 0.5) * 16, vy: -Math.random() * 15 - 5,
    r: Math.random() * 6, spin: Math.random() * 6, c: colors[Math.floor(Math.random() * 3)],
  }));
  const started = performance.now();
  const frame = (t: number) => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const b of bits) {
      b.vy += 0.4; b.x += b.vx; b.y += b.vy; b.spin += 0.2;
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(b.spin);
      ctx.fillStyle = b.c;
      ctx.fillRect(-3, -5, 6 + b.r, 8);
      ctx.restore();
    }
    if (t - started < 1800) requestAnimationFrame(frame);
    else canvas.remove();
  };
  requestAnimationFrame(frame);
}
