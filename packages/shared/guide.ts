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

/** UI-side guide shape: server output extended with persisted per-section reviewed state. */
export type CodeGuideData = CodeGuideOutput & { reviewed: boolean[] };
