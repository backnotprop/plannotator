/**
 * Plannotator Inbox: images an agent's message shows (#1813).
 *
 * A message body can carry `![alt](shots/after.png)` or `<img src="…">`
 * naming an image in the sender's project. The window asks for it through
 * `GET /api/inbox/messages/<id>/image?path=<the src as written>`
 * (packages/server/inbox-message-images.ts), and this module decides every
 * answer. The rules, in order:
 *
 *  1. The path must appear in THAT message's body as an image reference
 *     (`inboxMessageImageRefs`), compared as written. So the route reads
 *     only what the message shows, never a file a caller names.
 *  2. It must name an image by extension (png jpg jpeg gif webp svg avif bmp
 *     ico apng, `isReviewImagePath`), before anything is read.
 *  3. A relative path resolves against the folder the agent sent from
 *     (`base_path`, kept on the message when it is a subfolder of the
 *     project), else the project root; an absolute one is taken as it is.
 *     Both the resolved path and its realpath must sit inside the project
 *     root (a realpath itself), so `../` and a symlink that leaves the
 *     project are refused alike.
 *  4. A regular file of at most MAX_REVIEW_IMAGE_PREVIEW_BYTES (and
 *     MAX_REVIEW_IMAGE_PREVIEW_PIXELS), whose content type is sniffed from
 *     its magic bytes (code review's sniffer), never taken from the name.
 */

import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { MAX_REVIEW_IMAGE_PREVIEW_BYTES, MAX_REVIEW_IMAGE_PREVIEW_PIXELS, isReviewImagePath } from "../diff-paths";
import { isLfsPointer, readImageDimensions, sniffImageContentType } from "../review-image";

/** The longest `path` the route takes. */
export const INBOX_MESSAGE_IMAGE_PATH_MAX = 2048;

/** The image answer's policy: an SVG opened directly never runs a script. */
export const INBOX_MESSAGE_IMAGE_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'";

/** The markdown image grammar the window renders (InlineMarkdown): the src is everything up to the first `)`. */
const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\(([^)]+)\)/g;
/** An `<img>` tag's src attribute, quoted or not. */
const HTML_IMG_SRC_RE = /<img\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;

const NAMED_ENTITIES: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };

/** The attribute value as the browser reads it (getAttribute decodes character references). */
function decodeAttribute(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[ref.toLowerCase()] ?? whole;
  });
}

/**
 * Every image source the body names, as the window sends it: the markdown
 * `![alt](src)` target as written and each `<img src>` value decoded. Remote
 * (`http(s):`), `data:` and `blob:` sources are left out: the window never
 * asks the server for them.
 */
export function inboxMessageImageRefs(body: string): Set<string> {
  const refs = new Set<string>();
  const add = (src: string | undefined) => {
    if (!src) return;
    if (/^(https?:|data:|blob:)/i.test(src)) return;
    refs.add(src);
  };
  for (const match of body.matchAll(MARKDOWN_IMAGE_RE)) add(match[1]);
  for (const match of body.matchAll(HTML_IMG_SRC_RE)) add(decodeAttribute(match[1] ?? match[2] ?? match[3] ?? ""));
  return refs;
}

export type InboxMessageImageResult =
  | { ok: true; bytes: Buffer; contentType: string; width?: number; height?: number }
  | { ok: false; status: number; code: string; error: string };

function refuse(status: number, code: string, error: string): InboxMessageImageResult {
  return { ok: false, status, code, error };
}

function isInside(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/**
 * The filesystem paths a src may mean, in order: as written, without a
 * `?query` / `#fragment`, and percent-decoded (`my%20shot.png`).
 */
function pathCandidates(src: string): string[] {
  const out = [src];
  const stripped = src.replace(/[?#].*$/s, "");
  if (stripped && stripped !== src) out.push(stripped);
  if (stripped.includes("%")) {
    try {
      const decoded = decodeURIComponent(stripped);
      if (decoded !== stripped) out.push(decoded);
    } catch {
      // Not percent-encoded after all.
    }
  }
  return out;
}

/** A URL scheme the route never reads (`file:`, `javascript:`); a Windows drive letter is a path. */
function hasScheme(src: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(src) && !/^[a-z]:[\\/]/i.test(src);
}

/**
 * Read one image a message shows. `root` is the project's root (a realpath);
 * `base` the folder relative paths start from (the message's `base_path`, or
 * the root). Never throws.
 */
export function readInboxMessageImage(input: { body: string; root: string; base?: string | null; path: string | null }): InboxMessageImageResult {
  const src = input.path;
  if (typeof src !== "string" || src === "") return refuse(400, "validation_error", "path: required.");
  if (src.length > INBOX_MESSAGE_IMAGE_PATH_MAX || /[\u0000-\u001f\u007f]/.test(src)) {
    return refuse(400, "validation_error", "path: not a usable image path.");
  }
  if (!inboxMessageImageRefs(input.body).has(src)) {
    return refuse(403, "image_not_referenced", "This message does not show that image.");
  }
  if (hasScheme(src)) return refuse(400, "validation_error", "path: not a file path.");

  let root: string;
  try {
    root = realpathSync(input.root);
  } catch {
    return refuse(404, "image_missing", "The message's project is no longer on disk.");
  }
  let base = root;
  if (input.base) {
    try {
      const real = realpathSync(input.base);
      if (isInside(real, root)) base = real;
    } catch {
      // The folder the agent sent from is gone: paths start at the root.
    }
  }

  const candidates = pathCandidates(src).filter((candidate) => isReviewImagePath(candidate));
  if (candidates.length === 0) return refuse(415, "not_an_image", "Only png, jpg, gif, webp, svg, avif, bmp and ico images are shown.");

  for (const candidate of candidates) {
    const named = isAbsolute(candidate) ? resolve(candidate) : resolve(base, candidate);
    if (!isInside(named, root)) return refuse(403, "outside_project", "That image is outside the message's project.");
    let real: string;
    try {
      real = realpathSync(named);
    } catch {
      continue;
    }
    if (!isInside(real, root)) return refuse(403, "outside_project", "That image leads outside the message's project.");
    let stat;
    try {
      stat = statSync(real);
    } catch {
      continue;
    }
    if (!stat.isFile()) return refuse(404, "image_missing", "That image is not a file.");
    if (stat.size > MAX_REVIEW_IMAGE_PREVIEW_BYTES) return refuse(413, "image_too_large", "That image is larger than 10 MB.");
    let bytes: Buffer;
    try {
      bytes = readFileSync(real);
    } catch {
      return refuse(404, "image_missing", "That image could not be read.");
    }
    if (bytes.byteLength > MAX_REVIEW_IMAGE_PREVIEW_BYTES) return refuse(413, "image_too_large", "That image is larger than 10 MB.");
    if (isLfsPointer(bytes)) return refuse(415, "not_an_image", "That image is stored in Git LFS.");
    const contentType = sniffImageContentType(bytes);
    if (!contentType) return refuse(415, "not_an_image", "That file is not a recognized image.");
    const dims = readImageDimensions(bytes, contentType);
    if (dims && dims.width * dims.height > MAX_REVIEW_IMAGE_PREVIEW_PIXELS) {
      return refuse(413, "image_too_large", "That image has too many pixels to show.");
    }
    return { ok: true, bytes, contentType, ...(dims ? { width: dims.width, height: dims.height } : {}) };
  }
  return refuse(404, "image_missing", "That image is not on disk.");
}
