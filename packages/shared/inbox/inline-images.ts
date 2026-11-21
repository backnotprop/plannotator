/**
 * Plannotator Inbox: the images a message's body shows, captured as files of
 * the thread (approval "inbox-image-viewer", 2026-10-15, owner: "yes, copy
 * them").
 *
 * When an agent's message lands, each image its body shows
 * (`inboxMessageImageRefsInOrder`: markdown `![alt](src)` and `<img src>`,
 * outside code, in text order, each once) is read under the message-image
 * route's own rules (`readInboxMessageImageAsync`: referenced in the body, an
 * image by extension and by its magic bytes, anywhere but a hidden folder of
 * the home folder (`~/.ssh`) or a dotenv file, at most 10 MB and 50 megapixels, one
 * `O_NOFOLLOW | O_NONBLOCK` descriptor checked by dev and ino). Its bytes go
 * to `inbox/blobs/<sha256>` and the message keeps an attachment record for it
 * plus `ref`, the src as written (`InboxInlineImage`). An image that cannot be
 * read (remote, hidden, missing, too large) is left out (its refusal is in
 * `failures`, which send_message turns into its `images_not_shown` warning):
 * an image written later shows through the message-image route, and the
 * window opens it in the plain lightbox until a later read captures it. It never refuses
 * the send.
 *
 * Every read and write is asynchronous and the capture yields to the event
 * loop between images, so many images never stall the Inbox. At send the
 * blobs are staged as temp files and committed only once the store accepted
 * the message (`commit`), or removed (`discard`).
 *
 * Images a message shows that were not captured (a message sent before this,
 * an image written after the send, past the send's 64, a transient refusal,
 * the person's own messages) are captured on a later read of the thread, in
 * the background (packages/server/inbox-message-images.ts), marked
 * `captured: "on_open"`.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { rename, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { inboxAttachmentId, type InboxInlineImage } from "@plannotator/core/inbox-types";
import { inboxBlobPath, inboxBlobsDir } from "./attachments";
import { inboxMessageImageRefsInOrder, readInboxMessageImageAsync } from "./message-images";

/** The most images one message's capture at send takes (the rest are captured on a later read). */
export const INBOX_INLINE_IMAGES_MAX = 64;

export interface CaptureInlineImagesInput {
  body: string;
  /** The project's root (a realpath). */
  root: string;
  /** The folder the agent sent from (`base_path`), when not the root. */
  base?: string | null;
  /** The message's author is an agent: images from anywhere (`InboxMessageImageInput.anywhere`). */
  anywhere?: boolean;
  /** The message's time: each record's `sent_at`. */
  sentAt: string;
  /** Set when capturing on a later read: the records are marked `captured: "on_open"` at this time. */
  capturedOnOpenAt?: string;
  /** Only these sources (as written), in this order; default every image the body shows. */
  refs?: readonly string[];
  /** At most this many images (default INBOX_INLINE_IMAGES_MAX). */
  max?: number;
  /** Stage the blobs as temp files until `commit` (a send the store may still refuse). */
  stage?: boolean;
}

export interface InlineImageFailure {
  ref: string;
  code: string;
  notYet?: true;
}

export interface CapturedInlineImages {
  images: InboxInlineImage[];
  /** The sources not captured, with the refusal's code (`image_missing`, `not_an_image`, ...); `notYet` when nothing is at the path yet. */
  failures: InlineImageFailure[];
  /** The bytes read. */
  bytes: number;
  /** Move staged blobs into place (a no-op unless `stage`). */
  commit: () => Promise<void>;
  /** Remove staged blobs (a no-op unless `stage`). */
  discard: () => Promise<void>;
}

/** Whether a body shows any local image the capture could take. */
export function bodyShowsLocalImages(body: string): boolean {
  return inboxMessageImageRefsInOrder(body).length > 0;
}

/** Let other requests run (between images). */
export function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function writeTemp(dir: string, bytes: Uint8Array): Promise<string> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, `.send.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}.tmp`);
  await writeFile(temp, bytes, { mode: 0o600, flag: "wx" });
  return temp;
}

async function place(temp: string, path: string): Promise<void> {
  if (existsSync(path)) await unlink(temp).catch(() => {});
  else await rename(temp, path);
}

/**
 * Read and copy each image the body shows. Never throws: an image that cannot
 * be read is left out.
 */
export async function captureInboxInlineImages(inboxDirPath: string, input: CaptureInlineImagesInput): Promise<CapturedInlineImages> {
  const images: InboxInlineImage[] = [];
  const failures: InlineImageFailure[] = [];
  const staged: { temp: string; path: string }[] = [];
  let bytes = 0;
  const dir = inboxBlobsDir(inboxDirPath);
  const refs = (input.refs ?? inboxMessageImageRefsInOrder(input.body)).slice(0, input.max ?? INBOX_INLINE_IMAGES_MAX);
  for (const [index, ref] of refs.entries()) {
    if (index > 0) await yieldToLoop();
    const read = await readInboxMessageImageAsync({ body: input.body, root: input.root, base: input.base ?? null, path: ref, anywhere: input.anywhere === true }).catch(() => null);
    if (!read || !read.ok) {
      if (!read) failures.push({ ref, code: "image_read_failed" });
      else failures.push({ ref, code: read.code, ...(read.notYet ? { notYet: true as const } : {}) });
      continue;
    }
    const sha256 = createHash("sha256").update(read.bytes).digest("hex");
    const path = inboxBlobPath(inboxDirPath, sha256);
    try {
      // Staged even when the blob exists now: a deletion's sweep may remove it before the
      // record that will use it is written, and `commit` then puts this copy in its place.
      if (input.stage) staged.push({ temp: await writeTemp(dir, read.bytes), path });
      else if (!existsSync(path)) await place(await writeTemp(dir, read.bytes), path);
    } catch {
      failures.push({ ref, code: "write_failed" });
      continue;
    }
    bytes += read.bytes.length;
    images.push({
      id: inboxAttachmentId(),
      path: read.real,
      named_path: read.named === read.real ? null : read.named,
      name: basename(read.named) || basename(read.real),
      kind: "image",
      sent_sha256: sha256,
      size: read.bytes.length,
      sent_at: input.sentAt,
      sent_mtime: read.mtime,
      media_type: read.contentType,
      ...(read.width !== undefined && read.height !== undefined ? { width: read.width, height: read.height } : {}),
      ref,
      ...(input.capturedOnOpenAt ? { captured: "on_open" as const, captured_at: input.capturedOnOpenAt } : {}),
    });
  }
  return {
    images,
    failures,
    bytes,
    commit: async () => {
      for (const { temp, path } of staged.splice(0)) await place(temp, path).catch(() => unlink(temp).catch(() => {}));
    },
    discard: async () => {
      for (const { temp } of staged.splice(0)) await unlink(temp).catch(() => {});
    },
  };
}
