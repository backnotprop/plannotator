/**
 * What goes with this Send, said in one quiet line: "4 questions open · 3 comments ⌃" (approval
 * "inbox-reply-foot-phone", variant B "Summary", 2026-11-02). Where the line is too narrow for that (a 320 px phone, a
 * larger text size), "4 open · 3 comments ⌃".
 *
 * - A press on the line opens a small sheet: the questions with "Skip them" (or "Keep open" once skipped), the
 *   picks on a replaced question that won't be sent, and the comments with "Review", which opens their list.
 * - With comments only, the line opens the comments list itself: one press.
 * - Every action is two presses away at most, every target at least 44 px.
 *
 * Where it sits (approval "inbox-reply-box", T6): on a phone, on its own line over the box's row; on a computer, in
 * the row's middle cell in place of the chips when they don't fit (inbox.css, a container query). The answers chip
 * ("2 picks") is not drawn here: the answers list in the box says the same.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { plural, formatCount } from '../format';
import { Icon } from '../icons';
import { useInboxTextSize } from '../textSize';
import { AnnotationsList, type AnnotationsListProps, type CommentsListAt } from './AnnotationsChip';

export interface FootSkip {
  /** The unanswered questions (kept open) or the ones this Send skips. 0: none unanswered. */
  count: number;
  keepOpen: boolean;
  onToggle: () => void;
}

export interface FootComments {
  props: AnnotationsListProps;
  list: CommentsListAt | null;
  onList: (next: CommentsListAt | null) => void;
}

const skipWords = (skip: FootSkip) =>
  skip.keepOpen ? `${plural(skip.count, 'question')} ${skip.count === 1 ? 'stays' : 'stay'} open` : `${plural(skip.count, 'question')} will be skipped`;

const droppedWords = (dropped: number) => `${dropped} ${dropped === 1 ? 'pick' : 'picks'} on a replaced question won’t be sent`;

/** A small bottom sheet: the scrim, Escape and × close it. Focus goes in, and back to `back` when it closes. */
function FootSheet({ title, onClose, back, children }: { title: string; onClose: () => void; back: () => HTMLElement | null; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const backRef = useRef(back);
  backRef.current = back;
  useEffect(() => {
    panel.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      closeRef.current();
      backRef.current()?.focus({ preventScroll: true });
    };
    // Focus leaving for anything outside (Tab past the last button, a press elsewhere) closes it, as the comments list does.
    const onFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !panel.current?.contains(event.target)) closeRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('focusin', onFocus);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('focusin', onFocus);
    };
  }, []);
  const closeBack = () => {
    onClose();
    back()?.focus({ preventScroll: true });
  };
  return (
    <div className="ib-fsheet-layer" data-foot-sheet="">
      <div
        className="ib-fsheet-scrim"
        aria-hidden="true"
        // The press must not reach the page under the scrim (the reply box would take focus and raise the keyboard).
        onPointerDown={(event) => event.preventDefault()}
        // Closed on the click, not the press: gone at the press, the tap's click would land on what is under the
        // finger (a question's option, a link, Back).
        onClick={closeBack}
      />
      <div className="ib-fsheet" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={panel}>
        <div className="ib-fsheet-h">
          <b id={titleId}>{title}</b>
          <button type="button" className="ib-fsheet-x" aria-label="Close" onClick={closeBack}>
            <Icon name="x" size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/**
 * Stays mounted while the box is open, drawing nothing when nothing goes with the Send: when the questions go while
 * its sheet has focus, it puts focus on the box's paperclip.
 */
export function ReplySummary({ skip, dropped, comments }: { skip: FootSkip; dropped: number; comments: FootComments | null }) {
  const [sheetOpen, setSheet] = useState(false);
  const rowRef = useRef<HTMLSpanElement>(null);
  const lineRef = useRef<HTMLButtonElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const descId = useId();
  const count = comments?.props.records.length ?? 0;
  const commentsOpen = !!comments?.list && !comments.list.card;
  const questions = skip.count > 0 || dropped > 0;
  // With comments only, the line is the comments' own way in: one press to the list.
  const direct = !questions;
  // The sheet is for the questions. When they go while it is open (answered in another window, withdrawn), it closes
  // for good: a later question must not open it again by itself (it would take focus from the field mid-sentence).
  const [refocus, setRefocus] = useState(false);
  if (sheetOpen && direct) {
    setSheet(false);
    setRefocus(true);
  }
  const sheet = sheetOpen && !direct;
  // Focus was in the sheet that went: back on the line, or with no line left, the box's paperclip (not the field,
  // which would raise a phone's keyboard nobody asked for).
  useLayoutEffect(() => {
    if (!refocus) return;
    setRefocus(false);
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    (lineRef.current ?? rowRef.current?.closest('.ib-rbox')?.querySelector<HTMLElement>('input[type="file"]'))?.focus({ preventScroll: true });
  }, [refocus]);

  // Short of room, "4 open" for "4 questions open": tried long first, again on every change of the words, the row's
  // width, the Inbox text size, or the fonts (a web font that lands after the first measure).
  const textSize = useInboxTextSize();
  const [rowWidth, setRowWidth] = useState(0);
  const [fonts, setFonts] = useState(0);
  const [short, setShort] = useState(false);
  const fitKey = `${skip.count}|${skip.keepOpen}|${count}|${dropped}|${textSize}|${rowWidth}|${fonts}`;
  const [fittedFor, setFittedFor] = useState(fitKey);
  if (fittedFor !== fitKey) {
    setFittedFor(fitKey);
    setShort(false);
  }
  useLayoutEffect(() => {
    const text = textRef.current;
    if (!short && text && text.scrollWidth > text.clientWidth + 1) setShort(true);
  }, [fitKey, short]);
  useEffect(() => {
    const row = rowRef.current;
    if (!row || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setRowWidth(row.clientWidth));
    observer.observe(row);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let live = true;
    document.fonts?.ready.then(() => live && setFonts((n) => n + 1));
    return () => {
      live = false;
    };
  }, []);

  const parts: ReactNode[] = [];
  if (skip.count > 0)
    parts.push(
      <span key="q">
        {formatCount(skip.count)}
        {!short && ` question${skip.count === 1 ? '' : 's'}`}
        {skip.keepOpen ? ' open' : ' to skip'}
      </span>,
    );
  if (count > 0) parts.push(<span key="c">{plural(count, 'comment')}</span>);
  if (dropped > 0 && skip.count === 0) parts.push(<span key="d">{dropped} not sent</span>);
  const shown = parts.length > 0 || commentsOpen;
  // The line's name is its own words ("4 open · 3 comments": what a voice-control user says); the full sentence is its
  // description.
  const longWords = [skip.count > 0 ? skipWords(skip) : null, count > 0 ? plural(count, 'comment') : null, dropped > 0 ? droppedWords(dropped) : null]
    .filter(Boolean)
    .join(', ');
  return (
    <span className="ib-rsum" data-reply-summary="" ref={rowRef}>
      {shown && (
        <span className="ib-annchip ib-fsum-w">
          <button
            ref={lineRef}
            type="button"
            className={`ib-fsum${sheet || commentsOpen ? ' ib-on' : ''}${skip.keepOpen ? '' : ' ib-skipping'}`}
            data-foot-summary={direct ? 'comments' : 'sheet'}
            // A press on it while the list is open is the line's own (it closes the list), not a press outside.
            {...(direct ? { 'data-comments-link': '' } : {})}
            aria-describedby={descId}
            aria-haspopup="dialog"
            aria-expanded={sheet || commentsOpen}
            onClick={() => (direct ? comments?.onList(commentsOpen ? null : { at: null }) : setSheet((open) => !open))}
          >
            {!skip.keepOpen && <Icon name="forward" size={14} />}
            <span className="ib-fsum-t" ref={textRef} data-foot-summary-text="">
              {parts.map((part, index) => (index === 0 ? part : [' · ', part]))}
            </span>
            <Icon name="chevU" size={14} />
          </button>
          <span id={descId} hidden>
            {longWords}
          </span>
          {comments && commentsOpen && (
            <AnnotationsList
              {...comments.props}
              at={comments.list!.at}
              press={comments.list!.press}
              // On a computer the line sits in the row's middle cell (approval "inbox-reply-box", D4), often right of
              // the middle: kept in the window as the chip's list is. A phone's sheet is fixed, so nothing moves there.
              fit
              onClose={(back) => {
                comments.onList(null);
                if (!back) return;
                // The last comment removed (and no question): the line goes with the list, so focus goes to the
                // box's field, as the desktop chip does.
                const line = lineRef.current;
                const target = count === 0 && !questions ? line?.closest('.ib-rbox')?.querySelector('textarea') : line;
                target?.focus({ preventScroll: true });
              }}
            />
          )}
        </span>
      )}
      {sheet && (
        <FootSheet title="Goes with this reply" onClose={() => setSheet(false)} back={() => lineRef.current}>
          {skip.count > 0 && (
            <div className="ib-fsheet-row" data-foot-sheet-row="questions">
              <span className="ib-fsheet-t">
                <Icon name={skip.keepOpen ? 'question' : 'forward'} size={16} />
                <span>
                  <b>{skipWords(skip)}</b>
                  <span className="ib-fsheet-sub">{skip.keepOpen ? 'You can still answer them after you send.' : 'They are skipped when you send.'}</span>
                </span>
              </span>
              <button type="button" className="ib-btn" data-skip-toggle="" onClick={skip.onToggle}>
                {skip.keepOpen ? `Skip ${skip.count === 1 ? 'it' : 'them'}` : 'Keep open'}
              </button>
            </div>
          )}
          {dropped > 0 && (
            <div className="ib-fsheet-row ib-fsheet-quiet" data-foot-sheet-row="dropped">
              <span className="ib-fsheet-t">
                <Icon name="warn" size={16} />
                <span>{droppedWords(dropped)}.</span>
              </span>
            </div>
          )}
          {comments && count > 0 && (
            <div className="ib-fsheet-row" data-foot-sheet-row="comments">
              <span className="ib-fsheet-t">
                <Icon name="comment" size={16} />
                <b>{plural(count, 'comment')}</b>
              </span>
              <button
                type="button"
                className="ib-btn"
                aria-label="Review comments"
                onClick={() => {
                  setSheet(false);
                  comments.onList({ at: null });
                }}
              >
                Review
              </button>
            </div>
          )}
        </FootSheet>
      )}
    </span>
  );
}
