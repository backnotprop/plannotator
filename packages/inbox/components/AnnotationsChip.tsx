import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { InboxAnnotationRecord, InboxAttachmentState } from '@plannotator/core/inbox-types';
import { annotationOf, recordQuote, recordTag } from '../attachments';
import { plural } from '../format';
import { Icon } from '../icons';
import { useConfigValue } from '@plannotator/ui/config';
import { isCommentSubmitKey } from '@plannotator/ui/utils/commentSubmitKey';

/** The list is open, at this comment (null: from the top). The thread holds it: a highlight opens the list too. */
export interface CommentsListAt {
  at: string | null;
  /** Counts the presses on a highlight: one more on the same highlight brings its comment back into view. */
  press?: number;
  /** Opened from the full-screen card, which draws it. Not "in full screen": a Markdown file there has no card. */
  card?: boolean;
}

/** A comment being edited in the list. Held with the list, not in it: however the list closes, the words come back with it. */
export interface CommentEdit {
  id: string;
  text: string;
}

export interface AnnotationsListProps {
  records: readonly InboxAnnotationRecord[];
  attachments: readonly InboxAttachmentState[];
  onEdit: (record: InboxAnnotationRecord, text: string) => Promise<void>;
  onRemove: (record: InboxAnnotationRecord) => Promise<void>;
  /** The file name: open the file at that annotation (or, for a comment on a message's text, show that passage). */
  onOpen: (record: InboxAnnotationRecord) => void;
  /** A comment on a message's text: the row's name ("Claude Code's message, 2:58 PM"). */
  messageName?: (record: InboxAnnotationRecord) => string;
  /** Comments whose words were not found where they were made: tagged "Unanchored". */
  unanchored?: ReadonlySet<string>;
  editing: CommentEdit | null;
  onEditing: (next: CommentEdit | null) => void;
}

/** What opens the list, and marks a press on it as not a click outside: a press there toggles the list itself. */
const OPENS_THE_LIST = '[data-comments-link], .ib-body [data-bind-id], .ib-body [data-highlight-id]';

const focusNoScroll = (element: HTMLElement | null | undefined) => element?.focus({ preventScroll: true });

/**
 * The list of the comments going with the next Send, each with its file, quote
 * and comment; a comment edits in place, Remove deletes it, the file name opens
 * the file at that place. Mounted only while open. Four ways in: the reply
 * box's chip, the closed foot's "N comments" and a highlight in a message
 * (Thread.tsx), and the full-screen card's chip (FullScreenComposer.tsx). A
 * phone draws it as a sheet.
 *
 * Escape or a click outside closes it (`onClose`: `back` is whether focus goes
 * back to what opened it). Inside an attached HTML page neither reaches this
 * window: a click there shows as focus leaving for the frame, and its Escape
 * climbs the pane's ladder (escapeLadder.ts, rung `popover`).
 */
export function AnnotationsList({
  records,
  attachments,
  onEdit,
  onRemove,
  onOpen,
  messageName,
  unanchored,
  editing: held,
  onEditing,
  at,
  press,
  onClose,
  fit = false,
}: AnnotationsListProps & {
  at: string | null;
  press?: number;
  onClose: (back: boolean) => void;
  /** Keep it in the window by moving it from where it opened (the reply box's chip); elsewhere the CSS places it. */
  fit?: boolean;
}) {
  // A comment that has gone (a Send took it, another window removed it) is not being edited.
  const editing = held && records.some((record) => record.id === held.id) ? held : null;
  const [busy, setBusy] = useState(false);
  const enterSavesComment = useConfigValue('enterSavesComment');
  const popRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // A dialog takes focus as it opens, without scrolling anything behind it (back at an edit, the edit has it already).
  useEffect(() => {
    if (!popRef.current?.contains(document.activeElement)) focusNoScroll(popRef.current);
  }, []);

  // Opened from a highlight, or back at an edit: that comment, in the list's own scroll (scrollIntoView would move
  // what is behind it too). Under the header, which stays.
  const showRow = at ?? editing?.id ?? null;
  useLayoutEffect(() => {
    const pop = popRef.current;
    const row = showRow ? pop?.querySelector<HTMLElement>(`[data-annotation-row="${CSS.escape(showRow)}"]`) : null;
    if (pop && row) pop.scrollTop = row.offsetTop - Math.max(0, (pop.clientHeight - row.offsetHeight) / 2);
  }, [at, press]);

  // Read at the key press, not from the render that bound the listener: an Escape that lands right after a
  // Save (before the effect re-binds) must close the list, not "close" an edit that already ended.
  const editingRef = useRef(editing);
  editingRef.current = editing;
  // Where focus last was. Not `document.activeElement`: when what held it goes, in the list or out, it falls to the body.
  const focusHere = useRef(true);
  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      const target = event.target as Element;
      if (popRef.current?.contains(target) || target.closest?.(OPENS_THE_LIST)) return;
      closeRef.current(false);
    };
    const onBlur = () => {
      if (document.activeElement instanceof HTMLIFrameElement) closeRef.current(false);
    };
    const onFocus = (event: FocusEvent) => {
      focusHere.current = !!popRef.current?.contains(event.target as Node);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      if (editingRef.current) {
        editingRef.current = null;
        onEditing(null);
      } else closeRef.current(true);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focusin', onFocus);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focusin', onFocus);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [onEditing]);

  // The last comment went. Focus goes back only if the list had it: a Send that took them has its own place for focus.
  useEffect(() => {
    if (records.length === 0) closeRef.current(focusHere.current);
  }, [records.length]);

  // From the chip, the list opens at the chip; where that would run past the window's right edge it lines up with
  // the reply box's right edge instead (and never past the window's left edge).
  const [shift, setShift] = useState(0);
  useLayoutEffect(() => {
    if (!fit) return;
    const place = () => {
      const pop = popRef.current;
      const chip = pop?.parentElement;
      if (!pop || !chip || getComputedStyle(pop).position !== 'absolute') {
        setShift(0);
        return;
      }
      const margin = 8;
      const chipLeft = chip.getBoundingClientRect().left;
      const width = pop.getBoundingClientRect().width;
      const viewRight = document.documentElement.clientWidth - margin;
      let left = chipLeft;
      if (left + width > viewRight) {
        const boxRight = chip.closest('.ib-rbox')?.getBoundingClientRect().right ?? viewRight;
        left = Math.min(boxRight, viewRight) - width;
      }
      setShift(Math.round(Math.max(margin, left) - chipLeft));
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [fit]);

  const name = (record: InboxAnnotationRecord) =>
    record.message
      ? (messageName?.(record) ?? 'Message')
      : record.guide
        ? record.path
        : (attachments.find((a) => a.id === record.attachment_id) ?? attachments.find((a) => a.path === record.path))?.name ?? record.path;

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } finally {
      setBusy(false);
      // Remove took the button that held focus: the list keeps it, so Tab and Escape carry on from here.
      if (!document.activeElement || document.activeElement === document.body) focusNoScroll(popRef.current);
    }
  };

  return (
    <div
      ref={popRef}
      className="ib-annpop"
      role="dialog"
      tabIndex={-1}
      aria-label={plural(records.length, 'comment')}
      data-comments-list=""
      style={shift ? ({ '--ib-annpop-shift': `${shift}px` } as CSSProperties) : undefined}
    >
      <div className="ib-aph">
        <b>{plural(records.length, 'comment')}</b>
        <span className="ib-sp" />
        <button type="button" className="ib-iconbtn" onClick={() => closeRef.current(true)} aria-label="Close the list">
          <Icon name="x" />
        </button>
      </div>
      {records.map((record) => {
        const annotation = annotationOf(record);
        const tag = recordTag(record);
        const quote = recordQuote(record);
        const isEditing = editing?.id === record.id;
        return (
          <div className={`ib-arow${isEditing ? ' ib-ed' : ''}${at === record.id ? ' ib-at' : ''}`} key={record.id} data-annotation-row={record.id} aria-current={at === record.id || undefined}>
            <div className="ib-a1">
              <button
                type="button"
                className="ib-af"
                onClick={() => {
                  closeRef.current(false);
                  onOpen(record);
                }}
              >
                {name(record)}
                {record.guide ? ' (guided review)' : record.version !== 'current' ? ' (sent)' : ''}
              </button>
              {tag && <span className="ib-mini">{tag}</span>}
              {unanchored?.has(record.id) && (
                <span className="ib-mini" data-unanchored="">
                  Unanchored
                </span>
              )}
              {!isEditing && (
                <>
                  <span className="ib-sp" />
                  <button type="button" className="ib-aa" onClick={() => onEditing({ id: record.id, text: annotation.text ?? '' })}>
                    Edit
                  </button>
                  <button type="button" className="ib-aa" disabled={busy} onClick={() => void run(() => onRemove(record))}>
                    Remove
                  </button>
                </>
              )}
            </div>
            {quote && <p className="ib-aq">"{quote}"</p>}
            {isEditing ? (
              <>
                <textarea
                  className="ib-aed"
                  aria-label="Edit the comment"
                  value={editing.text}
                  autoFocus
                  rows={2}
                  onChange={(event) => onEditing({ id: record.id, text: event.target.value })}
                  onKeyDown={(event) => {
                    if (isCommentSubmitKey(event, enterSavesComment)) {
                      event.preventDefault();
                      void run(async () => {
                        await onEdit(record, editing.text);
                        onEditing(null);
                      });
                    }
                  }}
                />
                <div className="ib-abt">
                  <button type="button" className="ib-del-l" disabled={busy} onClick={() => void run(() => onRemove(record))}>
                    Remove
                  </button>
                  <span className="ib-sp" />
                  <button type="button" className="ib-btn ib-sm ib-ghost" onClick={() => onEditing(null)}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="ib-btn ib-sm ib-pri"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await onEdit(record, editing.text);
                        onEditing(null);
                      })
                    }
                  >
                    Save
                  </button>
                </div>
              </>
            ) : (
              annotation.text && <p className="ib-ac">{annotation.text}</p>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * "N comments" inside the reply box (record 2.6 to 2.8): a click opens the list.
 * With none, the chip dims to "No comments". `list` and `onList`, `editing` and
 * `onEditing`: a host that opens the list from elsewhere too holds them; without
 * them the chip does.
 */
export function AnnotationsChip({
  list: held = null,
  onList: hold,
  editing: heldEdit = null,
  onEditing: holdEdit,
  ...props
}: Omit<AnnotationsListProps, 'editing' | 'onEditing'> &
  Partial<Pick<AnnotationsListProps, 'editing' | 'onEditing'>> & { list?: CommentsListAt | null; onList?: (next: CommentsListAt | null) => void }) {
  const [own, setOwn] = useState<CommentsListAt | null>(null);
  const [ownEdit, setOwnEdit] = useState<CommentEdit | null>(null);
  const list = hold ? held : own;
  const onList = hold ?? setOwn;
  const chipRef = useRef<HTMLButtonElement>(null);
  const count = props.records.length;
  return (
    <div className="ib-annchip">
      <button
        ref={chipRef}
        type="button"
        className={`ib-rchip ib-ann${list ? ' ib-on' : ''}${count === 0 ? ' ib-none' : ''}`}
        data-annotations-chip=""
        data-comments-link=""
        aria-expanded={list !== null}
        aria-haspopup="dialog"
        disabled={count === 0}
        onClick={() => onList(list ? null : { at: null })}
      >
        <Icon name="comment" size={13} />
        {count > 0 ? plural(count, 'comment') : 'No comments'}
      </button>
      {list && (
        <AnnotationsList
          {...props}
          editing={holdEdit ? heldEdit : ownEdit}
          onEditing={holdEdit ?? setOwnEdit}
          at={list.at}
          press={list.press}
          fit
          onClose={(back) => {
            onList(null);
            if (!back) return;
            // With no comment left the chip is disabled and cannot take focus.
            const chip = chipRef.current;
            focusNoScroll(chip?.disabled ? chip.closest('.ib-rbox')?.querySelector('textarea') : chip);
          }}
        />
      )}
    </div>
  );
}
