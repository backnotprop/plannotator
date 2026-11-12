/** No DOM required (the test never touches document.cookie). */
import { afterEach, describe, expect, it } from 'bun:test';
import * as storageModule from './storage';

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

    const result = getItem('any-key');
    expect(result).not.toBe('should-not-see-this');
  });
});
