import { useLayoutEffect, useRef, useState, type CSSProperties, type MutableRefObject } from 'react';
import { createPortal } from 'react-dom';
import { HostMark } from '@plannotator/ui/components/inbox-thread/icons';
import { Tip } from '../components/Tip';
import { SideCircleMenu } from '../parts/SideCircleMenu';
import { SIDE_CORNER, SIDE_CORNER_HIT, SIDE_CORNER_R, isRingShadow, parseBoxShadows, scoopFits, scoopMask, scoopMaskReact, scoopMaskStyle, shadowText, sideCornerHitPath, type ScoopGeometry } from './scoop';

/**
 * The minimized side chat (the owner, 2026-11-20, the 28 px circle; it replaces the corner button removed on
 * 2026-11-09): a circle holding the agent's mark, set into the window's bottom-right corner on the ground, and the
 * pane at that corner cut inward around it (scoop.ts). A press reopens the chat. It is ChatFrameLauncher's child
 * (useInboxAsk), so it shows only while the window is minimized, and it wears `data-chat-launcher`, so minimizing
 * moves focus here (ui's useChatFrameFocusReturn). No shortcut of its own, no words but its name and tooltip. A
 * right-click or a long press opens its menu, Close (parts/SideCircleMenu.tsx): the circle goes, the chat stays.
 */

/** A minimize from inside the window, and the window as it was: it shrinks into the circle from there. */
export interface SideFlight {
  /** The window's copy, or null when it had no box to fly from. */
  node: HTMLElement | null;
  rect: DOMRect | null;
  radius: string;
  at: number;
}

/**
 * The window's node, taken before React removes it (the minimize's own handler runs before the re-render). No copy
 * when nothing will fly: under reduced motion, or when no circle comes to fly into (`circle` false).
 */
export function takeSideFlight(circle = true): SideFlight {
  const at = performance.now();
  const still = !circle || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  const el = still ? null : document.querySelector<HTMLElement>('[data-ask-window]');
  const rect = el?.getBoundingClientRect();
  if (!el || !rect || rect.width <= 0 || rect.height <= 0) return { node: null, rect: null, radius: '0px', at };
  return { node: el.cloneNode(true) as HTMLElement, rect, radius: getComputedStyle(el).borderTopLeftRadius, at };
}

/**
 * The panes a thread view lays out; the one whose corner is the window's gets the cut. With Split view on
 * (`inboxSplitView`) every pane sits in the free layout's place for it (panes/ThreadPanes.tsx, panes.css).
 */
const PANES = [
  ...['.ib-pane', '.ib-view', '.ib-listcol', '.ib-panehost > .ib-panedock > .ib-pane', '.ib-panehost > .ib-panedock > .ib-view'].map((pane) => `.ib-main > ${pane}`),
  '.ib-main > .ib-layout .pierre-layout-content > .ib-panehost > .ib-panedock > .ib-pane',
  '.ib-main > .ib-layout .pierre-layout-content > .ib-panehost > .ib-panedock > .ib-view',
].join(', ');

/**
 * Something else's in the corner pane's bottom-right corner, which the cut would clip and the circle cover: a Shape
 * board open in the thread (its side panel and its More run to the pane's corner), or a narrow file view's annotations
 * panel (open down its right edge to its foot). The circle and the cut keep off; they come back when it goes. The
 * floating drafts' pile never takes the corner: resting there, it sits just above the circle (useReplyFloaters).
 */
function cornerOwned(pane: HTMLElement): boolean {
  if (pane.querySelector('.ib-shape-inthread:not([hidden])')) return true;
  return pane.matches(FOLDED_PANEL) || pane.querySelector(FOLDED_PANEL) !== null;
}
const FOLDED_PANEL = '.ib-view.ib-fold.ib-panel-open';
/** Classes on a pane that hand its corner to something else, or the whole window to a layer. */
const OWNER_CLASSES = ['ib-fold', 'ib-panel-open', 'ib-wlayer'];
/**
 * A whole-window layer (`ib-wlayer`: a file's full view, a guided review, a PR review, a Shape board, the tour's
 * viewer) over the corner: that corner is the layer's, and the circle is not shown over it.
 */
function cornerLayer(corner: { right: number; bottom: number }): boolean {
  for (const el of document.querySelectorAll<HTMLElement>('.ib-wlayer')) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && r.right >= corner.right - 1 && r.bottom >= corner.bottom - 1 && r.left < corner.right - 44 && r.top < corner.bottom - 44 && getComputedStyle(el).visibility !== 'hidden') return true;
  }
  return false;
}

/**
 * The pane whose corner is the window's, found by layout and never by hit testing (a menu, a dialog or a toast over
 * the corner must not drop the cut): a laid-out pane holding the point 40 px in from the corner, its own corner within
 * the pocket's reach of both edges. Two such panes (a narrow window lays the thread over the list): the docked one,
 * else the later one, which paints on top.
 */
export function cornerPane(panes: Iterable<HTMLElement>, corner: { right: number; bottom: number }): HTMLElement | null {
  const x = corner.right - 40;
  const y = corner.bottom - 40;
  let best: HTMLElement | null = null;
  for (const el of panes) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0 || x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
    if (corner.right - r.right > SIDE_CORNER_R || corner.bottom - r.bottom > SIDE_CORNER_R) continue;
    if (el.hidden || getComputedStyle(el).visibility === 'hidden') continue;
    if (!best) best = el;
    else {
      const docked = (e: HTMLElement) => e.parentElement?.classList.contains('ib-panedock') === true;
      if (docked(el) !== docked(best)) best = docked(el) ? el : best;
      else if (best.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) best = el;
    }
  }
  return best;
}

/** Only nodes no measure here depends on: a code fence's text and highlight, the reply box's words, the corner's own layers. */
const MOVES_NOTHING = 'pre, .ib-rmirror, .ib-rtext, [data-side-corner], [data-side-scoop-edge]';

/**
 * Can this change move the pane at the corner? Only a change to the panes' containers (the shell, `.ib-main`, its dock):
 * a pane added, removed or swapped. A change inside a pane (a message's body, a highlight, a key) moves no pane, and a
 * pane's own size is watched by the ResizeObserver. Nodes of the corner's own (its edge layer) never count.
 */
export function cornerMoves(record: MutationRecord): boolean {
  const target = record.target.nodeType === 1 ? (record.target as Element) : record.target.parentElement;
  if (!target) return false;
  if (record.type === 'attributes') return ownerChanged(record, target);
  if (target.closest(MOVES_NOTHING)) return false;
  const nodes = [...record.addedNodes, ...record.removedNodes];
  if (nodes.length === 0) return false;
  // Inside a pane (not the pane's own container): nothing that moves it, only a board opening or closing in it.
  if (target.closest(PANES)) return nodes.some((node) => node.nodeType === 1 && (node as Element).matches('.ib-shape-inthread'));
  return nodes.some((node) => node.nodeType === 1 && !(node as Element).matches(MOVES_NOTHING));
}

/**
 * An attribute change that gives the corner to something else or takes it back (cornerOwned): a board in a thread
 * shown or hidden, a pane folding, opening its panel or going full.
 */
function ownerChanged(record: MutationRecord, target: Element): boolean {
  if (record.attributeName === 'hidden') return target.matches('.ib-shape-inthread');
  if (record.attributeName !== 'class' || !target.matches(PANES)) return false;
  const was = new Set((record.oldValue ?? '').split(/\s+/));
  return OWNER_CLASSES.some((name) => was.has(name) !== target.classList.contains(name));
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

const FLY_MS = 240;
const FLY_EASE = 'cubic-bezier(0.33, 1, 0.68, 1)'; // ease-out cubic: seven eighths of the way at half time

export interface SideChatCornerProps {
  host: string | null;
  unseen: boolean;
  answering: boolean;
  onOpen: () => void;
  flight: MutableRefObject<SideFlight | null>;
  /** What had focus when the chat was last opened: focus goes back there on a minimize with no circle to take it. */
  opener: MutableRefObject<HTMLElement | null>;
  /** Whether the circle is on screen (not hidden for want of a pane to cut): false again when it unmounts. */
  onShown?: (shown: boolean) => void;
  /** Close in the circle's menu (parts/SideCircleMenu.tsx): the circle goes for this thread, the chat stays. */
  onClose: () => void;
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

export function SideChatCorner({ host, unseen, answering, onOpen, flight, opener, onShown, onClose }: SideChatCornerProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const dotRef = useRef<HTMLSpanElement | null>(null);
  const flyRef = useRef<HTMLDivElement | null>(null);
  const [cut, setCut] = useState<Cut | null>(null);
  /**
   * No circle: no pane at the corner to cut (a flat pane, or none), or a file's full view, which keeps its own control
   * in this corner. Hidden until the first measure says otherwise.
   */
  const [covered, setCovered] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  /** The last measure's verdict, read by the minimize's flight and focus in the same commit. */
  const shown = useRef(false);
  const paneRef = useRef<HTMLElement | null>(null);

  // Find the pane at the window's corner and measure it, again whenever the layout or the theme may have moved it.
  useLayoutEffect(() => {
    let frame = 0;
    let last: HTMLElement | null = null;
    const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(() => soon()) : null;
    const watched = new Set<Element>();
    const measure = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      // The window's corner: the layer's (the circle may be hidden).
      const layer = rootRef.current?.parentElement;
      if (!layer) return;
      const panes = document.querySelectorAll<HTMLElement>(PANES);
      for (const el of panes) {
        if (!watched.has(el)) {
          watched.add(el);
          resize?.observe(el);
        }
      }
      for (const el of watched) {
        if (!el.isConnected) {
          watched.delete(el);
          resize?.unobserve(el);
        }
      }
      const corner = layer.getBoundingClientRect();
      const pane = cornerPane(panes, corner);
      last = pane;
      paneRef.current = pane;
      if (!pane) {
        shown.current = false;
        setCut(null);
        setCovered(true);
        return;
      }
      const r = pane.getBoundingClientRect();
      const cs = getComputedStyle(pane);
      const gx = Math.max(0, corner.right - r.right);
      const gy = Math.max(0, corner.bottom - r.bottom);
      // A whole-window layer over the corner, a placeholder pane with no thread in it (Reviews with code review off), or
      // something else's in the pane's corner.
      const notOurs = cornerLayer(corner) || pane.matches('.ib-pempty') || cornerOwned(pane);
      const radius = parseFloat(cs.borderTopRightRadius) || 0;
      const geo = { sx: SIDE_CORNER_R - gx, sy: SIDE_CORNER_R - gy, R: SIDE_CORNER_R, f: SIDE_CORNER.f };
      const shadows = parseBoxShadows(cs.getPropertyValue('--ib-pane-shadow'));
      const ring = shadows.find(isRingShadow);
      const next: Cut = {
        pane,
        gx,
        gy,
        // The flat window (rounded panes off, flush with the window): nothing to cut.
        geo: radius > 0 && scoopFits(geo) ? geo : null,
        box: { left: r.left, top: r.top, width: r.width, height: r.height },
        radius,
        ring: ring ? ring.color : null,
        shadows: shadows.filter((s) => !isRingShadow(s)),
      };
      // The circle shows only where it cuts a pane: never over a whole-window layer, a placeholder, a flat pane or nothing.
      shown.current = !notOurs && next.geo !== null;
      setCovered(!shown.current);
      setCut((was) => (was && sameCut(was, next) ? was : next));
    };
    function soon() {
      if (!frame) frame = requestAnimationFrame(measure);
    }
    measure();
    window.addEventListener('resize', soon);
    // Only changes that can move a pane: a pane or its containers added, removed or swapped. Never a message's body,
    // a code fence's highlight or the reply box's words (cornerMoves); a pane's own size is the ResizeObserver's.
    const watch = new MutationObserver((records) => {
      if (!records.some(cornerMoves)) return;
      // The cut pane itself went (a thread switch re-renders it): measure now, before the frame paints it uncut.
      if (last && !last.isConnected) measure();
      else soon();
    });
    // The window's root, which outlives the layouts inside it (a narrow window swaps the shell on its first frames).
    // Attributes: only those that hand the corner to something else or back (ownerChanged).
    watch.observe(rootRef.current?.closest('.pn-inbox') ?? document.body, { childList: true, subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['class', 'hidden'] });
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

  useLayoutEffect(() => {
    onShown?.(!covered);
  }, [covered, onShown]);
  useLayoutEffect(() => () => onShown?.(false), [onShown]);

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

  // The window shrinks into the circle (240 ms); under reduced motion it just goes. No circle to shrink into (a full
  // view at the corner): focus, which was in the window, goes back to where the chat was opened from, or to the pane.
  useLayoutEffect(() => {
    const from = flight.current;
    flight.current = null;
    const host = flyRef.current;
    const dot = dotRef.current;
    const layer = rootRef.current?.parentElement;
    if (!from || performance.now() - from.at > 500) return;
    if (!shown.current) {
      let second = 0;
      const first = requestAnimationFrame(() => {
        // After ui's useChatFrameFocusReturn (one frame), which finds no launcher while the circle is hidden.
        second = requestAnimationFrame(() => {
          if (document.activeElement && document.activeElement !== document.body) return;
          const back = opener.current;
          const target = back?.isConnected && back.getClientRects().length > 0 ? back : paneRef.current?.querySelector<HTMLElement>(FOCUSABLE);
          target?.focus({ preventScroll: true });
        });
      });
      return () => {
        cancelAnimationFrame(first);
        cancelAnimationFrame(second);
      };
    }
    if (!host || !dot || !layer || !from.node || !from.rect) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || typeof from.node.animate !== 'function') return;
    const ghost = from.node;
    const fromRect = from.rect;
    for (const el of [ghost, ...ghost.querySelectorAll('*')]) {
      for (const name of [...el.getAttributeNames()]) if (name === 'id' || name.startsWith('data-chat') || name.startsWith('data-ask')) el.removeAttribute(name);
    }
    ghost.setAttribute('aria-hidden', 'true');
    ghost.setAttribute('inert', '');
    Object.assign(ghost.style, {
      position: 'fixed',
      left: `${fromRect.left}px`,
      top: `${fromRect.top}px`,
      right: 'auto',
      bottom: 'auto',
      width: `${fromRect.width}px`,
      height: `${fromRect.height}px`,
      margin: '0',
      transformOrigin: '0 0',
      pointerEvents: 'none',
    });
    host.appendChild(ghost);
    // The circle's box from the corner's geometry (its centre SIDE_CORNER_R in from both edges of the window), never
    // from the dot: this commit mounted the circle hidden, and the measure's verdict shows it only on the next one.
    const corner = layer.getBoundingClientRect();
    const d = SIDE_CORNER.d;
    const to = { left: corner.right - SIDE_CORNER_R - d / 2, top: corner.bottom - SIDE_CORNER_R - d / 2, width: d, height: d };
    const sx = to.width / fromRect.width;
    const sy = to.height / fromRect.height;
    const flyBox = ghost.animate(
      [
        { transform: 'none', borderRadius: from.radius },
        { transform: `translate(${to.left - fromRect.left}px, ${to.top - fromRect.top}px) scale(${sx}, ${sy})`, borderRadius: '50%' },
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
      <SideCircleMenu button={() => buttonRef.current} anchor={() => dotRef.current} onClose={() => closeCircle(onClose, opener, paneRef.current)} onOpenChange={setMenuOpen}>
        <Tip content="Side chat" side="left" wide={false} when={() => !menuOpen}>
          <button
            ref={buttonRef}
            type="button"
            className="ib-sc-btn"
            aria-label={sideChatName(unseen, answering)}
            data-chat-launcher={covered ? undefined : ''}
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
      </SideCircleMenu>
      <div ref={flyRef} className="ib-sc-fly" aria-hidden="true" />
      {edge && edgeHost ? createPortal(edge, edgeHost) : null}
    </div>
  );
}

/**
 * Close from the circle's menu: the circle goes, so focus that was on it (the menu key, Shift+F10) goes back where the
 * chat was opened from, or into the pane at the corner, as a minimize with no circle to land on does.
 */
function closeCircle(onClose: () => void, opener: MutableRefObject<HTMLElement | null>, pane: HTMLElement | null) {
  const back = opener.current;
  const target = back?.isConnected && back.getClientRects().length > 0 ? back : pane?.querySelector<HTMLElement>(FOCUSABLE);
  onClose();
  requestAnimationFrame(() => {
    const at = document.activeElement;
    if (at && at !== document.body && at.isConnected) return;
    target?.focus({ preventScroll: true });
  });
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
