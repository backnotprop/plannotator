/**
 * Lazy-resolution contract for ConfigStore.
 *
 * Tested on a FRESH instance (ConfigStoreForTest) rather than the module
 * singleton: whether the singleton has already resolved depends on which test
 * files ran first in the process, which made a singleton-based version of this
 * test flaky in CI. The contract under test is the mechanism itself:
 * construction resolves NOTHING — a host StorageBackend installed before the
 * first settings access receives the initial resolution reads and the
 * default-seeding writes. A configured host therefore never gets
 * plannotator-* cookies written to its origin.
 */
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
    // Install the host backend, THEN construct. If the constructor resolved
    // eagerly, the reads would happen here; the lazy contract says none do.
    setStorageBackend(hostBackend);
    const store = new ConfigStoreForTest();
    expect(reads.length).toBe(0);
    expect(writes.length).toBe(0);

    const identity = store.get('displayName');

    expect(identity.length).toBeGreaterThan(0);
    // Resolution happened lazily, through the live (host) backend:
    expect(reads.length).toBeGreaterThan(0);
    // Missing defaults were seeded into the host backend — including the
    // generated identity — not into document.cookie:
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
