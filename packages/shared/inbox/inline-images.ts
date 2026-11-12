import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { rename, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { inboxAttachmentId, type InboxInlineImage } from "@plannotator/core/inbox-types";
import { inboxBlobPath, inboxBlobsDir } from "./attachments";
import { inboxMessageImageRefsInOrder, readInboxMessageImageAsync } from "./message-images";

export const INBOX_INLINE_IMAGES_MAX = 64;

export interface CaptureInlineImagesInput {
  body: string;
  root: string;
  base?: string | null;
  anywhere?: boolean;
  sentAt: string;
  capturedOnOpenAt?: string;
  refs?: readonly string[];
  max?: number;
  stage?: boolean;
}

export interface InlineImageFailure {
  ref: string;
  code: string;
  notYet?: true;
}

export interface CapturedInlineImages {
  images: InboxInlineImage[];
  failures: InlineImageFailure[];
  bytes: number;
  commit: () => Promise<void>;
  discard: () => Promise<void>;
}

export function bodyShowsLocalImages(body: string): boolean {
  return inboxMessageImageRefsInOrder(body).length > 0;
}

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
