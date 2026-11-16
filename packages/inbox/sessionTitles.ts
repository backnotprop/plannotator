/**
 * The titles each session's host generated (`session_titles`; Claude Code's own session title). A session with no
 * label of its own is named by its title everywhere (sessionLabels.ts reads it under the labels).
 */
import { useSyncExternalStore } from 'react';
import type { SessionLabels } from './sessionLabels';

const EMPTY: SessionLabels = Object.freeze(Object.create(null) as Record<string, string>);
let current: SessionLabels = EMPTY;
const listeners = new Set<() => void>();

export function setSessionTitles(next: unknown): void {
  const clean = Object.create(null) as Record<string, string>;
  if (next && typeof next === 'object' && !Array.isArray(next)) {
    for (const [session, title] of Object.entries(next as Record<string, unknown>)) if (typeof title === 'string' && title.trim()) clean[session] = title;
  }
  const keys = Object.keys(clean);
  if (keys.length === Object.keys(current).length && keys.every((key) => Object.hasOwn(current, key) && current[key] === clean[key])) return;
  current = keys.length === 0 ? EMPTY : Object.freeze(clean);
  for (const listener of listeners) listener();
}

/** The titles now, outside React. */
export function sessionTitlesNow(): SessionLabels {
  return current;
}

/** Hear each change (sessionLabels.ts). */
export function onSessionTitles(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const snapshot = () => current;

export function useSessionTitles(): SessionLabels {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
