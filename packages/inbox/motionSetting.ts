import { useSyncExternalStore } from 'react';
import { storage } from '@plannotator/ui/utils/storage';

export type InboxMotion = 'device' | 'reduced';

export const MOTION_COOKIE = 'plannotator-inbox-motion';
export const MOTION_ATTRIBUTE = 'data-motion';

const REDUCE = /\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/;
const NO_PREFERENCE = /\(\s*prefers-reduced-motion\s*:\s*no-preference\s*\)|\(\s*prefers-reduced-motion\s*\)/;

let current: InboxMotion = 'device';
const listeners = new Set<() => void>();
const queries = new Map<string, { list: MediaQueryList; announce: () => void }>();
let systemMatchMedia: ((query: string) => MediaQueryList) | null = null;

function readCookie(): InboxMotion {
  try {
    return storage.getItem(MOTION_COOKIE) === 'reduced' ? 'reduced' : 'device';
  } catch {
    return 'device';
  }
}

function forcedQuery(query: string): string {
  return query.replace(REDUCE, 'all').replace(NO_PREFERENCE, 'not all');
}

function settingQuery(system: (query: string) => MediaQueryList, query: string): MediaQueryList {
  const native = system(query);
  const forced = system(forcedQuery(query));
  const target = new EventTarget();
  let handler: ((this: MediaQueryList, event: MediaQueryListEvent) => unknown) | null = null;
  const list = Object.defineProperties(target, {
    media: { value: query },
    matches: { get: () => (current === 'reduced' ? forced.matches : native.matches) },
    onchange: {
      get: () => handler,
      set: (next: typeof handler) => {
        handler = next;
      },
    },
    addListener: { value: (listener: (event: MediaQueryListEvent) => void) => target.addEventListener('change', listener as EventListener) },
    removeListener: { value: (listener: (event: MediaQueryListEvent) => void) => target.removeEventListener('change', listener as EventListener) },
  }) as unknown as MediaQueryList;
  let last = list.matches;
  const announce = () => {
    const now = list.matches;
    if (now === last) return;
    last = now;
    const event = new Event('change') as MediaQueryListEvent;
    Object.defineProperty(event, 'matches', { value: now });
    Object.defineProperty(event, 'media', { value: query });
    handler?.call(list, event);
    target.dispatchEvent(event);
  };
  native.addEventListener?.('change', announce);
  queries.set(query, { list, announce });
  return list;
}

function installMatchMedia(): void {
  if (systemMatchMedia || typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
  const system = window.matchMedia.bind(window);
  systemMatchMedia = system;
  window.matchMedia = (query: string) => (REDUCE.test(query) || NO_PREFERENCE.test(query) ? (queries.get(query)?.list ?? settingQuery(system, query)) : system(query));
}

function apply(motion: InboxMotion): void {
  current = motion;
  installMatchMedia();
  if (typeof document !== 'undefined') {
    if (motion === 'reduced') document.documentElement.setAttribute(MOTION_ATTRIBUTE, 'reduced');
    else document.documentElement.removeAttribute(MOTION_ATTRIBUTE);
  }
  for (const { announce } of queries.values()) announce();
  for (const listener of listeners) listener();
}

export function applyRememberedMotion(): void {
  apply(readCookie());
}

function remember(motion: InboxMotion): void {
  try {
    if (motion === 'reduced') storage.setItem(MOTION_COOKIE, 'reduced');
    else storage.removeItem(MOTION_COOKIE);
  } catch {
    return;
  }
}

export function chooseMotion(motion: InboxMotion): void {
  remember(motion);
  apply(motion);
}

export function useInboxMotion(): InboxMotion {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
    () => 'device',
  );
}
