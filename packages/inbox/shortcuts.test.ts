/**
 * The Inbox's keys in the shared registry (shortcuts/): a surface like plan
 * review's and code review's. What would regress: a binding the registry
 * cannot read (it would never fire), two scopes with one id (one would shadow
 * the other in a help list), the full-screen chord drifting from plan
 * review's, or a single key slipping in that the owner did not approve
 * (approval "inbox-keyboard-shortcuts": the set below, each extra behind its
 * switch in shortcuts/extras.ts). Every combination of the extras is checked,
 * so turning one on or off never breaks the others.
 */
import { describe, expect, test } from 'bun:test';
import { htmlAnnotateShortcuts, listRegistryShortcuts, matchesShortcutBinding, validateShortcutRegistry } from '@plannotator/ui/shortcuts';
import { buildInboxShortcutRegistry, INBOX_SHORTCUT_EXTRAS, inboxAppShortcuts, inboxFileViewerShortcuts, inboxSearchShortcuts, inboxShortcutRegistry, inboxSurface, inboxThreadShortcuts, isBareBinding, type InboxShortcutExtras } from './shortcuts';

const COMBOS: InboxShortcutExtras[] = [false, true].flatMap((slashSearch) =>
  [false, true].flatMap((goTo) => [false, true].map((readFromList) => ({ slashSearch, goTo, readFromList }))),
);

/**
 * The single keys the owner approved; each extra adds its own. Shift+E, H, Shift+O, C, G P and G D: approval
 * "inbox-keyboard-keys-2026-11-07" (H for Snooze, as that approval's fallback: B is G B's second key). Shift+R
 * (Refresh): approval "inbox-refresh-key".
 */
function approvedBare(extras: InboxShortcutExtras): string[] {
  const core = ['E', 'Shift+E', 'Z', 'R', 'Shift+R', 'J', 'K', 'Shift+J', 'Shift+K', 'N', 'O', 'Shift+O', 'Q', 'F', 'H', 'C', '?', '[', ']'];
  return [...core, ...(extras.slashSearch ? ['/'] : []), ...(extras.goTo ? ['G I', 'G B', 'G P', 'G D', 'G S'] : [])].sort();
}

function bareBindings(registry: ReturnType<typeof buildInboxShortcutRegistry>): string[] {
  return listRegistryShortcuts(registry)
    .flatMap((entry) => entry.bindings)
    .filter(isBareBinding)
    .sort();
}

describe('the Inbox surface', () => {
  test('validates: every binding normalized, every scope id unique and the Inbox’s own', () => {
    expect(validateShortcutRegistry(inboxShortcutRegistry)).toEqual([]);
    const ids = inboxShortcutRegistry.map((scope) => scope.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.startsWith('inbox-')).toBe(true);
    expect(inboxSurface.registry).toBe(inboxShortcutRegistry);
  });

  test('the single keys are exactly the approved ones, for every combination of the extras', () => {
    for (const extras of COMBOS) expect(bareBindings(buildInboxShortcutRegistry(extras))).toEqual(approvedBare(extras));
    expect(bareBindings(inboxShortcutRegistry)).toEqual(approvedBare(INBOX_SHORTCUT_EXTRAS));
  });

  test('every combination validates, and no single key means two things', () => {
    for (const extras of COMBOS) {
      const registry = buildInboxShortcutRegistry(extras);
      expect(validateShortcutRegistry(registry)).toEqual([]);
      const bare = bareBindings(registry);
      expect(new Set(bare).size).toBe(bare.length);
      // A sequence's first key is never a key of its own (G would fire before G I could).
      const firsts = new Set(bare.filter((b) => b.includes(' ')).map((b) => b.split(' ')[0]));
      for (const first of firsts) expect(bare).not.toContain(first);
      // Nor is its second key: G, a pause past the sequence's window, then B would act on its own (a snooze for a
      // trip to the Board). This is why Snooze is H, not Gmail's B.
      const seconds = new Set(bare.filter((b) => b.includes(' ')).map((b) => b.split(' ')[1]));
      for (const second of seconds) expect(bare).not.toContain(second);
    }
  });

  test('a single key is one plain key or a sequence of them; chords, Escape, Enter and the arrows are not', () => {
    for (const binding of ['E', '?', '/', '[', 'G I']) expect(isBareBinding(binding)).toBe(true);
    for (const binding of ['Mod+K', 'Mod+Enter', 'Escape', 'Enter', 'ArrowDown', 'Home', 'Shift+F10', 'Alt+E']) expect(isBareBinding(binding)).toBe(false);
  });

  test('the full-screen toolbar takes plan review’s Hide tools chord', () => {
    expect(inboxFileViewerShortcuts.shortcuts.toggleTools.bindings).toEqual(htmlAnnotateShortcuts.shortcuts.toggleTools.bindings);
  });

  test('the bindings match the keys the Inbox reacts to, and only without ⌘ / Ctrl / Alt', () => {
    const keydown = (init: KeyboardEventInit) => ({ key: '', code: '', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...init }) as KeyboardEvent;
    const { escape, next, previous } = inboxFileViewerShortcuts.shortcuts;
    expect(escape.bindings.some((b) => matchesShortcutBinding(keydown({ key: 'Escape' }), b))).toBe(true);
    for (const key of [']', 'ArrowRight']) expect(next.bindings.some((b) => matchesShortcutBinding(keydown({ key }), b))).toBe(true);
    for (const key of ['[', 'ArrowLeft']) expect(previous.bindings.some((b) => matchesShortcutBinding(keydown({ key }), b))).toBe(true);
    // ⌘] is the browser's Forward; Shift+→ extends a selection.
    expect(next.bindings.some((b) => matchesShortcutBinding(keydown({ key: ']', metaKey: true }), b))).toBe(false);
    expect(next.bindings.some((b) => matchesShortcutBinding(keydown({ key: 'ArrowRight', shiftKey: true }), b))).toBe(false);
    const { markRead } = inboxThreadShortcuts.shortcuts;
    expect(markRead.bindings.some((b) => matchesShortcutBinding(keydown({ key: 'e' }), b))).toBe(true);
    expect(markRead.bindings.some((b) => matchesShortcutBinding(keydown({ key: 'e', ctrlKey: true }), b))).toBe(false);
    expect(markRead.bindings.some((b) => matchesShortcutBinding(keydown({ key: 'e', altKey: true }), b))).toBe(false);
    // Shift is part of the key: E is not Shift+E (Archive), O is not Shift+O (Artifacts).
    const { archive, openNewest, artifacts } = inboxThreadShortcuts.shortcuts;
    expect(markRead.bindings.some((b) => matchesShortcutBinding(keydown({ key: 'E', code: 'KeyE', shiftKey: true }), b))).toBe(false);
    expect(archive.bindings.some((b) => matchesShortcutBinding(keydown({ key: 'E', code: 'KeyE', shiftKey: true }), b))).toBe(true);
    expect(openNewest.bindings.some((b) => matchesShortcutBinding(keydown({ key: 'O', code: 'KeyO', shiftKey: true }), b))).toBe(false);
    expect(artifacts.bindings.some((b) => matchesShortcutBinding(keydown({ key: 'O', code: 'KeyO', shiftKey: true }), b))).toBe(true);
    // R is Reply, Shift+R Refresh; ⌘⇧R and Ctrl+Shift+R stay the browser's hard reload.
    const { reply } = inboxThreadShortcuts.shortcuts;
    const { refresh } = inboxAppShortcuts.shortcuts;
    expect(reply.bindings.some((b) => matchesShortcutBinding(keydown({ key: 'r', code: 'KeyR' }), b))).toBe(true);
    expect(reply.bindings.some((b) => matchesShortcutBinding(keydown({ key: 'R', code: 'KeyR', shiftKey: true }), b))).toBe(false);
    expect(refresh.bindings.some((b) => matchesShortcutBinding(keydown({ key: 'R', code: 'KeyR', shiftKey: true }), b))).toBe(true);
    expect(refresh.bindings.some((b) => matchesShortcutBinding(keydown({ key: 'r', code: 'KeyR' }), b))).toBe(false);
    for (const mod of [{ metaKey: true }, { ctrlKey: true }]) expect(refresh.bindings.some((b) => matchesShortcutBinding(keydown({ key: 'R', code: 'KeyR', shiftKey: true, ...mod }), b))).toBe(false);
  });

  test('letters work on a non-Latin layout (the physical key), a Latin layout keeps its characters, and ? / stay characters', () => {
    const keydown = (init: KeyboardEventInit) => ({ key: '', code: '', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...init }) as KeyboardEvent;
    const hits = (scope: { lettersByCode?: boolean; shortcuts: Record<string, { bindings: string[] }> }, action: string, init: KeyboardEventInit) =>
      scope.shortcuts[action]!.bindings.some((b) => matchesShortcutBinding(keydown(init), b, scope));
    // Every Inbox scope opts in.
    for (const scope of inboxShortcutRegistry) if (Object.values(scope.shortcuts).some((s) => s.bindings.some((b) => /(^|[+\s])[A-Z]($|\s)/.test(b)))) expect(scope.lettersByCode).toBe(true);
    // Russian: У is on the E key, Щ (Shift) on the O key, Р on the H key.
    expect(hits(inboxThreadShortcuts, 'markRead', { key: 'у', code: 'KeyE' })).toBe(true);
    expect(hits(inboxThreadShortcuts, 'archive', { key: 'У', code: 'KeyE', shiftKey: true })).toBe(true);
    expect(hits(inboxThreadShortcuts, 'artifacts', { key: 'Щ', code: 'KeyO', shiftKey: true })).toBe(true);
    expect(hits(inboxThreadShortcuts, 'snooze', { key: 'р', code: 'KeyH' })).toBe(true);
    // Greek and Hebrew too.
    expect(hits(inboxThreadShortcuts, 'reply', { key: 'ρ', code: 'KeyR' })).toBe(true);
    expect(hits(inboxThreadShortcuts, 'nextThread', { key: 'ח', code: 'KeyJ' })).toBe(true);
    // ⌘K on the K key of a Cyrillic layout opens search; Л alone does not.
    expect(hits(inboxSearchShortcuts, 'openSearch', { key: 'л', code: 'KeyK', metaKey: true })).toBe(true);
    expect(hits(inboxSearchShortcuts, 'openSearch', { key: 'л', code: 'KeyK' })).toBe(false);
    // Punctuation on a letter's key stays punctuation: Dvorak's `>` (Shift+. on KeyE) never archives, its `.` never
    // marks read, its `;` (KeyZ) never undoes; Hebrew's `/` (KeyQ) is Search and never Q.
    expect(hits(inboxThreadShortcuts, 'archive', { key: '>', code: 'KeyE', shiftKey: true })).toBe(false);
    expect(hits(inboxThreadShortcuts, 'markRead', { key: '.', code: 'KeyE' })).toBe(false);
    expect(hits(inboxThreadShortcuts, 'undo', { key: ';', code: 'KeyZ' })).toBe(false);
    expect(hits(inboxThreadShortcuts, 'openItems', { key: '/', code: 'KeyQ' })).toBe(false);
    expect(hits(inboxSearchShortcuts, 'openSearch', { key: '/', code: 'KeyQ' })).toBe(true);
    // AZERTY: the key that types A sits where Q is on a US keyboard. The character wins: it is A, never Q.
    expect(hits(inboxThreadShortcuts, 'openItems', { key: 'a', code: 'KeyQ' })).toBe(false);
    expect(hits(inboxThreadShortcuts, 'undo', { key: 'w', code: 'KeyZ' })).toBe(false);
    // A modifier still stands a letter down on any layout.
    expect(hits(inboxThreadShortcuts, 'markRead', { key: 'у', code: 'KeyE', altKey: true })).toBe(false);
    // `?` and `/` are characters: the physical key of `/` on a US keyboard is not `/` on another layout.
    expect(hits(inboxSearchShortcuts, 'openSearch', { key: '.', code: 'Slash' })).toBe(false);
  });
});
