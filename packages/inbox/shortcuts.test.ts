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
import { buildInboxShortcutRegistry, INBOX_SHORTCUT_EXTRAS, inboxFileViewerShortcuts, inboxShortcutRegistry, inboxSurface, inboxThreadShortcuts, isBareBinding, type InboxShortcutExtras } from './shortcuts';

const COMBOS: InboxShortcutExtras[] = [false, true].flatMap((slashSearch) =>
  [false, true].flatMap((goTo) => [false, true].map((readFromList) => ({ slashSearch, goTo, readFromList }))),
);

/** The single keys the owner approved; each extra adds its own. */
function approvedBare(extras: InboxShortcutExtras): string[] {
  const core = ['E', 'Z', 'R', 'J', 'K', 'Shift+J', 'Shift+K', 'N', 'O', 'F', '?', '[', ']'];
  return [...core, ...(extras.slashSearch ? ['/'] : []), ...(extras.goTo ? ['G I', 'G B', 'G S'] : [])].sort();
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
  });
});
