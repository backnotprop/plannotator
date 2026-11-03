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
 * The trigger element is drawn again when the tip mounts (another component holds it), so the pointer that armed it
 * is already inside: the tip is told so with the mouseenter and mousemove that pointer would have sent (`greet`),
 * synchronously in the same event, and opens as if it had been there all along. A trigger that arms on focus gets
 * the focus back. A touch never arms a trigger: a tip never opens for one.
 */
import { cloneElement, createContext, useContext, useRef, useState, type ComponentProps, type FocusEvent, type PointerEvent, type ReactElement, type Ref } from 'react';
import { flushSync } from 'react-dom';
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

/** A pointer that can open a tip: a mouse or a pen. A touch's hover is a first tap, and opens nothing. */
export function opensTips(event: PointerEvent): boolean {
  return event.pointerType !== 'touch';
}

function LazyTip({ armed: armedByRow, children, ...tip }: TipProps & { armed: boolean }) {
  const [armedHere, setArmedHere] = useState(false);
  const node = useRef<HTMLElement | null>(null);
  const armed = armedByRow || armedHere;
  const ownRef = (children.props as { ref?: Ref<HTMLElement> }).ref;
  if (armed) {
    return <Tip {...tip}>{cloneElement(children as ReactElement<{ ref?: Ref<HTMLElement> }>, { ref: mergeRefs(ownRef, node) })}</Tip>;
  }
  const props = children.props as { onPointerEnter?: (e: PointerEvent<HTMLElement>) => void; onFocus?: (e: FocusEvent<HTMLElement>) => void };
  const trigger = {
    // base-ui's trigger marks its element so; drawn the same before the tip mounts.
    'data-base-ui-tooltip-trigger': '',
    onPointerEnter: (event: PointerEvent<HTMLElement>) => {
      props.onPointerEnter?.(event);
      if (!opensTips(event)) return;
      const at = { x: event.clientX, y: event.clientY };
      flushSync(() => setArmedHere(true));
      greet(node.current, at);
    },
    onFocus: (event: FocusEvent<HTMLElement>) => {
      props.onFocus?.(event);
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
 * The pointer is on the trigger that was just drawn: send it what that pointer sent the one before it. base-ui's
 * tooltip opens from these two (its `mouseenter` listener, then React's `onMouseMove` starting the 150 ms rest, or
 * opening at once within the 400 ms run). Its listeners are in place: `flushSync` ran the effects that add them.
 */
function greet(node: HTMLElement | null, at: { x: number; y: number }): void {
  const trigger = node?.parentElement?.hasAttribute('data-tip-wrap') ? node.parentElement : node;
  if (!trigger?.isConnected) return;
  const init = { clientX: at.x, clientY: at.y, view: window };
  trigger.dispatchEvent(new MouseEvent('mouseenter', init));
  trigger.dispatchEvent(new MouseEvent('mousemove', { ...init, bubbles: true, cancelable: true }));
}

function mergeRefs<T>(a: Ref<T> | undefined, b: { current: T | null }): (value: T | null) => void {
  return (value) => {
    b.current = value;
    if (typeof a === 'function') a(value);
    else if (a) (a as { current: T | null }).current = value;
  };
}
