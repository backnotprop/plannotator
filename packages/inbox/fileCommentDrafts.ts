import { createContext, useContext, useLayoutEffect, useRef, useState } from 'react';
import type { Annotation, ImageAttachment } from '@plannotator/ui/types';

export type FileCommentDraft =
  | { kind: 'comment'; annotation: Annotation }
  | { kind: 'edit'; id: string; text: string }
  | { kind: 'row'; text: string; markup: ImageAttachment | null; time?: number | null; frame?: Blob | null };

const drafts = new Map<string, FileCommentDraft[]>();

export const fileDraftKey = (attachmentId: string, version: string) => `${attachmentId}\u0000${version}`;

export function peekFileDrafts(key: string): readonly FileCommentDraft[] {
  return drafts.get(key) ?? [];
}

export function takeFileDrafts(key: string): FileCommentDraft[] {
  const kept = drafts.get(key) ?? [];
  drafts.delete(key);
  return kept;
}

export function keepFileDrafts(key: string, kept: readonly FileCommentDraft[]): void {
  if (kept.length === 0) drafts.delete(key);
  else drafts.set(key, [...kept]);
}

export function draftHasWords(draft: FileCommentDraft): boolean {
  switch (draft.kind) {
    case 'comment':
      return (draft.annotation.text ?? '').trim() !== '' || (draft.annotation.images?.length ?? 0) > 0;
    case 'edit':
      return true;
    case 'row':
      return draft.text.trim() !== '' || draft.markup !== null;
  }
}

export function anchorKeyOf(annotation: Annotation): string {
  const a = annotation as Annotation & { inboxCode?: { lineStart: number; lineEnd: number } };
  return JSON.stringify([
    a.type,
    a.originalText,
    a.startMeta ?? null,
    a.endMeta ?? null,
    a.htmlAnchor?.selector ?? null,
    a.diagramAnchor ?? null,
    a.inboxCode ? [a.inboxCode.lineStart, a.inboxCode.lineEnd] : null,
  ]);
}

export function clearFileDrafts(): void {
  drafts.clear();
}

export type RowDraft = Extract<FileCommentDraft, { kind: 'row' }>;

export interface FileDraftSeat {
  peekRow: () => RowDraft | null;
  register: (read: () => RowDraft | null) => () => void;
}

export const FileDraftContext = createContext<FileDraftSeat | null>(null);

export function useRowDraft(read: () => RowDraft | null): RowDraft | null {
  const seat = useContext(FileDraftContext);
  const [initial] = useState(() => seat?.peekRow() ?? null);
  const readRef = useRef(read);
  readRef.current = read;
  // A layout effect: still registered when the pane, closing, reads it (a parent's cleanup runs before its children's).
  useLayoutEffect(() => seat?.register(() => readRef.current()), [seat]);
  return initial;
}
