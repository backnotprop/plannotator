import type { SecondOpinionReport, SemanticDiffFold, SemanticDiffOperation } from '@plannotator/sem-diff';
import { languageForPath } from '@plannotator/sem-diff/languages';
import { reviewSummary, SKIM_KINDS, type ReviewSummary } from '@plannotator/sem-diff/summary';
import type { SemDiffAdvert } from '@plannotator/shared/sem-diff-assets';
import { SEM_DIFF_GRAMMARS, type SemDiffReply, type SemDiffRequest } from './protocol';

export const SEM_DIFF_TIMEOUT_MS = 3_000;
export const SEM_DIFF_OPINION_TIMEOUT_MS = 30_000;
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
}

const HAS_SOMETHING_TO_SAY = new Set<string>([...SKIM_KINDS, 'movedWithEdit']);

export function hasSomethingToSay(operations: SemanticDiffOperation[]): boolean {
  return operations.some((op) => HAS_SOMETHING_TO_SAY.has(op.type));
}

export function createSemDiffClient(options: SemDiffClientOptions): SemDiffClient {
  const { advert, origin, createWorker, timeoutMs = SEM_DIFF_TIMEOUT_MS } = options;
  let worker: Promise<Worker> | null = null;
  let nextId = 1;
  interface Pending {
    request: SemDiffRequest;
    settle: (reply: SemDiffReply | null) => void;
    limitMs: number;
  }
  const pending = new Map<number, Pending>();
  let watchdog: ReturnType<typeof setTimeout> | null = null;

  const watchHead = () => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = null;
    const head = pending.keys().next();
    if (head.done) return;
    const id = head.value;
    watchdog = setTimeout(() => headTimedOut(id), pending.get(id)!.limitMs);
  };
  const settle = (id: number, reply: SemDiffReply | null) => {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    entry.settle(reply);
  };
  const dropWorker = () => {
    const old = worker;
    worker = null;
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
    if (!pending.has(id)) return;
    settle(id, null);
    dropWorker();
    for (const other of pending.keys()) post(other);
    watchHead();
  };
  const ensureWorker = (): Promise<Worker> => {
    if (worker) return worker;
    const created = Promise.resolve().then(createWorker).then((w) => {
      w.onmessage = (event: MessageEvent<SemDiffReply>) => {
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
    const id = nextId++;
    const request: SemDiffRequest = { id, advert: advert!, origin, path, oldText, newText, ...(opinion ? { opinion: { rejected: [...opinion.rejected] } } : {}) };
    return new Promise<SemDiffReply | null>((resolve) => {
      pending.set(id, { request, settle: resolve, limitMs: opinion ? Math.max(timeoutMs, SEM_DIFF_OPINION_TIMEOUT_MS) : timeoutMs });
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
