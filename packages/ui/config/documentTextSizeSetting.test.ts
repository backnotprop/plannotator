import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resetStorageBackend, setStorageBackend } from '../utils/storage';
import {
  applyDocumentTextSize,
  DEFAULT_DOCUMENT_TEXT_SIZE,
  DOCUMENT_TEXT_SCALE_PROPERTY,
  DOCUMENT_TEXT_SIZE_ATTRIBUTE,
  DOCUMENT_TEXT_SIZE_OPTIONS,
} from '../utils/documentTextSize';
import { SETTINGS } from './settings';

const KEY = 'plannotator-document-text-size';
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

describe('documentTextSize setting', () => {
  test('nothing stored reads as unset, and the default is today\'s 15 px body text', () => {
    installBackend();
    expect(SETTINGS.documentTextSize.fromCookie()).toBeUndefined();
    installBackend({ [KEY]: '' });
    expect(SETTINGS.documentTextSize.fromCookie()).toBeUndefined();
    expect(SETTINGS.documentTextSize.defaultValue).toBe(15);
    expect(DOCUMENT_TEXT_SIZE_OPTIONS).toContain(DEFAULT_DOCUMENT_TEXT_SIZE);
  });

  test('round-trips every offered step and rejects anything else', () => {
    const values = installBackend();
    for (const step of DOCUMENT_TEXT_SIZE_OPTIONS) {
      SETTINGS.documentTextSize.toCookie(step);
      expect(values.get(KEY)).toBe(String(step));
      expect(SETTINGS.documentTextSize.fromCookie()).toBe(step);
    }
    for (const bad of ['16', '0', '-15', '15.5', 'huge']) {
      values.set(KEY, bad);
      expect(SETTINGS.documentTextSize.fromCookie()).toBeUndefined();
    }
  });

  test('it is cookie-only: no server key', () => {
    expect(SETTINGS.documentTextSize.serverKey).toBeUndefined();
  });
});

describe.if(hasDom)('applyDocumentTextSize', () => {
  afterEach(() => {
    applyDocumentTextSize(document.documentElement, DEFAULT_DOCUMENT_TEXT_SIZE);
  });

  test('the default puts nothing on the page', () => {
    const root = document.documentElement;
    applyDocumentTextSize(root, DEFAULT_DOCUMENT_TEXT_SIZE);
    expect(root.hasAttribute(DOCUMENT_TEXT_SIZE_ATTRIBUTE)).toBe(false);
    expect(root.style.getPropertyValue(DOCUMENT_TEXT_SCALE_PROPERTY)).toBe('');
  });

  test('a size away from the default sets the attribute and the scale, and going back clears both', () => {
    const root = document.documentElement;
    applyDocumentTextSize(root, 21);
    expect(root.getAttribute(DOCUMENT_TEXT_SIZE_ATTRIBUTE)).toBe('21');
    expect(Number(root.style.getPropertyValue(DOCUMENT_TEXT_SCALE_PROPERTY))).toBeCloseTo(21 / 15);

    applyDocumentTextSize(root, 13);
    expect(Number(root.style.getPropertyValue(DOCUMENT_TEXT_SCALE_PROPERTY))).toBeCloseTo(13 / 15);

    applyDocumentTextSize(root, DEFAULT_DOCUMENT_TEXT_SIZE);
    expect(root.hasAttribute(DOCUMENT_TEXT_SIZE_ATTRIBUTE)).toBe(false);
    expect(root.style.getPropertyValue(DOCUMENT_TEXT_SCALE_PROPERTY)).toBe('');
  });

  test('a value that is not a step is treated as the default', () => {
    const root = document.documentElement;
    applyDocumentTextSize(root, 19);
    applyDocumentTextSize(root, 40);
    expect(root.hasAttribute(DOCUMENT_TEXT_SIZE_ATTRIBUTE)).toBe(false);
  });
});

describe('the stylesheet', () => {
  test('every rule that reads the scale is gated on the attribute, so the default page is unchanged', () => {
    const css = readFileSync(join(import.meta.dir, '..', 'theme.css'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = css.split('}').filter((rule) => rule.includes(DOCUMENT_TEXT_SCALE_PROPERTY));
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      const parts = rule.split('{');
      const selector = parts[parts.length - 2].trim();
      for (const part of selector.split(/,(?![^(]*\))/)) {
        expect(part.trim().startsWith(`[${DOCUMENT_TEXT_SIZE_ATTRIBUTE}]`)).toBe(true);
      }
    }
  });
});
