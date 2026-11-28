/**
 * How a picked colour becomes a row (approval "inbox-tag-colors-picker", NOTES.md). What this catches: a pick whose
 * row makes the row's text (the quiet grey or the body text) fall under 4.5:1 in any state, light or dark, on the
 * default theme; a vivid pick drawn as calm as a muted one (the
 * owner's "they are muted only"); black, white or a grey given a hue; the quick swatches' rows too close to tell
 * apart; an earlier Inbox's colour names drawn differently from the calm colour of their hue.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INBOX_TAG_PRESET_HEX, INBOX_TAG_PRESETS, INBOX_TAG_SWATCHES } from '@plannotator/core/inbox-types';
import { contrastOf, hexToOklch, hsvToHex, hexToHsv, oklchToHex, tintLook, TINT_BANDS, type TintMode } from './tagColourMap';
import { tagColourLong, tagColourName, tintAttrs } from './tagColours';
import { DEFAULT_TINT_THEMES, tintRows } from './tagTintTheme';

const theme = readFileSync(join(import.meta.dir, '../ui/themes/plannotator.css'), 'utf8');
const block = (selector: string) => theme.slice(theme.indexOf(`${selector} {`), theme.indexOf('}', theme.indexOf(`${selector} {`)));
const token = (text: string, name: string): [number, number, number] => {
  const m = new RegExp(`--${name}: oklch\\(([\\d.]+) ([\\d.]+) ([\\d.]+)\\)`).exec(text);
  if (!m) throw new Error(`no ${name}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
};
const THEME = {
  dark: block('.theme-plannotator'),
  light: block('.theme-plannotator.light'),
};
/** The four fills (rest, hover, selected, both) a row of this pick gets on the default theme. */
function fills(hex: string, mode: TintMode): string[] {
  return tintRows(hex, DEFAULT_TINT_THEMES[mode]).fills;
}

test('every pick (hue every 5°, saturation and brightness every 5%) keeps the quiet text and the body text at 4.5:1 in all four states, light and dark', () => {
  for (const mode of ['light', 'dark'] as const) {
    const muted = oklchToHex(...token(THEME[mode], 'muted-foreground'));
    const fg = oklchToHex(...token(THEME[mode], 'foreground'));
    let worst = { r: Infinity, pick: '' };
    for (let h = 0; h < 360; h += 5)
      for (let s = 0; s <= 100; s += 5)
        for (let v = 0; v <= 100; v += 5) {
          const pick = hsvToHex(h, s / 100, v / 100);
          for (const fill of fills(pick, mode)) {
            const r = Math.min(contrastOf(muted, fill), contrastOf(fg, fill));
            if (r < worst.r) worst = { r, pick };
          }
        }
    expect({ mode, worst: worst.pick, ok: worst.r >= 4.5 }).toEqual({ mode, worst: worst.pick, ok: true });
  }
});

test('a table of picks: muted gives a calm row, vivid a deeper and more colored one; black, white and greys a grey row', () => {
  const row = (hex: string, mode: TintMode) => {
    const look = tintLook(hex);
    return { L: Math.round((TINT_BANDS[mode].card + look[mode].delta) * 1000) / 1000, C: look[mode].c, grey: look.grey };
  };
  // NOTES.md's strip: muted, mid, very vivid, near black, near white.
  expect(row('#8698b3', 'light')).toMatchObject({ L: 0.943, grey: false });
  expect(row('#006aff', 'light')).toMatchObject({ L: 0.856 });
  expect(row('#006aff', 'light').C).toBeCloseTo(0.07, 2);
  expect(row('#006aff', 'dark')).toMatchObject({ L: 0.303, C: 0.12 });
  for (const hex of ['#121417', '#f5f6f8', '#000000', '#ffffff', '#808080']) {
    expect(row(hex, 'light').grey).toBe(true);
    expect(row(hex, 'light').C).toBeLessThanOrEqual(0.006);
    expect(row(hex, 'dark').C).toBeLessThanOrEqual(0.006);
  }
  expect(row('#121417', 'light').L).toBe(0.946);
  expect(row('#f5f6f8', 'light').L).toBe(0.97);
  expect(row('#121417', 'dark').L).toBe(0.251);
  expect(row('#f5f6f8', 'dark').L).toBe(0.262);
  // Extremes stay inside the bands.
  for (const hex of ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff', '#7eff73', '#81008c'])
    for (const mode of ['light', 'dark'] as const) {
      const r = row(hex, mode);
      expect(r.L).toBeGreaterThanOrEqual(TINT_BANDS[mode].min);
      expect(r.L).toBeLessThanOrEqual(TINT_BANDS[mode].max);
      expect(r.C).toBeLessThanOrEqual(TINT_BANDS[mode].cap);
    }
  // The same hue, muted and vivid: in light the vivid row is darker and more colored, in dark lighter and more colored.
  for (const hue of [25, 85, 150, 255, 310]) {
    const calm = hsvToHex(hue, 0.3, 0.8);
    const vivid = hsvToHex(hue, 1, 0.8);
    expect(row(vivid, 'light').L).toBeLessThan(row(calm, 'light').L - 0.03);
    expect(row(vivid, 'dark').L).toBeGreaterThan(row(calm, 'dark').L + 0.01);
    for (const mode of ['light', 'dark'] as const) expect(row(vivid, mode).C).toBeGreaterThan(row(calm, mode).C + 0.03);
    // The hue is kept.
    expect(Math.abs(((tintLook(vivid).h - hexToOklch(vivid).h + 540) % 360) - 180)).toBeLessThan(0.1);
  }
});

test('the twelve quick swatches give rows that differ, light and dark', () => {
  const lab = (hex: string) => {
    const { l, c, h } = hexToOklch(hex);
    return [l, c * Math.cos((h * Math.PI) / 180), c * Math.sin((h * Math.PI) / 180)];
  };
  for (const mode of ['light', 'dark'] as const) {
    const rows = INBOX_TAG_SWATCHES.map((sw) => lab(fills(sw.hex, mode)[0]!));
    let closest = Infinity;
    for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) closest = Math.min(closest, 100 * Math.hypot(...rows[i]!.map((v, k) => v - rows[j]![k]!)));
    expect({ mode, ok: closest >= 2.5 }).toEqual({ mode, ok: true });
  }
});

test('the five stored names still draw: each as the calm colour of its hue, accent as Indigo, named as that hue', () => {
  expect([...INBOX_TAG_PRESETS]).toEqual(['accent', 'green', 'amber', 'red', 'grey']);
  for (const name of INBOX_TAG_PRESETS) {
    const attrs = tintAttrs(name);
    expect(attrs['data-tint']).toBe(name);
    // Calm: a mid-strength row, never one of the vivid swatches.
    expect(hexToOklch(INBOX_TAG_PRESET_HEX[name]).c).toBeLessThanOrEqual(0.105);
  }
  expect(INBOX_TAG_PRESET_HEX.accent).toBe(INBOX_TAG_SWATCHES.find((s) => s.name === 'Indigo')!.hex);
  expect(INBOX_TAG_PRESETS.map(tagColourName)).toEqual(['Indigo', 'Green', 'Amber', 'Red', 'Grey']);
  expect(tagColourLong('#0b9488')).toBe('Teal');
  expect(tagColourLong('#3a7bd5')).toBe('Custom #3a7bd5');
});

test('the square’s HSV reads back the colour it wrote', () => {
  for (const hex of ['#0b9488', '#ff6a00', '#121417', '#ffffff']) {
    const { h, s, v } = hexToHsv(hex);
    expect(hsvToHex(h, s, v)).toBe(hex);
  }
});
