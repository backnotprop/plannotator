import type { AnnotationTextMeta } from '../types';

export interface ShelvedCommentDraft {
  draftKey: string;
  startMeta: AnnotationTextMeta;
  endMeta: AnnotationTextMeta;
  text: string;
}

const shelves = new Map<string, Map<string, ShelvedCommentDraft>>();

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
