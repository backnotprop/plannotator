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

export const FAN_DWELL_MS = 350;

export const FAN_PRESS_MS = 450;
export const FAN_GRACE_MS = 140;

export type FanOpenedBy = 'hover' | 'keyboard' | 'touch';

export const FAN_TOUCH: Partial<FanOptions> = { pitch: 44, item: 40, inner: 64, between: 52 };

export const OWN_CHOICE = 'own';
export const SETS_CHOICE = 'sets';
export type FanChoice = Exclude<AgentFace, `own:${string}` | `set:${string}`> | typeof OWN_CHOICE | typeof SETS_CHOICE;
export const OWN_LABEL = 'Your own…';
export const SETS_LABEL = 'Sets';

export function fanArcs(cx: number, cy: number, w: number, h: number, touch = false): { faces: FanChoice[][]; spots: FanSpot[][] } {
  const kinds: FanChoice[] = ['agent', 'transparent', 'totman', OWN_CHOICE, SETS_CHOICE];
  const base = { ...FAN_OPTIONS, ...(touch ? FAN_TOUCH : {}) };
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

export type FaceSources = Readonly<Record<OurFace, string | { light: string; dark: string }>>;

export interface FaceFanProps {
  anchor: HTMLElement;
  open: boolean;
  openedBy: FanOpenedBy;
  host: string | null;
  name: string;
  face: AgentFace;
  sources: FaceSources | null;
  onChoose: (face: AgentFace) => void;
  onOwn: () => void;
  onSets: () => void;
  onClose: () => void;
}

const reduceMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export function FaceFan({ anchor, open, openedBy, host, name, face, sources, onChoose, onOwn, onSets, onClose }: FaceFanProps) {
  const chosen: FanChoice = isOwnFace(face) ? OWN_CHOICE : isSetFace(face) ? SETS_CHOICE : face;
  const [place, setPlace] = useState<{ rect: DOMRect; w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    if (open) setPlace({ rect: anchor.getBoundingClientRect(), w: window.innerWidth, h: window.innerHeight });
  }, [open, anchor]);
  const touch = openedBy === 'touch';
  const arcs = useMemo(() => (place ? fanArcs(place.rect.left + place.rect.width / 2, place.rect.top + place.rect.height / 2, place.w, place.h, touch) : null), [place, touch]);
  const order = useMemo<FanChoice[]>(() => arcs?.faces.flat() ?? [], [arcs]);
  const dial = useMemo(() => {
    const spots = arcs?.spots.flat() ?? [];
    const reach = Math.max(0, ...spots.map((s) => Math.hypot(s.x, s.y))) + (touch ? 26 : 20);
    const aim = (Math.atan2(spots.reduce((sum, s) => sum + s.y, 0), spots.reduce((sum, s) => sum + s.x, 0)) * 180) / Math.PI;
    return { reach, aim };
  }, [arcs, touch]);
  const [active, setActive] = useState(0);
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
  }, [open, order]);

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
    const onScroll = (event: Event) => {
      const moved = event.target;
      if (moved === document || (moved instanceof Node && moved.contains(anchor))) closeNow.current();
    };
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
                      onPointerDown={(event: ReactPointerEvent) => {
                        if (event.pointerType !== 'touch') event.preventDefault();
                      }}
                      onClick={() => (f === OWN_CHOICE ? onOwn() : f === SETS_CHOICE ? onSets() : onChoose(f))}
                    >
                      <span className="am-fan-f" data-kind={f === 'agent' ? 'agent' : f.startsWith('glass') || f === 'yellow' ? 'glass' : f} aria-hidden="true">
                        {f === 'agent' ? (
                          <HostMark host={host} />
                        ) : f === OWN_CHOICE ? (
                          isOwnFace(face) ? (
                            <img className="am-own-art" src={ownIconSrc(face, true)} alt="" draggable={false} />
                          ) : (
                            <span className="am-own-add" />
                          )
                        ) : f === SETS_CHOICE ? (
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
