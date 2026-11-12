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

export const REVIEW_MARKDOWN_IMAGE_SRC_MAX = 2048;

export const REVIEW_MARKDOWN_DOC_MAX_BYTES = 2 * 1024 * 1024;

const BUILTIN_MARKDOWN_RE = /\.(md|mdx|markdown)$/i;

export function isReviewMarkdownPath(path: string, extraExtensions: readonly string[] = []): boolean {
  if (BUILTIN_MARKDOWN_RE.test(path)) return true;
  const lower = path.toLowerCase();
  return extraExtensions.some((ext) => ext && lower.endsWith(ext.toLowerCase()));
}

const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\(\s*(<[^>\n]*>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
const MARKDOWN_REF_IMAGE_RE = /!\[([^\]]*)\](?:\[([^\]]*)\])?/g;
const REFERENCE_DEFINITION_RE = /^ {0,3}\[([^\]]+)\]:[ \t]*(<[^>\n]*>|\S+)/gm;
const HTML_IMG_SRC_RE = /<img\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;

const NAMED_ENTITIES: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };

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

export function normalizeImageSource(src: string): string {
  return src.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");
}

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})\s*$/;
const INLINE_CODE_RE = /(?<!`)(`+)(?!`)(?:(?!\n[ \t]*\r?\n)[\s\S])*?[^`]\1(?!`)/g;

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
    if (open && !(open[1][0] === "`" && open[2].includes("`"))) {
      fence = { char: open[1][0], length: open[1].length };
      lines[i] = "";
    }
  }
  return lines.join("\n").replace(INLINE_CODE_RE, "");
}

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
      const after = text.slice((match.index ?? 0) + match[0].length);
      if (match[2] === undefined && after.startsWith("(")) continue;
      const label = normalizeLabel(match[2] ? match[2] : match[1]);
      add(definitions.get(label));
    }
  }
  for (const match of text.matchAll(HTML_IMG_SRC_RE)) add(decodeAttribute(match[1] ?? match[2] ?? match[3] ?? ""));
  return refs;
}

function hasScheme(src: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(src);
}

export type MarkdownImagePathResult =
  | { kind: "ok"; path: string }
  | { kind: "bad-request" }
  | { kind: "not-image" }
  | { kind: "outside-repo" };

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

export interface ReviewMarkdownImageRequest {
  params: URLSearchParams;
  ifNoneMatch?: string | null;
  available: boolean;
  patch: string;
  markdownExtensions?: readonly string[];
  isCurrentSnapshot: (snapshot: string) => boolean;
  signal?: AbortSignal;
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
