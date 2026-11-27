/**
 * Words of the person's held for another computer that met a newer draft there (a read's `notLanded`; replyDraft.ts,
 * packages/server/inbox-machine-drafts.ts): which version this page put to the person as the conflict, and which one
 * the person chose on and is settling. Keep mine and Discard mine settle only a version this page offered: words a read
 * found while another choice waited here were never put to the person, and a read offers them once it is settled.
 * Module-level, as replyDraft.ts's conflict words: they outlive the thread pane.
 */
import type { InboxReplyDraft } from '@plannotator/core/inbox-types';
import type { ReplyDraftNotLanded } from '@plannotator/core/inbox-reply-draft';

/** Per thread: the version of held words this page put in the box as the conflict. */
const offered = new Map<string, string>();
/** Per thread: a version the person chose on, its settling on its way there: not offered again meanwhile. */
const settling = new Map<string, string>();

/**
 * The held conflict's words to put to the person now, noted as this page's offer (undefined: none, or they wait).
 * They wait while other words of the person's wait on a choice here (`waiting`: edits in the box, an offered draft),
 * and while words of theirs not saved (`failed`) are not among them.
 */
export function offerHeld(target: string, lost: ReplyDraftNotLanded, draft: InboxReplyDraft | null, waiting: boolean, failed: string | undefined): string | undefined {
  if ((draft?.body ?? '').trim() === lost.words.trim() || waiting || (failed !== undefined && !lost.words.includes(failed))) return undefined;
  offered.set(target, lost.version);
  return lost.words;
}

/** A version the person chose on is settling there: a read does not offer it again meanwhile. */
export const heldSettling = (target: string, version: string): boolean => settling.get(target) === version;

/** The version this page offered for the thread (undefined: the conflict showing is the window's own). */
export const heldOffered = (target: string): string | undefined => offered.get(target);

/** The conflict showing is gone (chosen on, emptied, sent): nothing this page offered stands for it any more. */
export const heldOfferEnds = (target: string): void => void offered.delete(target);

/** The person chose on `version`: `run` settles it there (its failure leaves the words offered again by the next read). */
export function settleHeld(target: string, version: string, run: () => Promise<unknown> | undefined): () => Promise<void> {
  settling.set(target, version);
  return async () => {
    try {
      await run()?.catch(() => undefined);
    } finally {
      if (settling.get(target) === version) settling.delete(target);
    }
  };
}

export function resetHeldOffersForTests(): void {
  offered.clear();
  settling.clear();
}
