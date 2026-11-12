import { describe, expect, test } from 'bun:test';
import { buildPierreFontCSS } from './pierreFontCss';

describe('buildPierreFontCSS', () => {
  test('nothing set, nothing injected', () => {
    expect(buildPierreFontCSS(undefined, undefined)).toBe('');
    expect(buildPierreFontCSS('', '')).toBe('');
  });

  test('a custom installed font is quoted and falls back to monospace', () => {
    const css = buildPierreFontCSS('Iosevka Term', undefined);
    expect(css).toContain('font-family: "Iosevka Term", monospace !important;');
    expect(css).not.toContain('font-size');
  });

  test('a name with quotes or a line break cannot add declarations', () => {
    const css = buildPierreFontCSS('x"; } :host { display: none; } a { b: "\nc', '14px');
    const line = css.split('\n').find((l) => l.includes('font-family'))!;
    const value = line.trim().replace(/^font-family: /, '').replace(/\\./g, '');
    expect(value).toMatch(/^"[^"\n]*", monospace !important;$/);
    expect(css).toContain('font-size: 14px !important;');
  });

  test('a font size that is not a plain length is dropped, not injected', () => {
    expect(buildPierreFontCSS(undefined, '13px; } :host { display: none')).toBe('');
    const css = buildPierreFontCSS('Iosevka', 'expression(alert(1))');
    expect(css).toContain('font-family');
    expect(css).not.toContain('font-size');
    expect(buildPierreFontCSS(undefined, '0.875rem')).toContain('font-size: 0.875rem !important;');
  });
});
