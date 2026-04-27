export interface TourDiffAnchor {
  /** Relative file path within the repo. */
  file: string;
  /** Start line in the new file (post-change). */
  line: number;
  /** End line in the new file. */
  end_line: number;
  /** Raw unified diff hunk for this anchor. */
  hunk: string;
  /** One-line chip label, e.g. "Add retry logic". */
  label: string;
}

export interface TourKeyTakeaway {
  /** One sentence — the takeaway. */
  text: string;
  /** Severity for visual styling. */
  severity: "info" | "important" | "warning";
}

export interface TourStop {
  /** Short chapter title, friendly tone. */
  title: string;
  /** ONE sentence — the headline for this stop. Scannable without expanding. */
  gist: string;
  /** 2-3 sentences of additional context. Only shown when expanded. */
  detail: string;
  /** Connective phrase to the next stop, e.g. "Building on that..." (empty for last stop). */
  transition: string;
  /** Diff anchors — the code locations this stop references. */
  anchors: TourDiffAnchor[];
}

export interface TourQAItem {
  /** Product-level verification question. */
  question: string;
  /** Indices into stops[] that this question relates to. */
  stop_indices: number[];
}

export interface CodeTourOutput {
  /** One-line title for the entire tour. */
  title: string;
  /** 1-2 sentence friendly greeting + summary. Conversational, not formal. */
  greeting: string;
  /** 1-3 sentences: why this changeset exists — the motivation/problem being solved. */
  intent: string;
  /** What things looked like before this changeset — one sentence. */
  before: string;
  /** What things look like after — one sentence. */
  after: string;
  /** 3-5 key takeaways — the most critical info, scannable at a glance. */
  key_takeaways: TourKeyTakeaway[];
  /** Ordered tour stops — the detailed walk-through. */
  stops: TourStop[];
  /** Product-level QA checklist. */
  qa_checklist: TourQAItem[];
}

/** UI-side tour shape: server output extended with persisted checklist state. */
export type CodeTourData = CodeTourOutput & { checklist: boolean[] };
