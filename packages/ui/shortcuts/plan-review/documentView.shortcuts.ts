import { defineShortcutScope } from '../core';
import { createShortcutScopeHook } from '../runtime';

/**
 * Document-chrome view commands shared by plan review and annotate mode.
 *
 * Focus mode is the keyboard entry point to the same view state the document
 * card's `Focus` control drives: both side panels collapse in one press and the
 * previous arrangement comes back on the next one.
 */
export const documentViewShortcuts = defineShortcutScope({
  id: 'document-view',
  title: 'Document View',
  shortcuts: {
    toggleFocusMode: {
      description: 'Toggle focus mode',
      bindings: ['Mod+.'],
      section: 'View',
      hint: 'Collapses the Contents sidebar and the right-hand panel together; press again to restore whatever was open before.',
      displayOrder: 10,
      preventDefault: true,
    },
  },
});

export const useDocumentViewShortcuts = createShortcutScopeHook(documentViewShortcuts);
