/**
 * The Inbox's keys, as registry scopes composed into one surface the way plan
 * review and code review compose theirs (packages/editor/shortcuts.ts), so a
 * help modal or the docs can list them. Every Inbox key that is wired through
 * the registry is here; the ones still on hand-written listeners are listed in
 * the follow-up note at the end of this file.
 */
import { createShortcutRegistry, type ShortcutSurface } from '@plannotator/ui/shortcuts';
import { inboxSearchShortcuts } from '../search/searchShortcut';
import { inboxFileViewerShortcuts } from './fileViewer.shortcuts';
import { inboxThreadShortcuts } from './thread.shortcuts';

export { inboxFileViewerShortcuts } from './fileViewer.shortcuts';
export { inboxThreadShortcuts } from './thread.shortcuts';
export { inboxSearchShortcuts } from '../search/searchShortcut';
export * from './guards';

export const inboxShortcutRegistry = createShortcutRegistry([inboxSearchShortcuts, inboxThreadShortcuts, inboxFileViewerShortcuts]);

export const inboxSurface: ShortcutSurface = {
  slug: 'inbox',
  title: 'Plannotator Inbox',
  description: 'Keys in the Inbox window: search, threads, and an open file.',
  registry: inboxShortcutRegistry,
};

/*
 * Still on hand-written listeners (follow-up: move into scopes here):
 * - App.tsx: Escape closes the open thread (or a guided review).
 * - Thread.tsx: j / k / n between messages and to the first new one; Enter /
 *   Space on an image in a message.
 * - shell/sidebar.tsx: ⌘B / Ctrl+B closes and opens the sidebar.
 * - Dialog- and widget-local keys (compose, search palette, the project
 *   picker, the reply route, the decision card): they belong to their element
 *   and stay there.
 */
