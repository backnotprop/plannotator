import { defineShortcutScope } from '../core';
import { createShortcutScopeHook } from '../runtime';

export const reviewAiShortcuts = defineShortcutScope({
  id: 'review-ai',
  title: 'AI Assistant',
  shortcuts: {
    submit: {
      description: 'Send message',
      bindings: ['Mod+Enter'],
      section: 'AI Assistant',
      hint: 'Available in the AI tab and the Ask AI inline input.',
      displayOrder: 10,
    },
    cancel: {
      description: 'Cancel inline AI input',
      bindings: ['Escape'],
      section: 'AI Assistant',
      hint: 'Available in the Ask AI inline input.',
      displayOrder: 20,
    },
  },
});

export const useReviewAiShortcuts = createShortcutScopeHook(reviewAiShortcuts);
