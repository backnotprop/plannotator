import { describe, expect, test } from 'bun:test';
import { semanticDiffFile, languageForPath } from '@plannotator/sem-diff';
import { createSemDiffClient } from './semDiffClient';
import type { SemDiffReply, SemDiffRequest } from './protocol';
import { semDiffChanges } from './semDiffChanges';

const advert = {
  runtime: '/assets/sem-diff/web-tree-sitter-0.wasm',
  grammars: {
    'tree-sitter-typescript.wasm': '/assets/sem-diff/tree-sitter-typescript-0.wasm',
    'tree-sitter-tsx.wasm': '/assets/sem-diff/tree-sitter-tsx-0.wasm',
  },
};

type Behaviour = 'engine' | 'hang' | 'fail';

function fakeWorker(behaviour: Behaviour, log: { created: number; terminated: number }) {
  return () => {
    log.created++;
    const worker = {
      onmessage: null as ((e: MessageEvent<SemDiffReply>) => void) | null,
      onerror: null as (() => void) | null,
      postMessage(request: SemDiffRequest) {
        if (behaviour === 'hang') return;
        void (async () => {
          let reply: SemDiffReply;
          if (behaviour === 'fail') reply = { id: request.id, ok: false, error: 'boom' };
          else {
            const r = await semanticDiffFile(languageForPath(request.path)!, request.oldText, request.newText, request.path);
            reply = { id: request.id, ok: true, semanticOperations: r.semanticOperations, semanticFolds: r.semanticFolds, patch: r.patch };
          }
          worker.onmessage?.({ data: reply } as MessageEvent<SemDiffReply>);
        })();
      },
      terminate() {
        log.terminated++;
      },
    };
    return worker as unknown as Worker;
  };
}

const before = `export function load(id: string) {\n  return db.find(id);\n}\n\nexport function save(user: User) {\n  db.put(user.id, user);\n  return user;\n}\n`;
const moved = `export function save(user: User) {\n  db.put(user.id, user);\n  return user;\n}\n\nexport function load(id: string) {\n  return db.find(id);\n}\n`;
const edited = before.replace('db.find(id)', 'db.find(id) ?? null');

describe('semantic diff client', () => {
  test('returns operations, folds, the engine patch and a summary when code moved', async () => {
    const log = { created: 0, terminated: 0 };
    const client = createSemDiffClient({ advert, origin: 'http://127.0.0.1:1', createWorker: fakeWorker('engine', log) });
    const result = await client.diff('src/users.ts', before, moved);
    expect(result).not.toBeNull();
    expect(result!.semanticOperations.some((op) => op.type === 'moved')).toBe(true);
    expect(result!.patch).toContain('@@');
    expect(result!.summary.skim.length).toBeGreaterThan(0);
    client.dispose();
  });

  test('answers null for a plain edit, so the view keeps its own diff', async () => {
    const log = { created: 0, terminated: 0 };
    const client = createSemDiffClient({ advert, origin: 'http://127.0.0.1:1', createWorker: fakeWorker('engine', log) });
    expect(await client.diff('src/users.ts', before, edited)).toBeNull();
    client.dispose();
  });

  test('never starts a worker for a file it has no grammar for', async () => {
    const log = { created: 0, terminated: 0 };
    const client = createSemDiffClient({ advert, origin: 'http://127.0.0.1:1', createWorker: fakeWorker('engine', log) });
    expect(client.supports('main.go')).toBe(false);
    expect(client.supports('README.md')).toBe(false);
    expect(await client.diff('main.go', 'a', 'b')).toBeNull();
    expect(log.created).toBe(0);
  });

  test('without an advert nothing is supported', async () => {
    const log = { created: 0, terminated: 0 };
    const client = createSemDiffClient({ advert: undefined, origin: 'http://127.0.0.1:1', createWorker: fakeWorker('engine', log) });
    expect(client.supports('src/users.ts')).toBe(false);
    expect(await client.diff('src/users.ts', before, moved)).toBeNull();
    expect(log.created).toBe(0);
  });

  test('gives up after the cutoff and replaces the stuck worker', async () => {
    const log = { created: 0, terminated: 0 };
    const client = createSemDiffClient({ advert, origin: 'http://127.0.0.1:1', createWorker: fakeWorker('hang', log), timeoutMs: 30 });
    expect(await client.diff('src/users.ts', before, moved)).toBeNull();
    expect(log.terminated).toBe(1);
    expect(await client.diff('src/users.ts', before, moved)).toBeNull();
    expect(log.created).toBe(1);
    await client.diff('src/users.ts', before, `${moved}\n`);
    expect(log.created).toBe(2);
    client.dispose();
  });

  test('an abort settles at once with null', async () => {
    const log = { created: 0, terminated: 0 };
    const client = createSemDiffClient({ advert, origin: 'http://127.0.0.1:1', createWorker: fakeWorker('hang', log), timeoutMs: 10_000 });
    const controller = new AbortController();
    const pending = client.diff('src/users.ts', before, moved, controller.signal);
    controller.abort();
    expect(await pending).toBeNull();
    client.dispose();
  });

  test('an engine error is a plain diff, not a failure', async () => {
    const log = { created: 0, terminated: 0 };
    const client = createSemDiffClient({ advert, origin: 'http://127.0.0.1:1', createWorker: fakeWorker('fail', log) });
    expect(await client.diff('src/users.ts', before, moved)).toBeNull();
    client.dispose();
  });
});

test('each file and content pair is worked out once', async () => {
  let posted = 0;
  const log = { created: 0, terminated: 0 };
  const base = fakeWorker('engine', log);
  const client = createSemDiffClient({
    advert,
    origin: 'http://127.0.0.1:1',
    createWorker: () => {
      const w = base() as unknown as { postMessage: (r: SemDiffRequest) => void };
      const post = w.postMessage.bind(w);
      w.postMessage = (r) => {
        posted++;
        post(r);
      };
      return w as unknown as Worker;
    },
  });
  const [a, b] = await Promise.all([client.diff('src/users.ts', before, moved), client.diff('src/users.ts', before, moved)]);
  expect(a).not.toBeNull();
  expect(b).toBe(a);
  expect(posted).toBe(1);
  client.dispose();
});

describe('semantic changes for the file badge', () => {
  test('a move becomes a non-structural "moved" change named by its first line', async () => {
    const r = await semanticDiffFile('typescript', before, moved, 'src/users.ts');
    const changes = semDiffChanges('src/users.ts', r.semanticOperations, before, moved);
    const move = changes.find((c) => c.changeType === 'moved');
    expect(move).toBeDefined();
    expect(move!.structuralChange).toBe(false);
    expect(['load', 'save']).toContain(move!.entityName);
    expect(move!.startLine).not.toBeNull();
  });
});

test('names are the declared identifier where there is one', async () => {
  const { shortName } = await import('./semDiffChanges');
  expect(shortName('export async function sumLineItems(items: Item[]) {')).toBe('sumLineItems');
  expect(shortName('const taxRate = 0.08;')).toBe('taxRate');
  expect(shortName('def walk(tree):')).toBe('walk');
  expect(shortName('return db.save({')).toBe('return db.save({');
});
