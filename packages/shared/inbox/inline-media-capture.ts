/**
 * Plannotator Inbox: a sound or video a message's text plays in place
 * (`![alt](demo.mp4)`, inbox-files-and-guides.md "Sound and video in place"),
 * captured as a file of the thread the way its pictures are
 * (inline-images.ts), so it is one of the thread's artifacts: its Artifacts
 * grid and count, the Artifacts wall, pins, the viewer beside the thread, and
 * a phone and a linked computer, which read the same `inline_images` records.
 *
 * Read under the message media route's own rules (`openInboxMessageMedia`:
 * the locate step, one `O_NOFOLLOW` descriptor, a sound or video by its first
 * bytes, at most 2 GB), then streamed in 1 MiB chunks (`scanHandle`) into a
 * temp file beside the blobs, hashed as it goes: the caller stages or places
 * it as it does a picture's copy. The record is an attachment record, its kind
 * decided as an attached file's is (`decideInboxAttachmentKind`: `video` or
 * `audio`, with its length and frame size when the header says), plus `ref`.
 *
 * Nothing is copied when the same message attached the same file (the same
 * realpath, size and mtime) and its blob is kept: the record names that blob
 * (`temp: null`), so a film attached and played in place costs one read, at
 * send. The copy stops past the cap (a file that grew since its stat) and when
 * the caller stops (`stopped`, checked between chunks).
 * Never throws: a source that cannot be read comes back as its refusal's code.
 */

import { existsSync, mkdirSync } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { INBOX_INLINE_MEDIA_MAX_BYTES } from "@plannotator/core/inbox-inline-media";
import { inboxAttachmentId, type InboxAttachment, type InboxInlineImage } from "@plannotator/core/inbox-types";
import { decideInboxAttachmentKind, inboxBlobPath, inboxBlobsDir, readInboxVideoMetadata, scanHandle } from "./attachments";
import type { InboxMessageImageInput } from "./message-images";
import { openInboxMessageMedia, type InboxMessageMediaOpen } from "./message-media";

export type InboxInlineMediaCapture =
  /** `temp` null: the record names an attached twin's blob, nothing was copied. */
  | { ok: true; record: InboxInlineImage; temp: string | null; sha256: string; bytes: number }
  | { ok: false; code: string; notYet?: true };

export interface InboxInlineMediaCaptureInput extends InboxMessageImageInput {
  path: string;
  sentAt: string;
  capturedOnOpenAt?: string;
  /** The message's attached files: a twin whose blob is kept is used, not copied again. */
  attached?: readonly InboxAttachment[] | null;
  /** The most bytes copied (default INBOX_INLINE_MEDIA_MAX_BYTES; tests). */
  maxBytes?: number;
  /** The caller stopped: the copy ends at the next chunk. */
  stopped?: () => boolean;
}

const TOO_BIG = new Error("past the cap");
const STOPPED = new Error("stopped");

type Opened = Extract<InboxMessageMediaOpen, { ok: true }>;

/** The same message's attached copy of this very file (realpath, size, mtime), its blob kept. */
function keptTwin(inboxDirPath: string, opened: Opened, attached: readonly InboxAttachment[] | null | undefined): InboxAttachment | null {
  for (const file of attached ?? []) {
    if (file.path !== opened.real || file.size !== opened.size || file.sent_mtime !== opened.mtime) continue;
    if (file.kind !== "video" && file.kind !== "audio") continue;
    try {
      if (existsSync(inboxBlobPath(inboxDirPath, file.sent_sha256))) return file;
    } catch {
      // Not a blob hash: copy it.
    }
  }
  return null;
}

export async function captureInboxInlineMedia(inboxDirPath: string, input: InboxInlineMediaCaptureInput): Promise<InboxInlineMediaCapture> {
  const opened = await openInboxMessageMedia(input).catch(() => null);
  if (!opened) return { ok: false, code: "image_read_failed" };
  if (!opened.ok) return { ok: false, code: opened.code, ...(opened.notYet ? { notYet: true as const } : {}) };
  const base = {
    path: opened.real,
    named_path: opened.named === opened.real ? null : opened.named,
    name: basename(opened.named) || basename(opened.real),
    sent_at: input.sentAt,
    sent_mtime: opened.mtime,
    ref: input.path,
    ...(input.capturedOnOpenAt ? { captured: "on_open" as const, captured_at: input.capturedOnOpenAt } : {}),
  };
  const twin = keptTwin(inboxDirPath, opened, input.attached);
  if (twin) {
    await opened.handle.close().catch(() => {});
    const record: InboxInlineImage = {
      id: inboxAttachmentId(),
      ...base,
      kind: twin.kind,
      ...(twin.media_type ? { media_type: twin.media_type } : {}),
      ...(twin.width !== undefined && twin.height !== undefined ? { width: twin.width, height: twin.height } : {}),
      ...(twin.duration_ms !== undefined ? { duration_ms: twin.duration_ms } : {}),
      sent_sha256: twin.sent_sha256,
      size: twin.size,
    };
    return { ok: true, record, temp: null, sha256: twin.sent_sha256, bytes: 0 };
  }
  const cap = input.maxBytes ?? INBOX_INLINE_MEDIA_MAX_BYTES;
  const dir = inboxBlobsDir(inboxDirPath);
  const temp = join(dir, `.send.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}.tmp`);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const out = await open(temp, "wx", 0o600);
    let scan: Awaited<ReturnType<typeof scanHandle>>;
    try {
      let copied = 0;
      scan = await scanHandle(opened.handle, async (chunk) => {
        if (input.stopped?.()) throw STOPPED;
        copied += chunk.length;
        // A file that grew past the cap since its stat: never copied whole.
        if (copied > cap) throw TOO_BIG;
        let written = 0;
        while (written < chunk.length) written += (await out.write(chunk, written, chunk.length - written)).bytesWritten;
      });
    } finally {
      await out.close().catch(() => {});
    }
    const video = await readInboxVideoMetadata(opened.handle, scan.size, scan.head);
    const decided = decideInboxAttachmentKind(basename(opened.named), scan.head, false, scan.size, video);
    if (decided.kind !== "video" && decided.kind !== "audio") {
      await unlink(temp).catch(() => {});
      return { ok: false, code: "not_media" };
    }
    const record: InboxInlineImage = { id: inboxAttachmentId(), ...base, ...decided, sent_sha256: scan.sha256, size: scan.size };
    return { ok: true, record, temp, sha256: scan.sha256, bytes: scan.size };
  } catch (error) {
    await unlink(temp).catch(() => {});
    if (error === TOO_BIG) return { ok: false, code: "image_too_large" };
    if (error === STOPPED) return { ok: false, code: "capture_stopped" };
    return { ok: false, code: "write_failed" };
  } finally {
    await opened.handle.close().catch(() => {});
  }
}
