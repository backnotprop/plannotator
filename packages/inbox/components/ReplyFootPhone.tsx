/**
 * The reply box's foot on a phone (approval "inbox-reply-foot-phone", variant B "Summary", 2026-11-02): one row,
 * the paperclip at the left, the mic at the right, and between them one quiet line naming only what goes with this
 * Send: "4 questions open · 3 comments ⌃". Where the row is too narrow for that (a 320 px phone, a larger text
 * size), "4 open · 3 comments ⌃".
 *
 * - A press on the line opens a small sheet: the questions with "Skip them" (or "Keep open" once skipped), the
 *   picks on a replaced question that won't be sent, and the comments with "Review", which opens their list.
 * - With comments only, the line opens the comments list itself: one press.
 * - Every action is two presses away at most, every target at least 44 px.
 *
 * The desktop box keeps its chips (Thread.tsx). The answers chip ("2 picks") is not drawn here: the answers list
 * just above the foot says the same.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { plural, formatCount } from '../format';
import { Icon } from '../icons';
import type { VoiceHandle } from '../voice';
import { AnnotationsList, type AnnotationsListProps, type CommentsListAt } from './AnnotationsChip';
import { VoiceFoot } from './VoiceMic';

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
        onPointerDown={(event) => {
          // The press must not reach the page under the scrim (the reply box would take focus and raise the keyboard).
          event.preventDefault();
          closeBack();
        }}
      />
      <div className="ib-fsheet" role="dialog" aria-labelledby={titleId} tabIndex={-1} ref={panel}>
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

export function ReplyFootPhone({ clip, skip, dropped, comments, voice }: { clip: ReactNode; skip: FootSkip; dropped: number; comments: FootComments | null; voice: VoiceHandle }) {
  const [sheet, setSheet] = useState(false);
  const lineRef = useRef<HTMLButtonElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const count = comments?.props.records.length ?? 0;
  const commentsOpen = !!comments?.list && !comments.list.card;
  const questions = skip.count > 0 || dropped > 0;
  // Short of room, "4 open" for "4 questions open": tried long first, on every change of the words or the row's width.
  const [short, setShort] = useState(false);
  const words = `${skip.count}|${skip.keepOpen}|${count}|${dropped}`;
  const [fittedFor, setFittedFor] = useState(words);
  if (fittedFor !== words) {
    setFittedFor(words);
    setShort(false);
  }
  useLayoutEffect(() => {
    const text = textRef.current;
    if (!short && text && text.scrollWidth > text.clientWidth + 1) setShort(true);
  });
  useEffect(() => {
    const row = lineRef.current?.closest('.ib-rfoot');
    if (!row || typeof ResizeObserver === 'undefined') return;
    let width = row.clientWidth;
    const observer = new ResizeObserver(() => {
      if (row.clientWidth === width) return;
      width = row.clientWidth;
      setShort(false);
    });
    observer.observe(row);
    return () => observer.disconnect();
  }, [questions || count > 0]);

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
  // With comments only, the line is the comments' own way in: one press to the list.
  const direct = !questions;
  const name = [skip.count > 0 ? skipWords(skip) : null, count > 0 ? plural(count, 'comment') : null, dropped > 0 ? droppedWords(dropped) : null].filter(Boolean).join(', ');
  return (
    <div className="ib-rfoot ib-rfoot-phone" data-reply-foot-phone="">
      {clip}
      {shown && (
        <span className="ib-annchip ib-fsum-w">
          <button
            ref={lineRef}
            type="button"
            className={`ib-fsum${sheet || commentsOpen ? ' ib-on' : ''}${skip.keepOpen ? '' : ' ib-skipping'}`}
            data-foot-summary={direct ? 'comments' : 'sheet'}
            // A press on it while the list is open is the line's own (it closes the list), not a press outside.
            {...(direct ? { 'data-comments-link': '' } : {})}
            aria-label={name}
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
          {comments && commentsOpen && (
            <AnnotationsList
              {...comments.props}
              at={comments.list!.at}
              press={comments.list!.press}
              onClose={(back) => {
                comments.onList(null);
                if (back) lineRef.current?.focus({ preventScroll: true });
              }}
            />
          )}
        </span>
      )}
      {sheet && !direct && (
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
      <VoiceFoot voice={voice} phone />
    </div>
  );
}
