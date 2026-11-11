import { INBOX_OPEN_IN_DEFAULT_APP, inboxOpenInPolicy, readInboxAttachmentKind, type InboxAttachmentState } from '@plannotator/core/inbox-types';
import type { OpenInPlatform } from '@plannotator/core/open-in-apps';
import type { DetectedOpenInApp } from '@plannotator/ui/hooks/useOpenInApps';
import { attachmentImageUrl, attachmentPageUrl } from './attachments';

export type OpenInItem =
  | { kind: 'browser'; id: 'browser'; label: string; href: string }
  | { kind: 'default'; id: typeof INBOX_OPEN_IN_DEFAULT_APP; label: string }
  | { kind: 'app'; id: string; label: string; icon: string };

export interface OpenInMenu {
  items: OpenInItem[];
  primary: OpenInItem | null;
  missing: boolean;
}

export function openInMenu(
  attachment: InboxAttachmentState,
  detected: readonly DetectedOpenInApp[],
  platform: OpenInPlatform,
  remembered: string | null,
  version: 'current' | 'sent',
): OpenInMenu {
  return openInMenuFor(attachment, detected, platform, remembered, attachmentPageUrl(attachment, version), attachment.unavailable !== null);
}

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
    (['image', 'pdf', 'video', 'audio'].includes(readInboxAttachmentKind(file.kind)) ? items.find((item) => item.kind === 'default') : undefined) ??
    (remembered ? launchable.find((item) => item.id === remembered) : undefined) ??
    launchable.find((item) => item.kind === 'app' && item.id !== reveal?.id) ??
    launchable[0] ??
    null;
  return { items, primary, missing };
}

export function remembersOpenInItem(item: OpenInItem): boolean {
  return item.kind === 'app';
}

export function newTabUrl(attachment: InboxAttachmentState, version: 'current' | 'sent'): string | null {
  const kind = readInboxAttachmentKind(attachment.kind);
  if (kind === 'html') return attachmentPageUrl(attachment, version);
  if (kind === 'image') return attachmentImageUrl(attachment, version);
  return null;
}
