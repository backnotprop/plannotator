/**
 * Show me's floating parts over the review:
 *
 * - the box (bottom right, the size of Ask's): what the board is of, the
 *   person's optional words and Show me; then "Claude Code is drawing it." and
 *   Stop while the agent draws;
 * - the corner card: a click on a part of the board lands on its line and the
 *   board shrinks to it (a link on the board too, with no part named); a click
 *   on the card grows it back.
 *
 * Each wears `data-popover-layer` and `data-chat-window`, like Ask's window,
 * so the Inbox's keys (Mod+Enter, the Escape ladder) never act from inside
 * them. No new keys.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { inboxReviewLines } from '@plannotator/core/inbox-review';
import type { ShapeDrawnView } from '@plannotator/core/shape';
import { Pebble } from '@plannotator/ui/components/shape/Pebble';
import { ShapeDiagram, type MarkState } from '@plannotator/ui/components/shape/ShapeDrawn';
import { SessionAskActions, type SessionAskAction } from '@plannotator/ui/components/ai/SessionAskNotice';
import { Icon } from '../icons';
import { Tip } from '../components/Tip';
import { baseName } from './showMeModel';
import type { ShowMePlace, ShowMeState } from './useShowMe';

const LAYER = { 'data-popover-layer': '', 'data-chat-window': '' } as const;
const EMPTY = new Set<string>();
/** The width the corner card draws a picture at before it scales it down: about the board's. */
const CORNER_DRAWN_WIDTH = 960;

const linesWord = (lines: readonly [number, number]) => `${lines[0] === lines[1] ? 'line' : 'lines'} ${inboxReviewLines(lines)}`;

function Place({ place }: { place: ShowMePlace }) {
  return (
    <div className="ib-sm-at" data-show-me-place="">
      {place.file ? (
        <>
          {baseName(place.file)}
          {place.lines && ` · ${linesWord(place.lines)}`}
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

export function ShowMeCorner({
  shape,
  title,
  picture,
  part,
  resolveSrc,
  onGrow,
  onClose,
  onAgain,
}: {
  shape: string;
  title: string;
  /** The board's Picture, drawn small. */
  picture: ShapeDrawnView | null;
  /** `lines` null: the code this part was drawn from changed, and the review shows its file. Null: no part (a link). */
  part: { name: string; mark: string | null; file: string; lines: [number, number] | null } | null;
  /** Where the board's own pictures (its `files/`) are served from. */
  resolveSrc: (src: string) => string;
  onGrow: () => void;
  onClose: () => void;
  /** Show me again, when the agent can take one. */
  onAgain?: () => void;
}) {
  const marks: MarkState = { fresh: EMPTY, erasing: EMPTY, noted: part?.mark ? new Set([part.mark]) : EMPTY };
  // The whole picture, small: drawn at about the board's width, then scaled to fit the card.
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
  }, [shape]);
  return (
    <section className="ib-sm-pip" aria-label={`Shape: ${title}`} data-show-me-corner={shape} {...LAYER}>
      <div className="ib-sm-pip-h">
        <Pebble alive={false} size={14} className="ib-sm-peb" />
        <b>{title}</b>
        <span className="ib-sp" />
        <Tip content="Grow">
          <button type="button" className="ib-iconbtn ib-sm" onClick={onGrow} aria-label="Grow the board">
            <Icon name="expand" size={15} />
          </button>
        </Tip>
        <Tip content="Close">
          <button type="button" className="ib-iconbtn ib-sm" onClick={onClose} aria-label="Close the board">
            <Icon name="x" size={15} />
          </button>
        </Tip>
      </div>
      {/* The picture itself grows it too (the Grow button is the keyboard's way). */}
      <div className="ib-sm-pip-b" ref={box} onClick={onGrow} aria-hidden="true" data-show-me-grow="">
        {picture && (
          <div className="ib-sm-pip-in" ref={inner} style={{ width: CORNER_DRAWN_WIDTH, transform: `scale(${scale})` }}>
            <ShapeDiagram drawn={picture} animate={false} marks={marks} resolveSrc={resolveSrc} />
          </div>
        )}
      </div>
      {part && (
        <div className="ib-sm-pip-f">
          <b>{part.name}</b> <span>· {baseName(part.file)}{part.lines ? ` ${linesWord(part.lines)}` : ''}</span>
          {!part.lines && (
            <div className="ib-sm-pip-n" data-show-me-changed="">
              This code changed after the picture was drawn.
              {onAgain && (
                <button type="button" className="ib-btn" onClick={onAgain} data-show-me-again="">
                  Show me again
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
