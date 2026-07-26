/**
 * Keymap for text composers — comment editors and AI chat inputs.
 *
 * Two modes, selected by the `composerSubmitKey` setting:
 *   'mod-enter' — Mod+Enter submits (Enter inserts a newline).
 *   'enter'     — Enter submits, Shift+Enter inserts a newline, and Mod+Enter
 *                 asks AI on composers that offer it.
 *
 * Bindings are written in the shortcut-registry language and matched with the
 * registry matcher, so there is one place that decides what "Mod+Enter" means.
 */

import type { ComposerSubmitKey } from '@plannotator/core/config-types';
import { matchesShortcutBinding } from '../shortcuts/core';
import { isMac, submitHint } from './platform';

export interface ComposerKeymap {
  submit: string;
  /** null on keymaps where the submit key leaves no room for a second action. */
  askAI: string | null;
  /** Explicit newline binding, for hints and help text. Bare Enter otherwise. */
  newline: string | null;
}

export type ComposerIntent = 'submit' | 'askAI';

export const COMPOSER_KEYMAPS: Record<ComposerSubmitKey, ComposerKeymap> = {
  'mod-enter': { submit: 'Mod+Enter', askAI: null, newline: null },
  enter: { submit: 'Enter', askAI: 'Mod+Enter', newline: 'Shift+Enter' },
};

export interface ComposerCapabilities {
  /** False while the composer is empty, disabled, or mid-stream. */
  canSubmit: boolean;
  /** False on composers without an Ask AI action, or when AI is unavailable. */
  canAskAI: boolean;
}

/**
 * Returns the action a keystroke asks for, or null to leave the event to the
 * textarea. A null return is what makes Shift+Enter (and Enter while the
 * composer can't submit) insert a newline: the caller must not preventDefault.
 */
export function resolveComposerIntent(
  event: KeyboardEvent,
  keymap: ComposerKeymap,
  caps: ComposerCapabilities,
): ComposerIntent | null {
  // An IME candidate is committed with Enter. Under the 'enter' keymap that is
  // the same keystroke as submit, so this guard decides whether CJK input works.
  if (event.isComposing || event.keyCode === 229) return null;

  if (keymap.askAI && matchesShortcutBinding(event, keymap.askAI)) {
    if (caps.canAskAI) return 'askAI';
    // Ask AI unbound here: fall back to submit rather than dead-ending the
    // keystroke users already have in their fingers.
    return caps.canSubmit ? 'submit' : null;
  }

  if (matchesShortcutBinding(event, keymap.submit)) {
    return caps.canSubmit ? 'submit' : null;
  }

  return null;
}

/** Compact keycap hint for the submit action, e.g. `⌘↵` or `↵`. */
export function composerSubmitHint(key: ComposerSubmitKey): string {
  return key === 'enter' ? (isMac ? '↵' : 'Enter') : submitHint;
}

/**
 * Compact keycap hint for the Ask AI action, or null where the keymap leaves it
 * unbound. `submitHint` renders Mod+Enter, the only Ask AI binding in the table.
 */
export function composerAskAIHint(key: ComposerSubmitKey): string | null {
  return COMPOSER_KEYMAPS[key].askAI ? submitHint : null;
}
