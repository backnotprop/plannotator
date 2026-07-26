import { useCallback } from 'react';
import type React from 'react';
import { useConfigValue } from '../config';
import {
  COMPOSER_KEYMAPS,
  composerAskAIHint,
  composerSubmitHint,
  resolveComposerIntent,
} from '../utils/composerKeymap';

export interface ComposerKeyOptions {
  onSubmit: () => void;
  /** Omit on composers without an Ask AI action — Mod+Enter then submits. */
  onAskAI?: () => void;
  /** Escape, passed through un-defaulted so each surface keeps its own semantics. */
  onCancel?: (event: React.KeyboardEvent<HTMLElement>) => void;
  canSubmit: boolean;
}

/**
 * Keydown handler for a text composer, honoring the `composerSubmitKey` setting.
 *
 * A React handler rather than a `useShortcutScope` window listener: composers
 * are portaled and nested (popover inside viewer inside app), and the shortcut
 * engine has no cross-scope arbitration — see the note in shortcuts/runtime.ts.
 */
export function useComposerKeys({
  onSubmit,
  onAskAI,
  onCancel,
  canSubmit,
}: ComposerKeyOptions): (event: React.KeyboardEvent<HTMLElement>) => void {
  const submitKey = useConfigValue('composerSubmitKey');

  return useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      if (event.key === 'Escape') {
        onCancel?.(event);
        return;
      }

      const intent = resolveComposerIntent(event.nativeEvent, COMPOSER_KEYMAPS[submitKey], {
        canSubmit,
        canAskAI: !!onAskAI,
      });
      if (!intent) return;

      // The composer consumed the key: keep it away from the app-level
      // Mod+Enter that approves the plan / sends the review. Those listeners
      // skip INPUT and TEXTAREA targets, but a composer bound to a container
      // also sees keys pressed on its buttons.
      event.preventDefault();
      event.stopPropagation();
      if (intent === 'askAI') onAskAI?.();
      else onSubmit();
    },
    [canSubmit, onAskAI, onCancel, onSubmit, submitKey],
  );
}

/** Keycap hint for the active submit key, e.g. `⌘↵` or `↵`. */
export function useComposerSubmitHint(): string {
  return composerSubmitHint(useConfigValue('composerSubmitKey'));
}

/** Keycap hint for Ask AI, or null while the active keymap leaves it unbound. */
export function useComposerAskAIHint(): string | null {
  return composerAskAIHint(useConfigValue('composerSubmitKey'));
}
