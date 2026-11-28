import { describe, expect, test } from 'bun:test';
import { languageForPath, semanticDiffFile } from '@plannotator/sem-jiff';
import type { SemDiffReply, SemDiffRequest } from './protocol';
import { createSemDiffClient } from './semDiffClient';
import { semDiffPoolSize } from './semDiffPoolSize';
import { createSemDiffWorkerPool } from './semDiffWorkerPool';
import { computeReviewSemanticDiff } from './semanticDiffSource';

const advert = {
  runtime: '/assets/sem-diff/web-tree-sitter-0.wasm',
  grammars: {
    'tree-sitter-typescript.wasm': '/assets/sem-diff/tree-sitter-typescript-0.wasm',
    'tree-sitter-python.wasm': '/assets/sem-diff/tree-sitter-python-0.wasm',
  },
};

interface Held {
  posted: SemDiffRequest[];
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: (() => void) | null;
  terminated: boolean;
}

function heldWorkers() {
  const workers: Held[] = [];
  const create = () => {
    const held: Held = { posted: [], onmessage: null, onerror: null, terminated: false };
    workers.push(held);
    return {
      set onmessage(fn: (event: MessageEvent) => void) {
        held.onmessage = fn;
      },
      set onerror(fn: () => void) {
        held.onerror = fn;
      },
      postMessage: (request: SemDiffRequest) => held.posted.push(request),
      terminate: () => {
        held.terminated = true;
      },
    } as unknown as Worker;
  };
  const answer = (worker: Held, id: number) => worker.onmessage?.({ data: { id, ok: true, semanticOperations: [], semanticFolds: [], patch: '' } } as MessageEvent);
  return { workers, create, answer };
}

const request = (id: number, background = false): SemDiffRequest => ({ id, advert, origin: 'http://127.0.0.1:1', path: `src/f${id}.ts`, oldText: 'a', newText: 'b', ...(background ? { background: true as const } : {}) });
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

function engineWorker(): Worker {
  const worker = {
    onmessage: null as ((event: MessageEvent<SemDiffReply>) => void) | null,
    onerror: null,
    postMessage(job: SemDiffRequest) {
      void semanticDiffFile(languageForPath(job.path)!, job.oldText, job.newText, job.path).then((r) =>
        worker.onmessage?.({ data: { id: job.id, ok: true, semanticOperations: r.semanticOperations, semanticFolds: r.semanticFolds, patch: r.patch } } as MessageEvent<SemDiffReply>),
      );
    },
    terminate() {},
  };
  return worker as unknown as Worker;
}

function fixture(index: number): { path: string; oldContent: string; newContent: string } {
  const fns = Array.from({ length: 6 }, (_, i) => `export function f${index}_${i}(x: number) {\n  const y = x * ${i + 2};\n  return y + ${index};\n}\n`);
  const after = [...fns.slice(3), ...fns.slice(0, 3)].map((fn, i) => (i === 1 ? fn.replace('const y', 'const yy').replace('return y', 'return yy') : fn));
  return { path: `src/file${index}.ts`, oldContent: fns.join('\n'), newContent: after.join('\n') };
}

describe('semantic diff worker pool', () => {
  test('sizes itself from the cores, and stays at one worker on touch screens and low memory', () => {
    expect(semDiffPoolSize({ cores: 16 })).toBe(4);
    expect(semDiffPoolSize({ cores: 4 })).toBe(3);
    expect(semDiffPoolSize({ cores: 2 })).toBe(1);
    expect(semDiffPoolSize({})).toBe(1);
    expect(semDiffPoolSize({ cores: 16, touch: true })).toBe(1);
    expect(semDiffPoolSize({ cores: 16, memoryGb: 4 })).toBe(1);
    expect(semDiffPoolSize({ cores: 16, memoryGb: 8 })).toBe(4);
  });

  test('a three-file review uses one worker', async () => {
    const { workers, create, answer } = heldWorkers();
    const pool = createSemDiffWorkerPool({ createWorker: create, size: 4 });
    for (const id of [1, 2, 3]) pool.postMessage(request(id));
    await settled();
    for (const id of [1, 2, 3]) {
      answer(workers[0]!, id);
      await settled();
    }
    expect(workers).toHaveLength(1);
    expect(workers[0]!.posted.map((r) => r.id)).toEqual([1, 2, 3]);
  });

  test('files on screen go before background files, and a backlog spreads over more workers once the first is warm', async () => {
    const { workers, create, answer } = heldWorkers();
    const pool = createSemDiffWorkerPool({ createWorker: create, size: 3 });
    for (const id of [1, 2, 3, 4, 5, 6]) pool.postMessage(request(id, true));
    pool.postMessage(request(7));
    await settled();
    expect(workers).toHaveLength(1);
    answer(workers[0]!, 1);
    await settled();
    expect(workers).toHaveLength(3);
    expect(workers.map((w) => w.posted.map((r) => r.id))).toEqual([[1, 7], [2], [3]]);
  });

  test('a worker that dies fails only its own file, and the rest still get answered', async () => {
    const { workers, create, answer } = heldWorkers();
    const pool = createSemDiffWorkerPool({ createWorker: create, size: 2 });
    const replies: SemDiffReply[] = [];
    pool.onmessage = (event: MessageEvent) => replies.push(event.data);
    for (const id of [1, 2, 3, 4, 5]) pool.postMessage(request(id, true));
    await settled();
    answer(workers[0]!, 1);
    await settled();
    workers[1]!.onerror?.();
    await settled();
    expect(workers[1]!.terminated).toBe(true);
    for (let round = 0; round < 6; round++) {
      for (const worker of workers) for (const job of worker.posted) if (!worker.terminated && !replies.some((r) => r.id === job.id)) answer(worker, job.id);
      await settled();
    }
    expect(replies.filter((r) => !r.ok).map((r) => r.id)).toEqual([3]);
    expect(replies.filter((r) => r.ok).map((r) => r.id).sort()).toEqual([1, 2, 4, 5]);
  });

  test('gives the same review-wide result as a single worker', async () => {
    const files = Array.from({ length: 12 }, (_, i) => fixture(i));
    const read = async (file: { path: string }) => files.find((f) => f.path === file.path)!;
    const run = async (createWorker: () => Worker) => {
      const client = createSemDiffClient({ advert, origin: 'http://127.0.0.1:1', createWorker });
      const result = await computeReviewSemanticDiff(files, client, read, new AbortController().signal);
      client.dispose();
      return result;
    };
    const single = await run(engineWorker);
    const pooled = await run(() => createSemDiffWorkerPool({ createWorker: engineWorker, size: 4 }));
    expect(single.summary.total).toBeGreaterThan(0);
    expect(pooled).toEqual(single);
  });
});
