/**
 * "Draft" (approval "inbox-reply-drafts", variant Label): what the person has
 * not sent in a thread, said with Gmail's word wherever the window used to say
 * "Not sent". The row's count slot ("Draft · Your reply, 2 picks"), the soft
 * pill above the reply box ("Draft  Reply to … · Saved 4:43 PM · Discard"),
 * and the thread's foot ("Draft · 2 picks" before Send / Edit draft). Action
 * items waiting for the Send count as "1 done", "1 can't do".
 */
import type { InboxRowUnsent } from '@plannotator/core/inbox-types';
import { shortTime } from '../format';
import { Icon } from '../icons';

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? '' : 's'}`;

/** What waits, in words: "Your reply, 2 picks, 1 comment" (`lead`: capitalized). */
export function unsentWords(unsent: { reply: boolean; picks: number; comments: number; done?: number; cant?: number }, lead = true): string {
  const parts: string[] = [];
  if (unsent.reply) parts.push('your reply');
  if (unsent.picks > 0) parts.push(plural(unsent.picks, 'pick'));
  // Action items whose Done or Can't do it waits for the Send (approval "inbox-action-items-in-reply").
  if ((unsent.done ?? 0) > 0) parts.push(`${unsent.done} done`);
  if ((unsent.cant ?? 0) > 0) parts.push(`${unsent.cant} can't do`);
  if (unsent.comments > 0) parts.push(plural(unsent.comments, 'comment'));
  const text = parts.join(', ');
  return lead ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

/** A row's `unsent`, as unsentWords takes it. */
export function rowUnsent(unsent: InboxRowUnsent): { reply: boolean; picks: number; comments: number; done?: number; cant?: number } {
  return { reply: unsent.reply_at !== null, picks: unsent.picks, comments: unsent.comments, done: unsent.done ?? 0, cant: unsent.cant ?? 0 };
}

/**
 * "Draft · Your reply" (the Drafts page). `short`: "Draft" alone, the list row's short form (approval
 * "inbox-row-byline", option A); the row says the rest in its tooltip and name.
 */
export function DraftLabel({ unsent, short = false }: { unsent: InboxRowUnsent; short?: boolean }) {
  if (short) {
    return (
      <span className="ib-draft-l" data-draft-label="">
        <b>Draft</b>
      </span>
    );
  }
  return (
    <span className="ib-draft-l" data-draft-label="">
      <b>Draft</b> <span aria-hidden="true">·</span> <span>{unsentWords(rowUnsent(unsent))}</span>
    </span>
  );
}

/** The conflict line's words: both windows hold words for this reply. */
export function conflictText(sentElsewhere: boolean): string {
  return sentElsewhere ? 'Not saved: this reply was sent or discarded in another window.' : 'Not saved: this reply changed in another window.';
}

/**
 * Both windows hold words for this reply: this window's save was refused, and
 * its words are in the box, not saved. Keep mine saves them over the other's;
 * Discard mine drops only this window's words (the other's draft stays).
 */
export interface DraftConflict {
  /** The line's id: the reply box names it in aria-describedby. */
  id: string;
  text: string;
  onKeepMine: () => void;
  onDiscard: () => void;
}

/** Above the open reply box: the pill, whom it goes to, when it was saved, and Discard (or, after a conflict, the line and its choice). */
export function DraftHead({
  label,
  savedAt,
  onDiscard,
  conflict = null,
}: {
  label: string;
  savedAt: string | null;
  onDiscard: (() => void) | null;
  conflict?: DraftConflict | null;
}) {
  if (conflict) {
    // Not a live region: the thread's own region says it once when it appears.
    return (
      <div className="ib-reply-l ib-draft-head" data-draft-head="" data-draft-conflict="">
        <span className="ib-draft-pill">Draft</span>
        <span className="ib-draft-saved" id={conflict.id}>
          {conflict.text}
        </span>
        <span className="ib-draft-acts">
          <button type="button" className="ib-draft-discard" data-draft-keep-mine="" onClick={conflict.onKeepMine}>
            Keep mine
          </button>
          <button type="button" className="ib-draft-discard" data-draft-discard="" onClick={conflict.onDiscard}>
            Discard mine
          </button>
        </span>
      </div>
    );
  }
  return (
    <div className="ib-reply-l ib-draft-head" data-draft-head="">
      {savedAt !== null && <span className="ib-draft-pill">Draft</span>} <span className="ib-draft-for" dir="auto">{label}</span>
      {savedAt !== null && (
        <>
          <span className="ib-sp" />
          <span className="ib-draft-saved" role="status">
            Saved {shortTime(savedAt)}
          </span>
          {onDiscard && (
            <button type="button" className="ib-draft-discard" data-draft-discard="" onClick={onDiscard}>
              Discard
            </button>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The thread's foot while the box is closed and something waits: "Draft · 2 picks, 3 comments".
 * The words before the comments ("Your reply, 2 picks") and the comment count are spans of their own: short of room
 * the foot's row drops the pick words (footFit.ts step `draft`) and shows the count in the pill instead ("Draft 💬3").
 * That glyph and number are hidden from screen readers; the words stay as hidden text ("Draft, 2 picks, 3 comments").
 */
export function DraftFootNote({ unsent, id }: { unsent: { reply: boolean; picks: number; comments: number; done?: number; cant?: number }; id?: string }) {
  const lead = unsentWords({ ...unsent, comments: 0 });
  const comments = unsent.comments > 0 ? unsentWords({ reply: false, picks: 0, comments: unsent.comments }, lead === '') : '';
  return (
    <span className="ib-draft-foot" data-draft-foot="" id={id}>
      <span className="ib-draft-pill">
        {/* The comma is for the ear ("Draft, 1 pick, 3 comments"): inline and sized to nothing, so no space comes before it. */}
        <span>
          Draft
          {(lead || comments) && <span className="ib-draft-comma">,</span>}
        </span>
        {unsent.comments > 0 && (
          <span className="ib-draft-pc" data-draft-pill-count="" aria-hidden="true">
            <Icon name="comment" size={12} />
            {unsent.comments}
          </span>
        )}
      </span>{' '}
      <span className="ib-st">
        {lead && <span data-draft-words="">{lead}</span>}
        {lead && comments && <span data-draft-sep="">{', '}</span>}
        {comments && <span data-draft-comments="">{comments}</span>}
      </span>
    </span>
  );
}
