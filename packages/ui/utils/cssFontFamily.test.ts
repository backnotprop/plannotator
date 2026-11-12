import { describe, expect, test } from 'bun:test';
import {
  MAX_FONT_FAMILY_LENGTH,
  monoFontStack,
  normalizeCssFontSize,
  normalizeFontFamilyName,
  quoteFontFamily,
} from './cssFontFamily';
import { isFontInstalled } from './fontDetect';

describe('quoteFontFamily', () => {
  test('quotes a plain name', () => {
    expect(quoteFontFamily('Iosevka Term')).toBe('"Iosevka Term"');
  });

  test('escapes quotes and backslashes so the string cannot end early', () => {
    expect(quoteFontFamily('a"b')).toBe('"a\\"b"');
    expect(quoteFontFamily('a\\b')).toBe('"a\\\\b"');
    const quoted = quoteFontFamily('x", monospace; color: red; "');
    expect(quoted.startsWith('"')).toBe(true);
    expect(quoted.endsWith('"')).toBe(true);
    expect(quoted.slice(1, -1).replace(/\\\\/g, '').match(/(^|[^\\])"/)).toBeNull();
  });

  test('drops line breaks and control characters, which would end a CSS string', () => {
    expect(quoteFontFamily('Ios\nevka\r\u2028 Term\u0000')).toBe('"Iosevka Term"');
  });

  test('empty or blank names give nothing', () => {
    expect(quoteFontFamily('')).toBe('');
    expect(quoteFontFamily('   \n ')).toBe('');
  });
});

describe('normalizeFontFamilyName', () => {
  test('trims and caps the stored name', () => {
    expect(normalizeFontFamilyName('  Berkeley Mono  ')).toBe('Berkeley Mono');
    expect(normalizeFontFamilyName('x'.repeat(500))).toHaveLength(MAX_FONT_FAMILY_LENGTH);
  });
});

describe('monoFontStack', () => {
  test('ends in the generic monospace so a missing font keeps code aligned', () => {
    expect(monoFontStack('Iosevka')).toBe('"Iosevka", monospace');
    expect(monoFontStack('')).toBe('');
    expect(monoFontStack(undefined)).toBe('');
  });

});

describe('isFontInstalled', () => {
  function fakeContext(installed: string[]) {
    return {
      font: '',
      measureText(this: { font: string }) {
        const hit = installed.some((name) => this.font.includes(`"${name}"`));
        return { width: hit ? 101 : 100 } as TextMetrics;
      },
    };
  }

  test('a font that changes the measured width is found', () => {
    expect(isFontInstalled('Iosevka', fakeContext(['Iosevka']))).toBe(true);
  });

  test('a font that measures like the fallbacks is not found', () => {
    expect(isFontInstalled('Not A Font', fakeContext(['Iosevka']))).toBe(false);
  });

  test('measures with the quoted, escaped name', () => {
    const ctx = fakeContext(['a\\"b']);
    expect(isFontInstalled('a"b', ctx)).toBe(true);
  });

  test('no canvas means unknown, not missing', () => {
    expect(isFontInstalled('Iosevka', null)).toBeNull();
  });

  test('an empty name is never found', () => {
    expect(isFontInstalled('  ', fakeContext([]))).toBe(false);
  });
});

describe('normalizeCssFontSize', () => {
  test('keeps a plain length in range', () => {
    expect(normalizeCssFontSize('13px')).toBe('13px');
    expect(normalizeCssFontSize(' 0.875rem ')).toBe('0.875rem');
    expect(normalizeCssFontSize('11PT')).toBe('11pt');
    expect(normalizeCssFontSize('1.2em')).toBe('1.2em');
  });

  test('anything else falls back to the default size', () => {
    for (const bad of [
      '',
      undefined,
      '13',
      'px',
      '13 px',
      '-13px',
      '13vh',
      'calc(13px)',
      'var(--x)',
      '13px; } :host { display: none',
      '13px !important',
      '2px',
      '500px',
      '10rem',
      '1e2px',
    ]) {
      expect(normalizeCssFontSize(bad)).toBe('');
    }
  });
});
