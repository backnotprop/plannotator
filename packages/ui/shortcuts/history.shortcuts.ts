import { defineShortcutScope } from './core';
import { createShortcutScopeHook } from './runtime';

export const historyShortcuts = defineShortcutScope({
  id: 'history',
  title: 'History',
  shortcuts: {
    undo: {
      description: 'Undo annotation change',
      bindings: ['Mod+Z'],
      section: 'History',
      preventDefault: true,
      displayOrder: 10,
    },
    redo: {
      description: 'Redo annotation change',
      bindings: ['Mod+Shift+Z', 'Mod+Y'],
      section: 'History',
      preventDefault: true,
      displayOrder: 20,
    },
  },
});

export const useHistoryShortcuts = createShortcutScopeHook(historyShortcuts);
