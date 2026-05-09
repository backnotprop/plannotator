import { defineShortcutScope } from '../core';
import { createShortcutScopeHook } from '../runtime';

export const reviewPrCommentsShortcuts = defineShortcutScope({
  id: 'review-pr-comments',
  title: 'PR Comments',
  shortcuts: {
    focusSearch: {
      description: 'Focus PR comments search',
      bindings: ['Mod+Shift+F'],
      section: 'PR Comments',
      hint: 'Available while the PR Comments tab is open in the review sidebar.',
      displayOrder: 10,
    },
  },
});

export const useReviewPrCommentsShortcuts = createShortcutScopeHook(reviewPrCommentsShortcuts);
