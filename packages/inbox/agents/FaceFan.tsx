import { Popover } from '@base-ui/react/popover';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { isInboxMarkFace } from '@plannotator/core/inbox-types';
import { tooltipContainerOf } from '@plannotator/ui/components/HostTitle';
import { HostMark } from '../icons';
import { agentHostName } from './model';
import { FACE_LABELS, GLASS_FACES, isOwnFace, type AgentFace, type OurFace } from './faceChoices';
import { ownIconSrc } from './ownIcons';
import { isSetFace, setArtStyle, setFaceDrawing } from './iconSets';
import { FAN_OPTIONS, fanLayout, type FanOptions, type FanSpot } from './fanLayout';
import { focusBackTo } from './focusBack';
import { PROJECT_FACE_LABEL, ProjectFaceMark, useAgentProjectTile } from './projectFace';
import { useAgentTakesTiles } from './agentFaces';

/**
 * The face picker: a half-circle fan of an agent mark's faces round the mark, like a sundial's upper half laid on its
 * side (it opens toward the content; the mark sits at the sidebar's left edge). The inner arc holds the kinds (the
 * agent's own mark, its project's tile, Transparent, Face), the outer one the Glass colours; near the window's edges it turns away and,
 * short of room, the colours split over two short arcs. An overlay (Base UI's Popover, portaled), so the list never
 * moves.
 *
 * Opens: a click or a tap on the mark, the pointer resting on it for FAN_DWELL_MS (a pointer passing over opens
 * nothing), Enter or Space on the focused mark, or a long press on a touch screen. Closes: a second click on the mark
 * (the plate lies over it, so that click reaches onMark), the pointer leaving the mark and the fan (a short grace, and
 * the room between them counts as the fan's), Escape, a press outside, a scroll or resize, or a choice.
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
/** A place in the fan: a face, "Your own…" or "Sets". Another host's mark (`mark:<host>`) has none: it is a mark, in the own mark's place. */
export type FanChoice = Exclude<AgentFace, `own:${string}` | `set:${string}` | `mark:${string}`> | typeof OWN_CHOICE | typeof SETS_CHOICE;
export const OWN_LABEL = 'Your own…';
export const SETS_LABEL = 'Sets';

/**
 * The fan's arcs: the kinds inside, the Glass colours outside (one arc, or two short ones when room is short). `own`:
 * "Your own…" among the kinds (not for a linked machine's agent, AgentMark.tsx). `project`: "From the project name"
 * second, after the agent's own mark (approval "inbox-generated-agent-icons"; only for an agent whose project has a
 * name to draw). `places`: a project's picker (ProjectMarkPicker.tsx), its own places on the two arcs instead.
 */
export function fanArcs<T extends string = FanChoice>(cx: number, cy: number, w: number, h: number, touch = false, own = true, project = false, grow = 0, places?: { inner: readonly T[]; outer: readonly T[] }): { faces: T[][]; spots: FanSpot[][] } {
  const base = { ...FAN_OPTIONS, ...(touch ? FAN_TOUCH : {}) };
  const kinds = (places ? [...places.inner] : ['agent', ...(project ? ['project'] : []), 'transparent', 'totman', ...(own ? [OWN_CHOICE] : []), SETS_CHOICE]) as T[];
  const outer = (places ? places.outer : GLASS_FACES) as readonly T[];
  if (outer.length === 0) return { faces: [kinds], spots: fanLayout(cx, cy, w, h, [kinds.length], { ...(touch ? FAN_TOUCH : {}), inner: base.inner + grow }) };
  // Near a window's edge the inner arc's five kinds would crowd: it moves out (and the colours with it) until they
  // keep their pitch, a few steps at most.
  let best: { faces: T[][]; spots: FanSpot[][] } | null = null;
  for (let extra = 0; extra <= 48; extra += 8) {
    const options = { ...(touch ? FAN_TOUCH : {}), inner: base.inner + extra + grow };
    const one = fanLayout(cx, cy, w, h, [kinds.length, outer.length], options);
    const far = Math.max(...one.flat().map((s) => Math.hypot(s.x, s.y)));
    const half = Math.ceil(outer.length / 2);
    best =
      far <= (touch ? 165 : 120) + extra + grow
        ? { faces: [kinds, [...outer]], spots: one }
        : { faces: [kinds, outer.slice(0, half), outer.slice(half)], spots: fanLayout(cx, cy, w, h, [kinds.length, half, outer.length - half], options) };
    const inner = best.spots[0]!;
    if (inner.slice(1).every((s, i) => Math.hypot(s.x - inner[i]!.x, s.y - inner[i]!.y) >= base.pitch - 0.5)) break;
  }
  return best!;
}

/** A place in a project's picker: its id, its name, what it draws and what a press does. */
export interface FanPlace {
  id: string;
  label: string;
  node: ReactNode;
  onPick: () => void;
}

/** The pictures of our faces (faceArt.ts), once loaded. */
export type FaceSources = Readonly<Record<OurFace, string | { light: string; dark: string }>>;

export interface FaceFanProps {
  anchor: HTMLElement;
  open: boolean;
  openedBy: FanOpenedBy;
  host: string | null;
  /** The agent's id: its project's tile ("From the project name"). Absent: no such choice. */
  agent?: string;
  /** The agent's name, for the group's label. */
  name: string;
  face: AgentFace;
  sources: FaceSources | null;
  onChoose: (face: AgentFace) => void;
  /** "Your own…" was chosen: the uploaded pictures open. Absent: no "Your own…". */
  onOwn?: () => void;
  /** "Sets" was chosen: the icon sets open. */
  onSets: () => void;
  /** A click on the fan's plate where the mark is under it: the mark's own click. */
  onMark: () => void;
  onClose: () => void;
  /**
   * A project's picker (components/ProjectMarkPicker.tsx): its own places on the two arcs, each drawn and pressed as it
   * says, and `checked`, the place of the look it shows (null: none).
   */
  project?: { inner: readonly FanPlace[]; outer: readonly FanPlace[]; checked: string | null };
}

const reduceMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export function FaceFan({ anchor, open, openedBy, host, agent, name, face, sources, onChoose, onOwn, onSets, onMark, onClose, project: forProject }: FaceFanProps) {
  const chosen: string | null = forProject ? forProject.checked : isOwnFace(face) ? OWN_CHOICE : isSetFace(face) ? SETS_CHOICE : isInboxMarkFace(face) ? 'agent' : face;
  // Measured once as it opens: the mark's box and the room the choices keep inside, the window, or the list's pane for
  // a mark in the list (the Agents view's faces: no choice over the sidebar). Nothing is read while the pointer moves.
  // Nothing clips the fan or anything above its plate (agents.css: a clip, a filter or a mask there stops the blur).
  const [place, setPlace] = useState<{ rect: DOMRect; w: number; h: number; room: { left: number; top: number; width: number; height: number } } | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const w = window.innerWidth, h = window.innerHeight;
    const pane = anchor.closest('.ib-listcol')?.getBoundingClientRect();
    const left = Math.max(0, pane?.left ?? 0), top = Math.max(0, pane?.top ?? 0);
    const room = { left, top, width: Math.min(w, pane?.right ?? w) - left, height: Math.min(h, pane?.bottom ?? h) - top };
    setPlace({ rect: anchor.getBoundingClientRect(), w, h, room });
  }, [open, anchor]);
  const touch = openedBy === 'touch';
  const own = onOwn !== undefined;
  // Offered for an agent with a project, on a machine that keeps a tile (a linked one from before tiles keeps none).
  const takesTiles = useAgentTakesTiles(agent);
  const project = useAgentProjectTile(agent) !== null && takesTiles;
  // A mark larger than the sidebar's (its button past 28 px: the Agents view's 44): the arcs and the plate's hole move
  // out by half the difference, so the choices keep their room round it.
  const grow = place ? Math.max(0, Math.round((Math.min(place.rect.width, place.rect.height) - 28) / 2)) : 0;
  // A project's places by id; the ids alone lay out the arcs, so a redraw with the same places moves nothing.
  const projectKey = forProject ? `${forProject.inner.map((p) => p.id).join()}|${forProject.outer.map((p) => p.id).join()}` : '';
  const projectIds = useMemo(() => (forProject ? { inner: forProject.inner.map((p) => p.id), outer: forProject.outer.map((p) => p.id) } : undefined), [projectKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const placeById = new Map((forProject ? [...forProject.inner, ...forProject.outer] : []).map((p) => [p.id, p]));
  const arcs = useMemo(
    () => (place ? fanArcs(place.rect.left + place.rect.width / 2 - place.room.left, place.rect.top + place.rect.height / 2 - place.room.top, place.room.width, place.room.height, touch, own, project, grow, projectIds) : null),
    [place, touch, own, project, grow, projectIds],
  );
  const order = useMemo<string[]>(() => arcs?.faces.flat() ?? [], [arcs]);
  // The dial's plate: a half disc out past the farthest choice, turned the way the fan opens.
  const dial = useMemo(() => {
    const spots = arcs?.spots.flat() ?? [];
    const reach = Math.max(0, ...spots.map((s) => Math.hypot(s.x, s.y))) + (touch ? 26 : 20);
    const aim = (Math.atan2(spots.reduce((sum, s) => sum + s.y, 0), spots.reduce((sum, s) => sum + s.x, 0)) * 180) / Math.PI;
    return { reach, aim };
  }, [arcs, touch]);
  const [active, setActive] = useState(0);
  // An opening, until the choices rest in their places: they take no pointer (CSS), and a press that began meanwhile
  // chooses nothing when it lands on one. Settled is the fan's box still for a frame with Base UI's starting style gone,
  // then every choice's travel finished: a slow device's frames, not a clock, decide it.
  const [opening, setOpening] = useState(false);
  const settled = useRef(false);
  const pressSettled = useRef(false);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => {
    if (!open || !arcs) return;
    settled.current = false;
    setOpening(true);
    let gone = false;
    let frame = 0;
    let box = '';
    const settle = () => {
      if (gone) return;
      settled.current = true;
      setOpening(false);
    };
    const look = () => {
      const popup = items.current.find(Boolean)?.closest<HTMLElement>('.am-fan');
      const rect = popup?.getBoundingClientRect();
      const now = rect ? `${rect.left},${rect.top},${rect.width},${rect.height}` : '';
      if (!popup || popup.hasAttribute('data-starting-style') || now !== box) {
        box = now;
        frame = requestAnimationFrame(look);
        return;
      }
      const travel = items.current.slice(0, order.length).flatMap((el) => el?.getAnimations?.() ?? []);
      void Promise.all(travel.map((animation) => animation.finished)).then(settle, settle);
    };
    frame = requestAnimationFrame(look);
    return () => {
      gone = true;
      cancelAnimationFrame(frame);
    };
  }, [open, arcs, order]);
  useEffect(() => {
    if (open) setActive(chosen === null ? 0 : Math.max(0, order.indexOf(chosen)));
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
  const label = (f: FanChoice) => (f === 'agent' || f === 'mark' ? agentHostName(host) : f === 'project' ? PROJECT_FACE_LABEL : f === OWN_CHOICE ? OWN_LABEL : f === SETS_CHOICE ? SETS_LABEL : FACE_LABELS[f]);
  let index = -1;
  return (
    <Popover.Root
      open={open && !!arcs}
      onOpenChange={(next, details) => {
        // A press on the mark is the mark's own (AgentMark.tsx opens and closes the fan on its click).
        if (next || (details.reason === 'outside-press' && details.event.target instanceof Node && anchor.contains(details.event.target))) return;
        onClose();
      }}
      modal={false}
    >
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
            initialFocus={openedBy === 'keyboard' ? () => items.current[chosen === null ? 0 : Math.max(0, order.indexOf(chosen))] ?? true : false}
            finalFocus={openedBy === 'keyboard' ? focusBackTo(anchor, '.am-fan') : false}
            onPointerDownCapture={() => {
              pressSettled.current = settled.current;
            }}
            onClick={(event) => {
              // A choice took the click, unless a pointer pressed before the choices rested (detail 0 is a key's click).
              const onChoice = event.target instanceof Element && event.target.closest('[data-face-choice]');
              if (!place || (onChoice && (event.detail === 0 || pressSettled.current))) return;
              const box = place.rect;
              if (event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom) onMark();
            }}
          >
            <span className="am-fan-dial" aria-hidden="true" style={{ '--r': `${Math.round(dial.reach)}px`, '--a': `${dial.aim.toFixed(1)}deg`, ...(grow > 0 ? { '--grow': `${grow}px` } : {}) } as CSSProperties}>
              <span className="am-fan-shade">
                <span className="am-fan-plate" data-shade="" />
              </span>
              <span className="am-fan-edge">
                <span className="am-fan-plate" />
              </span>
            </span>
            <div role="radiogroup" aria-label={`Icon for ${name}`} className="am-fan-g" onKeyDown={onKeyDown}>
              {arcs?.faces.map((ring, r) =>
                ring.map((id, i) => {
                  index++;
                  const at = index;
                  const spot = arcs.spots[r]![i]!;
                  const projectPlace = placeById.get(id);
                  const f = id as FanChoice;
                  const src = projectPlace || f === 'agent' || f === 'mark' || f === 'project' || f === OWN_CHOICE || f === SETS_CHOICE ? null : sources?.[f];
                  const style = { '--x': `${spot.x}px`, '--y': `${spot.y}px`, '--d': `${at * 5}ms`, '--dr': `${(order.length - 1 - at) * 3}ms` } as CSSProperties;
                  return (
                    <button
                      key={id}
                      ref={(el) => {
                        items.current[at] = el;
                      }}
                      type="button"
                      role="radio"
                      aria-checked={id === chosen}
                      aria-label={projectPlace ? projectPlace.label : label(f)}
                      title={projectPlace ? projectPlace.label : f === 'project' ? label(f) : undefined}
                      tabIndex={at === active ? 0 : -1}
                      className="am-fan-i"
                      data-face-choice={id}
                      style={style}
                      onFocus={() => setActive(at)}
                      // A pointer's press keeps focus where it is. Never a finger's: Safari (iPhone, iPad) then sends no click.
                      onPointerDown={(event: ReactPointerEvent) => {
                        if (event.pointerType !== 'touch') event.preventDefault();
                      }}
                      onClick={(event) => {
                        if (event.detail !== 0 && !pressSettled.current) return;
                        if (projectPlace) projectPlace.onPick();
                        else if (f === OWN_CHOICE) onOwn?.();
                        else if (f === SETS_CHOICE) onSets();
                        else onChoose(f);
                      }}
                    >
                      <span className="am-fan-f" data-kind={projectPlace ? 'place' : f === 'agent' || f === 'project' ? f : f.startsWith('glass') || f === 'yellow' ? 'glass' : f} aria-hidden="true">
                        {projectPlace ? (
                          projectPlace.node
                        ) : f === 'agent' ? (
                          <HostMark host={host} />
                        ) : f === 'project' ? (
                          <ProjectFaceMark agent={agent} host={host} badge={false} />
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
