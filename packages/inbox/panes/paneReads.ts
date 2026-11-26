import type { QueryClient } from '@tanstack/react-query';
import type { InboxThread } from '@plannotator/core/inbox-types';
import { InboxApiError, type ListModel, type ThreadModel } from '../api';
import { FIRST_LIST_WAIT_MS, THREAD_READ_RETRY_MS, THREAD_READ_TIMEOUT_MS, UNLISTED_WAIT_MS, type ThreadLoad } from '../app/constants';
import { dropThread, heldThread, isThreadStale, putThread, showableThread } from '../data/queries/thread';
import { deletedHere } from '../data/deletedHere';
import { sameThreadFiles } from '../data/queries/files';
import { lookBoundary } from '../folding';
import { machineOf } from '../inboxUrl';
import { listsThread } from '../openThreadReads';
import { perfThreadOpenDropped, perfThreadOpenStart, perfThreadReadLanded } from '../perfMarks';
import { latestAgentSeq } from '../seenOnSight';
import type { KeyedSignal } from '../signal';
import { joinThreadRead, type ThreadFlight } from '../threadFlights';
import { paneOf, paneThread, type PaneId, type PaneSet } from './model';

/**
 * Each pane's open: the thread's read, what it opened with, and the look behind seen on sight. The reads are by
 * thread (one flight per thread, threadFlights.ts); what a read draws goes to the pane showing that thread
 * (model.ts: one thread in one pane at most). Not React: the window draws `views` (usePaneOpens.ts).
 */

export interface PaneLook {
  threadId: string;
  /** The "new since you looked" boundary (folding.ts), from before this look. Null when the thread carries no seqs. */
  seq: number | null;
  /** What the window's looks this visit cover: the newest agent message of the first read, raised as arrivals are seen. */
  through: number | null;
}

export interface PaneOpenView {
  look: PaneLook | null;
  /** The read when it has not landed: failed (read again soon), missing (a 404) or refused. */
  load: ThreadLoad | null;
  /** The ids of the messages the open's first fresh read had. */
  openedWith: { threadId: string; ids: ReadonlySet<string> } | null;
  /** Try again on the placeholder: each press reads the thread at once. */
  retry: number;
}

export const NO_OPEN: PaneOpenView = { look: null, load: null, openedWith: null, retry: 0 };

/** What a pane's reads keep between renders. */
interface PaneRecord {
  /** The open's first read numbered after its open (`after`: the last number before it). */
  openRead: { threadId: string; after: number } | null;
  /** The thread the pane last opened: Try again on the same thread is not a new open. */
  openedFor: string | null;
  /** The thread as last read, for the open when another read (the event stream's) landed first. */
  loaded: InboxThread | null;
  loadedAt: number;
  /** The newest read number drawn here: an older read never overwrites a newer one that landed (A, then B, then A). */
  applied: number;
  /** Wakes the open's wait between retries when another read lands the thread. */
  wake: (() => void) | null;
  /** A re-read of the thread on screen that failed: read again after THREAD_READ_RETRY_MS. */
  live: { threadId: string; attempt: number; timer: ReturnType<typeof setTimeout> } | null;
  /** When the thread's first 404 waited for linked machines' lists (UNLISTED_WAIT_MS). */
  unlisted: { threadId: string; at: number } | null;
}

export interface PaneReadsDeps {
  client: QueryClient;
  panes: () => PaneSet;
  read: (threadId: string, timeoutMs: number, signal?: AbortSignal) => Promise<ThreadModel>;
  drawReady: (thread: InboxThread) => Promise<unknown>;
  latest: () => ListModel | null;
  firstList: () => { done: boolean; promise: Promise<void> };
  filesSignals: KeyedSignal;
  /** The views changed: the window draws them. */
  drawn: (views: ReadonlyMap<PaneId, PaneOpenView>) => void;
}

export type PaneReads = ReturnType<typeof createPaneReads>;

export function createPaneReads(deps: PaneReadsDeps) {
  const { client } = deps;
  let views: ReadonlyMap<PaneId, PaneOpenView> = new Map();
  const records = new Map<PaneId, PaneRecord>();
  const flights = new Map<string, ThreadFlight>();
  const failures = new Map<string, number>();
  /** The reads of shown threads on their way: given up when no pane shows their thread any more. */
  const out = new Set<{ threadId: string; controller: AbortController }>();
  /** Panes kept off the page (ThreadPanes.tsx): their threads are not read while there. */
  let parked: ReadonlySet<PaneId> = new Set();
  /** Threads off the page that a read passed by (shownReads.ts): read once their pane is back. */
  const owed = new Set<string>();
  let seq = 0;

  const record = (paneId: PaneId): PaneRecord => {
    let r = records.get(paneId);
    if (!r) records.set(paneId, (r = { openRead: null, openedFor: null, loaded: null, loadedAt: 0, applied: 0, wake: null, live: null, unlisted: null }));
    return r;
  };
  const view = (paneId: PaneId): PaneOpenView => views.get(paneId) ?? NO_OPEN;
  const change = (paneId: PaneId, next: Partial<PaneOpenView>) => {
    const now = view(paneId);
    if ((Object.keys(next) as (keyof PaneOpenView)[]).every((key) => now[key] === next[key])) return;
    views = new Map(views).set(paneId, { ...now, ...next });
    deps.drawn(views);
  };
  const setLoad = (paneId: PaneId, load: ThreadLoad | null) => {
    const now = view(paneId).load;
    // The same failure again (a retry): nothing changes on screen, so nothing is said again.
    if (now && load && now.threadId === load.threadId && now.state === load.state && now.error === load.error) return;
    change(paneId, { load });
  };
  const shownIn = (threadId: string): PaneId | null => paneOf(deps.panes(), threadId);
  const stopLive = (paneId: PaneId) => {
    const r = record(paneId);
    if (r.live) clearTimeout(r.live.timer);
    r.live = null;
  };

  /** `given`: a read that came with another answer (a Send's `thread_read`): drawn as a read of the thread, none sent. */
  const readInto = async (threadId: string, given?: ThreadModel): Promise<InboxThread | null> => {
    const mine = ++seq;
    const askedIn = shownIn(threadId);
    if ((askedIn === null ? null : record(askedIn).loaded)?.thread_id !== threadId) perfThreadOpenStart(threadId);
    const askedOwner = machineOf(threadId);
    const reading = askedIn !== null && !given ? { threadId, controller: new AbortController() } : null;
    if (reading) out.add(reading);
    try {
      const next = given ?? (await deps.read(threadId, THREAD_READ_TIMEOUT_MS * 2 ** Math.min(failures.get(threadId) ?? 0, 3), reading?.controller.signal));
      failures.delete(threadId);
      owed.delete(threadId);
      await deps.drawReady(next.thread);
      const pane = shownIn(threadId);
      if (pane !== null && record(pane).unlisted?.threadId === threadId) record(pane).unlisted = null;
      const r = pane === null ? null : record(pane);
      if (pane !== null && r && mine > r.applied) {
        r.applied = mine;
        const before = r.loaded;
        const reread = before?.thread_id === threadId;
        const read = putThread(client, threadId, next).thread;
        // Every real read reads the thread's files again too (a file edited on disk, an image captured since): the
        // pane reads them by itself when the read changed a message's files (data/queries/files.ts), so a read that
        // did not says so here.
        if (reread && sameThreadFiles(before, read)) deps.filesSignals.emit(threadId);
        r.loaded = read;
        r.loadedAt = Date.now();
        r.wake?.();
        stopLive(pane);
        setLoad(pane, null);
        perfThreadReadLanded(threadId, next.thread.messages.length, true);
        // The open's first fresh read: what the thread opened with (never a stale copy shown before it landed).
        if (r.openRead?.threadId === threadId && mine > r.openRead.after) {
          r.openRead = null;
          change(pane, { openedWith: { threadId, ids: new Set(next.thread.messages.map((m) => m.id)) } });
        }
        // What is new since the last look, from the first read of this thread: it lands before the window records
        // the look, and is kept until the person leaves the thread.
        if (view(pane).look?.threadId !== threadId) change(pane, { look: { threadId, seq: lookBoundary(next.thread), through: latestAgentSeq(next.thread) } });
      } else perfThreadReadLanded(threadId, null, pane !== null);
      return next.thread;
    } catch (cause) {
      perfThreadOpenDropped(threadId);
      // Given up: the person moved on to another thread. Nothing to say or retry.
      if (reading?.controller.signal.aborted) return null;
      failures.set(threadId, (failures.get(threadId) ?? 0) + 1);
      // Not on this Inbox, asked before the list named each id's machine: once the first list is read (it may have landed
      // while this read was out; else wait a few seconds at most), read the thread on the machine it names.
      let waiting: string | null = null;
      if (cause instanceof InboxApiError && cause.status === 404 && !askedOwner) {
        const first = deps.firstList();
        if (!machineOf(threadId) && !first.done) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([first.promise, new Promise((r) => (timer = setTimeout(r, FIRST_LIST_WAIT_MS)))]);
          clearTimeout(timer);
        }
        if (machineOf(threadId) && shownIn(threadId) !== null) return readInto(threadId);
        // Just started (a restart, an update): a linked machine whose list this Inbox has not read yet may hold it.
        // Not "deleted" then: read again on the usual schedule, and the thread opens once that list names it. Only a
        // machine that can still send one counts (one that needs an update or removed the link never will), and only
        // for UNLISTED_WAIT_MS; after that it is missing, and a later list naming its machine opens it there (refreshList).
        const unread = (deps.latest()?.machines ?? []).filter((m) => !m.self && m.list_cursor === null && m.state !== 'needs_update' && m.state !== 'revoked');
        const holder = shownIn(threadId);
        const kept = holder === null ? null : record(holder).unlisted;
        const since = kept?.threadId === threadId ? kept.at : Date.now();
        if (holder !== null) record(holder).unlisted = { threadId, at: since };
        if (unread.length > 0 && Date.now() - since < UNLISTED_WAIT_MS) {
          waiting = unread.length === 1 ? `Waiting for ${unread[0]!.name}: this thread may be there.` : 'Waiting for linked machines: this thread may be on one of them.';
        }
      }
      const pane = shownIn(threadId);
      if (pane !== null && mine > record(pane).applied) {
        // What is open stays open (the owner, 2026-11-23): only the Inbox saying it has no such thread is "missing", and
        // a thread already on screen keeps its last read through any 404 (a linked machine briefly not known answers
        // `machine_not_linked`), read again as after any failure. Only one the person deleted here goes (deletedHere.ts).
        const onScreen = record(pane).loaded?.thread_id === threadId ? record(pane).loaded : null;
        const notHere = cause instanceof InboxApiError && cause.status === 404 && cause.code === 'thread_not_found' && !waiting;
        const missing = notHere && (!onScreen || deletedHere(onScreen));
        // Deleted elsewhere while on screen: it stays, says it is gone (ThreadGone.tsx), and is not read again.
        const gone = notHere && !missing;
        // Two linked machines claim it: it opens on neither, and says so (no retry would change that).
        const refused = cause instanceof InboxApiError && cause.code === 'machine_conflict';
        if (missing) dropThread(client, threadId);
        setLoad(pane, { threadId, state: refused ? 'refused' : missing ? 'missing' : 'failed', error: cause instanceof Error ? cause.message : String(cause), waiting, ...(gone ? { gone: true as const } : {}) });
        // The thread is on screen already (the open retries a first read itself): this re-read is tried again, or
        // what it would have brought (an agent's new message) waits until some other record re-reads the thread.
        const r = record(pane);
        if (!missing && !gone && !refused && r.loaded?.thread_id === threadId) {
          const attempt = r.live?.threadId === threadId ? r.live.attempt : 0;
          stopLive(pane);
          const timer = setTimeout(() => {
            if (paneThread(deps.panes(), pane) !== threadId) stopLive(pane);
            else if (parked.has(pane)) {
              // Off the page: tried again once it is back.
              owed.add(threadId);
              stopLive(pane);
            } else void refreshThread(threadId);
          }, THREAD_READ_RETRY_MS[Math.min(attempt, THREAD_READ_RETRY_MS.length - 1)]!);
          r.live = { threadId, attempt: attempt + 1, timer };
        }
      }
      return null;
    } finally {
      if (reading) out.delete(reading);
    }
  };

  const refreshThread = (threadId: string, given?: ThreadModel): Promise<InboxThread | null> =>
    joinThreadRead(flights, threadId, given, readInto, (id) => shownIn(id) !== null && isThreadStale(client, id));

  /** The reads of a thread no pane shows any more are given up: only the ones the person landed on are read. */
  const dropUnshown = () => {
    for (const reading of [...out]) {
      if (shownIn(reading.threadId) !== null) continue;
      reading.controller.abort();
      out.delete(reading);
    }
  };

  /** The pane shows nothing, and keeps no thread in memory. */
  const close = (paneId: PaneId) => {
    dropUnshown();
    const r = record(paneId);
    r.openRead = null;
    r.openedFor = null;
    r.unlisted = null;
    r.loaded = null;
    r.loadedAt = 0;
    setLoad(paneId, null);
    change(paneId, { look: null, openedWith: null });
  };

  /** The pane is gone (or the window): its reads are given up and nothing of it is kept. */
  const remove = (paneId: PaneId) => {
    const thread = records.get(paneId)?.openedFor ?? null;
    stopLive(paneId);
    for (const reading of [...out]) {
      if (reading.threadId !== thread || (shownIn(thread) ?? paneId) !== paneId) continue;
      reading.controller.abort();
      out.delete(reading);
    }
    dropUnshown();
    records.delete(paneId);
    if (!views.has(paneId)) return;
    const next = new Map(views);
    next.delete(paneId);
    views = next;
    deps.drawn(views);
  };

  /**
   * The pane opens `threadId`: read it (again after THREAD_READ_RETRY_MS while it fails, never after a 404), and once
   * a read landed, `opened` (the look). Returns the cleanup for when the pane closes or changes thread.
   */
  const open = (paneId: PaneId, threadId: string, opened: (threadId: string, thread: InboxThread) => void): (() => void) => {
    dropUnshown();
    const r = record(paneId);
    // A new open (not Try again on the same thread): what it opened with comes from its first read numbered after now.
    const newOpen = r.openedFor !== threadId;
    if (newOpen) {
      r.openedFor = threadId;
      r.openRead = { threadId, after: seq };
      r.unlisted = null;
      change(paneId, { openedWith: null });
    }
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    r.loaded = null;
    // Opened a moment ago and current since (data/queries/thread.ts): drawn at once from the cache while its read goes
    // out again below. What the open does with its first read (the look, what it opened with) waits for that read.
    // Only this Inbox's own listed threads; a copy that may have missed something is dropped, so it is never drawn.
    if (newOpen) {
      const cached = !machineOf(threadId) && listsThread(deps.latest(), threadId) ? showableThread(client, threadId) : null;
      if (cached) setLoad(paneId, null);
      else if (heldThread(client, threadId)) dropThread(client, threadId);
    }
    /** Another read (the event stream's) already put this thread on screen. */
    const landed = () => (r.loaded?.thread_id === threadId ? r.loaded : null);
    void (async () => {
      let read: InboxThread | null = null;
      for (let attempt = 0; !read; attempt++) {
        read = (await refreshThread(threadId)) ?? landed();
        if (cancelled) return;
        if (read) break;
        // Another thread opened meanwhile, or the server said this one is not there.
        const load = view(paneId).load;
        if (paneThread(deps.panes(), paneId) !== threadId || (load?.threadId === threadId && (load.state === 'missing' || load.state === 'refused' || load.gone))) return;
        const waitMs = THREAD_READ_RETRY_MS[Math.min(attempt, THREAD_READ_RETRY_MS.length - 1)]!;
        await new Promise<void>((done) => {
          retry = setTimeout(done, waitMs);
          r.wake = done;
        });
        retry = null;
        r.wake = null;
        if (cancelled) return;
        read = landed();
      }
      opened(threadId, read);
    })();
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
      r.wake = null;
      // Closed or changed: a failed re-read of this thread is not tried again.
      stopLive(paneId);
    };
  };

  const retry = (paneId: PaneId) => change(paneId, { retry: view(paneId).retry + 1 });
  return {
    view,
    refreshThread,
    open,
    close,
    remove,
    retry,
    /** The threads on screen, one per pane that shows one; none of a pane kept off the page. */
    shown: (): string[] => deps.panes().panes.flatMap((pane) => (pane.thread && !parked.has(pane.id) ? [pane.thread] : [])),
    /** The threads of the panes kept off the page. */
    parkedThreads: (): string[] => deps.panes().panes.flatMap((pane) => (pane.thread && parked.has(pane.id) ? [pane.thread] : [])),
    /** A read passed `threadId` by while its pane was off the page. */
    owe: (threadId: string) => void owed.add(threadId),
    /**
     * The panes now off the page (ThreadPanes.tsx). A pane back on it reads its thread once, when something changed
     * meanwhile: a read passed it by, or the thread was marked stale.
     */
    park: (next: ReadonlySet<PaneId>) => {
      const back = [...parked].filter((id) => !next.has(id));
      parked = next;
      for (const pane of back) {
        const thread = paneThread(deps.panes(), pane);
        if (!thread || record(pane).loaded?.thread_id !== thread) continue;
        const due = owed.has(thread) || isThreadStale(client, thread);
        owed.delete(thread);
        if (due) void refreshThread(thread);
      }
    },
    /** The thread was missing here, and the list now names the machine that holds it: its pane reads it there. */
    retryMissing: (threadId: string) => {
      const pane = shownIn(threadId);
      const load = pane === null ? null : view(pane).load;
      if (pane !== null && machineOf(threadId) && load?.threadId === threadId && load.state === 'missing') retry(pane);
    },
    /** The active pane's look, read when it is needed (Back from snooze). */
    activeLook: { get current(): PaneLook | null { return view(deps.panes().active).look; } },
    /** The read state of the pane showing `threadId`: its load, its last read and when it landed. */
    readOf: (threadId: string): { load: ThreadLoad | null; loaded: InboxThread | null; loadedAt: number } => {
      const pane = shownIn(threadId);
      if (pane === null) return { load: null, loaded: null, loadedAt: 0 };
      return { load: view(pane).load, loaded: record(pane).loaded, loadedAt: record(pane).loadedAt };
    },
    /** The look of the pane showing `threadId`, when it is that thread's. */
    lookOf: (threadId: string): PaneLook | null => {
      const pane = shownIn(threadId);
      const look = pane === null ? null : view(pane).look;
      return look?.threadId === threadId ? look : null;
    },
    /** The server took a look up to `through`: the pane's look covers it. */
    raiseThrough: (threadId: string, through: number) => {
      const pane = shownIn(threadId);
      const look = pane === null ? null : view(pane).look;
      if (pane !== null && look && look.threadId === threadId && (look.through === null || look.through < through)) change(pane, { look: { ...look, through } });
    },
  };
}
