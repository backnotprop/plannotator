import { appendFileSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { parseDiagramAnchor, type DiagramAnchor } from "@plannotator/core/diagram-anchor";
import { parseImageRegion, type ImageRegion } from "@plannotator/core/image-region";
import { parseQuestionAnswer, type QuestionAnswer } from "@plannotator/core/question-block";
import { getPlannotatorDataDir } from "./data-dir";
import { extractDirName, extractRepoName, sanitizeTag } from "./project";

export const FEEDBACK_RECORD_VERSION = 1;

export const FEEDBACK_RECORD_CLIENT = "plannotator";

export type FeedbackSurface =
  | "plan"
  | "review"
  | "annotate"
  | "annotate-url"
  | "annotate-app"
  | "annotate-last"
  | "annotate-folder"
  | "annotate-bundle";

export type FeedbackDecision =
  | "approved"
  | "approved-with-notes"
  | "denied"
  | "feedback"
  | "lgtm"
  | "dismissed";

export interface FeedbackReviewTarget {
  vcsType?: string;
  diffType?: string;
  base?: string;
  gitRef?: string;
  snapshotId?: string;
  cwd?: string;
  pr?: { provider: string; repo: string; number: number };
  changedFiles?: number;
  patchBytes?: number;
}

export interface FeedbackTarget {
  slug?: string;
  planVersion?: number;
  planVersionFile?: string;
  filePath?: string;
  url?: string;
  documents?: { path: string; annotationCount: number }[];
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
  scope?: string;
  outsideDiff?: boolean;
  blockId?: string;
  diffContext?: string;
  severity?: string;
  inReplyTo?: string;
  source?: string;
  author?: string;
  elementTag?: string;
  elementSelector?: string;
  elementPath?: string;
  elementRole?: string;
  elementName?: string;
  pageUrl?: string;
  documentPath?: string;
  diagramAnchor?: DiagramAnchor;
  imageRegion?: ImageRegion;
  questionAnswer?: QuestionAnswer;
  isQuickLabel?: boolean;
  quickLabelTip?: string;
  images?: number;
}

export interface FeedbackRecord {
  v: number;
  ts: string;
  client: string;
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
      const base = `${stamp(now)}-${input.surface}-${input.decision}`;
      let name = `${base}.md`;
      const body = renderFeedbackRecordMarkdown(record);
      for (let n = 2; ; n++) {
        try {
          writeFileSync(join(recordsDir, name), body, { encoding: "utf-8", flag: "wx" });
          break;
        } catch (err) {
          if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
          if (n > 100) {
            throw new Error(
              `sidecar name collision exceeded 100 attempts for ${base}.md (clock stuck or runaway writer)`,
            );
          }
          name = `${base}-${n}.md`;
        }
      }
      record.recordFile = `records/${name}`;
    }

    const indexPath = join(projectDir, "index.jsonl");
    appendFileSync(indexPath, `${JSON.stringify(record)}\n`, "utf-8");
    return indexPath;
  } catch (error) {
    console.error(
      `[plannotator] warning: could not archive submitted feedback (${error instanceof Error ? error.message : String(error)}); keeping the annotation draft as the recovery copy`,
    );
    return null;
  }
}

export function parseFeedbackIndex(contents: string): FeedbackRecord[] {
  const records: FeedbackRecord[] = [];
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as FeedbackRecord;
      if (parsed && typeof parsed === "object" && typeof parsed.v === "number") records.push(parsed);
    } catch {
    }
  }
  return records;
}

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
