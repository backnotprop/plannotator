/**
 * The Inbox's keys in the shared registry (shortcuts/): a surface like plan
 * review's and code review's. What would regress: a binding the registry
 * cannot read (it would never fire), two scopes with one id (one would shadow
 * the other in a help list), the full-screen chord drifting from plan
 * review's, or a new bare letter slipping in (the owner's rule: none until the
 * shared shortcut system lists them; E and Z predate it).
 */
import { describe, expect, test } from 'bun:test';
import { htmlAnnotateShortcuts, listRegistryShortcuts, matchesShortcutBinding, validateShortcutRegistry } from '@plannotator/ui/shortcuts';
import { inboxFileViewerShortcuts, inboxShortcutRegistry, inboxSurface, inboxThreadShortcuts } from './shortcuts';

describe('the Inbox surface', () => {
  test('validates: every binding normalized, every scope id unique and the Inbox’s own', () => {
    expect(validateShortcutRegistry(inboxShortcutRegistry)).toEqual([]);
    const ids = inboxShortcutRegistry.map((scope) => scope.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.startsWith('inbox-')).toBe(true);
    expect(inboxSurface.registry).toBe(inboxShortcutRegistry);
  });

  test('the only bare letters are E and Z (Mark read, Undo)', () => {
    const letters = listRegistryShortcuts(inboxShortcutRegistry)
      .flatMap((entry) => entry.bindings)
      .filter((binding) => /^[A-Z]$/.test(binding));
    expect(letters.sort()).toEqual(['E', 'Z']);
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
