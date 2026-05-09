import { defineShortcutScope } from '../core';
import { createShortcutScopeHook } from '../runtime';

export const annotationToolbarShortcuts = defineShortcutScope({
  id: 'annotation-toolbar',
  title: 'Annotation Toolbar',
  shortcuts: {
    typeToComment: {
      description: 'Start comment',
      bindings: ['A-Z'],
      section: 'Annotations',
      hint: 'Typing a letter opens the comment editor with that character.',
      displayOrder: 10,
    },
    applyQuickLabel: {
      description: 'Apply toolbar label',
      bindings: ['Alt+1-0'],
      section: 'Annotations',
      hint: 'Applies the matching preset label while the annotation toolbar is open.',
      displayOrder: 20,
    },
    applyQuickLabelFromPicker: {
      description: 'Apply picker label',
      bindings: ['1-0'],
      section: 'Annotations',
      hint: 'Available while the quick label picker is open.',
      displayOrder: 30,
    },
    close: {
      description: 'Close toolbar',
      bindings: ['Escape'],
      section: 'Annotations',
      hint: 'Available while the annotation toolbar is open.',
      displayOrder: 40,
    },
  },
});

export const useAnnotationToolbarShortcuts = createShortcutScopeHook(annotationToolbarShortcuts);
