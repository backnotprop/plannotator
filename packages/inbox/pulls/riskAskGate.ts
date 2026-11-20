import { useEffect, useRef, useState, type RefObject } from 'react';
import { pageBusy } from '../idleClock';

export const RISK_ASK_TIMING = { settleMs: 600, guardMs: 400, tickMs: 100 };

export function useSettled(want: boolean): boolean {
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    setSettled(false);
    if (!want) return;
    let quietSince = Date.now();
    let pointers = 0;
    const keys = new Set<string>();
    const press = () => {
      quietSince = Date.now();
    };
    const pointerDown = () => {
      pointers += 1;
      press();
    };
    const pointerUp = () => {
      pointers = Math.max(0, pointers - 1);
      press();
    };
    const keyDown = (event: KeyboardEvent) => {
      keys.add(event.code || event.key);
      press();
    };
    const keyUp = (event: KeyboardEvent) => {
      keys.delete(event.code || event.key);
      press();
    };
    const away = () => {
      keys.clear();
      pointers = 0;
      press();
    };
    const listeners: [string, EventListener][] = [
      ['pointerdown', pointerDown],
      ['pointerup', pointerUp],
      ['pointercancel', pointerUp],
      ['keydown', keyDown as EventListener],
      ['keyup', keyUp as EventListener],
      ['blur', away],
    ];
    for (const [type, listener] of listeners) window.addEventListener(type, listener, true);
    const tick = setInterval(() => {
      if (pageBusy() || pointers > 0 || keys.size > 0) press();
      else if (Date.now() - quietSince >= RISK_ASK_TIMING.settleMs) setSettled(true);
    }, RISK_ASK_TIMING.tickMs);
    return () => {
      for (const [type, listener] of listeners) window.removeEventListener(type, listener, true);
      clearInterval(tick);
    };
  }, [want]);
  return want && settled;
}

export function usePressGate(host: RefObject<HTMLElement | null>): { armed: boolean; ok: () => boolean } {
  const shownAt = useRef(Date.now());
  const fresh = useRef(false);
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setArmed(true), RISK_ASK_TIMING.guardMs);
    const dialog = host.current?.closest('dialog');
    if (!dialog) return () => clearTimeout(timer);
    const early = () => Date.now() - shownAt.current < RISK_ASK_TIMING.guardMs;
    const stop = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    const inside = (event: Event) => event.target instanceof Node && dialog.contains(event.target);
    const keyDown = (event: KeyboardEvent) => {
      if (!inside(event)) return;
      fresh.current = !event.repeat && !early();
      if (!fresh.current) stop(event);
    };
    const keyUp = (event: KeyboardEvent) => {
      if (inside(event) && !fresh.current) stop(event);
    };
    const pointerDown = (event: PointerEvent) => {
      if (inside(event)) fresh.current = !early();
    };
    const click = (event: MouseEvent) => {
      if (inside(event) && !fresh.current) stop(event);
    };
    window.addEventListener('keydown', keyDown, true);
    window.addEventListener('keyup', keyUp, true);
    window.addEventListener('pointerdown', pointerDown, true);
    window.addEventListener('click', click, true);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', keyDown, true);
      window.removeEventListener('keyup', keyUp, true);
      window.removeEventListener('pointerdown', pointerDown, true);
      window.removeEventListener('click', click, true);
    };
  }, []);
  return { armed, ok: () => fresh.current && Date.now() - shownAt.current >= RISK_ASK_TIMING.guardMs };
}
