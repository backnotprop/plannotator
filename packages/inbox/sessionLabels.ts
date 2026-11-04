/**
 * Session labels beyond the To picker (issue #2450, after #2467): the name a session was given (`/rename` or the
 * transcript's title in Claude Code, Pi's and OpenCode's session names) on the `@` picker's rows, the list rows'
 * agents, Send to another session and an agent message's author. The same label the To picker shows, from the
 * session's own poll: never from the model, never stored, and only for this computer's owner (a tailnet guest's
 * list carries none, so it reads as before). An unnamed session reads exactly as it did.
 *
 * Every row and thread reads one map, the list's `session_labels` (App puts each list read here), so a rename shows
 * everywhere at once and a session that ended keeps its name while the Inbox runs.
 */
import { useSyncExternalStore } from 'react';
import { INBOX_HOST_NAMES } from '@plannotator/core/inbox-types';

export type SessionLabels = Readonly<Record<string, string>>;

const EMPTY: SessionLabels = Object.freeze({});
let current: SessionLabels = EMPTY;
const listeners = new Set<() => void>();

/** The labels as a list read brought them; anything that is not a short string is dropped. Unchanged: no redraw. */
export function setSessionLabels(next: unknown): void {
  const clean: Record<string, string> = {};
  if (next && typeof next === 'object' && !Array.isArray(next)) {
    for (const [session, label] of Object.entries(next as Record<string, unknown>)) {
      if (typeof label === 'string' && label.trim()) clean[session] = label;
    }
  }
  const keys = Object.keys(clean);
  if (keys.length === Object.keys(current).length && keys.every((key) => current[key] === clean[key])) return;
  current = keys.length === 0 ? EMPTY : Object.freeze(clean);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const snapshot = () => current;

/** The labels now, redrawn when a list read changes them. */
export function useSessionLabels(): SessionLabels {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** One session's label, or null (no session, or none). */
export function labelOf(labels: SessionLabels, session: string | null | undefined): string | null {
  return session ? (labels[session] ?? null) : null;
}

/**
 * A label cut to `max` characters (code points) for words that cannot be cut by CSS (a tooltip, a spoken name):
 * the start and the end kept with "…" between, so "Fix login redirect for SSO users" stays told apart from
 * "Fix login redirect for the admin".
 */
export function shortLabel(label: string, max = 32): string {
  const chars = Array.from(label);
  if (chars.length <= max) return label;
  const head = Math.ceil((max - 1) / 2);
  const tail = max - 1 - head;
  return `${chars.slice(0, head).join('').trimEnd()}…${chars.slice(chars.length - tail).join('').trimStart()}`;
}

/** "Fix login redirect (Claude Code)": a labelled session in words, its agent after it. */
export function labelledAgent(label: string, host: string | null | undefined): string {
  const agent = host ? (INBOX_HOST_NAMES[host] ?? host) : 'An agent';
  return `${label} (${agent})`;
}
