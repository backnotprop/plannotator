/**
 * Every key sequence up to MAX_KEYS long over the Inbox's main views
 * (keyboard/model.ts), checked for the logic flaws keyboard-only use runs
 * into: a dead end Escape cannot get out of, focus left on the page, a key
 * that acts while the person types or with single keys off, a layer that
 * Escape does not put back exactly, and a model that has drifted from the
 * registry the window's keys are read from.
 *
 * A flaw found here is listed (with the shortest key path to it), never
 * skipped. Known, accepted gaps are in KNOWN, each with its reason.
 */
import { describe, expect, test } from 'bun:test';
import { listRegistryShortcuts } from '@plannotator/ui/shortcuts';
import { inboxShortcutRegistry, isBareBinding } from '../shortcuts';
import { depth, explore, MODEL_BARE_KEYS, press, START, typing, type KeyState, type ModelKey } from './model';

const MAX_KEYS = 6;
const reachable = [...explore(START, MAX_KEYS).values()];
const fromFullScreenStart = [...explore({ ...START, remembered: 'full' }, MAX_KEYS).values()];
const all = [...reachable, ...fromFullScreenStart];

/** Single keys the model has that the registry does not list yet, each with why. */
const HELD: Partial<Record<ModelKey, string>> = {};

const at = (path: ModelKey[]) => (path.length === 0 ? '(start)' : path.join(' → '));
const view = (s: KeyState) => ({ page: s.page, thread: s.thread, file: s.file, fullFrom: s.fullFrom, box: s.box, overlay: s.overlay });

describe('the keyboard model, every sequence up to ' + MAX_KEYS + ' keys', () => {
  test('explores enough of the window to mean something', () => {
    const pages = new Set(all.map(({ state }) => `${state.page}/${state.thread}/${state.file}/${state.box}/${state.overlay}`));
    expect(all.length).toBeGreaterThan(500);
    for (const must of ['inbox/true/side/false/none', 'inbox/true/full/false/none', 'inbox/true/none/true/none', 'settings/false/none/false/none', 'board/false/none/false/none', 'inbox/false/none/false/map', 'inbox/true/none/false/search'])
      expect([must, pages.has(must)]).toEqual([must, true]);
  });

  test('focus is never left on the page', () => {
    const lost = all.filter(({ state }) => state.focus === 'body').map(({ path }) => at(path));
    expect(lost).toEqual([]);
  });

  test('no dead end: Escape alone always gets back to a page’s base, one layer per press', () => {
    const flaws: string[] = [];
    for (const { state, path } of all) {
      let s = state;
      // A text field's Escape leaves the field first (one extra press), then each layer takes one.
      for (let n = 0; n <= depth(state) + 1 && depth(s) > 0; n++) {
        const next = press(s, 'Escape');
        if (depth(next) > depth(s)) flaws.push(`${at(path)}: Escape opened a layer`);
        s = next;
      }
      if (depth(s) !== 0) flaws.push(`${at(path)}: still ${depth(s)} layers after ${depth(state) + 2} Escapes`);
    }
    expect(flaws).toEqual([]);
  });

  test('while typing, no single key acts: it is text (Enter, the arrows, Escape and chords stay the field’s)', () => {
    const flaws: string[] = [];
    for (const { state, path } of all) {
      if (!typing(state)) continue;
      for (const key of [...MODEL_BARE_KEYS, 'type' as const]) {
        if (JSON.stringify(press(state, key)) !== JSON.stringify(state)) flaws.push(`${at(path)} then ${key}`);
      }
    }
    expect(flaws).toEqual([]);
  });

  test('with single keys off, no single key does anything; ⌘K, ⌘↵, Escape and the arrows still do', () => {
    const flaws: string[] = [];
    let chordsWork = 0;
    for (const { state, path } of all) {
      if (state.singleKeys) continue;
      for (const key of MODEL_BARE_KEYS) if (JSON.stringify(press(state, key)) !== JSON.stringify(state)) flaws.push(`${at(path)} then ${key}`);
      if (state.overlay === 'none' && JSON.stringify(press(state, 'Mod+K')) !== JSON.stringify(state)) chordsWork++;
    }
    expect(flaws).toEqual([]);
    expect(chordsWork).toBeGreaterThan(0);
  });

  test('a layer opened by a key and closed with Escape puts back the same view (and, for the map and search, the same focus)', () => {
    const flaws: string[] = [];
    for (const { state, path } of all) {
      if (state.overlay !== 'none' || typing(state)) continue;
      for (const key of ['?', '/', 'Mod+K'] as const) {
        const opened = press(state, key);
        if (opened.overlay === 'none') continue;
        if (JSON.stringify(press(opened, 'Escape')) !== JSON.stringify(state)) flaws.push(`${at(path)}: ${key} then Escape`);
      }
      if (!state.singleKeys) continue;
      if (state.page !== 'settings') {
        const back = press(press(state, 'G S'), 'Escape');
        if (JSON.stringify(view({ ...back, box: state.box })) !== JSON.stringify(view(state))) flaws.push(`${at(path)}: G S then Escape`);
      }
      if (state.page === 'inbox' && state.thread && state.file === 'none' && !state.box && state.focus !== 'file') {
        for (const key of ['O', 'F'] as const) {
          const back = press(press(state, key), 'Escape');
          if (JSON.stringify(view(back)) !== JSON.stringify(view(state))) flaws.push(`${at(path)}: ${key} then Escape`);
        }
      }
      if (state.page === 'inbox' && state.file === 'side' && state.focus !== 'file') {
        const back = press(press(state, 'F'), 'Escape');
        if (JSON.stringify(view(back)) !== JSON.stringify(view(state))) flaws.push(`${at(path)}: F then Escape from beside the thread`);
      }
    }
    expect(flaws).toEqual([]);
  });

  test('F never changes the remembered view; O opens in it', () => {
    for (const { state } of all) {
      expect(press(state, 'F').remembered).toBe(state.remembered);
      const opened = press(state, 'O');
      if (opened.file !== state.file && opened.file !== 'none') expect(opened.file).toBe(state.remembered);
    }
  });

  test('the model’s single keys are the registry’s, the held ones aside', () => {
    const registry = new Set(listRegistryShortcuts(inboxShortcutRegistry).flatMap((entry) => entry.bindings).filter(isBareBinding));
    const missing = MODEL_BARE_KEYS.filter((key) => !registry.has(key) && !HELD[key]);
    expect(missing).toEqual([]);
    // Held keys must still be missing: once one lands in the registry, take it out of HELD.
    for (const key of Object.keys(HELD) as ModelKey[]) expect([key, registry.has(key)]).toEqual([key, false]);
    // Every registry single key the model leaves out is one that only steps or undoes (no new view).
    const unmodelled = [...registry].filter((key) => !(MODEL_BARE_KEYS as readonly string[]).includes(key)).sort();
    expect(unmodelled).toEqual(['E', 'K', 'Shift+K', 'Z', '[', ']']);
  });
});
