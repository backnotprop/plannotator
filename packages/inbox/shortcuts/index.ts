import { createShortcutRegistry, type ShortcutRegistry, type ShortcutSurface } from '@plannotator/ui/shortcuts';
import { buildInboxSearchShortcuts, inboxSearchShortcuts } from '../search/searchShortcut';
import { buildInboxAppShortcuts, inboxAppShortcuts } from './app.shortcuts';
import type { InboxShortcutExtras } from './extras';
import { inboxFileViewerShortcuts } from './fileViewer.shortcuts';
import { inboxArtifactsShortcuts, inboxBoardShortcuts } from './grid.shortcuts';
import { inboxListShortcuts } from './list.shortcuts';
import { inboxThreadShortcuts } from './thread.shortcuts';

export { inboxAppShortcuts } from './app.shortcuts';
export { inboxFileViewerShortcuts } from './fileViewer.shortcuts';
export { inboxArtifactsShortcuts, inboxBoardShortcuts } from './grid.shortcuts';
export { inboxListShortcuts } from './list.shortcuts';
export { inboxThreadShortcuts } from './thread.shortcuts';
export { inboxSearchShortcuts } from '../search/searchShortcut';
export { INBOX_SHORTCUT_EXTRAS, type InboxShortcutExtras } from './extras';
export * from './guards';

export const inboxShortcutRegistry = createShortcutRegistry([inboxAppShortcuts, inboxSearchShortcuts, inboxListShortcuts, inboxThreadShortcuts, inboxFileViewerShortcuts, inboxArtifactsShortcuts, inboxBoardShortcuts]);

export function buildInboxShortcutRegistry(extras: InboxShortcutExtras): ShortcutRegistry {
  return createShortcutRegistry([buildInboxAppShortcuts(extras), buildInboxSearchShortcuts(extras), inboxListShortcuts, inboxThreadShortcuts, inboxFileViewerShortcuts, inboxArtifactsShortcuts, inboxBoardShortcuts]);
}

export const inboxSurface: ShortcutSurface = {
  slug: 'inbox',
  title: 'Plannotator Inbox',
  description: 'Keys in the Inbox window: everywhere, the list, a thread, and an open file.',
  registry: inboxShortcutRegistry,
};
