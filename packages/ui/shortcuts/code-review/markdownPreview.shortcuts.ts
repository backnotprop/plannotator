import { defineShortcutScope } from '../core';
import { createShortcutScopeHook } from '../runtime';

export const reviewMarkdownPreviewShortcuts = defineShortcutScope({
  id: 'review-markdown-preview',
  title: 'Markdown Preview',
  shortcuts: {
    toggleFilePreview: {
      description: 'Switch the current Markdown file between source and preview',
      bindings: ['P'],
      section: 'Markdown Preview',
      hint: 'Markdown files only: the open file, or in All files the file at the top of the view.',
      displayOrder: 10,
    },
    toggleAllPreviews: {
      description: 'Preview every Markdown file, or show them all as source',
      bindings: ['Shift+P'],
      section: 'Markdown Preview',
      hint: 'Same as the "Preview .md" button next to Split | Unified; resets each file to it.',
      displayOrder: 20,
    },
  },
});

export const useReviewMarkdownPreviewShortcuts = createShortcutScopeHook(reviewMarkdownPreviewShortcuts);
