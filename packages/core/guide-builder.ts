import { parseDiffToFiles, type DiffFileStatus } from "./diff-files";
import type { CodeGuideOutput, GuideOverview, GuideOverviewDiagram, GuideSection } from "./guide";
import {
  buildGuideSnapshot,
  parseGuideSnapshot,
  type GuideLaunchReview,
  type GuideSnapshot,
  type GuideSnapshotGenerator,
} from "./guide-format";
import { findGuideLinks, parseGuideLink, type GuideLink, type GuideLinkSource } from "./guide-links";
import { validateGuideOutput } from "./guide-prompt";
import { GUIDE_BUILDER_TOOL_NAMES, type GuideBuilderToolName } from "./guide-builder-tools";

/** At most this many chapters (the methodology says 2-6, never more than 10). */
export const GUIDE_BUILDER_MAX_CHAPTERS = 10;
/** Cap on an overview diagram's source, Mermaid or HTML, in UTF-8 bytes. */
export const GUIDE_OVERVIEW_DIAGRAM_MAX_BYTES = 64 * 1024;
/** Hygiene caps on the agent's text. */
export const GUIDE_BUILDER_TEXT_LIMITS = {
  title: 200,
  intent: 1_000,
  overview: 8_000,
  chapterTitle: 200,
  chapterOverview: 8_000,
  summary: 1_000,
  reason: 500,
} as const;

export const GUIDE_DRAFT_KIND = "plannotator-guide-draft" as const;
export const GUIDE_DRAFT_VERSION = 1 as const;

/** A line range on the head side (`start`..`end`, inclusive) or a hunk of the file's diff (1-based). */
export type GuideFocusRange = { readonly start: number; readonly end: number } | { readonly hunk: number };

export interface GuideDraftFile {
  readonly file: string;
  readonly summary: string;
  readonly focus?: readonly GuideFocusRange[];
}

export interface GuideDraftChapter {
  /** Stable id (`c1`, `c2`, …), never reused, so reordering never breaks a reference. */
  readonly id: string;
  readonly title: string;
  readonly overview: string;
  readonly files: readonly GuideDraftFile[];
  readonly diagram?: GuideOverviewDiagram;
}

/** A changed file the agent left out of every chapter on purpose. */
export interface GuideDraftUnplaced {
  readonly file: string;
  readonly reason?: string;
}

export interface GuideDraft {
  readonly kind: typeof GUIDE_DRAFT_KIND;
  readonly version: typeof GUIDE_DRAFT_VERSION;
  readonly review: GuideLaunchReview;
  readonly generator?: GuideSnapshotGenerator;
  readonly title: string;
  readonly intent: string;
  readonly overview?: GuideOverview;
  readonly chapters: readonly GuideDraftChapter[];
  readonly unplaced: readonly GuideDraftUnplaced[];
  readonly nextChapter: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateGuideDraftInput {
  readonly review: GuideLaunchReview;
  readonly generator?: GuideSnapshotGenerator;
  readonly now?: string;
}

/** A new, empty draft for a change. */
export function createGuideDraft(input: CreateGuideDraftInput): GuideDraft {
  const now = input.now ?? new Date().toISOString();
  return {
    kind: GUIDE_DRAFT_KIND,
    version: GUIDE_DRAFT_VERSION,
    review: input.review,
    ...(input.generator && { generator: input.generator }),
    title: "",
    intent: "",
    chapters: [],
    unplaced: [],
    nextChapter: 1,
    createdAt: now,
    updatedAt: now,
  };
}

/** JSON for persisting the draft (it carries the patch). */
export function serializeGuideDraft(draft: GuideDraft): string {
  return JSON.stringify(draft);
}

export type GuideDraftParseResult = { readonly ok: true; readonly draft: GuideDraft } | { readonly ok: false; readonly error: string };

/** Read a persisted draft back (from JSON text or an already-parsed value). Never throws. */
export function parseGuideDraft(input: unknown): GuideDraftParseResult {
  let value = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input);
    } catch {
      return { ok: false, error: "The draft is not valid JSON." };
    }
  }
  const bad = (error: string): GuideDraftParseResult => ({ ok: false, error });
  if (!isRecord(value)) return bad("The draft is not an object.");
  if (value.kind !== GUIDE_DRAFT_KIND) return bad(`Not a guide draft (kind must be ${GUIDE_DRAFT_KIND}).`);
  if (value.version !== GUIDE_DRAFT_VERSION) return bad(`Unsupported draft version: ${String(value.version)}.`);
  const review = value.review;
  if (!isRecord(review) || typeof review.rawPatch !== "string" || typeof review.gitRef !== "string" || !isRecord(review.source)) {
    return bad("The draft's review is missing its patch, ref or source.");
  }
  if (typeof value.title !== "string" || typeof value.intent !== "string") return bad("The draft's title and intent must be text.");
  if (value.overview !== undefined) {
    const o = value.overview;
    if (!isRecord(o) || typeof o.text !== "string") return bad("The draft's overview is malformed.");
    if (o.diagram !== undefined && !isDraftDiagram(o.diagram)) return bad("The draft's overview diagram is malformed.");
  }
  if (!Array.isArray(value.chapters)) return bad("The draft's chapters must be a list.");
  for (const c of value.chapters) {
    if (!isRecord(c) || typeof c.id !== "string" || typeof c.title !== "string" || typeof c.overview !== "string" || !Array.isArray(c.files)) {
      return bad("A chapter in the draft is malformed.");
    }
    if (c.diagram !== undefined && !isDraftDiagram(c.diagram)) return bad(`The diagram of chapter ${c.id} is malformed.`);
    for (const f of c.files) {
      if (!isRecord(f) || typeof f.file !== "string" || typeof f.summary !== "string") return bad(`A file in chapter ${c.id} is malformed.`);
      if (f.focus !== undefined && !Array.isArray(f.focus)) return bad(`The focus of ${f.file} is malformed.`);
    }
  }
  if (!Array.isArray(value.unplaced) || value.unplaced.some((u) => !isRecord(u) || typeof u.file !== "string")) {
    return bad("The draft's unplaced list is malformed.");
  }
  if (typeof value.nextChapter !== "number" || !Number.isInteger(value.nextChapter) || value.nextChapter < 1) return bad("The draft's chapter counter is malformed.");
  if (typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") return bad("The draft's timestamps are missing.");
  return { ok: true, draft: value as unknown as GuideDraft };
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDraftDiagram(value: unknown): boolean {
  return isRecord(value) && (value.kind === "mermaid" || value.kind === "html") && typeof value.source === "string";
}

function diagramLinkSource(diagram: GuideOverviewDiagram): GuideLinkSource {
  return diagram.kind === "mermaid" ? "mermaid" : "html";
}

interface ChangeHunk {
  readonly newStart: number;
  readonly newCount: number;
}

interface ChangeFile {
  readonly path: string;
  readonly status: DiffFileStatus;
  readonly additions: number;
  readonly deletions: number;
  readonly hunks: readonly ChangeHunk[];
  readonly patch: string;
}

interface ChangeIndex {
  readonly files: readonly ChangeFile[];
  readonly byPath: ReadonlyMap<string, ChangeFile>;
}

let changeCache: { patch: string; index: ChangeIndex } | null = null;

function changeOf(draft: GuideDraft): ChangeIndex {
  const patch = draft.review.rawPatch;
  if (changeCache && changeCache.patch === patch) return changeCache.index;
  const files: ChangeFile[] = [];
  const byPath = new Map<string, ChangeFile>();
  for (const f of parseDiffToFiles(patch)) {
    if (byPath.has(f.path)) continue;
    const hunks: ChangeHunk[] = [];
    for (const line of f.patch.split("\n")) {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m) hunks.push({ newStart: Number(m[1]), newCount: Number(m[2] ?? "1") });
    }
    const file: ChangeFile = { path: f.path, status: f.status, additions: f.additions, deletions: f.deletions, hunks, patch: f.patch };
    files.push(file);
    byPath.set(f.path, file);
  }
  const index = { files, byPath };
  changeCache = { patch, index };
  return index;
}

/** The changed files of the draft's patch, in patch order. */
export function guideDraftChangedFiles(draft: GuideDraft): string[] {
  return changeOf(draft).files.map((f) => f.path);
}

function levenshtein(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** The changed file a mistyped path most likely meant, if one is close. */
export function suggestChangedPath(path: string, changed: readonly string[]): string | undefined {
  const lower = path.toLowerCase();
  const exactCase = changed.find((p) => p.toLowerCase() === lower);
  if (exactCase) return exactCase;
  const trimmed = path.replace(/^\.?\//, "");
  if (trimmed !== path && changed.includes(trimmed)) return trimmed;
  const max = Math.max(3, Math.floor(path.length * 0.25));
  let best: string | undefined;
  let bestDistance = max + 1;
  for (const candidate of changed) {
    const d = levenshtein(path, candidate, max);
    if (d < bestDistance) {
      best = candidate;
      bestDistance = d;
    }
  }
  if (best) return best;
  const base = path.slice(path.lastIndexOf("/") + 1);
  const sameName = changed.filter((p) => p.slice(p.lastIndexOf("/") + 1) === base);
  return sameName.length === 1 ? sameName[0] : undefined;
}

function notInChange(path: string, draft: GuideDraft): string {
  const suggestion = suggestChangedPath(path, guideDraftChangedFiles(draft));
  return suggestion
    ? `\`${path}\` is not in this change. Did you mean \`${suggestion}\`?`
    : `\`${path}\` is not in this change. Call guide_read to see the changed files.`;
}

export interface GuideDraftProgress {
  readonly chapters: number;
  readonly placed: number;
  readonly total: number;
  readonly leftOut: number;
  readonly remaining: readonly string[];
  readonly ready: boolean;
  readonly line: string;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function guideDraftProgress(draft: GuideDraft): GuideDraftProgress {
  const changed = guideDraftChangedFiles(draft);
  const placedSet = new Set(draft.chapters.flatMap((c) => c.files.map((f) => f.file)));
  const leftOutSet = new Set(draft.unplaced.map((u) => u.file));
  const remaining = changed.filter((p) => !placedSet.has(p) && !leftOutSet.has(p));
  const ready =
    draft.title.trim() !== "" &&
    draft.intent.trim() !== "" &&
    draft.chapters.length > 0 &&
    remaining.length === 0 &&
    draft.chapters.every((c) => c.files.length > 0);
  const parts = [`${plural(draft.chapters.length, "chapter")}`, `${placedSet.size} of ${plural(changed.length, "file")} placed`];
  if (leftOutSet.size > 0) parts.push(`${leftOutSet.size} not in a chapter`);
  if (remaining.length > 0 && placedSet.size + leftOutSet.size > 0) parts.push(`${remaining.length} left`);
  if (ready) parts.push("ready to finish");
  return {
    chapters: draft.chapters.length,
    placed: placedSet.size,
    total: changed.length,
    leftOut: leftOutSet.size,
    remaining,
    ready,
    line: parts.join(" · "),
  };
}

export type GuideSymbolResolution =
  | { readonly status: "found" }
  | { readonly status: "ambiguous"; readonly candidates: readonly string[] }
  | { readonly status: "missing"; readonly suggestions?: readonly string[] };

export type GuideFileResolution = { readonly exists: true; readonly lineCount?: number } | { readonly exists: false };

export type GuideMermaidCheck = { readonly ok: true } | { readonly ok: false; readonly error: string };

export interface GuideHtmlSanitizeResult {
  readonly html: string;
  readonly removed: readonly string[];
}

type MaybePromise<T> = T | Promise<T>;

/** What only the host can check. */
export interface GuideBuilderHooks {
  resolveSymbol?(query: { readonly name: string; readonly path?: string }): MaybePromise<GuideSymbolResolution>;
  resolveFile?(query: { readonly path: string }): MaybePromise<GuideFileResolution>;
  checkMermaid?(source: string): MaybePromise<GuideMermaidCheck>;
  sanitizeHtml?(source: string): MaybePromise<GuideHtmlSanitizeResult>;
  now?(): string;
}

export interface GuideBuilderAnswer {
  readonly ok: boolean;
  readonly text: string;
  readonly draft: GuideDraft;
  readonly changed: boolean;
  readonly progress: GuideDraftProgress;
  readonly chapterId?: string;
  readonly snapshot?: GuideSnapshot;
}

function answer(draft: GuideDraft, ok: boolean, lines: Array<string | false | undefined | null>, extra?: Partial<GuideBuilderAnswer>): GuideBuilderAnswer {
  const progress = guideDraftProgress(draft);
  const body = lines.filter((l): l is string => typeof l === "string" && l.length > 0);
  return { ok, draft, changed: false, progress, text: [...body, progress.line].join("\n"), ...extra };
}

function refuse(draft: GuideDraft, ...lines: Array<string | false | undefined | null>): GuideBuilderAnswer {
  return answer(draft, false, lines);
}

function commit(next: GuideDraft, hooks: GuideBuilderHooks | undefined, lines: Array<string | false | undefined | null>, extra?: Partial<GuideBuilderAnswer>): GuideBuilderAnswer {
  const draft: GuideDraft = { ...next, updatedAt: hooks?.now?.() ?? new Date().toISOString() };
  return { ...answer(draft, true, lines, extra), changed: true };
}

function cleanText(value: string, name: string, max: number, opts?: { oneLine?: boolean }): { ok: true; value: string } | { ok: false; error: string } {
  const text = value.trim();
  if (text.length === 0) return { ok: false, error: `The ${name} is empty.` };
  if (opts?.oneLine && /[\r\n]/.test(text)) return { ok: false, error: `The ${name} is one line.` };
  if (text.length > max) return { ok: false, error: `The ${name} is ${text.length} characters; keep it under ${max}.` };
  return { ok: true, value: text };
}

function utf8Bytes(text: string): number {
  let bytes = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

interface LinkCheck {
  /** Links that do not resolve: the call is refused. */
  readonly problems: string[];
  readonly notes: string[];
  readonly checked: number;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function symbolInChange(change: ChangeIndex, name: string, path?: string): boolean {
  const last = name.split(/\.|::|#/).filter(Boolean).pop() ?? name;
  const word = new RegExp(`(^|[^A-Za-z0-9_$])${escapeRegExp(last)}($|[^A-Za-z0-9_$])`);
  const files = path ? [change.byPath.get(path)].filter(Boolean) : change.files;
  for (const file of files) {
    for (const line of file!.patch.split("\n")) {
      if ((line.startsWith("+") && !line.startsWith("+++")) || line.startsWith(" ")) {
        if (word.test(line.slice(1))) return true;
      }
    }
  }
  return false;
}

async function checkCodePath(
  path: string,
  startLine: number | undefined,
  endLine: number | undefined,
  href: string,
  draft: GuideDraft,
  hooks: GuideBuilderHooks | undefined,
  out: { problems: string[]; notes: string[] },
): Promise<void> {
  const change = changeOf(draft);
  const file = change.byPath.get(path);
  if (file) {
    if (startLine === undefined) return;
    if (file.status === "deleted") {
      out.problems.push(`\`${href}\`: \`${path}\` is deleted in this change, so it has no lines at the head. Link the file without a line.`);
      return;
    }
    const last = endLine ?? startLine;
    if (file.status === "added") {
      const lines = file.hunks.reduce((n, h) => Math.max(n, h.newStart + h.newCount - 1), 0);
      if (last > lines) out.problems.push(`\`${href}\`: \`${path}\` has ${plural(lines, "line")} at the head.`);
      return;
    }
    if (hooks?.resolveFile) {
      const found = await hooks.resolveFile({ path });
      if (found.exists && found.lineCount !== undefined && last > found.lineCount) {
        out.problems.push(`\`${href}\`: \`${path}\` has ${plural(found.lineCount, "line")} at the head.`);
      }
    }
    return;
  }
  const suggestion = suggestChangedPath(path, guideDraftChangedFiles(draft));
  if (hooks?.resolveFile) {
    const found = await hooks.resolveFile({ path });
    if (!found.exists) {
      out.problems.push(`\`${href}\`: \`${path}\` does not exist at the head.${suggestion ? ` Did you mean \`${suggestion}\`?` : ""}`);
    } else if (startLine !== undefined && found.lineCount !== undefined && (endLine ?? startLine) > found.lineCount) {
      out.problems.push(`\`${href}\`: \`${path}\` has ${plural(found.lineCount, "line")}.`);
    }
    return;
  }
  if (suggestion && suggestion !== path) {
    out.problems.push(`\`${href}\`: \`${path}\` is not in this change. Did you mean \`${suggestion}\`?`);
    return;
  }
  out.notes.push(`\`${href}\` is outside this change and was not checked.`);
}

async function checkLinks(
  sources: ReadonlyArray<{ text: string; source: GuideLinkSource }>,
  draft: GuideDraft,
  hooks: GuideBuilderHooks | undefined,
  chapterCount: number,
): Promise<LinkCheck> {
  const out = { problems: [] as string[], notes: [] as string[] };
  const seen = new Set<string>();
  let checked = 0;
  const change = changeOf(draft);
  for (const { text, source } of sources) {
    for (const occurrence of findGuideLinks(text, source)) {
      if (seen.has(occurrence.href)) continue;
      seen.add(occurrence.href);
      checked += 1;
      const parsed = parseGuideLink(occurrence.href);
      if (!parsed) continue;
      if ("error" in parsed) {
        out.problems.push(parsed.error);
        continue;
      }
      const link: GuideLink = parsed.link;
      if (link.kind === "chapter") {
        if (link.chapter > chapterCount) {
          out.notes.push(`\`${link.href}\`: there ${chapterCount === 1 ? "is" : "are"} ${plural(chapterCount, "chapter")} so far; guide_finish checks it again.`);
        }
      } else if (link.kind === "code") {
        await checkCodePath(link.path, link.startLine, link.endLine, link.href, draft, hooks, out);
      } else {
        if (link.path !== undefined) {
          const before = out.problems.length;
          await checkCodePath(link.path, undefined, undefined, link.href, draft, hooks, out);
          if (out.problems.length > before) continue;
        }
        if (hooks?.resolveSymbol) {
          const found = await hooks.resolveSymbol({ name: link.name, ...(link.path !== undefined && { path: link.path }) });
          if (found.status === "ambiguous") {
            out.problems.push(
              `\`${link.href}\`: more than one \`${link.name}\`. Name the file: ${found.candidates.slice(0, 8).map((c) => `\`${c}\``).join(", ")}.`,
            );
          } else if (found.status === "missing") {
            const hint = found.suggestions?.length ? ` Did you mean ${found.suggestions.slice(0, 5).map((s) => `\`${s}\``).join(", ")}?` : "";
            out.problems.push(`\`${link.href}\`: no symbol \`${link.name}\` was found.${hint}`);
          }
        } else if (!symbolInChange(change, link.name, link.path)) {
          out.notes.push(`\`${link.href}\` is not in the changed lines and was not checked.`);
        }
      }
    }
  }
  return { ...out, checked };
}

function chapterLinkProblems(text: string, source: GuideLinkSource, chapterCount: number, where: string): string[] {
  const problems: string[] = [];
  for (const occurrence of findGuideLinks(text, source)) {
    const parsed = parseGuideLink(occurrence.href);
    if (parsed?.ok && parsed.link.kind === "chapter" && parsed.link.chapter > chapterCount) {
      problems.push(`${where} links to \`${parsed.link.href}\`, but the guide has ${plural(chapterCount, "chapter")}.`);
    }
  }
  return problems;
}

function danglingChapter(href: string, count: number): boolean {
  const parsed = parseGuideLink(href);
  return !!parsed?.ok && parsed.link.kind === "chapter" && parsed.link.chapter > count;
}

function dropDanglingChapterLinks(text: string, source: GuideLinkSource, count: number): string {
  if (source === "markdown") {
    return text.replace(/\[([^\]\n]*)\]\(\s*(chapter:[^)\s]*)\s*\)/gi, (whole, label: string, href: string) => (danglingChapter(href, count) ? label : whole));
  }
  if (source === "mermaid") {
    return text
      .split("\n")
      .filter((line) => {
        const m = /^\s*click\s+\S+\s+(?:href\s+)?(?:"([^"]*)"|'([^']*)')/i.exec(line);
        return !(m && danglingChapter(m[1] ?? m[2] ?? "", count));
      })
      .join("\n");
  }
  return text.replace(
    /\s(?:href|xlink:href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/gi,
    (whole, a?: string, b?: string, c?: string) => (danglingChapter(a ?? b ?? c ?? "", count) ? "" : whole),
  );
}

const MERMAID_DIAGRAM_TYPES = [
  "flowchart", "graph", "sequenceDiagram", "classDiagram", "classDiagram-v2", "stateDiagram", "stateDiagram-v2",
  "erDiagram", "journey", "gantt", "pie", "quadrantChart", "requirementDiagram", "gitGraph", "C4Context",
  "C4Container", "C4Component", "C4Dynamic", "C4Deployment", "mindmap", "timeline", "zenuml", "sankey", "sankey-beta",
  "xychart", "xychart-beta", "block", "block-beta", "packet", "packet-beta", "kanban", "architecture", "architecture-beta",
  "radar", "radar-beta", "treemap", "treemap-beta",
];

export function checkMermaidStructure(source: string): string | null {
  const lines = source.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  if (lines[i]?.trim() === "---") {
    i++;
    while (i < lines.length && lines[i].trim() !== "---") i++;
    i++;
  }
  while (i < lines.length && (lines[i].trim() === "" || lines[i].trim().startsWith("%%"))) i++;
  const first = lines[i]?.trim();
  if (!first) return "The Mermaid diagram is empty.";
  const type = first.split(/[\s;:]/)[0];
  if (!MERMAID_DIAGRAM_TYPES.includes(type)) {
    return `A Mermaid diagram starts with its type, such as \`flowchart TD\`, \`sequenceDiagram\`, \`stateDiagram-v2\` or \`erDiagram\`; this one starts with \`${first.slice(0, 40)}\`.`;
  }
  return null;
}

function chapterList(draft: GuideDraft): string {
  if (draft.chapters.length === 0) return "There are no chapters yet; add one with guide_add_chapter.";
  return `Chapters: ${draft.chapters.map((c) => `${c.id} "${c.title}"`).join(", ")}.`;
}

function findChapter(draft: GuideDraft, ref: string): { ok: true; index: number } | { ok: false; error: string } {
  const id = ref.trim();
  const index = draft.chapters.findIndex((c) => c.id === id);
  if (index >= 0) return { ok: true, index };
  if (/^\d+$/.test(id)) {
    const position = Number(id);
    const at = draft.chapters[position - 1];
    return {
      ok: false,
      error: at
        ? `Use the chapter's id, not its position: chapter ${position} in reading order is ${at.id}.`
        : `Use the chapter's id (c1, c2, …). ${chapterList(draft)}`,
    };
  }
  return { ok: false, error: `\`${id}\` is not a chapter. ${chapterList(draft)}` };
}

function chapterOfFile(draft: GuideDraft, file: string): { index: number; fileIndex: number } | null {
  for (let index = 0; index < draft.chapters.length; index++) {
    const fileIndex = draft.chapters[index].files.findIndex((f) => f.file === file);
    if (fileIndex >= 0) return { index, fileIndex };
  }
  return null;
}

function describeChapter(draft: GuideDraft, index: number): string {
  return `chapter ${index + 1} (${draft.chapters[index].id})`;
}

export interface GuideSetHeaderArgs {
  readonly title?: string;
  readonly intent?: string;
}

/** guide_set_header: the guide's title (one line) and intent (1-2 sentences). Either may be set alone. */
export async function guideSetHeader(draft: GuideDraft, args: GuideSetHeaderArgs, hooks?: GuideBuilderHooks): Promise<GuideBuilderAnswer> {
  if (args.title === undefined && args.intent === undefined) return refuse(draft, "Give a `title`, an `intent`, or both.");
  let title = draft.title;
  let intent = draft.intent;
  const problems: string[] = [];
  if (args.title !== undefined) {
    const t = cleanText(args.title, "title", GUIDE_BUILDER_TEXT_LIMITS.title, { oneLine: true });
    if ("error" in t) problems.push(t.error);
    else title = t.value;
  }
  if (args.intent !== undefined) {
    const t = cleanText(args.intent, "intent", GUIDE_BUILDER_TEXT_LIMITS.intent);
    if ("error" in t) problems.push(t.error);
    else intent = t.value;
  }
  if (problems.length > 0) return refuse(draft, ...problems);
  const missing = [title ? null : "a title", intent ? null : "an intent"].filter(Boolean);
  return commit({ ...draft, title, intent }, hooks, [
    `Set the ${[args.title !== undefined && "title", args.intent !== undefined && "intent"].filter(Boolean).join(" and ")}.`,
    missing.length > 0 && `The guide still needs ${missing.join(" and ")}.`,
  ]);
}

export interface GuideSetOverviewArgs {
  readonly text: string;
  readonly diagram?: { readonly kind: "mermaid" | "html"; readonly source: string } | null;
}

/** guide_set_overview: a few sentences on how the change fits together, and optionally one diagram. */
export async function guideSetOverview(draft: GuideDraft, args: GuideSetOverviewArgs, hooks?: GuideBuilderHooks): Promise<GuideBuilderAnswer> {
  const t = cleanText(args.text ?? "", "overview text", GUIDE_BUILDER_TEXT_LIMITS.overview);
  if ("error" in t) return refuse(draft, t.error);
  let diagram: GuideOverviewDiagram | undefined;
  const removedNotes: string[] = [];
  if (args.diagram) {
    const checked = await checkDiagram(args.diagram, hooks);
    if ("error" in checked) return refuse(draft, checked.error);
    diagram = checked.diagram;
    removedNotes.push(...checked.notes);
  }
  const sources: Array<{ text: string; source: GuideLinkSource }> = [{ text: t.value, source: "markdown" }];
  if (diagram) sources.push({ text: diagram.source, source: diagramLinkSource(diagram) });
  const links = await checkLinks(sources, draft, hooks, draft.chapters.length);
  if (links.problems.length > 0) return refuse(draft, "These links do not resolve:", ...links.problems.map((p) => `- ${p}`));
  const overview: GuideOverview = diagram ? { text: t.value, diagram } : { text: t.value };
  return commit({ ...draft, overview }, hooks, [
    `${draft.overview ? "Replaced" : "Set"} the overview${diagram ? ` with a ${kindLabel(diagram)} diagram` : ""}.`,
    links.checked > 0 && `${plural(links.checked, "link")} checked.`,
    ...removedNotes,
    ...links.notes,
  ]);
}

type GuideDiagramArg = { readonly kind: "mermaid" | "html"; readonly source: string };

function kindLabel(diagram: GuideOverviewDiagram): string {
  return diagram.kind === "mermaid" ? "Mermaid" : "HTML";
}

function aDiagram(diagram: GuideOverviewDiagram): string {
  return diagram.kind === "mermaid" ? "a Mermaid diagram" : "an HTML diagram";
}

async function checkDiagram(
  arg: GuideDiagramArg,
  hooks: GuideBuilderHooks | undefined,
): Promise<{ ok: true; diagram: GuideOverviewDiagram; notes: string[] } | { ok: false; error: string }> {
  const refused = (error: string) => ({ ok: false as const, error });
  const kind = arg.kind;
  const source = (arg.source ?? "").trim();
  if (kind !== "mermaid" && kind !== "html") return refused("The diagram's `kind` is `mermaid` or `html`.");
  if (source.length === 0) return refused("The diagram's `source` is empty.");
  const bytes = utf8Bytes(source);
  if (bytes > GUIDE_OVERVIEW_DIAGRAM_MAX_BYTES) {
    return refused(`The diagram is ${Math.ceil(bytes / 1024)} KB; keep it under ${GUIDE_OVERVIEW_DIAGRAM_MAX_BYTES / 1024} KB.`);
  }
  if (kind === "mermaid") {
    const structure = checkMermaidStructure(source);
    if (structure) return refused(structure);
    if (hooks?.checkMermaid) {
      const rendered = await hooks.checkMermaid(source);
      if ("error" in rendered) return refused(`The Mermaid diagram does not render: ${rendered.error}`);
    }
    return { ok: true, diagram: { kind, source }, notes: [] };
  }
  if (!hooks?.sanitizeHtml) {
    return refused("HTML diagrams cannot be checked here, so they are not accepted. Use a Mermaid diagram.");
  }
  const sanitized = await hooks.sanitizeHtml(source);
  const html = sanitized.html.trim();
  if (html.length === 0) return refused("Nothing was left of the HTML diagram after sanitizing it.");
  const storedBytes = utf8Bytes(html);
  if (storedBytes > GUIDE_OVERVIEW_DIAGRAM_MAX_BYTES) {
    return refused(`The sanitized HTML is ${Math.ceil(storedBytes / 1024)} KB; keep it under ${GUIDE_OVERVIEW_DIAGRAM_MAX_BYTES / 1024} KB.`);
  }
  const notes = sanitized.removed.length > 0 ? [`Removed from the HTML: ${sanitized.removed.join(", ")}.`] : [];
  return { ok: true, diagram: { kind, source: html }, notes };
}

/** guide_clear_overview is not a tool; the host may drop the overview with this. */
export function guideClearOverview(draft: GuideDraft, hooks?: GuideBuilderHooks): GuideBuilderAnswer {
  if (!draft.overview) return answer(draft, true, ["There is no overview."]);
  const { overview: _drop, ...rest } = draft;
  return commit(rest, hooks, ["Removed the overview."]);
}

export interface GuideAddChapterArgs {
  readonly title: string;
  readonly overview: string;
  readonly position?: number;
  readonly diagram?: GuideDiagramArg | null;
}

function chapterSources(overview: string, diagram: GuideOverviewDiagram | undefined): Array<{ text: string; source: GuideLinkSource }> {
  const sources: Array<{ text: string; source: GuideLinkSource }> = [{ text: overview, source: "markdown" }];
  if (diagram) sources.push({ text: diagram.source, source: diagramLinkSource(diagram) });
  return sources;
}

/** guide_add_chapter: a new chapter; answers its id (`c3`). */
export async function guideAddChapter(draft: GuideDraft, args: GuideAddChapterArgs, hooks?: GuideBuilderHooks): Promise<GuideBuilderAnswer> {
  if (draft.chapters.length >= GUIDE_BUILDER_MAX_CHAPTERS) {
    return refuse(draft, `The guide already has ${GUIDE_BUILDER_MAX_CHAPTERS} chapters, the most it may have. Merge chapters instead.`);
  }
  const title = cleanText(args.title ?? "", "chapter title", GUIDE_BUILDER_TEXT_LIMITS.chapterTitle, { oneLine: true });
  const overview = cleanText(args.overview ?? "", "chapter overview", GUIDE_BUILDER_TEXT_LIMITS.chapterOverview);
  const problems = ["error" in title ? title.error : null, "error" in overview ? overview.error : null].filter((p): p is string => !!p);
  const position = args.position ?? draft.chapters.length + 1;
  if (!Number.isInteger(position) || position < 1 || position > draft.chapters.length + 1) {
    problems.push(`The position is from 1 to ${draft.chapters.length + 1}.`);
  }
  if (problems.length > 0 || "error" in title || "error" in overview) return refuse(draft, ...problems);
  let diagram: GuideOverviewDiagram | undefined;
  const removedNotes: string[] = [];
  if (args.diagram) {
    const checked = await checkDiagram(args.diagram, hooks);
    if ("error" in checked) return refuse(draft, checked.error);
    diagram = checked.diagram;
    removedNotes.push(...checked.notes);
  }
  const links = await checkLinks(chapterSources(overview.value, diagram), draft, hooks, draft.chapters.length + 1);
  if (links.problems.length > 0) return refuse(draft, "These links do not resolve:", ...links.problems.map((p) => `- ${p}`));
  const id = `c${draft.nextChapter}`;
  const chapters = [...draft.chapters];
  const chapter: GuideDraftChapter = { id, title: title.value, overview: overview.value, files: [], ...(diagram && { diagram }) };
  chapters.splice(position - 1, 0, chapter);
  return commit(
    { ...draft, chapters, nextChapter: draft.nextChapter + 1 },
    hooks,
    [`Added chapter ${id} "${title.value}" at position ${position}${diagram ? ` with ${aDiagram(diagram)}` : ""}.`, ...removedNotes, ...links.notes],
    { chapterId: id },
  );
}

export interface GuideUpdateChapterArgs {
  readonly chapter: string;
  readonly title?: string;
  readonly overview?: string;
  readonly diagram?: GuideDiagramArg | null;
}

/** guide_update_chapter: change a chapter's title, overview and/or diagram. */
export async function guideUpdateChapter(draft: GuideDraft, args: GuideUpdateChapterArgs, hooks?: GuideBuilderHooks): Promise<GuideBuilderAnswer> {
  const found = findChapter(draft, args.chapter ?? "");
  if ("error" in found) return refuse(draft, found.error);
  if (args.title === undefined && args.overview === undefined && args.diagram === undefined) {
    return refuse(draft, "Give a new `title`, `overview` or `diagram`.");
  }
  const current = draft.chapters[found.index];
  if (args.title === undefined && args.overview === undefined && args.diagram === null && !current.diagram) {
    return answer(draft, true, [`There is no diagram in ${describeChapter(draft, found.index)}.`]);
  }
  let title = current.title;
  let overview = current.overview;
  const problems: string[] = [];
  if (args.title !== undefined) {
    const t = cleanText(args.title, "chapter title", GUIDE_BUILDER_TEXT_LIMITS.chapterTitle, { oneLine: true });
    if ("error" in t) problems.push(t.error);
    else title = t.value;
  }
  if (args.overview !== undefined) {
    const t = cleanText(args.overview, "chapter overview", GUIDE_BUILDER_TEXT_LIMITS.chapterOverview);
    if ("error" in t) problems.push(t.error);
    else overview = t.value;
  }
  if (problems.length > 0) return refuse(draft, ...problems);
  let diagram = current.diagram;
  let diagramLine: string | undefined;
  const removedNotes: string[] = [];
  if (args.diagram === null) {
    diagram = undefined;
    if (current.diagram) diagramLine = "Removed its diagram.";
  } else if (args.diagram !== undefined) {
    const checked = await checkDiagram(args.diagram, hooks);
    if ("error" in checked) return refuse(draft, checked.error);
    diagram = checked.diagram;
    removedNotes.push(...checked.notes);
    diagramLine = current.diagram ? `Replaced its diagram with ${aDiagram(diagram)}.` : `Added ${aDiagram(diagram)}.`;
  }
  const sources = [
    ...(args.overview !== undefined ? [{ text: overview, source: "markdown" as const }] : []),
    ...(args.diagram && diagram ? [{ text: diagram.source, source: diagramLinkSource(diagram) }] : []),
  ];
  const links = sources.length > 0 ? await checkLinks(sources, draft, hooks, draft.chapters.length) : null;
  if (links && links.problems.length > 0) return refuse(draft, "These links do not resolve:", ...links.problems.map((p) => `- ${p}`));
  const chapters = draft.chapters.map((c, i) => {
    if (i !== found.index) return c;
    const { diagram: _old, ...rest } = c;
    return { ...rest, title, overview, ...(diagram && { diagram }) };
  });
  return commit({ ...draft, chapters }, hooks, [`Updated ${describeChapter(draft, found.index)}.`, diagramLine, ...removedNotes, ...(links?.notes ?? [])]);
}

export interface GuideMoveChapterArgs {
  readonly chapter: string;
  readonly position: number;
}

function linkTexts(draft: GuideDraft, chapters: readonly GuideDraftChapter[]): Array<{ text: string; source: GuideLinkSource; where: string }> {
  const out: Array<{ text: string; source: GuideLinkSource; where: string }> = [];
  if (draft.overview) {
    out.push({ text: draft.overview.text, source: "markdown", where: "the overview" });
    if (draft.overview.diagram) {
      out.push({ text: draft.overview.diagram.source, source: diagramLinkSource(draft.overview.diagram), where: "the overview diagram" });
    }
  }
  for (const c of chapters) {
    out.push({ text: c.overview, source: "markdown", where: `the overview of ${c.id}` });
    if (c.diagram) out.push({ text: c.diagram.source, source: diagramLinkSource(c.diagram), where: `the diagram of ${c.id}` });
  }
  return out;
}

function chapterLinkShifts(draft: GuideDraft, next: readonly GuideDraftChapter[]): string[] {
  const notes: string[] = [];
  const seen = new Set<string>();
  for (const { text, source, where } of linkTexts(draft, next)) {
    for (const occurrence of findGuideLinks(text, source)) {
      const parsed = parseGuideLink(occurrence.href);
      if (!parsed?.ok || parsed.link.kind !== "chapter") continue;
      const n = parsed.link.chapter;
      const before = draft.chapters[n - 1];
      const after = next[n - 1];
      if (before?.id === after?.id) continue;
      const key = `${where}|${n}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const now = after ? `${after.id} "${after.title}"` : "no chapter";
      const was = before ? `${before.id} "${before.title}"` : "no chapter";
      notes.push(`\`chapter:${n}\` in ${where} now points at ${now} (was ${was}).`);
    }
  }
  return notes;
}

function orderLine(draft: GuideDraft): string {
  return `Order: ${draft.chapters.map((c, i) => `${i + 1}. ${c.id} "${c.title}"`).join(", ")}.`;
}

/** guide_move_chapter: move a chapter to a new position; answers the new order. */
export async function guideMoveChapter(draft: GuideDraft, args: GuideMoveChapterArgs, hooks?: GuideBuilderHooks): Promise<GuideBuilderAnswer> {
  const found = findChapter(draft, args.chapter ?? "");
  if ("error" in found) return refuse(draft, found.error);
  const position = args.position;
  if (!Number.isInteger(position) || position < 1 || position > draft.chapters.length) {
    return refuse(draft, `The position is from 1 to ${draft.chapters.length}.`);
  }
  if (position === found.index + 1) return answer(draft, true, [`${draft.chapters[found.index].id} is already at position ${position}.`, orderLine(draft)]);
  const chapters = [...draft.chapters];
  const [moved] = chapters.splice(found.index, 1);
  chapters.splice(position - 1, 0, moved);
  const next = { ...draft, chapters };
  return commit(next, hooks, [`Moved ${moved.id} to position ${position}.`, orderLine(next as GuideDraft), ...chapterLinkShifts(draft, chapters)]);
}

export interface GuideRemoveChapterArgs {
  readonly chapter: string;
}

/** guide_remove_chapter: remove a chapter; its files go back to not placed. */
export async function guideRemoveChapter(draft: GuideDraft, args: GuideRemoveChapterArgs, hooks?: GuideBuilderHooks): Promise<GuideBuilderAnswer> {
  const found = findChapter(draft, args.chapter ?? "");
  if ("error" in found) return refuse(draft, found.error);
  const removed = draft.chapters[found.index];
  const chapters = draft.chapters.filter((_, i) => i !== found.index);
  return commit({ ...draft, chapters }, hooks, [
    `Removed ${describeChapter(draft, found.index)} "${removed.title}".`,
    removed.files.length > 0 && `${plural(removed.files.length, "file is", "files are")} back to not placed: ${removed.files.map((f) => `\`${f.file}\``).join(", ")}.`,
    ...chapterLinkShifts(draft, chapters),
  ]);
}

export interface GuideFocusArg {
  readonly start?: number;
  readonly end?: number;
  readonly hunk?: number;
}

export interface GuidePlaceFileArgs {
  readonly file: string;
  readonly chapter: string;
  readonly summary: string;
  readonly focus?: readonly GuideFocusArg[];
}

function checkFocus(file: ChangeFile, focus: readonly GuideFocusArg[]): { ok: true; value: GuideFocusRange[] } | { ok: false; error: string } {
  if (file.status === "deleted") return { ok: false, error: `\`${file.path}\` is deleted in this change, so it has no lines to focus on.` };
  const spans = file.hunks.filter((h) => h.newCount > 0).map((h) => ({ start: h.newStart, end: h.newStart + h.newCount - 1 }));
  const changedLines = spans.map((s) => (s.start === s.end ? `${s.start}` : `${s.start}-${s.end}`)).join(", ");
  const out: GuideFocusRange[] = [];
  for (const item of focus) {
    if (item.hunk !== undefined) {
      if (item.start !== undefined || item.end !== undefined) return { ok: false, error: "A focus item is either `{ hunk }` or `{ start, end }`, not both." };
      if (!Number.isInteger(item.hunk) || item.hunk < 1 || item.hunk > file.hunks.length) {
        return { ok: false, error: `\`${file.path}\` has ${plural(file.hunks.length, "hunk")}; hunk ${item.hunk} is not one of them.` };
      }
      out.push({ hunk: item.hunk });
      continue;
    }
    if (item.start === undefined) return { ok: false, error: "A focus item needs `start` (and optionally `end`) or `hunk`." };
    const start = item.start;
    const end = item.end ?? start;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
      return { ok: false, error: `Focus lines ${start}-${end} are not a range on the head.` };
    }
    if (!spans.some((s) => start <= s.end && end >= s.start)) {
      return {
        ok: false,
        error: `Lines ${start === end ? start : `${start}-${end}`} of \`${file.path}\` are outside its changed lines (${changedLines || "none at the head"}).`,
      };
    }
    out.push({ start, end });
  }
  return { ok: true, value: out };
}

/** guide_place_file: put a changed file in a chapter with a one-line summary. */
export async function guidePlaceFile(draft: GuideDraft, args: GuidePlaceFileArgs, hooks?: GuideBuilderHooks): Promise<GuideBuilderAnswer> {
  const path = args.file ?? "";
  const change = changeOf(draft);
  const file = change.byPath.get(path);
  if (!file) return refuse(draft, notInChange(path, draft));
  const found = findChapter(draft, args.chapter ?? "");
  if ("error" in found) return refuse(draft, found.error);
  const existing = chapterOfFile(draft, path);
  if (existing && existing.index !== found.index) {
    return refuse(draft, `\`${path}\` is already in ${describeChapter(draft, existing.index)}. Use guide_move_file to move it.`);
  }
  const summary = cleanText(args.summary ?? "", "summary", GUIDE_BUILDER_TEXT_LIMITS.summary);
  if ("error" in summary) return refuse(draft, summary.error);
  let focus: GuideFocusRange[] | undefined;
  if (args.focus !== undefined && args.focus.length > 0) {
    const checked = checkFocus(file, args.focus);
    if ("error" in checked) return refuse(draft, checked.error);
    focus = checked.value;
  }
  const wasLeftOut = draft.unplaced.some((u) => u.file === path);
  const entry: GuideDraftFile = focus ? { file: path, summary: summary.value, focus } : { file: path, summary: summary.value };
  if (existing) {
    const chapters = draft.chapters.map((c, i) =>
      i === found.index ? { ...c, files: c.files.map((f) => (f.file === path ? entry : f)) } : c,
    );
    return commit({ ...draft, chapters }, hooks, [`Updated \`${path}\` in ${describeChapter(draft, found.index)}.`]);
  }
  const chapters = draft.chapters.map((c, i) => (i === found.index ? { ...c, files: [...c.files, entry] } : c));
  const unplaced = draft.unplaced.filter((u) => u.file !== path);
  const next = { ...draft, chapters, unplaced } as GuideDraft;
  const left = guideDraftProgress(next).remaining.length;
  return commit(next, hooks, [
    `Placed \`${path}\` in ${describeChapter(draft, found.index)}.`,
    wasLeftOut && "It was marked not in a chapter; it is in this chapter now.",
    left > 0 ? `${plural(left, "file is", "files are")} still not placed.` : "Every changed file is accounted for.",
  ]);
}

export interface GuideMoveFileArgs {
  readonly file: string;
  readonly chapter: string;
}

/** guide_move_file: move a placed file to another chapter (its summary and focus go with it). */
export async function guideMoveFile(draft: GuideDraft, args: GuideMoveFileArgs, hooks?: GuideBuilderHooks): Promise<GuideBuilderAnswer> {
  const path = args.file ?? "";
  if (!changeOf(draft).byPath.has(path)) return refuse(draft, notInChange(path, draft));
  const found = findChapter(draft, args.chapter ?? "");
  if ("error" in found) return refuse(draft, found.error);
  const existing = chapterOfFile(draft, path);
  if (!existing) {
    return refuse(draft, `\`${path}\` is not in a chapter yet. Use guide_place_file to place it.`);
  }
  if (existing.index === found.index) return answer(draft, true, [`\`${path}\` is already in ${describeChapter(draft, found.index)}.`]);
  const entry = draft.chapters[existing.index].files[existing.fileIndex];
  const chapters = draft.chapters.map((c, i) => {
    if (i === existing.index) return { ...c, files: c.files.filter((f) => f.file !== path) };
    if (i === found.index) return { ...c, files: [...c.files, entry] };
    return c;
  });
  return commit({ ...draft, chapters }, hooks, [
    `Moved \`${path}\` from ${describeChapter(draft, existing.index)} to ${describeChapter(draft, found.index)}.`,
  ]);
}

export interface GuideUnplaceFileArgs {
  readonly file: string;
  readonly reason?: string;
}

/** guide_unplace_file: leave a changed file out of every chapter on purpose ("Not in a chapter"). */
export async function guideUnplaceFile(draft: GuideDraft, args: GuideUnplaceFileArgs, hooks?: GuideBuilderHooks): Promise<GuideBuilderAnswer> {
  const path = args.file ?? "";
  if (!changeOf(draft).byPath.has(path)) return refuse(draft, notInChange(path, draft));
  let reason: string | undefined;
  if (args.reason !== undefined && args.reason.trim() !== "") {
    const r = cleanText(args.reason, "reason", GUIDE_BUILDER_TEXT_LIMITS.reason);
    if ("error" in r) return refuse(draft, r.error);
    reason = r.value;
  }
  const existing = chapterOfFile(draft, path);
  const chapters = existing
    ? draft.chapters.map((c, i) => (i === existing.index ? { ...c, files: c.files.filter((f) => f.file !== path) } : c))
    : draft.chapters;
  const earlier = draft.unplaced.find((u) => u.file === path);
  const alreadyLeftOut = earlier !== undefined;
  const keptReason = reason ?? earlier?.reason;
  const entry: GuideDraftUnplaced = keptReason ? { file: path, reason: keptReason } : { file: path };
  const unplaced = alreadyLeftOut ? draft.unplaced.map((u) => (u.file === path ? entry : u)) : [...draft.unplaced, entry];
  return commit({ ...draft, chapters, unplaced }, hooks, [
    existing
      ? `Took \`${path}\` out of ${describeChapter(draft, existing.index)}; it goes to "Not in a chapter".`
      : alreadyLeftOut
        ? `\`${path}\` was already not in a chapter${reason ? "; updated the reason" : ""}.`
        : `\`${path}\` goes to "Not in a chapter".`,
  ]);
}

function indent(text: string, prefix: string): string {
  return text.split("\n").map((line) => `${prefix}${line}`).join("\n");
}

function focusText(focus: readonly GuideFocusRange[]): string {
  return focus.map((f) => ("hunk" in f ? `hunk ${f.hunk}` : f.start === f.end ? `L${f.start}` : `L${f.start}-L${f.end}`)).join(", ");
}

/** guide_read: the whole draft in reading order, plus the changed files not placed yet. */
export async function guideRead(draft: GuideDraft): Promise<GuideBuilderAnswer> {
  const change = changeOf(draft);
  const lines: string[] = [];
  lines.push(`Title: ${draft.title || "(not set)"}`);
  lines.push(`Intent: ${draft.intent || "(not set)"}`);
  if (draft.overview) {
    lines.push("Overview:", indent(draft.overview.text, "  "));
    if (draft.overview.diagram) {
      const d = draft.overview.diagram;
      lines.push(`Diagram (${d.kind}):`, indent(d.source, "  "));
    }
  } else {
    lines.push("Overview: (not set; optional)");
  }
  lines.push("");
  if (draft.chapters.length === 0) {
    lines.push("Chapters: none yet.");
  } else {
    lines.push("Chapters, in reading order:");
    draft.chapters.forEach((c, i) => {
      lines.push(`${i + 1}. ${c.id} · ${c.title}`);
      lines.push(indent(c.overview, "   "));
      if (c.diagram) lines.push(`   Diagram (${c.diagram.kind}):`, indent(c.diagram.source, "     "));
      if (c.files.length === 0) lines.push("   Files: none yet.");
      for (const f of c.files) {
        lines.push(`   - ${f.file}: ${f.summary}${f.focus?.length ? ` [focus: ${focusText(f.focus)}]` : ""}`);
      }
    });
  }
  const progress = guideDraftProgress(draft);
  if (progress.remaining.length > 0) {
    lines.push("", `Not placed yet (${progress.remaining.length}):`);
    for (const path of progress.remaining) {
      const f = change.byPath.get(path)!;
      lines.push(`- ${path} (+${f.additions} -${f.deletions}${f.status !== "modified" ? `, ${f.status}` : ""})`);
    }
  }
  if (draft.unplaced.length > 0) {
    lines.push("", `Not in a chapter, on purpose (${draft.unplaced.length}):`);
    for (const u of draft.unplaced) lines.push(`- ${u.file}${u.reason ? `: ${u.reason}` : ""}`);
  }
  return answer(draft, true, [lines.join("\n")]);
}

function finishProblems(draft: GuideDraft, opts?: { allowEmptyIntent?: boolean }): string[] {
  const problems: string[] = [];
  if (!draft.title.trim()) problems.push("The guide has no title. Set it with guide_set_header.");
  if (!draft.intent.trim() && !opts?.allowEmptyIntent) problems.push("The guide has no intent. Set it with guide_set_header.");
  if (draft.chapters.length === 0) problems.push("The guide has no chapters. Add one with guide_add_chapter.");
  for (const [i, c] of draft.chapters.entries()) {
    if (c.files.length === 0) problems.push(`${describeChapter(draft, i)} "${c.title}" has no files. Place files in it or remove it.`);
  }
  const remaining = guideDraftProgress(draft).remaining;
  if (remaining.length > 0) {
    problems.push(
      `${plural(remaining.length, "changed file is", "changed files are")} neither placed nor marked not in a chapter: ${remaining.map((p) => `\`${p}\``).join(", ")}.`,
    );
  }
  const count = draft.chapters.length;
  if (draft.overview) {
    problems.push(...chapterLinkProblems(draft.overview.text, "markdown", count, "The overview"));
    if (draft.overview.diagram) {
      problems.push(...chapterLinkProblems(draft.overview.diagram.source, diagramLinkSource(draft.overview.diagram), count, "The overview diagram"));
    }
  }
  for (const [i, c] of draft.chapters.entries()) {
    problems.push(...chapterLinkProblems(c.overview, "markdown", count, `The overview of ${describeChapter(draft, i)}`));
    if (c.diagram) problems.push(...chapterLinkProblems(c.diagram.source, diagramLinkSource(c.diagram), count, `The diagram of ${describeChapter(draft, i)}`));
  }
  return problems;
}

/** The draft as the guide it describes, before snapshot validation. */
export function guideDraftToOutput(draft: GuideDraft): CodeGuideOutput {
  const sections: GuideSection[] = draft.chapters.map((c) => ({
    title: c.title,
    overview: c.overview,
    diffs: c.files.map((f) => ({ file: f.file, summary: f.summary })),
    ...(c.diagram && { diagram: c.diagram }),
  }));
  return {
    title: draft.title,
    intent: draft.intent,
    ...(draft.overview && { overview: draft.overview }),
    sections,
    unplacedFiles: draft.unplaced.map((u) => u.file),
  };
}

/**
 * Hard checks the authored-guide path applies (`plannotator guide export --guide`): every placed or
 * unplaced file is in the patch and placed once.
 */
export function checkAuthoredGuideFiles(guide: CodeGuideOutput, patchFiles: readonly string[]): string[] {
  const patchSet = new Set(patchFiles);
  const problems: string[] = [];
  const seen = new Map<string, number>();
  const unknown = new Set<string>();
  guide.sections.forEach((section, i) => {
    for (const ref of section.diffs) {
      if (!patchSet.has(ref.file)) unknown.add(ref.file);
      const first = seen.get(ref.file);
      if (first !== undefined) problems.push(`${ref.file} is placed twice (sections[${first}] and sections[${i}]); a file belongs to one section.`);
      else seen.set(ref.file, i);
    }
  });
  if (unknown.size > 0) problems.push(`These files are not in the patch: ${[...unknown].join(", ")}.`);
  const badUnplaced = (guide.unplacedFiles ?? []).filter((f) => !patchSet.has(f));
  if (badUnplaced.length > 0) problems.push(`unplacedFiles not in the patch: ${badUnplaced.join(", ")}.`);
  return problems;
}

async function buildSnapshot(draft: GuideDraft, hooks: GuideBuilderHooks | undefined): Promise<{ ok: true; snapshot: GuideSnapshot } | { ok: false; problems: string[] }> {
  const output = guideDraftToOutput(draft);
  const patchFiles = guideDraftChangedFiles(draft);
  const authored = checkAuthoredGuideFiles(output, patchFiles);
  if (authored.length > 0) return { ok: false, problems: authored };
  const validated = validateGuideOutput(output, patchFiles);
  if ("error" in validated) return { ok: false, problems: [validated.error] };
  const sections =
    validated.guide.sections.length === output.sections.length
      ? validated.guide.sections.map((section, i) => {
          const diagram = output.sections[i].diagram;
          return diagram ? { ...section, diagram } : section;
        })
      : validated.guide.sections;
  const guide: CodeGuideOutput = {
    ...validated.guide,
    sections,
    ...(draft.overview && { overview: draft.overview }),
  };
  const now = hooks?.now?.() ?? new Date().toISOString();
  const snapshot = buildGuideSnapshot({
    guide,
    reviewed: [],
    review: draft.review,
    generator: { generatedAt: now, ...draft.generator },
    exportedAt: now,
  });
  const parsed = parseGuideSnapshot(JSON.parse(JSON.stringify(snapshot)));
  if ("error" in parsed) return { ok: false, problems: [`The guide does not pass the format check (${parsed.error.path}): ${parsed.error.message}`] };
  return { ok: true, snapshot: parsed.value };
}

/**
 * guide_finish: run every check, build the snapshot (`buildGuideSnapshot`, then the strict
 * `parseGuideSnapshot`), and answer it.
 */
export async function guideFinish(draft: GuideDraft, hooks?: GuideBuilderHooks): Promise<GuideBuilderAnswer> {
  return finish(draft, hooks);
}

async function finish(draft: GuideDraft, hooks: GuideBuilderHooks | undefined, opts?: { allowEmptyIntent?: boolean }): Promise<GuideBuilderAnswer> {
  const problems = finishProblems(draft, opts);
  if (problems.length > 0) return refuse(draft, "The guide is not finished:", ...problems.map((p) => `- ${p}`));
  const built = await buildSnapshot(draft, hooks);
  if ("problems" in built) return refuse(draft, "The guide is not finished:", ...built.problems.map((p) => `- ${p}`));
  return answer(draft, true, [
    `Saved "${draft.title}": ${plural(draft.chapters.length, "chapter")}${draft.overview ? " and an overview" : ""}.`,
  ], { snapshot: built.snapshot });
}

export async function guideSaveAsIs(draft: GuideDraft, hooks?: GuideBuilderHooks): Promise<GuideBuilderAnswer> {
  const remaining = guideDraftProgress(draft).remaining;
  const kept = draft.chapters.filter((c) => c.files.length > 0);
  // Chapter links past the chapters that are left become plain text, so an
  // unfinished draft is never refused for a link to a chapter it never wrote.
  const count = kept.length;
  const overview = draft.overview
    ? {
        text: dropDanglingChapterLinks(draft.overview.text, "markdown", count),
        ...(draft.overview.diagram && {
          diagram: {
            kind: draft.overview.diagram.kind,
            source: dropDanglingChapterLinks(draft.overview.diagram.source, diagramLinkSource(draft.overview.diagram), count),
          },
        }),
      }
    : undefined;
  const adjusted: GuideDraft = {
    ...draft,
    title: draft.title.trim() || "Guided review",
    ...(overview && { overview }),
    chapters: kept.map((c) => ({
      ...c,
      overview: dropDanglingChapterLinks(c.overview, "markdown", count),
      ...(c.diagram && { diagram: { ...c.diagram, source: dropDanglingChapterLinks(c.diagram.source, diagramLinkSource(c.diagram), count) } }),
    })),
    unplaced: [...draft.unplaced, ...remaining.map((file) => ({ file }))],
  };
  const result = await finish(adjusted, hooks, { allowEmptyIntent: true });
  if (!result.ok) {
    const lines = result.text.split("\n");
    return refuse(draft, ...lines.slice(0, -1));
  }
  return {
    ...result,
    draft: adjusted,
    changed: true,
    text: [
      remaining.length > 0 && `${plural(remaining.length, "file")} went to "Not in a chapter".`,
      kept.length < draft.chapters.length && `Dropped ${plural(draft.chapters.length - kept.length, "empty chapter")}.`,
      result.text,
    ].filter(Boolean).join("\n"),
  };
}

const TOOL_ARGS: Record<
  GuideBuilderToolName,
  {
    readonly required: readonly string[];
    readonly optional: readonly string[];
    readonly retired?: readonly string[];
    readonly nullable?: readonly string[];
  }
> = {
  guide_set_header: { required: [], optional: ["title", "intent"] },
  guide_set_overview: { required: ["text"], optional: [], retired: ["diagram"] },
  guide_add_chapter: { required: ["title", "overview"], optional: ["diagram", "position"] },
  guide_update_chapter: { required: ["chapter"], optional: ["title", "overview", "diagram"], nullable: ["diagram"] },
  guide_move_chapter: { required: ["chapter", "position"], optional: [] },
  guide_remove_chapter: { required: ["chapter"], optional: [] },
  guide_place_file: { required: ["file", "chapter", "summary"], optional: ["focus"] },
  guide_move_file: { required: ["file", "chapter"], optional: [] },
  guide_unplace_file: { required: ["file"], optional: ["reason"] },
  guide_read: { required: [], optional: [] },
  guide_finish: { required: [], optional: [] },
};

const STRING_ARGS = new Set(["title", "intent", "text", "overview", "chapter", "file", "summary", "reason"]);
const INTEGER_ARGS = new Set(["position"]);

function checkArgs(name: GuideBuilderToolName, raw: unknown): { ok: true; args: Record<string, any> } | { ok: false; error: string } {
  const args = raw === undefined || raw === null ? {} : raw;
  if (!isRecord(args)) return { ok: false, error: `The arguments of ${name} are an object.` };
  const spec = TOOL_ARGS[name];
  const allowed = new Set([...spec.required, ...spec.optional, ...(spec.retired ?? [])]);
  const takes = spec.required.length + spec.optional.length > 0 ? `It takes: ${[...spec.required, ...spec.optional].join(", ")}.` : "It takes no arguments.";
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) return { ok: false, error: `\`${key}\` is not an argument of ${name}. ${takes}` };
  }
  for (const key of spec.required) {
    if (args[key] === undefined || args[key] === null) return { ok: false, error: `${name} needs \`${key}\`. ${takes}` };
  }
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value === null && spec.nullable?.includes(key)) {
      out[key] = null;
      continue;
    }
    if (value === undefined || value === null) continue;
    if (key === "chapter" && typeof value === "number") {
      out[key] = String(value);
      continue;
    }
    if (STRING_ARGS.has(key) && typeof value !== "string") return { ok: false, error: `\`${key}\` is text.` };
    if (INTEGER_ARGS.has(key) && (typeof value !== "number" || !Number.isInteger(value))) return { ok: false, error: `\`${key}\` is a whole number.` };
    if (key === "diagram") {
      if (!isRecord(value)) return { ok: false, error: "`diagram` is an object: { kind: \"mermaid\" | \"html\", source }." };
      const extra = Object.keys(value).filter((k) => k !== "kind" && k !== "source");
      if (extra.length > 0) return { ok: false, error: `\`diagram\` takes only \`kind\` and \`source\`, not ${extra.map((k) => `\`${k}\``).join(", ")}.` };
      if (value.kind !== "mermaid" && value.kind !== "html") return { ok: false, error: "`diagram.kind` is `mermaid` or `html`." };
      if (typeof value.source !== "string") return { ok: false, error: "`diagram.source` is text." };
    }
    if (key === "focus") {
      if (!Array.isArray(value)) return { ok: false, error: "`focus` is a list of { start, end } line ranges or { hunk } numbers." };
      for (const item of value) {
        if (!isRecord(item)) return { ok: false, error: "Each `focus` item is { start, end } or { hunk }." };
        for (const [k, v] of Object.entries(item)) {
          if (k !== "start" && k !== "end" && k !== "hunk") return { ok: false, error: `A \`focus\` item takes \`start\`, \`end\` or \`hunk\`, not \`${k}\`.` };
          if (typeof v !== "number" || !Number.isInteger(v)) return { ok: false, error: `\`focus.${k}\` is a whole number.` };
        }
      }
    }
    out[key] = value;
  }
  return { ok: true, args: out };
}

/** True when `name` is one of the builder's tools. */
export function isGuideBuilderToolName(name: string): name is GuideBuilderToolName {
  return (GUIDE_BUILDER_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * Run one builder tool by name with the agent's raw arguments: argument checks (unknown or missing
 * arguments, wrong types) answer plainly instead of throwing.
 */
export async function runGuideBuilderTool(draft: GuideDraft, name: string, rawArgs: unknown, hooks?: GuideBuilderHooks): Promise<GuideBuilderAnswer> {
  if (!isGuideBuilderToolName(name)) return refuse(draft, `There is no tool \`${name}\`. The guide tools are: ${GUIDE_BUILDER_TOOL_NAMES.join(", ")}.`);
  const checked = checkArgs(name, rawArgs);
  if ("error" in checked) return refuse(draft, checked.error);
  const a = checked.args;
  switch (name) {
    case "guide_set_header":
      return guideSetHeader(draft, a as GuideSetHeaderArgs, hooks);
    case "guide_set_overview":
      return guideSetOverview(draft, a as GuideSetOverviewArgs, hooks);
    case "guide_add_chapter":
      return guideAddChapter(draft, a as GuideAddChapterArgs, hooks);
    case "guide_update_chapter":
      return guideUpdateChapter(draft, a as GuideUpdateChapterArgs, hooks);
    case "guide_move_chapter":
      return guideMoveChapter(draft, a as GuideMoveChapterArgs, hooks);
    case "guide_remove_chapter":
      return guideRemoveChapter(draft, a as GuideRemoveChapterArgs, hooks);
    case "guide_place_file":
      return guidePlaceFile(draft, a as GuidePlaceFileArgs, hooks);
    case "guide_move_file":
      return guideMoveFile(draft, a as GuideMoveFileArgs, hooks);
    case "guide_unplace_file":
      return guideUnplaceFile(draft, a as GuideUnplaceFileArgs, hooks);
    case "guide_read":
      return guideRead(draft);
    case "guide_finish":
      return guideFinish(draft, hooks);
  }
}
