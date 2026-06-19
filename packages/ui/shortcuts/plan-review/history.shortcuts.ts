import { defineShortcutScope } from '../core';
import { createShortcutScopeHook } from '../runtime';

/**
 * Undo/redo shortcut scope for the plan-review surface.
 *
 * `Mod+Z` / `Mod+Shift+Z` (and `Mod+Y`) are gated in `App.tsx`'s global keydown
 * handler so they only fire at the plan-review surface when no other owner is
 * active (CM6 markdown editor, Image Annotator, modals, comment popover). The
 * Image Annotator's own `undo` scope (`imageAnnotator.shortcuts.ts`) takes
 * precedence while the image annotator modal is open.
 */
export const historyShortcuts = defineShortcutScope({
  id: 'history',
  title: 'Undo / Redo',
  shortcuts: {
    undo: {
      description: 'Undo last action',
      bindings: ['Mod+Z'],
      section: 'History',
      hint: 'Reverses the last annotation, comment, code annotation, attachment, checkbox toggle, or identity change. Disabled while editing markdown, the Image Annotator is open, or a modal is visible.',
      preventDefault: true,
      displayOrder: 10,
    },
    redo: {
      description: 'Redo last undone action',
      bindings: ['Mod+Shift+Z', 'Mod+Y'],
      section: 'History',
      hint: 'Re-applies the most recently undone action.',
      preventDefault: true,
      displayOrder: 20,
    },
  },
});

export const useHistoryShortcuts = createShortcutScopeHook(historyShortcuts);
