import { useEffect, useRef, useState, type RefObject } from 'react';
import { pageAttentive, pageBusy } from '../idleClock';

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
      if (!pageAttentive() || pageBusy() || pointers > 0 || keys.size > 0) press();
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
  const press = useRef<'none' | 'fresh' | 'stale'>('none');
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(timer);
      shownAt.current = Date.now();
      setArmed(false);
      timer = setTimeout(() => setArmed(true), RISK_ASK_TIMING.guardMs);
    };
    arm();
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
      press.current = event.repeat || early() ? 'stale' : 'fresh';
      if (press.current === 'stale') stop(event);
    };
    const keyUp = (event: KeyboardEvent) => {
      if (inside(event) && press.current === 'stale') stop(event);
    };
    const pointerDown = (event: PointerEvent) => {
      if (inside(event)) press.current = early() ? 'stale' : 'fresh';
    };
    const click = (event: MouseEvent) => {
      if (!inside(event)) return;
      if (press.current === 'stale' || (press.current === 'none' && early())) {
        press.current = 'none';
        stop(event);
      }
    };
    const back = (event: Event) => {
      if (event.type === 'focus' && event.target instanceof Node) return;
      if (event.type === 'visibilitychange' && document.visibilityState !== 'visible') return;
      press.current = 'none';
      arm();
    };
    window.addEventListener('keydown', keyDown, true);
    window.addEventListener('keyup', keyUp, true);
    window.addEventListener('pointerdown', pointerDown, true);
    window.addEventListener('click', click, true);
    window.addEventListener('focus', back);
    document.addEventListener('visibilitychange', back);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', keyDown, true);
      window.removeEventListener('keyup', keyUp, true);
      window.removeEventListener('pointerdown', pointerDown, true);
      window.removeEventListener('click', click, true);
      window.removeEventListener('focus', back);
      document.removeEventListener('visibilitychange', back);
    };
  }, []);
  return { armed, ok: () => press.current !== 'stale' && Date.now() - shownAt.current >= RISK_ASK_TIMING.guardMs };
}
