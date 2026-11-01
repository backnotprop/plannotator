/**
 * The art backgrounds' restraint, checked without a canvas (bun has no
 * OffscreenCanvas; the drawing itself is proved in a browser):
 *
 * - The quiet mask is exactly zero over every keep rectangle and its theme's
 *   pad, for every theme, after the blur: no art pixel under a word or a
 *   control, however the blur spreads the rest.
 * - A step's dirty boxes cover everything that moved and stay inside the
 *   layer, so a mover's last position is always cleared.
 * - A stored value the vocabulary does not know reads as None, so a cookie
 *   from a later version never draws something unchosen.
 */
import { describe, expect, test } from 'bun:test';
import { mergeBoxes } from './boxes';
import { buildMask, MASK_CELL } from './mask';
import { THEMES } from './themes';
import { ART_THEME_IDS, parseArtCity, parseArtTheme } from './vocabulary';

const W = 1200;
const H = 800;
const KEEPS = [
  { x: 40, y: 30, w: 500, h: 22 },
  { x: 40, y: 70, w: 1100, h: 64 },
  { x: 700, y: 400, w: 120, h: 32 },
];

describe('the quiet mask', () => {
  for (const theme of Object.values(THEMES)) {
    test(`${theme.id}: zero over every keep and its pad, open away from them`, () => {
      const mask = buildMask(W, H, KEEPS, theme.pad, theme.ramp, theme.shape);
      for (let gy = 0; gy < mask.gh; gy++) {
        for (let gx = 0; gx < mask.gw; gx++) {
          const x = gx * MASK_CELL;
          const y = gy * MASK_CELL;
          // Within the pad of a keep: its distance from the rectangle, not its bounding box.
          const near = KEEPS.some((r) => Math.hypot(Math.max(r.x - x, 0, x - (r.x + r.w)), Math.max(r.y - y, 0, y - (r.y + r.h))) <= theme.pad);
          const v = mask.grid[gy * mask.gw + gx]!;
          if (near) expect(v).toBe(0);
          // The blur's running sums leave float dust below zero; the plate clamps it.
          expect(v).toBeGreaterThanOrEqual(-1e-9);
          expect(v).toBeLessThanOrEqual(1);
        }
      }
      // Something is drawable on an empty stretch of the ground.
      expect(Math.max(...mask.grid)).toBeGreaterThan(0);
    });
  }
});

describe('dirty boxes', () => {
  test('cover every moved box and stay inside the layer', () => {
    const LW = 300;
    const LH = 170;
    const moved = [
      { x: 3, y: 5, w: 10, h: 10 },
      { x: 290, y: 160, w: 30, h: 30 },
      { x: 100, y: 64, w: 1, h: 1 },
    ];
    const out = mergeBoxes(moved, LW, LH);
    for (const b of out) {
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.x + b.w).toBeLessThanOrEqual(LW);
      expect(b.y + b.h).toBeLessThanOrEqual(LH);
    }
    for (const m of moved) {
      // Every layer pixel of the moved box that is inside the layer is inside some merged box.
      for (let y = m.y; y < Math.min(LH, m.y + m.h); y++) {
        for (let x = m.x; x < Math.min(LW, m.x + m.w); x++) {
          expect(out.some((b) => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h)).toBe(true);
        }
      }
    }
    expect(mergeBoxes([], LW, LH)).toEqual([]);
  });
});

describe('the stored choice', () => {
  test('an unknown or absent value is None and Harbour', () => {
    expect(parseArtTheme('aurora')).toBe('none');
    expect(parseArtTheme(undefined)).toBe('none');
    expect(parseArtCity('paris')).toBe('harbour');
    // Every drawn id has a theme behind it.
    for (const id of ART_THEME_IDS) if (id !== 'none') expect(THEMES[id].id).toBe(id);
  });
});
