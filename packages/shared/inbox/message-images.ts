/**
 * Plannotator Inbox: images a message shows (#1813).
 *
 * A message body (an agent's, or the person's own) can carry
 * `![alt](shots/after.png)` or `<img src="…">` naming an image on this
 * computer. The window asks for it through
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
 *     project or a linked worktree of its repository, or the working folder
 *     its connection named, wherever it is), else the project root; an absolute one is taken as it is. It may lead anywhere the
 *     person's user can read, as an attachment may (owner ruling
 *     2026-10-16: no project boundary), except (`403 image_hidden`), judged
 *     on the path as named AND on its realpath, so a symlink into `~/.ssh`
 *     is refused too: a dotenv-family name anywhere, as attachments refuse
 *     it, and, outside the project and the folder sent from, anything in a
 *     hidden folder of the home folder or of `/` (`~/.ssh`, `~/.config`,
 *     `~/.cache`). A hidden folder anywhere else shows, as an attachment
 *     from it would (`~/work/.ops/shot.png`, `.walkthrough/`, a project in
 *     `~/.claude/worktrees/`).
 *  4. The realpath is opened once, `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`, and
 *     everything after that reads the descriptor: `fstat` must say a regular
 *     file of at most MAX_REVIEW_IMAGE_PREVIEW_BYTES, at most cap + 1 bytes
 *     are read, and the path must still lead to that same file afterwards.
 *     A swap to a symlink, a FIFO (a blocking open or read would hang the
 *     Inbox's event loop on it) or a device is refused, never read. Then
 *     MAX_REVIEW_IMAGE_PREVIEW_PIXELS, and the content type is sniffed from
 *     the magic bytes (code review's sniffer), never taken from the name.
 */

import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { isDotenvFileName } from "@plannotator/core/annotatable";
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

/** A remote source: `http(s):`, or protocol-relative `//host/x.png` (never a local path). */
const REMOTE_SRC_RE = /^(https?:|\/\/|\\\\)/i;
/** A source the server never reads: remote, `data:` or `blob:`. */
const NOT_LOCAL_SRC_RE = /^(https?:|\/\/|\\\\|data:|blob:)/i;

/**
 * Every image source the body names, as the window sends it: the markdown
 * `![alt](src)` target as written and each `<img src>` value decoded. Remote
 * (`http(s):`, protocol-relative `//host/…`), `data:` and `blob:` sources are
 * left out: the window never asks the server for them.
 */
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

/** Fenced code blocks and inline code spans, blanked to spaces (line breaks kept) so the image grammar never matches inside them. */
function blankCode(body: string): string {
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

/**
 * Inline code spans blanked to spaces (line breaks kept), in one linear pass:
 * a run of N backticks opens a span that the next run of exactly N closes
 * (CommonMark); a run with no such closer stays literal. Each run length has
 * one cursor over the runs of that length, and cursors only move forward, so
 * a body of many unmatched backticks is still linear.
 */
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

/**
 * The images the body shows, each once, in the order the text shows them:
 * the sources `inboxMessageImageRefs` finds, minus any inside a code block or
 * an inline code span (drawn as code, never as an image). What the store
 * captures (inline-images.ts), in the order the window steps through them.
 */
export function inboxMessageImageRefsInOrder(body: string): string[] {
  return imageSourcesInOrder(body).filter((src) => !NOT_LOCAL_SRC_RE.test(src));
}

/**
 * The remote images the body shows (`http:`, `https:`, protocol-relative
 * `//host/…`), each once, in text order, outside code. The window never loads
 * them (its CSP allows only its own origin, `data:` and `blob:`), so
 * send_message warns about them.
 */
export function inboxMessageRemoteImageRefsInOrder(body: string): string[] {
  return imageSourcesInOrder(body).filter((src) => REMOTE_SRC_RE.test(src));
}

/** Every image source the body shows outside code, each once, in text order. */
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
      /** The realpath read. */
      real: string;
      /** The path the src named, resolved to an absolute path before symlinks. */
      named: string;
      /** The file's mtime, from the descriptor that was read. */
      mtime: string;
    }
  | {
      ok: false;
      status: number;
      code: string;
      error: string;
      /** `image_missing` because nothing is at the path yet (it shows once written), not a folder or FIFO there. */
      notYet?: true;
    };

function refuse(status: number, code: string, error: string): InboxMessageImageResult {
  return { ok: false, status, code, error };
}

/** EACCES / EPERM: the file is there, and Plannotator may not read it (macOS privacy, permissions). */
function isPermissionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EACCES" || code === "EPERM";
}

const UNREADABLE = "Plannotator can't read that image (on macOS the terminal or app running it may need to be allowed).";
/** A read that failed for a reason not foreseen: neither missing nor refused. */
function readFailed(error: unknown): Refusal {
  if (isPermissionError(error)) return failRead(403, "image_unreadable", UNREADABLE);
  return failRead(500, "image_read_failed", `That image could not be read: ${(error as Error | undefined)?.message ?? String(error)}`);
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

export interface InboxMessageImageInput {
  body: string;
  /** The project's root: relative paths start here when there is no `base`. */
  root: string;
  /** The folder the agent sent from (`base_path`): relative paths start here. */
  base?: string | null;
  path: string | null;
  /**
   * The message's author is an agent: its images may come from anywhere the
   * user can read (owner ruling 2026-10-16). A person's own message (which a
   * paired phone, the relay or an allowed tailnet login can post) keeps the
   * boundary of before: the project root or the folder sent from, else
   * `403 outside_project`. Default false.
   */
  anywhere?: boolean;
}

type Refusal = Extract<InboxMessageImageResult, { ok: false }>;

/**
 * Folders that never exempt hidden segments below them: `/`, the home folder
 * (`HOME` and `os.homedir()`, each in both spellings) and every folder above
 * it. A project at `~` must not serve `~/.ssh/key.png` or `~/.cache/…`.
 */
function protectedFolders(): string[] {
  const homes = new Set<string>();
  for (const home of [process.env.HOME, homedir()]) if (home && isAbsolute(home)) for (const spelling of spellings(home)) homes.add(spelling);
  return [...homes];
}

function exemptsHidden(anchor: string, protectedHomes: readonly string[]): boolean {
  if (dirname(anchor) === anchor) return false;
  return !protectedHomes.some((home) => isInside(home, anchor));
}

/**
 * The hidden rule for one absolute path. A dotenv-family file name is refused
 * everywhere, as attachments refuse it. Outside `anchors` (the project root
 * and the folder sent from, each in both spellings), a path in a hidden
 * folder of the home folder or of `/` is refused too (`inboxHomeDotFolder`:
 * `~/.ssh`, `~/.config`, `~/.cache`, where keys, settings and caches live).
 * A hidden folder anywhere else belongs to someone's work and shows, as an
 * attachment from it would: `~/work/.ops/shot.png`, screenshots in
 * `.walkthrough/` or `.playwright-mcp/`, a project that itself sits in a
 * hidden folder (`~/.claude/worktrees/…`). An anchor that is `/`, the home
 * folder or above it exempts nothing (`protectedFolders`).
 */
function hiddenPath(path: string, anchors: readonly string[], homes: readonly string[]): boolean {
  if (isDotenvFileName(basename(path))) return true;
  const dot = inboxHomeDotFolder(path, homes);
  // An anchor exempts it only from inside that hidden folder (a project in `~/.claude/worktrees/`), never from above it.
  return dot !== null && !anchors.some((folder) => isInside(path, folder) && isInside(folder, dot));
}

/**
 * A home-shaped folder's own hidden entry, whatever `HOME` says (an Inbox
 * started under a scratch or relative HOME still guards the real `~/.ssh`,
 * and other users' homes too): `/Users/<name>/.x`, `/home/<name>/.x`,
 * `/root/.x`, `/var/root/.x`, `<drive>:\Users\<name>\.x`.
 */
const HOME_SHAPED_DOT_FOLDER = /^(?:\/Users\/[^/]+|\/home\/[^/]+|\/root|\/(?:private\/)?var\/root|[A-Za-z]:[\\/]Users[\\/][^\\/]+)[\\/]\.[^\\/]*/i;

/**
 * The hidden folder (or file) directly in a home folder or in `/` that `path`
 * is in, or null: in a home of `homes` (`HOME` and `os.homedir()` by
 * default), in a home-shaped folder (`HOME_SHAPED_DOT_FOLDER`), or in `/`.
 */
export function inboxHomeDotFolder(path: string, homes: readonly string[] = protectedFolders()): string | null {
  for (const folder of [...homes, parse(path).root]) {
    if (path === folder || !isInside(path, folder)) continue;
    const first = relative(folder, path).split(sep)[0]!;
    if (first.startsWith(".")) return join(folder, first);
  }
  return HOME_SHAPED_DOT_FOLDER.exec(path)?.[0] ?? null;
}

/** A folder and its realpath, when it has one. */
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

/**
 * Rules 1 to 3: the path the src names, judged before anything is read: a
 * refusal, or the file to read (its realpath, and the absolute path it was
 * named by). Never throws.
 */
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
  // Relative paths start at the folder the agent sent from while it is on disk, else at the root.
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
      // Not on disk under this spelling: one a person's message names outside its area is
      // refused as such; otherwise the next spelling is tried.
      if (!inArea(named)) return refuse(403, "outside_project", OUTSIDE) as Refusal;
      continue;
    }
    // A person's message: judged by where the path really leads.
    if (!inArea(real)) return refuse(403, "outside_project", OUTSIDE) as Refusal;
    // By where it really leads (a symlink into a hidden folder is refused), and as named: the
    // name in its folder's real location (a link kept in `~/.config`, whatever spells the folder).
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

/** Rule 4's last part: the bytes read are an image (not an LFS pointer), within the pixel cap. */
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

/**
 * Read one image a message shows. `root` is the project's root (a realpath);
 * `base` the folder relative paths start from (the message's `base_path`, or
 * the root). Never throws.
 */
export function readInboxMessageImage(input: InboxMessageImageInput): InboxMessageImageResult {
  const located = locateInboxMessageImage(input);
  if (!located.ok) return located;
  const read = readImageFile(located.real);
  if (!read.ok) return read;
  return finishImage(read.bytes, located, read.mtime);
}

/**
 * The same read, asynchronous: the same rules and the same one-descriptor
 * checks (`O_NOFOLLOW | O_NONBLOCK`, `fstat` a regular file within the cap, at
 * most cap + 1 bytes, the path still leading to the same dev and ino), with
 * the bytes read through a file handle, so a capture of many images never
 * holds the event loop (inline-images.ts). Never throws.
 */
export async function readInboxMessageImageAsync(input: InboxMessageImageInput): Promise<InboxMessageImageResult> {
  const located = locateInboxMessageImage(input);
  if (!located.ok) return located;
  const read = await readImageFileAsync(located.real);
  if (!read.ok) return read;
  return finishImage(read.bytes, located, read.mtime);
}

const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const TOO_LARGE = "That image is larger than 10 MB.";
const CHANGED = "That image changed while it was read.";

const failRead = (status: number, code: string, error: string): Refusal => ({ ok: false as const, status, code, error });

/** How much of a file is read first, to tell its type and size before the rest is read. */
const HEAD_BYTES = 64 * 1024;

/**
 * The first bytes decide before the rest is read: not an image (or an LFS
 * pointer) or over the pixel cap is refused without reading up to 10 MB.
 */
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

/**
 * Read a realpath through one descriptor: never follows a final symlink,
 * never blocks on a FIFO, never buffers more than the cap + 1 bytes, and
 * refuses when the path no longer leads to the file that was read.
 */
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

/** `readImageFile` through an async file handle, read in 1 MiB slices. */
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
