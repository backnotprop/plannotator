import { cloneElement, createContext, useContext, useEffect, useMemo, useRef, useState, type ComponentProps, type FocusEvent, type MouseEvent as ReactMouseEvent, type PointerEvent, type ReactElement, type Ref } from 'react';
import { flushSync } from 'react-dom';
import { noHover } from '@plannotator/ui/utils/textCut';
import { Tip } from './Tip';

export const LazyRowTips = createContext(false);

type TipProps = ComponentProps<typeof Tip>;

export interface RowTipProps extends TipProps {
  armed?: boolean;
}

export function RowTip({ armed = false, ...tip }: RowTipProps) {
  const lazy = useContext(LazyRowTips);
  if (!lazy || tip.open !== undefined) return <Tip {...tip} />;
  return <LazyTip armed={armed} {...tip} />;
}

export function opensTips(event: PointerEvent): boolean {
  return event.pointerType !== 'touch' && !noHover();
}

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
  const pressed = useRef(false);
  const ownRef = (children.props as { ref?: Ref<HTMLElement> }).ref;
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
  const enter = (event: ReactMouseEvent<HTMLElement>) => {
    if (pressed.current) return;
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
    'data-base-ui-tooltip-trigger': '',
    onPointerEnter: (event: PointerEvent<HTMLElement>) => {
      props.onPointerEnter?.(event);
      if (opensTips(event)) enter(event);
    },
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
  if ('disabled' in (children.props as object)) {
    return (
      <span className="ib-tipwrap" data-tip-wrap="" {...trigger}>
        {children}
      </span>
    );
  }
  return cloneElement(children as ReactElement<typeof trigger>, trigger);
}

function greet(node: HTMLElement | null, entry: Entry): void {
  const trigger = node?.parentElement?.hasAttribute('data-tip-wrap') ? node.parentElement : node;
  if (!trigger?.isConnected || trigger === entry.drawn) return;
  trigger.dispatchEvent(new MouseEvent('mouseenter', { clientX: entry.at.x, clientY: entry.at.y, view: window }));
  if (entry.move) trigger.dispatchEvent(new MouseEvent('mousemove', { ...entry.move, bubbles: true, cancelable: true, view: window }));
  watchLeave(trigger);
}

function fromTouch(event: MouseEvent): boolean {
  if (noHover()) return true;
  return (event as MouseEvent & { sourceCapabilities?: { firesTouchEvents?: boolean } }).sourceCapabilities?.firesTouchEvents === true;
}

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
