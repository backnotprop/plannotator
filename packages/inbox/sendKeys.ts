/**
 * A Send's idempotency keys, kept on this device from the moment its POST goes
 * until it is confirmed. The keys live in the thread pane, so a reload (or
 * leaving the thread) used to make the same words a new reply: a request still
 * on its way then landed beside it, two replies. Kept here, the next Send of the
 * same contents uses the same key and the server replays it.
 *
 * In localStorage, not sessionStorage: iOS discards a backgrounded tab, and the
 * Send that page lost is still on its way. One origin, every tab: two tabs
 * sending the same words share a key, which is the same reply.
 */
import type { SentContents } from './sendTargets';

const STORE_KEY = 'plannotator-inbox-send-keys';
/** As long as a Send waits to be confirmed in the page (Thread.tsx UNCONFIRMED_MS): nothing on the wire is older. */
const KEPT_MS = 10 * 60_000;

interface KeptSend {
  at: number;
  keys: [string, string][];
  contents: [string, SentContents][];
}
type KeptSends = Record<string, KeptSend>;

function read(now: number): KeptSends {
  try {
    const all = JSON.parse(globalThis.localStorage?.getItem(STORE_KEY) ?? '{}') as KeptSends;
    return Object.fromEntries(Object.entries(all).filter(([, kept]) => now - kept.at < KEPT_MS));
  } catch {
    return {};
  }
}

function write(all: KeptSends): void {
  try {
    if (Object.keys(all).length === 0) globalThis.localStorage?.removeItem(STORE_KEY);
    else globalThis.localStorage?.setItem(STORE_KEY, JSON.stringify(all));
  } catch {
    // Storage full or refused: the key lives in the page only, as it did before.
  }
}

export function keepSendKeys(threadId: string, keys: ReadonlyMap<string, string>, contents: ReadonlyMap<string, SentContents>, now = Date.now()): void {
  write({ ...read(now), [threadId]: { at: now, keys: [...keys], contents: [...contents] } });
}

export function keptSendKeys(threadId: string, now = Date.now()): { keys: Map<string, string>; contents: Map<string, SentContents> } | null {
  const kept = read(now)[threadId];
  return kept ? { keys: new Map(kept.keys), contents: new Map(kept.contents) } : null;
}

export function forgetSendKeys(threadId: string, now = Date.now()): void {
  const all = read(now);
  if (!(threadId in all)) return;
  delete all[threadId];
  write(all);
}
