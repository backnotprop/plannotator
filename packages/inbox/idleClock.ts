import { useEffect, useRef, useState } from 'react';

export const IDLE_CLOCK = {
  idleMs: 20_000,
};

/** Every input that ends idle. `scroll` does not bubble, so the listeners listen in the capture phase. */
const ACTIVITY = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'scroll', 'touchstart'] as const;

export function pageAttentive(doc: Document = document): boolean {
  return doc.visibilityState === 'visible' && (typeof doc.hasFocus !== 'function' || doc.hasFocus());
}

export const PAGE_OVERLAYS = [
  'dialog[open]',
  '[aria-modal="true"]',
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  '[aria-haspopup]:not([aria-haspopup="false"])[aria-expanded="true"]',
  '[data-popover-layer]',
  '[data-chat-window]',
  '[data-pn-image-annotator-stage]',
  '[data-shape-open]',
  '.annotation-toolbar',
  '[data-comment-popover]',
  '[data-floating-picker]',
  '[data-table-toolbar]',
].join(', ');

function popoverOpen(doc: Document): boolean {
  try {
    return doc.querySelector(':popover-open') !== null;
  } catch {
    return false;
  }
}

export function pageBusy(doc: Document = document): boolean {
  const active = doc.activeElement as HTMLElement | null;
  if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT' || active.isContentEditable)) return true;
  return doc.querySelector(PAGE_OVERLAYS) !== null || popoverOpen(doc);
}

export interface IdleClockInput {
  enabled: boolean;
  busy?: () => boolean;
}

export function useIdleClock(input: IdleClockInput): boolean {
  const [idle, setIdle] = useState(false);
  const latest = useRef(input);
  latest.current = input;
  useEffect(() => {
    if (!input.enabled) return;
    let last = Date.now();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let now = false;
    const set = (value: boolean) => {
      if (now === value) return;
      now = value;
      setIdle(value);
    };
    const arm = (ms: number) => {
      if (timer === null && pageAttentive()) timer = setTimeout(fire, ms);
    };
    function fire() {
      timer = null;
      if (!pageAttentive()) return;
      const quiet = Date.now() - last;
      if (quiet < IDLE_CLOCK.idleMs) return arm(IDLE_CLOCK.idleMs - quiet);
      if (pageBusy() || latest.current.busy?.()) {
        last = Date.now();
        return arm(IDLE_CLOCK.idleMs);
      }
      set(true);
    }
    const active = () => {
      last = Date.now();
      set(false);
      arm(IDLE_CLOCK.idleMs);
    };
    const away = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      set(false);
    };
    const attention = () => (pageAttentive() ? active() : away());
    const options: AddEventListenerOptions = { capture: true, passive: true };
    for (const type of ACTIVITY) window.addEventListener(type, active, options);
    window.addEventListener('focus', attention);
    window.addEventListener('blur', away);
    document.addEventListener('visibilitychange', attention);
    arm(IDLE_CLOCK.idleMs);
    return () => {
      for (const type of ACTIVITY) window.removeEventListener(type, active, options);
      window.removeEventListener('focus', attention);
      window.removeEventListener('blur', away);
      document.removeEventListener('visibilitychange', attention);
      if (timer !== null) clearTimeout(timer);
      setIdle(false);
    };
  }, [input.enabled]);
  return idle;
}
