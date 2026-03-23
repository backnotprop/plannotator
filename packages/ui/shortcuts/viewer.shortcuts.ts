import { defineShortcutScope } from './core';
import { createShortcutScopeHook } from './runtime';

export const viewerShortcuts = defineShortcutScope({
  id: 'viewer',
  title: 'Viewer',
  shortcuts: {
    copySelection: {
      description: 'Copy selected text',
      bindings: ['Mod+C'],
      section: 'Annotations',
      displayOrder: 25,
    },
  },
});

export const useViewerShortcuts = createShortcutScopeHook(viewerShortcuts);
