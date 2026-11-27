/**
 * "Open in" for an attachment (design record "inbox-open-in", approved
 * 2026-10-14): what the pane header's split button and a tile's ⋯ menu
 * offer, from the per-kind policy the server enforces too
 * (`inboxOpenInPolicy`, @plannotator/core). A plain list: Browser (HTML),
 * the editors this computer has, the default app where the policy allows
 * it, the file manager; then Copy path. The current choice is checked.
 * A referenced file (a review's diff headers, a message's code spans) has the same list, by its
 * kind on disk, with no Browser: only an attachment has a page to open.
 * A file of a thread on another linked machine (`onAnotherMachine`) lists
 * only what works from here, a page's or an image's new tab and Copy path:
 * every surface asks `openInMenu` and `newTabUrl`, so each follows.
 */

import { INBOX_OPEN_IN_DEFAULT_APP, inboxOpenInPolicy, readInboxAttachmentKind, type InboxAttachmentState } from '@plannotator/core/inbox-types';
import type { OpenInPlatform } from '@plannotator/core/open-in-apps';
import type { DetectedOpenInApp } from '@plannotator/ui/hooks/useOpenInApps';
import { attachmentImageUrl, attachmentPageUrl } from './attachments';
import { machineOf, selfMachineId } from './inboxUrl';

export type OpenInItem =
  /** A new tab of the page (a link in the window; nothing launches). */
  | { kind: 'browser'; id: 'browser'; label: string; href: string }
  /** The OS default app (`app_id: "default"`). */
  | { kind: 'default'; id: typeof INBOX_OPEN_IN_DEFAULT_APP; label: string }
  /** A catalog editor or the file manager, launched by the server. */
  | { kind: 'app'; id: string; label: string; icon: string };

export interface OpenInMenu {
  items: OpenInItem[];
  /** What the split button's left half does, checked in the menu. */
  primary: OpenInItem | null;
  /** The file is no longer on disk as it was: the apps are disabled (Copy path still works). */
  missing: boolean;
}

/**
 * Whether the file's thread lives on another linked machine (docs/agent-guides/inbox-machines.md: Open in stays on
 * this computer). Its bytes are on that machine's disk, so this computer's editors, Default app and file manager have
 * nothing to open. What works from here: Copy path (that machine's path, for a shell there), a page or an image in
 * a new tab (through the forward; inbox-machine-page.ts makes the page's), Download and the viewer in the thread.
 */
export function onAnotherMachine(attachment: Pick<InboxAttachmentState, 'id'>): boolean {
  const machine = machineOf(attachment.id);
  return machine !== null && machine !== selfMachineId();
}

/**
 * The menu for one attachment. `version` is the one the window shows: a new
 * tab shows that version; the apps always open the file as it is now
 * (owner's recommendation 1: no temp copy of the sent bytes). For a file on
 * another machine, only what works from here: a page's or an image's new tab
 * (through the forward), and Copy path, which every list ends with.
 */
export function openInMenu(
  attachment: InboxAttachmentState,
  detected: readonly DetectedOpenInApp[],
  platform: OpenInPlatform,
  remembered: string | null,
  version: 'current' | 'sent',
): OpenInMenu {
  if (onAnotherMachine(attachment)) return newTabMenu(attachment, version);
  return openInMenuFor(attachment, detected, platform, remembered, attachmentPageUrl(attachment, version), attachment.unavailable !== null);
}

/**
 * What works with no app to launch: a page's or an image's new tab, then Copy path (every list ends with it). A file
 * on another machine, and any file from a window over the tailnet, where launching an app is refused.
 */
export function newTabMenu(attachment: InboxAttachmentState, version: 'current' | 'sent'): OpenInMenu {
  const tab = newTabUrl(attachment, version);
  const items: OpenInItem[] = tab ? [{ kind: 'browser', id: 'browser', label: 'Browser', href: tab }] : [];
  return { items, primary: items[0] ?? null, missing: false };
}

/** The menu for a file of a kind: `browserPage` is its new-tab page, if it has one; `missing` disables the apps. */
export function openInMenuFor(
  file: { kind: unknown; path: string },
  detected: readonly DetectedOpenInApp[],
  platform: OpenInPlatform,
  remembered: string | null,
  browserPage: string | null,
  missing: boolean,
): OpenInMenu {
  const policy = inboxOpenInPolicy(file, platform);
  const items: OpenInItem[] = [];
  if (policy.browser && browserPage) items.push({ kind: 'browser', id: 'browser', label: 'Browser', href: browserPage });
  if (policy.editors) {
    for (const app of detected) if (app.kind === 'editor') items.push({ kind: 'app', id: app.id, label: app.label, icon: app.icon });
  }
  if (policy.systemDefault) items.push({ kind: 'default', id: INBOX_OPEN_IN_DEFAULT_APP, label: 'Default app' });
  const reveal = detected.find((app) => app.kind === 'file-manager');
  if (reveal) items.push({ kind: 'app', id: reveal.id, label: reveal.label, icon: reveal.icon });

  const launchable = items.filter((item) => item.kind !== 'browser');
  const primary =
    items.find((item) => item.kind === 'browser') ??
    // Images, PDFs, videos and recordings open in their viewer; everything else in the remembered app, else the first editor.
    (['image', 'pdf', 'video', 'audio'].includes(readInboxAttachmentKind(file.kind)) ? items.find((item) => item.kind === 'default') : undefined) ??
    (remembered ? launchable.find((item) => item.id === remembered) : undefined) ??
    launchable.find((item) => item.kind === 'app' && item.id !== reveal?.id) ??
    launchable[0] ??
    null;
  return { items, primary, missing };
}

/** Whether picking this item is remembered in the shared cookie (a catalog app; never Browser or the default app). */
export function remembersOpenInItem(item: OpenInItem): boolean {
  return item.kind === 'app';
}

/**
 * Over the tailnet and on a phone the only app-free "Open in" is a new tab:
 * the page route for HTML, the image route for an image, nothing for anything
 * else (Copy path goes beside it, `newTabMenu`). The same for a file on
 * another machine, through the forward.
 */
export function newTabUrl(attachment: InboxAttachmentState, version: 'current' | 'sent'): string | null {
  const kind = readInboxAttachmentKind(attachment.kind);
  if (kind === 'html') return attachmentPageUrl(attachment, version);
  if (kind === 'image') return attachmentImageUrl(attachment, version);
  return null;
}
