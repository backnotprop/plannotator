import { describe, expect, test } from 'bun:test';
import { htmlAnnotateShortcuts, listRegistryShortcuts, matchesShortcutBinding, validateShortcutRegistry } from '@plannotator/ui/shortcuts';
import { buildInboxShortcutRegistry, INBOX_SHORTCUT_EXTRAS, inboxAppShortcuts, inboxFileViewerShortcuts, inboxSearchShortcuts, inboxShortcutRegistry, inboxSurface, inboxThreadShortcuts, isBareBinding, type InboxShortcutExtras } from './shortcuts';

const COMBOS: InboxShortcutExtras[] = [false, true].flatMap((slashSearch) =>
  [false, true].flatMap((goTo) => [false, true].map((readFromList) => ({ slashSearch, goTo, readFromList }))),
);

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
      const firsts = new Set(bare.filter((b) => b.includes(' ')).map((b) => b.split(' ')[0]));
      for (const first of firsts) expect(bare).not.toContain(first);
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
    expect(next.bindings.some((b) => matchesShortcutBinding(keydown({ key: ']', metaKey: true }), b))).toBe(false);
    expect(next.bindings.some((b) => matchesShortcutBinding(keydown({ key: 'ArrowRight', shiftKey: true }), b))).toBe(false);
    const { markRead } = inboxThreadShortcuts.shortcuts;
    expect(markRead.bindings.some((b) => matchesShortcutBinding(keydown({ key: 'e' }), b))).toBe(true);
    expect(markRead.bindings.some((b) => matchesShortcutBinding(keydown({ key: 'e', ctrlKey: true }), b))).toBe(false);
    expect(markRead.bindings.some((b) => matchesShortcutBinding(keydown({ key: 'e', altKey: true }), b))).toBe(false);
    const { archive, openNewest, artifacts } = inboxThreadShortcuts.shortcuts;
    expect(markRead.bindings.some((b) => matchesShortcutBinding(keydown({ key: 'E', code: 'KeyE', shiftKey: true }), b))).toBe(false);
    expect(archive.bindings.some((b) => matchesShortcutBinding(keydown({ key: 'E', code: 'KeyE', shiftKey: true }), b))).toBe(true);
    expect(openNewest.bindings.some((b) => matchesShortcutBinding(keydown({ key: 'O', code: 'KeyO', shiftKey: true }), b))).toBe(false);
    expect(artifacts.bindings.some((b) => matchesShortcutBinding(keydown({ key: 'O', code: 'KeyO', shiftKey: true }), b))).toBe(true);
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
    for (const scope of inboxShortcutRegistry) if (Object.values(scope.shortcuts).some((s) => s.bindings.some((b) => /(^|[+\s])[A-Z]($|\s)/.test(b)))) expect(scope.lettersByCode).toBe(true);
    expect(hits(inboxThreadShortcuts, 'markRead', { key: 'у', code: 'KeyE' })).toBe(true);
    expect(hits(inboxThreadShortcuts, 'archive', { key: 'У', code: 'KeyE', shiftKey: true })).toBe(true);
    expect(hits(inboxThreadShortcuts, 'artifacts', { key: 'Щ', code: 'KeyO', shiftKey: true })).toBe(true);
    expect(hits(inboxThreadShortcuts, 'snooze', { key: 'р', code: 'KeyH' })).toBe(true);
    expect(hits(inboxThreadShortcuts, 'reply', { key: 'ρ', code: 'KeyR' })).toBe(true);
    expect(hits(inboxThreadShortcuts, 'nextThread', { key: 'ח', code: 'KeyJ' })).toBe(true);
    expect(hits(inboxSearchShortcuts, 'openSearch', { key: 'л', code: 'KeyK', metaKey: true })).toBe(true);
    expect(hits(inboxSearchShortcuts, 'openSearch', { key: 'л', code: 'KeyK' })).toBe(false);
    expect(hits(inboxThreadShortcuts, 'archive', { key: '>', code: 'KeyE', shiftKey: true })).toBe(false);
    expect(hits(inboxThreadShortcuts, 'markRead', { key: '.', code: 'KeyE' })).toBe(false);
    expect(hits(inboxThreadShortcuts, 'undo', { key: ';', code: 'KeyZ' })).toBe(false);
    expect(hits(inboxThreadShortcuts, 'openItems', { key: '/', code: 'KeyQ' })).toBe(false);
    expect(hits(inboxSearchShortcuts, 'openSearch', { key: '/', code: 'KeyQ' })).toBe(true);
    expect(hits(inboxThreadShortcuts, 'openItems', { key: 'a', code: 'KeyQ' })).toBe(false);
    expect(hits(inboxThreadShortcuts, 'undo', { key: 'w', code: 'KeyZ' })).toBe(false);
    expect(hits(inboxThreadShortcuts, 'markRead', { key: 'у', code: 'KeyE', altKey: true })).toBe(false);
    expect(hits(inboxSearchShortcuts, 'openSearch', { key: '.', code: 'Slash' })).toBe(false);
  });
});
