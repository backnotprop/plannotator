/**
 * PROTOTYPE ONLY (branch proto/composer-picker; never merged): the three open choices of the composer and picker
 * redesign, flipped live from outside the window. The side-by-side page writes them to localStorage and fires
 * `ib-px-flags`; another tab's write arrives as a `storage` event; `?px=send:pill,model:off,to:top,agent:name` sets them at load
 * (for a phone, which has no switches). Each defaults to the recommended choice.
 */
import { useSyncExternalStore } from 'react';

export interface PxFlags {
  /** Send: the round arrow, or a pill with the word. */
  send: 'round' | 'pill';
  /** Model and Effort under a chosen new-session row. Shown in the picker and the pill only: the launch ignores them. */
  model: boolean;
  /** New message's To: the pill in the bottom row, or the line at the top as today. */
  to: 'row' | 'top';
  /** The agent in the thread reply's row: its mark alone as a round button, or the pill with its name. New message keeps the pill. */
  agent: 'icon' | 'name';
  /** Several recipients on the icon button: the first mark with a count, or two marks overlapped (for a still; not on the page). */
  multi: 'badge' | 'stack';
}

const KEY = 'ib-px-flags';
const EVENT = 'ib-px-flags';
const DEFAULTS: PxFlags = { send: 'round', model: true, to: 'row', agent: 'icon', multi: 'badge' };

function parse(raw: string | null): PxFlags {
  try {
    const v = raw ? (JSON.parse(raw) as Partial<PxFlags>) : {};
    return { send: v.send === 'pill' ? 'pill' : 'round', model: v.model !== false, to: v.to === 'top' ? 'top' : 'row', agent: v.agent === 'name' ? 'name' : 'icon', multi: v.multi === 'stack' ? 'stack' : 'badge' };
  } catch {
    return DEFAULTS;
  }
}

let current: PxFlags = DEFAULTS;
let raw: string | null = null;
function read(): PxFlags {
  let next: string | null = null;
  try {
    next = localStorage.getItem(KEY);
  } catch {}
  if (next !== raw) {
    raw = next;
    current = parse(next);
  }
  return current;
}

function paint(): void {
  const flags = read();
  const root = document.documentElement;
  root.dataset.px = '';
  root.dataset.pxSend = flags.send;
  root.dataset.pxTo = flags.to;
  root.dataset.pxModel = flags.model ? 'on' : 'off';
  root.dataset.pxAgent = flags.agent;
}

const listeners = new Set<() => void>();
function changed(): void {
  paint();
  for (const listener of listeners) listener();
}

/** Called once at load (index.tsx): the URL's choices, the root's marks, and the two events. */
export function startPxFlags(): void {
  if (typeof window === 'undefined') return;
  const fromUrl = new URLSearchParams(location.search).get('px');
  if (fromUrl) {
    const flags = { ...read() };
    for (const part of fromUrl.split(',')) {
      const [name, value] = part.split(':');
      if (name === 'send') flags.send = value === 'pill' ? 'pill' : 'round';
      if (name === 'model') flags.model = value !== 'off';
      if (name === 'to') flags.to = value === 'top' ? 'top' : 'row';
      if (name === 'agent') flags.agent = value === 'name' ? 'name' : 'icon';
      if (name === 'multi') flags.multi = value === 'stack' ? 'stack' : 'badge';
    }
    try {
      localStorage.setItem(KEY, JSON.stringify(flags));
    } catch {}
  }
  paint();
  window.addEventListener('storage', (event) => {
    if (event.key === KEY || event.key === null) changed();
  });
  window.addEventListener(EVENT, changed);
}

export function usePxFlags(): PxFlags {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    read,
    () => DEFAULTS,
  );
}
