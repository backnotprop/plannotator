/** A configured host therefore never gets plannotator-* cookies written to its origin. */
import { describe, test, expect, afterAll, beforeEach } from 'bun:test';
import { setStorageBackend, resetStorageBackend, type StorageBackend } from '../utils/storage';
import { ConfigStoreForTest } from './configStore';

describe('configStore lazy resolution', () => {
  const stored = new Map<string, string>();
  let reads: string[] = [];
  let writes: string[] = [];
  const hostBackend: StorageBackend = {
    getItem(key) {
      reads.push(key);
      return stored.get(key) ?? null;
    },
    setItem(key, value) {
      writes.push(key);
      stored.set(key, value);
    },
    removeItem(key) {
      stored.delete(key);
    },
  };

  beforeEach(() => {
    stored.clear();
    reads = [];
    writes = [];
  });

  afterAll(() => {
    resetStorageBackend();
  });

  test('construction resolves nothing; first access resolves through the live backend', () => {
    setStorageBackend(hostBackend);
    const store = new ConfigStoreForTest();
    expect(reads.length).toBe(0);
    expect(writes.length).toBe(0);

    const identity = store.get('displayName');

    expect(identity.length).toBeGreaterThan(0);
    expect(reads.length).toBeGreaterThan(0);
    expect(writes).toContain('plannotator-identity');
    expect(stored.has('plannotator-identity')).toBe(true);
  });

  test('resolution runs once; later reads are served from memory', () => {
    setStorageBackend(hostBackend);
    const store = new ConfigStoreForTest();
    const first = store.get('displayName');
    const readsAfterLoad = reads.length;
    const second = store.get('displayName');
    expect(second).toBe(first);
    expect(reads.length).toBe(readsAfterLoad);
  });
});
