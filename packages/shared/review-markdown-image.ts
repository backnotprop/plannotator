/**
 * Code-review Markdown preview: images a reviewed Markdown file shows.
 * `GET /api/review-markdown-image?doc=&side=old|new&src=&snapshot=`.
 *
 * The preview renders a Markdown file at one side of the diff, and an image
 * it names (`![shot](img/after.png)`) must be read at THAT side's revision,
 * never from the working tree by default, so a deleted file, a PR or a
 * committed diff shows the image as it was. Every decision lives here; the
 * Bun server and the Pi mirror supply only `readSide`, the same reader
 * `/api/review-image` uses. The rules, in order:
 *
 *  1. The session must have full file contents (`available`), the request
 *     must name `doc`, `side`, `src` and the current `snapshot`.
 *  2. `doc` must be a file in the current patch whose path at that side is a
 *     Markdown file (`.md`, `.mdx`, `.markdown`, or a config.json
 *     `markdownExtensions` entry), and that side must exist.
 *  3. `src` (as written; leading and trailing whitespace dropped, as a
 *     browser does) must be a plain relative or root-relative path (no scheme, no
 *     `//`, no backslash, no control characters, at most 2048 characters)
 *     naming an image by extension, checked before anything is read.
 *  4. It resolves against the doc's folder at that side (`/` = repository
 *     root, GitHub's README rule); one that climbs above the root is refused.
 *  5. The doc's text at that side must reference `src` as an image (a
 *     markdown image, a reference-style image definition, or an `<img src>`,
 *     never one inside a code block or code span), so the route reads only
 *     what the file shows.
 *  6. The image is read at that side and answered exactly like
 *     `/api/review-image` (caps, LFS pointer, sniffed type, headers, ETag).
 */

import { MAX_REVIEW_IMAGE_PREVIEW_BYTES, isReviewImagePath } from "./diff-paths";
import {
  type DiffSide,
  type FileBytesRead,
  findPatchFileEntry,
  validateFilePath,
} from "./review-core";
import {
  ReviewImageAbortError,
  type ReviewImageResponse,
  reviewImageBytesResponse,
  reviewImageErrorResponse,
} from "./review-image";

export const REVIEW_MARKDOWN_IMAGE_ENDPOINT = "/api/review-markdown-image";

/** The longest `src` the route takes (the Inbox's message-image rule). */
export const REVIEW_MARKDOWN_IMAGE_SRC_MAX = 2048;

/** The most of the Markdown file read to check that it references `src`. */
export const REVIEW_MARKDOWN_DOC_MAX_BYTES = 2 * 1024 * 1024;

const BUILTIN_MARKDOWN_RE = /\.(md|mdx|markdown)$/i;

/** True when `path` is a Markdown file the preview renders. */
export function isReviewMarkdownPath(path: string, extraExtensions: readonly string[] = []): boolean {
  if (BUILTIN_MARKDOWN_RE.test(path)) return true;
  const lower = path.toLowerCase();
  return extraExtensions.some((ext) => ext && lower.endsWith(ext.toLowerCase()));
}

// --- References -------------------------------------------------------------

/** `![alt](src)`, `![alt](<src>)`, `![alt](src "title")`. */
const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\(\s*(<[^>\n]*>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
/** `![alt][ref]`, `![alt][]` and `![ref]`: the labels a reference image uses. */
const MARKDOWN_REF_IMAGE_RE = /!\[([^\]]*)\](?:\[([^\]]*)\])?/g;
/** `[ref]: src "title"` link reference definitions. */
const REFERENCE_DEFINITION_RE = /^ {0,3}\[([^\]]+)\]:[ \t]*(<[^>\n]*>|\S+)/gm;
/** An `<img>` tag's src attribute, quoted or not. */
const HTML_IMG_SRC_RE = /<img\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;

const NAMED_ENTITIES: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };

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

function unwrapAngle(target: string): string {
  return target.startsWith("<") && target.endsWith(">") ? target.slice(1, -1) : target;
}

function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * An image source with the leading and trailing ASCII whitespace a browser's
 * URL parser strips (`<img src=" a.png">` loads `a.png`). The route applies it
 * to the requested `src` and to every reference alike, so the client can send
 * the source exactly as written.
 */
export function normalizeImageSource(src: string): string {
  return src.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");
}

/** A fence opener: up to three spaces, then three or more backticks or tildes. */
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})\s*$/;
/** An inline code span that stays inside one paragraph (CommonMark's backtick-run rule). */
const INLINE_CODE_RE = /(?<!`)(`+)(?!`)(?:(?!\n[ \t]*\r?\n)[\s\S])*?[^`]\1(?!`)/g;

/**
 * The Markdown text with its code taken out: fenced code blocks (``` or ~~~,
 * to the matching close or the end of the text) become empty lines and inline
 * code spans are removed. An image written inside code renders as code, so it
 * is not an image the file shows.
 */
export function stripMarkdownCode(text: string): string {
  const lines = text.split("\n");
  let fence: { char: string; length: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence) {
      const close = FENCE_CLOSE_RE.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = null;
      lines[i] = "";
      continue;
    }
    const open = FENCE_OPEN_RE.exec(line);
    // A backtick fence's info string cannot hold a backtick (that is inline code).
    if (open && !(open[1][0] === "`" && open[2].includes("`"))) {
      fence = { char: open[1][0], length: open[1].length };
      lines[i] = "";
    }
  }
  return lines.join("\n").replace(INLINE_CODE_RE, "");
}

/**
 * Every image source the Markdown text names, as the preview's renderer
 * asks for it: a markdown image target as written (angle brackets removed),
 * a reference-style image's definition target, and each `<img src>` value
 * decoded, each through `normalizeImageSource`. Images inside code (fenced
 * blocks, inline spans) are not shown and are left out, as are remote,
 * `data:` and `blob:` sources.
 */
export function markdownImageRefs(markdown: string): Set<string> {
  const text = stripMarkdownCode(markdown);
  const refs = new Set<string>();
  const add = (raw: string | undefined) => {
    const src = raw === undefined ? "" : normalizeImageSource(raw);
    if (!src) return;
    if (/^(https?:|data:|blob:)/i.test(src)) return;
    refs.add(src);
  };
  for (const match of text.matchAll(MARKDOWN_IMAGE_RE)) add(unwrapAngle(match[1]));
  const definitions = new Map<string, string>();
  for (const match of text.matchAll(REFERENCE_DEFINITION_RE)) {
    const label = normalizeLabel(match[1]);
    if (!definitions.has(label)) definitions.set(label, unwrapAngle(match[2]));
  }
  if (definitions.size > 0) {
    for (const match of text.matchAll(MARKDOWN_REF_IMAGE_RE)) {
      // `![alt](...)` is an inline image, handled above.
      const after = text.slice((match.index ?? 0) + match[0].length);
      if (match[2] === undefined && after.startsWith("(")) continue;
      const label = normalizeLabel(match[2] ? match[2] : match[1]);
      add(definitions.get(label));
    }
  }
  for (const match of text.matchAll(HTML_IMG_SRC_RE)) add(decodeAttribute(match[1] ?? match[2] ?? match[3] ?? ""));
  return refs;
}

// --- Path resolution --------------------------------------------------------

/** A URL scheme (`file:`, `javascript:`, `http:`); a Windows drive letter counts too. */
function hasScheme(src: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(src);
}

export type MarkdownImagePathResult =
  | { kind: "ok"; path: string }
  | { kind: "bad-request" }
  | { kind: "not-image" }
  | { kind: "outside-repo" };

/**
 * Resolve `src`, as written in the Markdown file at `docPath` (a
 * repository-relative path), to a repository-relative path. Pure.
 */
export function resolveMarkdownImagePath(docPath: string, src: string): MarkdownImagePathResult {
  if (!src || src.length > REVIEW_MARKDOWN_IMAGE_SRC_MAX) return { kind: "bad-request" };
  if (/[\u0000-\u001f\u007f]/.test(src)) return { kind: "bad-request" };
  if (src.includes("\\")) return { kind: "bad-request" };
  if (src.startsWith("//") || hasScheme(src)) return { kind: "bad-request" };
  let raw = src.replace(/[?#].*$/s, "");
  if (raw === "") return { kind: "bad-request" };
  if (raw.includes("%")) {
    try {
      raw = decodeURIComponent(raw);
    } catch {
      // Not percent-encoded after all: keep it as written.
    }
  }
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return { kind: "bad-request" };
  if (!isReviewImagePath(raw)) return { kind: "not-image" };

  const fromRoot = raw.startsWith("/");
  const docFolder = docPath.includes("/") ? docPath.slice(0, docPath.lastIndexOf("/")) : "";
  const segments = fromRoot ? [] : docFolder.split("/").filter(Boolean);
  for (const segment of raw.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return { kind: "outside-repo" };
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  if (segments.length === 0) return { kind: "bad-request" };
  const path = segments.join("/");
  try {
    validateFilePath(path);
  } catch {
    return { kind: "bad-request" };
  }
  return { kind: "ok", path };
}

// --- The request ------------------------------------------------------------

export interface ReviewMarkdownImageRequest {
  /** Query parameters (`doc`, `side`, `src`, `snapshot`). */
  params: URLSearchParams;
  /** `If-None-Match` request header, for the 304 path. */
  ifNoneMatch?: string | null;
  /** False when the session has no full file contents (static patch, P4). */
  available: boolean;
  /** The session's current patch: `doc` must be one of its files. */
  patch: string;
  /** config.json `markdownExtensions`, normalized (`.livemd`). */
  markdownExtensions?: readonly string[];
  /** Whether `snapshot` names the snapshot the server is serving right now. */
  isCurrentSnapshot: (snapshot: string) => boolean;
  /** Aborts when the client goes away. */
  signal?: AbortSignal;
  /**
   * Read one repository path at one side in the server's current mode (the
   * `/api/review-image` reader). For the old side `oldPath` names the path.
   */
  readSide: (
    side: DiffSide,
    filePath: string,
    oldPath: string | undefined,
    maxBytes: number,
    signal?: AbortSignal,
  ) => Promise<FileBytesRead>;
}

async function readOrError(
  request: ReviewMarkdownImageRequest,
  side: DiffSide,
  filePath: string,
  oldPath: string | undefined,
  maxBytes: number,
): Promise<FileBytesRead | ReviewImageResponse> {
  try {
    return await request.readSide(side, filePath, oldPath, maxBytes, request.signal);
  } catch (error) {
    if (error instanceof ReviewImageAbortError || request.signal?.aborted) {
      return reviewImageErrorResponse(499, { reason: "aborted", error: "The request was aborted" });
    }
    return reviewImageErrorResponse(502, {
      reason: "fetch-failed",
      error: error instanceof Error ? error.message : "Failed to read the file",
    });
  }
}

function isResponse(value: FileBytesRead | ReviewImageResponse): value is ReviewImageResponse {
  return "status" in value;
}

/** Resolve one `GET /api/review-markdown-image` request to a transport-neutral response. */
export async function handleReviewMarkdownImageRequest(
  request: ReviewMarkdownImageRequest,
): Promise<ReviewImageResponse> {
  if (!request.available) {
    return reviewImageErrorResponse(400, { reason: "unavailable", error: "Markdown preview images are unavailable for this review" });
  }
  const doc = request.params.get("doc");
  const side = request.params.get("side");
  const rawSrc = request.params.get("src");
  const src = rawSrc === null ? null : normalizeImageSource(rawSrc);
  const snapshot = request.params.get("snapshot");
  if (!doc || (side !== "old" && side !== "new") || !src || !snapshot) {
    return reviewImageErrorResponse(400, { reason: "bad-request", error: "Expected doc, side=old|new, src and snapshot" });
  }
  if (!request.isCurrentSnapshot(snapshot)) {
    return reviewImageErrorResponse(409, { reason: "stale", error: "Diff snapshot is stale; refresh the review" });
  }

  const entry = findPatchFileEntry(request.patch, doc);
  const extras = request.markdownExtensions ?? [];
  if (!entry) {
    return reviewImageErrorResponse(404, { reason: "not-in-diff", error: "No Markdown file by that path in this diff" });
  }
  const docSidePath = side === "old" ? entry.oldPath : entry.newPath;
  const anyMarkdown = [entry.oldPath, entry.newPath].some((p) => p && isReviewMarkdownPath(p, extras));
  if (!anyMarkdown) {
    return reviewImageErrorResponse(404, { reason: "not-in-diff", error: "That file is not a Markdown file" });
  }
  if (!docSidePath) {
    return reviewImageErrorResponse(404, { reason: "absent", error: `This file has no ${side === "old" ? "before" : "after"} version` });
  }
  if (!isReviewMarkdownPath(docSidePath, extras)) {
    return reviewImageErrorResponse(404, { reason: "not-in-diff", error: "That file is not a Markdown file at this version" });
  }
  try {
    validateFilePath(docSidePath);
    if (entry.newPath) validateFilePath(entry.newPath);
  } catch {
    return reviewImageErrorResponse(404, { reason: "not-in-diff", error: "Invalid file path" });
  }

  const resolved = resolveMarkdownImagePath(docSidePath, src);
  switch (resolved.kind) {
    case "bad-request":
      return reviewImageErrorResponse(400, { reason: "bad-request", error: "Not a usable image path" });
    case "not-image":
      return reviewImageErrorResponse(415, { reason: "not-image", error: "Only png, jpg, gif, webp, svg, avif, bmp, ico and apng images are shown" });
    case "outside-repo":
      return reviewImageErrorResponse(403, { reason: "outside-repo", error: "That image is outside the repository" });
  }

  // The doc must reference the image: the route reads only what the file shows.
  const docRead = await readOrError(
    request,
    side,
    entry.newPath ?? docSidePath,
    entry.oldPath,
    REVIEW_MARKDOWN_DOC_MAX_BYTES,
  );
  if (isResponse(docRead)) return docRead;
  switch (docRead.kind) {
    case "unavailable":
      return reviewImageErrorResponse(400, { reason: "unavailable", error: "Markdown preview images are unavailable for this review" });
    case "missing":
      return reviewImageErrorResponse(404, { reason: "missing", error: "The Markdown file could not be found at this version" });
    case "too-large":
      return reviewImageErrorResponse(413, { reason: "too-large", error: "The Markdown file is too large", bytes: docRead.size });
  }
  const docText = new TextDecoder("utf-8", { fatal: false }).decode(docRead.bytes);
  if (!markdownImageRefs(docText).has(src)) {
    return reviewImageErrorResponse(403, { reason: "not-referenced", error: "The Markdown file does not show that image" });
  }

  const imageRead = await readOrError(request, side, resolved.path, resolved.path, MAX_REVIEW_IMAGE_PREVIEW_BYTES);
  if (isResponse(imageRead)) return imageRead;
  return reviewImageBytesResponse(imageRead, request.ifNoneMatch);
}
