import type { SecondOpinionReport, SemanticDiffFold, SemanticDiffOperation } from '@plannotator/sem-jiff';
import { languageForPath } from '@plannotator/sem-jiff/languages';
import { reviewSummary, SKIM_KINDS, type ReviewSummary } from '@plannotator/sem-jiff/summary';
import type { SemDiffAdvert } from '@plannotator/shared/sem-diff-assets';
import { SEM_DIFF_GRAMMARS } from '@plannotator/sem-jiff/grammars';
import type { SemDiffDownload, SemDiffReply, SemDiffRequest } from './protocol';

export const SEM_DIFF_TIMEOUT_MS = 3_000;
export const SEM_DIFF_OPINION_TIMEOUT_MS = 30_000;
export const SEM_DIFF_COLD_TIMEOUT_MS = 30_000;
export const SEM_DIFF_DOWNLOAD_TIMEOUT_MS = 90_000;
const MAX_CACHED = 500;

function hashText(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return `${text.length}:${(h >>> 0).toString(36)}`;
}

export interface SemDiffResult {
  semanticOperations: SemanticDiffOperation[];
  semanticFolds: SemanticDiffFold[];
  patch: string;
  summary: ReviewSummary;
  secondOpinion?: SecondOpinionReport;
}

export interface SemDiffOpinionRequest {
  rejected: readonly string[];
}

export interface SemDiffAttempt {
  result: SemDiffResult | null;
  failed: boolean;
}

export interface SemDiffClient {
  supports(path: string): boolean;
  diff(path: string, oldText: string, newText: string, signal?: AbortSignal, opinion?: SemDiffOpinionRequest): Promise<SemDiffResult | null>;
  attempt(path: string, oldText: string, newText: string, signal?: AbortSignal, opinion?: SemDiffOpinionRequest): Promise<SemDiffAttempt>;
  dispose(): void;
}

export interface SemDiffClientOptions {
  advert: SemDiffAdvert | undefined | null;
  origin: string;
  createWorker: () => Worker | Promise<Worker>;
  timeoutMs?: number;
  coldTimeoutMs?: number;
  downloadTimeoutMs?: number;
  /** The timers every bound runs on. Tests pass their own so they can fire a bound and see exactly which timers this client left. */
  timers?: SemDiffTimers;
}

export interface SemDiffTimers {
  set(fn: () => void, ms: number): unknown;
  clear(timer: unknown): void;
}

const realTimers: SemDiffTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

const HAS_SOMETHING_TO_SAY = new Set<string>([...SKIM_KINDS, 'movedWithEdit']);

export function hasSomethingToSay(operations: SemanticDiffOperation[]): boolean {
  return operations.some((op) => HAS_SOMETHING_TO_SAY.has(op.type));
}

export function createSemDiffClient(options: SemDiffClientOptions): SemDiffClient {
  const { advert, origin, createWorker, timeoutMs = SEM_DIFF_TIMEOUT_MS, coldTimeoutMs = SEM_DIFF_COLD_TIMEOUT_MS, downloadTimeoutMs = SEM_DIFF_DOWNLOAD_TIMEOUT_MS, timers = realTimers } = options;
  const warm = new Set<string>();
  const coldTimedOut = new Map<string, number>();
  const downloading = new Set<string>();
  const downloadTimers = new Map<string, unknown>();
  const stalledDownloads = new Set<string>();
  let worker: Promise<Worker> | null = null;
  let nextId = 1;
  interface Pending {
    request: SemDiffRequest;
    settle: (reply: SemDiffReply | null) => void;
  }
  const pending = new Map<number, Pending>();
  let watchdog: unknown = null;

  const watchHead = () => {
    if (watchdog) timers.clear(watchdog);
    watchdog = null;
    const head = pending.keys().next();
    if (head.done) return;
    const id = head.value;
    const { request } = pending.get(id)!;
    if (downloading.has(languageForPath(request.path) ?? '')) return;
    const limit = request.opinion ? Math.max(timeoutMs, SEM_DIFF_OPINION_TIMEOUT_MS) : warm.has(languageForPath(request.path) ?? '') || (coldTimedOut.get(languageForPath(request.path) ?? '') ?? 0) >= 2 ? timeoutMs : Math.max(timeoutMs, coldTimeoutMs);
    watchdog = timers.set(() => headTimedOut(id), limit);
  };
  const settle = (id: number, reply: SemDiffReply | null) => {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (reply) warm.add(languageForPath(entry.request.path) ?? '');
    entry.settle(reply);
  };
  const dropWorker = () => {
    const old = worker;
    worker = null;
    warm.clear();
    downloading.clear();
    for (const timer of downloadTimers.values()) timers.clear(timer);
    downloadTimers.clear();
    void old?.then((w) => w.terminate(), () => {});
  };
  const post = (id: number) => {
    const entry = pending.get(id);
    if (!entry) return;
    ensureWorker().then(
      (w) => {
        if (pending.has(id)) w.postMessage(entry.request);
      },
      () => {
        settle(id, null);
        watchHead();
      },
    );
  };
  const headTimedOut = (id: number) => {
    watchdog = null;
    const timedOut = pending.get(id);
    if (!timedOut) return;
    const language = languageForPath(timedOut.request.path) ?? '';
    if (!timedOut.request.opinion && !warm.has(language)) coldTimedOut.set(language, (coldTimedOut.get(language) ?? 0) + 1);
    settle(id, null);
    dropWorker();
    for (const other of pending.keys()) post(other);
    watchHead();
  };
  const downloadTimedOut = (language: string) => {
    downloadTimers.delete(language);
    downloading.delete(language);
    stalledDownloads.add(language);
    const head = pending.keys().next().value;
    for (const [id, { request }] of [...pending]) if ((languageForPath(request.path) ?? '') === language) settle(id, null);
    if (pending.keys().next().value !== head) watchHead();
  };
  const heard = ({ download, language }: SemDiffDownload) => {
    if (download === 'start') {
      downloading.add(language);
      if (!downloadTimers.has(language)) downloadTimers.set(language, timers.set(() => downloadTimedOut(language), downloadTimeoutMs));
    } else {
      downloading.delete(language);
      if (downloadTimers.has(language)) timers.clear(downloadTimers.get(language));
      downloadTimers.delete(language);
    }
    const head = pending.values().next();
    if (head.done || (languageForPath(head.value.request.path) ?? '') !== language) return;
    if (download === 'start' && watchdog) {
      timers.clear(watchdog);
      watchdog = null;
    } else if (download === 'done' && !watchdog) watchHead();
  };
    const ensureWorker = (): Promise<Worker> => {
    if (worker) return worker;
    const created = Promise.resolve().then(createWorker).then((w) => {
      w.onmessage = (event: MessageEvent<SemDiffReply | SemDiffDownload>) => {
        if ('download' in event.data) {
          if (worker === created) heard(event.data);
          return;
        }
        if (!pending.has(event.data.id)) return;
        settle(event.data.id, event.data);
        watchHead();
      };
      w.onerror = () => {
        if (worker !== created) return;
        dropWorker();
        for (const id of [...pending.keys()]) settle(id, null);
        watchHead();
      };
      return w;
    });
    worker = created;
    return created;
  };

  const supports = (path: string): boolean => {
    if (!advert) return false;
    const language = languageForPath(path);
    if (!language || !(language in SEM_DIFF_GRAMMARS)) return false;
    return advert.grammars[SEM_DIFF_GRAMMARS[language as keyof typeof SEM_DIFF_GRAMMARS]] != null;
  };

  const results = new Map<string, Promise<SemDiffAttempt>>();

  const compute = (path: string, oldText: string, newText: string, opinion?: SemDiffOpinionRequest): Promise<SemDiffAttempt> => {
    if (stalledDownloads.has(languageForPath(path) ?? '')) return Promise.resolve({ result: null, failed: true });
    const id = nextId++;
    const request: SemDiffRequest = { id, advert: advert!, origin, path, oldText, newText, ...(opinion ? { opinion: { rejected: [...opinion.rejected] } } : {}) };
    return new Promise<SemDiffReply | null>((resolve) => {
      pending.set(id, { request, settle: resolve });
      post(id);
      if (pending.size === 1) watchHead();
    }).then((reply) => {
      if (!reply || !reply.ok) return { result: null, failed: true };
      if (!opinion && !hasSomethingToSay(reply.semanticOperations)) return { result: null, failed: false };
      return {
        result: {
          semanticOperations: reply.semanticOperations,
          semanticFolds: reply.semanticFolds,
          patch: reply.patch,
          summary: reviewSummary(reply.semanticOperations),
          ...(reply.secondOpinion ? { secondOpinion: reply.secondOpinion } : {}),
        },
        failed: false,
      };
    });
  };

  const attempt = async (path: string, oldText: string, newText: string, signal?: AbortSignal, opinion?: SemDiffOpinionRequest): Promise<SemDiffAttempt> => {
    if (!advert || !supports(path) || signal?.aborted || oldText === newText) return { result: null, failed: false };
    const key = `${path}\0${hashText(oldText)}\0${hashText(newText)}${opinion ? `\0opinion\0${[...opinion.rejected].sort().join(',')}` : ''}`;
    let found = results.get(key);
    if (!found) {
      found = compute(path, oldText, newText, opinion);
      results.set(key, found);
      void found.then((outcome) => {
        const keep = !outcome.failed && (!opinion || outcome.result?.secondOpinion?.state === 'ok');
        if (!keep && results.get(key) === found) results.delete(key);
      });
      if (results.size > MAX_CACHED) results.delete(results.keys().next().value!);
    }
    if (!signal) return found;
    return new Promise<SemDiffAttempt>((resolve) => {
      const onAbort = () => resolve({ result: null, failed: false });
      signal.addEventListener('abort', onAbort, { once: true });
      found!.then((value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(signal.aborted ? { result: null, failed: false } : value);
      });
    });
  };

  return {
    supports,
    attempt,
    async diff(path, oldText, newText, signal, opinion) {
      return (await attempt(path, oldText, newText, signal, opinion)).result;
    },
    dispose() {
      results.clear();
      dropWorker();
      for (const id of [...pending.keys()]) settle(id, null);
      watchHead();
    },
  };
}
