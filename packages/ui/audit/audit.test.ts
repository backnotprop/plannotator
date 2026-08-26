import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, test, expect } from 'bun:test';
import {
  parseCssColor,
  parseHex,
  hslToRgb,
  oklchToRgba,
  rgbaToOklch,
  rgbaToLab,
  labToRgba,
  mixColors,
  compositeColors,
  getRelativeLuminance,
  getContrastRatio,
  suggestCompliantOklch,
} from './color';
import {
  auditThemes,
  type ThemeAuditReport,
} from './engine';
import {
  BUILT_IN_THEMES,
  themesForHalf,
} from '../utils/themeRegistry';
import { loadCssCatalog, parseThemeStylesheet } from './cssParser';
import { SEMANTIC_INVENTORY } from './inventory';

describe('WCAG 2.2 Color Engine', () => {
  test('parses standard hex formats (#rgb, #rgba, #rrggbb, #rrggbbaa)', () => {
    const white3 = parseHex('#fff');
    expect(white3).toEqual({ r: 1, g: 1, b: 1, a: 1 });

    const black6 = parseHex('#000000');
    expect(black6).toEqual({ r: 0, g: 0, b: 0, a: 1 });

    const semiWhite = parseHex('#ffffff80');
    expect(semiWhite?.a).toBeCloseTo(0.502, 2);

    const blue4 = parseHex('#00f8');
    expect(blue4?.b).toBe(1);
    expect(blue4?.a).toBeCloseTo(0.533, 2);
  });

  test('rejects malformed same-length hex values instead of partially parsing them', () => {
    for (const malformed of ['#0z0z0z', '#fffffg']) {
      expect(parseHex(malformed)).toBeNull();
    }
  });

  test('converts HSL to sRGB RGBA accurately', () => {
    const red = hslToRgb(0, 100, 50);
    expect(red.r).toBeCloseTo(1, 4);
    expect(red.g).toBeCloseTo(0, 4);
    expect(red.b).toBeCloseTo(0, 4);

    const green = hslToRgb(120, 100, 50);
    expect(green.g).toBeCloseTo(1, 4);

    const blue = hslToRgb(240, 100, 50);
    expect(blue.b).toBeCloseTo(1, 4);
  });

  test('converts OKLCH to sRGB RGBA accurately and back', () => {
    const white = oklchToRgba({ l: 1, c: 0, h: 0, a: 1 });
    expect(white.r).toBeCloseTo(1, 3);
    expect(white.g).toBeCloseTo(1, 3);
    expect(white.b).toBeCloseTo(1, 3);

    const black = oklchToRgba({ l: 0, c: 0, h: 0, a: 1 });
    expect(black.r).toBe(0);
    expect(black.g).toBe(0);
    expect(black.b).toBe(0);

    const oklchBack = rgbaToOklch({ r: 1, g: 1, b: 1, a: 1 });
    expect(oklchBack.l).toBeCloseTo(1, 3);
    expect(oklchBack.c).toBeCloseTo(0, 3);
  });

  test('parses color-mix expressions in oklch, oklab, and srgb', () => {
    const ctx = {
      resolveVar: (name: string) => {
        if (name === '--bg') return '#000000';
        if (name === '--fg') return '#ffffff';
        return undefined;
      },
    };

    const mixed = parseCssColor(
      'color-mix(in srgb, var(--bg) 50%, var(--fg) 50%)',
      ctx
    );
    expect(mixed).not.toBeNull();
    expect(mixed?.r).toBeCloseTo(0.5, 2);
    expect(mixed?.g).toBeCloseTo(0.5, 2);
    expect(mixed?.b).toBeCloseTo(0.5, 2);

    const mixedOklab = parseCssColor(
      'color-mix(in oklab, #ff0000 50%, #0000ff)',
      ctx
    );
    expect(mixedOklab).not.toBeNull();
  });

  test('performs standard sRGB alpha compositing', () => {
    const translucentWhite = { r: 1, g: 1, b: 1, a: 0.5 };
    const black = { r: 0, g: 0, b: 0, a: 1 };

    const composited = compositeColors(translucentWhite, black);
    expect(composited.r).toBeCloseTo(0.5, 3);
    expect(composited.g).toBeCloseTo(0.5, 3);
    expect(composited.b).toBeCloseTo(0.5, 3);
    expect(composited.a).toBe(1);
  });

  test('calculates WCAG 2.2 relative luminance and contrast ratio', () => {
    const white = { r: 1, g: 1, b: 1, a: 1 };
    const black = { r: 0, g: 0, b: 0, a: 1 };

    const whiteLum = getRelativeLuminance(white);
    const blackLum = getRelativeLuminance(black);
    expect(whiteLum).toBeCloseTo(1, 4);
    expect(blackLum).toBeCloseTo(0, 4);

    const maxRatio = getContrastRatio(white, black);
    expect(maxRatio).toBeCloseTo(21.0, 1);

    const sameRatio = getContrastRatio(white, white);
    expect(sameRatio).toBeCloseTo(1.0, 1);
  });

  test('round-trips sRGB through CSS CIELAB and matches Chromium Lab mixing', () => {
    const red = parseCssColor('#ff0000')!;
    const redLab = rgbaToLab(red);
    expect(redLab.L).toBeCloseTo(54.29, 1);
    expect(redLab.a).toBeCloseTo(80.82, 1);
    expect(redLab.b).toBeCloseTo(69.88, 1);

    const roundTrip = labToRgba(redLab);
    expect(roundTrip.r).toBeCloseTo(1, 4);
    expect(roundTrip.g).toBeCloseTo(0, 4);
    expect(roundTrip.b).toBeCloseTo(0, 4);

    // Chromium canvas sample for color-mix(in lab, red 50%, blue): rgb(193, 0, 136).
    const midpoint = mixColors('lab', red, 50, parseCssColor('#0000ff')!, 50);
    expect(Math.round(midpoint.r * 255)).toBe(193);
    expect(Math.round(midpoint.g * 255)).toBe(0);

    const parsedMidpoint = parseCssColor('color-mix(in lab, #ff0000 50%, #0000ff 50%)');
    expect(parsedMidpoint).not.toBeNull();
    expect(Math.round(parsedMidpoint!.r * 255)).toBe(193);
    expect(Math.round(parsedMidpoint!.g * 255)).toBe(0);
    expect(Math.round(parsedMidpoint!.b * 255)).toBe(136);
    expect(parseCssColor('color-mix(in hsl, #ff0000 50%, #0000ff 50%)')).toBeNull();

    const translucent = parseCssColor(
      'color-mix(in srgb, rgb(136 192 208) 58%, transparent)',
    );
    expect(translucent).not.toBeNull();
    expect(Math.round(translucent!.r * 255)).toBe(136);
    expect(Math.abs(Math.round(translucent!.g * 255) - 191)).toBeLessThanOrEqual(1);
    expect(Math.round(translucent!.b * 255)).toBe(208);
    expect(Math.round(translucent!.a * 255)).toBe(148);

    for (const space of ['srgb', 'oklab', 'lab', 'oklch'] as const) {
      const partial = mixColors(space, red, 30, parseCssColor('#0000ff')!, 30);
      const normalized = mixColors(space, red, 50, parseCssColor('#0000ff')!, 50);
      expect(partial.r).toBeCloseTo(normalized.r, 8);
      expect(partial.g).toBeCloseTo(normalized.g, 8);
      expect(partial.b).toBeCloseTo(normalized.b, 8);
      expect(partial.a).toBeCloseTo(0.6, 8);

      const endpoint = mixColors(space, red, 100, parseCssColor('#0000ff')!, 0);
      expect(endpoint.r).toBeCloseTo(red.r, 5);
      expect(endpoint.g).toBeCloseTo(red.g, 5);
      expect(endpoint.b).toBeCloseTo(red.b, 5);
      expect(endpoint.a).toBe(1);
    }

    const nonOpaque = mixColors(
      'srgb',
      { ...red, a: 0.5 },
      30,
      parseCssColor('#0000ff')!,
      30,
    );
    expect(nonOpaque.a).toBeCloseTo(0.45, 8);
    expect(nonOpaque.r).toBeCloseTo(1 / 3, 8);
    expect(nonOpaque.b).toBeCloseTo(2 / 3, 8);
    expect(Math.round(midpoint.b * 255)).toBe(136);
  });

  test('catalog tracks exact selectors and theme.css imports fail-closed', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'plannotator-theme-audit-'));
    try {
      const themesDir = path.join(directory, 'themes');
      fs.mkdirSync(themesDir);
      const stylesheet = path.join(themesDir, 'fixture.css');
      fs.writeFileSync(stylesheet, '.theme-renamed { --background: #000; }');
      const themeCss = path.join(directory, 'theme.css');
      fs.writeFileSync(themeCss, '@import \"./themes/fixture.css\";');

      const parsed = parseThemeStylesheet(stylesheet);
      expect(parsed.hasDarkSelector).toBe(false);
      expect(parsed.hasExplicitLightSelector).toBe(false);

      const catalog = loadCssCatalog(themesDir, themeCss);
      expect(catalog.importedThemeIds.has('fixture')).toBe(true);
      expect(catalog.themes.get('fixture')?.hasDarkSelector).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('audit result fails when registry selectors are missing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plannotator-theme-integrity-'));
    try {
      fs.mkdirSync(path.join(root, 'packages/ui/themes'), { recursive: true });
      fs.writeFileSync(path.join(root, 'packages/ui/theme.css'), ':root {}');
      const failed = auditThemes({ repoRoot: root });
      expect(failed.allPassed).toBe(false);
      expect(failed.missingSelectors.length).toBe(BUILT_IN_THEMES.length);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });


  test('resolver errors count as failed states and fail the variant', () => {
    const failed = auditThemes({
      themeFilter: 'nord:dark',
      inventory: [{
        id: 'throws',
        name: 'Throwing fixture',
        category: 'core-text',
        criterion: 'SC 1.4.3',
        targetRatio: 4.5,
        isLargeText: false,
        isNonText: false,
        source: 'fixture',
        description: 'Exercises fail-closed state accounting.',
        resolve: () => {
          throw new Error('fixture failure');
        },
      }],
    });
    expect(failed.totalEvaluatedStates).toBe(1);
    expect(failed.failedStates).toBe(1);
    expect(failed.variants[0]?.passed).toBe(false);
    expect(failed.allPassed).toBe(false);
  });
});

describe('WCAG 2.2 Semantic Rules & Threshold Selection', () => {
  test('normal text must reach 4.5:1 for SC 1.4.3', () => {
    // Normal text at ~3.2:1 must fail SC 1.4.3 (requires 4.5:1)
    const fg32 = { r: 0.366, g: 0.366, b: 0.366, a: 1 };
    const bg = { r: 0, g: 0, b: 0, a: 1 }; // black
    const ratio32 = getContrastRatio(fg32, bg);
    expect(ratio32).toBeCloseTo(3.2, 1);
    expect(ratio32 >= 4.5).toBe(false);
  });
  test('essential UI components and focus rings require 3.0:1 for SC 1.4.11', () => {
    // A focus ring at ~2.9:1 must fail SC 1.4.11
    const fgLow = { r: 0.344, g: 0.344, b: 0.344, a: 1 };
    const bg = { r: 0, g: 0, b: 0, a: 1 };
    const ratioLow = getContrastRatio(fgLow, bg);
    expect(ratioLow).toBeCloseTo(2.9, 1);
    expect(ratioLow >= 3.0).toBe(false);

    // A focus ring at ~3.5:1 passes SC 1.4.11
    const fgPass = { r: 0.40, g: 0.40, b: 0.40, a: 1 };
    const ratioPass = getContrastRatio(fgPass, bg);
    expect(ratioPass).toBeGreaterThanOrEqual(3.0);
  });

  test('checked switch track composites primary opacity over card exactly once', () => {
    const primary = parseCssColor('#88c0d0')!;
    const card = parseCssColor('#3b4252')!;
    const expectedTrack = compositeColors({ ...primary, a: 0.58 }, card);
    const switchState = SEMANTIC_INVENTORY.find((state) => state.id === 'switch-checked-track');
    expect(switchState).toBeDefined();

    const rawTokens = {
      '--primary': '#88c0d0',
      '--card': '#3b4252',
      '--background': '#2e3440',
    };
    const resolvedColors = { '--primary': primary, '--card': card, '--background': parseCssColor('#2e3440')! };
    const resolved = switchState!.resolve({
      themeId: 'fixture',
      mode: 'dark',
      rawTokens,
      resolvedColors,
    });

    expect(resolved.fg).toEqual(expectedTrack);
    expect(resolved.fg.a).toBe(1);
    expect(getContrastRatio(resolved.fg, resolved.bg)).toBeCloseTo(
      getContrastRatio(expectedTrack, card),
      8,
    );
  });


  test('identical foreground and background fails with 1.0:1', () => {
    const fg = { r: 0.8, g: 0.2, b: 0.2, a: 1 };
    const bg = { r: 0.8, g: 0.2, b: 0.2, a: 1 };
    const ratio = getContrastRatio(fg, bg);
    expect(ratio).toBe(1.0);
    expect(ratio >= 4.5).toBe(false);
  });

  test('suggestCompliantOklch computes minimal lightness delta to reach target', () => {
    const darkBg = { r: 0.05, g: 0.05, b: 0.05, a: 1 };
    const failingFg = { r: 0.2, g: 0.2, b: 0.2, a: 1 };

    const initialRatio = getContrastRatio(failingFg, darkBg);
    expect(initialRatio).toBeLessThan(4.5);

    const suggestion = suggestCompliantOklch(failingFg, darkBg, 4.5, 'dark');
    expect(suggestion.ratio).toBeGreaterThanOrEqual(4.5);
    expect(suggestion.hex).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('Deterministic Theme Audit Seam', () => {
  let report: ThemeAuditReport;

  test('derives variants dynamically from themeRegistry without hardcoded bounds', () => {
    const lightThemes = themesForHalf(BUILT_IN_THEMES, 'light');
    const darkThemes = themesForHalf(BUILT_IN_THEMES, 'dark');
    const expectedVariantCount = lightThemes.length + darkThemes.length;

    report = auditThemes();

    expect(report.totalThemes).toBe(BUILT_IN_THEMES.length);
    expect(report.totalVariants).toBe(expectedVariantCount);
    expect(report.variants.length).toBe(expectedVariantCount);

    // Verify all keys are unique
    const keys = new Set(report.variants.map((v) => v.key));
    expect(keys.size).toBe(expectedVariantCount);
  });

  test('reports counts and evaluations for only the filtered theme variant', () => {
    const filtered = auditThemes({ themeFilter: 'nord:dark' });

    expect(filtered.totalThemes).toBe(1);
    expect(filtered.totalVariants).toBe(1);
    expect(filtered.variants).toHaveLength(1);
    expect(filtered.totalEvaluatedStates).toBe(SEMANTIC_INVENTORY.length);
    expect(filtered.variants[0]?.states).toHaveLength(SEMANTIC_INVENTORY.length);
  });

  test('verifies no orphaned stylesheets or missing selectors', () => {
    expect(report.orphanedFiles).toEqual([]);
    expect(report.missingSelectors).toEqual([]);
    expect(report.diagnosticErrors).toEqual([]);
  });

  test('evaluates every semantic state across all variants deterministically', () => {
    const expectedTotalStates = report.totalVariants * SEMANTIC_INVENTORY.length;
    expect(report.totalEvaluatedStates).toBe(expectedTotalStates);

    for (const v of report.variants) {
      expect(v.states.length).toBe(SEMANTIC_INVENTORY.length);
      for (const s of v.states) {
        expect(typeof s.ratio).toBe('number');
        expect(s.ratio).toBeGreaterThanOrEqual(1.0);
        expect(s.fgHex).toMatch(/^#[0-9a-f]{6,8}$/);
        expect(s.bgHex).toMatch(/^#[0-9a-f]{6,8}$/);
      }
    }
  });

  test('audit execution is strictly deterministic across runs', () => {
    const report2 = auditThemes();
    expect(report2.totalVariants).toBe(report.totalVariants);
    expect(report2.passedStates).toBe(report.passedStates);
    expect(report2.failedStates).toBe(report.failedStates);
    expect(report2.complianceRate).toBe(report.complianceRate);
  });
});
