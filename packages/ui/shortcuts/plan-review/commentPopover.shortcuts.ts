import { defineShortcutScope } from '../core';

export const commentPopoverShortcuts = defineShortcutScope({
  id: 'comment-popover',
  title: 'Comment Editor',
  shortcuts: {
    submit: {
      description: 'Submit comment',
      bindings: ['Mod+Enter'],
      section: 'Annotations',
      displayOrder: 30,
    },
    cancel: {
      description: 'Close comment',
      bindings: ['Escape'],
      section: 'Annotations',
      hint: 'Available while the comment editor is open.',
      displayOrder: 40,
    },
    skillMenuOpen: {
      description: 'Reference an agent skill (opens the skill menu)',
      bindings: ['/', '$'],
      section: 'Annotations',
      hint: 'Type / or $ at the start of a word in the comment editor to open the skill menu; keep typing to filter. Nothing is preselected: Enter stays a newline until you pick a row with the arrow keys (or click one), then Enter or Tab inserts it. Escape dismisses the menu.',
      displayOrder: 50,
    },
  },
});
