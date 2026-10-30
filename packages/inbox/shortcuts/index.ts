/**
 * The Inbox's keys, as registry scopes composed into one surface the way plan
 * review and code review compose theirs (packages/editor/shortcuts.ts). The
 * shortcut map (ShortcutMap.tsx), every keycap (ShortcutHint.tsx) and every
 * `aria-keyshortcuts` read their keys from here, so a key and its hint cannot
 * drift apart. The extras (extras.ts) add or drop their bindings here too.
 *
 * Keys that belong to one widget stay with it and are not listed: compose, the
 * search palette, the project picker, the reply route, the decision card,
 * Enter / Space on an image in a message.
 */
import { createShortcutRegistry, type ShortcutRegistry, type ShortcutSurface } from '@plannotator/ui/shortcuts';
import { buildInboxSearchShortcuts, inboxSearchShortcuts } from '../search/searchShortcut';
import { buildInboxAppShortcuts, inboxAppShortcuts } from './app.shortcuts';
import type { InboxShortcutExtras } from './extras';
import { inboxFileViewerShortcuts } from './fileViewer.shortcuts';
import { inboxListShortcuts } from './list.shortcuts';
import { inboxThreadShortcuts } from './thread.shortcuts';

export { inboxAppShortcuts } from './app.shortcuts';
export { inboxFileViewerShortcuts } from './fileViewer.shortcuts';
export { inboxListShortcuts } from './list.shortcuts';
export { inboxThreadShortcuts } from './thread.shortcuts';
export { inboxSearchShortcuts } from '../search/searchShortcut';
export { INBOX_SHORTCUT_EXTRAS, type InboxShortcutExtras } from './extras';
export * from './guards';

export const inboxShortcutRegistry = createShortcutRegistry([inboxAppShortcuts, inboxSearchShortcuts, inboxListShortcuts, inboxThreadShortcuts, inboxFileViewerShortcuts]);

/** The registry with other extras (tests: every combination must validate and stay unambiguous). */
export function buildInboxShortcutRegistry(extras: InboxShortcutExtras): ShortcutRegistry {
  return createShortcutRegistry([buildInboxAppShortcuts(extras), buildInboxSearchShortcuts(extras), inboxListShortcuts, inboxThreadShortcuts, inboxFileViewerShortcuts]);
}

export const inboxSurface: ShortcutSurface = {
  slug: 'inbox',
  title: 'Plannotator Inbox',
  description: 'Keys in the Inbox window: everywhere, the list, a thread, and an open file.',
  registry: inboxShortcutRegistry,
};
