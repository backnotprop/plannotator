import { defineShortcutScope } from '../core';

export const commentPopoverShortcuts = defineShortcutScope({
  id: 'comment-popover',
  title: 'Comment Editor',
  shortcuts: {
    submit: {
      description: 'Submit comment',
      bindings: ['Mod+Enter'],
      section: 'Annotations',
      hint: 'With "Enter sends" enabled in Settings, Enter submits, Shift+Enter inserts a new line, and Mod+Enter asks AI.',
      displayOrder: 30,
    },
    cancel: {
      description: 'Close comment',
      bindings: ['Escape'],
      section: 'Annotations',
      hint: 'Available while the comment editor is open.',
      displayOrder: 40,
    },
  },
});
