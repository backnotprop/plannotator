/**
 * "Open in" for an attachment (design record "inbox-open-in", approved
 * 2026-10-14): what the pane header's split button and a tile's ⋯ menu
 * offer, from the per-kind policy the server enforces too
 * (`inboxOpenInPolicy`, @plannotator/core). A plain list: Browser (HTML),
 * the editors this computer has, the default app where the policy allows
 * it, the file manager; then Copy path. The current choice is checked.
 */

import { INBOX_OPEN_IN_DEFAULT_APP, inboxOpenInPolicy, readInboxAttachmentKind, type InboxAttachmentState } from '@plannotator/core/inbox-types';
import type { OpenInPlatform } from '@plannotator/core/open-in-apps';
import type { DetectedOpenInApp } from '@plannotator/ui/hooks/useOpenInApps';
import { attachmentImageUrl, attachmentPageUrl } from './attachments';

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
 * The menu for one attachment. `version` is the one the window shows: a new
 * tab shows that version; the apps always open the file as it is now
 * (owner's recommendation 1: no temp copy of the sent bytes).
 */
export function openInMenu(
  attachment: InboxAttachmentState,
  detected: readonly DetectedOpenInApp[],
  platform: OpenInPlatform,
  remembered: string | null,
  version: 'current' | 'sent',
): OpenInMenu {
  const policy = inboxOpenInPolicy(attachment, platform);
  const items: OpenInItem[] = [];
  if (policy.browser) items.push({ kind: 'browser', id: 'browser', label: 'Browser', href: attachmentPageUrl(attachment, version) });
  if (policy.editors) {
    for (const app of detected) if (app.kind === 'editor') items.push({ kind: 'app', id: app.id, label: app.label, icon: app.icon });
  }
  if (policy.systemDefault) items.push({ kind: 'default', id: INBOX_OPEN_IN_DEFAULT_APP, label: 'Default app' });
  const reveal = detected.find((app) => app.kind === 'file-manager');
  if (reveal) items.push({ kind: 'app', id: reveal.id, label: reveal.label, icon: reveal.icon });

  const launchable = items.filter((item) => item.kind !== 'browser');
  const primary =
    items.find((item) => item.kind === 'browser') ??
    // Images, PDFs and videos open in their viewer; everything else in the remembered app, else the first editor.
    (['image', 'pdf', 'video'].includes(readInboxAttachmentKind(attachment.kind)) ? items.find((item) => item.kind === 'default') : undefined) ??
    (remembered ? launchable.find((item) => item.id === remembered) : undefined) ??
    launchable.find((item) => item.kind === 'app' && item.id !== reveal?.id) ??
    launchable[0] ??
    null;
  return { items, primary, missing: attachment.unavailable !== null };
}

/** Whether picking this item is remembered in the shared cookie (a catalog app; never Browser or the default app). */
export function remembersOpenInItem(item: OpenInItem): boolean {
  return item.kind === 'app';
}

/**
 * Over the tailnet and on a phone the only "Open in" is a new tab: the page
 * route for HTML, the image route for an image, nothing for anything else.
 */
export function newTabUrl(attachment: InboxAttachmentState, version: 'current' | 'sent'): string | null {
  const kind = readInboxAttachmentKind(attachment.kind);
  if (kind === 'html') return attachmentPageUrl(attachment, version);
  if (kind === 'image') return attachmentImageUrl(attachment, version);
  return null;
}
