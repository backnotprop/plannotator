import { defineShortcutScope } from '../core';
import { createShortcutScopeHook } from '../runtime';

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
