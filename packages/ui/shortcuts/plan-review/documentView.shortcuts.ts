import { defineShortcutScope } from '../core';
import { createShortcutScopeHook } from '../runtime';

/**
 * Document-chrome view commands shared by plan review and annotate mode.
 *
 * Focus mode is the keyboard entry point to the same view state the document
 * card's `Focus` control drives: both side panels collapse in one press and the
 * previous arrangement comes back on the next one.
 *
 * Edit mode is its sibling: the same chord the card's `Edit` / `Done` control
 * drives, opening the markdown source editor in place and committing back to
 * the viewer — the scroll position survives both directions, so a mid-document
 * fix never costs a scroll to the top and back.
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
    toggleEditMode: {
      description: 'Toggle edit mode',
      bindings: ['Mod+E'],
      section: 'View',
      hint: 'Opens the markdown source editor in place, keeping your scroll position; press again to commit your edits and return to annotating.',
      displayOrder: 20,
      preventDefault: true,
    },
  },
});

export const useDocumentViewShortcuts = createShortcutScopeHook(documentViewShortcuts);
