/**
 * `hideRepoOwner` defaults off, so nobody's repository label changes until
 * they hide the owner, and only an explicit `true` / `false` cookie is read:
 * anything else falls back to the default instead of hiding the owner.
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

describe('Hide the repository owner setting', () => {
  test('defaults off when no preference exists', () => {
    memoryStorage();
    expect(SETTINGS.hideRepoOwner.defaultValue).toBe(false);
    expect(SETTINGS.hideRepoOwner.fromCookie()).toBeUndefined();
  });

  test('reads only an explicit true or false', () => {
    const values = memoryStorage();

    SETTINGS.hideRepoOwner.toCookie(true);
    expect(values.get('plannotator-hide-repo-owner')).toBe('true');
    expect(SETTINGS.hideRepoOwner.fromCookie()).toBe(true);

    SETTINGS.hideRepoOwner.toCookie(false);
    expect(SETTINGS.hideRepoOwner.fromCookie()).toBe(false);

    values.set('plannotator-hide-repo-owner', '1');
    expect(SETTINGS.hideRepoOwner.fromCookie()).toBeUndefined();
  });
});
