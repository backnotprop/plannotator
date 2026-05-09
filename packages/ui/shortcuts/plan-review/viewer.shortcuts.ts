import { defineShortcutScope } from '../core';
import { createShortcutScopeHook } from '../runtime';

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
    closeLightbox: {
      description: 'Close image lightbox',
      bindings: ['Escape'],
      section: 'Annotations',
      hint: 'Available while an image is open in the lightbox.',
      displayOrder: 70,
    },
  },
});

export const useViewerShortcuts = createShortcutScopeHook(viewerShortcuts);
