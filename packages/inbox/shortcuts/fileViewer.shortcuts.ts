import { defineShortcutScope, htmlAnnotateShortcuts } from '@plannotator/ui/shortcuts';

export const inboxFileViewerShortcuts = defineShortcutScope({
  id: 'inbox-file-viewer',
  title: 'Open file',
  lettersByCode: true,
  shortcuts: {
    escape: {
      description: 'Close what is open, then leave full screen',
      bindings: ['Escape'],
      section: 'Files',
      hint: 'One thing per press, innermost first: a menu or the file list, a comment being written (its words are kept and are back when you open the file again), the comments drawer, Annotate (HTML goes to Interact); then full screen ends and the file is back beside the thread (on a phone, back to the thread). Nothing asks first. In Interact, an Escape the page uses itself stays the page’s.',
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
      bindings: htmlAnnotateShortcuts.shortcuts.toggleTools.bindings,
      section: 'Files',
      hint: 'An HTML file in full screen. Works from inside the page too.',
      preventDefault: true,
      displayOrder: 3,
    },
    toggleAnnotate: {
      description: 'Annotate or Interact',
      bindings: htmlAnnotateShortcuts.shortcuts.toggleAnnotateMode.bindings,
      section: 'Files',
      hint: 'An HTML file: Annotate takes clicks for comments, Interact hands them to the page.',
      preventDefault: true,
      displayOrder: 4,
    },
  },
});
