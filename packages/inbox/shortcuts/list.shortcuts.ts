import { defineShortcutScope } from '@plannotator/ui/shortcuts';

export const inboxListShortcuts = defineShortcutScope({
  id: 'inbox-list',
  title: 'List',
  lettersByCode: true,
  shortcuts: {
    next: { description: 'Next thread', bindings: ['ArrowDown'], section: 'List', preventDefault: true, displayOrder: 0 },
    previous: { description: 'Previous thread', bindings: ['ArrowUp'], section: 'List', preventDefault: true, displayOrder: 1 },
    first: { description: 'First thread', bindings: ['Home'], section: 'List', preventDefault: true, displayOrder: 2 },
    last: { description: 'Last thread', bindings: ['End'], section: 'List', preventDefault: true, displayOrder: 3 },
    open: {
      description: 'Open the thread',
      bindings: ['Enter'],
      section: 'List',
      displayOrder: 4,
    },
    rowMenu: {
      description: 'Row or card menu',
      bindings: ['Shift+F10'],
      section: 'List',
      displayOrder: 7,
    },
  },
});
