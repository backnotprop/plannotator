import { describe, expect, test } from 'bun:test';
import { semanticDiffFile, languageForPath } from '@plannotator/sem-jiff';
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

type Behaviour = 'engine' | 'hang' | 'fail' | 'stuck-on-big';

function fakeWorker(behaviour: Behaviour, log: { created: number; terminated: number }) {
  return () => {
    log.created++;
    const worker = {
      onmessage: null as ((e: MessageEvent<SemDiffReply>) => void) | null,
      onerror: null as (() => void) | null,
      queue: [] as SemDiffRequest[],
      stuck: false,
      postMessage(request: SemDiffRequest) {
        if (behaviour === 'hang') return;
        if (behaviour === 'stuck-on-big') {
          worker.queue.push(request);
          const drain = async () => {
            while (!worker.stuck && worker.queue.length > 0) {
              const next = worker.queue.shift()!;
              if (next.path.includes('big')) {
                worker.stuck = true;
                return;
              }
              const r = await semanticDiffFile(languageForPath(next.path)!, next.oldText, next.newText, next.path);
              worker.onmessage?.({ data: { id: next.id, ok: true, semanticOperations: r.semanticOperations, semanticFolds: r.semanticFolds, patch: r.patch } } as MessageEvent<SemDiffReply>);
            }
          };
          if (worker.queue.length === 1) void drain();
          return;
        }
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

  test('Java and C# files are supported when the server ships their grammars', () => {
    const log = { created: 0, terminated: 0 };
    const shipped = {
      ...advert,
      grammars: {
        ...advert.grammars,
        'tree-sitter-java.wasm': '/assets/sem-diff/tree-sitter-java-0.wasm',
        'tree-sitter-c_sharp.wasm': '/assets/sem-diff/tree-sitter-c_sharp-0.wasm',
      },
    };
    expect(createSemDiffClient({ advert, origin: 'http://127.0.0.1:1', createWorker: fakeWorker('engine', log) }).supports('src/Users.java')).toBe(false);
    const client = createSemDiffClient({ advert: shipped, origin: 'http://127.0.0.1:1', createWorker: fakeWorker('engine', log) });
    expect(client.supports('src/Users.java')).toBe(true);
    expect(client.supports('src/Users.cs')).toBe(true);
    expect(log.created).toBe(0);
    client.dispose();
  });

  test('PHP files are supported when the server ships the PHP grammar; Blade templates never are', () => {
    const log = { created: 0, terminated: 0 };
    const shipped = { ...advert, grammars: { ...advert.grammars, 'tree-sitter-php.wasm': '/assets/sem-diff/tree-sitter-php-0.wasm' } };
    expect(createSemDiffClient({ advert, origin: 'http://127.0.0.1:1', createWorker: fakeWorker('engine', log) }).supports('src/User.php')).toBe(false);
    const client = createSemDiffClient({ advert: shipped, origin: 'http://127.0.0.1:1', createWorker: fakeWorker('engine', log) });
    expect(client.supports('src/User.php')).toBe(true);
    expect(client.supports('views/list.phtml')).toBe(true);
    expect(client.supports('resources/views/welcome.blade.php')).toBe(false);
    expect(log.created).toBe(0);
    client.dispose();
  });

  test('Kotlin files and scripts are supported when the server ships the Kotlin grammar', () => {
    const log = { created: 0, terminated: 0 };
    const shipped = { ...advert, grammars: { ...advert.grammars, 'tree-sitter-kotlin.wasm': '/assets/sem-diff/tree-sitter-kotlin-0.wasm' } };
    expect(createSemDiffClient({ advert, origin: 'http://127.0.0.1:1', createWorker: fakeWorker('engine', log) }).supports('src/main/kotlin/App.kt')).toBe(false);
    const client = createSemDiffClient({ advert: shipped, origin: 'http://127.0.0.1:1', createWorker: fakeWorker('engine', log) });
    expect(client.supports('src/main/kotlin/App.kt')).toBe(true);
    expect(client.supports('build.gradle.kts')).toBe(true);
    expect(client.supports('notes.ktx')).toBe(false);
    expect(log.created).toBe(0);
    client.dispose();
  });

  test('Ruby files are supported when the server ships the Ruby grammar; ERB templates never are', () => {
    const log = { created: 0, terminated: 0 };
    const shipped = { ...advert, grammars: { ...advert.grammars, 'tree-sitter-ruby.wasm': '/assets/sem-diff/tree-sitter-ruby-0.wasm' } };
    expect(createSemDiffClient({ advert, origin: 'http://127.0.0.1:1', createWorker: fakeWorker('engine', log) }).supports('lib/cart.rb')).toBe(false);
    const client = createSemDiffClient({ advert: shipped, origin: 'http://127.0.0.1:1', createWorker: fakeWorker('engine', log) });
    expect(client.supports('lib/cart.rb')).toBe(true);
    expect(client.supports('lib/tasks/db.rake')).toBe(true);
    expect(client.supports('shop.gemspec')).toBe(true);
    expect(client.supports('Rakefile')).toBe(true);
    expect(client.supports('Gemfile')).toBe(true);
    expect(client.supports('app/views/index.html.erb')).toBe(false);
    expect(log.created).toBe(0);
    client.dispose();
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
    const client = createSemDiffClient({ advert, origin: 'http://127.0.0.1:1', createWorker: fakeWorker('hang', log), timeoutMs: 30, coldTimeoutMs: 30 });
    expect(await client.diff('src/users.ts', before, moved)).toBeNull();
    expect(log.terminated).toBe(1);
    expect((await client.attempt('src/users.ts', before, moved)).failed).toBe(true);
    expect(log.created).toBe(2);
    client.dispose();
  });

  test('one file that stalls the worker fails alone; the files queued behind it still get their answers', async () => {
    const log = { created: 0, terminated: 0 };
    const client = createSemDiffClient({ advert, origin: 'http://127.0.0.1:1', createWorker: fakeWorker('stuck-on-big', log), timeoutMs: 200, coldTimeoutMs: 200 });
    const big = client.attempt('src/big.ts', before, moved);
    const others = [client.attempt('src/a.ts', before, moved), client.attempt('src/b.ts', before, `${moved}\n`)];
    expect((await big).failed).toBe(true);
    const settled = await Promise.all(others);
    expect(settled.map((outcome) => outcome.failed)).toEqual([false, false]);
    expect(settled.every((outcome) => outcome.result?.semanticOperations.some((op) => op.type === 'moved'))).toBe(true);
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

describe('the Semantic diff panel lists declarations, not lines', () => {
  const op = (type: string, oldLines: [number, number] | null, newLines: [number, number] | null) =>
    ({ type, lines: { old: oldLines ? [{ start: oldLines[0], end: oldLines[1] }] : [], new: newLines ? [{ start: newLines[0], end: newLines[1] }] : [] } }) as never;
  const oldText = ['export function total(items) {', '  let sum = 0;', '  for (const i of items) sum += i;', '  return sum;', '}', '', 'function titleCase(s) {', "  return s.split(' ');", '}'].join('\n');
  const newText = ['export function total(items) {', '  let sum = 0;', '  for (const i of items) sum += i * 2;', '  return sum;', '}', '', 'const titleCase = (s) =>', "  s.split(' ');", '}'].join('\n');

  test('statements fold into their function, braces and blank names are dropped, a delete plus add of one name is edited', () => {
    const changes = semDiffChanges('src/a.ts', [
      op('edited', [3, 3], [3, 3]),
      op('edited', [4, 4], [4, 4]),
      op('deleted', [5, 5], null),
      op('deleted', [7, 9], null),
      op('added', null, [7, 9]),
      op('added', null, [6, 6]),
    ], oldText, newText);
    expect(changes.map((c) => [c.entityName, c.changeType])).toEqual([
      ['total', 'modified'],
      ['titleCase', 'modified'],
    ]);
    expect(changes[0]!.startLine).toBe(3);
    expect(changes[0]!.endLine).toBe(4);
  });

  test('a rename inside a function keeps its own row', () => {
    const before = ['export function addTax(amount) {', '  const rate = 0.2;', '  return amount * rate;', '}'].join('\n');
    const after = ['export function addTax(amount) {', '  const taxRate = 0.2;', '  return amount * taxRate;', '}'].join('\n');
    const changes = semDiffChanges('src/tax.ts', [op('renamed', [2, 3], [2, 3])], before, after);
    expect(changes.map((c) => [c.oldEntityName, c.entityName, c.changeType])).toEqual([['rate', 'taxRate', 'renamed']]);
  });

  test('a method line names the method, not the statement inside it', async () => {
    const { shortName } = await import('./semDiffChanges');
    expect(shortName('  async listEntries(dir: string): Promise<Entry[]> {')).toBe('listEntries');
    expect(shortName('func (s *Store) Save(u User) error {')).toBe('Save');
    expect(shortName('if (user.coupon) {')).toBe('if (user.coupon) {');
  });
});

describe('a moved method is named by itself, not its class, in every language', () => {
  const op = (start: number, end: number) => ({ type: 'moved', lines: { old: [{ start, end }], new: [{ start, end }] } }) as never;
  const cases: [string, string, string[], number, string][] = [
    ['TypeScript method', 'src/greeter.ts', ['export class Greeter {', '  private async greet(name: string): Promise<string> {', '    return name;', '  }', '}'], 2, 'greet'],
    ['TypeScript arrow const', 'src/greeter.ts', ['export class Greeter {}', 'export const shout = async (s: string) => {', '  return s;', '};'], 2, 'shout'],
    ['JavaScript function', 'src/greeter.js', ['class Greeter {', '  static build() {', '    function* steps() {', '      yield 1;', '    }', '  }', '}'], 3, 'steps'],
    ['Python', 'greeter.py', ['class Greeter:', '    async def greet(self, name):', '        return name'], 2, 'greet'],
    ['Go', 'greeter.go', ['type Greeter struct{}', '', 'func (g *Greeter) Greet(name string) string {', '\treturn name', '}'], 3, 'Greet'],
    ['Rust', 'src/greeter.rs', ['impl Greeter {', '    pub(crate) async fn greet(&self) -> String {', '        String::new()', '    }', '}'], 2, 'greet'],
    ['Java', 'Greeter.java', ['public class Greeter {', '    @Override', '    public static <T> List<T> greet(String name) {', '        return null;', '    }', '}'], 3, 'greet'],
    ['C# brace on next line', 'Greeter.cs', ['public class Greeter', '{', '    public async Task<string> GreetAsync(string name)', '    {', '        return name;', '    }', '}'], 3, 'GreetAsync'],
    ['PHP', 'Greeter.php', ['class Greeter {', '    public static function greet($name) {', '        return $name;', '    }', '}'], 2, 'greet'],
    ['Ruby', 'greeter.rb', ['class Greeter', '  def self.greet(name)', '    name', '  end', 'end'], 2, 'greet'],
    ['Kotlin', 'Greeter.kt', ['class Greeter {', '    fun greet(name: String): String {', '        return name', '    }', '}'], 2, 'greet'],
    ['Kotlin extension', 'Greeter.kt', ['object Registry {', '    suspend fun <T> List<T>.firstGreeting(): T {', '        return first()', '    }', '}'], 2, 'firstGreeting'],
    ['Swift', 'Greeter.swift', ['extension Greeter {', '    @MainActor public mutating func greet(_ name: String) -> String {', '        return name', '    }', '}'], 2, 'greet'],
  ];
  test.each(cases)('%s', (_label, path, lines, start, expected) => {
    const text = lines.join('\n');
    const [change] = semDiffChanges(path, [op(start, start + 1)], text, text);
    expect(change!.entityName).toBe(expected);
  });

  const lookalikes: [string, string, string[], number, string][] = [
    ['a call line', 'src/greeter.ts', ['class Greeter {', '  run(x) {', '    greet(x)', '  }', '}'], 3, 'run'],
    ['an if line', 'Greeter.kt', ['class Greeter {', '    fun run(x: Int) {', '        if (x > 0) {', '            log(x)', '        }', '    }', '}'], 3, 'run'],
    ['a return of a call', 'Greeter.java', ['public class Greeter {', '    public int run(int x) {', '        return foo(x);', '    }', '}'], 3, 'run'],
    ['a constructor call', 'Greeter.cs', ['public class Greeter', '{', '    public void Run()', '    {', '        throw new ArgumentException(name);', '    }', '}'], 5, 'Run'],
    ['a Kotlin when', 'Greeter.kt', ['class Greeter {', '    fun run(x: Int) {', '        when (x) {', '            else -> log(x)', '        }', '    }', '}'], 3, 'run'],
    ['a call ending in a lambda', 'src/greeter.test.ts', ['describe("greeter", () => {', '  test("greets", () => {', '    expect(1).toBe(1);', '  });', '});'], 2, 'test("greets", () => {'],
  ];
  test.each(lookalikes)('%s is not taken as a name', (_label, path, lines, start, expected) => {
    const text = lines.join('\n');
    const [change] = semDiffChanges(path, [op(start, start)], text, text);
    expect(change!.entityName).toBe(expected);
  });

  test('type declarations name the type', async () => {
    const { shortName } = await import('./semDiffChanges');
    expect(shortName('sealed interface Shape {')).toBe('Shape');
    expect(shortName('enum class Color {')).toBe('Color');
    expect(shortName('data object Empty')).toBe('Empty');
    expect(shortName('public protocol Drawable {')).toBe('Drawable');
    expect(shortName('extension Greeter: CustomStringConvertible {')).toBe('Greeter');
    expect(shortName('indirect enum Tree {')).toBe('Tree');
    expect(shortName('pub trait Shape {')).toBe('Shape');
    expect(shortName('impl<T: Display> fmt::Display for Point<T> {')).toBe('Point');
    expect(shortName('pub struct Point {')).toBe('Point');
    expect(shortName('module Billing')).toBe('Billing');
    expect(shortName('greet(x)')).toBe('greet(x)');
    expect(shortName('return foo(x);', 'A.java')).toBe('return foo(x);');
  });
});

test('a slow first answer while the engine and its grammar arrive is not a failure; a warm engine that stalls still is', async () => {
  const timers: ReturnType<typeof setTimeout>[] = [];
  const replyAfter = (ms: number) => () =>
    ({
      onmessage: null as ((e: MessageEvent<SemDiffReply>) => void) | null,
      onerror: null,
      postMessage(request: SemDiffRequest) {
        timers.push(setTimeout(() => this.onmessage?.({ data: { id: request.id, ok: true, semanticOperations: [], semanticFolds: [], patch: '' } } as MessageEvent<SemDiffReply>), ms));
      },
      terminate() {},
    }) as unknown as Worker;
  const client = createSemDiffClient({ advert, origin: 'http://x', createWorker: replyAfter(120), timeoutMs: 30, coldTimeoutMs: 400 });
  expect(await client.attempt('a.ts', 'const a = 1;\n', 'const a = 2;\n')).toEqual({ result: null, failed: false });
  expect((await client.attempt('b.ts', 'const b = 1;\n', 'const b = 2;\n')).failed).toBe(true);
  client.dispose();
  for (const timer of timers) clearTimeout(timer);
});

test('after a stalled file replaces a warm worker, the files queued behind it get the cold limit on the new one', async () => {
  const timers: ReturnType<typeof setTimeout>[] = [];
  let made = 0;
  const createWorker = () => {
    const n = ++made;
    let stuck = false;
    return {
      onmessage: null as ((e: MessageEvent<SemDiffReply>) => void) | null,
      onerror: null,
      postMessage(request: SemDiffRequest) {
        if (stuck || request.path.includes('big')) {
          stuck = true;
          return;
        }
        timers.push(setTimeout(() => this.onmessage?.({ data: { id: request.id, ok: true, semanticOperations: [], semanticFolds: [], patch: '' } } as MessageEvent<SemDiffReply>), n === 1 ? 0 : 120));
      },
      terminate() {},
    } as unknown as Worker;
  };
  const client = createSemDiffClient({ advert, origin: 'http://x', createWorker, timeoutMs: 30, coldTimeoutMs: 400 });
  expect((await client.attempt('a.ts', 'const a = 1;\n', 'const a = 2;\n')).failed).toBe(false);
  const big = client.attempt('big.ts', 'const b = 1;\n', 'const b = 2;\n');
  const after = client.attempt('c.ts', 'const c = 1;\n', 'const c = 2;\n');
  expect((await big).failed).toBe(true);
  expect((await after).failed).toBe(false);
  expect(made).toBe(2);
  client.dispose();
  for (const timer of timers) clearTimeout(timer);
});

test('a language whose cold start timed out twice gets only the warm limit after that, and once is not enough', async () => {
  const hang = () => ({ onmessage: null, onerror: null, postMessage() {}, terminate() {} }) as unknown as Worker;
  const client = createSemDiffClient({ advert, origin: 'http://x', createWorker: hang, timeoutMs: 30, coldTimeoutMs: 400 });
  const started = Date.now();
  const first = client.attempt('a.ts', 'const a = 1;\n', 'const a = 2;\n');
  const second = client.attempt('b.ts', 'const b = 1;\n', 'const b = 2;\n');
  const order: string[] = [];
  await first.then(() => order.push('first'));
  const firstAt = Date.now() - started;
  await second.then(() => order.push('second'));
  expect(Date.now() - started - firstAt).toBeGreaterThan(200);
  const third = client.attempt('c.ts', 'const c = 1;\n', 'const c = 2;\n');
  const stop = new Promise<string>((resolve) => {
    const timer = setTimeout(() => resolve('cold again'), 300);
    void third.then(() => {
      clearTimeout(timer);
      resolve('warm limit');
    });
  });
  expect(await stop).toBe('warm limit');
  expect(order).toEqual(['first', 'second']);
  client.dispose();
});

test('an engine that answered at all, even with an error, is warm: a stall after it gets the warm limit', async () => {
  let answered = false;
  const createWorker = () =>
    ({
      onmessage: null as ((e: MessageEvent<SemDiffReply>) => void) | null,
      onerror: null,
      postMessage(request: SemDiffRequest) {
        if (answered) return;
        answered = true;
        queueMicrotask(() => this.onmessage?.({ data: { id: request.id, ok: false, error: 'boom' } } as MessageEvent<SemDiffReply>));
      },
      terminate() {},
    }) as unknown as Worker;
  const client = createSemDiffClient({ advert, origin: 'http://x', createWorker, timeoutMs: 30, coldTimeoutMs: 600 });
  expect((await client.attempt('a.ts', 'const a = 1;\n', 'const a = 2;\n')).failed).toBe(true);
  const stalled = client.attempt('b.ts', 'const b = 1;\n', 'const b = 2;\n');
  const outcome = await new Promise<string>((resolve) => {
    const timer = setTimeout(() => resolve('cold limit'), 300);
    void stalled.then(() => {
      clearTimeout(timer);
      resolve('warm limit');
    });
  });
  expect(outcome).toBe('warm limit');
  client.dispose();
});

test('the cold limit starts when the engine and its grammar have arrived, so a slow download is not a stall and is not started again', async () => {
  const timers: ReturnType<typeof setTimeout>[] = [];
  let made = 0;
  const createWorker = () => {
    made++;
    return {
      onmessage: null as ((e: MessageEvent<unknown>) => void) | null,
      onerror: null,
      postMessage(request: SemDiffRequest) {
        const say = (data: unknown, ms: number) => timers.push(setTimeout(() => this.onmessage?.({ data } as MessageEvent<unknown>), ms));
        say({ download: 'start', language: 'typescript' }, 0);
        say({ download: 'done', language: 'typescript' }, 150);
        say({ id: request.id, ok: true, semanticOperations: [], semanticFolds: [], patch: '' }, 180);
      },
      terminate() {},
    } as unknown as Worker;
  };
  const client = createSemDiffClient({ advert, origin: 'http://x', createWorker, timeoutMs: 30, coldTimeoutMs: 60 });
  expect(await client.attempt('a.ts', 'const a = 1;\n', 'const a = 2;\n')).toEqual({ result: null, failed: false });
  expect(made).toBe(1);
  client.dispose();
  for (const timer of timers) clearTimeout(timer);
});

test('a grammar download that never ends gives up after its bound: that language falls back to the plain diff without starting it again, other languages still answer', async () => {
  // The client's own timers only, on a clock this test fires: a real 40 ms bound raced the test's awaits on a loaded runner,
  // and a patched global setTimeout also counted timers that other code in the same process started meanwhile.
  const live = new Map<number, { fn: () => void; ms: number }>();
  let nextTimer = 1;
  const timers = {
    set: (fn: () => void, ms: number) => {
      const id = nextTimer++;
      live.set(id, { fn, ms });
      return id;
    },
    clear: (timer: unknown) => {
      live.delete(timer as number);
    },
  };
  let made = 0;
  const posted: string[] = [];
  const createWorker = () => {
    made++;
    return {
      onmessage: null as ((e: MessageEvent<unknown>) => void) | null,
      onerror: null,
      postMessage(request: SemDiffRequest) {
        posted.push(request.path);
        const say = (data: unknown) => queueMicrotask(() => this.onmessage?.({ data } as MessageEvent<unknown>));
        if (request.path.endsWith('.tsx')) say({ id: request.id, ok: true, semanticOperations: [], semanticFolds: [], patch: '' });
        else say({ download: 'start', language: 'typescript' });
      },
      terminate() {},
    } as unknown as Worker;
  };
  const client = createSemDiffClient({ advert, origin: 'http://x', createWorker, timeoutMs: 30, coldTimeoutMs: 60_000, downloadTimeoutMs: 40, timers });
  let settled = 0;
  const first = client.attempt('a.ts', 'const a = 1;\n', 'const a = 2;\n');
  const second = client.attempt('b.ts', 'const b = 1;\n', 'const b = 2;\n');
  void first.then(() => settled++);
  void second.then(() => settled++);
  const other = client.attempt('c.tsx', 'const c = 1;\n', 'const c = 2;\n');
  expect(await other).toEqual({ result: null, failed: false });
  // While the download runs, the only bound left is the download's own (the cold limit waits for the grammar).
  expect([...live.values()].map((t) => t.ms)).toEqual([40]);
  expect(settled).toBe(0);
  const [[bound, { fn }]] = [...live];
  live.delete(bound);
  fn();
  expect(await first).toEqual({ result: null, failed: true });
  expect(await second).toEqual({ result: null, failed: true });
  expect(await client.attempt('d.ts', 'const d = 1;\n', 'const d = 2;\n')).toEqual({ result: null, failed: true });
  expect(await client.attempt('e.tsx', 'const e = 1;\n', 'const e = 2;\n')).toEqual({ result: null, failed: false });
  expect(made).toBe(1);
  expect(posted).toEqual(['a.ts', 'b.ts', 'c.tsx', 'e.tsx']);
  client.dispose();
  expect(live.size).toBe(0);
});
