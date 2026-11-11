/**
 * The person's verdict on a review (code review in the Inbox, approval
 * "inbox-code-review-direction"), as pure parts the review pane uses and the
 * tests read:
 *
 * - `verdictOf`: what each decision of ui's DecisionControl sends: the
 *   verdict, whether the review's comments ride it, and whether they are
 *   discarded first;
 * - `verdictReply`: the reply body (the verdict words, the note, then the
 *   comments in the review app's export);
 * - `VerdictKeys`: one idempotency key per verdict, kept while the same
 *   verdict is retried, so a retry after a lost answer never sends twice;
 * - the note the person is writing, kept per review until its verdict goes
 *   (`readReviewNotes` / `saveReviewNotes` / `clearReviewNotes`), across a
 *   failed send, a close and a reload.
 */
import type { InboxAnnotationRecord } from '@plannotator/core/inbox-types';
import { inboxReviewVerdictWords, type InboxReviewVerdict } from '@plannotator/core/inbox-review';
import type { DecisionActionId } from '@plannotator/ui/utils/decisionSpec';
import { guideFeedback } from './attachments';
import { commentPictureUploads } from './commentPictureFiles';
import { newUuid } from './uuid';

export interface VerdictPlan {
  verdict: InboxReviewVerdict;
  /** The review's comments ride the reply. */
  withComments: boolean;
  /** The comments are removed before the verdict goes ("Approve, discard N comments…"). */
  discard?: true;
}

/** The verdict each decision sends, and whether the review's comments ride it. */
export function verdictOf(id: DecisionActionId, hasComments: boolean): VerdictPlan {
  switch (id) {
    case 'primary':
      return hasComments ? { verdict: 'changes_requested', withComments: true } : { verdict: 'approved', withComments: false };
    case 'note-with-approval':
      return { verdict: 'approved', withComments: false };
    case 'approve-with-notes':
      return { verdict: 'approved', withComments: true };
    case 'discard-and-finish':
      return { verdict: 'approved', withComments: false, discard: true };
    case 'request-changes':
    case 'note-with-feedback':
      return { verdict: 'changes_requested', withComments: hasComments };
  }
}

/** The verdict reply's parts: its words and, with comments, the feedback and the annotations it marks sent. */
export function verdictReply(
  plan: VerdictPlan,
  title: string,
  records: readonly InboxAnnotationRecord[],
  note?: string,
): { words: string; feedback?: string; annotation_ids?: string[]; uploads?: string[] } {
  const carried = plan.withComments ? records : [];
  const words = [inboxReviewVerdictWords(plan.verdict, title, carried.length), note?.trim() ?? ''].filter((part) => part !== '').join('\n\n');
  // A global comment's pictures go as the reply's attachments (commentPictures.tsx).
  const uploads = commentPictureUploads(carried);
  return carried.length > 0 ? { words, feedback: guideFeedback(carried), annotation_ids: carried.map((r) => r.id), ...(uploads.length > 0 ? { uploads } : {}) } : { words };
}

/**
 * One idempotency key per verdict: the same verdict (the same words, comments
 * and recipient) asked again gets the same key, so the Inbox answers the
 * first reply instead of storing a second; anything different gets a new one.
 * `done` forgets it once the verdict went.
 */
export class VerdictKeys {
  private last: { sig: string; key: string } | null = null;
  constructor(private readonly make: () => string = newUuid) {}
  keyFor(parts: unknown): string {
    const sig = JSON.stringify(parts);
    if (this.last?.sig !== sig) this.last = { sig, key: this.make() };
    return this.last.key;
  }
  done(): void {
    this.last = null;
  }
}

const NOTES_KEY = 'plannotator-inbox-review-notes:';

/** The notes the person was writing on a review's decisions, keyed by decision (DecisionControl's drafts). */
export function readReviewNotes(messageId: string): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(NOTES_KEY + messageId);
    const value = raw ? (JSON.parse(raw) as unknown) : null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== ''));
  } catch {
    return {};
  }
}

export function saveReviewNotes(messageId: string, notes: Record<string, string>): void {
  try {
    const kept = Object.fromEntries(Object.entries(notes).filter(([, text]) => text !== ''));
    if (Object.keys(kept).length === 0) window.localStorage.removeItem(NOTES_KEY + messageId);
    else window.localStorage.setItem(NOTES_KEY + messageId, JSON.stringify(kept));
  } catch {
    // Storage full or off: the note stays for this visit only.
  }
}

export function clearReviewNotes(messageId: string): void {
  try {
    window.localStorage.removeItem(NOTES_KEY + messageId);
  } catch {
    // Nothing kept.
  }
}
