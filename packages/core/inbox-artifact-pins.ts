/**
 * Plannotator Inbox: artifacts the person pinned (approval
 * "inbox-artifact-stars", .product/approved/inbox-artifact-stars/; the word
 * is Pin). A pin marks one artifact of one thread, so the person can come
 * back to it: the thread's Artifacts grid shows its pinned artifacts first
 * ("Pinned N"), and the Artifacts wall (the sidebar's Artifacts row) can show
 * only the pinned ones. Kept per person on the server, in
 * `inbox/artifact-pins.json`, outside the event log (shared/inbox/artifact-pins.ts),
 * so every window and phone of the person sees the same pins and agents never do.
 *
 * Not the sidebar's thread pins (`pins.json`, "Starred" threads): a different file,
 * different routes and different names, so the two never mix.
 *
 * Pure: the wire types, the Wall's types, and the one rule both the server and the window use to name a
 * thread's artifacts (`inboxThreadArtifactRefs`, the same keys as packages/inbox/artifacts.ts `artifactKey`).
 */

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

/** Which chip an artifact falls under: pictures and videos, HTML pages, documents (text, code, diagrams, PDFs, guided reviews), other files (recordings among them). */
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
  /** A file (an attachment or an image the text shows); null for a guided review. */
  attachment: InboxAttachment | null;
  /** An image the message's text shows (`inline_images`). */
  inline: boolean;
  guide: InboxGuideRef | null;
}

/**
 * A thread's artifacts in reading order, as the window's Artifacts grid counts
 * them (packages/inbox/artifacts.ts `threadArtifacts`): message by message,
 * the images its text shows, then its attached files, then its guided review.
 * An image both shown and attached (the same path, the same message) is one
 * artifact under the shown image's id. A key that appears twice is kept once.
 */
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
  /** The thread's name as the list shows it (`thread_name`, else the subject). */
  thread_title: string;
  project: { id: string; name: string };
  /** The message it came in. */
  message_id: string;
  at: string;
  author: InboxAuthor;
  type: InboxArtifactType;
  /** A file: the attachment as the window reads it (`/threads/:id/attachments`), `inline` for an image the text shows. */
  attachment: InboxAttachmentState | null;
  inline: boolean;
  guide: InboxGuideRef | null;
  /** Archived thread (resolved, no agent message since). */
  archived: boolean;
  /** When the person pinned it, or null. */
  pinned_at: string | null;
}

/** The Wall's page (`GET /api/inbox/artifacts`). */
export interface InboxArtifactsPage {
  artifacts: InboxArtifactRow[];
  /** The next page's `cursor`, or null at the end. */
  next_cursor: string | null;
  /** Every artifact the filters match (every page). */
  total: number;
  /** The counts the filter bar shows, under the same `archived` and `type`: all, and pinned. Per type: under the same `archived` and `pinned`. */
  counts: { all: number; pinned: number; types: Record<InboxArtifactType, number> };
}

/** The Wall's page size: the default and the most one read takes. */
export const INBOX_ARTIFACTS_PAGE = 60;
export const INBOX_ARTIFACTS_PAGE_MAX = 200;
