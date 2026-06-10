import { defineShortcutScope } from '../core';
import { createShortcutScopeHook } from '../runtime';

export const reviewAllFilesDiffShortcuts = defineShortcutScope({
  id: 'review-all-files-diff',
  title: 'All-Files Diff View',
  shortcuts: {
    toggleCollapse: {
      description: 'Collapse / expand current file',
      bindings: ['X'],
      section: 'All-Files View',
      hint: 'Available when the all-files diff panel is active.',
      displayOrder: 10,
    },
    undoCollapse: {
      description: 'Re-expand nearest collapsed file',
      bindings: ['Z'],
      section: 'All-Files View',
      hint: 'Reopens the nearest collapsed file at or above the current position (collapse also fires when toggling viewed).',
      displayOrder: 20,
    },
    addFileComment: {
      description: 'Add file-scoped comment',
      bindings: ['C'],
      section: 'All-Files View',
      hint: 'Opens the file-scoped comment popover for the active file.',
      displayOrder: 30,
    },
    nextFile: {
      description: 'Scroll to next file',
      bindings: [']'],
      section: 'All-Files View',
      hint: 'All-files panel only.',
      displayOrder: 40,
    },
    prevFile: {
      description: 'Scroll to previous file',
      bindings: ['['],
      section: 'All-Files View',
      hint: 'All-files panel only.',
      displayOrder: 50,
    },
  },
});

export const useReviewAllFilesDiffShortcuts = createShortcutScopeHook(reviewAllFilesDiffShortcuts);
