/**
 * Session labels beyond the To picker (issue #2450, after #2467): the name a session was given (`/rename` or the
 * transcript's title in Claude Code, Pi's and OpenCode's session names) on the `@` picker's rows, the list rows'
 * agents, Send to another session and an agent message's author. The same label the To picker shows, sent by the
 * session's connection on each poll, never stored. An unnamed session reads exactly as it did.
 *
 * It is display only and not proof of who wrote: no tool takes a label, but Claude Code's comes from the session's
 * transcript (its latest `custom-title` line), which the session's own model can append to. So the server refuses a
 * label that reads as "You", the agent's mark stays beside every name, two sessions sharing a label say their agent
 * where it matters, and nothing routes or decides on one.
 *
 * Every row and thread reads one map, the list's `session_labels` (App puts each list read here), so a rename shows
 * everywhere at once and a session that ended keeps its name while the Inbox runs. The map has no prototype and is
 * read with `Object.hasOwn`, so a session id like "constructor" finds nothing.
 *
 * A name the person gave the agent (agents/agentNames.ts) is read here over the label its poll sends; the poll's
 * label is kept, so Reset name shows it as it is then.
 */
import { useSyncExternalStore } from 'react';
import { graphemesOf } from '@plannotator/core/inbox-format';
import { agentNamesNow, onAgentNames } from './agents/agentNames';

export type SessionLabels = Readonly<Record<string, string>>;

const EMPTY: SessionLabels = Object.freeze(Object.create(null) as Record<string, string>);
/** What the list read brought. */
let polled: SessionLabels = EMPTY;
/** `polled` with the given names over it: what every reader gets. */
let current: SessionLabels = EMPTY;
const listeners = new Set<() => void>();

function merge(): void {
  const names = agentNamesNow();
  if (names.size === 0) {
    current = polled;
    return;
  }
  const out = Object.assign(Object.create(null), polled) as Record<string, string>;
  for (const [id, name] of names) out[id] = name;
  current = Object.freeze(out);
}

onAgentNames(() => {
  merge();
  for (const listener of listeners) listener();
});

/** The labels as a list read brought them; anything that is not a short string is dropped. Unchanged: no redraw. */
export function setSessionLabels(next: unknown): void {
  const clean = Object.create(null) as Record<string, string>;
  if (next && typeof next === 'object' && !Array.isArray(next)) {
    for (const [session, label] of Object.entries(next as Record<string, unknown>)) {
      if (typeof label === 'string' && label.trim()) clean[session] = label;
    }
  }
  const keys = Object.keys(clean);
  if (keys.length === Object.keys(polled).length && keys.every((key) => labelOf(polled, key) === clean[key])) return;
  polled = keys.length === 0 ? EMPTY : Object.freeze(clean);
  merge();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const snapshot = () => current;

/** The labels now, outside React. */
export function sessionLabelsNow(): SessionLabels {
  return current;
}

/** The labels now, redrawn when a list read or a given name changes them. */
export function useSessionLabels(): SessionLabels {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** One session's label, or null (no session, or none). Own keys only: "constructor" or "toString" is no label. */
export function labelOf(labels: SessionLabels, session: string | null | undefined): string | null {
  if (!session || !Object.hasOwn(labels, session)) return null;
  const label = labels[session];
  return typeof label === 'string' ? label : null;
}

/**
 * A label cut to `max` characters (user-perceived ones, `graphemesOf`, so a family emoji or a flag is never split)
 * for words that cannot be cut by CSS (a tooltip, a spoken name): the start and the end kept with "…" between, so
 * "Fix login redirect for SSO users" stays told apart from "Fix login redirect for the admin".
 */
export function shortLabel(label: string, max = 32): string {
  const chars = graphemesOf(label);
  if (chars.length <= max) return label;
  const head = Math.ceil((max - 1) / 2);
  const tail = max - 1 - head;
  return `${chars.slice(0, head).join('').trimEnd()}…${chars.slice(chars.length - tail).join('').trimStart()}`;
}

/**
 * A named session's message author in words, the agent first as the head shows it (owner's decision on #2450,
 * 2026-11-04): `shown` for the hover, "Claude Code · Fix login redirect"; `spoken` for a screen reader, which
 * may skip the "·", "Claude Code (Fix login redirect)". Both carry the whole label.
 */
export function authorWithLabel(agent: string, label: string): { shown: string; spoken: string } {
  return { shown: `${agent} · ${label}`, spoken: `${agent} (${label})` };
}
