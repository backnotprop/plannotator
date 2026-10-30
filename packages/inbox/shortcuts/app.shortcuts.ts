import { defineShortcutScope, type ShortcutDefinition } from '@plannotator/ui/shortcuts';
import { INBOX_SHORTCUT_EXTRAS, type InboxShortcutExtras } from './extras';

/**
 * The window's own keys (App.tsx): the shortcut map, the sidebar, leaving a
 * focused page, and (an extra) going to the Inbox, the Board or Settings.
 * `?` is matched by its character (`event.key`), so it is Shift+/ on a US
 * keyboard and Shift+, on a French one.
 */
export type InboxAppAction = 'openMap' | 'goInbox' | 'goBoard' | 'goSettings' | 'toggleSidebar' | 'leavePage';

export function buildInboxAppShortcuts(extras: InboxShortcutExtras = INBOX_SHORTCUT_EXTRAS) {
  const goTo: Partial<Record<InboxAppAction, ShortcutDefinition>> = extras.goTo
    ? {
        goInbox: { description: 'Go to the Inbox', bindings: ['G I'], section: 'Everywhere', hint: 'Focus lands on the first row, or the open thread’s row.', preventDefault: true, displayOrder: 2 },
        goBoard: { description: 'Go to the Board', bindings: ['G B'], section: 'Everywhere', hint: 'When the Board is on.', preventDefault: true, displayOrder: 3 },
        goSettings: { description: 'Go to Settings', bindings: ['G S'], section: 'Everywhere', preventDefault: true, displayOrder: 4 },
      }
    : {};
  return defineShortcutScope({
    id: 'inbox-app',
    title: 'Everywhere',
    shortcuts: {
      openMap: {
        description: 'Keyboard shortcuts',
        bindings: ['?'],
        section: 'Everywhere',
        hint: 'Again, or Escape, closes it.',
        preventDefault: true,
        displayOrder: 1,
      },
      ...goTo,
      toggleSidebar: {
        // Wired in shell/sidebar.tsx (the sidebar primitive's own listener, unchanged); listed here for the map.
        description: 'Show or hide the sidebar',
        bindings: ['Mod+B'],
        section: 'Everywhere',
        preventDefault: true,
        displayOrder: 5,
      },
      leavePage: {
        description: 'Close, one layer at a time',
        bindings: ['Escape'],
        section: 'Everywhere',
        hint: 'Settings and What’s new go back to where you were.',
        displayOrder: 9,
      },
      // With an extra off its actions are simply absent: the registry lists entries, and a handler for an absent one never runs.
    } as Record<InboxAppAction, ShortcutDefinition>,
  });
}

export const inboxAppShortcuts = buildInboxAppShortcuts();
