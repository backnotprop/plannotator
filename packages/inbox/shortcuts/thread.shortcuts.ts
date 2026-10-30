import { defineShortcutScope } from '@plannotator/ui/shortcuts';

/**
 * The thread's keys. Mark read and Undo (App.tsx) also act on the list's
 * focused row; the rest act on the open thread (Thread.tsx). Every single key
 * stands down while typing, while an input method composes, under a dialog or
 * menu, and when single-key shortcuts are off (guards.ts `bareKeyAllowed`).
 */
export const inboxThreadShortcuts = defineShortcutScope({
  id: 'inbox-thread',
  title: 'Thread',
  shortcuts: {
    markRead: {
      description: 'Mark read, or move back',
      bindings: ['E'],
      section: 'List',
      hint: 'The row the keyboard is on, else the open thread. Only where something waits on you.',
      preventDefault: true,
      displayOrder: 5,
    },
    undo: {
      description: 'Undo',
      bindings: ['Z'],
      section: 'List',
      hint: 'While the toast shows Undo.',
      preventDefault: true,
      displayOrder: 6,
    },
    reply: {
      description: 'Reply',
      bindings: ['R'],
      section: 'Thread',
      hint: 'Opens the reply box (or the kept draft) with the caret in it. From a file too.',
      preventDefault: true,
      displayOrder: 0,
    },
    send: {
      // The reply box's and compose's own keydown (Thread.tsx, ComposeDialog.tsx) match this binding.
      description: 'Send',
      bindings: ['Mod+Enter'],
      section: 'Thread',
      hint: 'In the reply box or a new message.',
      preventDefault: true,
      displayOrder: 1,
    },
    // J / K are threads, Shift+J / Shift+K messages (approval "inbox-keyboard-shortcuts", J/K swap addendum
    // 2026-10-27: the owner moves between threads far more often than between messages; Gmail and Superhuman agree).
    nextThread: {
      // App.tsx: the list's order as shown, folded Quiet left out; no wrap; replaces the thread in history. With no
      // thread open, J / K move along the list's rows as ↓ ↑ do (nothing opens).
      description: 'Next thread',
      bindings: ['J'],
      section: 'Thread',
      hint: 'With a thread open, the one below opens as Enter opens it; Back still goes to the list. Else the next row.',
      preventDefault: true,
      displayOrder: 2,
    },
    previousThread: {
      description: 'Previous thread',
      bindings: ['K'],
      section: 'Thread',
      preventDefault: true,
      displayOrder: 3,
    },
    nextMessage: {
      description: 'Next message',
      bindings: ['Shift+J'],
      section: 'Thread',
      hint: 'From the list too: focus moves into the open thread.',
      preventDefault: true,
      displayOrder: 3.1,
    },
    previousMessage: {
      description: 'Previous message',
      bindings: ['Shift+K'],
      section: 'Thread',
      preventDefault: true,
      displayOrder: 3.2,
    },
    firstNew: {
      description: 'First new message',
      bindings: ['N'],
      section: 'Thread',
      preventDefault: true,
      displayOrder: 4,
    },
    openNewest: {
      description: 'Open the newest file',
      bindings: ['O'],
      section: 'Thread',
      hint: 'In the view you last chose; then ] and [ step through the others.',
      preventDefault: true,
      displayOrder: 5,
    },
    fullScreen: {
      // Thread.tsx: never saved as the view files open in (only the Full screen button is a choice).
      description: 'Full screen',
      bindings: ['F'],
      section: 'Thread',
      hint: 'The open file, else the newest one. F again, or Escape, goes back.',
      preventDefault: true,
      displayOrder: 6,
    },
    close: {
      // App.tsx: a guided review, then the Artifacts view, then the thread.
      description: 'Close, one layer at a time',
      bindings: ['Escape'],
      section: 'Everywhere',
      displayOrder: 9,
    },
  },
});
