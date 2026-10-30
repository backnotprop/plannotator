/**
 * The registry's per-system keys and the two tokens code review's navigation
 * keys need (approved design record "review-explorer", step 3).
 *
 * Regressions guarded:
 *  - `Ctrl` (the physical Control key) matching ⌘, or `Mod` no longer
 *    matching both ⌘ and Ctrl (every existing key depends on it);
 *  - `-` not matching with Shift held (⌃⇧- is Forward);
 *  - a system's own bindings not replacing the shared ones, or the docs not
 *    saying which key belongs to which system;
 *  - a new code review key taking a key code review already used.
 */
import { describe, expect, it } from 'bun:test';
import {
  formatShortcutBindingTokens,
  formatShortcutDefinitionText,
  matchesShortcutBinding,
  resolveShortcutBindings,
  reviewExplorerShortcuts,
  listRegistryShortcuts,
  validateShortcutRegistry,
} from './shortcuts';
import { reviewSettingsShortcutRegistry } from '../review-editor/shortcuts';

function key(init: Partial<KeyboardEvent> & { key: string; code?: string }): KeyboardEvent {
  return { ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, code: '', ...init } as KeyboardEvent;
}

describe('Ctrl and -', () => {
  it('Ctrl is the Control key only; Mod stays ⌘ or Ctrl', () => {
    expect(matchesShortcutBinding(key({ key: '-', code: 'Minus', ctrlKey: true }), 'Ctrl+-')).toBe(true);
    expect(matchesShortcutBinding(key({ key: '-', code: 'Minus', metaKey: true }), 'Ctrl+-')).toBe(false);
    expect(matchesShortcutBinding(key({ key: '-', code: 'Minus' }), 'Ctrl+-')).toBe(false);
    expect(matchesShortcutBinding(key({ key: 'p', code: 'KeyP', metaKey: true }), 'Mod+P')).toBe(true);
    expect(matchesShortcutBinding(key({ key: 'p', code: 'KeyP', ctrlKey: true }), 'Mod+P')).toBe(true);
  });

  it('- matches by its key code, so Shift (which types _) still reads as it', () => {
    expect(matchesShortcutBinding(key({ key: '_', code: 'Minus', ctrlKey: true, shiftKey: true }), 'Ctrl+Shift+-')).toBe(true);
    expect(matchesShortcutBinding(key({ key: '_', code: 'Minus', ctrlKey: true, shiftKey: true }), 'Ctrl+-')).toBe(false);
    expect(matchesShortcutBinding(key({ key: '-', code: 'Minus', ctrlKey: true, altKey: true }), 'Ctrl+Alt+-')).toBe(true);
  });

  it('keycaps', () => {
    expect(formatShortcutBindingTokens('Ctrl+Shift+-', 'mac')).toEqual(['⌃', '⇧', '-']);
    expect(formatShortcutBindingTokens('Ctrl+Alt+-', 'non-mac')).toEqual(['Ctrl', 'Alt', '-']);
  });
});

describe('per-system bindings', () => {
  const back = reviewExplorerShortcuts.shortcuts.navigateBack;
  it("a system's own keys replace the shared ones", () => {
    expect(resolveShortcutBindings(back, 'mac')).toEqual(['Ctrl+-']);
    expect(resolveShortcutBindings(back, 'windows')).toEqual(['Alt+ArrowLeft']);
    expect(resolveShortcutBindings(back, 'linux')).toEqual(['Ctrl+Alt+-']);
    expect(resolveShortcutBindings(reviewExplorerShortcuts.shortcuts.goToFile, 'windows')).toEqual(['Mod+P']);
  });

  it('the docs name each system when the keys differ', () => {
    expect(formatShortcutDefinitionText(back)).toBe('Ctrl+- (macOS) · Alt+ArrowLeft (Windows) · Ctrl+Alt+- (Linux)');
    expect(formatShortcutDefinitionText(reviewExplorerShortcuts.shortcuts.goToFile)).toBe('Cmd/Ctrl+P');
  });
});

describe('the code review registry', () => {
  it('validates', () => {
    expect(validateShortcutRegistry(reviewSettingsShortcutRegistry)).toEqual([]);
  });

  it('no explorer key is a key another code review scope already binds', () => {
    const explorerIds = new Set(listRegistryShortcuts(reviewSettingsShortcutRegistry)
      .filter((entry) => entry.scopeId === 'review-explorer')
      .flatMap((entry) => (['mac', 'windows', 'linux'] as const).flatMap((os) => resolveShortcutBindings(entry, os))));
    const others = listRegistryShortcuts(reviewSettingsShortcutRegistry)
      .filter((entry) => entry.scopeId !== 'review-explorer')
      .flatMap((entry) => (['mac', 'windows', 'linux'] as const).flatMap((os) => resolveShortcutBindings(entry, os)));
    for (const binding of others) expect(explorerIds.has(binding)).toBe(false);
  });
});
