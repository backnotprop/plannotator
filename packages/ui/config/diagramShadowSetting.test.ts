/**
 * The diagram shadow setting.
 *
 * The failure this guards is specific and was real during development: 0 is a
 * VALID stored amount here, and `Number(null)` is 0, so a `fromCookie` that
 * parses before checking for an absent cookie reads "never chosen" as "no
 * shadow" — every diagram would ship flat, for everyone, with no way to tell
 * the default from a choice. The rest pins the registry contract the Settings
 * UI and `DiagramBlock` read through.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { resetStorageBackend, setStorageBackend } from '../utils/storage';
import { DEFAULT_DIAGRAM_SHADOW, DIAGRAM_SHADOW_OPTIONS, diagramShadowAmount } from '../utils/diagramShadow';
import { SETTINGS } from './settings';

const KEY = 'plannotator-diagram-shadow';

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

describe('diagramShadow', () => {
  test('an absent cookie is undefined, not 0', () => {
    installBackend();
    expect(SETTINGS.diagramShadow.fromCookie()).toBeUndefined();
    installBackend({ [KEY]: '' });
    expect(SETTINGS.diagramShadow.fromCookie()).toBeUndefined();
    // Deliberate default: the shipped look is the toned-down shadow, not none.
    expect(SETTINGS.diagramShadow.defaultValue).toBe(DEFAULT_DIAGRAM_SHADOW);
  });

  test('round-trips every offered step, 0 included, and rejects anything else', () => {
    const values = installBackend();
    for (const step of DIAGRAM_SHADOW_OPTIONS) {
      SETTINGS.diagramShadow.toCookie(step);
      expect(values.get(KEY)).toBe(String(step));
      expect(SETTINGS.diagramShadow.fromCookie()).toBe(step);
    }
    for (const bad of ['-10', '101', '70.5', 'lots']) {
      values.set(KEY, bad);
      expect(SETTINGS.diagramShadow.fromCookie()).toBeUndefined();
    }
  });

  test('the stored percent becomes the 0..1 amount the mapping takes', () => {
    expect(diagramShadowAmount(0)).toBe(0);
    expect(diagramShadowAmount(70)).toBe(0.7);
    expect(diagramShadowAmount(100)).toBe(1);
    // Nothing downstream ever sees an out-of-range amount.
    expect(diagramShadowAmount(-5)).toBe(0);
    expect(diagramShadowAmount(400)).toBe(1);
    expect(diagramShadowAmount(Number.NaN)).toBe(DEFAULT_DIAGRAM_SHADOW / 100);
  });

  test('it is cookie-only: no server key, so it never writes ~/.plannotator/config.json', () => {
    expect(SETTINGS.diagramShadow.serverKey).toBeUndefined();
  });
});
