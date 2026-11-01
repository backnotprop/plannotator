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
  /** Opened from the full-screen card, which draws it. Not "in full screen": a Markdown file there has no card. */
  card?: boolean;
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
}

/** What opens the list, and marks a press on it as not a click outside: a press there toggles the list itself. */
const OPENS_THE_LIST = '[data-comments-link], .ib-body [data-bind-id], .ib-body [data-highlight-id]';

/**
 * The list of the comments going with the next Send, each with its file, quote
 * and comment; a comment edits in place, Remove deletes it, the file name opens
 * the file at that place. Mounted only while open. Three ways in: the reply
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
  at,
  onClose,
  fit = false,
}: AnnotationsListProps & {
  at: string | null;
  onClose: (back: boolean) => void;
  /** Keep it in the window by moving it from where it opened (the reply box's chip); elsewhere the CSS places it. */
  fit?: boolean;
}) {
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const enterSavesComment = useConfigValue('enterSavesComment');
  const popRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // A dialog takes focus as it opens, without scrolling anything behind it.
  useEffect(() => popRef.current?.focus({ preventScroll: true }), []);

  // Opened from a highlight: that comment, in the list's own scroll (scrollIntoView would move what is behind it too).
  useLayoutEffect(() => {
    const pop = popRef.current;
    const row = at ? pop?.querySelector<HTMLElement>(`[data-annotation-row="${CSS.escape(at)}"]`) : null;
    if (pop && row) pop.scrollTop = row.offsetTop - Math.max(0, (pop.clientHeight - row.offsetHeight) / 2);
  }, [at]);

  // Read at the key press, not from the render that bound the listener: an Escape that lands right after a
  // Save (before the effect re-binds) must close the list, not "close" an edit that already ended.
  const editingRef = useRef(editing);
  editingRef.current = editing;
  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      const target = event.target as Element;
      if (popRef.current?.contains(target) || target.closest?.(OPENS_THE_LIST)) return;
      closeRef.current(false);
    };
    const onBlur = () => {
      if (document.activeElement instanceof HTMLIFrameElement) closeRef.current(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      if (editingRef.current) {
        editingRef.current = null;
        setEditing(null);
      } else closeRef.current(true);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('blur', onBlur);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('keydown', onKey, true);
    };
  }, []);

  useEffect(() => {
    if (records.length === 0) closeRef.current(true);
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
      if (!document.activeElement || document.activeElement === document.body) popRef.current?.focus({ preventScroll: true });
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
                  <button type="button" className="ib-aa" onClick={() => setEditing({ id: record.id, text: annotation.text ?? '' })}>
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
                  onChange={(event) => setEditing({ id: record.id, text: event.target.value })}
                  onKeyDown={(event) => {
                    if (isCommentSubmitKey(event, enterSavesComment)) {
                      event.preventDefault();
                      void run(async () => {
                        await onEdit(record, editing.text);
                        setEditing(null);
                      });
                    }
                  }}
                />
                <div className="ib-abt">
                  <button type="button" className="ib-del-l" disabled={busy} onClick={() => void run(() => onRemove(record))}>
                    Remove
                  </button>
                  <span className="ib-sp" />
                  <button type="button" className="ib-btn ib-sm ib-ghost" onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="ib-btn ib-sm ib-pri"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await onEdit(record, editing.text);
                        setEditing(null);
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
 * With none, the chip dims to "No comments". `list` and `onList`: a host that
 * opens the list from elsewhere too holds it; without them the chip does.
 */
export function AnnotationsChip({ list: held = null, onList: hold, ...props }: AnnotationsListProps & { list?: CommentsListAt | null; onList?: (next: CommentsListAt | null) => void }) {
  const [own, setOwn] = useState<CommentsListAt | null>(null);
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
          at={list.at}
          fit
          onClose={(back) => {
            onList(null);
            if (back) chipRef.current?.focus({ preventScroll: true });
          }}
        />
      )}
    </div>
  );
}
