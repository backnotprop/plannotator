import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { plural, formatCount } from '../format';
import { Icon } from '../icons';
import { useInboxTextSize } from '../textSize';
import { AnnotationsList, type AnnotationsListProps, type CommentsListAt } from './AnnotationsChip';

export interface FootSkip {
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
        onPointerDown={(event) => event.preventDefault()}
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

export function ReplySummary({ skip, dropped, comments }: { skip: FootSkip; dropped: number; comments: FootComments | null }) {
  const [sheetOpen, setSheet] = useState(false);
  const rowRef = useRef<HTMLSpanElement>(null);
  const lineRef = useRef<HTMLButtonElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const descId = useId();
  const count = comments?.props.records.length ?? 0;
  const commentsOpen = !!comments?.list && !comments.list.card;
  const questions = skip.count > 0 || dropped > 0;
  const direct = !questions;
  const [refocus, setRefocus] = useState(false);
  if (sheetOpen && direct) {
    setSheet(false);
    setRefocus(true);
  }
  const sheet = sheetOpen && !direct;
  useLayoutEffect(() => {
    if (!refocus) return;
    setRefocus(false);
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    (lineRef.current ?? rowRef.current?.closest('.ib-rbox')?.querySelector<HTMLElement>('input[type="file"]'))?.focus({ preventScroll: true });
  }, [refocus]);

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
              fit
              onClose={(back) => {
                comments.onList(null);
                if (!back) return;
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
