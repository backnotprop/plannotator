/**
 * Token hover trigger/delay settings.
 *
 * The failure this guards is the expensive one: `tokenHoverCards` was a
 * boolean, and its `false` is a real preference. A migration that drops it
 * silently turns hover cards back ON for the one user who went looking for the
 * switch. The rest pins the registry contract the Settings UI and the App both
 * read through (unrecognized values fall back to the default rather than
 * reaching the hook).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { resetStorageBackend, setStorageBackend } from '../utils/storage';
import { SETTINGS } from './settings';

const TRIGGER_KEY = 'plannotator-token-hover-trigger';
const DELAY_KEY = 'plannotator-token-hover-delay';
const LEGACY_KEY = 'plannotator-token-hover-cards';

function installBackend(seed: Record<string, string> = {}): Map<string, string> {
  const values = new Map(Object.entries(seed));
  setStorageBackend({
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  });
  return values;
}

afterEach(() => {
  resetStorageBackend();
});

describe('tokenHoverTrigger', () => {
  test('defaults to on-hover when nothing is stored', () => {
    installBackend();
    expect(SETTINGS.tokenHoverTrigger.defaultValue).toBe('hover');
    expect(SETTINGS.tokenHoverTrigger.fromCookie()).toBeUndefined();
  });

  test('round-trips every trigger and rejects anything else', () => {
    const values = installBackend();

    for (const trigger of ['hover', 'modifier', 'off'] as const) {
      SETTINGS.tokenHoverTrigger.toCookie(trigger);
      expect(values.get(TRIGGER_KEY)).toBe(trigger);
      expect(SETTINGS.tokenHoverTrigger.fromCookie()).toBe(trigger);
    }

    values.set(TRIGGER_KEY, 'sometimes');
    expect(SETTINGS.tokenHoverTrigger.fromCookie()).toBeUndefined();
  });

  test('an early adopter who turned cards off with the old boolean stays off', () => {
    installBackend({ [LEGACY_KEY]: 'false' });
    expect(SETTINGS.tokenHoverTrigger.fromCookie()).toBe('off');
  });

  test('the old boolean true migrates to the on-hover behavior it meant', () => {
    installBackend({ [LEGACY_KEY]: 'true' });
    expect(SETTINGS.tokenHoverTrigger.fromCookie()).toBe('hover');
  });

  test('a stored trigger wins over the legacy boolean', () => {
    installBackend({ [TRIGGER_KEY]: 'modifier', [LEGACY_KEY]: 'false' });
    expect(SETTINGS.tokenHoverTrigger.fromCookie()).toBe('modifier');
  });

  test('the legacy cookie is read, never written', () => {
    const values = installBackend({ [LEGACY_KEY]: 'false' });
    SETTINGS.tokenHoverTrigger.fromCookie();
    SETTINGS.tokenHoverTrigger.toCookie('off');
    // Left in place deliberately: deleting it would let a downgrade to the
    // pre-migration build re-enable cards for someone who turned them off.
    expect(values.get(LEGACY_KEY)).toBe('false');
    expect(values.get(TRIGGER_KEY)).toBe('off');
  });
});

describe('tokenHoverDelay', () => {
  test('defaults to the dwell the feature shipped with', () => {
    installBackend();
    expect(SETTINGS.tokenHoverDelay.defaultValue).toBe(300);
    expect(SETTINGS.tokenHoverDelay.fromCookie()).toBeUndefined();
  });

  test('round-trips the three steps as numbers and rejects anything else', () => {
    const values = installBackend();

    for (const delay of [150, 300, 700] as const) {
      SETTINGS.tokenHoverDelay.toCookie(delay);
      expect(values.get(DELAY_KEY)).toBe(String(delay));
      expect(SETTINGS.tokenHoverDelay.fromCookie()).toBe(delay);
    }

    // An off-step number is as invalid as a word: the hook takes this value as
    // a raw setTimeout delay, so a hand-edited cookie must not reach it.
    values.set(DELAY_KEY, '5000');
    expect(SETTINGS.tokenHoverDelay.fromCookie()).toBeUndefined();
    values.set(DELAY_KEY, 'slow');
    expect(SETTINGS.tokenHoverDelay.fromCookie()).toBeUndefined();
    values.set(DELAY_KEY, '');
    expect(SETTINGS.tokenHoverDelay.fromCookie()).toBeUndefined();
  });
});
