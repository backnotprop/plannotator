import { languageForPath } from '@plannotator/sem-jiff/languages';
import type { SemDiffDownload, SemDiffPromote, SemDiffReply, SemDiffRequest } from './protocol';
import { SEM_DIFF_COLD_TIMEOUT_MS, SEM_DIFF_OPINION_TIMEOUT_MS, SEM_DIFF_TIMEOUT_MS, type SemDiffTimers } from './semDiffClient';

export const SPAWN_BACKLOG = 3;
export const JOBS_PER_WORKER = 2;
export const IDLE_RELEASE_MS = 45_000;

export interface SemDiffWorkerPoolOptions {
  createWorker: () => Worker | Promise<Worker>;
  size: number;
  timers?: SemDiffTimers;
  timeoutMs?: number;
  coldTimeoutMs?: number;
  opinionTimeoutMs?: number;
}

interface Slot {
  worker: Promise<Worker>;
  jobs: Map<number, SemDiffRequest>;
  asides: Map<number, unknown>;
  downloads: Set<string>;
  warm: Set<string>;
  answered: boolean;
  timer: unknown;
}

type Message = SemDiffReply | SemDiffDownload;

const realTimers: SemDiffTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

const languageOf = (request: SemDiffRequest) => languageForPath(request.path) ?? '';

export function createSemDiffWorkerPool(options: SemDiffWorkerPoolOptions): Worker {
  const { createWorker, timers = realTimers, timeoutMs = SEM_DIFF_TIMEOUT_MS, coldTimeoutMs = SEM_DIFF_COLD_TIMEOUT_MS, opinionTimeoutMs = SEM_DIFF_OPINION_TIMEOUT_MS } = options;
  let size = options.size;
  const slots: Slot[] = [];
  const waiting: SemDiffRequest[] = [];
  const downloads = new Map<string, number>();
  const coldTimeouts = new Map<string, number>();
  let warm = false;
  let closed = false;
  let broken = false;
  let loadFailures = 0;
  let idleTimer: unknown = null;
  const pool = {
    onmessage: null as ((event: MessageEvent<Message>) => void) | null,
    onerror: null as (() => void) | null,
    postMessage,
    terminate,
  };

  const emit = (data: Message) => pool.onmessage?.({ data } as MessageEvent<Message>);
  const fail = (id: number, error: string) => emit({ id, ok: false, error });

  const release = (slot: Slot, language: string) => {
    if (!slot.downloads.delete(language)) return;
    const left = (downloads.get(language) ?? 1) - 1;
    if (left > 0) downloads.set(language, left);
    else {
      downloads.delete(language);
      emit({ download: 'done', language });
    }
  };

  const watch = (slot: Slot) => {
    if (slot.timer != null) timers.clear(slot.timer);
    slot.timer = null;
    const current = slot.jobs.values().next();
    if (current.done) return;
    const request = current.value;
    const language = languageOf(request);
    if (slot.downloads.has(language)) return;
    const limit = slot.warm.has(language) || (coldTimeouts.get(language) ?? 0) >= 2 ? timeoutMs : Math.max(timeoutMs, coldTimeoutMs);
    slot.timer = timers.set(() => timedOut(slot, request), limit);
  };

  const remove = (slot: Slot): boolean => {
    const at = slots.indexOf(slot);
    if (closed || at < 0) return false;
    slots.splice(at, 1);
    if (slot.timer != null) timers.clear(slot.timer);
    for (const timer of slot.asides.values()) timers.clear(timer);
    void slot.worker.then((w) => w.terminate(), () => {});
    for (const language of [...slot.downloads]) release(slot, language);
    return true;
  };

  const requeue = (requests: SemDiffRequest[]) => waiting.unshift(...requests);

  const failAsides = (slot: Slot) => {
    const ids = [...slot.asides.keys()];
    slot.asides.clear();
    for (const id of ids) fail(id, 'worker stopped');
  };

  const timedOut = (slot: Slot, request: SemDiffRequest) => {
    slot.timer = null;
    if (!slots.includes(slot) || !slot.jobs.has(request.id)) return;
    const language = languageOf(request);
    if (!slot.warm.has(language)) coldTimeouts.set(language, (coldTimeouts.get(language) ?? 0) + 1);
    slot.jobs.delete(request.id);
    const untouched = [...slot.jobs.values()];
    slot.jobs.clear();
    remove(slot);
    fail(request.id, 'timed out');
    failAsides(slot);
    requeue(untouched);
    dispatch();
  };

  const crashed = (slot: Slot) => {
    const jobs = [...slot.jobs.values()];
    slot.jobs.clear();
    if (!remove(slot)) return;
    failAsides(slot);
    if (!slot.answered) return notLoaded(jobs);
    const [current, ...untouched] = jobs;
    if (current) fail(current.id, 'worker stopped');
    requeue(untouched);
    dispatch();
  };

  const notLoaded = (jobs: SemDiffRequest[]) => {
    loadFailures++;
    if (loadFailures > 1) size = Math.max(1, slots.length);
    if (loadFailures > 1 && slots.length === 0) {
      broken = true;
      for (const request of [...jobs, ...waiting.splice(0)]) fail(request.id, 'worker did not start');
      return;
    }
    requeue(jobs);
    dispatch();
  };

  const heard = (slot: Slot, message: SemDiffDownload) => {
    if (message.download === 'done') release(slot, message.language);
    else if (!slot.downloads.has(message.language)) {
      slot.downloads.add(message.language);
      const count = downloads.get(message.language) ?? 0;
      downloads.set(message.language, count + 1);
      if (count === 0) emit(message);
    }
    watch(slot);
    dispatch();
  };

  const spawn = (): Slot => {
    const slot: Slot = { worker: Promise.resolve().then(createWorker), jobs: new Map(), asides: new Map(), downloads: new Set(), warm: new Set(), answered: false, timer: null };
    slots.push(slot);
    slot.worker.then(
      (w) => {
        w.onmessage = (event: MessageEvent<Message>) => {
          if (closed || !slots.includes(slot)) return;
          slot.answered = true;
          const data = event.data;
          if ('download' in data) return heard(slot, data);
          const job = slot.jobs.get(data.id);
          if (job) {
            slot.jobs.delete(data.id);
            slot.warm.add(languageOf(job));
            warm = true;
            watch(slot);
          } else if (slot.asides.has(data.id)) {
            timers.clear(slot.asides.get(data.id));
            slot.asides.delete(data.id);
          } else return;
          emit(data);
          dispatch();
        };
        w.onerror = () => crashed(slot);
      },
      () => {
        const jobs = [...slot.jobs.values()];
        slot.jobs.clear();
        if (!remove(slot)) return;
        failAsides(slot);
        notLoaded(jobs);
      },
    );
    return slot;
  };

  const send = (slot: Slot, request: SemDiffRequest) => {
    void slot.worker.then((w) => {
      if (!closed && slots.includes(slot)) w.postMessage(request);
    }, () => {});
  };

  const freeSlot = (): Slot | null => {
    const empty = slots.find((slot) => slot.jobs.size === 0);
    if (empty) return empty;
    const stalled = slots.length > 0 && slots.every((slot) => slot.downloads.size > 0);
    const backlog = slots.reduce((sum, slot) => sum + slot.jobs.size - 1, waiting.length);
    if (slots.length === 0 || (warm && !stalled && slots.length < size && backlog >= SPAWN_BACKLOG)) return spawn();
    const least = slots.reduce((a, b) => (b.jobs.size < a.jobs.size ? b : a));
    return stalled || least.jobs.size < JOBS_PER_WORKER ? least : null;
  };

  const settleIdle = () => {
    const idle = waiting.length === 0 && slots.length > 1 && slots.every((slot) => slot.jobs.size === 0 && slot.asides.size === 0);
    if (!idle) {
      if (idleTimer != null) timers.clear(idleTimer);
      idleTimer = null;
      return;
    }
    idleTimer ??= timers.set(() => {
      idleTimer = null;
      if (closed || waiting.length > 0 || slots.some((slot) => slot.jobs.size > 0 || slot.asides.size > 0)) return;
      for (const slot of slots.slice(1)) remove(slot);
    }, IDLE_RELEASE_MS);
  };

  function dispatch(): void {
    while (!closed && !broken && waiting.length > 0) {
      const slot = freeSlot();
      if (!slot) break;
      const visible = waiting.findIndex((request) => !request.background);
      const [request] = waiting.splice(visible < 0 ? 0 : visible, 1);
      slot.jobs.set(request!.id, request!);
      send(slot, request!);
      if (slot.jobs.size === 1) watch(slot);
    }
    if (!closed) settleIdle();
  }

  function promote(id: number): void {
    const at = waiting.findIndex((request) => request.id === id);
    if (at < 0) return;
    const [request] = waiting.splice(at, 1);
    const { background: _background, ...foreground } = request!;
    waiting.unshift(foreground);
  }

  function postMessage(message: SemDiffRequest | SemDiffPromote): void {
    if (closed) return;
    if ('promote' in message) return promote(message.promote);
    if (broken) return fail(message.id, 'worker did not start');
    if (message.opinion) {
      const slot = slots[0] ?? spawn();
      const id = message.id;
      slot.asides.set(id, timers.set(() => {
        if (!slot.asides.delete(id)) return;
        fail(id, 'timed out');
        settleIdle();
      }, Math.max(timeoutMs, opinionTimeoutMs)));
      send(slot, message);
      settleIdle();
      return;
    }
    waiting.push(message);
    dispatch();
  }

  function terminate(): void {
    if (idleTimer != null) timers.clear(idleTimer);
    for (const slot of [...slots]) remove(slot);
    closed = true;
    waiting.length = 0;
  }

  return pool as unknown as Worker;
}
