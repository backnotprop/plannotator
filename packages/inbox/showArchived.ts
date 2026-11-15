/**
 * The list's "Show archived" (approval "inbox-archived-group"; the ⋮ menu's View group): off by default, one switch on
 * every linked machine and in every window (config.json `inboxShowArchived`, packages/server/inbox-show-archived.ts).
 * The window holds the newest it heard: a settings read, `event: show-archived`, or its own save on the way.
 */
import { useSyncExternalStore } from 'react';

interface Held {
  on: boolean;
  rev: number;
}

let held: Held = { on: false, rev: -1 };
/** This window's own save while it is on its way: drawn at once, whatever an older event says meanwhile. */
let pending: boolean | null = null;
const listeners = new Set<() => void>();

const notify = () => {
  for (const listener of listeners) listener();
};

function read(value: unknown): Held | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as { on?: unknown; rev?: unknown };
  return typeof v.on === 'boolean' && typeof v.rev === 'number' ? { on: v.on, rev: v.rev } : null;
}

/** A settings read's `show_archived`, an `event: show-archived`, or a save's answer: taken unless older than the held one. */
export function adoptShowArchived(value: unknown): void {
  const next = read(value);
  if (!next || next.rev < held.rev) return;
  const was = showArchivedOn();
  held = next;
  if (was !== showArchivedOn()) notify();
}

export function showArchivedOn(): boolean {
  return pending ?? held.on;
}

/** Drawn at once; `settled` ends it (with the save's answer, or nothing when it failed). */
export function drawShowArchived(on: boolean): { settled: (answer?: unknown) => void } {
  const was = showArchivedOn();
  pending = on;
  if (was !== on) notify();
  return {
    settled: (answer) => {
      const before = showArchivedOn();
      pending = null;
      if (answer !== undefined) adoptShowArchived(answer);
      if (before !== showArchivedOn()) notify();
    },
  };
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useShowArchived(): boolean {
  return useSyncExternalStore(subscribe, showArchivedOn, showArchivedOn);
}

/** Tests only. */
export function resetShowArchivedForTests(): void {
  held = { on: false, rev: -1 };
  pending = null;
  notify();
}
