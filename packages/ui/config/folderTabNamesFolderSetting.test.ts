/**
 * `folderTabNamesFolder` defaults off, so a folder session's tab keeps naming
 * the open file (the owner's ruling on #2392) until someone turns it on, and
 * only an explicit `true` / `false` cookie is read: anything else falls back
 * to the default instead of renaming the tab.
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

describe('Name the tab after the folder setting', () => {
  test('defaults off when no preference exists', () => {
    memoryStorage();
    expect(SETTINGS.folderTabNamesFolder.defaultValue).toBe(false);
    expect(SETTINGS.folderTabNamesFolder.fromCookie()).toBeUndefined();
  });

  test('reads only an explicit true or false', () => {
    const values = memoryStorage();

    SETTINGS.folderTabNamesFolder.toCookie(true);
    expect(values.get('plannotator-folder-tab-names-folder')).toBe('true');
    expect(SETTINGS.folderTabNamesFolder.fromCookie()).toBe(true);

    SETTINGS.folderTabNamesFolder.toCookie(false);
    expect(SETTINGS.folderTabNamesFolder.fromCookie()).toBe(false);

    values.set('plannotator-folder-tab-names-folder', '1');
    expect(SETTINGS.folderTabNamesFolder.fromCookie()).toBeUndefined();
  });
});
