/**
 * Words this page holds for a thread that no draft holds (a conflict's, a save that did not land, Keep mine on its
 * way, another machine's thread), kept in this browser's localStorage too, so a tab the browser ended (a phone short
 * of memory, a crash) loses none: the thread opened again in a new page has them back, and its conflict or "Not saved"
 * line shows by itself (replyDraft.ts). One entry per thread, with the `updated_at` of the draft the words were typed
 * over. Written as they change, removed where the page lets them go. Capped in size and count; a full or blocked
 * storage keeps nothing (the page still has the words). The words are never logged.
 */

const PREFIX = 'plannotator-inbox-reply-kept:';
/** The most threads kept: the oldest entry goes first. */
const MAX_THREADS = 20;
/** Longer words are not kept here (the page still holds them). */
const MAX_CHARS = 100_000;

export type KeptKind = 'conflict' | 'failed' | 'remote';
export interface KeptWords {
  kind: KeptKind;
  words: string;
  /** The `updated_at` of the draft the words were typed over (null: none). */
  base: string | null;
}

function store(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function parse(raw: string | null): (KeptWords & { at: number }) | null {
  if (!raw) return null;
  try {
    const kept = JSON.parse(raw) as Partial<KeptWords & { at: number }>;
    if (typeof kept.words !== 'string' || (kept.kind !== 'conflict' && kept.kind !== 'failed' && kept.kind !== 'remote')) return null;
    if (kept.base !== null && typeof kept.base !== 'string') return null;
    return { kind: kept.kind, words: kept.words, base: kept.base, at: typeof kept.at === 'number' ? kept.at : 0 };
  } catch {
    return null;
  }
}

/** The words kept for the thread by an earlier page (null: none). */
export function keptWordsOf(threadId: string): KeptWords | null {
  const kept = parse(store()?.getItem(PREFIX + threadId) ?? null);
  return kept ? { kind: kept.kind, words: kept.words, base: kept.base } : null;
}

/** Keep the thread's words (they replace what was kept for it). */
export function keepWords(threadId: string, kept: KeptWords): void {
  const storage = store();
  if (!storage) return;
  if (kept.words.trim() === '' || kept.words.length > MAX_CHARS) return forgetWords(threadId);
  try {
    const fresh = storage.getItem(PREFIX + threadId) === null;
    storage.setItem(PREFIX + threadId, JSON.stringify({ ...kept, at: Date.now() }));
    if (fresh) trim(storage);
  } catch {
    // Full or blocked: the page still holds the words.
  }
}

export function forgetWords(threadId: string): void {
  try {
    store()?.removeItem(PREFIX + threadId);
  } catch {
    // Blocked storage keeps nothing to forget.
  }
}

/** At most MAX_THREADS entries: the oldest go. */
function trim(storage: Storage): void {
  const entries: { key: string; at: number }[] = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key?.startsWith(PREFIX)) entries.push({ key, at: parse(storage.getItem(key))?.at ?? 0 });
  }
  entries.sort((a, b) => a.at - b.at);
  for (const { key } of entries.slice(0, Math.max(0, entries.length - MAX_THREADS))) storage.removeItem(key);
}
