import { describe, expect, it } from 'bun:test';
import { COMPOSER_KEYMAPS, composerAskAIHint, resolveComposerIntent } from './composerKeymap';

function keyEvent(overrides: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
  return {
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    isComposing: false,
    keyCode: 13,
    code: 'Enter',
    ...overrides,
  } as KeyboardEvent;
}

const ENTER = keyEvent({ key: 'Enter' });
const MOD_ENTER = keyEvent({ key: 'Enter', metaKey: true });
const SHIFT_ENTER = keyEvent({ key: 'Enter', shiftKey: true });

const READY = { canSubmit: true, canAskAI: true };
const NO_AI = { canSubmit: true, canAskAI: false };

describe('resolveComposerIntent', () => {
  describe("'mod-enter' keymap", () => {
    const keymap = COMPOSER_KEYMAPS['mod-enter'];

    it('submits on Mod+Enter and leaves Enter to the textarea', () => {
      expect(resolveComposerIntent(MOD_ENTER, keymap, READY)).toBe('submit');
      expect(resolveComposerIntent(ENTER, keymap, READY)).toBeNull();
      expect(resolveComposerIntent(SHIFT_ENTER, keymap, READY)).toBeNull();
    });

    it('never asks AI, even where Ask AI is available', () => {
      expect(resolveComposerIntent(MOD_ENTER, keymap, READY)).toBe('submit');
    });
  });

  describe("'enter' keymap", () => {
    const keymap = COMPOSER_KEYMAPS.enter;

    it('submits on Enter and asks AI on Mod+Enter', () => {
      expect(resolveComposerIntent(ENTER, keymap, READY)).toBe('submit');
      expect(resolveComposerIntent(MOD_ENTER, keymap, READY)).toBe('askAI');
    });

    it('leaves Shift+Enter to the textarea for a newline', () => {
      expect(resolveComposerIntent(SHIFT_ENTER, keymap, READY)).toBeNull();
    });

    it('falls back to submit on Mod+Enter where Ask AI is unavailable', () => {
      expect(resolveComposerIntent(MOD_ENTER, keymap, NO_AI)).toBe('submit');
    });

    it('yields to the textarea while the composer cannot submit', () => {
      const empty = { canSubmit: false, canAskAI: false };
      expect(resolveComposerIntent(ENTER, keymap, empty)).toBeNull();
      expect(resolveComposerIntent(MOD_ENTER, keymap, empty)).toBeNull();
    });

    it('still asks AI while the composer cannot submit but AI is available', () => {
      expect(resolveComposerIntent(MOD_ENTER, keymap, { canSubmit: false, canAskAI: true })).toBe('askAI');
    });
  });

  it('hints Ask AI only where the keymap binds it', () => {
    expect(composerAskAIHint('mod-enter')).toBeNull();
    expect(composerAskAIHint('enter')).toBeTruthy();
  });

  it('ignores Enter that commits an IME candidate', () => {
    const keymap = COMPOSER_KEYMAPS.enter;
    expect(resolveComposerIntent(keyEvent({ key: 'Enter', isComposing: true }), keymap, READY)).toBeNull();
    expect(resolveComposerIntent(keyEvent({ key: 'Enter', keyCode: 229 }), keymap, READY)).toBeNull();
  });
});
