/**
 * Plannotator Inbox: the person's marked-up images (a comment on an image
 * attachment, drawn with ui's ImageAnnotator).
 *
 *   inbox/markups/<sha256>.<png|jpg|webp>
 *
 * The window posts the PNG the annotator composited; the Inbox keeps it
 * content-addressed, owner-only, under its data dir, and the comment carries
 * its absolute path as an `images` entry, so the reply's feedback names a
 * file the agent can open (`- [shot-markup] /…/inbox/markups/<sha>.png`).
 * The window shows it back through `GET /api/inbox/markups/<name>`, by name
 * only. A markup the deleted thread's or project's annotations named, and no
 * remaining annotation names, is removed with it; one no annotation names yet
 * (uploaded, its comment not saved) is left alone.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { sniffImageContentType } from "../review-image";
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

/** Keep a marked-up image (PNG, JPEG or WebP by its bytes), once. Returns its absolute path and file name. */
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

/** A markup's bytes by its file name, or null. */
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

/** The markup file names an annotation's `images` name (paths under the markups dir). */
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

/** Remove these markups (by file name): the deleted records' markups no remaining annotation names. */
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
