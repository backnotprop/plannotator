import { defineShortcutScope } from '../core';
import { createShortcutScopeHook } from '../runtime';

// Chords for the HTML and live-app annotate surfaces. Both are mirrored inside
// the sandboxed iframe by the bridge (focus usually lives in there on live
// apps) and forwarded to the parent, so they work regardless of which document
// owns the keyboard. No bare-letter binding: bare letters belong to
// type-to-comment and the page itself.
//
// `Mod+Shift+X` for the tools rather than a mnemonic letter: every mnemonic
// candidate is claimed by a browser (H = Chrome's Home / Firefox's history
// library, E/I/J/K/C = devtools, B/O = bookmarks, V = paste-as-plain-text,
// T = reopen tab), and a chord the browser eats is worse than an arbitrary
// one. X is unassigned in Chrome, Firefox, Safari and Edge on every platform.
export const htmlAnnotateShortcuts = defineShortcutScope({
  id: 'html-annotate',
  title: 'HTML Annotate',
  shortcuts: {
    toggleAnnotateMode: {
      description: 'Toggle annotate mode',
      bindings: ['Mod+Shift+A'],
      section: 'Annotations',
      hint: 'On HTML and live app surfaces: arm annotation capture, or hand clicks back to the page. Esc also exits Annotate; this chord is the way back in.',
      preventDefault: true,
      displayOrder: 0,
    },
    toggleTools: {
      description: 'Show or hide tools',
      bindings: ['Mod+Shift+X'],
      section: 'Annotations',
      hint: 'On HTML and live app surfaces: the header eye — shows or removes all floating chrome over the page. HTML surfaces open with the tools hidden.',
      preventDefault: true,
      displayOrder: 1,
    },
  },
});

export const useHtmlAnnotateShortcuts = createShortcutScopeHook(htmlAnnotateShortcuts);
