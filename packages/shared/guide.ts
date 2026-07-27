export interface GuideDiffRef {
  /** Repo-relative path; must match a DiffFile.path in the current review patch. */
  file: string;
  /** 1-2 sentence semantic description of what changed in THIS file, written
   *  from the diff hunks alone (no investigation). Required by the JSON schema
   *  for schema-enforced engines; optional here so a marker engine that omits
   *  it still yields a valid guide — the UI simply renders nothing. */
  summary?: string;
}

export interface GuideSection {
  /** Concept-level title, e.g. "Payment localization module" — never a filename paraphrase. */
  title: string;
  /** Markdown prose: what changed, why it exists, and its key implications.
   *  Semantic order (core first, consequences next, glue grouped last) is
   *  carried by the array position, not by any label field. */
  overview: string;
  /** File references into the provided changeset. Usually 1..n, but a
   *  deliberate prose-only context section (no diffs, real overview text) is
   *  a valid model output and is preserved as-is rather than dropped. */
  diffs: GuideDiffRef[];
}

export interface CodeGuideOutput {
  /** From the PR title when a PR is given, otherwise derived from the changes. */
  title: string;
  /** 1-2 sentence framing shown under the title: why this changeset exists. */
  intent: string;
  /** Ordered sections: core first, consequence next, support last. */
  sections: GuideSection[];
  /** Changed files the model didn't place — rendered in a trailing "Everything else" section. */
  unplacedFiles?: string[];
}

/** One row of GET /api/guides — a persisted guide for the current repo
 *  (#1112). Loaded through the guide endpoints as the `saved:{id}` pseudo
 *  job id. Browser-safe (types only); the store lives in guide-store.ts. */
export interface SavedGuideListEntry {
  id: string;
  /** Review-target label — "PR #1082" or the branch name. */
  label: string;
  title: string;
  /** Epoch ms when the guide was first persisted. */
  savedAt: number;
  progress: { reviewed: number; total: number };
  /** True when the stored head sha differs from the current head. */
  moved: boolean;
}

/** UI-side guide shape: server output extended with persisted per-section reviewed state.
 *  `saved` is set when the guide is persisted on disk (autosaved live job, or a
 *  `saved:{id}` load); `moved` is set only on `saved:` loads whose stored head
 *  sha differs from the head currently under review. */
export type CodeGuideData = CodeGuideOutput & { reviewed: boolean[]; saved?: boolean; moved?: boolean };
