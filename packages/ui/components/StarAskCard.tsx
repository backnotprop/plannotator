/**
 * The "Star the repo" ask (approval "star-ask", 2026-11-06, `.product/approved/star-ask/`): one humble card, in two
 * shapes. `corner`: a small card in the Inbox's bottom-right corner (packages/inbox). `card`: in place under the done
 * message on the done screen of plan review, code review and annotate (`StarAskDoneScreen`). Nothing here decides who
 * sees it or talks to a server: the host claims it (packages/shared/star-ask.ts) and hands in `onStar` / `onAnswer`.
 * A host that renders neither (the Workspaces app) never shows it.
 *
 * States: the ask; "Starring…" while gh stars it; "Starred. Thank you!" (the star fills #FFC926, the big line reads
 * "starred.", the row "decided · recorded"); "Thank you! GitHub is open in a new tab." after the link; on a failed star,
 * "Couldn't star it from here." with an "Open GitHub" link. The corner sees itself out 4 s after a thank-you; the card
 * waits for Close. Nothing moves: no entrance and no tween, the same under reduced motion. A named region, never a
 * dialog; no keyboard shortcut. Words: utils/starAskWords.ts.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { STAR_ASK_DISPLAY_FONT, STAR_ASK_MONO_FONT } from '../utils/starAskFonts';
import { STAR_ASK_CSS } from '../utils/starAskStyles';
import { STAR_ASK_WORDS, type StarAskWords } from '../utils/starAskWords';

export const STAR_ASK_REPO_URL = 'https://github.com/backnotprop/plannotator';
/** The corner leaves by itself this long after a thank-you. */
export const STAR_ASK_THANKS_LEAVE_MS = 4_000;

export type StarAskShape = 'corner' | 'card';
export type StarAskState = 'ask' | 'starring' | 'starred' | 'opened' | 'failed';

/** The board the art is drawn on (scaled to the card's width), and the measure the big line fills. */
const BOARD_W = 340;
const BOARD_H = 104;
const MEASURE = 316;
/** The big line's size for the approved words, solved once in the harness (Archivo 900 at width 125). */
const SOLVED_SIZE: Record<string, number> = { 'star it?': 68.95, 'starred.': 62.99 };

/** A plain upright five-point star (centre, outer radius; inner radius 0.382 of it). */
function starPoints(cx: number, cy: number, r: number): string {
  const ri = r * 0.382;
  return Array.from({ length: 10 }, (_, i) => {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 ? ri : r;
    return `${(cx + rr * Math.cos(a)).toFixed(2)},${(cy + rr * Math.sin(a)).toFixed(2)}`;
  }).join(' ');
}
/** Centred behind "star it?", its top point through the rule (the approved v3). */
const STAR_POINTS = starPoints(198, 58, 70);

/** The big line, solved to the measure once its face has loaded (one measurement: width scales with the size). */
function BigLine({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [size, setSize] = useState(SOLVED_SIZE[text] ?? 60);
  useEffect(() => {
    let live = true;
    const fit = () => {
      const el = ref.current;
      if (!live || !el) return;
      const width = el.scrollWidth;
      if (width > 0) setSize((current) => (Math.abs(width - MEASURE) > 0.5 ? Number(((current * MEASURE) / width).toFixed(2)) : current));
    };
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
    if (fonts?.load) {
      fonts.load(`900 60px "${STAR_ASK_DISPLAY_FONT}"`).then(fit, fit);
    } else fit();
    return () => {
      live = false;
    };
  }, [text]);
  return (
    <span ref={ref} className="psa-w" style={{ fontSize: `${size}px` }}>
      {text}
    </span>
  );
}

/** The art band: one 340 × 104 board, scaled to the card's width. Decorative (aria-hidden). */
export function StarAskArt({ lit, words = STAR_ASK_WORDS }: { lit: boolean; words?: StarAskWords }) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const width = el.clientWidth;
      if (width > 0) setScale(width / BOARD_W);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // The mono face is tiny; ask for it with the display face so neither paints late.
  useEffect(() => {
    void document.fonts?.load?.(`500 9px "${STAR_ASK_MONO_FONT}"`).catch(() => undefined);
  }, []);
  return (
    <div ref={box} className={`psa-art${lit ? ' psa-lit' : ''}`} aria-hidden="true" data-star-ask-art={lit ? 'lit' : 'ask'}>
      <div className="psa-board" style={{ transform: `scale(${scale})` }}>
        <svg className="psa-star" viewBox={`0 0 ${BOARD_W} ${BOARD_H}`} focusable="false">
          <polygon points={STAR_POINTS} />
        </svg>
        <div className="psa-grid" />
        <i className="psa-reg psa-r1" />
        <i className="psa-reg psa-r2" />
        <div className="psa-rule" />
        <div className="psa-lab">
          <span>{words.art.label}</span>
          <span className="psa-lab-r">{lit ? words.art.after : words.art.ask}</span>
        </div>
        <div className="psa-big">
          <BigLine key={lit ? 'after' : 'ask'} text={lit ? words.art.bigAfter : words.art.big} />
        </div>
      </div>
    </div>
  );
}

const StarIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z" />
  </svg>
);

export interface StarAskCardProps {
  shape: StarAskShape;
  /** The button stars with gh (the claim's check found it can); false: it is a link to the repository. */
  canStar: boolean;
  /** Star it with gh: resolves true when GitHub took the star. Only ever called from the person's click. */
  onStar: () => Promise<boolean>;
  /** Record how it ended: Not now, or the GitHub page opened from a link. Best effort. */
  onAnswer: (answer: 'not-now' | 'opened') => void;
  /** Take the card away (Not now, Close, or the corner's own leave after a thank-you). */
  onLeave: () => void;
  /** The state it starts in (tests and pictures). */
  initialState?: StarAskState;
  /** The corner's leave after a thank-you (tests). Default `STAR_ASK_THANKS_LEAVE_MS`. */
  leaveAfterMs?: number;
  words?: StarAskWords;
}

export function StarAskCard({ shape, canStar, onStar, onAnswer, onLeave, initialState = 'ask', leaveAfterMs = STAR_ASK_THANKS_LEAVE_MS, words = STAR_ASK_WORDS }: StarAskCardProps) {
  const [state, setState] = useState<StarAskState>(initialState);
  const titleId = useId();
  const root = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const hadFocus = useRef(false);
  const leave = useRef(onLeave);
  leave.current = onLeave;
  const lit = state === 'starred' || state === 'opened';
  const answered = lit || state === 'failed';

  /** A state change that replaces the buttons: keep the keyboard where it was (on Close). */
  const move = useCallback((next: StarAskState) => {
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    hadFocus.current = !!active && !!root.current?.contains(active);
    setState(next);
  }, []);

  useEffect(() => {
    if (!answered || !hadFocus.current) return;
    hadFocus.current = false;
    closeRef.current?.focus();
  }, [answered, state]);

  // The corner sees itself out after a thank-you; the card waits for Close.
  useEffect(() => {
    if (shape !== 'corner' || !lit) return;
    const timer = setTimeout(() => leave.current(), leaveAfterMs);
    return () => clearTimeout(timer);
  }, [shape, lit, leaveAfterMs]);

  const star = () => {
    if (state !== 'ask') return;
    move('starring');
    onStar().then(
      (starred) => move(starred ? 'starred' : 'failed'),
      () => move('failed'),
    );
  };
  const opened = () => {
    onAnswer('opened');
    move('opened');
  };
  const big = shape === 'card';

  return (
    <section ref={root} className={`psa psa-${shape}`} aria-labelledby={titleId} data-star-ask={shape} data-star-ask-state={state}>
      <style>{STAR_ASK_CSS}</style>
      <StarAskArt lit={lit} words={words} />
      <div className="psa-body">
        <h2 className="psa-h" id={titleId}>
          {words.title}
        </h2>
        <p className="psa-p">{words.body}</p>
        {answered ? (
          <div className="psa-acts">
            <p className="psa-done" role="status">
              {lit && <i aria-hidden="true" />}
              {state === 'starred' ? words.starred : state === 'opened' ? words.opened : (
                <>
                  <span>{words.failed}</span>
                  <a href={STAR_ASK_REPO_URL} target="_blank" rel="noopener noreferrer" onClick={opened}>
                    {words.openGitHub}
                  </a>
                </>
              )}
            </p>
            <span className="psa-sp" />
            <button ref={closeRef} type="button" className={`psa-btn psa-ghost${big ? ' psa-lg' : ''}`} onClick={() => onLeave()}>
              {words.close}
            </button>
          </div>
        ) : (
          <div className="psa-acts">
            <button
              type="button"
              className={`psa-btn psa-ghost${big ? ' psa-lg' : ''}`}
              disabled={state === 'starring'}
              onClick={() => {
                onAnswer('not-now');
                onLeave();
              }}
            >
              {words.notNow}
            </button>
            <span className="psa-sp" />
            {canStar ? (
              <button
                type="button"
                className={`psa-btn psa-pri${big ? ' psa-lg' : ''}`}
                aria-busy={state === 'starring' || undefined}
                onClick={star}
              >
                <StarIcon />
                <span>{state === 'starring' ? words.starring : words.star}</span>
              </button>
            ) : (
              // A real link: the browser opens it from the click itself, so no popup blocker applies.
              <a href={STAR_ASK_REPO_URL} target="_blank" rel="noopener noreferrer" className={`psa-btn psa-pri${big ? ' psa-lg' : ''}`} onClick={opened}>
                <StarIcon />
                <span>{words.star}</span>
              </a>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
