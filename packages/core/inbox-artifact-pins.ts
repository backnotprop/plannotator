import type { InboxAttachment, InboxAttachmentKind, InboxAttachmentState, InboxInlineImage } from "./inbox-attachments";
import { readInboxAttachmentKind } from "./inbox-attachments";
import type { InboxAuthor, InboxGuideRef } from "./inbox-types";

/** One pinned artifact: its key (an attachment id, or `guide:<message id>`), its thread, and when it was pinned. */
export interface InboxArtifactPin {
  key: string;
  thread_id: string;
  pinned_at: string;
}

/** The Wall's type chips. */
export const INBOX_ARTIFACT_TYPES = ["images", "pages", "documents", "other"] as const;
export type InboxArtifactType = (typeof INBOX_ARTIFACT_TYPES)[number];

export function inboxArtifactTypeOf(kind: InboxAttachmentKind | "guide"): InboxArtifactType {
  if (kind === "guide") return "documents";
  const k = readInboxAttachmentKind(kind);
  if (k === "image" || k === "video") return "images";
  if (k === "html") return "pages";
  if (k === "file" || k === "audio") return "other";
  return "documents";
}

/** The key of a guided review: one per message that carries one. */
export function inboxGuideArtifactKey(messageId: string): string {
  return `guide:${messageId}`;
}

/** What a thread's artifact is made of, as the store holds it. */
export interface InboxArtifactRef<M> {
  key: string;
  message: M;
  attachment: InboxAttachment | null;
  inline: boolean;
  guide: InboxGuideRef | null;
}

export function inboxThreadArtifactRefs<M extends { id: string; attachments?: readonly InboxAttachment[] | null; inline_images?: readonly InboxInlineImage[] | null; guide?: InboxGuideRef | null }>(
  messages: readonly M[],
): InboxArtifactRef<M>[] {
  const out: InboxArtifactRef<M>[] = [];
  const placed = new Set<string>();
  for (const message of messages) {
    const shown: InboxAttachment[] = [];
    for (const image of message.inline_images ?? []) {
      if (placed.has(image.id)) continue;
      placed.add(image.id);
      shown.push(image);
      out.push({ key: image.id, message, attachment: image, inline: true, guide: null });
    }
    for (const attachment of message.attachments ?? []) {
      if (placed.has(attachment.id)) continue;
      placed.add(attachment.id);
      if (shown.some((image) => image.path === attachment.path)) continue;
      out.push({ key: attachment.id, message, attachment, inline: false, guide: null });
    }
    if (message.guide) out.push({ key: inboxGuideArtifactKey(message.id), message, attachment: null, inline: false, guide: message.guide });
  }
  return out;
}

/** A row of the Wall (`GET /api/inbox/artifacts`): one artifact, its thread, its message, and its pin. */
export interface InboxArtifactRow {
  key: string;
  thread_id: string;
  thread_title: string;
  project: { id: string; name: string };
  message_id: string;
  at: string;
  author: InboxAuthor;
  type: InboxArtifactType;
  attachment: InboxAttachmentState | null;
  inline: boolean;
  guide: InboxGuideRef | null;
  archived: boolean;
  pinned_at: string | null;
}

/** The Wall's page (`GET /api/inbox/artifacts`). */
export interface InboxArtifactsPage {
  artifacts: InboxArtifactRow[];
  next_cursor: string | null;
  total: number;
  counts: { all: number; pinned: number; types: Record<InboxArtifactType, number> };
}

/** The Wall's page size: the default and the most one read takes. */
export const INBOX_ARTIFACTS_PAGE = 60;
export const INBOX_ARTIFACTS_PAGE_MAX = 200;
