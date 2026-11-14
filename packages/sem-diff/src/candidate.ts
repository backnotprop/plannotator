/** One extract/inline candidate, as a second opinion sees it. */
export interface Candidate {
  kind: 'extract' | 'inline';
  /** The file's name, as given to `semanticDiffFile` (filled in for per-diff second opinions). */
  file?: string;
  helper: string;
  caller: string;
  /** Source text. For an extract, `caller` is the new caller and `callerNew` the old one (extract is inline run backwards). */
  code: { helper: string; caller: string; callerNew: string };
}
