import { INBOX_DRAFT_BODY_MAX, type InboxRowUnsent } from '@plannotator/core/inbox-types';
import { shortTime } from '../format';
import { Icon } from '../icons';

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? '' : 's'}`;

export function unsentWords(unsent: { reply: boolean; picks: number; comments: number; done?: number; cant?: number }, lead = true): string {
  const parts: string[] = [];
  if (unsent.reply) parts.push('your reply');
  if (unsent.picks > 0) parts.push(plural(unsent.picks, 'pick'));
  if ((unsent.done ?? 0) > 0) parts.push(`${unsent.done} done`);
  if ((unsent.cant ?? 0) > 0) parts.push(`${unsent.cant} can't do`);
  if (unsent.comments > 0) parts.push(plural(unsent.comments, 'comment'));
  const text = parts.join(', ');
  return lead ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

export function rowUnsent(unsent: InboxRowUnsent): { reply: boolean; picks: number; comments: number; done?: number; cant?: number } {
  return { reply: unsent.reply_at !== null, picks: unsent.picks, comments: unsent.comments, done: unsent.done ?? 0, cant: unsent.cant ?? 0 };
}

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

export const DRAFT_NOT_SAVED_TOO_LONG = `Not saved: a draft holds at most ${INBOX_DRAFT_BODY_MAX.toLocaleString('en-US')} characters.`;

export const DRAFT_NOT_SAVED_FAILED = 'Not saved. It tries again when you type.';

export function conflictText(sentElsewhere: boolean): string {
  return sentElsewhere ? 'Not saved: this reply was sent or discarded in another window.' : 'Not saved: this reply changed in another window.';
}

export interface DraftConflict {
  id: string;
  text: string;
  onKeepMine: () => void;
  onDiscard: () => void;
}

export function DraftHead({ conflict }: { conflict: DraftConflict }) {
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

export function DraftStamp({
  savedAt,
  onDiscard,
  tooLong = false,
  failed = false,
}: {
  savedAt: string | null;
  onDiscard: () => void;
  tooLong?: boolean;
  failed?: boolean;
}) {
  if (!tooLong && !failed && savedAt === null) return null;
  return (
    <span className="ib-draft-stamp" data-draft-head="" data-draft-stamp="" data-draft-too-long={tooLong ? '' : undefined} data-draft-failed={failed && !tooLong ? '' : undefined}>
      <span className="ib-draft-pill">Draft</span>
      <span className="ib-draft-saved" role="status">
        {tooLong ? DRAFT_NOT_SAVED_TOO_LONG : failed ? DRAFT_NOT_SAVED_FAILED : `Saved ${shortTime(savedAt!)}`}
      </span>
      {!tooLong && savedAt !== null && (
        <button type="button" className="ib-draft-discard" data-draft-discard="" onClick={onDiscard}>
          Discard
        </button>
      )}
    </span>
  );
}

export function DraftFootNote({
  unsent,
  id,
  onComments,
  commentsOpen = false,
}: {
  unsent: { reply: boolean; picks: number; comments: number; done?: number; cant?: number };
  id?: string;
  onComments?: () => void;
  commentsOpen?: boolean;
}) {
  const lead = unsentWords({ ...unsent, comments: 0 });
  const comments = unsent.comments > 0 ? unsentWords({ reply: false, picks: 0, comments: unsent.comments }, lead === '') : '';
  const link = onComments ? { type: 'button' as const, onClick: onComments, 'aria-expanded': commentsOpen, 'aria-haspopup': 'dialog' as const, 'data-comments-link': '' } : null;
  return (
    <>
    {link && <span id={id} hidden>{['Draft', lead, comments].filter(Boolean).join(', ')}</span>}
    <span className="ib-draft-foot" data-draft-foot="" id={link ? undefined : id}>
      <span className="ib-draft-pill">
        {/* The comma is for the ear ("Draft, 1 pick, 3 comments"): inline and sized to nothing, so no space comes before it. */}
        <span>
          Draft
          {(lead || comments) && <span className="ib-draft-comma">,</span>}
        </span>
        {unsent.comments > 0 &&
          (link ? (
            <button {...link} className="ib-draft-pc ib-comments-link" data-draft-pill-count="" aria-label={comments}>
              <Icon name="comment" size={12} />
              {unsent.comments}
            </button>
          ) : (
            <span className="ib-draft-pc" data-draft-pill-count="" aria-hidden="true">
              <Icon name="comment" size={12} />
              {unsent.comments}
            </span>
          ))}
      </span>{' '}
      <span className="ib-st">
        {lead && <span data-draft-words="">{lead}</span>}
        {lead && comments && <span data-draft-sep="">{', '}</span>}
        {comments &&
          (link ? (
            <button {...link} className="ib-comments-link" data-draft-comments="">
              {comments}
            </button>
          ) : (
            <span data-draft-comments="">{comments}</span>
          ))}
      </span>
    </span>
    </>
  );
}
