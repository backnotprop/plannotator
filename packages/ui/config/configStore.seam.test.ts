/** Seam tests: ConfigStore server-sync override + loadFromBackend re-hydration. */
import { afterEach, describe, expect, it } from 'bun:test';
import { configStore } from './index';
import * as storageModule from '../utils/storage';

const setStorageBackend = storageModule.setStorageBackend;
const resetStorageBackend = storageModule.resetStorageBackend;

afterEach(() => {
  configStore.resetServerSync();
  resetStorageBackend();
});

describe('configStore.setServerSync seam', () => {
  it('routes server write-back through the installed sync fn', async () => {
    const synced: Array<Record<string, unknown>> = [];
    const fakeSync = (payload: Record<string, unknown>) => {
      synced.push(payload);
    };

    configStore.setServerSync(fakeSync);

    configStore.set('displayName', 'test-tater');

    await new Promise<void>((resolve) => setTimeout(resolve, 350));

    expect(synced.length).toBeGreaterThanOrEqual(1);
    // The payload must contain the displayName key from toServer().
    const merged = Object.assign({}, ...synced) as Record<string, unknown>;
    expect(merged).toHaveProperty('displayName', 'test-tater');
  });

  it('resetServerSync() restores the default fn (no longer calls the fake)', async () => {
    const fakeCalled: boolean[] = [];
    configStore.setServerSync((_: Record<string, unknown>) => { fakeCalled.push(true); });
    configStore.resetServerSync();

    configStore.set('displayName', 'another-tater');
    await new Promise<void>((resolve) => setTimeout(resolve, 350));

    expect(fakeCalled).toHaveLength(0);
  });
});

describe('configStore.loadFromBackend seam', () => {
  it('re-hydrates settings from the installed StorageBackend', () => {
    const prefetched = new Map<string, string>([
      ['plannotator-identity', 'prefetched-workspace-user'],
    ]);
    const fakeBackend = {
      getItem: (key: string) => prefetched.get(key) ?? null,
      setItem: () => {},
      removeItem: () => {},
    };

    setStorageBackend(fakeBackend);
    configStore.loadFromBackend();

    expect(configStore.get('displayName')).toBe('prefetched-workspace-user');
  });

  it('seeds the backend with resolved defaults for keys it lacks (first-run host store)', () => {
    configStore.set('displayName', 'prior-value');

    const store = new Map<string, string>();
    const seedBackend = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
    };

    setStorageBackend(seedBackend);
    configStore.loadFromBackend();

    expect(configStore.get('displayName')).toBe('prior-value');
    // ...AND the empty host backend is now seeded with the resolved default, so a
    // reload reads it back from this backend instead of regenerating it.
    expect(store.get('plannotator-identity')).toBe('prior-value');
  });
});
