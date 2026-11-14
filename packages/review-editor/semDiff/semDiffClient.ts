import type { SemanticDiffFold, SemanticDiffOperation } from '@plannotator/sem-diff';
import { languageForPath } from '@plannotator/sem-diff/languages';
import { reviewSummary, SKIM_KINDS, type ReviewSummary } from '@plannotator/sem-diff/summary';
import type { SemDiffAdvert } from '@plannotator/shared/sem-diff-assets';
import { SEM_DIFF_GRAMMARS, type SemDiffReply, type SemDiffRequest } from './protocol';

export const SEM_DIFF_TIMEOUT_MS = 3_000;
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

  const results = new Map<string, Promise<SemDiffResult | null>>();

  const compute = (path: string, oldText: string, newText: string): Promise<SemDiffResult | null> => {
    const id = nextId++;
    const request: SemDiffRequest = { id, advert: advert!, origin, path, oldText, newText };
    return new Promise<SemDiffReply | null>((resolve) => {
      const timer = setTimeout(() => {
        if (pending.has(id)) restart();
      }, timeoutMs);
      pending.set(id, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
      ensureWorker().then(
        (w) => {
          if (pending.has(id)) w.postMessage(request);
        },
        () => {
          pending.get(id)?.(null);
          pending.delete(id);
        },
      );
    }).then((reply) => {
      if (!reply || !reply.ok || !hasSomethingToSay(reply.semanticOperations)) return null;
      return {
        semanticOperations: reply.semanticOperations,
        semanticFolds: reply.semanticFolds,
        patch: reply.patch,
        summary: reviewSummary(reply.semanticOperations),
      };
    });
  };

  return {
    supports,
    async diff(path, oldText, newText, signal) {
      if (!advert || !supports(path) || signal?.aborted || oldText === newText) return null;
      const key = `${path}\0${hashText(oldText)}\0${hashText(newText)}`;
      let result = results.get(key);
      if (!result) {
        result = compute(path, oldText, newText);
        results.set(key, result);
        if (results.size > MAX_CACHED) results.delete(results.keys().next().value!);
      }
      if (!signal) return result;
      return new Promise<SemDiffResult | null>((resolve) => {
        const onAbort = () => resolve(null);
        signal.addEventListener('abort', onAbort, { once: true });
        result!.then((value) => {
          signal.removeEventListener('abort', onAbort);
          resolve(signal.aborted ? null : value);
        });
      });
    },
    dispose() {
      results.clear();
      restart();
    },
  };
}
