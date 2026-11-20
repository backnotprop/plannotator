/**
 * Which agents of the list's Agents view the person opened or folded (agentsView/model.ts), and the view's two bands
 * ("Ended", "No agent"). An agent the person never touched starts as the view says (open when something is for the
 * person, `AgentBlock.open`); a click on its row is remembered for it, as the groups' are (listGroups.ts): a cookie
 * through `storage`, per browser, never on the server and never a setting. Kept for the latest `AGENT_FOLDS_KEPT`
 * clicks, each agent by a short hash of its key, so the cookie stays small however many agents come and go.
 */
import { useState, useSyncExternalStore } from 'react';
import { storage } from '@plannotator/ui/utils/storage';

export const AGENT_FOLDS_COOKIE = 'plannotator-inbox-agent-folds';
export const AGENT_FOLDS_KEPT = 40;
/** The bands' keys: "Ended" starts open (its agents folded), "No agent" folded. */
export const ENDED_BAND = '~ended';
export const NONE_BAND = '~none';

/** A short, stable name for a key (FNV-1a, base 36). */
export function foldHash(key: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

type Folds = ReadonlyMap<string, boolean>;

/** The cookie's value ("k3x9a:1,~ended:0") as choices, oldest first; anything else is ignored. */
export function parseAgentFolds(raw: string | null): Folds {
  const out = new Map<string, boolean>();
  for (const token of (raw ?? '').split(',')) {
    const m = /^([~\w]{1,12}):([01])$/.exec(token);
    if (!m) continue;
    out.delete(m[1]!);
    out.set(m[1]!, m[2] === '1');
  }
  return out;
}

function formatAgentFolds(folds: Folds): string {
  return [...folds].slice(-AGENT_FOLDS_KEPT).map(([id, open]) => `${id}:${open ? 1 : 0}`).join(',');
}

const nameOf = (key: string) => (key.startsWith('~') ? key : foldHash(key));

/** Whether `key` is open: the person's choice, else `byDefault`. */
export function foldOpen(folds: Folds, key: string, byDefault: boolean): boolean {
  return folds.get(nameOf(key)) ?? byDefault;
}

/** The choices after a click on `key`'s row: the other state, kept as the newest choice. */
export function foldToggled(folds: Folds, key: string, byDefault: boolean): Map<string, boolean> {
  const next = new Map(folds);
  const name = nameOf(key);
  const open = foldOpen(folds, key, byDefault);
  next.delete(name);
  next.set(name, !open);
  while (next.size > AGENT_FOLDS_KEPT) next.delete(next.keys().next().value!);
  return next;
}

const listeners = new Set<() => void>();
let written: string | null = null;
const read = () => storage.getItem(AGENT_FOLDS_COOKIE) ?? written ?? '';
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

function write(next: Folds): void {
  const value = formatAgentFolds(next);
  if (value) storage.setItem(AGENT_FOLDS_COOKIE, value);
  else storage.removeItem(AGENT_FOLDS_COOKIE);
  written = (storage.getItem(AGENT_FOLDS_COOKIE) ?? '') === value ? null : value;
  for (const listener of [...listeners]) listener();
}

/** The view's folds. `remember` false (the tour): every agent at its start, a click not kept. */
export function useAgentFolds(remember = true): { open: (key: string, byDefault: boolean) => boolean; toggle: (key: string, byDefault: boolean) => void } {
  const raw = useSyncExternalStore(subscribe, read, () => '');
  const [local, setLocal] = useState<Folds>(() => new Map());
  const folds = remember ? parseAgentFolds(raw) : local;
  return {
    open: (key, byDefault) => foldOpen(folds, key, byDefault),
    toggle: (key, byDefault) => {
      if (remember) return write(foldToggled(parseAgentFolds(read()), key, byDefault));
      setLocal((last) => foldToggled(last, key, byDefault));
    },
  };
}

/** Tests only: forget every choice. */
export function resetAgentFoldsForTests(): void {
  storage.removeItem(AGENT_FOLDS_COOKIE);
  written = null;
  for (const listener of [...listeners]) listener();
}
