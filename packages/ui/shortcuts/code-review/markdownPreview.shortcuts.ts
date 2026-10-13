import { defineShortcutScope } from '../core';
import { createShortcutScopeHook } from '../runtime';

export const reviewMarkdownPreviewShortcuts = defineShortcutScope({
  id: 'review-markdown-preview',
  title: 'Markdown Files',
  shortcuts: {
    cycleMarkdownView: {
      description: 'Show the current Markdown file as Source, Changes or Read (next view)',
      bindings: ['P'],
      section: 'Markdown Files',
      hint: 'The open file, or in All files the file at the top of the view. New and deleted files have no Changes view. Markdown files you have not set by hand follow your choice.',
      displayOrder: 10,
    },
  },
});

export const useReviewMarkdownPreviewShortcuts = createShortcutScopeHook(reviewMarkdownPreviewShortcuts);
