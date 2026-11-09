import { defineShortcutScope } from '../core';
import { createShortcutScopeHook } from '../runtime';

/**
 * Moving around the repository in code review (approved design record
 * "review-explorer", step 3). VS Code's own default keys per system, so a
 * reviewer's hands already know them. None of them takes a key code review
 * used before; ⌘P / Ctrl+P is the browser's Print, replaced here in code
 * review only.
 */
export const reviewExplorerShortcuts = defineShortcutScope({
  id: 'review-explorer',
  title: 'Go to',
  shortcuts: {
    goToFile: {
      description: 'Go to File',
      bindings: ['Mod+P'],
      section: 'Go to',
      hint: 'Fuzzy search over every file of the repository at the revision the diff reads. Changed files are marked and win ties; with nothing typed, the files you opened last.',
      preventDefault: true,
      displayOrder: 10,
    },
    goToDefinition: {
      description: 'Go to Definition',
      bindings: ['F12', 'Mod+F12'],
      section: 'Go to',
      hint: 'The symbol under the pointer (or the last one you clicked). One clear definition opens its file at the line; several open the references panel. Mod+F12 is for browsers that keep F12 for their developer tools. Needs the local checkout.',
      preventDefault: true,
      displayOrder: 20,
    },
    goToReferences: {
      description: 'Go to References',
      bindings: ['Shift+F12'],
      section: 'Go to',
      hint: 'Opens the references panel for the symbol under the pointer. A result opens its file at the line.',
      preventDefault: true,
      displayOrder: 30,
    },
    navigateBack: {
      description: 'Go back',
      bindings: ['Ctrl+-'],
      platformBindings: {
        mac: ['Ctrl+-'],
        windows: ['Alt+ArrowLeft'],
        linux: ['Ctrl+Alt+-'],
      },
      section: 'Go to',
      hint: 'Back to where the last jump (Go to File, Go to Definition, a reference) started. Stays inside the review.',
      preventDefault: true,
      displayOrder: 40,
    },
    navigateForward: {
      description: 'Go forward',
      bindings: ['Ctrl+Shift+-'],
      platformBindings: {
        mac: ['Ctrl+Shift+-'],
        windows: ['Alt+ArrowRight'],
        linux: ['Ctrl+Shift+-'],
      },
      section: 'Go to',
      displayOrder: 50,
      preventDefault: true,
    },
    nextChange: {
      description: 'Next change',
      bindings: ['Alt+F5'],
      section: 'Go to',
      hint: 'The next run of changed lines in the open file; past the last one, the next file with changes.',
      preventDefault: true,
      displayOrder: 60,
    },
    previousChange: {
      description: 'Previous change',
      bindings: ['Shift+Alt+F5'],
      section: 'Go to',
      preventDefault: true,
      displayOrder: 70,
    },
  },
});

export const useReviewExplorerShortcuts = createShortcutScopeHook(reviewExplorerShortcuts);
