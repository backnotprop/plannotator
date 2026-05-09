import { defineShortcutScope } from '../core';
import { createShortcutScopeHook } from '../runtime';

export const reviewSuggestionModalShortcuts = defineShortcutScope({
  id: 'review-suggestion-modal',
  title: 'Suggestion Editor',
  shortcuts: {
    indent: {
      description: 'Indent (insert spaces)',
      bindings: ['Tab'],
      section: 'Suggestion Editor',
      hint: 'Available in the expanded suggestion editor.',
      displayOrder: 10,
    },
    close: {
      description: 'Close suggestion editor',
      bindings: ['Escape'],
      section: 'Suggestion Editor',
      hint: 'Closes the modal; suggestion text is preserved on the underlying comment.',
      displayOrder: 20,
    },
  },
});

export const useReviewSuggestionModalShortcuts = createShortcutScopeHook(reviewSuggestionModalShortcuts);
