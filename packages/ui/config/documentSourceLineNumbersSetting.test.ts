/**
 * `documentSourceLineNumbers` defaults off, so today's document has no gutter
 * until someone turns the switch on, and only an explicit `true` / `false`
 * cookie is read.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { resetStorageBackend, setStorageBackend } from '../utils/storage';
import { SETTINGS } from './settings';

afterEach(() => {
  resetStorageBackend();
});

function memoryStorage(): Map<string, string> {
  const values = new Map<string, string>();
  setStorageBackend({
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  });
  return values;
}

describe('Source line numbers setting', () => {
  test('defaults off when no preference exists', () => {
    memoryStorage();
    expect(SETTINGS.documentSourceLineNumbers.defaultValue).toBe(false);
    expect(SETTINGS.documentSourceLineNumbers.fromCookie()).toBeUndefined();
  });

  test('reads only an explicit true or false, and is cookie-only', () => {
    const values = memoryStorage();

    SETTINGS.documentSourceLineNumbers.toCookie(true);
    expect(values.get('plannotator-document-source-line-numbers')).toBe('true');
    expect(SETTINGS.documentSourceLineNumbers.fromCookie()).toBe(true);

    SETTINGS.documentSourceLineNumbers.toCookie(false);
    expect(SETTINGS.documentSourceLineNumbers.fromCookie()).toBe(false);

    values.set('plannotator-document-source-line-numbers', '1');
    expect(SETTINGS.documentSourceLineNumbers.fromCookie()).toBeUndefined();

    expect(SETTINGS.documentSourceLineNumbers.serverKey).toBeUndefined();
  });
});
