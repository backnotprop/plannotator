import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { InboxAnnotationRecord, InboxAttachmentState } from '@plannotator/core/inbox-types';
import { annotationOf, recordQuote, recordTag } from '../attachments';
import { plural } from '../format';
import { Icon } from '../icons';
import { useConfigValue } from '@plannotator/ui/config';
import { isCommentSubmitKey } from '@plannotator/ui/utils/commentSubmitKey';

export interface AnnotationsChipProps {
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

/**
 * "N annotations" inside the reply box (record 2.6 to 2.8): a click opens the
 * list of what rides this reply, each with its file, quote and comment;
 * a comment edits in place, Remove deletes it, the file name opens the file
 * at that place. Escape or a click outside closes it. With none, the chip
 * dims to "No annotations".
 */
export function AnnotationsChip({ records, attachments, onEdit, onRemove, onOpen, messageName, unanchored }: AnnotationsChipProps) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const enterSavesComment = useConfigValue('enterSavesComment');
  const rootRef = useRef<HTMLDivElement>(null);

  // Read at the key press, not from the render that bound the listener: an Escape that lands right after a
  // Save (before the effect re-binds) must close the list, not "close" an edit that already ended.
  const editingRef = useRef(editing);
  editingRef.current = editing;
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      if (editingRef.current) {
        editingRef.current = null;
        setEditing(null);
      } else setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  useEffect(() => {
    if (records.length === 0) setOpen(false);
  }, [records.length]);

  // The list opens from the chip; where that would run past the window's right edge it lines up with the
  // reply box's right edge instead (and never past the window's left edge). A phone draws it as a sheet.
  const popRef = useRef<HTMLDivElement>(null);
  const [shift, setShift] = useState(0);
  useLayoutEffect(() => {
    if (!open) {
      setShift(0);
      return;
    }
    const place = () => {
      const pop = popRef.current;
      const chip = rootRef.current;
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
  }, [open]);

  const name = (record: InboxAnnotationRecord) =>
    record.message
      ? (messageName?.(record) ?? 'Message')
      : record.live
        ? `${record.live.url.replace(/^https?:\/\//, '').replace(/\/$/, '')}${record.live.page_url ?? ''} (live)`
        : record.guide
        ? record.path
        : (attachments.find((a) => a.id === record.attachment_id) ?? attachments.find((a) => a.path === record.path))?.name ?? record.path;

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } finally {
      setBusy(false);
    }
  };

  const count = records.length;
  return (
    <div className="ib-annchip" ref={rootRef}>
      <button
        type="button"
        className={`ib-rchip ib-ann${open ? ' ib-on' : ''}${count === 0 ? ' ib-none' : ''}`}
        data-annotations-chip=""
        aria-expanded={open}
        disabled={count === 0}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="comment" size={13} />
        {count > 0 ? plural(count, 'annotation') : 'No annotations'}
      </button>
      {open && (
        <div
          ref={popRef}
          className="ib-annpop"
          role="dialog"
          aria-label={`${plural(count, 'annotation')} ride this reply`}
          style={shift ? ({ '--ib-annpop-shift': `${shift}px` } as CSSProperties) : undefined}
        >
          <div className="ib-aph">
            <b>{plural(count, 'annotation')}</b>
            <span className="ib-mut">ride this reply</span>
            <span className="ib-sp" />
            <button type="button" className="ib-iconbtn" onClick={() => setOpen(false)} aria-label="Close the list">
              <Icon name="x" />
            </button>
          </div>
          {records.map((record) => {
            const annotation = annotationOf(record);
            const tag = recordTag(record);
            const quote = recordQuote(record);
            const isEditing = editing?.id === record.id;
            return (
              <div className={`ib-arow${isEditing ? ' ib-ed' : ''}`} key={record.id} data-annotation-row={record.id}>
                <div className="ib-a1">
                  <button
                    type="button"
                    className="ib-af"
                    onClick={() => {
                      setOpen(false);
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
      )}
    </div>
  );
}
