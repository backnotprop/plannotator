/**
 * A walkthrough (approval item 6, "a review with no diff"): the agent names files and lines, and the Inbox reads them
 * from the project when it is sent. They become a patch of context lines only, stored with the review like any other,
 * so the same viewers draw the code as it was then, with nothing marked as changed.
 */
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { inboxAttachmentNameRefusal } from "@plannotator/core/inbox-types";
import { inboxOwnSecretRefusal } from "@plannotator/shared/inbox/own-secrets";
import { MAX_REVIEW_FILE_CONTENT_BYTES } from "@plannotator/shared/review-core";

/**
 * The most a walkthrough takes of one file: the lines it names (the whole file when it names none), at most the
 * review's own read cap for a file (5 MB). A big file with a small excerpt is read only as far as its last named line.
 */
export const INBOX_WALKTHROUGH_FILE_MAX_BYTES = MAX_REVIEW_FILE_CONTENT_BYTES;
/** The most the excerpts of one walkthrough may come to: what one agent-door call takes as data (16 MB). */
export const INBOX_WALKTHROUGH_TOTAL_MAX_BYTES = 16 * 1024 * 1024;
/**
 * The most of one file a walkthrough reads through to reach the lines it names (256 MB), for every agent: the read is
 * done inside the request, so naming lines near the end of a file of many gigabytes must not hold the Inbox up.
 */
export const INBOX_WALKTHROUGH_SCAN_MAX_BYTES = 256 * 1024 * 1024;

const MB = 1024 * 1024;
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

export type InboxWalkthroughRead = { ok: true; guide: Record<string, unknown>; patch: string } | { ok: false; error: string };

/** "10-40, 80-95", "12", 12, [10, 40], ["10-40", "80-95"] or [[10, 40], [80, 95]]; null when it is none of these. */
export function walkthroughRangesOf(lines: unknown): [number, number][] | null {
  const whole = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n > 0;
  if (whole(lines)) return [[lines, lines]];
  if (typeof lines === "string") {
    const ranges: [number, number][] = [];
    for (const part of lines.split(",")) {
      const match = /^\s*L?(\d+)\s*(?:(?:-|–|\.\.)\s*L?(\d+))?\s*$/i.exec(part);
      if (!match) return null;
      const start = Number(match[1]);
      const end = match[2] ? Number(match[2]) : start;
      if (start < 1 || end < start) return null;
      ranges.push([start, end]);
    }
    return ranges;
  }
  if (!Array.isArray(lines) || lines.length === 0) return null;
  if (lines.length === 2 && whole(lines[0]) && whole(lines[1])) return lines[1] >= lines[0] ? [[lines[0], lines[1]]] : null;
  const ranges: [number, number][] = [];
  for (const part of lines) {
    const inner = walkthroughRangesOf(part);
    if (!inner) return null;
    ranges.push(...inner);
  }
  return ranges;
}

/** Sorted, with overlapping and touching ranges made one: a hunk apiece. */
const merged = (ranges: [number, number][]): [number, number][] => {
  const out: [number, number][] = [];
  for (const [start, end] of [...ranges].sort((a, b) => a[0] - b[0])) {
    const last = out[out.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
};

/** One file's named lines as a diff of context lines, from its text. Ranges past the end stop at the end. */
export function walkthroughFilePatch(path: string, text: string, ranges: [number, number][] | null): string | { error: string } {
  const bytes = Buffer.from(text, "utf8");
  const part = excerptPatch(path, ranges, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, (into, at) => bytes.copy(into, 0, at, Math.min(bytes.length, at + into.length)));
  return "error" in part ? { error: part.error } : part.patch;
}

const outside = (path: string) => !path || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);

/**
 * A file named relative to `folder`, once it is certain to be a file inside it (a link out of the folder isn't), with
 * the realpath it is read at. A hidden folder inside the project (`.github/`) is read, as before.
 */
function fileInFolder(folder: string, file: string): { full: string; real: string; path: string } | null {
  const full = resolve(folder, file);
  const path = relative(folder, full);
  if (outside(path)) return null;
  let real: string;
  try {
    real = realpathSync(full);
    if (!statSync(real).isFile() || outside(relative(realpathSync(folder), real))) return null;
  } catch {
    return null;
  }
  return { full: join(folder, path), real, path: path.split(sep).join("/") };
}

const CHUNK = 64 * 1024;

/**
 * One named file's patch, read from its realpath opened once without following a link: only as far as its last
 * named line (to the end when it names none), in 64 KB reads, keeping only the named lines, so a big file costs what
 * its excerpt does. `max`: the most the kept lines may come to; `scan`: the most of the file read to reach them. A NUL
 * in what is read means it isn't text.
 */
function readNamedExcerpt(real: string, path: string, ranges: [number, number][] | null, max: number, scan: number): Excerpt {
  let fd: number;
  try {
    fd = openSync(real, OPEN_FLAGS);
  } catch {
    return { error: `${path} could not be read.` };
  }
  try {
    if (!fstatSync(fd).isFile()) return { error: `${path} could not be read.` };
    return excerptPatch(path, ranges, max, scan, (into, at) => readSync(fd, into, 0, into.length, at));
  } finally {
    closeSync(fd);
  }
}

type Excerpt = { patch: string; bytes: number } | { error: string; total?: boolean };

/**
 * The patch of the named lines of what `read` gives (bytes from an offset, 0 at the end), read only as far as needed
 * and never more than `scan` bytes: a named line not reached by then is refused.
 */
function excerptPatch(path: string, ranges: [number, number][] | null, max: number, scan: number, read: (into: Buffer, at: number) => number): Excerpt {
  const want = merged(ranges ?? [[1, Number.MAX_SAFE_INTEGER]]);
  const lastWanted = want[want.length - 1]![1];
  const kept = new Map<number, string>();
  let keptBytes = 0;
  let line = 1;
  let parts: Buffer[] = [];
  let partBytes = 0;
  let range = 0;
  const named = (n: number) => {
    while (range < want.length && want[range]![1] < n) range++;
    return range < want.length && want[range]![0] <= n;
  };
  let inLine = named(1);
  let lineOpen = false;
  const chunk = Buffer.alloc(CHUNK);
  let at = 0;
  let done = false;
  while (!done) {
    // One byte past `scan` is asked for, so a file that ends exactly there is read whole and one that goes on is not.
    const got = read(chunk.subarray(0, Math.min(CHUNK, scan + 1 - at)), at);
    if (got === 0) break;
    const n = Math.min(got, scan - at);
    const over = at + got > scan;
    at += got;
    const bytes = chunk.subarray(0, n);
    if (bytes.includes(0)) return { error: `${path} isn't text.` };
    let from = 0;
    while (from < n) {
      const end = bytes.indexOf(10, from);
      const stop = end < 0 ? n : end;
      lineOpen = true;
      if (inLine) {
        parts.push(Buffer.from(bytes.subarray(from, stop)));
        partBytes += stop - from;
        if (keptBytes + partBytes > max) return { error: tooLarge(path, max), total: max < INBOX_WALKTHROUGH_FILE_MAX_BYTES };
      }
      if (end < 0) break;
      if (inLine) kept.set(line, Buffer.concat(parts).toString("utf8"));
      keptBytes += partBytes + (inLine ? 1 : 0);
      parts = [];
      partBytes = 0;
      lineOpen = false;
      from = end + 1;
      if (line >= lastWanted) {
        done = true;
        break;
      }
      line += 1;
      inLine = named(line);
    }
    if (over && !done) return { error: tooFar(path, scan) };
  }
  // The last line has no line break: it is a line all the same, and the patch says so.
  const noNewline = lineOpen;
  if (noNewline && inLine) {
    kept.set(line, Buffer.concat(parts).toString("utf8"));
    keptBytes += partBytes;
  }
  // How many lines there are, once the read reached the end (it did whenever a named line is past it).
  const total = done ? Number.MAX_SAFE_INTEGER : noNewline ? line : line - 1;
  if (total === 0) return { error: `${path} is empty.` };
  const out = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`];
  for (const [start, end] of want) {
    if (start > total) return { error: `${path} has ${total} line${total === 1 ? "" : "s"}, so line ${start} isn't there.` };
    const last = Math.min(end, total);
    const count = last - start + 1;
    out.push(`@@ -${start},${count} +${start},${count} @@`);
    for (let n = start; n <= last; n++) out.push(` ${kept.get(n) ?? ""}`);
    if (last === total && noNewline) out.push("\\ No newline at end of file");
  }
  return { patch: `${out.join("\n")}\n`, bytes: keptBytes };
}

const tooFar = (path: string, scan: number) =>
  `${path}: the lines named are more than ${scan / MB} MB into the file, the most a walkthrough reads of one file. Name lines nearer the start, or send guide with patch instead.`;

const tooLarge = (path: string, max: number) =>
  max < INBOX_WALKTHROUGH_FILE_MAX_BYTES
    ? `${path}: the lines this walkthrough names come to more than ${INBOX_WALKTHROUGH_TOTAL_MAX_BYTES / MB} MB, the most one takes. Name fewer lines, or send guide with patch instead.`
    : `${path}: the lines named come to more than ${INBOX_WALKTHROUGH_FILE_MAX_BYTES / MB} MB, the most a walkthrough takes of one file. Name fewer lines, or send guide with patch instead.`;

/**
 * The guide and patch to check and store, from a guide whose `diffs` name `file` and maybe `lines`. A `patch` the agent
 * sent as well is never looked at, so its own diff (or an empty one) can't get in the way. The strict checks that
 * follow are the ones every guide gets, so a file placed twice is refused by name there. `folders`: where to look, the
 * agent's own first (it may be a worktree or a subfolder), the project's last. `scan`: the most of one file read
 * (INBOX_WALKTHROUGH_SCAN_MAX_BYTES; a test sets less).
 */
export function readInboxWalkthrough(guide: unknown, folders: readonly string[], scan = INBOX_WALKTHROUGH_SCAN_MAX_BYTES): InboxWalkthroughRead {
  let raw = guide;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return { ok: false, error: "`guide` isn't valid JSON." };
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "`guide` must be an object." };
  const { unplacedFiles: _unplaced, ...rest } = raw as Record<string, unknown>;
  if (!Array.isArray(rest.sections)) return { ok: false, error: "`guide.sections` must be a list of chapters." };
  const problems: string[] = [];
  const named = new Map<string, { path: string; full: string; real: string; ranges: [number, number][] | null }>();
  const sections = rest.sections.map((section: unknown) => {
    if (!section || typeof section !== "object" || !Array.isArray((section as { diffs?: unknown }).diffs)) return section;
    const diffs = (section as { diffs: unknown[] }).diffs.map((ref: unknown) => {
      if (!ref || typeof ref !== "object" || typeof (ref as { file?: unknown }).file !== "string") return ref;
      const { lines, ...kept } = ref as { file: string; lines?: unknown };
      const found = folders.map((folder) => fileInFolder(folder, kept.file)).find(Boolean);
      if (!found) {
        problems.push(`${kept.file} isn't a file in the project.`);
        return kept;
      }
      // A secret's name, as named and where it leads (the rule attachments use): never read, for any agent.
      const secret = inboxAttachmentNameRefusal(found.full) ?? inboxAttachmentNameRefusal(found.real);
      if (secret) {
        problems.push(`${kept.file}: .env files are never read into a walkthrough (they hold secrets).`);
        return kept;
      }
      // The Inbox's own keys (own-secrets.ts), when the project is its data folder.
      const ownKey = inboxOwnSecretRefusal(found.full) ?? inboxOwnSecretRefusal(found.real);
      if (ownKey) {
        problems.push(`${kept.file}: ${ownKey}`);
        return kept;
      }
      const ranges = lines === undefined || lines === null ? null : walkthroughRangesOf(lines);
      if (lines !== undefined && lines !== null && !ranges) problems.push(`${kept.file}: \`lines\` should look like "10-40" or "10-40, 80-95".`);
      const before = named.get(found.path);
      named.set(found.path, { ...found, ranges: before ? (before.ranges && ranges ? [...before.ranges, ...ranges] : null) : ranges });
      return { ...kept, file: found.path };
    });
    return { ...(section as object), diffs };
  });
  if (problems.length > 0) return { ok: false, error: problems.join("\n") };
  if (named.size === 0) return { ok: false, error: "Name at least one file: a chapter's `diffs` take `file` and `lines`." };
  let patch = "";
  // At most INBOX_WALKTHROUGH_FILE_MAX_BYTES of a file's named lines and INBOX_WALKTHROUGH_TOTAL_MAX_BYTES in all,
  // counted as they are read: an excerpt that would pass a cap is refused, never read whole.
  let left = INBOX_WALKTHROUGH_TOTAL_MAX_BYTES;
  for (const { path, real, ranges } of named.values()) {
    const part = readNamedExcerpt(real, path, ranges, Math.min(INBOX_WALKTHROUGH_FILE_MAX_BYTES, left), scan);
    if ("error" in part) {
      problems.push(part.error);
      if (part.total) break;
      continue;
    }
    left -= part.bytes;
    patch += part.patch;
  }
  return problems.length > 0 ? { ok: false, error: problems.join("\n") } : { ok: true, guide: { ...rest, sections }, patch };
}
