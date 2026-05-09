import { defineShortcutScope } from '../core';
import { createShortcutScopeHook } from '../runtime';

export const reviewTourDialogShortcuts = defineShortcutScope({
  id: 'review-tour-dialog',
  title: 'Tour Dialog',
  shortcuts: {
    close: {
      description: 'Close tour',
      bindings: ['Escape'],
      section: 'Tour',
      hint: 'Available while the code tour dialog is open.',
      displayOrder: 10,
    },
  },
});

export const useReviewTourDialogShortcuts = createShortcutScopeHook(reviewTourDialogShortcuts);
