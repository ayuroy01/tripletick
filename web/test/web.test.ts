import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TEXT_STYLES, styleById } from '../src/lib/textStyles.ts';
import { contrast, decodeTheme, DEFAULT_PREFS, encodeTheme, THEMES } from '../src/lib/themes.ts';

describe('text styles', () => {
  it('every style keeps text non-empty and leaves emoji and accents intact', () => {
    for (const s of TEXT_STYLES) {
      assert.ok(s.apply('Hello 123').length > 0, s.id);
      assert.ok(s.apply('hi 👟').includes('👟'), s.id);
      assert.ok(s.apply('café').length >= 4, s.id);
    }
  });

  it('maps letters to the right code points', () => {
    assert.equal(styleById('bold')!.apply('Ab1'), '𝗔𝗯𝟭');
    assert.equal(styleById('double')!.apply('CH'), 'ℂℍ');
    assert.equal(styleById('bubble')!.apply('a'), 'ⓐ');
    assert.equal(styleById('vapor')!.apply('a b'), 'ａ　ｂ');
    assert.equal(styleById('flip')!.apply('ab'), 'qɐ');
  });
});

describe('themes', () => {
  it('has unique ids', () => assert.equal(new Set(THEMES.map((t) => t.id)).size, THEMES.length));

  for (const t of THEMES) {
    it(`${t.name} meets WCAG AA contrast`, () => {
      const pairs: [string, string, string][] = [
        ['text on bg', t.text, t.bg], ['text on surface', t.text, t.surface], ['text on surface2', t.text, t.surface2],
        ['muted on surface', t.muted, t.surface], ['muted on bg', t.muted, t.bg], ['accent button', t.accentText, t.accent],
        ['incoming bubble', t.bubbleInText, t.bubbleIn], ['outgoing bubble', t.bubbleOutText, t.bubbleOut],
      ];
      for (const [name, a, b] of pairs) assert.ok(contrast(a, b) >= 4.5, `${name}: ${contrast(a, b).toFixed(2)}`);
      assert.ok(contrast(t.tick, t.bubbleOut) >= 3, `third tick: ${contrast(t.tick, t.bubbleOut).toFixed(2)}`);
    });
  }

  it('round-trips a share code and drops unsafe values', () => {
    const code = encodeTheme({ ...DEFAULT_PREFS, theme: 'arcade', custom: { accent: '#123456' } });
    const back = decodeTheme(code)!;
    assert.equal(back.theme, 'arcade');
    assert.equal(back.custom?.accent, '#123456');
    const evil = btoa(JSON.stringify({ theme: 'nope', custom: { accent: 'red;background:url(x)' } }));
    const safe = decodeTheme(evil)!;
    assert.equal(safe.theme, undefined);
    assert.deepEqual(safe.custom, {});
    assert.equal(decodeTheme('%%%'), null);
  });
});
