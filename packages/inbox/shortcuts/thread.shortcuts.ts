import { defineShortcutScope } from '@plannotator/ui/shortcuts';

/**
 * The thread's keys (App.tsx): Mark read and the toast's Undo. Bare letters,
 * so never while typing, in a dialog, menu or list, or in an open file
 * (guards.ts and the handler's `when`).
 */
export const inboxThreadShortcuts = defineShortcutScope({
  id: 'inbox-thread',
  title: 'Thread',
  shortcuts: {
    markRead: {
      description: 'Mark read, or move back',
      bindings: ['E'],
      section: 'Threads',
      hint: 'The row the keyboard is on, else the open thread. Only where something waits on you.',
      preventDefault: true,
      displayOrder: 0,
    },
    undo: {
      description: 'Undo what the toast offers',
      bindings: ['Z'],
      section: 'Threads',
      hint: 'While the toast shows Undo.',
      preventDefault: true,
      displayOrder: 1,
    },
  },
});
