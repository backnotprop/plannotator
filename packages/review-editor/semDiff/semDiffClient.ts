import type { SemanticDiffFold, SemanticDiffOperation } from '@plannotator/sem-diff';
import { languageForPath } from '@plannotator/sem-diff/languages';
import { reviewSummary, SKIM_KINDS, type ReviewSummary } from '@plannotator/sem-diff/summary';
import type { SemDiffAdvert } from '@plannotator/shared/sem-diff-assets';
import { SEM_DIFF_GRAMMARS, type SemDiffReply, type SemDiffRequest } from './protocol';

export const SEM_DIFF_TIMEOUT_MS = 3_000;

export interface SemDiffResult {
  semanticOperations: SemanticDiffOperation[];
  semanticFolds: SemanticDiffFold[];
  patch: string;
  summary: ReviewSummary;
}

export interface SemDiffClient {
  supports(path: string): boolean;
  diff(path: string, oldText: string, newText: string, signal?: AbortSignal): Promise<SemDiffResult | null>;
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
  const pending = new Map<number, (reply: SemDiffReply | null) => void>();

  const settleAll = () => {
    for (const resolve of pending.values()) resolve(null);
    pending.clear();
  };
  const restart = () => {
    const old = worker;
    worker = null;
    void old?.then((w) => w.terminate(), () => {});
    settleAll();
  };
  const ensureWorker = (): Promise<Worker> => {
    if (worker) return worker;
    const created = Promise.resolve().then(createWorker).then((w) => {
      w.onmessage = (event: MessageEvent<SemDiffReply>) => {
        const resolve = pending.get(event.data.id);
        if (!resolve) return;
        pending.delete(event.data.id);
        resolve(event.data);
      };
      w.onerror = () => {
        if (worker === created) restart();
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

  return {
    supports,
    async diff(path, oldText, newText, signal) {
      if (!advert || !supports(path) || signal?.aborted || oldText === newText) return null;
      const id = nextId++;
      const request: SemDiffRequest = { id, advert, origin, path, oldText, newText };
      const reply = await new Promise<SemDiffReply | null>((resolve) => {
        const timer = setTimeout(() => {
          if (pending.has(id)) restart();
        }, timeoutMs);
        const finish = (value: SemDiffReply | null) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          resolve(value);
        };
        const onAbort = () => {
          pending.delete(id);
          finish(null);
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        pending.set(id, finish);
        ensureWorker().then(
          (w) => {
            if (pending.has(id)) w.postMessage(request);
          },
          () => {
            pending.delete(id);
            finish(null);
          },
        );
      });
      if (!reply || !reply.ok || signal?.aborted) return null;
      if (!hasSomethingToSay(reply.semanticOperations)) return null;
      return {
        semanticOperations: reply.semanticOperations,
        semanticFolds: reply.semanticFolds,
        patch: reply.patch,
        summary: reviewSummary(reply.semanticOperations),
      };
    },
    dispose() {
      restart();
    },
  };
}
