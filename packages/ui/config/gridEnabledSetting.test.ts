/**
 * The plan look default (Grid vs Clean), by stored cookie state.
 *
 * Clean is the default (owner, 2026-10-27), and existing users move to Clean
 * once: both earlier choosers opened with Grid preselected, so a stored Grid
 * next to an old (v1) marker is not proof anyone chose it. ConfigStore also
 * writes a setting's default into its cookie on first load, so most browsers
 * hold `plannotator-grid-enabled=true` without a choice at all.
 *
 * Each row is one state from the #2268 review table: what the person sees
 * on load (the look and which dialog), and that a choice made under the
 * Clean default (v2) is never moved again. A "reload" is a fresh
 * ConfigStoreForTest over the same storage.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { resetStorageBackend, setStorageBackend } from '../utils/storage';
import { markLookAndFeelChoiceResolved, planLookPrompt } from '../utils/lookAndFeelAnnouncement';
import { ConfigStoreForTest } from './configStore';

const GRID = 'plannotator-grid-enabled';
const V1 = 'plannotator-plan-look-choice-resolved';
const LEGACY_SEEN = 'plannotator-look-feel-announcement-seen';
const V2 = 'plannotator-plan-look-v2';

function installBackend(seed: Record<string, string> = {}): Map<string, string> {
  const values = new Map(Object.entries(seed));
  setStorageBackend({
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  });
  return values;
}

/** One page load: the look the store resolves, then the dialog the app asks for. */
function load(): { grid: boolean; prompt: ReturnType<typeof planLookPrompt> } {
  const grid = new ConfigStoreForTest().get('gridEnabled');
  return { grid, prompt: planLookPrompt() };
}

afterEach(() => {
  resetStorageBackend();
});

describe('plan look by cookie state', () => {
  test('fresh install: Clean, first-run chooser', () => {
    installBackend();
    expect(load()).toEqual({ grid: false, prompt: 'first-run' });
  });

  test('never dismissed a chooser (default seeded as true, no marker): Clean, first-run chooser', () => {
    const values = installBackend({ [GRID]: 'true' });
    expect(load()).toEqual({ grid: false, prompt: 'first-run' });
    expect(values.get(GRID)).toBe('false');
  });

  test('pre-0.20.0 announcement only (seen=1): Clean, first-run chooser', () => {
    installBackend({ [GRID]: 'true', [LEGACY_SEEN]: '1' });
    expect(load()).toEqual({ grid: false, prompt: 'first-run' });
  });

  test('0.20.0 chooser with Grid: moved to Clean, one-time notice', () => {
    const values = installBackend({ [GRID]: 'true', [LEGACY_SEEN]: '2' });
    expect(load()).toEqual({ grid: false, prompt: 'moved' });
    expect(values.get(GRID)).toBe('false');
    expect(values.get(V2)).toBe('notice');
  });

  test('0.20.0 chooser with Clean: stays Clean, no notice, marked v2 silently', () => {
    const values = installBackend({ [GRID]: 'false', [LEGACY_SEEN]: '2' });
    expect(load()).toEqual({ grid: false, prompt: null });
    expect(values.get(V2)).toBe('resolved');
  });

  test('newer chooser with Grid (Continue on the Grid preselect): moved to Clean, one-time notice', () => {
    const values = installBackend({ [GRID]: 'true', [V1]: 'true' });
    expect(load()).toEqual({ grid: false, prompt: 'moved' });
    expect(values.get(GRID)).toBe('false');
  });

  test('newer chooser with Clean: stays Clean, no notice', () => {
    installBackend({ [GRID]: 'false', [V1]: 'true' });
    expect(load()).toEqual({ grid: false, prompt: null });
  });

  test('old marker, no look cookie: Clean, no notice', () => {
    installBackend({ [V1]: 'true' });
    expect(load()).toEqual({ grid: false, prompt: null });
  });

  test('the notice shows until it is answered, then never again', () => {
    installBackend({ [GRID]: 'true', [V1]: 'true' });
    expect(load().prompt).toBe('moved');
    // Closed the tab without answering: asked again, still Clean.
    expect(load()).toEqual({ grid: false, prompt: 'moved' });
    // Continue / Escape on Clean.
    markLookAndFeelChoiceResolved();
    expect(load()).toEqual({ grid: false, prompt: null });
    expect(load()).toEqual({ grid: false, prompt: null });
  });

  test('picking Grid on the notice keeps Grid on every later load', () => {
    installBackend({ [GRID]: 'true', [V1]: 'true' });
    const store = new ConfigStoreForTest();
    expect(planLookPrompt()).toBe('moved');
    store.set('gridEnabled', true);
    markLookAndFeelChoiceResolved();
    expect(load()).toEqual({ grid: true, prompt: null });
    expect(load()).toEqual({ grid: true, prompt: null });
  });

  test('a choice made under the Clean default is never moved: v2 with Grid stays Grid', () => {
    installBackend({ [GRID]: 'true', [V2]: 'resolved', [V1]: 'true' });
    expect(load()).toEqual({ grid: true, prompt: null });
  });

  test('v2 with Clean stays Clean', () => {
    installBackend({ [GRID]: 'false', [V2]: 'resolved' });
    expect(load()).toEqual({ grid: false, prompt: null });
  });

  test('an older build re-writing its v1 marker cannot move a v2 Grid choice', () => {
    const values = installBackend({ [GRID]: 'true', [V2]: 'resolved' });
    // An older bundle on the same cookie jar resolves its own chooser.
    values.set(V1, 'true');
    values.set(LEGACY_SEEN, '2');
    expect(load()).toEqual({ grid: true, prompt: null });
  });

  test('every load rewrites a resolved v2, so it cannot expire before an older build\'s v1 marker and Grid', () => {
    const values = installBackend({ [GRID]: 'true', [V2]: 'resolved', [V1]: 'true' });
    const writes: string[] = [];
    setStorageBackend({
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { writes.push(key); values.set(key, value); },
      removeItem: (key) => { values.delete(key); },
    });
    expect(load()).toEqual({ grid: true, prompt: null });
    // Cookies last a year from their last write: the load wrote v2 again.
    expect(writes).toContain(V2);
    expect(values.get(V2)).toBe('resolved');
  });

  test('resolving also writes the v1 marker, so older builds do not ask again', () => {
    const values = installBackend();
    markLookAndFeelChoiceResolved();
    expect(values.get(V1)).toBe('true');
    expect(values.get(V2)).toBe('resolved');
  });

  test('a host with no chooser that marks the choice before the first read keeps the stored look', () => {
    installBackend({ [GRID]: 'true', [V1]: 'true' });
    markLookAndFeelChoiceResolved();
    expect(load()).toEqual({ grid: true, prompt: null });
  });
});
