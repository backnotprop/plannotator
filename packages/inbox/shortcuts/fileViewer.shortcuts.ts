import { defineShortcutScope, htmlAnnotateShortcuts } from '@plannotator/ui/shortcuts';

/**
 * The keys of an open file (AttachmentPane): beside the thread and full
 * screen. Wired with `useShortcutScope`; when each one stands down is in
 * `guards.ts`, `stepKeyIntent` (stepping.ts) and the Escape ladder
 * (escapeLadder.ts).
 */
export const inboxFileViewerShortcuts = defineShortcutScope({
  id: 'inbox-file-viewer',
  title: 'Open file',
  shortcuts: {
    escape: {
      description: 'Close what is open, then leave full screen',
      bindings: ['Escape'],
      section: 'Files',
      hint: 'One thing per press, innermost first: a menu or the file list, a comment being written (typed words are never lost: you are asked first), the comments drawer, Annotate (HTML goes to Interact), the question about an unsaved comment; then full screen ends and the file is back beside the thread (on a phone, back to the thread). In Interact, an Escape the page uses itself stays the page’s.',
      preventDefault: true,
      displayOrder: 0,
    },
    next: {
      description: 'Next file in the thread',
      bindings: [']', 'ArrowRight'],
      section: 'Files',
      hint: 'Not while typing, in a menu, or where the arrows scroll or move something. Beside the thread, from inside the file.',
      preventDefault: true,
      displayOrder: 1,
    },
    previous: {
      description: 'Previous file in the thread',
      bindings: ['[', 'ArrowLeft'],
      section: 'Files',
      hint: 'Not while typing, in a menu, or where the arrows scroll or move something. Beside the thread, from inside the file.',
      preventDefault: true,
      displayOrder: 2,
    },
    toggleTools: {
      description: 'Hide or show the full-screen toolbar',
      // The html-annotate chord, from its one definition: the same keys hide the tools in plan review.
      bindings: htmlAnnotateShortcuts.shortcuts.toggleTools.bindings,
      section: 'Files',
      hint: 'An HTML file in full screen. Works from inside the page too.',
      preventDefault: true,
      displayOrder: 3,
    },
  },
});
