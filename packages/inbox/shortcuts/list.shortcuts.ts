import { defineShortcutScope } from '@plannotator/ui/shortcuts';

/**
 * The list's keys (InboxList.tsx). The arrows and Home / End act only while a
 * row has focus (the list's own keydown), so they never take the page's
 * scrolling elsewhere; they move focus and never open a thread (Enter does,
 * the row being a button). Tab still visits every row, as before.
 */
export const inboxListShortcuts = defineShortcutScope({
  id: 'inbox-list',
  title: 'List',
  shortcuts: {
    next: { description: 'Next thread', bindings: ['ArrowDown'], section: 'List', preventDefault: true, displayOrder: 0 },
    previous: { description: 'Previous thread', bindings: ['ArrowUp'], section: 'List', preventDefault: true, displayOrder: 1 },
    first: { description: 'First thread', bindings: ['Home'], section: 'List', preventDefault: true, displayOrder: 2 },
    last: { description: 'Last thread', bindings: ['End'], section: 'List', preventDefault: true, displayOrder: 3 },
    open: {
      // The row is a button: Enter is its own (listed for the map).
      description: 'Open the thread',
      bindings: ['Enter'],
      section: 'List',
      displayOrder: 4,
    },
    rowMenu: {
      // RowMenu.tsx takes it on a focused row (the context-menu key too).
      description: 'Row menu',
      bindings: ['Shift+F10'],
      section: 'List',
      displayOrder: 7,
    },
  },
});
