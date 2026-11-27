/**
 * Which agents of the list's Agents view the person opened or folded (agentsView/model.ts), and the view's two bands
 * ("Ended", "No agent"). An agent the person never touched starts as the view says (open when something is for the
 * person, `AgentBlock.open`); a click on its row is remembered for it, as the groups' are (listGroups.ts): a cookie
 * through `storage`, per browser, never on the server and never a setting. Kept for the latest `AGENT_FOLDS_KEPT`
 * clicks, each agent by a short hash of its key, so the cookie stays small however many agents come and go.
 *
 * A fold gives way to new work: a thread that waits on the person and came after the fold opens the agent again (the
 * fold keeps when it was made), and Show opens the agents its rows land under (`openAll`, as it opens groups).
 */
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
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

/** A choice: open or folded, and when it was made (ms; 0 when not known). */
export interface FoldChoice {
  open: boolean;
  at: number;
}
type Folds = ReadonlyMap<string, FoldChoice>;

/** The fold key of an agent: its id, with its machine when that is another one (this machine's agents keep theirs when a first machine is linked). */
export function agentFoldKey(agent: { id: string; machine: string | null }, self: string | null): string {
  return `${agent.machine && agent.machine !== self ? agent.machine : ''}\u0000${agent.id}`;
}

/** The cookie's value ("k3x9a:1:lz1a2b,~ended:0") as choices, oldest first; anything else is ignored. */
export function parseAgentFolds(raw: string | null): Folds {
  const out = new Map<string, FoldChoice>();
  for (const token of (raw ?? '').split(',')) {
    const m = /^([~\w]{1,12}):([01])(?::([0-9a-z]{1,10}))?$/.exec(token);
    if (!m) continue;
    out.delete(m[1]!);
    out.set(m[1]!, { open: m[2] === '1', at: m[3] ? parseInt(m[3], 36) * 1000 : 0 });
  }
  return out;
}

export function formatAgentFolds(folds: Folds): string {
  return [...folds]
    .slice(-AGENT_FOLDS_KEPT)
    .map(([id, choice]) => `${id}:${choice.open ? 1 : 0}${choice.at ? `:${Math.floor(choice.at / 1000).toString(36)}` : ''}`)
    .join(',');
}

const nameOf = (key: string) => (key.startsWith('~') ? key : foldHash(key));

/**
 * Whether `key` is open: the person's choice, else `byDefault`. `waitsSince` (ms): its newest thread that waits on
 * the person; one after the fold opens it.
 */
export function foldOpen(folds: Folds, key: string, byDefault: boolean, waitsSince = 0): boolean {
  const choice = folds.get(nameOf(key));
  if (!choice) return byDefault;
  return choice.open || waitsSince > choice.at;
}

/**
 * The choices with `key` set `open`, kept as the newest choice, made at `now`, or at its newest waiting row if that is
 * later (the server's clock, or a row that came just before the click): rounded up to the second the cookie keeps,
 * so a fold always holds against the rows it was made over.
 */
function foldSet(folds: Folds, key: string, open: boolean, now: number, waitsSince = 0): Map<string, FoldChoice> {
  const next = new Map(folds);
  const name = nameOf(key);
  next.delete(name);
  next.set(name, { open, at: Math.ceil(Math.max(now, waitsSince) / 1000) * 1000 });
  while (next.size > AGENT_FOLDS_KEPT) next.delete(next.keys().next().value!);
  return next;
}

/** The choices after a click on `key`'s row: the other state, kept as the newest choice. */
export function foldToggled(folds: Folds, key: string, byDefault: boolean, waitsSince = 0, now = Date.now()): Map<string, FoldChoice> {
  return foldSet(folds, key, !foldOpen(folds, key, byDefault, waitsSince), now, waitsSince);
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

export interface AgentFolds {
  open: (key: string, byDefault: boolean, waitsSince?: number) => boolean;
  toggle: (key: string, byDefault: boolean, waitsSince?: number) => void;
  /** Show: open each of these (a kept choice, as a click on its row). */
  openAll: (keys: readonly string[]) => void;
}

const unheard = () => () => {};
const unread = () => '';

/** The view's folds. `remember` false (the tour, the view choice's picture): every agent at its start, a click not kept, the person's folds never read. */
export function useAgentFolds(remember = true): AgentFolds {
  const raw = useSyncExternalStore(remember ? subscribe : unheard, remember ? read : unread, unread);
  const [local, setLocal] = useState<Folds>(() => new Map());
  const folds = useMemo(() => (remember ? parseAgentFolds(raw) : local), [remember, raw, local]);
  const change = useCallback(
    (next: (last: Folds) => Folds) => (remember ? write(next(parseAgentFolds(read()))) : setLocal((last) => next(last))),
    [remember],
  );
  return useMemo(
    () => ({
      open: (key, byDefault, waitsSince) => foldOpen(folds, key, byDefault, waitsSince),
      toggle: (key, byDefault, waitsSince) => change((last) => foldToggled(last, key, byDefault, waitsSince)),
      openAll: (keys) => keys.length > 0 && change((last) => keys.reduce<Folds>((acc, key) => foldSet(acc, key, true, Date.now()), last)),
    }),
    [folds, change],
  );
}

/** Tests only: forget every choice. */
export function resetAgentFoldsForTests(): void {
  storage.removeItem(AGENT_FOLDS_COOKIE);
  written = null;
  for (const listener of [...listeners]) listener();
}
