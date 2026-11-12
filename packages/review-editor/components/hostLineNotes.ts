import type { ReactNode } from 'react';
import type { DiffLineAnnotation } from '@pierre/diffs';
import type { CodeAnnotationType, DiffAnnotationMetadata } from '@plannotator/ui/types';

export interface HostLineNote {
  id: string;
  filePath: string;
  line: number;
  side: 'old' | 'new';
  key: string;
  render: () => ReactNode;
}

export const NO_HOST_LINE_NOTES: readonly HostLineNote[] = [];

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

export function hostLineNoteSignatures(notes: readonly HostLineNote[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const note of notes) map.set(note.filePath, `${map.get(note.filePath) ?? ''}${JSON.stringify([note.id, note.line, note.side, note.key])}\n`);
  return map;
}

export interface HostFileNote {
  id: string;
  filePath: string;
  key: string;
  height?: number;
  render: () => ReactNode;
}

export const NO_HOST_FILE_NOTES: readonly HostFileNote[] = [];

export function hostFileNoteSignatures(notes: readonly HostFileNote[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const note of notes) map.set(note.filePath, `${map.get(note.filePath) ?? ''}${JSON.stringify([note.id, note.key, note.height ?? null])}\n`);
  return map;
}
