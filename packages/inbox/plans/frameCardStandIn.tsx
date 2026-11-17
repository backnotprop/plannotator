/**
 * TEMPORARY STAND-IN, to be deleted when the frame's own lands. The shared Card, CardRow, CardUpdatesPill and the named
 * motions (arrive, settle; breathe and fan in CSS) are being built in packages/ui/components/frame by the sister team
 * (the Spaces session). This file copies only their agreed prop contract so the Spaces home can be built and tested
 * now; every card visual lives here (its CSS too, below), so the swap is this one file: replace the imports with
 * `@plannotator/ui/components/frame` and delete it. Nothing else in the Inbox may import from here but the Spaces home.
 *
 * Contract (as agreed with the frame's team):
 * - Card({ kind, face, title, href, fact?, factMark?, factTone?, unread?, size, time?, linkComponent?, action?, pinned? }): ONE
 *   link named by the title and the fact, whose hit area covers the whole card; the face is a sibling of the link,
 *   never inside it (inert: hidden from screen readers, never focusable, no pointer); the action is a sibling too
 *   (top right of the well, shown on hover and focus-within, always on touch and while `pinned`); a document's face
 *   is paper with one sheet behind; the face is drawn only near the screen and let go when it is far (a window of
 *   screens around the scroll position), in a fixed-aspect well with a quiet placeholder; the title takes two lines.
 * - CardRow({ kind, title, href, linkComponent?, fact?, factMark?, factTone?, unread?, time?, secondary?, thumb?, face?, action?,
 *   pinned? }): 44 px (52 on a phone), a 36x27 thumbnail of the card's own face on the kind's ground (`thumb`: a
 *   picture's `src`, or the host's small static drawing of the face, never a frame; absent, the kind's shape), one line.
 * - CardUpdatesPill({ count, onShow }): "N updates · Show".
 * - arrive(el): content changed in place, a short fade; never moves. `fc-landed-0`/`fc-landed-1` on the block where a
 *   change landed: a brief tint (1.6 s). settleBatch(container, mutate): FLIP over every card in the container around
 *   the host's reorder (measure, mutate, play 320 ms). breathe: the fact's mark, opacity only, 4.8 s, only while drawn.
 *   Reduced motion: cuts, and nothing breathes or tints.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ComponentType, type CSSProperties, type ReactNode } from 'react';

export type CardKind = 'document' | 'page' | 'image' | 'data';
export type CardFace = ReactNode | { src: string };

export interface CardLinkProps {
  href: string;
  className?: string;
  children: ReactNode;
  'data-card-link'?: string;
  'aria-describedby'?: string;
}

interface CardCommon {
  kind: CardKind;
  title: string;
  href: string;
  /** The link the card is drawn with (the host's router link); absent, an `<a>`. */
  linkComponent?: ComponentType<CardLinkProps>;
  /** The one grey line ("Your move", "<agent> is working", a date). */
  fact?: ReactNode;
  /** Before the fact: an agent's mark (it breathes while drawn). */
  factMark?: ReactNode;
  /** 'action': the fact in the accent colour (the person's move); absent or 'default': grey. */
  factTone?: 'default' | 'action';
  unread?: boolean;
  /** When the fact is a date: the full time, for the title attribute and the spoken name. */
  time?: string;
  /** Top right of the well (a card) or at the row's end: the host's control, never inside the link. */
  action?: ReactNode;
  pinned?: boolean;
}

export interface CardProps extends CardCommon {
  face: CardFace;
  size: 'large' | 'regular';
}

export interface CardRowProps extends CardCommon {
  /** The project, in "Now" only. */
  secondary?: ReactNode;
  thumb?: CardFace;
  face?: CardFace;
}

/** The width a face is laid out at before it is scaled into its well (the sheet's type scale). */
const FACE_WIDTH = 420;

const reducedMotion = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The element's scrolling ancestor (null: the window), where "near the screen" is measured. */
function scrollerOf(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const y = getComputedStyle(p).overflowY;
    if (y === 'auto' || y === 'scroll') return p;
  }
  return null;
}

/** How far ahead a face is drawn, and how far away it is let go (so a small window of faces stays alive). */
const NEAR_MARGIN = '400px';
const FAR_MARGIN = '1600px';

/**
 * Drawn once the element is near the screen (400 px ahead of its scroller's view), and let go again once it is far
 * (1600 px out): a long page or a search keeps only the faces around what is shown. Without IntersectionObserver, at
 * once and for good.
 */
function useNear(): [(el: HTMLElement | null) => void, boolean] {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    const root = scrollerOf(el);
    const toward = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setNear(true), { root, rootMargin: NEAR_MARGIN });
    const away = new IntersectionObserver((entries) => entries.every((e) => !e.isIntersecting) && setNear(false), { root, rootMargin: FAR_MARGIN });
    toward.observe(el);
    away.observe(el);
    return () => {
      toward.disconnect();
      away.disconnect();
    };
  }, [el]);
  return [setEl, near];
}

/** The face scaled from FACE_WIDTH to the well's width. */
function Scaled({ children }: { children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.6);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const w = el.getBoundingClientRect().width;
      if (w > 0) setScale(w / FACE_WIDTH);
    };
    measure();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);
  return (
    <div className="fc-scale" ref={box}>
      <div className="fc-scale-in" style={{ width: FACE_WIDTH, transform: `scale(${scale})` } as CSSProperties}>
        {children}
      </div>
    </div>
  );
}

const isSrc = (face: CardFace): face is { src: string } => !!face && typeof face === 'object' && 'src' in (face as object) && typeof (face as { src?: unknown }).src === 'string';

/**
 * What sits in the well: paper for a document (one sheet behind), a flat window for a page (its bar with three dots),
 * flat for an image or data. `small` (a row's thumbnail): the host's small static face as it is (not scaled), or a
 * picture's `src`; never a whole face.
 */
function Well({ kind, face, small }: { kind: CardKind; face: CardFace; small?: boolean }) {
  const [ref, near] = useNear();
  const body = !near ? null : isSrc(face) ? <img className="fc-img" src={face.src} alt="" draggable={false} /> : small ? face : <Scaled>{face}</Scaled>;
  return (
    <div className={`fc-well fc-k-${kind}${small ? ' fc-small' : ''}`} ref={ref} aria-hidden="true" inert data-card-face="">
      {kind === 'document' && !small && <div className="fc-sheet fc-back" />}
      <div className={kind === 'document' ? 'fc-sheet fc-front' : kind === 'page' ? 'fc-win' : kind === 'data' ? 'fc-panel fc-cells' : 'fc-panel'}>
        {kind === 'page' && !small && (
          <div className="fc-wbar">
            <i />
            <i />
            <i />
          </div>
        )}
        <div className="fc-body">{body}</div>
      </div>
    </div>
  );
}

function Fact({ fact, factMark, factTone, time }: Pick<CardCommon, 'fact' | 'factMark' | 'factTone' | 'time'>) {
  if (!fact) return null;
  return (
    <span className={factTone === 'action' ? 'fc-fact fc-act' : 'fc-fact'} title={time}>
      {factMark && <span className="fc-mark">{factMark}</span>}
      <span className="fc-fact-t">{fact}</span>
    </span>
  );
}

const Anchor = ({ children, ...props }: CardLinkProps) => <a {...props}>{children}</a>;

export function Card(props: CardProps) {
  const Link = props.linkComponent ?? Anchor;
  return (
    <div className={`fc-card fc-${props.size}${props.pinned ? ' fc-pinned' : ''}`} data-card="" data-card-kind={props.kind}>
      <Well kind={props.kind} face={props.face} />
      <Link href={props.href} className="fc-link" data-card-link="">
        <span className="fc-text">
          <span className="fc-title" dir="auto">
            {props.unread && <span className="fc-dot" aria-hidden="true" />}
            {props.unread && <span className="fc-sr">New. </span>}
            {props.title}
          </span>
          <Fact fact={props.fact} factMark={props.factMark} factTone={props.factTone} time={props.time} />
          {props.time && <span className="fc-sr">, {props.time}</span>}
          {props.pinned && <span className="fc-sr">, pinned</span>}
        </span>
      </Link>
      {props.action && <div className="fc-action">{props.action}</div>}
    </div>
  );
}

export function CardRow(props: CardRowProps) {
  const Link = props.linkComponent ?? Anchor;
  return (
    <div className={`fc-row${props.pinned ? ' fc-pinned' : ''}`} data-card-row="" data-card-kind={props.kind}>
      <span className="fc-thumb">
        <Well kind={props.kind} face={props.thumb ?? null} small />
      </span>
      <Link href={props.href} className="fc-rlink" data-card-link="">
        <span className="fc-rname" dir="auto">
          {props.unread && <span className="fc-dot" aria-hidden="true" />}
          {props.unread && <span className="fc-sr">New. </span>}
          <span className="fc-rtitle">{props.title}</span>
        </span>
        {props.secondary ? <span className="fc-rsec">{props.secondary}</span> : <span className="fc-rgap" />}
        <span className="fc-rfact">
          <Fact fact={props.fact} factMark={props.factMark} factTone={props.factTone} time={props.time} />
        </span>
        {props.time && <span className="fc-sr">, {props.time}</span>}
        {props.pinned && <span className="fc-sr">, pinned</span>}
      </Link>
      {props.action && <div className="fc-raction">{props.action}</div>}
    </div>
  );
}

export function CardUpdatesPill({ count, onShow }: { count: number; onShow: () => void }) {
  if (count < 1) return null;
  return (
    <button type="button" className="fc-pill" onClick={onShow} data-card-updates={count}>
      {count} {count === 1 ? 'update' : 'updates'} · Show
    </button>
  );
}

/** Content changed in place: a short fade on the face; the card never moves. */
export function arrive(el: Element | null): void {
  if (!el || reducedMotion() || typeof (el as HTMLElement).animate !== 'function') return;
  (el as HTMLElement).animate([{ opacity: 0.45 }, { opacity: 1 }], { duration: 240, easing: 'ease-out' });
}

/** FLIP every card and row in `container` around the host's reorder (`mutate` must change the DOM synchronously). */
export function settleBatch(container: Element | null, mutate: () => void): void {
  if (!container || reducedMotion()) {
    mutate();
    return;
  }
  const keyed = () => new Map([...container.querySelectorAll<HTMLElement>('[data-card-key]')].map((el) => [el.dataset.cardKey!, el]));
  const before = new Map([...keyed()].map(([key, el]) => [key, el.getBoundingClientRect()]));
  mutate();
  for (const [key, el] of keyed()) {
    const was = before.get(key);
    if (!was || typeof el.animate !== 'function') continue;
    const now = el.getBoundingClientRect();
    const dx = was.left - now.left;
    const dy = was.top - now.top;
    if (!dx && !dy) continue;
    el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 320, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
  }
}

/** The stand-in's look, drawn once per document. Theme tokens only; fills, never borders, for hover and focus. */
export function CardStyles() {
  return <style data-card-stand-in="">{CSS}</style>;
}

const CSS = `
.fc-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
/* Paper, its edge and the shadow's ink, as home-5 sets them: the paper is lighter than its ground in dark, and a shadow
   is a shadow (never the foreground's glow). The app's dark is the root without .light. */
.fc-card, .fc-row { --fc-paper: var(--card); --fc-paper-edge: color-mix(in oklch, var(--foreground) 11%, transparent); --fc-shadow-ink: var(--foreground); }
:root:not(.light) :is(.fc-card, .fc-row) { --fc-paper: color-mix(in oklch, var(--card) 94%, var(--foreground)); --fc-paper-edge: color-mix(in oklch, var(--foreground) 12%, transparent); --fc-shadow-ink: oklch(from var(--background) calc(l * 0.2) calc(c * 0.5) h); }
.fc-card { --fc-ease: cubic-bezier(0.22, 1, 0.36, 1); position: relative; display: flex; flex-direction: column; min-width: 0; border-radius: 12px; overflow: hidden; background: var(--card); box-shadow: 0 0 0 1px color-mix(in oklch, var(--foreground) 9%, transparent); transition: box-shadow 160ms ease-out; }
.fc-card:hover { box-shadow: 0 0 0 1px color-mix(in oklch, var(--foreground) 16%, transparent), 0 10px 24px -14px color-mix(in oklch, var(--fc-shadow-ink) 30%, transparent); }
.fc-link { display: flex; flex-direction: column; flex: 1; color: inherit; text-decoration: none; outline: none; }
/* The link's hit area is the whole card (the face is its sibling); its focus ring is drawn on it, inside the card. */
.fc-link::after { content: ''; position: absolute; inset: 0; border-radius: inherit; }
.fc-link:focus-visible::after { box-shadow: inset 0 0 0 2px var(--primary), inset 0 0 0 4px var(--card); }
.fc-well { position: relative; aspect-ratio: 4 / 3; overflow: hidden; background: var(--fc-g); pointer-events: none; box-shadow: inset 0 -1px 0 color-mix(in oklch, var(--foreground) 7%, transparent); }
.fc-k-document { --fc-g: color-mix(in oklab, var(--primary) 8%, var(--card)); }
.fc-k-page { --fc-g: color-mix(in oklab, var(--foreground) 5%, var(--card)); }
.fc-k-image { --fc-g: color-mix(in oklab, var(--warning) 10%, var(--card)); }
.fc-k-data { --fc-g: color-mix(in oklab, var(--success) 9%, var(--card)); }
:root:not(.light) .fc-k-document { --fc-g: color-mix(in oklab, var(--primary) 12%, var(--card)); }
:root:not(.light) .fc-k-image { --fc-g: color-mix(in oklab, var(--warning) 12%, var(--card)); }
:root:not(.light) .fc-k-data { --fc-g: color-mix(in oklab, var(--success) 11%, var(--card)); }
.fc-sheet, .fc-win, .fc-panel { position: absolute; background: var(--fc-paper); overflow: hidden; transition: transform 240ms var(--fc-ease, ease-out); }
.fc-sheet { left: 10%; right: 10%; top: 10%; bottom: -14px; border-radius: 6px 6px 0 0; box-shadow: 0 0 0 1px var(--fc-paper-edge), 0 2px 8px -4px color-mix(in oklch, var(--fc-shadow-ink) 18%, transparent); }
.fc-back { transform: translate(2%, -5%) rotate(1.4deg); transform-origin: 50% 100%; box-shadow: 0 0 0 1px var(--fc-paper-edge); background: color-mix(in oklch, var(--fc-paper) 92%, var(--foreground)); }
.fc-win { left: 8%; right: 8%; top: 9%; bottom: -10px; border-radius: 8px 8px 0 0; box-shadow: 0 0 0 1px var(--fc-paper-edge), 0 2px 8px -4px color-mix(in oklch, var(--fc-shadow-ink) 18%, transparent); }
.fc-panel { left: 8%; right: 8%; top: 9%; bottom: 9%; border-radius: 6px; box-shadow: 0 0 0 1px var(--fc-paper-edge); }
.fc-panel.fc-cells { bottom: -10px; border-radius: 6px 6px 0 0; }
.fc-wbar { display: flex; gap: 4px; align-items: center; height: 16px; padding: 0 8px; box-shadow: inset 0 -1px 0 color-mix(in oklch, var(--foreground) 7%, transparent); }
.fc-wbar i { width: 5px; height: 5px; border-radius: 50%; background: color-mix(in oklch, var(--foreground) 18%, transparent); }
.fc-body { position: absolute; inset: 0; overflow: hidden; }
.fc-win .fc-body { top: 16px; }
.fc-sheet .fc-body { padding: 0; }
.fc-scale { position: absolute; inset: 0; overflow: hidden; }
.fc-scale-in { transform-origin: 0 0; pointer-events: none; }
.fc-img { width: 100%; height: 100%; object-fit: contain; display: block; }
.fc-card:hover .fc-back, .fc-card:focus-within .fc-back { transform: translate(3.5%, -7%) rotate(2.6deg); }
.fc-card:hover :is(.fc-win, .fc-panel, .fc-front), .fc-card:focus-within :is(.fc-win, .fc-panel, .fc-front) { transform: translateY(-3px); }
.fc-text { display: flex; flex-direction: column; gap: 2px; padding: 11px 14px 13px; }
.fc-title { font-size: 14px; line-height: 20px; font-weight: 500; color: var(--foreground); display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; text-wrap: pretty; }
.fc-large .fc-title { font-size: 15px; line-height: 22px; }
.fc-dot { display: inline-block; width: 7px; height: 7px; margin: 0 7px 0 0; border-radius: 50%; background: var(--primary); vertical-align: 1px; flex: none; }
.fc-fact { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; line-height: 18px; color: var(--muted-foreground); white-space: nowrap; min-width: 0; }
.fc-fact-t { overflow: hidden; text-overflow: ellipsis; }
.fc-act { color: var(--primary); }
/* breathe: the agent's mark, very slowly (home-5: 4.8 s), only while the fact is drawn. */
.fc-mark { display: inline-flex; width: 14px; height: 14px; align-items: center; justify-content: center; animation: fc-breathe 4.8s ease-in-out infinite; }
.fc-mark :is(svg, img) { width: 13px; height: 13px; }
@keyframes fc-breathe { 50% { opacity: 0.35; } }
/* A change landing in a face: the block it landed in, tinted for a moment (two names, so a second landing replays). */
.fc-landed-0 { animation: fc-landed-a 1600ms ease-out; border-radius: 4px; }
.fc-landed-1 { animation: fc-landed-b 1600ms ease-out; border-radius: 4px; }
@keyframes fc-landed-a { from { background: color-mix(in oklch, var(--primary) 18%, transparent); } to { background: transparent; } }
@keyframes fc-landed-b { from { background: color-mix(in oklch, var(--primary) 18%, transparent); } to { background: transparent; } }
.fc-action, .fc-raction { opacity: 0; transition: opacity 120ms ease-out; }
.fc-action { position: absolute; top: 8px; right: 8px; z-index: 1; }
.fc-card:hover .fc-action, .fc-card:focus-within .fc-action, .fc-pinned .fc-action, .fc-row:hover .fc-raction, .fc-row:focus-within .fc-raction, .fc-row.fc-pinned .fc-raction { opacity: 1; }
@media (hover: none) { .fc-action, .fc-raction { opacity: 1; } }
.fc-row { position: relative; display: flex; align-items: center; column-gap: 14px; padding-left: 6px; border-radius: 8px; }
.fc-row:hover { background: color-mix(in oklch, var(--foreground) 5%, transparent); }
.fc-row:focus-within { background: color-mix(in oklch, var(--primary) 12%, transparent); }
.fc-rlink { flex: 1; min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 160px) minmax(0, 180px); align-items: center; column-gap: 14px; height: 44px; padding: 0 10px 0 0; color: inherit; text-decoration: none; outline: none; }
.fc-rlink::after { content: ''; position: absolute; inset: 0; border-radius: inherit; }
.fc-thumb { flex: none; width: 36px; height: 27px; border-radius: 5px; overflow: hidden; display: block; pointer-events: none; }
.fc-small { width: 36px; height: 27px; aspect-ratio: auto; }
.fc-small .fc-sheet { left: 12%; right: 12%; top: 14%; bottom: -2px; border-radius: 2px 2px 0 0; }
.fc-small :is(.fc-win, .fc-panel) { border-radius: 2px; }
.fc-small .fc-panel.fc-cells { bottom: -2px; border-radius: 2px 2px 0 0; }
.fc-rname { display: flex; align-items: center; min-width: 0; font-size: 14px; line-height: 20px; color: var(--foreground); }
.fc-rtitle { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.fc-rsec { font-size: 13px; color: var(--muted-foreground); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.fc-rfact { display: flex; justify-content: flex-end; min-width: 0; }
.fc-raction { position: relative; flex: none; padding-right: 6px; }
@media (max-width: 767px) {
  .fc-rlink { grid-template-columns: minmax(0, 1fr) auto; height: 52px; }
  .fc-rsec, .fc-rgap { display: none; }
}
.fc-pill { display: inline-flex; align-items: center; height: 26px; padding: 0 10px; border-radius: 999px; background: color-mix(in oklch, var(--primary) 12%, transparent); color: var(--primary); font-size: 13px; font-weight: 500; cursor: pointer; }
.fc-pill:hover { background: color-mix(in oklch, var(--primary) 18%, transparent); }
.fc-pill:focus-visible { outline: 2px solid var(--primary); outline-offset: 1px; }
@media (prefers-reduced-motion: reduce) {
  .fc-card, .fc-sheet, .fc-win, .fc-panel, .fc-action, .fc-raction { transition: none; }
  .fc-mark, .fc-landed-0, .fc-landed-1 { animation: none; }
  .fc-card:hover .fc-back, .fc-card:focus-within .fc-back { transform: translate(2%, -5%) rotate(1.4deg); }
  .fc-card:hover :is(.fc-win, .fc-panel, .fc-front), .fc-card:focus-within :is(.fc-win, .fc-panel, .fc-front) { transform: none; }
}
`;
