/**
 * A name for a session the person never named, for list rows only (option A, 2026-11-10): the list's
 * `session_titles`, the host's generated title (Claude Code's `ai-title`) else Claude Code's own name for the session
 * (`claude agents --json`). Kept apart from `session_labels` (sessionLabels.ts), the name the person gave, which every
 * other place reads: whether those places show a generated name too is the owner's to decide. Same rules as the
 * labels: display only, this computer's owner only, no prototype, own keys only.
 */
import { useSyncExternalStore } from 'react';
import type { SessionLabels } from './sessionLabels';

const EMPTY: SessionLabels = Object.freeze(Object.create(null) as Record<string, string>);
let current: SessionLabels = EMPTY;
const listeners = new Set<() => void>();

/** The titles a list read brought; anything that is not a non-empty string is dropped. Unchanged: no redraw. */
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

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const snapshot = () => current;

/** The titles now, redrawn when a list read changes them. */
export function useSessionTitles(): SessionLabels {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
