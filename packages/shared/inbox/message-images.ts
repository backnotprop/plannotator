/** Decides every answer for an image a message body shows. The path must appear in that message's body and have an image extension; hidden-folder and dotenv refusals are judged on the path as named AND its realpath; the realpath is opened once (O_NOFOLLOW | O_NONBLOCK) and everything after reads the descriptor; the type is sniffed from magic bytes, never the name. */

import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { isDotenvFileName } from "@plannotator/core/annotatable";
import { MAX_REVIEW_IMAGE_PREVIEW_BYTES, MAX_REVIEW_IMAGE_PREVIEW_PIXELS, isReviewImagePath } from "../diff-paths";
import { isLfsPointer, readImageDimensions, sniffImageContentType } from "../review-image";

export const INBOX_MESSAGE_IMAGE_PATH_MAX = 2048;

/** The image answer's policy: an SVG opened directly never runs a script. */
export const INBOX_MESSAGE_IMAGE_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'";

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

const REMOTE_SRC_RE = /^(https?:|\/\/|\\\\)/i;
const NOT_LOCAL_SRC_RE = /^(https?:|\/\/|\\\\|data:|blob:)/i;

export function inboxMessageImageRefs(body: string): Set<string> {
  const refs = new Set<string>();
  const add = (src: string | undefined) => {
    if (!src) return;
    if (NOT_LOCAL_SRC_RE.test(src)) return;
    refs.add(src);
  };
  for (const match of body.matchAll(MARKDOWN_IMAGE_RE)) add(match[1]);
  for (const match of body.matchAll(HTML_IMG_SRC_RE)) add(decodeAttribute(match[1] ?? match[2] ?? match[3] ?? ""));
  return refs;
}

export function blankCode(body: string): string {
  const blank = (text: string) => text.replace(/[^\n]/g, " ");
  const lines = body.split("\n");
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence === null) {
      if (open) {
        fence = open[1]!;
        lines[i] = blank(line);
      }
    } else {
      if (open && open[1]![0] === fence[0] && open[1]!.length >= fence.length && line.trim().replace(/[`~]/g, "") === "") fence = null;
      lines[i] = blank(line);
    }
  }
  return blankInlineCode(lines.join("\n"));
}

/** One linear pass: a run of N backticks opens a span closed by the next run of exactly N (CommonMark); cursors only move forward. */
export function blankInlineCode(text: string): string {
  const runs: { start: number; end: number }[] = [];
  for (let i = 0; i < text.length; ) {
    if (text.charCodeAt(i) !== 96) {
      i++;
      continue;
    }
    let j = i;
    while (j < text.length && text.charCodeAt(j) === 96) j++;
    runs.push({ start: i, end: j });
    i = j;
  }
  if (runs.length < 2) return text;
  const byLength = new Map<number, number[]>();
  runs.forEach((run, index) => {
    const n = run.end - run.start;
    const list = byLength.get(n);
    if (list) list.push(index);
    else byLength.set(n, [index]);
  });
  const cursor = new Map<number, number>();
  const spans: { start: number; end: number }[] = [];
  for (let r = 0; r < runs.length; ) {
    const run = runs[r]!;
    const n = run.end - run.start;
    const list = byLength.get(n)!;
    let at = cursor.get(n) ?? 0;
    while (at < list.length && list[at]! <= r) at++;
    cursor.set(n, at);
    if (at >= list.length) {
      r++;
      continue;
    }
    const close = list[at]!;
    spans.push({ start: run.start, end: runs[close]!.end });
    r = close + 1;
  }
  if (spans.length === 0) return text;
  let out = "";
  let last = 0;
  for (const span of spans) {
    out += text.slice(last, span.start) + text.slice(span.start, span.end).replace(/[^\n]/g, " ");
    last = span.end;
  }
  return out + text.slice(last);
}

export function inboxMessageImageRefsInOrder(body: string): string[] {
  return imageSourcesInOrder(body).filter((src) => !NOT_LOCAL_SRC_RE.test(src));
}

export function inboxMessageRemoteImageRefsInOrder(body: string): string[] {
  return imageSourcesInOrder(body).filter((src) => REMOTE_SRC_RE.test(src));
}

function imageSourcesInOrder(body: string): string[] {
  const text = blankCode(body);
  const found: { index: number; src: string }[] = [];
  for (const match of text.matchAll(MARKDOWN_IMAGE_RE)) found.push({ index: match.index ?? 0, src: match[1]! });
  for (const match of text.matchAll(HTML_IMG_SRC_RE)) found.push({ index: match.index ?? 0, src: decodeAttribute(match[1] ?? match[2] ?? match[3] ?? "") });
  found.sort((a, b) => a.index - b.index);
  const out: string[] = [];
  for (const { src } of found) {
    if (!src || out.includes(src)) continue;
    out.push(src);
  }
  return out;
}

export type InboxMessageImageResult =
  | {
      ok: true;
      bytes: Buffer;
      contentType: string;
      width?: number;
      height?: number;
      real: string;
      named: string;
      mtime: string;
    }
  | {
      ok: false;
      status: number;
      code: string;
      error: string;
      notYet?: true;
    };

function refuse(status: number, code: string, error: string): InboxMessageImageResult {
  return { ok: false, status, code, error };
}

function isPermissionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EACCES" || code === "EPERM";
}

const UNREADABLE = "Plannotator can't read that image (on macOS the terminal or app running it may need to be allowed).";
function readFailed(error: unknown): Refusal {
  if (isPermissionError(error)) return failRead(403, "image_unreadable", UNREADABLE);
  return failRead(500, "image_read_failed", `That image could not be read: ${(error as Error | undefined)?.message ?? String(error)}`);
}

function isInside(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/** Exported for send_message's attached-pictures advice, which must count a picture as shown exactly when the window would find it. */
export function pathCandidates(src: string): string[] {
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

function hasScheme(src: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(src) && !/^[a-z]:[\\/]/i.test(src);
}

export interface InboxMessageImageInput {
  body: string;
  root: string;
  base?: string | null;
  path: string | null;
  /** The author is an agent: its images may come from anywhere the user can read. A person's message keeps the project-root boundary (else `403 outside_project`). Default false. */
  anywhere?: boolean;
}

type Refusal = Extract<InboxMessageImageResult, { ok: false }>;

/** Folders that never exempt hidden segments below them (`/`, the home folder, everything above it): a project at `~` must not serve `~/.ssh/key.png`. */
function protectedFolders(): string[] {
  const homes = new Set<string>();
  for (const home of [process.env.HOME, homedir()]) if (home && isAbsolute(home)) for (const spelling of spellings(home)) homes.add(spelling);
  return [...homes];
}

function exemptsHidden(anchor: string, protectedHomes: readonly string[]): boolean {
  if (dirname(anchor) === anchor) return false;
  return !protectedHomes.some((home) => isInside(home, anchor));
}

/** A dotenv-family name is refused everywhere. Outside `anchors`, a path in a hidden folder of the home folder or `/` is refused; a hidden folder elsewhere shows. An anchor that is `/`, the home folder or above exempts nothing. */
function hiddenPath(path: string, anchors: readonly string[], homes: readonly string[]): boolean {
  if (isDotenvFileName(basename(path))) return true;
  const dot = inboxHomeDotFolder(path, homes);
  // An anchor exempts it only from inside that hidden folder (a project in `~/.claude/worktrees/`), never from above it.
  return dot !== null && !anchors.some((folder) => isInside(path, folder) && isInside(folder, dot));
}

/** Whatever `HOME` says: an Inbox started under a scratch or relative HOME still guards the real `~/.ssh` and other users' homes. */
const HOME_SHAPED_DOT_FOLDER = /^(?:\/Users\/[^/]+|\/home\/[^/]+|\/root|\/(?:private\/)?var\/root|[A-Za-z]:[\\/]Users[\\/][^\\/]+)[\\/]\.[^\\/]*/i;

export function inboxHomeDotFolder(path: string, homes: readonly string[] = protectedFolders()): string | null {
  for (const folder of [...homes, parse(path).root]) {
    if (path === folder || !isInside(path, folder)) continue;
    const first = relative(folder, path).split(sep)[0]!;
    if (first.startsWith(".")) return join(folder, first);
  }
  return HOME_SHAPED_DOT_FOLDER.exec(path)?.[0] ?? null;
}

function spellings(folder: string): string[] {
  const out = [resolve(folder)];
  try {
    const real = realpathSync(folder);
    if (real !== out[0]) out.push(real);
  } catch {
    // Not on disk: the spelling given is all there is.
  }
  return out;
}

function locateInboxMessageImage(input: InboxMessageImageInput): Refusal | { ok: true; real: string; named: string } {
  const src = input.path;
  if (typeof src !== "string" || src === "") return refuse(400, "validation_error", "path: required.") as Refusal;
  if (src.length > INBOX_MESSAGE_IMAGE_PATH_MAX || /[\u0000-\u001f\u007f]/.test(src)) {
    return refuse(400, "validation_error", "path: not a usable image path.") as Refusal;
  }
  if (!inboxMessageImageRefs(input.body).has(src)) {
    return refuse(403, "image_not_referenced", "This message does not show that image.") as Refusal;
  }
  if (hasScheme(src)) return refuse(400, "validation_error", "path: not a file path.") as Refusal;

  const roots = spellings(input.root);
  const bases = input.base ? spellings(input.base) : [];
  const base = bases.length > 0 && isOnDisk(bases[0]!) ? bases[bases.length - 1]! : roots[roots.length - 1]!;
  const area = [...roots, ...bases];
  const protectedHomes = protectedFolders();
  const anchors = area.filter((folder) => exemptsHidden(folder, protectedHomes));
  const inArea = (path: string) => input.anywhere === true || area.some((folder) => isInside(path, folder));

  const candidates = pathCandidates(src).filter((candidate) => isReviewImagePath(candidate));
  if (candidates.length === 0) return refuse(415, "not_an_image", "Only png, jpg, gif, webp, svg, avif, bmp and ico images are shown.") as Refusal;

  for (const candidate of candidates) {
    const named = isAbsolute(candidate) ? resolve(candidate) : resolve(base, candidate);
    let real: string;
    try {
      real = realpathSync(named);
    } catch (error) {
      if (isPermissionError(error)) return failRead(403, "image_unreadable", UNREADABLE);
      if (!inArea(named)) return refuse(403, "outside_project", OUTSIDE) as Refusal;
      continue;
    }
    if (!inArea(real)) return refuse(403, "outside_project", OUTSIDE) as Refusal;
    // Judged by where it really leads (a symlink into a hidden folder is refused) and as named.
    if (hiddenPath(real, anchors, protectedHomes) || hiddenPath(join(realFolder(dirname(named)), basename(named)), anchors, protectedHomes)) {
      return refuse(403, "image_hidden", HIDDEN) as Refusal;
    }
    return { ok: true, real, named };
  }
  return { ...(refuse(404, "image_missing", "That image is not on disk.") as Refusal), notYet: true };
}

const OUTSIDE = "A message you write shows images from its project only.";

const HIDDEN = "That image is a .env file, or in a hidden folder of the home folder (such as ~/.ssh).";

function realFolder(folder: string): string {
  try {
    return realpathSync(folder);
  } catch {
    return folder;
  }
}

function isOnDisk(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function finishImage(bytes: Buffer, located: { real: string; named: string }, mtime: string): InboxMessageImageResult {
  if (isLfsPointer(bytes)) return refuse(415, "not_an_image", "That image is stored in Git LFS.");
  const contentType = sniffImageContentType(bytes);
  if (!contentType) return refuse(415, "not_an_image", "That file is not a recognized image.");
  const dims = readImageDimensions(bytes, contentType);
  if (dims && dims.width * dims.height > MAX_REVIEW_IMAGE_PREVIEW_PIXELS) {
    return refuse(413, "image_too_large", "That image has too many pixels to show.");
  }
  return { ok: true, bytes, contentType, real: located.real, named: located.named, mtime, ...(dims ? { width: dims.width, height: dims.height } : {}) };
}

export function readInboxMessageImage(input: InboxMessageImageInput): InboxMessageImageResult {
  const located = locateInboxMessageImage(input);
  if (!located.ok) return located;
  const read = readImageFile(located.real);
  if (!read.ok) return read;
  return finishImage(read.bytes, located, read.mtime);
}

export async function readInboxMessageImageAsync(input: InboxMessageImageInput): Promise<InboxMessageImageResult> {
  const located = locateInboxMessageImage(input);
  if (!located.ok) return located;
  const read = await readImageFileAsync(located.real);
  if (!read.ok) return read;
  return finishImage(read.bytes, located, read.mtime);
}

const HIDDEN_ANYWHERE = "That image is a .env file, or in a hidden folder.";

export async function readInboxPictureAsync(named: string, refused: (path: string) => boolean): Promise<InboxMessageImageResult> {
  if (!isAbsolute(named) || /[\u0000-\u001f\u007f]/.test(named)) return refuse(400, "validation_error", "path: not a usable image path.");
  if (refused(named)) return refuse(403, "image_hidden", HIDDEN_ANYWHERE);
  let real: string;
  try {
    real = realpathSync(named);
  } catch (error) {
    if (isPermissionError(error)) return failRead(403, "image_unreadable", UNREADABLE);
    return { ...failRead(404, "image_missing", "That image is not on disk."), notYet: true };
  }
  if (refused(real)) return refuse(403, "image_hidden", HIDDEN_ANYWHERE);
  const read = await readImageFileAsync(real);
  if (!read.ok) return read;
  return finishImage(read.bytes, { real, named }, read.mtime);
}

const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const TOO_LARGE = "That image is larger than 10 MB.";
const CHANGED = "That image changed while it was read.";

const failRead = (status: number, code: string, error: string): Refusal => ({ ok: false as const, status, code, error });

const HEAD_BYTES = 64 * 1024;

function headRefusal(head: Buffer): Refusal | null {
  if (isLfsPointer(head)) return failRead(415, "not_an_image", "That image is stored in Git LFS.");
  const type = sniffImageContentType(head);
  if (!type) return failRead(415, "not_an_image", "That file is not a recognized image.");
  const dims = readImageDimensions(head, type);
  if (dims && dims.width * dims.height > MAX_REVIEW_IMAGE_PREVIEW_PIXELS) return failRead(413, "image_too_large", "That image has too many pixels to show.");
  return null;
}

/** The path must still lead to the file a descriptor read, so a parent folder swapped for a symlink in between is caught. */
function stillSameFile(real: string, stat: { dev: number; ino: number }): boolean {
  try {
    if (realpathSync(real) !== real) return false;
    const again = statSync(real);
    return again.dev === stat.dev && again.ino === stat.ino;
  } catch {
    return false;
  }
}

// Through one descriptor: never follows a final symlink, never blocks on a FIFO, reads at most cap + 1 bytes, and refuses if the path no longer leads to the file read.
function readImageFile(real: string): { ok: true; bytes: Buffer; mtime: string } | Refusal {
  let fd: number;
  try {
    fd = openSync(real, OPEN_FLAGS);
  } catch (error) {
    // ELOOP: the last component became a symlink after it was resolved.
    if ((error as NodeJS.ErrnoException).code === "ELOOP") return failRead(409, "image_changed", CHANGED);
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return failRead(404, "image_missing", "That image could not be opened.");
    return readFailed(error);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return failRead(404, "image_missing", "That image is not a file.");
    if (stat.size > MAX_REVIEW_IMAGE_PREVIEW_BYTES) return failRead(413, "image_too_large", TOO_LARGE);
    // One byte past what fstat said, so a file that grew meanwhile is seen.
    const buffer = Buffer.alloc(Math.min(stat.size, MAX_REVIEW_IMAGE_PREVIEW_BYTES) + 1);
    let total = 0;
    const head = Math.min(buffer.length, HEAD_BYTES);
    let checked = false;
    while (total < buffer.length) {
      const n = readSync(fd, buffer, total, (checked ? buffer.length : head) - total, null);
      if (n === 0) break;
      total += n;
      if (!checked && total >= head) {
        checked = true;
        const refused = headRefusal(buffer.subarray(0, total));
        if (refused) return refused;
      }
    }
    if (!checked) {
      const refused = headRefusal(buffer.subarray(0, total));
      if (refused) return refused;
    }
    if (total > MAX_REVIEW_IMAGE_PREVIEW_BYTES) return failRead(413, "image_too_large", TOO_LARGE);
    if (total === buffer.length) return failRead(409, "image_changed", CHANGED);
    if (!stillSameFile(real, stat)) return failRead(409, "image_changed", CHANGED);
    return { ok: true, bytes: buffer.subarray(0, total), mtime: stat.mtime.toISOString() };
  } catch (error) {
    return readFailed(error);
  } finally {
    closeSync(fd);
  }
}

async function readImageFileAsync(real: string): Promise<{ ok: true; bytes: Buffer; mtime: string } | Refusal> {
  let handle: FileHandle;
  try {
    handle = await open(real, OPEN_FLAGS);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") return failRead(409, "image_changed", CHANGED);
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return failRead(404, "image_missing", "That image could not be opened.");
    return readFailed(error);
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return failRead(404, "image_missing", "That image is not a file.");
    if (stat.size > MAX_REVIEW_IMAGE_PREVIEW_BYTES) return failRead(413, "image_too_large", TOO_LARGE);
    const buffer = Buffer.alloc(Math.min(stat.size, MAX_REVIEW_IMAGE_PREVIEW_BYTES) + 1);
    let total = 0;
    const head = Math.min(buffer.length, HEAD_BYTES);
    let checked = false;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, Math.min(1024 * 1024, (checked ? buffer.length : head) - total), total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (!checked && total >= head) {
        checked = true;
        const refused = headRefusal(buffer.subarray(0, total));
        if (refused) return refused;
      }
    }
    if (!checked) {
      const refused = headRefusal(buffer.subarray(0, total));
      if (refused) return refused;
    }
    if (total > MAX_REVIEW_IMAGE_PREVIEW_BYTES) return failRead(413, "image_too_large", TOO_LARGE);
    if (total === buffer.length) return failRead(409, "image_changed", CHANGED);
    if (!stillSameFile(real, stat)) return failRead(409, "image_changed", CHANGED);
    return { ok: true, bytes: buffer.subarray(0, total), mtime: stat.mtime.toISOString() };
  } catch (error) {
    return readFailed(error);
  } finally {
    await handle.close().catch(() => {});
  }
}
