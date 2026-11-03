/**
 * The list rows' tooltips, set up on first use. A list draws every row of its open sections (719 at the perf
 * suite's XL size), and each row carries three or four tooltips. Mounted with the row, each one's base-ui root,
 * trigger and portal render twice and add four hover listeners, which is most of the cost of drawing the rows
 * (.ops/perf/open-thread-xl.md, fix 2: about 100 ms of the 320 ms it takes to open a thread from the list at XL).
 *
 * `RowTip` takes `Tip`'s props. Inside a list (`LazyRowTips`, which InboxList sets around its rows) it draws the
 * trigger alone, with the attribute base-ui's trigger adds, until the pointer enters it or it takes focus; then it
 * mounts the very `Tip` it stands for, so the delay, the 400 ms run of instant tips, `cut`, `when` and Escape are
 * `Tip`'s own. Anywhere else, and wherever `open` is given (a badge's card shows while its row has keyboard focus),
 * it is `Tip` from the start.
 *
 * The trigger arms in the task after the pointer's entry, never inside it: a press with no hover before it (a pen's
 * first touch) brings its own over events, and an element drawn again there would take the press's down and click
 * with it. A press that reaches the unarmed trigger arms nothing, as `Tip` would let it cancel the open; the next entry
 * arms it. The trigger element is drawn again when the tip mounts (another component holds it), so the pointer that
 * armed it is already inside: the tip is told so with the mouseenter, and the last move if one came, that the
 * pointer sent the element before (`greet`), and opens as if it had been there all along. A mouseover with no pointer
 * event before it (the browser's own, when the rows were drawn again under a pointer at rest) arms it too, with no
 * move: as before, the tip opens once the pointer moves. A trigger that arms on keyboard focus gets the focus back. A
 * touch, or a screen with no hover, never arms a trigger: a tip never opens for one.
 */
import { cloneElement, createContext, useContext, useEffect, useMemo, useRef, useState, type ComponentProps, type FocusEvent, type MouseEvent as ReactMouseEvent, type PointerEvent, type ReactElement, type Ref } from 'react';
import { flushSync } from 'react-dom';
import { noHover } from '@plannotator/ui/utils/textCut';
import { Tip } from './Tip';

/** True around the list's rows: their `RowTip`s wait for the pointer or focus. False (the default): `Tip`. */
export const LazyRowTips = createContext(false);

type TipProps = ComponentProps<typeof Tip>;

export interface RowTipProps extends TipProps {
  /**
   * Mount now, without waiting for this trigger's own pointer or focus. A row's hover action, which takes focus
   * from the row (a Tab), is armed by its row before it can take focus, so focus never lands on a trigger that is
   * about to be drawn again.
   */
  armed?: boolean;
}

/** `Tip`, mounted on first use inside a list's rows (`LazyRowTips`). */
export function RowTip({ armed = false, ...tip }: RowTipProps) {
  const lazy = useContext(LazyRowTips);
  if (!lazy || tip.open !== undefined) return <Tip {...tip} />;
  return <LazyTip armed={armed} {...tip} />;
}

/**
 * A pointer that can open a tip: a mouse or a pen, on a screen that hovers. A touch's hover is a first tap, and a
 * screen with no hover (a tablet's pen) opens no tip (`Tip`).
 */
export function opensTips(event: PointerEvent): boolean {
  return event.pointerType !== 'touch' && !noHover();
}

/** An entry waiting for its task: where the pointer came in, the element it came into, and its last move there. */
interface Entry {
  timer: ReturnType<typeof setTimeout>;
  at: { x: number; y: number };
  drawn: HTMLElement;
  move: MouseEventInit | null;
}

function LazyTip({ armed: armedByRow, children, ...tip }: TipProps & { armed: boolean }) {
  const [armedHere, setArmedHere] = useState(false);
  const node = useRef<HTMLElement | null>(null);
  const entry = useRef<Entry | null>(null);
  // A press came to the trigger before it armed: its focus arms nothing.
  const pressed = useRef(false);
  const ownRef = (children.props as { ref?: Ref<HTMLElement> }).ref;
  // One ref for as long as the child's own: a new one each render would have base-ui drop and register the trigger again.
  const ref = useMemo(() => mergeRefs(ownRef, node), [ownRef]);
  useEffect(() => () => {
    if (entry.current) clearTimeout(entry.current.timer);
  }, []);
  const armed = armedByRow || armedHere;
  if (armed) {
    return <Tip {...tip}>{cloneElement(children as ReactElement<{ ref?: Ref<HTMLElement> }>, { ref })}</Tip>;
  }
  const props = children.props as {
    onPointerEnter?: (e: PointerEvent<HTMLElement>) => void;
    onPointerOver?: (e: PointerEvent<HTMLElement>) => void;
    onMouseOver?: (e: ReactMouseEvent<HTMLElement>) => void;
    onMouseMove?: (e: ReactMouseEvent<HTMLElement>) => void;
    onPointerLeave?: (e: PointerEvent<HTMLElement>) => void;
    onPointerDown?: (e: PointerEvent<HTMLElement>) => void;
    onFocus?: (e: FocusEvent<HTMLElement>) => void;
  };
  const drop = () => {
    if (entry.current) clearTimeout(entry.current.timer);
    entry.current = null;
  };
  // Armed in the next task, never inside the event: a press with no hover before it (a pen's first touch) brings its
  // own over events, and a trigger drawn again there would take the press's down and click with the old element.
  const enter = (event: ReactMouseEvent<HTMLElement>) => {
    pressed.current = false;
    const at = { x: event.clientX, y: event.clientY };
    if (entry.current) {
      entry.current.at = at;
      return;
    }
    const timer = setTimeout(() => {
      const waiting = entry.current;
      entry.current = null;
      if (!waiting) return;
      flushSync(() => setArmedHere(true));
      greet(node.current, waiting);
    }, 0);
    entry.current = { timer, at, drawn: event.currentTarget, move: null };
  };
  const trigger = {
    // base-ui's trigger marks its element so; drawn the same before the tip mounts.
    'data-base-ui-tooltip-trigger': '',
    // React's enter, from the pointerout of what the pointer left: the earliest event of the move.
    onPointerEnter: (event: PointerEvent<HTMLElement>) => {
      props.onPointerEnter?.(event);
      if (opensTips(event)) enter(event);
    },
    // React derives no enter when what the pointer left was itself just drawn again (its out reached no one):
    // the over events always come.
    onPointerOver: (event: PointerEvent<HTMLElement>) => {
      props.onPointerOver?.(event);
      if (opensTips(event)) enter(event);
    },
    onMouseOver: (event: ReactMouseEvent<HTMLElement>) => {
      props.onMouseOver?.(event);
      if (!fromTouch(event.nativeEvent)) enter(event);
    },
    onMouseMove: (event: ReactMouseEvent<HTMLElement>) => {
      props.onMouseMove?.(event);
      const { clientX, clientY, movementX, movementY } = event;
      if (entry.current) entry.current.move = { clientX, clientY, movementX, movementY };
    },
    onPointerLeave: (event: PointerEvent<HTMLElement>) => {
      props.onPointerLeave?.(event);
      pressed.current = false;
      drop();
    },
    // A press before the trigger armed: `Tip` would have let it cancel the open, and its tip would wait for the
    // pointer to leave and come back. So does this one: the press arms nothing, the next entry does.
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      props.onPointerDown?.(event);
      pressed.current = true;
      drop();
    },
    onFocus: (event: FocusEvent<HTMLElement>) => {
      props.onFocus?.(event);
      if (pressed.current) return;
      drop();
      flushSync(() => setArmedHere(true));
      node.current?.focus({ preventScroll: true });
    },
  };
  // A control that can be disabled has its tip on a wrapper (`Tip`), so the wrapper is the trigger.
  if ('disabled' in (children.props as object)) {
    return (
      <span className="ib-tipwrap" data-tip-wrap="" {...trigger}>
        {children}
      </span>
    );
  }
  return cloneElement(children as ReactElement<typeof trigger>, trigger);
}

/**
 * The pointer is on the trigger that was just drawn: send it what that pointer sent the one before it (`drawn`, no
 * longer in the page). base-ui's tooltip opens from these two: its `mouseenter` listener (at once within the 400 ms
 * run), then React's `onMouseMove` starting the 150 ms rest. Its listeners are in place: `flushSync` ran the effects
 * that add them. The move is passed on only if one came: when the rows were drawn again under a pointer at rest, the
 * browser's over events come with no move, and as before the tip waits for the pointer to move.
 */
function greet(node: HTMLElement | null, entry: Entry): void {
  const trigger = node?.parentElement?.hasAttribute('data-tip-wrap') ? node.parentElement : node;
  if (!trigger?.isConnected || trigger === entry.drawn) return;
  trigger.dispatchEvent(new MouseEvent('mouseenter', { clientX: entry.at.x, clientY: entry.at.y, view: window }));
  if (entry.move) trigger.dispatchEvent(new MouseEvent('mousemove', { ...entry.move, bubbles: true, cancelable: true, view: window }));
  watchLeave(trigger);
}

/** A mouse event a touch sent (a tap's compatibility events), or any on a screen with no hover. */
function fromTouch(event: MouseEvent): boolean {
  if (noHover()) return true;
  return (event as MouseEvent & { sourceCapabilities?: { firesTouchEvents?: boolean } }).sourceCapabilities?.firesTouchEvents === true;
}

/**
 * The browser may still hold the element it replaced as the one under the pointer, and then never tells the new
 * trigger the pointer left (a row's hover action that shows over the delivery tick the pointer just reached: the
 * pointer is on the action without moving). Until a real `mouseleave` reaches the trigger, the first real event over
 * anything else stands in for it: the trigger gets the `mouseleave` base-ui waits for, so its tip never opens late.
 */
function watchLeave(trigger: HTMLElement): void {
  const doc = trigger.ownerDocument;
  const stop = () => {
    doc.removeEventListener('mouseover', elsewhere, true);
    doc.removeEventListener('mousemove', elsewhere, true);
    trigger.removeEventListener('mouseleave', left);
  };
  const left = (event: MouseEvent) => {
    if (event.isTrusted) stop();
  };
  const elsewhere = (event: MouseEvent) => {
    if (!event.isTrusted) return;
    if (!trigger.isConnected) return stop();
    const target = event.target as Node | null;
    if (target && trigger.contains(target)) return;
    stop();
    trigger.dispatchEvent(new MouseEvent('mouseleave', { clientX: event.clientX, clientY: event.clientY, relatedTarget: target as Element | null, view: window }));
  };
  doc.addEventListener('mouseover', elsewhere, true);
  doc.addEventListener('mousemove', elsewhere, true);
  trigger.addEventListener('mouseleave', left);
}

function mergeRefs<T>(a: Ref<T> | undefined, b: { current: T | null }): (value: T | null) => void {
  return (value) => {
    b.current = value;
    if (typeof a === 'function') a(value);
    else if (a) (a as { current: T | null }).current = value;
  };
}
