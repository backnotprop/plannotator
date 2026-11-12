import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { STAR_ASK_DISPLAY_FONT, STAR_ASK_MONO_FONT } from '../utils/starAskFonts';
import { STAR_ASK_CSS } from '../utils/starAskStyles';
import { STAR_ASK_WORDS, type StarAskWords } from '../utils/starAskWords';

export const STAR_ASK_REPO_URL = 'https://github.com/backnotprop/plannotator';
export const STAR_ASK_THANKS_LEAVE_MS = 4_000;

export type StarAskShape = 'corner' | 'card';
export type StarAskState = 'ask' | 'starring' | 'starred' | 'opened' | 'failed';

const BOARD_W = 340;
const BOARD_H = 104;
const MEASURE = 316;
const SOLVED_SIZE: Record<string, number> = { 'star it?': 68.95, 'starred.': 62.99 };

function starPoints(cx: number, cy: number, r: number): string {
  const ri = r * 0.382;
  return Array.from({ length: 10 }, (_, i) => {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 ? ri : r;
    return `${(cx + rr * Math.cos(a)).toFixed(2)},${(cy + rr * Math.sin(a)).toFixed(2)}`;
  }).join(' ');
}
const STAR_POINTS = starPoints(198, 58, 70);

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
  canStar: boolean;
  onStar: () => Promise<boolean>;
  onAnswer: (answer: 'not-now' | 'opened') => void;
  onLeave: () => void;
  initialState?: StarAskState;
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
