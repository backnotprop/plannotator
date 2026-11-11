import { expect, test } from 'bun:test';
import { contrast, over, pickActivityInk, activityInkStyle, type Rgb } from './activityInk';

const CARD: Rgb = [255, 255, 255];
const TEXT: Rgb = [20, 20, 20];
const PALE: Rgb = [235, 225, 255];

const measure = (accent: Rgb) => (ink: number, strand: number) => {
  const mix = (a: Rgb, b: Rgb, share: number) => a.map((v, i) => Math.round(v * share + b[i]! * (1 - share))) as unknown as Rgb;
  const color = mix(accent, TEXT, ink / 100);
  return { faintest: [over(color, CARD, 0.62)], strand: mix(color, CARD, strand / 100), ground: CARD };
};

test('a strong accent is kept as it is', () => {
  const pick = pickActivityInk(measure([90, 60, 220]))!;
  expect(pick.ink).toBe(100);
  expect(activityInkStyle(pick)['--ib-act-ink']).toBe('var(--primary)');
});

test('a pale accent takes just enough text colour for its faintest mark to reach 2:1, and its strand 1.3:1', () => {
  const pick = pickActivityInk(measure(PALE))!;
  expect(pick.ink).toBeLessThan(100);
  const read = measure(PALE)(pick.ink, pick.strand);
  expect(contrast(read.faintest[0]!, CARD)).toBeGreaterThanOrEqual(2);
  expect(contrast(read.strand, CARD)).toBeGreaterThanOrEqual(1.3);
  const shares = [100, 85, 70, 55, 40, 25, 0];
  const more = shares[shares.indexOf(pick.ink) - 1]!;
  expect(contrast(measure(PALE)(more, pick.strand).faintest[0]!, CARD)).toBeLessThan(2);
});

test('a page that cannot read colours keeps the CSS defaults', () => {
  expect(pickActivityInk(() => null)).toBeNull();
});
