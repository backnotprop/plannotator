import { createShortcutScopeHook, defineShortcutScope } from '@plannotator/ui/shortcuts';

/**
 * Keys inside a Call tree (the tree has keyboard focus). They are bound to
 * the tree element, not the window, and stop there, so the file tree's
 * arrow keys and the All files `C` never see them. Enter opens the line and
 * C comments: the owner's decision of 2026-11-10 (the Paths cards keep their
 * own click-to-comment).
 */
export const reviewCallTreeShortcuts = defineShortcutScope({
  id: 'review-call-tree',
  title: 'Call tree',
  shortcuts: {
    moveDown: {
      description: 'Move down',
      bindings: ['ArrowDown'],
      section: 'Call tree',
      hint: 'When the Call tree has focus.',
      preventDefault: true,
      displayOrder: 10,
    },
    moveUp: {
      description: 'Move up',
      bindings: ['ArrowUp'],
      section: 'Call tree',
      preventDefault: true,
      displayOrder: 20,
    },
    fold: {
      description: 'Fold',
      bindings: ['ArrowLeft'],
      section: 'Call tree',
      hint: 'On a folded or childless row, moves to its caller.',
      preventDefault: true,
      displayOrder: 30,
    },
    unfold: {
      description: 'Unfold',
      bindings: ['ArrowRight'],
      section: 'Call tree',
      hint: 'On an open row, moves to its first call.',
      preventDefault: true,
      displayOrder: 40,
    },
    open: {
      description: 'Open in diff',
      bindings: ['Enter'],
      section: 'Call tree',
      hint: 'Opens the row\'s file at its line.',
      preventDefault: true,
      displayOrder: 50,
    },
    comment: {
      description: 'Comment',
      bindings: ['C'],
      section: 'Call tree',
      hint: 'The comment lands on the row\'s file line, like a line comment.',
      preventDefault: true,
      displayOrder: 60,
    },
    back: {
      description: 'Go back',
      bindings: ['Escape'],
      section: 'Call tree',
      hint: 'A tree opened from a hunk returns to that hunk.',
      displayOrder: 70,
    },
  },
});

export const useReviewCallTreeShortcuts = createShortcutScopeHook(reviewCallTreeShortcuts);
