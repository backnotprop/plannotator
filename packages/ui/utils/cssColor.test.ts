import { describe, expect, test } from 'bun:test';
import {
  compositeOver,
  contrastRatio,
  mixOklab,
  parseCssColor,
  parseOpaqueColor,
  rgbToOklch,
  toHex,
  withOklchLightness,
} from './cssColor';

const hex = (value: string): string => toHex(parseCssColor(value)!);

describe('parseCssColor', () => {
  test('reads every syntax the palettes and browsers emit', () => {
    expect(hex('#abc')).toBe('#aabbcc');
    expect(hex('#AABBCC')).toBe('#aabbcc');
    expect(hex('rgb(255, 0, 0)')).toBe('#ff0000');
    expect(hex('rgb(255 0 0 / 50%)')).toBe('#ff0000');
    expect(parseCssColor('rgb(255 0 0 / 50%)')!.a).toBeCloseTo(0.5, 5);
    expect(hex('rgba(0, 0, 255, 0.5)')).toBe('#0000ff');
    expect(hex('hsl(120 100% 50%)')).toBe('#00ff00');
    expect(hex('white')).toBe('#ffffff');
    expect(hex('color(srgb 1 0 0)')).toBe('#ff0000');
    expect(hex('color(srgb-linear 1 1 1)')).toBe('#ffffff');
    expect(hex('oklch(1 0 0)')).toBe('#ffffff');
    expect(hex('oklch(0 0 0)')).toBe('#000000');
    const plannotatorBg = parseCssColor('oklch(0.15 0.02 260)')!;
    const backAgain = rgbToOklch(plannotatorBg);
    expect(backAgain.L).toBeCloseTo(0.15, 2);
    expect(backAgain.H).toBeCloseTo(260, 0);
    expect(hex('oklab(0.5 0 0)')).toBe(hex('oklch(0.5 0 0)'));
  });

  test('alpha hex keeps its alpha and composites over a backdrop', () => {
    const parsed = parseCssColor('#ffffff99')!;
    expect(parsed.a).toBeCloseTo(0x99 / 255, 5);
    const over = parseOpaqueColor('#ffffff99', parseCssColor('#000000')!)!;
    expect(over.a).toBe(1);
    expect(toHex(over)).toBe('#999999');
    expect(toHex(compositeOver({ r: 1, g: 0, b: 0, a: 0 }, parseCssColor('#123456')!))).toBe('#123456');
  });

  test('rejects what only the engine can resolve', () => {
    expect(parseCssColor('var(--background)')).toBeUndefined();
    expect(parseCssColor('color-mix(in oklch, #fff 40%, #000)')).toBeUndefined();
    expect(parseCssColor('')).toBeUndefined();
    expect(parseCssColor(undefined)).toBeUndefined();
    expect(parseCssColor('#12')).toBeUndefined();
    expect(parseCssColor('rgb(1, 2)')).toBeUndefined();
  });
});

describe('contrast and mixing', () => {
  test('WCAG anchors', () => {
    const white = parseCssColor('#ffffff')!;
    const black = parseCssColor('#000000')!;
    expect(contrastRatio(white, black)).toBeCloseTo(21, 5);
    expect(contrastRatio(black, white)).toBeCloseTo(21, 5);
    expect(contrastRatio(white, white)).toBeCloseTo(1, 5);
    expect(contrastRatio(parseCssColor('#767676')!, white)).toBeCloseTo(4.54, 1);
  });

  test('mixOklab is anchored at its endpoints and monotone in lightness', () => {
    const a = parseCssColor('#202020')!;
    const b = parseCssColor('#e0e0e0')!;
    expect(toHex(mixOklab(a, b, 0))).toBe('#202020');
    expect(toHex(mixOklab(a, b, 1))).toBe('#e0e0e0');
    const quarter = rgbToOklch(mixOklab(a, b, 0.25)).L;
    const half = rgbToOklch(mixOklab(a, b, 0.5)).L;
    expect(quarter).toBeGreaterThan(rgbToOklch(a).L);
    expect(half).toBeGreaterThan(quarter);
  });

  test('withOklchLightness keeps hue and lands on the requested lightness', () => {
    const blue = parseCssColor('#3b82f6')!;
    const lifted = withOklchLightness(blue, 0.8);
    expect(rgbToOklch(lifted).L).toBeCloseTo(0.8, 1);
    expect(Math.abs(rgbToOklch(lifted).H - rgbToOklch(blue).H)).toBeLessThan(15);
  });
});
