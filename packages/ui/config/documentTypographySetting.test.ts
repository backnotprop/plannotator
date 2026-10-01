import { afterEach, expect, test } from 'bun:test';
import { resetStorageBackend, setStorageBackend } from '../utils/storage';
import { SETTINGS } from './settings';

afterEach(resetStorageBackend);

test('document typography persists independently and reset removes both cookies', () => {
  const values = new Map<string, string>();
  setStorageBackend({ getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } });
  expect(SETTINGS.documentFontFamily.defaultValue).toBe('');
  expect(SETTINGS.documentFontSize.defaultValue).toBeNull();
  SETTINGS.documentFontFamily.toCookie('Georgia');
  SETTINGS.documentFontSize.toCookie(24);
  expect(SETTINGS.documentFontFamily.fromCookie()).toBe('Georgia');
  expect(SETTINGS.documentFontSize.fromCookie()).toBe(24);
  expect(values.has('plannotator-diff-font-size')).toBe(false);
  expect(SETTINGS.documentFontSize.serverKey).toBeUndefined();
  SETTINGS.documentFontFamily.toCookie('');
  SETTINGS.documentFontSize.toCookie(null);
  expect(values.size).toBe(0);
});

test('document typography accepts installed font names but rejects invalid sizes', () => {
  setStorageBackend({ getItem: key => key.endsWith('family') ? 'unknown' : '25', setItem: () => {}, removeItem: () => {} });
  expect(SETTINGS.documentFontFamily.fromCookie()).toBe('unknown');
  expect(SETTINGS.documentFontSize.fromCookie()).toBeUndefined();
});
