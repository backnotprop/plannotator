/**
 * A walkthrough (approval item 6, "a review with no diff"): the agent names files and lines, and the Inbox reads them
 * from the project when it is sent. They become a patch of context lines only, stored with the review like any other,
 * so the same viewers draw the code as it was then, with nothing marked as changed.
 */
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

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

/** One file's named lines as a diff of context lines. Ranges past the end stop at the end. */
export function walkthroughFilePatch(path: string, text: string, ranges: [number, number][] | null): string | { error: string } {
  const lines = text.split("\n");
  const endsInNewline = lines[lines.length - 1] === "";
  if (endsInNewline) lines.pop();
  if (lines.length === 0) return { error: `${path} is empty.` };
  const out = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`];
  for (const [start, end] of merged(ranges ?? [[1, lines.length]])) {
    if (start > lines.length) return { error: `${path} has ${lines.length} line${lines.length === 1 ? "" : "s"}, so line ${start} isn't there.` };
    const last = Math.min(end, lines.length);
    const count = last - start + 1;
    out.push(`@@ -${start},${count} +${start},${count} @@`);
    for (let at = start; at <= last; at++) out.push(` ${lines[at - 1]}`);
    if (last === lines.length && !endsInNewline) out.push("\\ No newline at end of file");
  }
  return `${out.join("\n")}\n`;
}

const outside = (path: string) => !path || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);

/** A file named relative to `folder`, once it is certain to be a file inside it (a link out of the folder isn't). */
function fileInFolder(folder: string, file: string): { full: string; path: string } | null {
  const full = resolve(folder, file);
  const path = relative(folder, full);
  if (outside(path)) return null;
  try {
    if (!statSync(full).isFile() || outside(relative(realpathSync(folder), realpathSync(full)))) return null;
  } catch {
    return null;
  }
  return { full: join(folder, path), path: path.split(sep).join("/") };
}

/**
 * The guide and patch to check and store, from a guide whose `diffs` name `file` and maybe `lines`. A `patch` the agent
 * sent as well is never looked at, so its own diff (or an empty one) can't get in the way. The strict checks that
 * follow are the ones every guide gets, so a file placed twice is refused by name there. `folders`: where to look, the
 * agent's own first (it may be a worktree or a subfolder), the project's last.
 */
export function readInboxWalkthrough(guide: unknown, folders: readonly string[]): InboxWalkthroughRead {
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
  const named = new Map<string, { path: string; full: string; ranges: [number, number][] | null }>();
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
  for (const { path, full, ranges } of named.values()) {
    const bytes = readFileSync(full);
    if (bytes.includes(0)) {
      problems.push(`${path} isn't text.`);
      continue;
    }
    const part = walkthroughFilePatch(path, bytes.toString("utf8"), ranges);
    if (typeof part === "string") patch += part;
    else problems.push(part.error);
  }
  return problems.length > 0 ? { ok: false, error: problems.join("\n") } : { ok: true, guide: { ...rest, sections }, patch };
}
