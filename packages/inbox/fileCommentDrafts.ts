/**
 * A comment being written when its file closes (approval
 * "inbox-file-close-keeps-comment-draft", 2026-11-07): closing the file, or
 * going to another one, never asks; the words (and what they were on) wait
 * here, and are back in the comment box when that same file opens again.
 *
 * Kept in this window's memory, as Plannotator's own comment drafts are
 * (CommentPopover's `draftKey` store): a reload starts clean. A file is one
 * attachment at one version (`fileDraftKey`); attachment ids are unique, so
 * the thread needs no part of the key.
 */
import { createContext, useContext, useLayoutEffect, useRef, useState } from 'react';
import type { Annotation, ImageAttachment } from '@plannotator/ui/types';

export type FileCommentDraft =
  /** A comment composer of the viewer (a selection's, a pin's, code lines', a diagram part's): its anchor, its words as `text`. */
  | { kind: 'comment'; annotation: Annotation }
  /** A saved comment's edit box, its words changed and not saved. */
  | { kind: 'edit'; id: string; text: string }
  /** The file's own comment row (an image's, a film's): its words, a drawing not yet added, a film's pinned moment and frame. */
  | { kind: 'row'; text: string; markup: ImageAttachment | null; time?: number | null; frame?: Blob | null };

const drafts = new Map<string, FileCommentDraft[]>();

export const fileDraftKey = (attachmentId: string, version: string) => `${attachmentId}\u0000${version}`;

/** What waits for this file now (nothing removed). */
export function peekFileDrafts(key: string): readonly FileCommentDraft[] {
  return drafts.get(key) ?? [];
}

/** Take what waits for this file: it is the open file's again until it closes. */
export function takeFileDrafts(key: string): FileCommentDraft[] {
  const kept = drafts.get(key) ?? [];
  drafts.delete(key);
  return kept;
}

/** What the file held as it closed, in place of what waited before (nothing typed: nothing waits). */
export function keepFileDrafts(key: string, kept: readonly FileCommentDraft[]): void {
  if (kept.length === 0) drafts.delete(key);
  else drafts.set(key, [...kept]);
}

/** Whether a draft holds anything worth keeping. */
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

/**
 * What a comment is on, as a key: two comments on the same words, lines,
 * pin or part read the same. A comment saved on what a kept draft is on
 * replaces it (the person wrote it again there).
 */
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

/** For tests: forget every kept draft. */
export function clearFileDrafts(): void {
  drafts.clear();
}

/** A row draft, as the file's own comment row takes it. */
export type RowDraft = Extract<FileCommentDraft, { kind: 'row' }>;

/**
 * What the pane gives the file's own comment row (an image's, a film's):
 * the draft waiting for it as it mounts, and a way to be read as the file
 * closes. The row is keyed by file, so it mounts fresh for each.
 */
export interface FileDraftSeat {
  /** The row's waiting draft (read in its first render: nothing is removed). */
  peekRow: () => RowDraft | null;
  /** Read the row's words as the file closes; returns the way to stop. */
  register: (read: () => RowDraft | null) => () => void;
}

export const FileDraftContext = createContext<FileDraftSeat | null>(null);

/** For the file's own comment row: its waiting draft (once, as it mounts), and its words read as the file closes. */
export function useRowDraft(read: () => RowDraft | null): RowDraft | null {
  const seat = useContext(FileDraftContext);
  const [initial] = useState(() => seat?.peekRow() ?? null);
  const readRef = useRef(read);
  readRef.current = read;
  // A layout effect: still registered when the pane, closing, reads it (a parent's cleanup runs before its children's).
  useLayoutEffect(() => seat?.register(() => readRef.current()), [seat]);
  return initial;
}
