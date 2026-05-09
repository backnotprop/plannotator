import { defineShortcutScope } from '../core';
import { createShortcutScopeHook } from '../runtime';

export const reviewFileTreeShortcuts = defineShortcutScope({
  id: 'review-file-tree',
  title: 'File Navigation',
  shortcuts: {
    nextFile: {
      description: 'Next file',
      bindings: ['J', 'ArrowDown'],
      section: 'File Navigation',
      displayOrder: 10,
    },
    prevFile: {
      description: 'Previous file',
      bindings: ['K', 'ArrowUp'],
      section: 'File Navigation',
      displayOrder: 20,
    },
    firstFile: {
      description: 'First file',
      bindings: ['Home'],
      section: 'File Navigation',
      displayOrder: 30,
    },
    lastFile: {
      description: 'Last file',
      bindings: ['End'],
      section: 'File Navigation',
      displayOrder: 40,
    },
  },
});

export const useReviewFileTreeShortcuts = createShortcutScopeHook(reviewFileTreeShortcuts);
