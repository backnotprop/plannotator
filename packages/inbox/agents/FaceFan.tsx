import { Popover } from '@base-ui/react/popover';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { tooltipContainerOf } from '@plannotator/ui/components/HostTitle';
import { HostMark } from '../icons';
import { agentHostName } from './model';
import { FACE_LABELS, GLASS_FACES, isOwnFace, type AgentFace, type OurFace } from './faceChoices';
import { ownIconSrc } from './ownIcons';
import { isSetFace, setArtStyle, setFaceDrawing } from './iconSets';
import { FAN_OPTIONS, fanLayout, type FanOptions, type FanSpot } from './fanLayout';
import { focusBackTo } from './focusBack';

/**
 * The face picker: a half-circle fan of an agent mark's faces round the mark, like a sundial's upper half laid on its
 * side (it opens toward the content; the mark sits at the sidebar's left edge). The inner arc holds the kinds (the
 * agent's own mark, Transparent, Face), the outer one the Glass colours; near the window's edges it turns away and,
 * short of room, the colours split over two short arcs. An overlay (Base UI's Popover, portaled), so the list never
 * moves.
 *
 * Opens: the pointer resting on the mark for FAN_DWELL_MS (a pointer passing over opens nothing), Enter or Space on
 * the focused mark, or a long press on a touch screen. Closes: the pointer leaving the mark and the fan (a short grace,
 * and the room between them counts as the fan's), Escape, a press outside, a scroll or resize, or a choice.
 * Keyboard inside: the arrows move along the arcs, Home and End to the ends, Enter or Space chooses. A labelled radio
 * group for screen readers. No global shortcut.
 */

/** How long the pointer rests on a mark before the fan opens. */
export const FAN_DWELL_MS = 350;

/** How long a touch is held before the fan opens. */
export const FAN_PRESS_MS = 450;
/** How long the pointer may be outside the mark and the fan before it closes. */
export const FAN_GRACE_MS = 140;

export type FanOpenedBy = 'hover' | 'keyboard' | 'touch';

/** A finger's fan: 40 px targets, 44 px apart (a pointer's are 28 and 32). */
export const FAN_TOUCH: Partial<FanOptions> = { pitch: 44, item: 40, inner: 64, between: 52 };

/** "Your own…": the inner arc's last place, which opens the uploaded pictures (OwnIconsBody.tsx, AgentIconDialog.tsx). */
export const OWN_CHOICE = 'own';
/** "Sets": the inner arc's place after it, which opens the icon sets (SetsBody.tsx, AgentIconDialog.tsx). */
export const SETS_CHOICE = 'sets';
/** A place in the fan: a face, "Your own…" or "Sets". */
export type FanChoice = Exclude<AgentFace, `own:${string}` | `set:${string}`> | typeof OWN_CHOICE | typeof SETS_CHOICE;
export const OWN_LABEL = 'Your own…';
export const SETS_LABEL = 'Sets';

/**
 * The fan's arcs: the kinds inside, the Glass colours outside (one arc, or two short ones when room is short). `own`:
 * "Your own…" among the kinds (not for a linked machine's agent, AgentMark.tsx).
 */
export function fanArcs(cx: number, cy: number, w: number, h: number, touch = false, own = true): { faces: FanChoice[][]; spots: FanSpot[][] } {
  const kinds: FanChoice[] = own ? ['agent', 'transparent', 'totman', OWN_CHOICE, SETS_CHOICE] : ['agent', 'transparent', 'totman', SETS_CHOICE];
  const base = { ...FAN_OPTIONS, ...(touch ? FAN_TOUCH : {}) };
  // Near a window's edge the inner arc's five kinds would crowd: it moves out (and the colours with it) until they
  // keep their pitch, a few steps at most.
  let best: { faces: FanChoice[][]; spots: FanSpot[][] } | null = null;
  for (let extra = 0; extra <= 48; extra += 8) {
    const options = { ...(touch ? FAN_TOUCH : {}), inner: base.inner + extra };
    const one = fanLayout(cx, cy, w, h, [kinds.length, GLASS_FACES.length], options);
    const far = Math.max(...one.flat().map((s) => Math.hypot(s.x, s.y)));
    const half = Math.ceil(GLASS_FACES.length / 2);
    best =
      far <= (touch ? 165 : 120) + extra
        ? { faces: [kinds, [...GLASS_FACES]], spots: one }
        : { faces: [kinds, GLASS_FACES.slice(0, half), GLASS_FACES.slice(half)], spots: fanLayout(cx, cy, w, h, [kinds.length, half, GLASS_FACES.length - half], options) };
    const inner = best.spots[0]!;
    if (inner.slice(1).every((s, i) => Math.hypot(s.x - inner[i]!.x, s.y - inner[i]!.y) >= base.pitch - 0.5)) break;
  }
  return best!;
}

/** The pictures of our faces (faceArt.ts), once loaded. */
export type FaceSources = Readonly<Record<OurFace, string | { light: string; dark: string }>>;

export interface FaceFanProps {
  anchor: HTMLElement;
  open: boolean;
  openedBy: FanOpenedBy;
  host: string | null;
  /** The agent's name, for the group's label. */
  name: string;
  face: AgentFace;
  sources: FaceSources | null;
  onChoose: (face: AgentFace) => void;
  /** "Your own…" was chosen: the uploaded pictures open. Absent: no "Your own…". */
  onOwn?: () => void;
  /** "Sets" was chosen: the icon sets open. */
  onSets: () => void;
  onClose: () => void;
}

const reduceMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export function FaceFan({ anchor, open, openedBy, host, name, face, sources, onChoose, onOwn, onSets, onClose }: FaceFanProps) {
  const chosen: FanChoice = isOwnFace(face) ? OWN_CHOICE : isSetFace(face) ? SETS_CHOICE : face;
  // Measured once as it opens: the mark's box and the window (nothing is read while the pointer moves).
  const [place, setPlace] = useState<{ rect: DOMRect; w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    if (open) setPlace({ rect: anchor.getBoundingClientRect(), w: window.innerWidth, h: window.innerHeight });
  }, [open, anchor]);
  const touch = openedBy === 'touch';
  const own = onOwn !== undefined;
  const arcs = useMemo(() => (place ? fanArcs(place.rect.left + place.rect.width / 2, place.rect.top + place.rect.height / 2, place.w, place.h, touch, own) : null), [place, touch, own]);
  const order = useMemo<FanChoice[]>(() => arcs?.faces.flat() ?? [], [arcs]);
  // The dial's plate: a half disc out past the farthest choice, turned the way the fan opens.
  const dial = useMemo(() => {
    const spots = arcs?.spots.flat() ?? [];
    const reach = Math.max(0, ...spots.map((s) => Math.hypot(s.x, s.y))) + (touch ? 26 : 20);
    const aim = (Math.atan2(spots.reduce((sum, s) => sum + s.y, 0), spots.reduce((sum, s) => sum + s.x, 0)) * 180) / Math.PI;
    return { reach, aim };
  }, [arcs, touch]);
  const [active, setActive] = useState(0);
  // The first moments of an opening, while the choices travel out.
  const [opening, setOpening] = useState(false);
  useEffect(() => {
    if (!open) return;
    setOpening(true);
    const done = setTimeout(() => setOpening(false), 240);
    return () => clearTimeout(done);
  }, [open]);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => {
    if (open) setActive(Math.max(0, order.indexOf(chosen)));
    // Only as it opens: a choice made while it is open moves nothing.
  }, [open, order]); // eslint-disable-line react-hooks/exhaustive-deps

  // The pointer leaving the mark and the fan closes it, after a short grace. The fan's zone is the disc round the
  // mark out to the farthest choice, on the side the fan opens (so the way from the mark to a choice is inside).
  const closeNow = useRef(onClose);
  closeNow.current = onClose;
  useEffect(() => {
    if (!open || !place || !arcs) return;
    const cx = place.rect.left + place.rect.width / 2;
    const cy = place.rect.top + place.rect.height / 2;
    const spots = arcs.spots.flat();
    const reach = Math.max(...spots.map((s) => Math.hypot(s.x, s.y))) + 22;
    const ax = spots.reduce((sum, s) => sum + s.x, 0);
    const ay = spots.reduce((sum, s) => sum + s.y, 0);
    const len = Math.hypot(ax, ay) || 1;
    const box = place.rect;
    let entered = openedBy === 'hover';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const inside = (x: number, y: number) => {
      if (x >= box.left - 6 && x <= box.right + 6 && y >= box.top - 6 && y <= box.bottom + 6) return true;
      const dx = x - cx;
      const dy = y - cy;
      return Math.hypot(dx, dy) <= reach && (dx * ax + dy * ay) / len >= -18;
    };
    const onMove = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      if (inside(event.clientX, event.clientY)) {
        entered = true;
        clearTimeout(timer);
        timer = undefined;
      } else if (entered && !timer) {
        timer = setTimeout(() => closeNow.current(), FAN_GRACE_MS);
      }
    };
    const onGone = () => closeNow.current();
    // A scroll that moves the mark (the sidebar's, the page's) closes it; a scroll elsewhere (the list) does not.
    const onScroll = (event: Event) => {
      const moved = event.target;
      if (moved === document || (moved instanceof Node && moved.contains(anchor))) closeNow.current();
    };
    // Escape closes it wherever focus is (a fan opened by the pointer has none), and only it: the window's own Escape
    // (closing a thread) skips a used key.
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeNow.current();
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointermove', onMove, { passive: true });
    document.addEventListener('scroll', onScroll, { passive: true, capture: true });
    window.addEventListener('resize', onGone, { passive: true });
    return () => {
      clearTimeout(timer);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('scroll', onScroll, { capture: true });
      window.removeEventListener('resize', onGone);
    };
  }, [open, place, arcs, openedBy, anchor]);

  const move = (to: number) => {
    const n = order.length;
    const next = ((to % n) + n) % n;
    setActive(next);
    items.current[next]?.focus();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const keys: Record<string, () => void> = {
      ArrowDown: () => move(active + 1),
      ArrowRight: () => move(active + 1),
      ArrowUp: () => move(active - 1),
      ArrowLeft: () => move(active - 1),
      Home: () => move(0),
      End: () => move(order.length - 1),
    };
    const go = keys[event.key];
    if (!go) return;
    event.preventDefault();
    event.stopPropagation();
    go();
  };

  const still = reduceMotion();
  const container = tooltipContainerOf(anchor) ?? anchor.closest<HTMLElement>('.pn-inbox') ?? undefined;
  const label = (f: FanChoice) => (f === 'agent' ? agentHostName(host) : f === OWN_CHOICE ? OWN_LABEL : f === SETS_CHOICE ? SETS_LABEL : FACE_LABELS[f]);
  let index = -1;
  return (
    <Popover.Root open={open && !!arcs} onOpenChange={(next) => !next && onClose()} modal={false}>
      <Popover.Portal container={container}>
        <Popover.Positioner
          className="am-fan-pos"
          anchor={anchor}
          side="right"
          align="center"
          sideOffset={place ? -place.rect.width / 2 : 0}
          collisionAvoidance={{ side: 'none', align: 'none', fallbackAxisSide: 'none' }}
          disableAnchorTracking
        >
          <Popover.Popup
            className="am-fan"
            data-still={still ? '' : undefined}
            data-opening={opening ? '' : undefined}
            data-touch={touch ? '' : undefined}
            aria-label={`Icon for ${name}`}
            initialFocus={openedBy === 'keyboard' ? () => items.current[Math.max(0, order.indexOf(chosen))] ?? true : false}
            finalFocus={openedBy === 'keyboard' ? focusBackTo(anchor, '.am-fan') : false}
          >
            <span className="am-fan-dial" aria-hidden="true" style={{ '--r': `${Math.round(dial.reach)}px`, '--a': `${dial.aim.toFixed(1)}deg` } as CSSProperties}>
              <span className="am-fan-shade">
                <span className="am-fan-plate" data-shade="" />
              </span>
              <span className="am-fan-edge">
                <span className="am-fan-plate" />
              </span>
            </span>
            <div role="radiogroup" aria-label={`Icon for ${name}`} className="am-fan-g" onKeyDown={onKeyDown}>
              {arcs?.faces.map((ring, r) =>
                ring.map((f, i) => {
                  index++;
                  const at = index;
                  const spot = arcs.spots[r]![i]!;
                  const src = f === 'agent' || f === OWN_CHOICE || f === SETS_CHOICE ? null : sources?.[f];
                  const style = { '--x': `${spot.x}px`, '--y': `${spot.y}px`, '--d': `${at * 5}ms`, '--dr': `${(order.length - 1 - at) * 3}ms` } as CSSProperties;
                  return (
                    <button
                      key={f}
                      ref={(el) => {
                        items.current[at] = el;
                      }}
                      type="button"
                      role="radio"
                      aria-checked={f === chosen}
                      aria-label={label(f)}
                      tabIndex={at === active ? 0 : -1}
                      className="am-fan-i"
                      data-face-choice={f}
                      style={style}
                      onFocus={() => setActive(at)}
                      // A pointer's press keeps focus where it is. Never a finger's: Safari (iPhone, iPad) then sends no click.
                      onPointerDown={(event: ReactPointerEvent) => {
                        if (event.pointerType !== 'touch') event.preventDefault();
                      }}
                      onClick={() => (f === OWN_CHOICE ? onOwn?.() : f === SETS_CHOICE ? onSets() : onChoose(f))}
                    >
                      <span className="am-fan-f" data-kind={f === 'agent' ? 'agent' : f.startsWith('glass') || f === 'yellow' ? 'glass' : f} aria-hidden="true">
                        {f === 'agent' ? (
                          <HostMark host={host} />
                        ) : f === OWN_CHOICE ? (
                          // The agent's own picture when it shows one (a still), else a dashed "+".
                          isOwnFace(face) ? (
                            <img className="am-own-art" src={ownIconSrc(face, true)} alt="" draggable={false} />
                          ) : (
                            <span className="am-own-add" />
                          )
                        ) : f === SETS_CHOICE ? (
                          // The agent's set icon when it shows one, else a little grid of four.
                          isSetFace(face) ? (
                            <SetArt face={face} />
                          ) : (
                            <span className="am-sets-add">
                              <i />
                              <i />
                              <i />
                              <i />
                            </span>
                          )
                        ) : typeof src === 'string' ? (
                          <img src={src} alt="" draggable={false} />
                        ) : src ? (
                          <>
                            <img className="am-art-l" src={src.light} alt="" draggable={false} />
                            <img className="am-art-d" src={src.dark} alt="" draggable={false} />
                          </>
                        ) : null}
                      </span>
                    </button>
                  );
                }),
              )}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** A set icon drawn in a small box (the fan's place, the panel's grid): an image, or a mask in the text colour. */
export function SetArt({ face }: { face: string }) {
  const drawing = setFaceDrawing(face);
  if (!drawing) return null;
  const { look, src } = drawing;
  return (
    <span
      className="am-sets-art"
      data-pixel={look?.pixelated ? '' : undefined}
      data-mono={look?.mono ? '' : undefined}
      style={setArtStyle(look, src) as CSSProperties}
    >
      {look?.mono ? <span className="am-sets-mono" /> : <img src={src} alt="" draggable={false} />}
    </span>
  );
}
