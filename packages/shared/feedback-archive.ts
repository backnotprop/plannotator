/**
 * Durable local storage of every submitted review: `{DATA_DIR}/feedback/{project}/index.jsonl` (append-only, authoritative) plus a markdown sidecar in `records/` for records that carry content.
 * SHARED INDEX: other tools (`plannotator-tui`) append to the same file, told apart by the `client` field. The line shape is a cross-tool contract: fields are added, never repurposed; other clients suffix their id onto sidecar filenames; unknown fields must be ignored.
 * This module NEVER throws: a failure is logged once and reported as `null`. Callers append BEFORE deleting the reviewer's draft, so a failed write leaves the draft as the recovery copy.
 * The data dir is resolved PER CALL so a test can redirect PLANNOTATOR_DATA_DIR inside the test body.
 */

import { appendFileSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { parseDiagramAnchor, type DiagramAnchor } from "@plannotator/core/diagram-anchor";
import { parseImageRegion, type ImageRegion } from "@plannotator/core/image-region";
import { parseQuestionAnswer, type QuestionAnswer } from "@plannotator/core/question-block";
import { getPlannotatorDataDir } from "./data-dir";
import { extractDirName, extractRepoName, sanitizeTag } from "./project";

export const FEEDBACK_RECORD_VERSION = 1;

/** An open set, never an enum to validate against: other clients stamp themselves here. */
export const FEEDBACK_RECORD_CLIENT = "plannotator";

export type FeedbackSurface =
  | "plan"
  | "review"
  | "annotate"
  | "annotate-url"
  | "annotate-app"
  | "annotate-last"
  | "annotate-folder"
  /** Several files reviewed as one (0.29 bundles); `target.documents` lists them. */
  | "annotate-bundle";

export type FeedbackDecision =
  | "approved"
  | "approved-with-notes"
  | "denied"
  | "feedback"
  | "lgtm"
  | "dismissed";

/** Deliberately NOT the patch bytes: refs plus snapshot id regenerate the diff, and uncapped patch copies cost too much disk. */
export interface FeedbackReviewTarget {
  vcsType?: string;
  diffType?: string;
  base?: string;
  gitRef?: string;
  snapshotId?: string;
  /** Provenance, not a durable handle: a `--local` PR review's checkout is cleaned up when the session ends. `pr` plus `gitRef` are the identity that survives. */
  cwd?: string;
  pr?: { provider: string; repo: string; number: number };
  changedFiles?: number;
  patchBytes?: number;
}

export interface FeedbackTarget {
  slug?: string;
  planVersion?: number;
  planVersionFile?: string;
  /** The resolved file for a single-file session, the session's FOLDER for a folder session; each annotation names its own document in `documentPath`. */
  filePath?: string;
  /** Stored in full including its query string; a URL carrying a secret in its query is therefore written to disk (the archive opt-out is the control). */
  url?: string;
  documents?: { path: string; annotationCount: number }[];
  /** Reserved across every client sharing the index (plannotator-tui populates it); this module does not write it. Readers must tolerate its absence. */
  agent?: {
    host?: string;
    session?: string;
    transcript?: string;
  };
  review?: FeedbackReviewTarget;
}

export interface FeedbackAnnotationRecord {
  id?: string;
  type?: string;
  text?: string;
  originalText?: string;
  file?: string;
  lineStart?: number;
  lineEnd?: number;
  side?: string;
  /** Absent means a line comment (the pre-scope default), so a review-level general comment stays distinguishable. */
  scope?: string;
  outsideDiff?: boolean;
  blockId?: string;
  diffContext?: string;
  severity?: string;
  inReplyTo?: string;
  /** Absent means the human wrote it: the "my own comments" filter. */
  source?: string;
  author?: string;
  elementTag?: string;
  elementSelector?: string;
  elementPath?: string;
  elementRole?: string;
  elementName?: string;
  pageUrl?: string;
  /** Absent means the session's own target (`target.filePath`/`url`) or the message on annotate-last. Distinct from `file`, a code annotation's file. */
  documentPath?: string;
  diagramAnchor?: DiagramAnchor;
  imageRegion?: ImageRegion;
  /** The structured copy of the answer (the text also rides `feedback`); validated and capped by the same `parseQuestionAnswer` the ui runs; a malformed value is left out. */
  questionAnswer?: QuestionAnswer;
  isQuickLabel?: boolean;
  quickLabelTip?: string;
  images?: number;
}

export interface FeedbackRecord {
  v: number;
  ts: string;
  client: string;
  /** Not populated here: packages/shared has no runtime-agnostic version constant, and reading package.json from a vendored module would add a filesystem dependency. Named so clients that know their version share one key. */
  clientVersion?: string;
  project: string;
  origin?: string;
  surface: FeedbackSurface;
  decision: FeedbackDecision;
  target?: FeedbackTarget;
  feedback?: string;
  annotations?: FeedbackAnnotationRecord[];
  counts: { annotations: number; external: number; images: number };
  recordFile?: string;
}

export interface FeedbackArchiveInput {
  project: string;
  origin?: string;
  surface: FeedbackSurface;
  decision: FeedbackDecision;
  target?: FeedbackTarget;
  feedback?: unknown;
  annotations?: unknown;
  now?: Date;
}

/** Matches history/'s bucketing (`detectProjectName()` or `_unknown`); every other value is sanitizeTag'd, which keeps a caller-derived name from escaping the archive directory. */
export function normalizeFeedbackProject(project: string | null | undefined): string {
  if (!project) return "_unknown";
  if (project === "_unknown") return project;
  return sanitizeTag(project) ?? "_unknown";
}

export function deriveFeedbackProject(cwd: string | undefined): string {
  if (!cwd) return "_unknown";
  return extractDirName(cwd) ?? extractRepoName(cwd) ?? "_unknown";
}

function feedbackProjectDir(project: string): string {
  return join(getPlannotatorDataDir(), "feedback", normalizeFeedbackProject(project));
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Provenance (`source`, `author`) is always preserved: external, WebMCP and agent annotations belong in the record but must stay distinguishable from what the human wrote. */
function normalizeAnnotation(raw: unknown): FeedbackAnnotationRecord {
  if (typeof raw !== "object" || raw === null) return {};
  const a = raw as Record<string, unknown>;
  const record: FeedbackAnnotationRecord = {};
  const id = asString(a.id);
  if (id) record.id = id;
  const type = asString(a.type);
  if (type) record.type = type;
  const text = asString(a.text);
  if (text) record.text = text;
  // A code-review comment made in a Markdown preview quotes rendered text.
  const markdownPreview = typeof a.markdownPreview === "object" && a.markdownPreview !== null
    ? (a.markdownPreview as Record<string, unknown>)
    : undefined;
  const originalText = asString(a.originalText) ?? asString(a.selectedText) ?? asString(a.tokenText)
    ?? asString(markdownPreview?.originalText);
  if (originalText) record.originalText = originalText;
  const file = asString(a.filePath) ?? asString(a.file);
  if (file) record.file = file;
  const lineStart = asNumber(a.lineStart);
  if (lineStart !== undefined) record.lineStart = lineStart;
  const lineEnd = asNumber(a.lineEnd);
  if (lineEnd !== undefined) record.lineEnd = lineEnd;
  const side = asString(a.side);
  if (side) record.side = side;
  const scope = asString(a.scope);
  if (scope) record.scope = scope;
  if (a.outsideDiff === true) record.outsideDiff = true;
  const blockId = asString(a.blockId);
  if (blockId) record.blockId = blockId;
  const diffContext = asString(a.diffContext);
  if (diffContext) record.diffContext = diffContext;
  const severity = asString(a.severity);
  if (severity) record.severity = severity;
  const inReplyTo = asString(a.inReplyTo);
  if (inReplyTo) record.inReplyTo = inReplyTo;
  const source = asString(a.source);
  if (source) record.source = source;
  const author = asString(a.author);
  if (author) record.author = author;
  if (Array.isArray(a.images) && a.images.length > 0) record.images = a.images.length;
  const anchor = typeof a.htmlAnchor === "object" && a.htmlAnchor !== null ? (a.htmlAnchor as Record<string, unknown>) : undefined;
  const context = typeof a.elementContext === "object" && a.elementContext !== null ? (a.elementContext as Record<string, unknown>) : undefined;
  const elementTag = asString(context?.tag) ?? asString(anchor?.tagName);
  if (elementTag) record.elementTag = elementTag;
  const elementSelector = asString(anchor?.selector);
  if (elementSelector) record.elementSelector = elementSelector;
  const elementPath = asString(context?.path);
  if (elementPath) record.elementPath = elementPath;
  const elementRole = asString(context?.role);
  if (elementRole) record.elementRole = elementRole;
  const elementName = asString(context?.name);
  if (elementName) record.elementName = elementName;
  const pageUrl = asString(a.pageUrl);
  if (pageUrl) record.pageUrl = pageUrl;
  const documentPath = asString(a.documentPath);
  if (documentPath) record.documentPath = documentPath;
  const diagramAnchor = a.diagramAnchor === undefined ? null : parseDiagramAnchor(a.diagramAnchor);
  if (diagramAnchor !== null) record.diagramAnchor = diagramAnchor;
  const imageRegion = a.imageRegion === undefined ? null : parseImageRegion(a.imageRegion);
  if (imageRegion !== null) record.imageRegion = imageRegion;
  const questionAnswer = a.questionAnswer === undefined ? null : parseQuestionAnswer(a.questionAnswer);
  if (questionAnswer !== null) record.questionAnswer = questionAnswer;
  if (a.isQuickLabel === true) {
    record.isQuickLabel = true;
    const quickLabelTip = asString(a.quickLabelTip);
    if (quickLabelTip) record.quickLabelTip = quickLabelTip;
  }
  return record;
}

const SURFACE_TITLES: Record<FeedbackSurface, string> = {
  plan: "Plan review feedback",
  review: "Code review feedback",
  annotate: "Annotate feedback",
  "annotate-url": "Annotate feedback (URL)",
  "annotate-app": "Annotate feedback (live app)",
  "annotate-last": "Annotate feedback (agent message)",
  "annotate-folder": "Annotate feedback (folder)",
  "annotate-bundle": "Annotate feedback (several files)",
};

export function renderFeedbackRecordMarkdown(record: FeedbackRecord): string {
  const lines: string[] = [`# ${SURFACE_TITLES[record.surface] ?? "Feedback"}`, ""];
  lines.push(`- Submitted: ${record.ts}`);
  lines.push(`- Surface: ${record.surface}`);
  lines.push(`- Decision: ${record.decision}`);
  lines.push(`- Project: ${record.project}`);
  if (record.origin) lines.push(`- Origin: ${record.origin}`);
  const target = record.target;
  if (target?.filePath) lines.push(`- File: ${target.filePath}`);
  if (target?.url) lines.push(`- URL: ${target.url}`);
  for (const document of target?.documents ?? []) {
    lines.push(`- File: ${document.path} (${document.annotationCount} ${document.annotationCount === 1 ? "comment" : "comments"})`);
  }
  if (target?.slug) {
    lines.push(
      `- Plan: ${target.slug}${target.planVersion ? ` (version ${target.planVersion})` : ""}`,
    );
  }
  if (target?.planVersionFile) lines.push(`- Plan version file: ${target.planVersionFile}`);
  const review = target?.review;
  if (review) {
    const bits = [review.diffType, review.base ? `base ${review.base}` : null, review.gitRef ? `ref ${review.gitRef}` : null]
      .filter(Boolean)
      .join(", ");
    if (bits) lines.push(`- Diff: ${bits}`);
    if (review.cwd) lines.push(`- Repository: ${review.cwd}`);
    if (review.pr) lines.push(`- Pull request: ${review.pr.provider} ${review.pr.repo}#${review.pr.number}`);
  }
  lines.push(
    `- Annotations: ${record.counts.annotations}${record.counts.external > 0 ? ` (${record.counts.external} external)` : ""}`,
  );
  lines.push("", "---", "");
  lines.push(record.feedback && record.feedback.trim() ? record.feedback : "_No feedback text submitted._");
  lines.push("");
  return lines.join("\n");
}

/**
 * Returns the index path, or `null` when nothing durable was written (the caller keeps the draft). Never throws.
 * The sidecar is written first with the exclusive `wx` flag (retrying with a counter), so a record file is never overwritten and an index line never names a missing file; an orphan sidecar is harmless, a dangling reference is not.
 */
export function appendFeedbackRecord(input: FeedbackArchiveInput): string | null {
  try {
    const now = input.now ?? new Date();
    const project = normalizeFeedbackProject(input.project);
    const feedback = typeof input.feedback === "string" ? input.feedback : "";
    const rawAnnotations = Array.isArray(input.annotations) ? input.annotations : [];
    const annotations = rawAnnotations.map(normalizeAnnotation);
    const counts = {
      annotations: annotations.length,
      external: annotations.filter((a) => a.source !== undefined).length,
      images: annotations.reduce((sum, a) => sum + (a.images ?? 0), 0),
    };
    const hasContent = feedback.trim().length > 0 || annotations.length > 0;

    const record: FeedbackRecord = {
      v: FEEDBACK_RECORD_VERSION,
      ts: now.toISOString(),
      client: FEEDBACK_RECORD_CLIENT,
      project,
      ...(input.origin ? { origin: input.origin } : {}),
      surface: input.surface,
      decision: input.decision,
      ...(input.target ? { target: input.target } : {}),
      ...(feedback ? { feedback } : {}),
      ...(annotations.length > 0 ? { annotations } : {}),
      counts,
    };

    const projectDir = feedbackProjectDir(project);
    mkdirSync(projectDir, { recursive: true });

    if (hasContent) {
      const recordsDir = join(projectDir, "records");
      mkdirSync(recordsDir, { recursive: true });
      // Other clients suffix their own id onto sidecar names, so nothing may parse a sidecar name: `recordFile` is the only handle.
      const base = `${stamp(now)}-${input.surface}-${input.decision}`;
      let name = `${base}.md`;
      const body = renderFeedbackRecordMarkdown(record);
      for (let n = 2; ; n++) {
        try {
          writeFileSync(join(recordsDir, name), body, { encoding: "utf-8", flag: "wx" });
          break;
        } catch (err) {
          if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
          // Exhausting the counter is not an ordinary collision: the stamp is
          // per-millisecond, so 100 taken names in one millisecond means a
          // stopped clock or a runaway writer. Say so, or the outer catch logs
          // a bare EEXIST that reads like a transient disk problem.
          if (n > 100) {
            throw new Error(
              `sidecar name collision exceeded 100 attempts for ${base}.md (clock stuck or runaway writer)`,
            );
          }
          name = `${base}-${n}.md`;
        }
      }
      record.recordFile = `records/${name}`;
      // The sidecar body names the record's own metadata, not its filename, so
      // no rewrite is needed once the final name is known.
    }

    const indexPath = join(projectDir, "index.jsonl");
    // JSON.stringify never emits a raw newline, so one record is one line, handed to a single append-mode write. That is a practical guarantee only: NFS and SMB may interleave and damage both records; the backstop is that parseFeedbackIndex skips unparsable lines.
    appendFileSync(indexPath, `${JSON.stringify(record)}\n`, "utf-8");
    return indexPath;
  } catch (error) {
    console.error(
      `[plannotator] warning: could not archive submitted feedback (${error instanceof Error ? error.message : String(error)}); keeping the annotation draft as the recovery copy`,
    );
    return null;
  }
}

/** Never throws. A line counts as a record when it parses and carries a numeric `v`; it deliberately does NOT filter by version or `client`, so newer writers' lines are still returned. */
export function parseFeedbackIndex(contents: string): FeedbackRecord[] {
  const records: FeedbackRecord[] = [];
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as FeedbackRecord;
      if (parsed && typeof parsed === "object" && typeof parsed.v === "number") records.push(parsed);
    } catch {
      // Torn last line from a concurrent append — skip it, keep the rest.
    }
  }
  return records;
}

/** Deliberately not `extractChangedFiles` (code-nav), which unions the a/ and b/ sides so a rename counts twice. The `diff --git` header names a real path on both sides, so the b side alone is one entry per file. */
export function countChangedFiles(patch: string | null | undefined): number {
  if (!patch) return 0;
  const files = new Set<string>();
  const re = /^diff --git a\/(.+?) b\/(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(patch)) !== null) files.add(match[2]);
  return files.size;
}

export function feedbackIndexPath(project: string): string {
  return join(feedbackProjectDir(project), "index.jsonl");
}
