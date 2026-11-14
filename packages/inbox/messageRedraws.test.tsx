/**
 * A message arriving in a long open thread draws its own body and no other; typing in the reply box draws no message
 * body, and typing in a question's "Other" draws only the body holding that question (its card shows the words).
 * parts/MessageView.tsx draws a body again only when its `data` changed. Before stage 3 one arrival drew every open
 * body: the thread itself (Copy thread's), a new `Set` of the person's message ids and new per-reply arrays went into
 * every body's `data`, and every body read the Board's tags, which change with each list read.
 *
 * The counts come from React's own commit hook (the one React DevTools uses; the Profiler tests here count whole
 * commits, this names the bodies): a component counts when it performed work in a commit, and a subtree React reused
 * whole is skipped. The whole window (InboxApp) runs on a real Inbox (tests/helpers/inbox-dom-server.ts), every
 * message open, the arrival heard as the stream's record.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const hasDom = typeof document !== 'undefined';

/** The message bodies and heads (the head line and its menu) drawn while `counting`: one id per draw. */
let drawn: string[] = [];
let heads: string[] = [];
let counting = false;
type Fiber = { tag: number; flags: number; type: unknown; memoizedProps: unknown; child: Fiber | null; sibling: Fiber | null; alternate: Fiber | null };
const nameOf = (type: unknown): string | null => {
  if (typeof type === 'function') return (type as { displayName?: string; name?: string }).displayName || type.name || null;
  if (type && typeof type === 'object' && 'type' in type) return nameOf((type as { type: unknown }).type);
  return null;
};
/** Function and simple memo components; flag 1 is React's PerformedWork. */
function walk(fiber: Fiber | null) {
  for (let f = fiber; f; f = f.sibling) {
    if ((f.tag === 0 || f.tag === 15) && (f.flags & 1) === 1) {
      const name = nameOf(f.type);
      if (name === 'MessageBody' || name === 'MessageMenu') (name === 'MessageBody' ? drawn : heads).push((f.memoizedProps as { message: { id: string } }).message.id);
    }
    if (f.child && !(f.alternate && f.alternate.child === f.child)) walk(f.child);
  }
}
if (hasDom) {
  (globalThis as Record<string, unknown>).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    isDisabled: false,
    renderers: new Map(),
    inject: () => 1,
    onScheduleFiberRoot() {},
    onCommitFiberRoot(_id: number, root: { current: Fiber }) {
      if (counting) walk(root.current.child);
    },
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
  };
}
const { act } = (hasDom ? await import('react') : {}) as typeof import('react');
const { createRoot } = (hasDom ? await import('react-dom/client') : {}) as typeof import('react-dom/client');
const { InboxApp } = (hasDom ? await import('./App') : {}) as typeof import('./App');

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');
/** Agent updates after the question, with one reply of the person's every ten: a long thread with reply chains. */
const UPDATES = 60;

type World = { project: string; waiting: string };
let child: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;
let world: World = { project: '', waiting: '' };
let dir: string | null = null;
let buffer = '';
let nextLine: (() => void) | null = null;
let record: ((data: object) => void) | null = null;
let seq = 1_000_000;

function loopback(path: string, method = 'GET', body?: string): Promise<{ status: number; text: string }> {
  return new Promise((done, fail) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { 'Content-Type': 'application/json', Host: `127.0.0.1:${port}` } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => done({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', fail);
    if (body) req.write(body);
    req.end();
  });
}

async function line(): Promise<string> {
  for (;;) {
    const at = buffer.indexOf('\n');
    if (at >= 0) {
      const out = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      return out;
    }
    await new Promise<void>((r) => (nextLine = r));
  }
}

async function agentWrites(body: string): Promise<string> {
  const stdin = child!.stdin as import('bun').FileSink;
  stdin.write(`${JSON.stringify({ send: { project: world.project, session: 'ses_b0', body, reply_to: world.waiting } })}\n`);
  stdin.flush();
  return (JSON.parse(await line()) as { sent: string }).sent;
}

beforeAll(async () => {
  if (!hasDom) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-redraws-dom-')));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(dir, 'bin', 'tailscale'), 0o755);
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), '1'], {
    env: { ...process.env, DOM_TESTS: '0', PLANNOTATOR_DATA_DIR: join(dir, 'data'), HOME: dir, PATH: `${join(dir, 'bin')}:${process.env.PATH}` },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += new TextDecoder().decode(value);
      nextLine?.();
    }
  })();
  const started = JSON.parse(await line()) as { port: number; worlds: World[] };
  port = started.port;
  world = started.worlds[0]!;
  for (let i = 1; i <= UPDATES; i++) {
    const id = await agentWrites(`Update ${i}.\n\n- one point\n- another with \`code\`\n\n${'Some prose that takes a line or two. '.repeat(4)}`);
    if (i % 10 === 0) {
      const sent = await loopback(`/api/inbox/messages/${id}/reply`, 'POST', JSON.stringify({ idempotency_key: `redraws-${i}`, words: `Noted ${i}.`, questions: [] }));
      if (sent.status !== 200) throw new Error(`the person's reply ${i}: ${sent.status} ${sent.text}`);
    }
  }
}, 60_000);

afterAll(async () => {
  if (!hasDom) return;
  child?.kill();
  await child?.exited;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function wait(ms: number) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await wait(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function type(field: HTMLTextAreaElement, words: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(field, words);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** The message bodies drawn while `run` goes and the window settles: how many times, per message id. */
async function bodiesDrawn(run: () => Promise<void>): Promise<Record<string, number>> {
  drawn = [];
  heads = [];
  counting = true;
  await run();
  await wait(1200);
  counting = false;
  return byId(drawn);
}

function byId(ids: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of ids) out[id] = (out[id] ?? 0) + 1;
  return out;
}

test.skipIf(!hasDom)('one arrival in a long thread draws its own body and head only; 20 keys draw no other body', async () => {
  const savedFetch = globalThis.fetch;
  const savedEventSource = (globalThis as Record<string, unknown>).EventSource;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const answer = await loopback(String(input), init?.method ?? 'GET', init?.body ? String(init.body) : undefined);
    return new Response(answer.text, { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).EventSource = class {
    addEventListener(name: string, listener: (event: MessageEvent<string>) => void) {
      if (name === 'record') record = (data) => listener(new MessageEvent(name, { data: JSON.stringify(data) }));
    }
    close() {}
  };
  window.location.hash = `#thread=${world.waiting}`;
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    act(() => root.render(<InboxApp />));
    const other = () => host.querySelector<HTMLTextAreaElement>('textarea[aria-label^="Other answer"]');
    await until(() => record !== null && host.querySelector('[data-message-article]') !== null, 'the open thread and the stream');
    await wait(800);
    // Every message open, as a person reading the whole thread has it: the middle fold shown, each folded line opened.
    for (const all of host.querySelectorAll<HTMLButtonElement>('[data-fold-all]')) act(() => all.click());
    await wait(300);
    for (let i = 0; i < 200; i++) {
      const line = host.querySelector<HTMLButtonElement>('article[data-folded] [data-fold-head]');
      if (!line) break;
      act(() => line.click());
    }
    await until(() => other() !== null, 'the question card');
    await wait(1500);
    const bodies = host.querySelectorAll('.ib-body[data-message-id]').length;
    expect(bodies).toBeGreaterThan(UPDATES);

    // One agent message, heard over the stream: its body is drawn, no other.
    const sent = await agentWrites('One more update.');
    const read = JSON.parse((await loopback(`/api/inbox/threads/${world.waiting}`)).text) as { thread: { messages: { id: string }[] } };
    const message = read.thread.messages.find((m) => m.id === sent)!;
    await wait(300);
    const onArrival = await bodiesDrawn(async () => {
      act(() => record!({ seq: ++seq, kind: 'message', id: sent, first: true, message }));
      await until(() => host.querySelector(`.ib-body[data-message-id="${sent}"]`) !== null, 'the new message');
    });
    expect(onArrival).toEqual({ [sent]: 1 });
    // Its head too, and no other head: Copy thread reads the thread as it is when pressed.
    expect(Object.keys(byId(heads))).toEqual([sent]);

    // 20 keys in "Other": its first key picks the question (not counted); the keys after it draw no other body.
    type(other()!, 'w');
    await wait(1500);
    let words = 'w';
    const inOther = await bodiesDrawn(async () => {
      for (let i = 0; i < 20; i++) {
        words += 'x';
        type(other()!, words);
        await wait(30);
      }
    });
    expect(other()!.value).toBe(words);
    // The card holding "Other" is in that message's body, which draws once per key (and once for the pick's save).
    expect(Object.keys(inOther)).toEqual([world.waiting]);
    expect(inOther[world.waiting]!).toBeLessThanOrEqual(22);

    // 20 keys in the reply box.
    const replyButton = [...host.querySelectorAll<HTMLButtonElement>('.ib-pfoot button')].find((b) => /^(Reply|Edit draft)$/.test(b.textContent?.trim() ?? ''));
    act(() => replyButton?.click());
    const box = () => host.querySelector<HTMLTextAreaElement>('textarea[aria-label^="Reply to"]');
    await until(() => box() !== null, 'the reply box');
    await wait(800);
    let typed = '';
    const inReply = await bodiesDrawn(async () => {
      for (let i = 0; i < 20; i++) {
        typed += 'y';
        type(box()!, typed);
        await wait(30);
      }
    });
    expect(box()!.value).toBe(typed);
    expect(inReply).toEqual({});
  } finally {
    act(() => root.unmount());
    host.remove();
    globalThis.fetch = savedFetch;
    (globalThis as Record<string, unknown>).EventSource = savedEventSource;
  }
}, 120_000);
