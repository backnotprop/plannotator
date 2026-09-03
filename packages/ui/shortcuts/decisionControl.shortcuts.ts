import { defineShortcutScope } from './core';

/**
 * The header decision control's note composer (shortcuts root, not
 * plan-review/ or code-review/: both apps mount the identical control with
 * identical semantics).
 *
 * Documents ONLY the chords the control actually implements — bindings must
 * match shipped behavior (`DecisionControl.tsx`). Enter is a newline in the
 * note field and must never be documented as submit.
 */
export const decisionControlShortcuts = defineShortcutScope({
  id: 'decision-control',
  title: 'Decision control',
  shortcuts: {
    submitNote: {
      description: 'Send the note with the decision you picked',
      bindings: ['Mod+Enter'],
      section: 'Actions',
      hint: "Available while the decision control's note field is open. Enter inserts a newline.",
      displayOrder: 12,
    },
    closeNote: {
      description: 'Step back to the decision menu, keeping the note',
      bindings: ['Escape'],
      section: 'Actions',
      hint: "Available while the decision control's note field is open.",
      displayOrder: 14,
    },
  },
});
