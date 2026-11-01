/**
 * The reply box's words on this device, from the moment they are typed until
 * the server confirms it holds them. A draft is saved on the server, so a save
 * stuck on a bad link took the only copy with it when the page went: the page's
 * own going-away save covers words still in the typing pause, never a save
 * already on its way, and iOS does not always run it at all.
 *
 * `base` is the draft's `updated_at` when the words were typed: a draft that
 * has not moved since means these words are the newest. A day is long enough to
 * come back to them, and words older than that were written for another moment.
 */
const STORE_KEY = 'plannotator-inbox-unsaved-words';
const KEPT_MS = 24 * 60 * 60_000;

export interface KeptWords {
  text: string;
  base: string | null;
  at: number;
}
type AllWords = Record<string, KeptWords>;

function read(now: number): AllWords {
  try {
    const all = JSON.parse(globalThis.localStorage?.getItem(STORE_KEY) ?? '{}') as AllWords;
    return Object.fromEntries(Object.entries(all).filter(([, kept]) => now - kept.at < KEPT_MS));
  } catch {
    return {};
  }
}

function write(all: AllWords): void {
  try {
    if (Object.keys(all).length === 0) globalThis.localStorage?.removeItem(STORE_KEY);
    else globalThis.localStorage?.setItem(STORE_KEY, JSON.stringify(all));
  } catch {
    // Storage full or refused: the server's copy is the only one, as it was before.
  }
}

/** Blank words are nothing to lose: the entry goes. */
export function keepWords(threadId: string, text: string, base: string | null, now = Date.now()): void {
  const all = read(now);
  if (text.trim() === '') delete all[threadId];
  else all[threadId] = { text, base, at: now };
  write(all);
}

export function keptWords(threadId: string, now = Date.now()): KeptWords | null {
  return read(now)[threadId] ?? null;
}

/** The server holds the words (`text`: only while they are still these; the person may have typed on since). */
export function forgetWords(threadId: string, text?: string, now = Date.now()): void {
  const all = read(now);
  const kept = all[threadId];
  if (!kept || (text !== undefined && kept.text !== text)) return;
  delete all[threadId];
  write(all);
}
