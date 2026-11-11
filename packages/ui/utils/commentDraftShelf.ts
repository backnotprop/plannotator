/**
 * Where visible comment drafts wait between mounts (opt-in: `configurePlannotatorUI({ visibleCommentDrafts })`).
 *
 * The words of a comment not sent live in CommentPopover's draft store, keyed by `draftKey`; that store already
 * outlives a popover. This shelf keeps what each one is on (the selection's stored positions and quote), per
 * document scope, so a Viewer that mounts again (another thread and back, a file closed and opened, a step to the
 * next file) paints every waiting draft as a draft mark with its "Draft" badge. An entry whose words no longer wait
 * (sent, binned, taken by a host) is dropped as the shelf is read. Kept in this window's memory, like the draft
 * store: a reload starts clean.
 */
import type { AnnotationTextMeta } from '../types';

export interface ShelvedCommentDraft {
  /** The composer's own `draftKey` (the hook's; a host prefixes it with its scope for the draft store). */
  draftKey: string;
  /** web-highlighter positions, as stored (without a host's `belowTitle` slot). */
  startMeta: AnnotationTextMeta;
  endMeta: AnnotationTextMeta;
  /** The selected words. */
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

/** The drafts waiting in `scope`, oldest first; an entry whose words no longer wait (`waits` false) is dropped. */
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

/** For tests: forget every shelved draft. */
export function resetCommentDraftShelf(): void {
  shelves.clear();
}
