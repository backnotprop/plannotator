import { defineShortcutScope } from '../core';
import { createShortcutScopeHook } from '../runtime';

// Shift+digit rather than mnemonic letters: bare letters are swallowed by
// type-to-comment, bare digits by the label picker, Mod+digit by the browser's
// tab switching, and Mod+Shift+3/4 by macOS screenshots. Follows the toolstrip
// left to right.
export const annotationModeShortcuts = defineShortcutScope({
  id: 'annotation-mode',
  title: 'Annotation Mode',
  shortcuts: {
    selectMarkupMode: {
      description: 'Markup mode',
      bindings: ['Shift+1'],
      section: 'Annotations',
      hint: 'Selecting text opens the annotation toolbar.',
      preventDefault: true,
      displayOrder: 1,
    },
    selectCommentMode: {
      description: 'Comment mode',
      bindings: ['Shift+2'],
      section: 'Annotations',
      hint: 'Selecting text opens the comment editor.',
      preventDefault: true,
      displayOrder: 2,
    },
    selectRedlineMode: {
      description: 'Redline mode',
      bindings: ['Shift+3'],
      section: 'Annotations',
      hint: 'Selecting text marks it for deletion.',
      preventDefault: true,
      displayOrder: 3,
    },
    selectQuickLabelMode: {
      description: 'Label mode',
      bindings: ['Shift+4'],
      section: 'Annotations',
      hint: 'Selecting text opens the quick label picker.',
      preventDefault: true,
      displayOrder: 4,
    },
  },
});

export const useAnnotationModeShortcuts = createShortcutScopeHook(annotationModeShortcuts);
