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
 * Never throws: a source that cannot be read comes back as its refusal's code.
 */

import { mkdirSync } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { inboxAttachmentId, type InboxInlineImage } from "@plannotator/core/inbox-types";
import { decideInboxAttachmentKind, inboxBlobsDir, readInboxVideoMetadata, scanHandle } from "./attachments";
import type { InboxMessageImageInput } from "./message-images";
import { openInboxMessageMedia } from "./message-media";

export type InboxInlineMediaCapture =
  | { ok: true; record: InboxInlineImage; temp: string; sha256: string; bytes: number }
  | { ok: false; code: string; notYet?: true };

export async function captureInboxInlineMedia(
  inboxDirPath: string,
  input: InboxMessageImageInput & { path: string; sentAt: string; capturedOnOpenAt?: string },
): Promise<InboxInlineMediaCapture> {
  const opened = await openInboxMessageMedia(input).catch(() => null);
  if (!opened) return { ok: false, code: "image_read_failed" };
  if (!opened.ok) return { ok: false, code: opened.code, ...(opened.notYet ? { notYet: true as const } : {}) };
  const dir = inboxBlobsDir(inboxDirPath);
  const temp = join(dir, `.send.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}.tmp`);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const out = await open(temp, "wx", 0o600);
    let scan: Awaited<ReturnType<typeof scanHandle>>;
    try {
      scan = await scanHandle(opened.handle, async (chunk) => {
        await out.write(chunk);
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
    const record: InboxInlineImage = {
      id: inboxAttachmentId(),
      path: opened.real,
      named_path: opened.named === opened.real ? null : opened.named,
      name: basename(opened.named) || basename(opened.real),
      ...decided,
      sent_sha256: scan.sha256,
      size: scan.size,
      sent_at: input.sentAt,
      sent_mtime: opened.mtime,
      ref: input.path,
      ...(input.capturedOnOpenAt ? { captured: "on_open" as const, captured_at: input.capturedOnOpenAt } : {}),
    };
    return { ok: true, record, temp, sha256: scan.sha256, bytes: scan.size };
  } catch {
    await unlink(temp).catch(() => {});
    return { ok: false, code: "write_failed" };
  } finally {
    await opened.handle.close().catch(() => {});
  }
}
