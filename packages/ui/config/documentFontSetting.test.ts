/**
 * The document font setting (Settings → Display → Document font, #1657).
 *
 * Guards: (1) the default draws the document exactly as before, so nothing is
 * put on the page and the stylesheet rule is gated on the attribute; (2) a
 * chosen font reaches the page, a typed name only ever as one quoted family
 * with the theme's font behind it; (3) code keeps its font, because the rule
 * sits in the base layer where a block's own font-mono utility wins.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resetStorageBackend, setStorageBackend } from '../utils/storage';
import {
  applyDocumentFont,
  DOCUMENT_FONT_ATTRIBUTE,
  DOCUMENT_FONT_PROPERTY,
  documentFontStack,
} from '../utils/documentFont';
import { SETTINGS } from './settings';

const KEY = 'plannotator-document-font-family';
const hasDom = typeof document !== 'undefined';

function installBackend(seed: Record<string, string> = {}): Map<string, string> {
  const values = new Map(Object.entries(seed));
  setStorageBackend({
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  });
  return values;
}

afterEach(() => {
  resetStorageBackend();
});

describe('documentFontFamily setting', () => {
  test('nothing stored reads as unset, and the default is the theme font', () => {
    installBackend();
    expect(SETTINGS.documentFontFamily.fromCookie()).toBeUndefined();
    installBackend({ [KEY]: '  ' });
    expect(SETTINGS.documentFontFamily.fromCookie()).toBeUndefined();
    expect(SETTINGS.documentFontFamily.defaultValue).toBe('');
    expect(documentFontStack(SETTINGS.documentFontFamily.defaultValue)).toBe('');
  });

  test('a planted cookie loses its control characters', () => {
    installBackend({ [KEY]: 'Iowan\nOld Style\u0000' });
    expect(SETTINGS.documentFontFamily.fromCookie()).toBe('IowanOld Style');
  });

  test('it is cookie-only and does not share the code font cookie', () => {
    const values = installBackend();
    SETTINGS.documentFontFamily.toCookie('Georgia');
    expect([...values.keys()]).toEqual([KEY]);
    expect(SETTINGS.documentFontFamily.serverKey).toBeUndefined();
  });
});

describe('documentFontStack', () => {
  test('a typed name is one quoted family, then the theme font', () => {
    expect(documentFontStack('Iowan Old Style')).toBe('"Iowan Old Style", var(--font-sans), sans-serif');
    expect(documentFontStack('x", monospace; color: red')).toBe('"x\\", monospace; color: red", var(--font-sans), sans-serif');
  });

  test('a typed name that is an inherited object key is still just a name', () => {
    expect(documentFontStack('constructor')).toBe('"constructor", var(--font-sans), sans-serif');
  });
});

describe.if(hasDom)('applyDocumentFont', () => {
  afterEach(() => {
    applyDocumentFont(document.documentElement, '');
  });

  test('the default puts nothing on the page', () => {
    const root = document.documentElement;
    applyDocumentFont(root, '');
    expect(root.hasAttribute(DOCUMENT_FONT_ATTRIBUTE)).toBe(false);
    expect(root.style.getPropertyValue(DOCUMENT_FONT_PROPERTY)).toBe('');
  });

  test('a font sets the attribute and the stack, and going back clears both', () => {
    const root = document.documentElement;
    applyDocumentFont(root, 'serif');
    expect(root.hasAttribute(DOCUMENT_FONT_ATTRIBUTE)).toBe(true);
    expect(root.style.getPropertyValue(DOCUMENT_FONT_PROPERTY)).toContain('Georgia');

    applyDocumentFont(root, '');
    expect(root.hasAttribute(DOCUMENT_FONT_ATTRIBUTE)).toBe(false);
    expect(root.style.getPropertyValue(DOCUMENT_FONT_PROPERTY)).toBe('');
  });
});

describe('the stylesheet', () => {
  const css = readFileSync(join(import.meta.dir, '..', 'theme.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = css.split('}').filter((rule) => rule.includes(DOCUMENT_FONT_PROPERTY));

  test('every rule that reads the font is gated on the attribute, so the default page is unchanged', () => {
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      const parts = rule.split('{');
      const selector = parts[parts.length - 2].trim();
      for (const part of selector.split(/,(?![^(]*\))/)) {
        expect(part.trim().startsWith(`[${DOCUMENT_FONT_ATTRIBUTE}]`)).toBe(true);
      }
    }
  });

  test('the rule sits in the base layer, so font-mono on a block (the raw diff) still wins', () => {
    for (const rule of rules) {
      expect(rule.split('{')[0].trim()).toBe('@layer base');
    }
  });
});
