/**
 * Seam test: StorageBackend override (setStorageBackend / resetStorageBackend).
 *
 * Contract: after setStorageBackend(fake), getItem/setItem route through the
 * fake backend — NOT through document.cookie. resetStorageBackend() restores
 * the cookie backend.
 *
 * No DOM required (the test never touches document.cookie).
 *
 * IMPORTANT: function references are captured at module-load time (top-level)
 * so they remain valid even when configure.test.ts's mock.module() replaces
 * the module exports later during test execution.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import * as storageModule from './storage';

// Capture real function references at import time (before configure.test.ts's
// mock.module() runs and replaces setStorageBackend/resetStorageBackend exports
// with no-op spies).
const setStorageBackend = storageModule.setStorageBackend;
const resetStorageBackend = storageModule.resetStorageBackend;
const getItem = storageModule.getItem;
const setItem = storageModule.setItem;
const removeItem = storageModule.removeItem;

afterEach(() => {
  resetStorageBackend();
});

describe('StorageBackend seam', () => {
  it('routes getItem through the installed fake backend', () => {
    const store = new Map<string, string>([['test-key', 'test-value']]);
    const fake = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
    };

    setStorageBackend(fake);

    expect(getItem('test-key')).toBe('test-value');
    expect(getItem('missing-key')).toBeNull();
  });

  it('routes setItem through the installed fake backend (not document.cookie)', () => {
    const written: Array<{ key: string; value: string }> = [];
    const read = new Map<string, string>();
    const fake = {
      getItem: (key: string) => read.get(key) ?? null,
      setItem: (key: string, value: string) => { written.push({ key, value }); read.set(key, value); },
      removeItem: () => {},
    };

    setStorageBackend(fake);

    setItem('seam-key', 'seam-value');

    expect(written).toHaveLength(1);
    expect(written[0]).toEqual({ key: 'seam-key', value: 'seam-value' });
    // Confirm read-back goes through the same fake
    expect(getItem('seam-key')).toBe('seam-value');
  });

  it('routes removeItem through the installed fake backend', () => {
    const store = new Map<string, string>([['k', 'v']]);
    const removed: string[] = [];
    const fake = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { removed.push(key); store.delete(key); },
    };

    setStorageBackend(fake);

    removeItem('k');

    expect(removed).toEqual(['k']);
    expect(getItem('k')).toBeNull();
  });

  it('resetStorageBackend restores the original behavior (does not use the fake)', () => {
    const fake = {
      getItem: (_: string) => 'should-not-see-this',
      setItem: () => {},
      removeItem: () => {},
    };
    setStorageBackend(fake);
    resetStorageBackend();

    // After reset, reads go to cookies — in this env cookies return null for
    // unknown keys (no cookie jar in the non-DOM test environment).
    // The key point is that the fake is no longer consulted: if getItem
    // returned 'should-not-see-this' the reset did not work.
    const result = getItem('any-key');
    expect(result).not.toBe('should-not-see-this');
  });
});
