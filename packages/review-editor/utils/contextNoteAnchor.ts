/**
 * A context note's place on a file's diff (approval "inbox-context-notes"): its own module, so a host can name the
 * type without compiling `AllFilesCodeView` (the Inbox's tsconfig does not build it). Re-exported from there.
 * Its file, side and lines; the row draws under `lineEnd`.
 */
export interface ContextNoteAnchor {
  id: string;
  filePath: string;
  side: 'old' | 'new';
  lineStart: number;
  lineEnd: number;
}
