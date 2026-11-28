/**
 * A thread's artifacts (approval "inbox-thread-artifacts", 2026-10-23,
 * variant Swap): everything in the thread you would open, look at or
 * download, from every message, the person's included. One list, built once
 * from the thread payload, read by both surfaces that show it:
 *
 * - the Artifacts view (components/ArtifactsView.tsx), a grid of every
 *   artifact, newest message first (`artifactsNewestFirst`);
 * - the viewer's stepping and its peek (stepping.ts `attachmentSequence`),
 *   which keep thread order and step only through what the viewer opens.
 *
 * What counts: every attachment of every kind (documents, code, diagrams,
 * images, video, PDFs and other downloads), the images a message's text shows
 * (`inline_images`, captured as files), the live html blocks of an agent's
 * text (```html fences; not files: core inbox-html-blocks.ts), one guided
 * review per message that carries one, and the files the person pasted into a
 * reply or a new message (attachments of their own messages). Not: drawings
 * made while commenting, remote images, the message text.
 *
 * The one seam between the two counts: a guided review opens its own reader
 * and an html block its own page (htmlArtifactOpen.ts), never the file viewer,
 * so the viewer does not step through them. The grid's count is the peek's
 * plus the thread's guided reviews and html blocks ("2 of 10" in the viewer,
 * "11 artifacts" in the grid when one message carries a guide).
 *
 * Pure: no DOM, no fetch.
 */

import type { InboxAttachmentState, InboxGuideRef, InboxMessageWire } from '@plannotator/core/inbox-types';
import { isInboxAnnotatableKind } from '@plannotator/core/inbox-types';
import { inboxHtmlBlocksOf } from '@plannotator/core/inbox-artifact-pins';
import { inboxHtmlArtifactKey } from '@plannotator/core/inbox-html-blocks';
import { agentName, whenTime } from './format';

/** Who sent the message an artifact came in, and when, in the window's words. */
interface ArtifactOrigin {
  messageId: string;
  /** "Claude Code"; "You" for the person's own message. */
  sender: string;
  /** "11:06 AM" (the day too when it is not today). */
  sentAt: string;
  /** The message's time, for ordering and for a full date in a tooltip. */
  at: string;
  /** The person's own message (a file they pasted). */
  fromPerson: boolean;
  /** The sending agent's host (its mark); null for the person. */
  host: string | null;
}

/** A file the viewer opens or downloads: an attachment, or an image the message's text shows. */
export interface FileArtifact extends ArtifactOrigin {
  type: 'file';
  attachment: InboxAttachmentState;
  /** An image the message's text shows (`inline_images`), not an attached file. */
  inline: boolean;
  /**
   * The same file attached to the same message as well as shown in its text
   * (one artifact, two records): the other record's id. Opening either opens
   * this artifact, and the viewer's stepping counts it once.
   */
  alsoIds: readonly string[];
}

/** A guided review: one per message that carries one; it opens the guide reader. */
export interface GuideArtifact extends ArtifactOrigin {
  type: 'guide';
  guide: InboxGuideRef;
}

/**
 * A live html block of an agent's text (```html, core inbox-html-blocks.ts): not a file. It opens its own page, big,
 * with the block's own tools (htmlArtifactOpen.ts); the viewer never steps through it.
 */
export interface HtmlArtifact extends ArtifactOrigin {
  type: 'html';
  /** `html:<message id>:<hash>`. */
  key: string;
  /** The page's first heading, else null (the tile says "HTML block"). */
  title: string | null;
  /** The source's size in bytes. */
  size: number;
  /** The block's source, when the thread's messages are at hand (the grid); null on the Wall. */
  source: string | null;
}

export type Artifact = FileArtifact | GuideArtifact | HtmlArtifact;

/** The key a tile and a list use: the file's id, `guide:<message id>`, or an html block's `html:<message id>:<hash>`. */
export function artifactKey(artifact: Artifact): string {
  return artifact.type === 'file' ? artifact.attachment.id : artifact.type === 'html' ? artifact.key : `guide:${artifact.messageId}`;
}

/** What a tile names an html block: its first heading, else "HTML block". */
export function htmlArtifactName(artifact: Pick<HtmlArtifact, 'title'>): string {
  return artifact.title ?? 'HTML block';
}

/** Who sent a message and when, as a tile says it (also the Artifacts wall's, from its rows). */
export function originOf(message: Pick<InboxMessageWire, 'id' | 'author' | 'created_at'>): ArtifactOrigin {
  const day = new Date().toDateString();
  const kept = origins.get(message);
  if (kept?.day === day) return kept.origin;
  const origin = originNow(message);
  origins.set(message, { day, origin });
  return origin;
}

const origins = new WeakMap<object, { day: string; origin: ArtifactOrigin }>();

function originNow(message: Pick<InboxMessageWire, 'id' | 'author' | 'created_at'>): ArtifactOrigin {
  const fromPerson = message.author.kind === 'person';
  return {
    messageId: message.id,
    sender: fromPerson ? 'You' : agentName(message.author),
    sentAt: whenTime(message.created_at),
    at: message.created_at,
    fromPerson,
    host: message.author.kind === 'agent' ? message.author.host : null,
  };
}

/**
 * Every artifact of the thread in reading order: message by message, the
 * images its text shows in text order, then the live html blocks of an agent's
 * text, then its attached files in the order of its tiles, then its guided
 * review. An image both shown in the text and
 * attached to the same message (the same file on disk) is one artifact, the
 * one in the text, carrying the attached record's id in `alsoIds`. A file
 * whose message is not in the thread (it should not happen) goes last, so the
 * count always matches the records.
 */
export function threadArtifacts(
  messages: readonly InboxMessageWire[],
  attachments: readonly InboxAttachmentState[],
  inlineImages: readonly InboxAttachmentState[] = [],
): Artifact[] {
  const out: Artifact[] = [];
  const placed = new Set<string>();
  for (const message of messages) {
    const origin = () => originOf(message);
    const files: FileArtifact[] = [];
    for (const image of inlineImages) {
      if (image.message_id !== message.id || placed.has(image.id)) continue;
      placed.add(image.id);
      files.push({ type: 'file', ...origin(), attachment: image, inline: true, alsoIds: [] });
    }
    // The live html blocks of an agent's text, after its pictures (the store's order: core inboxThreadArtifactRefs).
    const pages: HtmlArtifact[] = [];
    for (const block of inboxHtmlBlocksOf(message)) {
      const key = inboxHtmlArtifactKey(message.id, block.hash);
      if (placed.has(key)) continue;
      placed.add(key);
      pages.push({ type: 'html', ...origin(), key, title: block.title, size: block.size, source: block.content });
    }
    for (const attachment of attachments) {
      if (attachment.message_id !== message.id || placed.has(attachment.id)) continue;
      placed.add(attachment.id);
      // Shown in the text AND attached: the same file on disk, in the same message.
      const twin = files.find((f) => f.inline && f.attachment.path === attachment.path);
      if (twin) {
        twin.alsoIds = [...twin.alsoIds, attachment.id];
        continue;
      }
      files.push({ type: 'file', ...origin(), attachment, inline: false, alsoIds: [] });
    }
    out.push(...files.filter((f) => f.inline), ...pages, ...files.filter((f) => !f.inline));
    if (message.guide) out.push({ type: 'guide', ...origin(), guide: message.guide });
  }
  for (const [list, inline] of [
    [inlineImages, true],
    [attachments, false],
  ] as const) {
    for (const attachment of list) {
      if (placed.has(attachment.id)) continue;
      placed.add(attachment.id);
      out.push({ type: 'file', messageId: attachment.message_id, sender: 'the agent', sentAt: whenTime(attachment.sent_at), at: attachment.sent_at, fromPerson: false, host: null, attachment, inline, alsoIds: [] });
    }
  }
  return out;
}

/**
 * The grid's order (decision 2): the newest message first; inside a message,
 * the order it has (images in its text, its attached files, its guided
 * review). Stable for messages sent at the same moment: thread order decides.
 */
export function artifactsNewestFirst(artifacts: readonly Artifact[]): Artifact[] {
  const groups: Artifact[][] = [];
  for (const artifact of artifacts) {
    const last = groups.at(-1);
    if (last && last[0]!.messageId === artifact.messageId) last.push(artifact);
    else groups.push([artifact]);
  }
  return groups.reverse().flat();
}

/** The artifact a file id opens (its own record, or the twin it was folded into). */
export function artifactOfFile(artifacts: readonly Artifact[], attachmentId: string): FileArtifact | null {
  for (const artifact of artifacts) {
    if (artifact.type !== 'file') continue;
    if (artifact.attachment.id === attachmentId || artifact.alsoIds.includes(attachmentId)) return artifact;
  }
  return null;
}

/** The pin key of an open file: its artifact's (the shown image's id for an attached twin), else its own id. */
export function openArtifactKey(artifacts: readonly Artifact[], attachmentId: string): string {
  const artifact = artifactOfFile(artifacts, attachmentId);
  return artifact ? artifactKey(artifact) : attachmentId;
}

/**
 * What `O` opens (approval "inbox-keyboard-shortcuts"): the newest message's
 * first file that opens in the viewer (its tile says Open, not Download), the
 * grid's order. Guided reviews open their own reader and a plain file or a PDF
 * is a download, so neither is taken. Null: nothing to open.
 */
export function newestViewableFile(artifacts: readonly Artifact[]): FileArtifact | null {
  for (const artifact of artifactsNewestFirst(artifacts)) {
    if (artifact.type !== 'file') continue;
    if (isInboxAnnotatableKind(artifact.attachment.kind)) return artifact;
  }
  return null;
}
