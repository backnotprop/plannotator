import { useLayoutEffect, useRef, useState, type CSSProperties, type MutableRefObject } from 'react';
import { createPortal } from 'react-dom';
import { HostMark } from '@plannotator/ui/components/inbox-thread/icons';
import { Tip } from '../components/Tip';
import { SIDE_CORNER, SIDE_CORNER_HIT, SIDE_CORNER_R, isRingShadow, parseBoxShadows, scoopFits, scoopMask, scoopMaskReact, scoopMaskStyle, shadowText, sideCornerHitPath, type ScoopGeometry } from './scoop';

/**
 * The minimized side chat (the owner, 2026-11-20, the 28 px circle; it replaces the corner button removed on
 * 2026-11-09): a circle holding the agent's mark, set into the window's bottom-right corner on the ground, and the
 * pane at that corner cut inward around it (scoop.ts). A press reopens the chat. It is ChatFrameLauncher's child
 * (useInboxAsk), so it shows only while the window is minimized, and it wears `data-chat-launcher`, so minimizing
 * moves focus here (ui's useChatFrameFocusReturn). No shortcut of its own, no words but its name and tooltip.
 */

/** The window as it was when the person minimized it: it shrinks into the circle from there. */
export interface SideFlight {
  node: HTMLElement;
  rect: DOMRect;
  radius: string;
  at: number;
}

/** The window's node, taken before React removes it (the minimize's own handler runs before the re-render). */
export function takeSideFlight(): SideFlight | null {
  const el = document.querySelector<HTMLElement>('[data-ask-window]');
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return { node: el.cloneNode(true) as HTMLElement, rect, radius: getComputedStyle(el).borderTopLeftRadius, at: performance.now() };
}

/** The panes a thread view lays out; the one whose corner is the window's gets the cut. */
const PANES = ':is(.ib-main > :is(.ib-pane, .ib-view, .ib-listcol), .ib-main > .ib-panehost > .ib-panedock > :is(.ib-pane, .ib-view))';

const FLY_MS = 240;
const FLY_EASE = 'cubic-bezier(0.33, 1, 0.68, 1)'; // ease-out cubic: seven eighths of the way at half time

export interface SideChatCornerProps {
  host: string | null;
  unseen: boolean;
  answering: boolean;
  onOpen: () => void;
  flight: MutableRefObject<SideFlight | null>;
}

interface Cut {
  pane: HTMLElement;
  /** The ground between the pane and the window's edges (the hit area's strips). */
  gx: number;
  gy: number;
  geo: ScoopGeometry | null;
  box: { left: number; top: number; width: number; height: number };
  radius: number;
  ring: string | null;
  shadows: ReturnType<typeof parseBoxShadows>;
}

export function sideChatName(unseen: boolean, answering: boolean): string {
  return `Side chat${unseen ? ', new answer' : ''}${answering ? ', answering' : ''}`;
}

export function SideChatCorner({ host, unseen, answering, onOpen, flight }: SideChatCornerProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const dotRef = useRef<HTMLSpanElement | null>(null);
  const flyRef = useRef<HTMLDivElement | null>(null);
  const [cut, setCut] = useState<Cut | null>(null);
  /** A file's full view fills the window and keeps its own control in this corner: no circle over it. */
  const [covered, setCovered] = useState(false);

  // Find the pane at the window's corner and measure it, again whenever the layout or the theme may have moved it.
  useLayoutEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      // The window's corner: the layer's (the circle may be hidden, see `covered`).
      const layer = rootRef.current?.parentElement;
      if (!layer) return;
      const corner = layer.getBoundingClientRect();
      // The pane on top just past the pocket (a pane under another, as the list under a narrow window's thread, is not it).
      let pane: HTMLElement | null = null;
      for (const el of document.elementsFromPoint?.(corner.right - 40, corner.bottom - 40) ?? []) {
        const found = el.closest<HTMLElement>(PANES);
        if (found) {
          pane = found;
          break;
        }
      }
      if (pane) {
        const r = pane.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0 || corner.right - r.right > SIDE_CORNER_R || corner.bottom - r.bottom > SIDE_CORNER_R) pane = null;
      }
      if (!pane) {
        setCut(null);
        setCovered(false);
        return;
      }
      const r = pane.getBoundingClientRect();
      const cs = getComputedStyle(pane);
      const gx = Math.max(0, corner.right - r.right);
      const gy = Math.max(0, corner.bottom - r.bottom);
      setCovered(gx < 1 && gy < 1 && pane.matches('.ib-fullview, .ib-full'));
      // The flat window (rounded panes off): no cut, the circle sits over the pane's corner.
      const radius = parseFloat(cs.borderTopRightRadius) || 0;
      const geo = { sx: SIDE_CORNER_R - gx, sy: SIDE_CORNER_R - gy, R: SIDE_CORNER_R, f: SIDE_CORNER.f };
      const shadows = parseBoxShadows(cs.getPropertyValue('--ib-pane-shadow'));
      const ring = shadows.find(isRingShadow);
      const next: Cut = {
        pane,
        gx,
        gy,
        geo: radius > 0 && scoopFits(geo) ? geo : null,
        box: { left: r.left, top: r.top, width: r.width, height: r.height },
        radius,
        ring: ring ? ring.color : null,
        shadows: shadows.filter((s) => !isRingShadow(s)),
      };
      setCut((last) => (last && sameCut(last, next) ? last : next));
    };
    const soon = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener('resize', soon);
    const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(soon) : null;
    for (const el of document.querySelectorAll(PANES)) resize?.observe(el);
    const watch = new MutationObserver(() => {
      if (resize) for (const el of document.querySelectorAll(PANES)) resize.observe(el);
      soon();
    });
    // The window's root, which outlives the layouts inside it (a narrow window swaps the shell on its first frames).
    watch.observe(rootRef.current?.closest('.pn-inbox') ?? document.body, { childList: true, subtree: true });
    // A theme or palette change: the pane's shadow is another list.
    const theme = new MutationObserver(soon);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('resize', soon);
      resize?.disconnect();
      watch.disconnect();
      theme.disconnect();
    };
  }, []);

  // The pane's own corner: masked to the cut, its outer shadows off (the edge layer draws them along the cut).
  const pane = cut?.geo && !covered ? cut.pane : null;
  const geo = cut?.geo ?? null;
  const insetShadow = cut ? cut.shadows.filter((s) => s.inset).map(shadowText).join(', ') : '';
  useLayoutEffect(() => {
    if (!pane || !geo) return;
    const style: Record<string, string> = {
      ...scoopMaskStyle(scoopMask(geo)),
      'box-shadow': insetShadow || 'none',
      'border-bottom-right-radius': '0',
    };
    for (const [key, value] of Object.entries(style)) pane.style.setProperty(key, value);
    pane.setAttribute('data-side-scoop', '');
    return () => {
      for (const key of Object.keys(style)) pane.style.removeProperty(key);
      pane.removeAttribute('data-side-scoop');
    };
  }, [pane, geo?.sx, geo?.sy, geo?.R, geo?.f, insetShadow]); // eslint-disable-line react-hooks/exhaustive-deps

  // The window shrinks into the circle (240 ms); under reduced motion it just goes.
  useLayoutEffect(() => {
    const from = flight.current;
    flight.current = null;
    const host = flyRef.current;
    const dot = dotRef.current;
    if (!from || !host || !dot || performance.now() - from.at > 500) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || typeof from.node.animate !== 'function') return;
    const ghost = from.node;
    for (const el of [ghost, ...ghost.querySelectorAll('*')]) {
      for (const name of [...el.getAttributeNames()]) if (name === 'id' || name.startsWith('data-chat') || name.startsWith('data-ask')) el.removeAttribute(name);
    }
    ghost.setAttribute('aria-hidden', 'true');
    ghost.setAttribute('inert', '');
    Object.assign(ghost.style, {
      position: 'fixed',
      left: `${from.rect.left}px`,
      top: `${from.rect.top}px`,
      right: 'auto',
      bottom: 'auto',
      width: `${from.rect.width}px`,
      height: `${from.rect.height}px`,
      margin: '0',
      transformOrigin: '0 0',
      pointerEvents: 'none',
    });
    host.appendChild(ghost);
    const to = dot.getBoundingClientRect();
    const sx = to.width / from.rect.width;
    const sy = to.height / from.rect.height;
    const flyBox = ghost.animate(
      [
        { transform: 'none', borderRadius: from.radius },
        { transform: `translate(${to.left - from.rect.left}px, ${to.top - from.rect.top}px) scale(${sx}, ${sy})`, borderRadius: '50%' },
      ],
      { duration: FLY_MS, easing: FLY_EASE, fill: 'forwards' },
    );
    ghost.animate([{ opacity: 1 }, { opacity: 1, offset: 0.55 }, { opacity: 0 }], { duration: FLY_MS, fill: 'forwards' });
    for (const child of ghost.children) (child as HTMLElement).animate?.([{ opacity: 1 }, { opacity: 0 }], { duration: FLY_MS / 2, fill: 'forwards' });
    dot.animate([{ transform: 'scale(0.55)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: FLY_MS, easing: FLY_EASE });
    const done = () => ghost.remove();
    flyBox.onfinish = done;
    flyBox.oncancel = done;
    return () => {
      flyBox.cancel();
      done();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const hit = sideCornerHitPath(cut ? cut.gx : 0, cut ? cut.gy : 0);
  const work = SIDE_CORNER.d + 6;
  const edge = pane && cut?.geo ? <ScoopEdge cut={cut} geo={cut.geo} /> : null;
  const edgeHost = pane ? (pane.closest<HTMLElement>('.ib-sb-wrapper') ?? pane.parentElement) : null;

  return (
    <div ref={rootRef} className="ib-sc" data-side-corner="" hidden={covered}>
      <Tip content="Side chat" side="left" wide={false}>
        <button
          ref={buttonRef}
          type="button"
          className="ib-sc-btn"
          aria-label={sideChatName(unseen, answering)}
          data-chat-launcher=""
          data-side-chat-corner=""
          data-unseen={unseen ? '' : undefined}
          data-answering={answering ? '' : undefined}
          style={{ clipPath: `path('${hit}')`, width: SIDE_CORNER_HIT, height: SIDE_CORNER_HIT } as CSSProperties}
          onClick={onOpen}
        >
          {answering && (
            <svg className="ib-sc-work" viewBox={`0 0 ${work} ${work}`} aria-hidden="true" data-side-work="">
              <circle cx={work / 2} cy={work / 2} r={work / 2 - 1.5} pathLength={100} strokeDasharray="22 78" />
            </svg>
          )}
          <span ref={dotRef} className="ib-sc-dot">
            <HostMark host={host} />
          </span>
          {unseen && <span className="ib-sc-new" aria-hidden="true" data-side-new="" />}
        </button>
      </Tip>
      <div ref={flyRef} className="ib-sc-fly" aria-hidden="true" />
      {edge && edgeHost ? createPortal(edge, edgeHost) : null}
    </div>
  );
}

function sameCut(a: Cut, b: Cut): boolean {
  return (
    a.pane === b.pane &&
    a.gx === b.gx &&
    a.gy === b.gy &&
    a.radius === b.radius &&
    a.ring === b.ring &&
    a.box.left === b.box.left &&
    a.box.top === b.box.top &&
    a.box.width === b.box.width &&
    a.box.height === b.box.height &&
    a.geo?.sx === b.geo?.sx &&
    a.geo?.sy === b.geo?.sy &&
    JSON.stringify(a.shadows) === JSON.stringify(b.shadows)
  );
}

/**
 * Behind the cut pane, never above it: the pane's hairline as a 1 px rim of the cut shape grown by 1, and each of its
 * outer shadows as a drop-shadow of the shape eroded by the shadow's negative spread, so the edge, the hairline and
 * the shadow follow the curve.
 */
function ScoopEdge({ cut, geo }: { cut: Cut; geo: ScoopGeometry }) {
  const { radius } = cut;
  return (
    <div
      className="ib-sc-edge"
      aria-hidden="true"
      data-side-scoop-edge=""
      style={{ left: cut.box.left, top: cut.box.top, width: cut.box.width, height: cut.box.height }}
    >
      {cut.shadows
        .filter((s) => !s.inset)
        .map((s, i) => {
          const k = Math.max(0, -s.spread);
          return (
            <div key={i} className="ib-sc-shade" style={{ filter: `drop-shadow(${s.x}px ${s.y}px ${s.blur / 2}px ${s.color})` }}>
              <i style={{ inset: k, borderRadius: Math.max(radius - k, 0), borderBottomRightRadius: 0, ...(scoopMaskReact(scoopMask(geo, -k)) as CSSProperties) }} />
            </div>
          );
        })}
      {cut.ring && (
        <i
          className="ib-sc-rim"
          style={{ inset: -1, background: cut.ring, borderRadius: radius + 1, borderBottomRightRadius: 0, ...(scoopMaskReact(scoopMask(geo, 1)) as CSSProperties) }}
        />
      )}
    </div>
  );
}
