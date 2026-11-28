import { describe, expect, test } from 'bun:test';
import { languageForPath, semanticDiffFile } from '@plannotator/sem-jiff';
import type { SemDiffReply, SemDiffRequest } from './protocol';
import { createSemDiffClient, type SemDiffTimers } from './semDiffClient';
import { semDiffPoolSize } from './semDiffPoolSize';
import { createSemDiffWorkerPool, IDLE_RELEASE_MS } from './semDiffWorkerPool';
import { computeReviewSemanticDiff } from './semanticDiffSource';

const advert = {
  runtime: '/assets/sem-diff/web-tree-sitter-0.wasm',
  grammars: {
    'tree-sitter-typescript.wasm': '/assets/sem-diff/tree-sitter-typescript-0.wasm',
    'tree-sitter-python.wasm': '/assets/sem-diff/tree-sitter-python-0.wasm',
  },
};

interface Held {
  posted: unknown[];
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: (() => void) | null;
  terminated: boolean;
}

function heldWorkers(fails: (attempt: number) => boolean = () => false) {
  const workers: Held[] = [];
  let attempts = 0;
  const create = () => {
    if (fails(++attempts)) return Promise.reject(new Error('no worker'));
    const held: Held = { posted: [], onmessage: null, onerror: null, terminated: false };
    workers.push(held);
    return {
      set onmessage(fn: (event: MessageEvent) => void) {
        held.onmessage = fn;
      },
      set onerror(fn: () => void) {
        held.onerror = fn;
      },
      postMessage: (message: unknown) => held.posted.push(message),
      terminate: () => {
        held.terminated = true;
      },
    } as unknown as Worker;
  };
  const answer = (worker: Held, id: number) => worker.onmessage?.({ data: { id, ok: true, semanticOperations: [], semanticFolds: [], patch: '' } } as MessageEvent);
  const ids = (worker: Held) => worker.posted.map((message) => (message as SemDiffRequest).id);
  return { workers, create, answer, ids, attempts: () => attempts };
}

function clock() {
  let now = 0;
  const pending: { at: number; fn: () => void; live: boolean }[] = [];
  const timers: SemDiffTimers = {
    set(fn, ms) {
      const timer = { at: now + ms, fn, live: true };
      pending.push(timer);
      return timer;
    },
    clear(timer) {
      if (timer) (timer as { live: boolean }).live = false;
    },
  };
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const due = pending.filter((t) => t.live && t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      now = due.at;
      due.live = false;
      due.fn();
    }
    now = until;
  };
  return { timers, advance };
}

const request = (id: number, background = false, path = `src/f${id}.ts`): SemDiffRequest => ({ id, advert, origin: 'http://127.0.0.1:1', path, oldText: 'a', newText: 'b', ...(background ? { background: true as const } : {}) });
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

function listen(pool: Worker) {
  const replies: SemDiffReply[] = [];
  pool.onmessage = (event: MessageEvent) => {
    if ('id' in event.data) replies.push(event.data);
  };
  return { replies, failed: () => replies.filter((r) => !r.ok).map((r) => r.id).sort((a, b) => a - b) };
}

describe('semantic diff worker pool', () => {
  test('sizes itself from the cores, and stays at one worker on touch screens and low memory', () => {
    expect(semDiffPoolSize({ cores: 16 })).toBe(4);
    expect(semDiffPoolSize({ cores: 8 })).toBe(3);
    expect(semDiffPoolSize({ cores: 6 })).toBe(2);
    expect(semDiffPoolSize({ cores: 4 })).toBe(1);
    expect(semDiffPoolSize({})).toBe(1);
    expect(semDiffPoolSize({ cores: 16, touch: true })).toBe(1);
    expect(semDiffPoolSize({ cores: 16, memoryGb: 4 })).toBe(1);
    expect(semDiffPoolSize({ cores: 16, memoryGb: 8 })).toBe(4);
  });

  test('a three-file review uses one worker', async () => {
    const { workers, create, answer, ids } = heldWorkers();
    const pool = createSemDiffWorkerPool({ createWorker: create, size: 4, timers: clock().timers });
    for (const id of [1, 2, 3]) pool.postMessage(request(id));
    await settled();
    for (const id of [1, 2, 3]) {
      answer(workers[0]!, id);
      await settled();
    }
    expect(workers).toHaveLength(1);
    expect(ids(workers[0]!)).toEqual([1, 2, 3]);
  });

  test('files on screen go before background files, and a backlog spreads over more workers once the first is warm', async () => {
    const { workers, create, answer, ids } = heldWorkers();
    const pool = createSemDiffWorkerPool({ createWorker: create, size: 3, timers: clock().timers });
    for (const id of [1, 2, 3, 4, 5, 6]) pool.postMessage(request(id, true));
    pool.postMessage(request(7));
    await settled();
    expect(workers).toHaveLength(1);
    answer(workers[0]!, 1);
    await settled();
    expect(workers.map(ids)).toEqual([[1, 2, 4], [7, 5], [3, 6]]);
  });

  test('a list file asked for on screen moves to the front of the queue', async () => {
    const { workers, create, answer, ids } = heldWorkers();
    const pool = createSemDiffWorkerPool({ createWorker: create, size: 1, timers: clock().timers });
    for (const id of [1, 2, 3, 4, 5]) pool.postMessage(request(id, true));
    pool.postMessage({ promote: 5 } as unknown as SemDiffRequest);
    await settled();
    answer(workers[0]!, 1);
    await settled();
    expect(ids(workers[0]!)).toEqual([1, 2, 5]);
  });

  test('a hung worker is caught at its own deadline while the others keep answering, and only its file is blamed', async () => {
    const { workers, create, answer, ids } = heldWorkers();
    const { timers, advance } = clock();
    const pool = createSemDiffWorkerPool({ createWorker: create, size: 2, timers, timeoutMs: 3_000, coldTimeoutMs: 30_000 });
    const { replies, failed } = listen(pool);
    for (const id of [1, 2, 3, 4, 5, 6]) pool.postMessage(request(id, true));
    await settled();
    answer(workers[0]!, 1);
    await settled();
    expect(ids(workers[1]!)).toEqual([3, 5]);
    for (let second = 0; second < 29; second++) {
      for (const id of ids(workers[0]!)) if (!replies.some((r) => r.id === id)) answer(workers[0]!, id);
      await settled();
      advance(1_000);
    }
    expect(failed()).toEqual([]);
    advance(1_000);
    await settled();
    expect(failed()).toEqual([3]);
    expect(workers[1]!.terminated).toBe(true);
    for (let round = 0; round < 4; round++) {
      for (const worker of workers) for (const id of ids(worker)) if (!worker.terminated && !replies.some((r) => r.id === id)) answer(worker, id);
      await settled();
    }
    expect(replies.filter((r) => r.ok).map((r) => r.id).sort()).toEqual([1, 2, 4, 5, 6]);
  });

  test('a file that never started is never timed out, and the replacement worker is given the cold limit', async () => {
    const { workers, create, answer, ids } = heldWorkers();
    const { timers, advance } = clock();
    const pool = createSemDiffWorkerPool({ createWorker: create, size: 1, timers, timeoutMs: 3_000, coldTimeoutMs: 30_000 });
    const { failed } = listen(pool);
    for (const id of [1, 2, 3]) pool.postMessage(request(id, true));
    pool.postMessage(request(4));
    await settled();
    answer(workers[0]!, 1);
    await settled();
    answer(workers[0]!, 2);
    await settled();
    expect(ids(workers[0]!)).toEqual([1, 2, 4, 3]);
    advance(3_000);
    await settled();
    expect(failed()).toEqual([4]);
    expect(ids(workers[1]!)).toEqual([3]);
    advance(29_000);
    await settled();
    expect(failed()).toEqual([4]);
    answer(workers[1]!, 3);
    await settled();
    expect(failed()).toEqual([4]);
  });

  test('a file running while the one before it waits for its grammar still has a deadline', async () => {
    const { workers, create, answer, ids } = heldWorkers();
    const { timers, advance } = clock();
    const pool = createSemDiffWorkerPool({ createWorker: create, size: 1, timers, timeoutMs: 3_000, coldTimeoutMs: 30_000 });
    const { failed } = listen(pool);
    pool.postMessage(request(1));
    await settled();
    answer(workers[0]!, 1);
    pool.postMessage(request(2, false, 'src/p.py'));
    pool.postMessage(request(3, false, 'src/t.ts'));
    await settled();
    workers[0]!.onmessage?.({ data: { download: 'start', language: 'python' } } as MessageEvent);
    expect(ids(workers[0]!)).toEqual([1, 2, 3]);
    advance(3_000);
    await settled();
    expect(failed()).toEqual([3]);
    expect(workers[0]!.terminated).toBe(true);
    expect(ids(workers[1]!)).toEqual([2]);
  });

  test('a file the client gave up on frees its worker, so the idle stop still releases it', async () => {
    const { workers, create, answer, ids } = heldWorkers();
    const { timers, advance } = clock();
    const pool = createSemDiffWorkerPool({ createWorker: create, size: 2, timers });
    const { replies } = listen(pool);
    for (const id of [1, 2, 3, 4, 5, 6]) pool.postMessage(request(id, true, id === 3 ? 'src/p.py' : `src/f${id}.ts`));
    await settled();
    answer(workers[0]!, 1);
    await settled();
    expect(ids(workers[1]!)[0]).toBe(3);
    workers[1]!.onmessage?.({ data: { download: 'start', language: 'python' } } as MessageEvent);
    for (let round = 0; round < 6; round++) {
      for (const worker of workers) for (const id of ids(worker)) if (id !== 3 && !replies.some((r) => r.id === id)) answer(worker, id);
      await settled();
    }
    advance(IDLE_RELEASE_MS);
    await settled();
    expect(workers[1]!.terminated).toBe(false);
    pool.postMessage({ forget: [3] } as unknown as SemDiffRequest);
    advance(IDLE_RELEASE_MS);
    await settled();
    expect(workers[1]!.terminated).toBe(true);
  });

  test('the client tells the pool which files it gave up on when a grammar never arrives', async () => {
    const posted: unknown[] = [];
    let send: ((event: MessageEvent) => void) | null = null;
    const worker = {
      set onmessage(fn: (event: MessageEvent) => void) {
        send = fn;
      },
      set onerror(_fn: () => void) {},
      postMessage: (message: unknown) => posted.push(message),
      terminate() {},
      semDiffPool: true,
    } as unknown as Worker;
    const { timers, advance } = clock();
    const client = createSemDiffClient({ advert, origin: 'http://127.0.0.1:1', createWorker: () => worker, timers, downloadTimeoutMs: 90_000 });
    const asked = client.attempt('src/p.py', 'a = 1\n', 'a = 2\n');
    await settled();
    send!({ data: { download: 'start', language: 'python' } } as MessageEvent);
    advance(90_000);
    expect(await asked).toEqual({ result: null, failed: true });
    await settled();
    expect(posted[1]).toEqual({ forget: [(posted[0] as SemDiffRequest).id] });
    client.dispose();
  });

  test('a worker that dies fails only the file it was on; the file waiting in it goes to another', async () => {
    const { workers, create, answer, ids } = heldWorkers();
    const pool = createSemDiffWorkerPool({ createWorker: create, size: 1, timers: clock().timers });
    const { replies, failed } = listen(pool);
    for (const id of [1, 2, 3]) pool.postMessage(request(id));
    await settled();
    answer(workers[0]!, 1);
    await settled();
    workers[0]!.onerror?.();
    await settled();
    expect(failed()).toEqual([2]);
    expect(ids(workers[1]!)).toEqual([3]);
    answer(workers[1]!, 3);
    expect(replies.filter((r) => r.ok).map((r) => r.id)).toEqual([1, 3]);
  });

  test('extra workers stop after a quiet spell and come back when a backlog returns', async () => {
    const { workers, create, answer, ids } = heldWorkers();
    const { timers, advance } = clock();
    const pool = createSemDiffWorkerPool({ createWorker: create, size: 3, timers });
    const { replies } = listen(pool);
    const drain = async () => {
      for (let round = 0; round < 6; round++) {
        for (const worker of workers) for (const id of ids(worker)) if (!worker.terminated && !replies.some((r) => r.id === id)) answer(worker, id);
        await settled();
      }
    };
    for (const id of [1, 2, 3, 4, 5, 6, 7]) pool.postMessage(request(id, true));
    await settled();
    await drain();
    expect(workers).toHaveLength(3);
    advance(IDLE_RELEASE_MS - 1);
    await settled();
    expect(workers.map((w) => w.terminated)).toEqual([false, false, false]);
    advance(1);
    await settled();
    expect(workers.map((w) => w.terminated)).toEqual([false, true, true]);
    for (const id of [8, 9, 10, 11, 12, 13]) pool.postMessage(request(id, true));
    await settled();
    await drain();
    expect(workers.filter((w) => !w.terminated)).toHaveLength(3);
  });

  test('a worker that fails to start is tried once more, and a pool that cannot start any fails its files as before', async () => {
    const once = heldWorkers((attempt) => attempt === 1);
    const recovering = createSemDiffWorkerPool({ createWorker: once.create, size: 4, timers: clock().timers });
    const recovered = listen(recovering);
    recovering.postMessage(request(1));
    await settled();
    await settled();
    once.answer(once.workers[0]!, 1);
    expect(recovered.replies.map((r) => [r.id, r.ok])).toEqual([[1, true]]);

    const never = heldWorkers(() => true);
    const dead = createSemDiffWorkerPool({ createWorker: never.create, size: 4, timers: clock().timers });
    const { failed } = listen(dead);
    for (const id of [1, 2, 3]) dead.postMessage(request(id));
    for (let round = 0; round < 4; round++) await settled();
    dead.postMessage(request(4));
    expect(failed()).toEqual([1, 2, 3, 4]);
    expect(never.attempts()).toBe(2);
  });

  test('Power Up goes to the first worker', async () => {
    const { workers, create, answer, ids } = heldWorkers();
    const pool = createSemDiffWorkerPool({ createWorker: create, size: 3, timers: clock().timers });
    for (const id of [1, 2, 3, 4, 5, 6, 7]) pool.postMessage(request(id, true));
    await settled();
    answer(workers[0]!, 1);
    await settled();
    expect(workers).toHaveLength(3);
    pool.postMessage({ ...request(8), opinion: { rejected: [] } });
    await settled();
    expect(ids(workers[0]!)).toContain(8);
    expect([...ids(workers[1]!), ...ids(workers[2]!)]).not.toContain(8);
  });

  test('no worker is added while every worker is fetching a grammar', async () => {
    const { workers, create, answer, ids } = heldWorkers();
    const pool = createSemDiffWorkerPool({ createWorker: create, size: 4, timers: clock().timers });
    pool.postMessage(request(1));
    await settled();
    answer(workers[0]!, 1);
    pool.postMessage(request(2, true, 'src/a.py'));
    await settled();
    workers[0]!.onmessage?.({ data: { download: 'start', language: 'python' } } as MessageEvent);
    for (const id of [3, 4, 5, 6, 7]) pool.postMessage(request(id, true));
    await settled();
    expect(workers).toHaveLength(1);
    expect(ids(workers[0]!)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  test('nothing is passed on after the pool is closed', async () => {
    const { workers, create, answer } = heldWorkers();
    const pool = createSemDiffWorkerPool({ createWorker: create, size: 2, timers: clock().timers });
    const { replies } = listen(pool);
    pool.postMessage(request(1));
    await settled();
    pool.terminate();
    answer(workers[0]!, 1);
    pool.postMessage(request(2));
    await settled();
    expect(replies).toEqual([]);
    expect(workers[0]!.terminated).toBe(true);
    expect(workers).toHaveLength(1);
  });

  test('the Semantic diff list asks in the background, and the same file asked on screen is moved up', async () => {
    const posted: unknown[] = [];
    let send: ((event: MessageEvent) => void) | null = null;
    const worker = {
      set onmessage(fn: (event: MessageEvent) => void) {
        send = fn;
      },
      set onerror(_fn: () => void) {},
      postMessage: (message: unknown) => posted.push(message),
      terminate() {},
      semDiffPool: true,
    } as unknown as Worker;
    const client = createSemDiffClient({ advert, origin: 'http://127.0.0.1:1', createWorker: () => worker });
    const file = fixture(0);
    const listed = computeReviewSemanticDiff([file], client, async () => file, new AbortController().signal);
    await settled();
    expect(posted).toHaveLength(1);
    expect((posted[0] as SemDiffRequest).background).toBe(true);
    const onScreen = client.diff(file.path, file.oldContent, file.newContent);
    await settled();
    expect(posted[1]).toEqual({ promote: (posted[0] as SemDiffRequest).id });
    send!({ data: { id: (posted[0] as SemDiffRequest).id, ok: true, semanticOperations: [], semanticFolds: [], patch: '' } } as MessageEvent);
    await Promise.all([listed, onScreen]);
    client.dispose();
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
