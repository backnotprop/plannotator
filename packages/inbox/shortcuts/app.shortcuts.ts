import { defineShortcutScope, type ShortcutDefinition } from '@plannotator/ui/shortcuts';
import { INBOX_SHORTCUT_EXTRAS, type InboxShortcutExtras } from './extras';

export type InboxAppAction = 'openMap' | 'goInbox' | 'goBoard' | 'goPulls' | 'goDrafts' | 'goSettings' | 'compose' | 'refresh' | 'toggleSidebar' | 'leavePage';

export function buildInboxAppShortcuts(extras: InboxShortcutExtras = INBOX_SHORTCUT_EXTRAS) {
  const goTo: Partial<Record<InboxAppAction, ShortcutDefinition>> = extras.goTo
    ? {
        goInbox: { description: 'Go to the Inbox', bindings: ['G I'], section: 'Everywhere', hint: 'Focus lands on the first row, or the open thread’s row.', preventDefault: true, displayOrder: 2 },
        goBoard: { description: 'Go to the Board', bindings: ['G B'], section: 'Everywhere', hint: 'When the Board is on.', preventDefault: true, displayOrder: 3 },
        goPulls: { description: 'Go to Reviews (pull requests)', bindings: ['G P'], section: 'Everywhere', hint: 'When Code review is on.', preventDefault: true, displayOrder: 3.1 },
        goDrafts: { description: 'Go to Drafts', bindings: ['G D'], section: 'Everywhere', hint: 'When you have drafts.', preventDefault: true, displayOrder: 3.2 },
        goSettings: { description: 'Go to Settings', bindings: ['G S'], section: 'Everywhere', preventDefault: true, displayOrder: 4 },
      }
    : {};
  return defineShortcutScope({
    id: 'inbox-app',
    title: 'Everywhere',
    lettersByCode: true,
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
      compose: {
        description: 'New message',
        bindings: ['C'],
        section: 'Everywhere',
        hint: 'Opens a new message to an agent.',
        preventDefault: true,
        displayOrder: 4.5,
      },
      refresh: {
        description: 'Refresh',
        bindings: ['Shift+R'],
        section: 'Everywhere',
        hint: 'The Inbox or the project on screen, as the list’s ↻ does. On the Board and Reviews, their own refresh.',
        preventDefault: true,
        displayOrder: 4.6,
      },
      toggleSidebar: {
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
    } as Record<InboxAppAction, ShortcutDefinition>,
  });
}

export const inboxAppShortcuts = buildInboxAppShortcuts();
