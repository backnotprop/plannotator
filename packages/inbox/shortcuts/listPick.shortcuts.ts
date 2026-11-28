import { defineShortcutScope } from '@plannotator/ui/shortcuts';

/**
 * Escape stops picking thread rows (approval "inbox-multi-select"), as Done does. It is the same Escape as everywhere
 * ("Close, one layer at a time"), so the map lists it on that row and shows no words of its own. The list wires it on
 * the document (components/useListPicks.tsx): a menu, a field or a dialog that used the key keeps it first, and App's
 * ladder on the window stands down once it has acted, so the thread open beside the list stays open.
 */
export const inboxListPickShortcuts = defineShortcutScope({
  id: 'inbox-list-pick',
  title: 'List',
  shortcuts: {
    leavePicks: { description: 'Close, one layer at a time', bindings: ['Escape'], section: 'Everywhere', preventDefault: true, displayOrder: 9 },
  },
});
