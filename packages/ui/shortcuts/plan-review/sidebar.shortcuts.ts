import { defineShortcutScope } from '../core';
import { createShortcutScopeHook } from '../runtime';

export const annotateSidebarShortcuts = defineShortcutScope({
  id: 'annotate-sidebar',
  title: 'Annotate Sidebar',
  shortcuts: {
    toggleContents: {
      description: 'Toggle Contents sidebar',
      bindings: ['Mod+B'],
      section: 'Sidebar',
      displayOrder: 10,
      preventDefault: true,
    },
    toggleFiles: {
      description: 'Toggle Files sidebar',
      bindings: ['Mod+Shift+B'],
      section: 'Sidebar',
      hint: 'Available when the Files tab is shown.',
      displayOrder: 20,
      preventDefault: true,
    },
    toggleAgentTui: {
      description: 'Toggle Agent TUI sidebar',
      bindings: ['Shift Shift'],
      section: 'Sidebar',
      hint: 'Available when the Agent control is shown.',
      displayOrder: 30,
      preventDefault: true,
    },
  },
});

export const useAnnotateSidebarShortcuts = createShortcutScopeHook(annotateSidebarShortcuts);
