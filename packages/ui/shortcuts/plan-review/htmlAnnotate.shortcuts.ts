import { defineShortcutScope } from '../core';
import { createShortcutScopeHook } from '../runtime';

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
