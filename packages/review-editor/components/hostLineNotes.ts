import type { ReactNode } from 'react';
import type { DiffLineAnnotation } from '@pierre/diffs';
import type { CodeAnnotationType, DiffAnnotationMetadata } from '@plannotator/ui/types';

/**
 * Something the host draws itself under a line of the diff (the Inbox's PR page: other people's threads from the
 * forge). Read-only and never an annotation: nothing here is selected, counted, exported or posted. Absent: none, as
 * before.
 */
export interface HostLineNote {
  /** Stable for the same note across reads. */
  id: string;
  filePath: string;
  /** Drawn under this line. */
  line: number;
  side: 'old' | 'new';
  /** Changes whenever what `render` draws changes, so the line is drawn again; the same key leaves it as it is. */
  key: string;
  render: () => ReactNode;
}

export const NO_HOST_LINE_NOTES: readonly HostLineNote[] = [];

/** One file's notes in Pierre's line-annotation shape. The note itself is looked up by id when drawn. */
export function projectHostLineNotes(
  notes: readonly HostLineNote[],
  filePath: string,
): DiffLineAnnotation<DiffAnnotationMetadata>[] {
  return notes
    .filter((note) => note.filePath === filePath)
    .map((note) => ({
      side: note.side === 'old' ? ('deletions' as const) : ('additions' as const),
      lineNumber: note.line,
      metadata: { annotationId: note.id, type: 'comment' as CodeAnnotationType, kind: 'host-note' as const, text: note.key },
    }));
}

/** Per file, what its notes draw: a file whose signature moved is drawn again, and no other. */
export function hostLineNoteSignatures(notes: readonly HostLineNote[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const note of notes) map.set(note.filePath, `${map.get(note.filePath) ?? ''}${JSON.stringify([note.id, note.line, note.side, note.key])}\n`);
  return map;
}

/**
 * Something the host draws itself about a whole file (the Inbox's PR page: other people's comments on a whole file).
 * Drawn under the file's header, above its first lines, before the person's own comments on the file. Read-only and
 * never an annotation, as a `HostLineNote`. Absent: none, as before.
 */
export interface HostFileNote {
  /** Stable for the same note across reads. */
  id: string;
  filePath: string;
  /** Changes whenever what `render` draws changes, so the file's header is drawn again; the same key leaves it. */
  key: string;
  render: () => ReactNode;
}

export const NO_HOST_FILE_NOTES: readonly HostFileNote[] = [];

/** Per file, what its file notes draw: a file whose signature moved has its header drawn again, and no other. */
export function hostFileNoteSignatures(notes: readonly HostFileNote[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const note of notes) map.set(note.filePath, `${map.get(note.filePath) ?? ''}${JSON.stringify([note.id, note.key])}\n`);
  return map;
}
