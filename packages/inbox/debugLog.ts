/**
 * The window's side of the Inbox's debug log (packages/core/inbox-debug-log.ts). Off, nothing here runs: fetch is
 * untouched and nothing is stored. An Inbox with debug on marks its answers (`INBOX_DEBUG_ON_HEADER`), and from then
 * on this window wraps `fetch`, which covers every request in one place, and notes the page's own events.
 *
 * During a stall the window cannot reach the server, so every record goes to a capped local buffer first and is
 * sent when it can be, including right after a refresh: that is what shows what the old page was waiting on. A
 * request id is on both sides of the log. Only ids, routes, statuses and timings are recorded.
 */
import { debugRoute, INBOX_DEBUG_ID_HEADER, INBOX_DEBUG_ON_HEADER, INBOX_DEBUG_PATH } from '@plannotator/core/inbox-debug-log';
import { inboxUrl } from './inboxUrl';

const ON_KEY = 'plannotator-inbox-debug';
const BUFFER_KEY = 'plannotator-inbox-debug-buffer';
/** The oldest records go first past this, with a `buffer_dropped` saying how many. */
export const DEBUG_BUFFER_RECORDS = 2000;
const BATCH_RECORDS = 500;
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
  const page = `p${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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
    const batch = stored().slice(0, BATCH_RECORDS);
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

  let serial = 0;
  /** `fetch`, with each `/api/inbox/` request noted from start to end, and the id both sides log. */
  const tracked = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = apiPath(url);
    if (stopped || !path || path === INBOX_DEBUG_PATH) return env.fetch(input, init);
    serial += 1;
    const id = `${page}-${serial}`;
    const started = now();
    const base = { id, method: (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase(), route: debugRoute(path) };
    const elapsed = () => ({ ...base, ms: now() - started });
    const failed = (cause: unknown) => {
      open.delete(id);
      const error = cause instanceof Error ? cause.name : 'Error';
      note(error === 'AbortError' ? 'req_abort' : 'req_fail', { ...elapsed(), error });
    };
    note('req_start', base);
    open.add(id);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set(INBOX_DEBUG_ID_HEADER, id);
    return env.fetch(input, { ...init, headers }).then(
      (response) => {
        note('req_head', { ...elapsed(), status: response.status });
        // A body that stalls is a stall too: the end is when the whole answer is in. Debug mode pays for the copy.
        void response
          .clone()
          .arrayBuffer()
          .then(() => {
            open.delete(id);
            note('req_end', { ...elapsed(), status: response.status });
          }, failed);
        return response;
      },
      (cause) => {
        failed(cause);
        throw cause;
      },
    );
  };

  return { note, save, flush, stop, tracked, openRequests: () => open.size, page };
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

function listen(active: ReturnType<typeof createDebugRecorder>): void {
  const state = () => ({ state: document.visibilityState, online: navigator.onLine });
  const navigation = performance.getEntriesByType?.('navigation')[0] as PerformanceNavigationTiming | undefined;
  active.note('page_load', { ...state(), protocol: navigation?.nextHopProtocol || undefined });
  window.addEventListener('pageshow', (event) => active.note('page_show', { ...state(), persisted: event.persisted }));
  window.addEventListener('pagehide', () => {
    active.note('page_hide', { ...state(), open: active.openRequests() });
    active.save();
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
  setInterval(() => void active.flush(), FLUSH_MS);
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
    }
  } catch {
    // No local storage: no recording.
  }
}

/** A page moment worth a line (Send pressed, Send cleared). A no-op while debug is off. */
export function debugNote(ev: string, fields?: Record<string, unknown>): void {
  recorder?.note(ev, fields);
}
