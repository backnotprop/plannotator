/**
 * Annotate per-file version history.
 *
 * Runtime-agnostic core of the pipeline that powers annotate mode's inline
 * round-over-round diff: derive a stable slug for a file, snapshot its
 * content into history, and look up the previous version to diff against.
 * Used by both the single-file annotate flow (one file per session) and the
 * folder annotate flow (many files served lazily via /api/doc).
 *
 * History is keyed by file PATH, not content, and slug derivation depends
 * only on the resolved path — so the same file annotated once as a
 * single-file session and once inside a folder session shares one version
 * history and the same slug.
 *
 * Storage is an enhancement, never a gate: `computeAnnotateHistory` never
 * throws. Any failure (read-only data dir, full disk, etc.) is logged and
 * `null` is returned so the caller can degrade to a plain render with no
 * version diff instead of failing the request.
 *
 * Uses only node:fs / node:path / node:crypto (via ./storage and ./draft) so
 * non-Bun runtimes can vendor it unmodified.
 */

import { saveToHistory, getPlanVersion, getVersionCount } from "./storage";
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
}

/**
 * Derive the stable history slug for a file from its resolved absolute path.
 *
 * Takes an already-resolved path — it does no filesystem resolution of its
 * own — so callers are responsible for resolving first (e.g.
 * `path.resolve(filePath)` at single-file session start, or the resolved
 * `filepath` a folder session's /api/doc handler already computed for the
 * request). Same input always produces the same slug, which is what lets a
 * version saved under one annotate mode surface as the baseline when the
 * other mode opens the same path.
 */
export function deriveAnnotateHistorySlug(resolvedFilePath: string): string {
  const base =
    (resolvedFilePath.split(/[\\/]/).pop() || "document")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "document";
  return `annotate-${base}-${contentHash(resolvedFilePath).slice(0, 8)}`;
}

/**
 * Run the save-to-history → previous-version lookup pipeline for one file.
 *
 * Saves `content` as the next version (storage dedupes identical content
 * against the latest stored version), then looks up the previous version (if
 * any) to diff against. Never throws — any storage error is logged and
 * results in `null`, which callers should treat as "no version diff for this
 * request", not a failure of the request itself.
 */
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
    };
  } catch (error) {
    console.error(
      `[plannotator] warning: annotate history unavailable (${error instanceof Error ? error.message : String(error)}); continuing without version diff`,
    );
    return null;
  }
}
