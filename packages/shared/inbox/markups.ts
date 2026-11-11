/** Marked-up images, saved content-addressed and owner-only under inbox/markups/. A markup no remaining annotation names is removed with its deleted thread or project; one no annotation names yet is left alone. */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { sniffImageContentType } from "../review-image";
import { INBOX_MAX_REQUEST_BYTES } from "./connection";
import { InboxError } from "./schema";

export const MARKUPS_DIR = "markups";

const EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
const NAME_RE = /^[0-9a-f]{64}\.(png|jpg|webp)$/;

export function inboxMarkupsDir(inboxDirPath: string): string {
  return join(inboxDirPath, MARKUPS_DIR);
}

export function isInboxMarkupName(name: string): boolean {
  return NAME_RE.test(name);
}

/** The annotator exports a PNG at the image's own size (a 24 MP photo can pass 40 MB); the read enforces the bound because the route buffers the image whole. */
export const INBOX_MARKUP_MAX_BYTES = INBOX_MAX_REQUEST_BYTES;

/** The phone door counts the body itself because the window's handler runs in-process. */
export const INBOX_DEVICE_MARKUP_MAX_BYTES = 32 * 1024 * 1024;

function markupTooLarge(max: number): InboxError {
  return new InboxError("markup_too_large", `A drawing is at most ${Math.round(max / (1024 * 1024))} MB.`, { max_bytes: max });
}

/** A declared Content-Length over max is refused before a byte is read; a body that grows past it is cancelled, never buffered past the bound. */
export async function readInboxMarkupBody(
  body: ReadableStream<Uint8Array> | null,
  declaredLength: string | null,
  max: number = INBOX_MARKUP_MAX_BYTES,
): Promise<Uint8Array> {
  const declared = declaredLength === null ? Number.NaN : Number(declaredLength);
  if (Number.isFinite(declared) && declared > max) {
    await body?.cancel().catch(() => {});
    throw markupTooLarge(max);
  }
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw markupTooLarge(max);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

export function writeInboxMarkup(inboxDirPath: string, bytes: Uint8Array): { path: string; name: string; contentType: string } {
  const contentType = sniffImageContentType(bytes);
  const ext = contentType ? EXTENSIONS[contentType] : undefined;
  if (!contentType || !ext) throw new InboxError("validation_error", "body: a PNG, JPEG or WebP image.");
  const sha = createHash("sha256").update(bytes).digest("hex");
  const name = `${sha}.${ext}`;
  const dir = inboxMarkupsDir(inboxDirPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, name);
  if (!existsSync(path)) {
    const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temp, bytes, { mode: 0o600 });
    renameSync(temp, path);
  }
  return { path, name, contentType };
}

export function readInboxMarkup(inboxDirPath: string, name: string): { bytes: Buffer; contentType: string } | null {
  if (!isInboxMarkupName(name)) return null;
  try {
    const bytes = readFileSync(join(inboxMarkupsDir(inboxDirPath), name));
    const contentType = sniffImageContentType(bytes);
    return contentType ? { bytes, contentType } : null;
  } catch {
    return null;
  }
}

export function inboxMarkupNamesOf(inboxDirPath: string, annotation: Record<string, unknown>): string[] {
  const images = annotation.images;
  if (!Array.isArray(images)) return [];
  const dir = inboxMarkupsDir(inboxDirPath);
  const out: string[] = [];
  for (const image of images) {
    const path = image && typeof image === "object" ? (image as { path?: unknown }).path : undefined;
    if (typeof path !== "string" || !path.startsWith(`${dir}${sep}`)) continue;
    const name = path.slice(dir.length + 1);
    if (isInboxMarkupName(name)) out.push(name);
  }
  return out;
}

export function removeInboxMarkups(inboxDirPath: string, names: readonly string[]): void {
  for (const name of names) {
    if (!isInboxMarkupName(name)) continue;
    try {
      unlinkSync(join(inboxMarkupsDir(inboxDirPath), name));
    } catch {
      // Already gone.
    }
  }
}
