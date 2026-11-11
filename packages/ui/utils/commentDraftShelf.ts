import type { AnnotationTextMeta } from '../types';

export interface ShelvedCommentDraft {
  draftKey: string;
  /** web-highlighter positions, as stored (without a host's `belowTitle` slot). */
  startMeta: AnnotationTextMeta;
  endMeta: AnnotationTextMeta;
  text: string;
}

const shelves = new Map<string, Map<string, ShelvedCommentDraft>>();

/** Remember what a draft is on, for the document `scope` (the last word for its `draftKey` wins). */
export function shelveCommentDraft(scope: string, draft: ShelvedCommentDraft): void {
  let shelf = shelves.get(scope);
  if (!shelf) {
    shelf = new Map();
    shelves.set(scope, shelf);
  }
  shelf.delete(draft.draftKey);
  shelf.set(draft.draftKey, draft);
}

export function shelvedCommentDrafts(scope: string, waits: (draftKey: string) => boolean): ShelvedCommentDraft[] {
  const shelf = shelves.get(scope);
  if (!shelf) return [];
  const kept: ShelvedCommentDraft[] = [];
  for (const [key, draft] of [...shelf]) {
    if (waits(key)) kept.push(draft);
    else shelf.delete(key);
  }
  if (shelf.size === 0) shelves.delete(scope);
  return kept;
}

export function resetCommentDraftShelf(): void {
  shelves.clear();
}
