/**
 * Words this page holds for a thread that no draft holds (a conflict's, a save that did not land, words on their way
 * that must outlive the tab, another machine's thread), kept in this browser's localStorage too, so a tab the browser
 * ended (a phone short of memory, a crash) loses none: the thread opened again in a new page has them back, and its
 * conflict or "Not saved" line shows by itself (replyDraft.ts). One entry per page and thread, with the `updated_at` of
 * the draft the words were typed over. Written as they change, removed where the page lets them go.
 *
 * Several tabs of one origin share the storage: each page holds a Web Lock named for it for its life, and a page takes
 * back only the words of a page that is gone (its lock is free; the browser frees it when a tab closes, crashes or is
 * ended). Without Web Locks (plain http on a LAN, as a phone's page) a page keeping words writes a heartbeat instead,
 * every few seconds and as it hides or shows, and removes it as it goes for good: another page's words are taken back
 * only once its heartbeat is gone or older than KEPT_ALIVE_MS.
 *
 * Kept at most 14 days, at most 20 entries and 200 KB in all (the oldest go first); a full or blocked storage keeps
 * nothing (the page still has the words). The words are never logged.
 */

const PREFIX = 'plannotator-inbox-reply-kept:';
const LOCK_PREFIX = 'plannotator-inbox-reply-kept-page:';
/** No Web Locks: a page's heartbeat (when it last said it is open), and how often it beats while it keeps words. */
const ALIVE_PREFIX = 'plannotator-inbox-reply-kept-alive:';
const BEAT_MS = 5_000;
/** A page whose heartbeat is older than this (or gone) is gone: its words are free to take. */
export const KEPT_ALIVE_MS = 30_000;
/** The most entries kept, and their size in all (characters of key and value): the oldest go first. */
const MAX_ENTRIES = 20;
const MAX_TOTAL = 200_000;
/** Longer words are not kept here (the page still holds them). */
const MAX_CHARS = 100_000;
/** Older entries are dropped as a page loads. */
export const KEPT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export type KeptKind = 'conflict' | 'failed' | 'remote';
export interface KeptWords {
  kind: KeptKind;
  words: string;
  /** The `updated_at` of the draft the words were typed over (null: none, or not known). */
  base: string | null;
}
interface Entry extends KeptWords {
  thread: string;
  page: string;
  at: number;
}

const newPageId = (): string => {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
};
/** This page's id: its entries' keys name it, and so does the lock it holds while it is open. */
let page = newPageId();
let locked: string | null = null;
let swept = false;

function store(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

type Locks = { request: (name: string, callback: () => Promise<void>) => Promise<unknown>; query: () => Promise<{ held?: { name?: string }[] }> };
const locks = (): Locks | null => {
  try {
    return ((typeof navigator !== 'undefined' && (navigator as unknown as { locks?: Locks }).locks) || null) ?? null;
  } catch {
    return null;
  }
};

let beating: ReturnType<typeof setInterval> | null = null;
/** The page went for good (`pagehide`, not into the back/forward cache): it beats no more. */
let gone = false;
let listening = false;

function beat(): void {
  const storage = store();
  if (!storage || gone) return;
  try {
    storage.setItem(ALIVE_PREFIX + page, String(Date.now()));
  } catch {
    // Full or blocked: nothing is kept here either.
  }
}

function stopBeat(storage: Storage): void {
  if (beating) clearInterval(beating);
  beating = null;
  remove(storage, ALIVE_PREFIX + page);
}

function listen(): void {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  // Back from the back/forward cache: the lock is taken again (the browser may have let it go), the heartbeat goes on.
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted || locked !== page) return;
    gone = false;
    locked = null;
    holdPageLock();
  });
  // Gone for good (a reload, a closed tab): no longer open, so the next page takes these words back at once.
  window.addEventListener('pagehide', (event) => {
    if (event.persisted) return;
    gone = true;
    const storage = store();
    if (storage) stopBeat(storage);
  });
  document.addEventListener('visibilitychange', () => beating && beat());
}

/**
 * Held until the page is gone (a promise that never settles): another page reading the locks knows it is open. Without
 * Web Locks the page beats while it keeps words.
 */
function holdPageLock(): void {
  listen();
  if (locked === page) return;
  locked = page;
  const known = locks();
  if (!known) {
    beat();
    beating ??= setInterval(beat, BEAT_MS);
    return;
  }
  try {
    void known.request(LOCK_PREFIX + page, () => new Promise<void>(() => {})).catch(() => {});
  } catch {
    // The lock could not be asked for: other pages read it as free.
  }
}

function parse(key: string, raw: string | null): Entry | null {
  if (!raw || !key.startsWith(PREFIX)) return null;
  try {
    const kept = JSON.parse(raw) as Partial<Entry>;
    if (typeof kept.words !== 'string' || (kept.kind !== 'conflict' && kept.kind !== 'failed' && kept.kind !== 'remote')) return null;
    if (kept.base !== null && typeof kept.base !== 'string') return null;
    if (typeof kept.thread !== 'string' || typeof kept.page !== 'string' || typeof kept.at !== 'number') return null;
    return { kind: kept.kind, words: kept.words, base: kept.base, thread: kept.thread, page: kept.page, at: kept.at };
  } catch {
    return null;
  }
}

function entries(storage: Storage): { key: string; size: number; entry: Entry | null }[] {
  const list: { key: string; size: number; entry: Entry | null }[] = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (!key?.startsWith(PREFIX)) continue;
    const raw = storage.getItem(key);
    list.push({ key, size: key.length + (raw?.length ?? 0), entry: parse(key, raw) });
  }
  return list;
}

const remove = (storage: Storage, key: string) => {
  try {
    storage.removeItem(key);
  } catch {
    // Blocked storage keeps nothing to remove.
  }
};

/** Entries that cannot be read or are older than 14 days go; then at most MAX_ENTRIES and MAX_TOTAL, the oldest first. */
function trim(storage: Storage): void {
  const now = Date.now();
  // Another page's heartbeat that stopped (it is gone, or beats again once back) says nothing: it goes.
  const stopped: string[] = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key?.startsWith(ALIVE_PREFIX) && key !== ALIVE_PREFIX + page && now - (Number(storage.getItem(key)) || 0) > KEPT_ALIVE_MS) stopped.push(key);
  }
  for (const key of stopped) remove(storage, key);
  const kept = entries(storage).filter(({ key, entry }) => {
    if (entry && now - entry.at <= KEPT_MAX_AGE_MS) return true;
    remove(storage, key);
    return false;
  });
  kept.sort((a, b) => a.entry!.at - b.entry!.at);
  let total = kept.reduce((sum, { size }) => sum + size, 0);
  for (let count = kept.length; count > 0 && (count > MAX_ENTRIES || total > MAX_TOTAL); count -= 1) {
    const oldest = kept[kept.length - count]!;
    remove(storage, oldest.key);
    total -= oldest.size;
  }
}

function sweepOnce(storage: Storage): void {
  if (swept) return;
  swept = true;
  trim(storage);
}

/** `remote`: a thread's words kept while its draft is not kept there, beside (never over) its other words. */
const keyOf = (threadId: string, slot: '' | ':remote' = '') => `${PREFIX}${page}:${threadId}${slot}`;

/**
 * The newest words another page kept for the thread whose page is gone (null: none): its entry's key goes with it, for
 * `dropKept` once this page keeps them. A page still open keeps its own.
 */
export async function keptWordsGone(threadId: string, remote?: boolean): Promise<(KeptWords & { key: string }) | null> {
  const storage = store();
  if (!storage) return null;
  sweepOnce(storage);
  // `remote` given: only the entries of that slot (a remote thread's page-only words sit beside its other words).
  const slotOf = (entry: Entry) => remote === undefined || (entry.kind === 'remote') === remote;
  const theirs = entries(storage)
    .flatMap(({ key, entry }) => (entry && entry.thread === threadId && entry.page !== page && slotOf(entry) ? [{ key, entry }] : []))
    .sort((a, b) => b.entry.at - a.entry.at);
  if (theirs.length === 0) return null;
  const open = new Set<string>();
  const known = locks();
  if (known) {
    const held = await known.query().catch(() => null);
    // The locks could not be read: no page is known gone, so none is taken.
    if (!held) return null;
    for (const lock of held.held ?? []) if (lock.name?.startsWith(LOCK_PREFIX)) open.add(lock.name.slice(LOCK_PREFIX.length));
  } else {
    // No Web Locks: a page whose heartbeat is fresh is open.
    for (const { entry } of theirs) if (Date.now() - (Number(storage.getItem(ALIVE_PREFIX + entry.page)) || 0) <= KEPT_ALIVE_MS) open.add(entry.page);
  }
  const gone = theirs.find(({ entry }) => !open.has(entry.page));
  return gone ? { kind: gone.entry.kind, words: gone.entry.words, base: gone.entry.base, key: gone.key } : null;
}

/** Another page's entry, taken by this one (which keeps the words under its own). */
export function dropKept(key: string): void {
  const storage = store();
  if (storage) remove(storage, key);
}

/** Keep the thread's words (they replace what this page kept for it). */
export function keepWords(threadId: string, kept: KeptWords): void {
  const storage = store();
  if (!storage) return;
  const slot = kept.kind === 'remote' ? ':remote' : '';
  if (kept.words.trim() === '' || kept.words.length > MAX_CHARS) return forgetWords(threadId, slot);
  holdPageLock();
  sweepOnce(storage);
  try {
    const entry: Entry = { ...kept, thread: threadId, page, at: Date.now() };
    storage.setItem(keyOf(threadId, slot), JSON.stringify(entry));
  } catch {
    // Full or blocked: the page still holds the words.
  }
  trim(storage);
}

export function forgetWords(threadId: string, slot: '' | ':remote' = ''): void {
  const storage = store();
  if (!storage) return;
  remove(storage, keyOf(threadId, slot));
  // Nothing of this page's kept any more: its heartbeat stops (the next words kept start it again).
  if (beating && !entries(storage).some(({ entry }) => entry?.page === page)) {
    stopBeat(storage);
    locked = null;
  }
}

/** DOM tests: a new page (another id, its lock not taken yet, no heartbeat, the sweep on load still to run). */
export function newKeptPageForTests(): void {
  if (beating) clearInterval(beating);
  beating = null;
  gone = false;
  page = newPageId();
  locked = null;
  swept = false;
}
