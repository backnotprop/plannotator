/**
 * Messages agents are writing right now, with a drawing in them (prototype;
 * packages/core/inbox-drafting.ts). The event stream's `drafting` frames land
 * here from App.tsx's one subscription; the open thread draws them
 * (components/LiveDrawings.tsx). No state in App, so a frame draws only the
 * drawing. Nothing is kept: a draft goes when its message lands, or when its
 * frames stop coming.
 */
import { useSyncExternalStore } from 'react';
import type { InboxDraftingFrame } from '@plannotator/core/inbox-drafting';

export interface LiveDraft {
  call: string;
  body: string;
  done: boolean;
}

/** A draft whose frames stopped (the turn was stopped, the session ended) goes after this long. */
export const DRAFTING_STALE_MS = 20_000;
/** A finished draft waits this long for its message before it goes by itself. */
export const DRAFTING_DONE_MS = 15_000;

const NONE: readonly LiveDraft[] = [];
const threads = new Map<string, readonly LiveDraft[]>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

function changed(): void {
  for (const listener of listeners) listener();
}

function drop(threadId: string, call: string): void {
  const timer = timers.get(call);
  if (timer) clearTimeout(timer);
  timers.delete(call);
  const next = (threads.get(threadId) ?? NONE).filter((draft) => draft.call !== call);
  if (next.length > 0) threads.set(threadId, next);
  else threads.delete(threadId);
  changed();
}

export function noteDrafting(frame: InboxDraftingFrame): void {
  const drafts = threads.get(frame.thread_id) ?? NONE;
  const draft: LiveDraft = { call: frame.call, body: frame.body, done: frame.done };
  threads.set(frame.thread_id, drafts.some((d) => d.call === frame.call) ? drafts.map((d) => (d.call === frame.call ? draft : d)) : [...drafts, draft]);
  const timer = timers.get(frame.call);
  if (timer) clearTimeout(timer);
  timers.set(frame.call, setTimeout(() => drop(frame.thread_id, frame.call), frame.done ? DRAFTING_DONE_MS : DRAFTING_STALE_MS));
  changed();
}

/** A message landed in the thread: the finished drafts were it. */
export function draftingLanded(threadId: string): void {
  for (const draft of threads.get(threadId) ?? NONE) if (draft.done) drop(threadId, draft.call);
}

export function useLiveDrafts(threadId: string): readonly LiveDraft[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => threads.get(threadId) ?? NONE,
    () => NONE,
  );
}

/**
 * Unfinished SVG markup as a document an `<img>` can draw: the tag cut short
 * at the end is left out and every open element is closed. The HTML parser
 * does the closing, as it would for a page; nothing it reads runs. Null while
 * there is no `<svg>` yet.
 */
export function drawablePartialSvg(source: string): string | null {
  if (typeof DOMParser === 'undefined' || typeof XMLSerializer === 'undefined') return null;
  const lastOpen = source.lastIndexOf('<');
  const whole = lastOpen > source.lastIndexOf('>') ? source.slice(0, lastOpen) : source;
  if (!/<svg[\s>]/i.test(whole)) return null;
  try {
    const svg = new DOMParser().parseFromString(`<!doctype html><body>${whole}</body>`, 'text/html').querySelector('svg');
    return svg ? new XMLSerializer().serializeToString(svg) : null;
  } catch {
    return null;
  }
}
