/**
 * Per-file annotate version history, keyed by file path (not content), so single-file and folder sessions share one history.
 * Never throws: storage failures are logged and null is returned.
 */

import { saveToHistory, getPlanVersion, getVersionCount, saveAnnotateSubmission } from "./storage";
import { contentHash } from "./draft";

export interface AnnotateVersionInfo {
  version: number;
  totalVersions: number;
  project: string;
}

export interface AnnotateHistoryResult {
  slug: string;
  diffCurrent: string;
  previousPlan: string | null;
  versionInfo: AnnotateVersionInfo;
  isNew: boolean;
}

export function deriveAnnotateHistorySlug(resolvedFilePath: string): string {
  const base =
    (resolvedFilePath.split(/[\\/]/).pop() || "document")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "document";
  return `annotate-${base}-${contentHash(resolvedFilePath).slice(0, 8)}`;
}

/** Never throws: a storage error is logged and yields null (no version diff). */
export function computeAnnotateHistory(
  project: string,
  resolvedFilePath: string,
  content: string,
): AnnotateHistoryResult | null {
  const slug = deriveAnnotateHistorySlug(resolvedFilePath);
  try {
    const saved = saveToHistory(project, slug, content);
    const previousPlan =
      saved.version > 1 ? getPlanVersion(project, slug, saved.version - 1) : null;
    return {
      slug,
      diffCurrent: content,
      previousPlan,
      versionInfo: {
        version: saved.version,
        totalVersions: getVersionCount(project, slug),
        project,
      },
      isNew: saved.isNew,
    };
  } catch (error) {
    console.error(
      `[plannotator] warning: annotate history unavailable (${error instanceof Error ? error.message : String(error)}); continuing without version diff`,
    );
    return null;
  }
}

export interface AnnotateSubmissionInput {
  project: string;
  /** Goes through deriveAnnotateHistorySlug, so single-file records share the file's history slug directory. */
  sessionPath: string;
  feedback: string;
  annotations: unknown[];
  approved?: boolean;
}

/**
 * Persist a record of a submitted decision before the draft is deleted: the CLI consumer may have timed out.
 * Never throws; null on failure (servers then keep the draft as the recovery copy).
 */
export function persistAnnotateSubmission(input: AnnotateSubmissionInput): string | null {
  try {
    const slug = deriveAnnotateHistorySlug(input.sessionPath);
    // The exported feedback text already embeds every annotation in
    // human-readable form; the raw annotations JSON is only recorded when
    // there is no text to fall back on (defensive — the UI always exports).
    const body = input.feedback.trim()
      ? input.feedback
      : "```json\n" + JSON.stringify(input.annotations, null, 2) + "\n```";
    const content = [
      "# Annotate feedback",
      "",
      `- Source: ${input.sessionPath}`,
      `- Decision: ${input.approved ? "approved (with notes)" : "feedback"}`,
      `- Submitted: ${new Date().toISOString()}`,
      "",
      "---",
      "",
      body,
      "",
    ].join("\n");
    return saveAnnotateSubmission(input.project, slug, content);
  } catch (error) {
    console.error(
      `[plannotator] warning: could not persist submitted annotate feedback (${error instanceof Error ? error.message : String(error)}); keeping the annotation draft as the recovery copy`,
    );
    return null;
  }
}
