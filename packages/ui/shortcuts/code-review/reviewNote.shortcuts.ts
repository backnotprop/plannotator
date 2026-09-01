import { defineShortcutScope } from '../core';

/** The "Add a note" field on the code review Send control (and its compact
 * dialog). The field is multi-line, so a bare Enter is a newline and the send
 * chord is Mod+Enter. The handlers are local to the input; this scope exists so
 * the chords show up in the in-app help modal and the generated docs, the same
 * way the comment editor's chords do. */
export const reviewNoteShortcuts = defineShortcutScope({
  id: 'review-note',
  title: 'Quick Note',
  shortcuts: {
    submit: {
      description: 'Send the note with your annotations',
      bindings: ['Mod+Enter'],
      section: 'Actions',
      hint: 'Available while the Send control’s note field is open. Enter inserts a newline.',
      displayOrder: 12,
    },
    cancel: {
      description: 'Close the note field without sending',
      bindings: ['Escape'],
      section: 'Actions',
      hint: 'The typed note is kept for the rest of the session but is not sent.',
      displayOrder: 14,
    },
  },
});
