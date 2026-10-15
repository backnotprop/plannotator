/**
 * A Send with words and no pick, in a thread where ONE session asked twice
 * (two agent messages, each holding one open question): the shape of the
 * owner's thread on 0.28.20 that came back as two skip-only replies.
 * Approval "inbox-words-only-reply" (#1903): a Send that carries no pick
 * keeps every question open, sends the words once, to the latest agent
 * message, with the still-open line, and posts nothing to the older one.
 *
 * Every way into that Send is tried: the foot's Reply then the Send button,
 * Mod+Enter in the box, a pick made and then taken back before typing, a
 * thread whose first message is folded, and the box cancelled and opened
 * again. The window over a REAL Inbox (tests/helpers/inbox-dom-server.ts),
 * its fetches carried over loopback, the second question written by the
 * agent through the server's stdin.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from the test.yml DOM list.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { InboxQuestion } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { InboxApp } = (hasDom ? await import('./App') : {}) as typeof import('./App');

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');

type World = { project: string; waiting: string };
let child: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;
let worlds: World[] = [];
let world: World = { project: '', waiting: '' };
let dir: string | null = null;
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedEventSource: unknown;
let posted: { path: string; body: Record<string, unknown> }[] = [];
const lines: string[] = [];

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

type ThreadModel = {
  thread: { messages: { id: string; seq?: number; author: { kind: string }; reply_to: string | null; body: string; questions?: InboxQuestion[] }[] };
};
const readThread = async (id: string) => JSON.parse((await loopback(`/api/inbox/threads/${id}`)).text) as ThreadModel;

/** The agent's second message: the same session, a reply in the thread, one open question of its own. */
const SECOND = ['The long cut is ready too.', '', ':::question', 'Is this the film you upload?', '', '- [ ] Yes', '- [ ] No', ':::'].join('\n');

async function askAgain(w: World): Promise<string> {
  // The waiting thread's author is `ses_b<i>`: read it back rather than guess the index.
  const first = (await readThread(w.waiting)).thread.messages[0]! as unknown as { author: { session: string } };
  const stdin = child!.stdin as import('bun').FileSink;
  const before = lines.length;
  stdin.write(`${JSON.stringify({ send: { project: w.project, session: first.author.session, body: SECOND, reply_to: w.waiting } })}\n`);
  await stdin.flush();
  for (let i = 0; i < 100 && lines.length === before; i++) await new Promise((r) => setTimeout(r, 20));
  return (JSON.parse(lines.at(-1)!) as { sent: string }).sent;
}

const TESTS = 6;

beforeAll(async () => {
  if (!hasDom) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-wordsonly-dom-')));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(dir, 'bin', 'tailscale'), 0o755);
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), String(TESTS)], {
    env: { ...process.env, DOM_TESTS: '0', PLANNOTATOR_DATA_DIR: join(dir, 'data'), HOME: dir, PATH: `${join(dir, 'bin')}:${process.env.PATH}` },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
  let buffer = '';
  let first: string | null = null;
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += new TextDecoder().decode(value);
      let at = buffer.indexOf('\n');
      while (at >= 0) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (line) {
          if (first === null) first = line;
          else lines.push(line);
        }
        at = buffer.indexOf('\n');
      }
    }
  })();
  for (let i = 0; i < 400 && first === null; i++) await new Promise((r) => setTimeout(r, 25));
  if (first === null) throw new Error('the Inbox did not start');
  const started = JSON.parse(first) as { port: number; worlds: World[] };
  port = started.port;
  worlds = started.worlds;
});

afterAll(async () => {
  if (!hasDom) return;
  child?.kill();
  await child?.exited;
  child = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

beforeEach(() => {
  if (!hasDom) return;
  world = worlds.shift()!;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? String(init.body) : undefined;
    if (method === 'POST') posted.push({ path, body: body ? JSON.parse(body) : {} });
    const answer = await loopback(path, method, body);
    return new Response(answer.text, { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  savedEventSource = (globalThis as Record<string, unknown>).EventSource;
  (globalThis as Record<string, unknown>).EventSource = class {
    addEventListener() {}
    close() {}
  };
  posted = [];
  window.location.hash = '';
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
  (globalThis as Record<string, unknown>).EventSource = savedEventSource;
});

async function settle(ms = 40) {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, ms));
    });
  }
}

async function until(check: () => boolean | Promise<boolean>, what: string) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function renderApp(hash: string) {
  window.location.hash = hash;
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<InboxApp />);
  });
  await settle();
  return host;
}

function button(el: ParentNode, text: string): HTMLButtonElement {
  const found = [...el.querySelectorAll('button')].find((b) => b.textContent?.replace(/\s+/g, ' ').trim() === text);
  if (!found) throw new Error(`no button "${text}" in ${[...el.querySelectorAll('button')].map((b) => b.textContent?.trim()).join(' | ')}`);
  return found as HTMLButtonElement;
}

function type(el: HTMLElement, words: string) {
  const text = el.querySelector('textarea') as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(text, words);
    text.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const replies = () => posted.filter((p) => p.path.endsWith('/reply'));

/** What every words-only Send in this thread must come to, on the wire and on the server. */
async function expectWordsOnly(firstId: string, secondId: string, words: string) {
  expect(replies().map((p) => p.path)).toEqual([`/api/inbox/messages/${secondId}/reply`]);
  expect(replies()[0]!.body).toMatchObject({ words, questions: [], skip_unanswered: false });
  const model = await readThread(firstId);
  expect(model.thread.messages.flatMap((m) => m.questions ?? []).map((q) => [q.state, q.answer])).toEqual([
    ['open', null],
    ['open', null],
  ]);
  const mine = model.thread.messages.filter((m) => m.author.kind === 'person');
  // Pinned word for word on purpose: the still-open line is the approved agent wording (approval "inbox-words-only-reply").
  expect(mine.map((m) => [m.reply_to, m.body])).toEqual([
    [secondId, `${words}\n\nNo questions answered yet; all 2 are still open. Don't re-ask them; the person will answer in the Inbox.`],
  ]);
}

test.skipIf(!hasDom)('one session asked twice: Reply, words, the Send button: one reply to the latest message, both questions open', async () => {
  const second = await askAgain(world);
  const el = await renderApp(`#thread=${world.waiting}`);
  await until(() => el.querySelectorAll('fieldset[data-question-key]').length === 2, 'both questions');
  act(() => button(el, 'Reply').click());
  await settle();
  expect(el.querySelector('[data-skip-chip]')?.getAttribute('data-skip-chip')).toBe('keep');
  type(el, 'Is there a way to attach video?');
  act(() => button(el, 'Send').click());
  await until(() => el.querySelector('textarea') === null, 'the Send');
  await expectWordsOnly(world.waiting, second, 'Is there a way to attach video?');
});

test.skipIf(!hasDom)('one session asked twice: Mod+Enter in the reply box sends the same words-only reply', async () => {
  const second = await askAgain(world);
  const el = await renderApp(`#thread=${world.waiting}`);
  await until(() => el.querySelectorAll('fieldset[data-question-key]').length === 2, 'both questions');
  act(() => button(el, 'Reply').click());
  await settle();
  type(el, 'Thinking about it.');
  const text = el.querySelector('textarea') as HTMLTextAreaElement;
  act(() => {
    text.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, ctrlKey: true, bubbles: true }));
  });
  await until(() => el.querySelector('textarea') === null, 'the Send');
  await expectWordsOnly(world.waiting, second, 'Thinking about it.');
});

test.skipIf(!hasDom)('one session asked twice: a pick made and taken back before the words leaves the Send words-only', async () => {
  const second = await askAgain(world);
  const el = await renderApp(`#thread=${world.waiting}`);
  await until(() => el.querySelectorAll('fieldset[data-question-key]').length === 2, 'both questions');
  const card = el.querySelector('fieldset[data-question-key]') as HTMLElement;
  act(() => (card.querySelector('[data-question-option] input') as HTMLInputElement).click());
  await until(async () => (await readThread(world.waiting)).thread.messages[0]!.questions![0]!.state === 'picked', 'the pick saved');
  // Skip on the card, then Unskip: the card holds no answer again.
  act(() => button(card, 'Skip').click());
  await settle();
  act(() => button(el.querySelector('fieldset[data-question-key]')!, 'Unskip').click());
  await until(async () => (await readThread(world.waiting)).thread.messages[0]!.questions![0]!.state === 'open', 'the pick taken back');
  await settle();
  act(() => button(el, 'Reply').click());
  await settle();
  expect(el.querySelector('[data-skip-chip]')?.getAttribute('data-skip-chip')).toBe('keep');
  type(el, 'Not yet.');
  act(() => button(el, 'Send').click());
  await until(() => el.querySelector('textarea') === null, 'the Send');
  await expectWordsOnly(world.waiting, second, 'Not yet.');
});

test.skipIf(!hasDom)('one session asked twice, the first message folded: the Send is still words-only', async () => {
  // The person looked at the first message before the second came: it folds when the thread opens again.
  const before = await readThread(world.waiting);
  await loopback(`/api/inbox/threads/${world.waiting}/seen`, 'POST', JSON.stringify({ through_seq: before.thread.messages[0]!.seq }));
  const second = await askAgain(world);
  const el = await renderApp(`#thread=${world.waiting}`);
  await until(() => el.querySelectorAll('fieldset[data-question-key]').length >= 1, 'the open question');
  act(() => button(el, 'Reply').click());
  await settle();
  expect(el.querySelector('[data-skip-chip]')?.getAttribute('data-skip-chip')).toBe('keep');
  type(el, 'Later.');
  act(() => button(el, 'Send').click());
  await until(() => el.querySelector('textarea') === null, 'the Send');
  await expectWordsOnly(world.waiting, second, 'Later.');
});

test.skipIf(!hasDom)('one session asked twice: the box cancelled and opened again keeps the default, and the Send is words-only', async () => {
  const second = await askAgain(world);
  const el = await renderApp(`#thread=${world.waiting}`);
  await until(() => el.querySelectorAll('fieldset[data-question-key]').length === 2, 'both questions');
  act(() => button(el, 'Reply').click());
  await settle();
  type(el, 'A first try.');
  act(() => button(el, 'Cancel').click());
  await settle();
  act(() => button(el, 'Reply').click());
  await settle();
  expect(el.querySelector('[data-skip-chip]')?.getAttribute('data-skip-chip')).toBe('keep');
  type(el, 'The second try.');
  act(() => button(el, 'Send').click());
  await until(() => el.querySelector('textarea') === null, 'the Send');
  await expectWordsOnly(world.waiting, second, 'The second try.');
});

test.skipIf(!hasDom)('one session asked twice: a second words-only Send after the first is words-only too', async () => {
  const second = await askAgain(world);
  const el = await renderApp(`#thread=${world.waiting}`);
  await until(() => el.querySelectorAll('fieldset[data-question-key]').length === 2, 'both questions');
  act(() => button(el, 'Reply').click());
  await settle();
  type(el, 'One.');
  act(() => button(el, 'Send').click());
  await until(() => el.querySelector('textarea') === null, 'the first Send');
  await settle();
  posted = [];
  act(() => button(el, 'Reply').click());
  await settle();
  expect(el.querySelector('[data-skip-chip]')?.getAttribute('data-skip-chip')).toBe('keep');
  type(el, 'Two.');
  act(() => button(el, 'Send').click());
  await until(() => el.querySelector('textarea') === null, 'the second Send');
  expect(replies().map((p) => p.path)).toEqual([`/api/inbox/messages/${second}/reply`]);
  expect(replies()[0]!.body).toMatchObject({ words: 'Two.', questions: [], skip_unanswered: false });
  const model = await readThread(world.waiting);
  expect(model.thread.messages.flatMap((m) => m.questions ?? []).map((q) => q.state)).toEqual(['open', 'open']);
});
