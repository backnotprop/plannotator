/**
 * The window's side of the Inbox's debug log (packages/shared/inbox/debug-log.ts). Off, nothing here runs: fetch is
 * untouched and nothing is stored. An Inbox with debug on marks its answers (`INBOX_DEBUG_ON_HEADER`), and from then
 * on this window wraps `fetch` in this one place and notes the page's own events. What is not `fetch` is not seen
 * here: uploads (`XMLHttpRequest`), `sendBeacon` and the event stream (`EventSource`).
 *
 * The wrapper must not change a request: the caller gets the same response or the same error, from one call made in
 * the same tick, and any failure of the recording falls back to the plain `fetch`.
 *
 * During a stall the window cannot reach the server, so every record goes to a capped local buffer first and is
 * sent when it can be, including right after a refresh: that is what shows what the old page was waiting on. A
 * request id is on both sides of the log. Only ids, routes, statuses and timings are recorded.
 */
// A relative path: the module is private to the Inbox, and core's exports are published.
import { debugPageId, debugRoute, INBOX_DEBUG_BATCH_RECORDS, INBOX_DEBUG_ID_HEADER, INBOX_DEBUG_ON_HEADER, INBOX_DEBUG_PATH } from '../shared/inbox/debug-log';
import { inboxUrl } from './inboxUrl';

const ON_KEY = 'plannotator-inbox-debug';
const BUFFER_KEY = 'plannotator-inbox-debug-buffer';
/** The oldest records go first past this, with a `buffer_dropped` saying how many. */
export const DEBUG_BUFFER_RECORDS = 2000;
const SAVE_MS = 300;
const FLUSH_MS = 5000;
const FLUSH_LIMIT_MS = 8000;

type DebugRecord = Record<string, unknown> & { page: string; seq: number };
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface DebugRecorderEnv {
  storage: Storage;
  /** The real fetch: the buffer's own sends go through it, unrecorded. */
  fetch: typeof fetch;
  now?: () => number;
}

export function createDebugRecorder(env: DebugRecorderEnv) {
  const now = env.now ?? Date.now;
  const page = debugPageId(now());
  let seq = 0;
  let unsaved: DebugRecord[] = [];
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let flushing = false;
  let stopped = false;
  const open = new Set<string>();

  const stored = (): DebugRecord[] => {
    try {
      const value = JSON.parse(env.storage.getItem(BUFFER_KEY) ?? '[]') as unknown;
      return Array.isArray(value) ? (value as DebugRecord[]) : [];
    } catch {
      return [];
    }
  };
  const put = (records: DebugRecord[]): void => {
    try {
      if (records.length === 0) env.storage.removeItem(BUFFER_KEY);
      else env.storage.setItem(BUFFER_KEY, JSON.stringify(records));
    } catch {
      // A full store: what is already there stays.
    }
  };

  const record = (ev: string, fields: Record<string, unknown> = {}): DebugRecord => {
    seq += 1;
    return { ...fields, t: now(), ev, page, seq };
  };

  /** Moves what is new into the store, which every tab of this origin shares. */
  const save = (): void => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    if (unsaved.length === 0) return;
    let all = [...stored(), ...unsaved];
    unsaved = [];
    if (all.length > DEBUG_BUFFER_RECORDS) {
      const dropped = all.length - DEBUG_BUFFER_RECORDS + 1;
      all = [...all.slice(dropped), record('buffer_dropped', { n: dropped })];
    }
    put(all);
  };

  const note = (ev: string, fields?: Record<string, unknown>): void => {
    if (stopped) return;
    unsaved.push(record(ev, fields));
    saveTimer ??= setTimeout(save, SAVE_MS);
  };

  const stop = (): void => {
    stopped = true;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    unsaved = [];
    try {
      env.storage.removeItem(BUFFER_KEY);
      env.storage.removeItem(ON_KEY);
    } catch {
      // Nothing to clear.
    }
  };

  const flush = async (): Promise<void> => {
    if (flushing || stopped) return;
    save();
    const batch = stored().slice(0, INBOX_DEBUG_BATCH_RECORDS);
    if (batch.length === 0) return;
    flushing = true;
    const controller = new AbortController();
    const limit = setTimeout(() => controller.abort(), FLUSH_LIMIT_MS);
    try {
      const response = await env.fetch(INBOX_DEBUG_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ records: batch }),
        signal: controller.signal,
      });
      if (response.status === 404) stop();
      else if (response.ok) {
        const sent = new Set(batch.map((r) => `${r.page}:${r.seq}`));
        put(stored().filter((r) => !sent.has(`${r.page}:${r.seq}`)));
      }
    } catch {
      // Still no way through: the records wait for the next try.
    } finally {
      clearTimeout(limit);
      flushing = false;
    }
  };

  /**
   * The timed flush. It waits while a request is out: a flush could take one of the last connections, or keep a dying
   * one alive and hide the stall this log is for. The buffer holds the records, and the flush after a refresh sends them.
   */
  const flushWhenIdle = (): Promise<void> => (open.size === 0 ? flush() : Promise.resolve());

  let serial = 0;
  /** One request's notes: null when it is not recorded, or when the recording failed before it was sent. */
  const track = (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const path = apiPath(url);
      if (stopped || !path || path === INBOX_DEBUG_PATH) return null;
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      serial += 1;
      const id = `${page}-${serial}`;
      headers.set(INBOX_DEBUG_ID_HEADER, id);
      const started = now();
      const base = { id, method: (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase(), route: debugRoute(path) };
      const elapsed = () => ({ ...base, ms: now() - started });
      const failed = (cause: unknown) => {
        open.delete(id);
        const error = cause instanceof Error ? cause.name : 'Error';
        note(error === 'AbortError' ? 'req_abort' : 'req_fail', { ...elapsed(), error });
      };
      const answered = (response: Response) => {
        note('req_head', { ...elapsed(), status: response.status });
        // A body that stalls is a stall too: the end is when the whole answer is in. Debug mode pays for the copy.
        void response
          .clone()
          .arrayBuffer()
          .then(() => {
            open.delete(id);
            note('req_end', { ...elapsed(), status: response.status });
          }, failed);
      };
      note('req_start', base);
      open.add(id);
      return { sent: { ...init, headers }, answered, failed, id };
    } catch {
      return null;
    }
  };

  /** `fetch`, with each `/api/inbox/` request noted from start to end, and the id both sides log. */
  const tracked = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = track(input, init);
    if (!request) return env.fetch(input, init);
    return env.fetch(input, request.sent).then(
      (response) => {
        try {
          request.answered(response);
        } catch {
          // The caller's answer stands; the log has what it has.
          open.delete(request.id);
        }
        return response;
      },
      (cause) => {
        try {
          request.failed(cause);
        } catch {
          // The caller's error stands.
        }
        throw cause;
      },
    );
  };

  return { note, save, flush, flushWhenIdle, stop, tracked, openRequests: () => open.size, page };
}

/** The path of a same-origin `/api/inbox/` url, else null. */
function apiPath(url: string): string | null {
  try {
    const parsed = new URL(url, typeof location === 'undefined' ? 'http://inbox.invalid' : location.href);
    if (typeof location !== 'undefined' && parsed.origin !== location.origin) return null;
    return parsed.pathname.startsWith(inboxUrl('/')) ? parsed.pathname : null;
  } catch {
    return null;
  }
}

let recorder: ReturnType<typeof createDebugRecorder> | null = null;

/** How often a recording window notes its memory (`mem`) and refreshes its alive marker. */
export const DEBUG_MEMORY_MS = 30_000;
const ALIVE_KEY = 'plannotator-inbox-debug-alive';

/** What the address has open, ids only: the thread, the file and its view. Anything else in the hash stays out. */
export function openRoute(hash: string): { thread?: string; file?: string; view?: string } {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const id = (value: string | null) => (value && /^[A-Za-z0-9_]{1,64}$/.test(value) ? value : undefined);
  const view = params.get('view');
  return { thread: id(params.get('thread')), file: id(params.get('file')), view: view === 'full' || view === 'side' ? view : undefined };
}

/**
 * The page's memory as the log may hold it, in whole MB: the JS heap in use and its limit where the browser tells
 * (Chrome's `performance.memory`), and how many images and elements the page holds.
 */
export function debugMemory(): { heap?: number; heap_limit?: number; imgs?: number; nodes?: number } {
  const memory = (globalThis.performance as unknown as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } } | undefined)?.memory;
  const mb = (bytes: number | undefined) => (typeof bytes === 'number' && Number.isFinite(bytes) ? Math.round(bytes / 1e6) : undefined);
  const doc = typeof document === 'undefined' ? null : document;
  return {
    heap: mb(memory?.usedJSHeapSize),
    heap_limit: mb(memory?.jsHeapSizeLimit),
    imgs: doc ? doc.getElementsByTagName('img').length : undefined,
    nodes: doc ? doc.getElementsByTagName('*').length : undefined,
  };
}

type AliveMark = { page: string; at: number; thread?: string; file?: string; view?: string; heap?: number; imgs?: number };

/**
 * A crash breadcrumb. While a recording page lives, the tab's session storage says so (`mark`); a normal leave
 * (`pagehide`, a refresh, a closed tab) takes it away (`clear`). A renderer that dies ("Aw, Snap") never hears
 * `pagehide`, so the next page in the same tab finds the mark (`previous`) and logs `renderer_gone` with what the
 * dead page had open and how big it had grown. Session storage is the tab's own: another tab never reads it.
 */
export function createAliveMarker(env: { storage: Storage | null; page: string; now?: () => number }) {
  const now = env.now ?? Date.now;
  return {
    /** The mark a page that did not leave cleanly left behind, as a `renderer_gone` record's fields; null when none. */
    previous(): Record<string, unknown> | null {
      try {
        const raw = env.storage?.getItem(ALIVE_KEY);
        if (!raw) return null;
        const mark = JSON.parse(raw) as AliveMark;
        if (!mark || typeof mark.page !== 'string' || mark.page === env.page) return null;
        const discarded = typeof document !== 'undefined' && (document as Document & { wasDiscarded?: boolean }).wasDiscarded === true;
        return { last_page: mark.page, ms: typeof mark.at === 'number' ? now() - mark.at : undefined, thread: mark.thread, file: mark.file, view: mark.view, heap: mark.heap, imgs: mark.imgs, discarded };
      } catch {
        return null;
      }
    },
    mark(route: { thread?: string; file?: string; view?: string }, memory: { heap?: number; imgs?: number } = {}): void {
      try {
        const mark: AliveMark = { page: env.page, at: now(), ...route, heap: memory.heap, imgs: memory.imgs };
        env.storage?.setItem(ALIVE_KEY, JSON.stringify(mark));
      } catch {
        // No session storage: no breadcrumb.
      }
    },
    clear(): void {
      try {
        env.storage?.removeItem(ALIVE_KEY);
      } catch {
        // Nothing to clear.
      }
    },
  };
}

function aliveStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function listen(active: ReturnType<typeof createDebugRecorder>): void {
  const state = () => ({ state: document.visibilityState, online: navigator.onLine });
  const navigation = performance.getEntriesByType?.('navigation')[0] as PerformanceNavigationTiming | undefined;
  active.note('page_load', { ...state(), protocol: navigation?.nextHopProtocol || undefined });
  const alive = createAliveMarker({ storage: aliveStorage(), page: active.page });
  const gone = alive.previous();
  if (gone) active.note('renderer_gone', gone);
  const mark = () => alive.mark(openRoute(window.location.hash), debugMemory());
  mark();
  window.addEventListener('hashchange', mark);
  window.addEventListener('pageshow', (event) => {
    active.note('page_show', { ...state(), persisted: event.persisted });
    if (event.persisted) mark();
  });
  window.addEventListener('pagehide', () => {
    active.note('page_hide', { ...state(), open: active.openRequests() });
    alive.clear();
    active.save();
  });
  // Memory every so often: when the tab dies, the last of these says how big it had grown.
  const sampler = setInterval(() => {
    if (recorder !== active) return;
    active.note('mem', debugMemory());
    mark();
  }, DEBUG_MEMORY_MS);
  whenDebugLogStops(() => {
    clearInterval(sampler);
    window.removeEventListener('hashchange', mark);
    alive.clear();
  });
  document.addEventListener('visibilitychange', () => {
    active.note('visibility', state());
    if (document.visibilityState === 'hidden') active.save();
    else void active.flush();
  });
  window.addEventListener('online', () => {
    active.note('online');
    void active.flush();
  });
  window.addEventListener('offline', () => active.note('offline'));
  setInterval(() => void active.flushWhenIdle(), FLUSH_MS);
  void active.flush();
}

function begin(): void {
  if (recorder) return;
  const active = createDebugRecorder({ storage: window.localStorage, fetch: globalThis.fetch.bind(globalThis) });
  recorder = active;
  globalThis.fetch = active.tracked as typeof fetch;
  listen(active);
}

let resumed = false;

/** Before the page's first read: a window that recorded before starts at once, so a refresh sends what the old page left. */
export function resumeDebugLog(): void {
  if (resumed) return;
  resumed = true;
  try {
    if (window.localStorage.getItem(ON_KEY) === '1') begin();
  } catch {
    // No local storage: no recording.
  }
}

/**
 * From each read's answer: debug on starts this window recording. Only a good answer without the mark ends it: a
 * proxy's 502 during a restart has no mark either, and the buffer may be all that is left of a stall.
 */
export function learnDebugLog(response: Response): void {
  const on = response.headers?.get(INBOX_DEBUG_ON_HEADER) === '1';
  if (on === (recorder !== null)) return;
  try {
    if (on) {
      window.localStorage.setItem(ON_KEY, '1');
      begin();
    } else if (response.ok) {
      recorder?.stop();
      recorder = null;
      for (const listener of [...stopListeners]) listener();
    }
  } catch {
    // No local storage: no recording.
  }
}

const stopListeners = new Set<() => void>();
/** `listener` runs once when this window hears that debug went off (perfMarks.ts tears down its listeners). Returns the removal. */
export function whenDebugLogStops(listener: () => void): () => void {
  const once = () => {
    stopListeners.delete(once);
    listener();
  };
  stopListeners.add(once);
  return () => void stopListeners.delete(once);
}

/** Whether this window is recording (the Inbox's debug log is on): the performance marks (perfMarks.ts) run only then. */
export function debugLogOn(): boolean {
  return recorder !== null;
}

/** A page moment worth a line (Send pressed, Send cleared). A no-op while debug is off. */
export function debugNote(ev: string, fields?: Record<string, unknown>): void {
  recorder?.note(ev, fields);
}
