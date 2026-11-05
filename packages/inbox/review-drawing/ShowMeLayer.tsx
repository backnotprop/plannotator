/**
 * Show me's three floating parts over the review (mock ac2):
 *
 * - the box (bottom right, the size of Ask's): what the picture is of, the
 *   person's optional words and Show me; then "Claude Code is drawing it." and
 *   Stop while the agent draws;
 * - the sheet: the picture over the diff (Shape's `ShapeDiagram`), and the
 *   agent's short answer under it;
 * - the corner card: a click on a part opens its code and the sheet shrinks
 *   to it; a click on the card grows it back.
 *
 * Each wears `data-popover-layer` and `data-chat-window`, like Ask's window,
 * so the Inbox's keys (Mod+Enter, the Escape ladder) never act from inside
 * them. No new keys.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { inboxReviewLines, type InboxReviewDrawing } from '@plannotator/core/inbox-review';
import type { ShapeCodeTarget } from '@plannotator/core/shape';
import { Pebble } from '@plannotator/ui/components/shape/Pebble';
import { ShapeDiagram, type MarkState } from '@plannotator/ui/components/shape/ShapeDrawn';
import { HostMark } from '@plannotator/ui/components/inbox-thread/icons';
import { SessionAskActions, type SessionAskAction } from '@plannotator/ui/components/ai/SessionAskNotice';
import { Icon } from '../icons';
import { Tip } from '../components/Tip';
import { baseName, showMePlace } from './showMeModel';
import { SHEET_HOME, useSheetDrag, type SheetOffset } from './useSheetDrag';
import type { ShowMePlace, ShowMeState } from './useShowMe';

const LAYER = { 'data-popover-layer': '', 'data-chat-window': '' } as const;
const EMPTY = new Set<string>();
/** The width the corner card draws a picture at before it scales it down: about the sheet's. */
const CORNER_DRAWN_WIDTH = 960;

function Place({ place }: { place: ShowMePlace }) {
  return (
    <div className="ib-sm-at" data-show-me-place="">
      {place.file ? (
        <>
          {baseName(place.file)}
          {place.lines && ` · lines ${inboxReviewLines(place.lines)}`}
        </>
      ) : (
        'The whole review'
      )}
    </div>
  );
}

export function ShowMeBox({
  state,
  agent,
  onWords,
  onSend,
  onBusy,
  onStop,
  onClose,
}: {
  state: ShowMeState;
  agent: string;
  onWords: (words: string) => void;
  onSend: () => void;
  /** The agent was busy: ask when it finishes, or interrupt it. */
  onBusy?: (policy: SessionAskAction) => void;
  onStop: () => void;
  onClose: () => void;
}) {
  const box = state.box;
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (box && !box.turn) field.current?.focus({ preventScroll: true });
  }, [box?.place.file, box?.place.lines?.[0], box?.place.lines?.[1]]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!box) return null;
  return (
    <section className="ib-sm-box" aria-label="Show me" data-show-me-box={box.turn ? (state.drawing ? 'drawing' : state.busy ? 'busy' : 'done') : 'compose'} {...LAYER}>
      <div className="ib-sm-h">
        <Pebble alive={false} size={18} className="ib-sm-peb" />
        <b>Show me</b>
        <span className="ib-sm-by">· {agent} draws it</span>
        <span className="ib-sp" />
        <Tip content="Close">
          <button type="button" className="ib-iconbtn ib-sm-x" onClick={onClose} aria-label="Close Show me">
            <Icon name="x" />
          </button>
        </Tip>
      </div>
      <div className="ib-sm-b">
        <Place place={box.place} />
        {!box.turn ? (
          <>
            <textarea
              ref={field}
              className="ib-sm-field"
              value={box.words}
              onChange={(event) => onWords(event.target.value)}
              aria-label="What the picture should show"
              rows={3}
              maxLength={600}
            />
            <div className="ib-sm-fine">Optional: what the picture should show.</div>
            <div className="ib-sm-acts">
              <button type="button" className="ib-btn ib-pri ib-sm-send" onClick={onSend} disabled={state.posting} data-show-me-send="">
                <Pebble alive={false} size={15} className="ib-sm-peb" />
                Show me
              </button>
            </div>
          </>
        ) : (
          <>
            {box.words.trim() && <div className="ib-sm-words">{box.words.trim()}</div>}
            {state.drawing ? (
              <>
                <div className="ib-sm-line" role="status">
                  <Pebble alive reshaping size={20} className="ib-sm-peb" />
                  <span>
                    {state.waiting === 'waiting' ? (
                      `Waiting for ${agent} to finish…`
                    ) : state.waiting === 'interrupting' ? (
                      `Interrupting ${agent}…`
                    ) : (
                      <>
                        <b>{agent} is drawing it.</b> It opens over the review when it’s ready.
                      </>
                    )}
                  </span>
                </div>
                <div>
                  <button type="button" className="ib-btn ib-sm-quiet" onClick={onStop} data-show-me-stop="">
                    Stop
                  </button>
                </div>
              </>
            ) : state.busy ? (
              <div className="ib-ask-note" data-ask-note="busy">
                <p>{agent} is working on something else.</p>
                <SessionAskActions response={state.busy} onAction={onBusy} />
              </div>
            ) : state.answerOnly ? (
              <p className="ib-sm-answer" data-show-me-answer="">
                {state.answerOnly}
              </p>
            ) : null}
          </>
        )}
        {state.problem && (
          <p className="ib-sm-problem" role="alert">
            {state.problem}
          </p>
        )}
      </div>
    </section>
  );
}

/** The sheet's second line: "Claude Code · Show me on retry-worker.ts lines 16–18 · round 1". */
export function showMeSubtitle(agent: string, drawing: InboxReviewDrawing): string {
  return `${agent} · Show me on ${showMePlace(drawing.file, drawing.lines)} · round ${drawing.round}`;
}

export function ShowMeSheet({
  drawing,
  answer,
  agent,
  host,
  asked,
  onAgain,
  offset = SHEET_HOME,
  onOffset,
  onCode,
  onShrink,
  onClose,
}: {
  drawing: InboxReviewDrawing;
  answer: string;
  agent: string;
  host: string | null;
  /** A picture of an earlier round, as asked: the parts whose lines changed since, and Show me again. */
  asked?: { stale: ReadonlySet<string>; onAgain: () => void } | null;
  /** This round's picture: Show me again, the same lines asked anew (other words). */
  onAgain?: () => void;
  /** Where it was dragged to (useSheetDrag), kept by the host. Absent `onOffset`: it does not move (a phone's sheet). */
  offset?: SheetOffset;
  onOffset?: (offset: SheetOffset) => void;
  onCode: (target: ShapeCodeTarget, el: HTMLElement) => void;
  onShrink: () => void;
  onClose: () => void;
}) {
  const drag = useSheetDrag({ offset, onOffset: onOffset ?? (() => {}), enabled: !!onOffset });
  return (
    <section
      ref={drag.ref}
      className="ib-sm-sheet"
      style={drag.style}
      aria-label={`Show me: ${drawing.title ?? 'the picture'}`}
      data-show-me-sheet={drawing.id}
      data-moved={drag.style ? '' : undefined}
      {...LAYER}
    >
      <div className="ib-sm-sheet-h" {...drag.headerProps} title={onOffset ? 'Drag to move · double-click to put it back' : undefined}>
        <Pebble alive={false} size={20} className="ib-sm-peb" />
        <div className="ib-sm-tx">
          <b>{drawing.title ?? 'Show me'}</b>
          <span>{showMeSubtitle(agent, drawing)}</span>
        </div>
        <Tip content="Shrink">
          <button type="button" className="ib-iconbtn" onClick={onShrink} aria-label="Shrink the picture">
            <Icon name="collapse" />
          </button>
        </Tip>
        <Tip content="Close">
          <button type="button" className="ib-iconbtn" onClick={onClose} aria-label="Close the picture">
            <Icon name="x" />
          </button>
        </Tip>
      </div>
      <div className="ib-sm-sheet-b">
        {asked && (
          <div className="ib-sm-banner" data-show-me-asked={drawing.round}>
            <div className="ib-sm-tx">
              <b>As asked in round {drawing.round}.</b> Its parts still open the right lines
              {asked.stale.size > 0 ? `; ${asked.stale.size} of them changed since.` : '.'}
            </div>
            <button type="button" className="ib-btn" onClick={asked.onAgain} data-show-me-again="">
              <Pebble alive={false} size={14} className="ib-sm-peb" />
              Show me again
            </button>
          </div>
        )}
        <ShapeDiagram drawn={drawing.view} onCode={onCode} {...(asked?.stale.size ? { stale: asked.stale, tags: { stale: 'changed since asked' } } : {})} />
      </div>
      {(answer.trim() || (onAgain && !asked)) && (
        <div className="ib-sm-sheet-f" data-show-me-answer={answer.trim() ? '' : undefined}>
          {answer.trim() && (
            <>
              <span className="ib-sm-mark">
                <HostMark host={host} />
              </span>
              <div className="ib-sm-tx">{answer.trim()}</div>
            </>
          )}
          {onAgain && !asked && (
            <button type="button" className="ib-btn ib-sm-again" onClick={onAgain} data-show-me-again="">
              <Pebble alive={false} size={14} className="ib-sm-peb" />
              Show me again
            </button>
          )}
        </div>
      )}
    </section>
  );
}

export function ShowMeCorner({
  drawing,
  part,
  onGrow,
  onClose,
}: {
  drawing: InboxReviewDrawing;
  part: { name: string; mark: string | null; file: string; lines: [number, number] } | null;
  onGrow: () => void;
  onClose: () => void;
}) {
  const marks: MarkState = { fresh: EMPTY, erasing: EMPTY, noted: part?.mark ? new Set([part.mark]) : EMPTY };
  // The whole picture, small: drawn at the sheet's width, then scaled to fit the card.
  const box = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.3);
  useLayoutEffect(() => {
    const fit = () => {
      const outer = box.current;
      const drawn = inner.current;
      if (!outer || !drawn) return;
      const w = outer.clientWidth - 16;
      const h = outer.clientHeight - 12;
      const next = Math.min(w / CORNER_DRAWN_WIDTH, drawn.scrollHeight > 0 ? h / drawn.scrollHeight : 1);
      if (next > 0 && Number.isFinite(next)) setScale(next);
    };
    fit();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(fit);
    if (inner.current) observer.observe(inner.current);
    if (box.current) observer.observe(box.current);
    return () => observer.disconnect();
  }, [drawing.id]);
  return (
    <section className="ib-sm-pip" aria-label={`Show me: ${drawing.title ?? 'the picture'}`} data-show-me-corner={drawing.id} {...LAYER}>
      <div className="ib-sm-pip-h">
        <Pebble alive={false} size={14} className="ib-sm-peb" />
        <b>{drawing.title ?? 'Show me'}</b>
        <span className="ib-sp" />
        <Tip content="Grow">
          <button type="button" className="ib-iconbtn ib-sm" onClick={onGrow} aria-label="Grow the picture">
            <Icon name="expand" size={15} />
          </button>
        </Tip>
        <Tip content="Close">
          <button type="button" className="ib-iconbtn ib-sm" onClick={onClose} aria-label="Close the picture">
            <Icon name="x" size={15} />
          </button>
        </Tip>
      </div>
      {/* The picture itself grows it too (the Grow button is the keyboard's way). */}
      <div className="ib-sm-pip-b" ref={box} onClick={onGrow} aria-hidden="true" data-show-me-grow="">
        <div className="ib-sm-pip-in" ref={inner} style={{ width: CORNER_DRAWN_WIDTH, transform: `scale(${scale})` }}>
          <ShapeDiagram drawn={drawing.view} animate={false} marks={marks} />
        </div>
      </div>
      {part && (
        <div className="ib-sm-pip-f">
          <b>{part.name}</b> <span>· {baseName(part.file)} lines {inboxReviewLines(part.lines)}</span>
        </div>
      )}
    </section>
  );
}
