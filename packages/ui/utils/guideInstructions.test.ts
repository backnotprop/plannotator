/**
 * Guide extra instructions persistence (#1265).
 *
 * Contract: getGuideInstructions/setGuideInstructions round-trip the reviewer's
 * standing preferences through the storage backend under a DEDICATED key
 * (never inside the plannotator.agents blob, so a long text cannot push that
 * settings cookie past the browser's per-cookie size limit), and a blank set
 * removes the stored value entirely rather than persisting whitespace.
 *
 * No DOM required: runs against a fake StorageBackend via the seam.
 *
 * IMPORTANT: function references are captured at module-load time (top-level)
 * so they remain valid even when configure.test.ts's mock.module() replaces
 * the module exports later during test execution.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import * as storageModule from './storage';

const setStorageBackend = storageModule.setStorageBackend;
const resetStorageBackend = storageModule.resetStorageBackend;
const getGuideInstructions = storageModule.getGuideInstructions;
const setGuideInstructions = storageModule.setGuideInstructions;

function installFakeBackend(): Map<string, string> {
  const store = new Map<string, string>();
  setStorageBackend({
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  });
  return store;
}

afterEach(() => {
  resetStorageBackend();
});

describe('guide instructions persistence', () => {
  it('returns an empty string when nothing is stored', () => {
    installFakeBackend();
    expect(getGuideInstructions()).toBe('');
  });

  it('round-trips multi-line instructions verbatim', () => {
    installFakeBackend();
    const text = 'Prefer product vocabulary.\nNever invent Linear ticket IDs.';
    setGuideInstructions(text);
    expect(getGuideInstructions()).toBe(text);
  });

  it('stores under its own key, never inside the plannotator.agents blob', () => {
    const store = installFakeBackend();
    setGuideInstructions('standing preference');
    expect(store.has('plannotator-guide-instructions')).toBe(true);
    expect(store.has('plannotator.agents')).toBe(false);
  });

  it('a blank set removes the stored value instead of persisting whitespace', () => {
    const store = installFakeBackend();
    setGuideInstructions('keep me');
    setGuideInstructions('   ');
    expect(store.has('plannotator-guide-instructions')).toBe(false);
    expect(getGuideInstructions()).toBe('');
  });
});
