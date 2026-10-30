/**
 * Picks made while the reply box is open (the owner: "When i edit a reply,
 * and then add new answers... do they get added to the reply? Because I dont
 * see them"). An agent asks six pick-one questions; the person picks one,
 * opens the reply (Edit draft), adds words, then picks more on the cards.
 * Every pick saves; the box lists every answer live under the words and
 * never writes them into the words (until 0.28.25 Edit draft seeded a
 * one-time summary that went stale). A row jumps to its card. The window over a REAL Inbox
 * (tests/helpers/inbox-dom-server.ts).
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
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

type World = { project: string; waiting: string; stopped: string };
let child: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;
let worlds: World[] = [];
let world: World = { project: '', waiting: '', stopped: '' };
let dir: string | null = null;
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedEventSource: unknown;
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

const TESTS = 3;

beforeAll(async () => {
  if (!hasDom) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-picks-composing-dom-')));
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
    const answer = await loopback(path, method, body);
    return new Response(answer.text, { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  savedEventSource = (globalThis as Record<string, unknown>).EventSource;
  (globalThis as Record<string, unknown>).EventSource = class {
    addEventListener() {}
    close() {}
  };
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

async function until(check: () => boolean | Promise<boolean>, what: string, tries = 80) {
  for (let i = 0; i < tries; i++) {
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

const SIX = [
  'Six choices before I build the billing screens:',
  '',
  ...[
    ['Which layout should the invoice list use?', 'Cards', 'A dense table'],
    ['Should overdue invoices sort to the top?', 'Yes', 'No'],
    ['Which currency format?', 'Symbol first', 'Code after'],
    ['Where does the export button go?', 'Header', 'Footer'],
    ['Paginate or scroll?', 'Paginate', 'Infinite scroll'],
    ['Default date range?', 'Last 30 days', 'This month'],
  ].flatMap(([prompt, a, b]) => [':::question', prompt!, '', `- [ ] ${a}`, `- [ ] ${b}`, ':::', '']),
].join('\n');

/** An agent writes while the test runs (the server's stdin). */
async function agentSends(body: string, reply_to?: string): Promise<string> {
  const before = lines.length;
  (child!.stdin as import('bun').FileSink).write(`${JSON.stringify({ send: { project: world.project, session: 'ses_six', body, ...(reply_to ? { reply_to } : {}) } })}\n`);
  (child!.stdin as import('bun').FileSink).flush();
  for (let i = 0; i < 200; i++) {
    const line = lines.slice(before).find((l) => l.includes('"sent"'));
    if (line) return (JSON.parse(line) as { sent: string }).sent;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('the agent message was not written');
}

const cards = (el: ParentNode) => [...el.querySelectorAll('fieldset[data-question-key]')] as HTMLElement[];
const choice = (card: HTMLElement, n: number) => card.querySelectorAll('[data-question-option] input')[n] as HTMLInputElement;
const textarea = (el: ParentNode) => el.querySelector('.ib-rbox textarea') as HTMLTextAreaElement;

function type(text: HTMLTextAreaElement, words: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    text.focus();
    setter.call(text, words);
    text.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** A person's click: focus leaves the reply box for the card, then the click. */
function clickChoice(input: HTMLInputElement) {
  act(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    input.click();
  });
}

const serverQuestions = async (message: string) => {
  const model = await readThread(threadOf.get(message)!);
  return model.thread.messages.find((m) => m.id === message)!.questions!;
};
const threadOf = new Map<string, string>();

async function openSix(followUp?: string) {
  const message = await agentSends(SIX);
  const later = followUp ? await agentSends(followUp, message) : null;
  const list = JSON.parse((await loopback('/api/inbox/threads')).text) as { sections: { threads: { thread_id: string; subject: string }[] }[] };
  const row = list.sections.flatMap((s) => s.threads).find((t) => t.subject.startsWith('Six choices') || t.thread_id === message)!;
  threadOf.set(message, row.thread_id);
  const el = await renderApp(`#thread=${row.thread_id}`);
  await until(() => cards(el).length === (later ? 7 : 6), 'the questions');
  return { el, message, later };
}

const answerRows = (el: ParentNode) =>
  [...el.querySelectorAll('[data-reply-answers] [data-reply-answer]')].map((row) => row.textContent?.replace(/\s+/g, ' ').trim());

async function personReplies(message: string) {
  const model = await readThread(threadOf.get(message)!);
  return model.thread.messages.filter((m) => m.author.kind === 'person');
}

test.skipIf(!hasDom)('picks made while the reply box is open save, and the box lists every answer live', async () => {
  const { el, message } = await openSix();
  // One pick, then the reply box from the foot's Edit draft.
  clickChoice(choice(cards(el)[0]!, 0));
  await until(async () => (await serverQuestions(message))[0]!.state === 'picked', 'the first pick saved');
  await settle();
  act(() => (el.querySelector('[data-edit-draft]') as HTMLButtonElement).click());
  await settle();
  const text = textarea(el);
  expect(text).not.toBeNull();
  // The box holds the person's words only: the answers are listed beside them, never written into
  // the words as a summary that would go stale (and reach the agent twice).
  expect(text.value).toBe('');
  expect(el.querySelector('[data-reply-answers]')?.textContent).toContain('Your answer goes with this reply');
  expect(answerRows(el)).toEqual(['Q1 Which layout should the invoice list use? Cards']);
  type(text, 'Cards because the list is short.');
  await settle();
  // More picks while the box is open, focus in the words.
  for (const n of [1, 2, 3]) {
    act(() => text.focus());
    clickChoice(choice(cards(el)[n]!, 0));
    await settle(20);
  }
  await until(async () => (await serverQuestions(message)).filter((q) => q.state === 'picked').length === 4, 'four picks saved');
  await settle();
  expect(el.querySelector('.ib-error')?.textContent ?? null).toBeNull();
  expect(el.querySelector('[data-picks-chip]')?.textContent).toContain('4 picks');
  expect(el.querySelector('[data-reply-answers]')?.textContent).toContain('Your 4 answers go with this reply');
  expect(answerRows(el)).toEqual([
    'Q1 Which layout should the invoice list use? Cards',
    'Q2 Should overdue invoices sort to the top? Yes',
    'Q3 Which currency format? Symbol first',
    'Q4 Where does the export button go? Header',
  ]);
  // A changed pick shows at once, and the words are as the person left them.
  clickChoice(choice(cards(el)[0]!, 1));
  await settle();
  expect(answerRows(el)[0]).toBe('Q1 Which layout should the invoice list use? A dense table');
  expect(textarea(el).value).toBe('Cards because the list is short.');
  // The last two stay open by default (approval "inbox-explicit-skip"), then Send: the words once, every answer once.
  expect(el.querySelector('[data-skip-chip]')?.getAttribute('data-skip-chip')).toBe('keep');
  await until(async () => (await serverQuestions(message))[0]!.answer?.selected?.[0] === 'A dense table', 'the changed pick saved');
  const sends = [...el.querySelectorAll('.ib-rbox ~ .ib-acts button, .ib-acts button')].filter((b) => b.textContent?.trim() === 'Send');
  act(() => (sends.at(-1) as HTMLButtonElement).click());
  await until(async () => (await personReplies(message)).length === 1, 'the reply');
  const body = (await personReplies(message))[0]!.body;
  expect(body.split('Cards because the list is short.').length).toBe(2);
  expect(body).toContain('### Q1. Which layout should the invoice list use?');
  expect(body).toContain('Answer: A dense table');
  expect(body).toContain('Answer: Header');
  // No summary line of the picks in the words.
  expect(body).not.toContain('Which layout should the invoice list use: ');
  const qs = await serverQuestions(message);
  expect(qs.map((q) => q.state)).toEqual(['sent', 'sent', 'sent', 'sent', 'open', 'open']);
}, 30_000);

test.skipIf(!hasDom)('a row in the answers list takes the person to its card', async () => {
  const { el, message } = await openSix();
  clickChoice(choice(cards(el)[2]!, 1));
  await until(async () => (await serverQuestions(message))[2]!.state === 'picked', 'the pick saved');
  await settle();
  act(() => (el.querySelector('[data-edit-draft]') as HTMLButtonElement).click());
  await settle();
  const row = el.querySelector('[data-reply-answers] [data-reply-answer]') as HTMLButtonElement;
  expect(row.tagName).toBe('BUTTON');
  act(() => row.click());
  await settle();
  expect(document.activeElement).toBe(cards(el)[2]!);
}, 30_000);

test.skipIf(!hasDom)('answers to two messages: grouped under each message, "go with your replies", and the chip agrees', async () => {
  const followUp = [':::question', 'Ship it behind a flag?', '', '- [ ] Yes, a flag', '- [ ] No flag', ':::'].join('\n');
  const { el, message, later } = await openSix(followUp);
  clickChoice(choice(cards(el)[0]!, 0));
  clickChoice(choice(cards(el)[6]!, 0));
  await until(async () => (await serverQuestions(message))[0]!.state === 'picked', 'the first pick saved');
  await until(async () => {
    const model = await readThread(threadOf.get(message)!);
    return model.thread.messages.find((m) => m.id === later)!.questions![0]!.state === 'picked';
  }, 'the follow-up pick saved');
  await settle();
  act(() => (el.querySelector('[data-edit-draft]') as HTMLButtonElement).click());
  await settle();
  const list = el.querySelector('[data-reply-answers]')!;
  // The group is named by its visible heading, not a repeated aria-label.
  const heading = list.querySelector('.ib-ranswers-h')!;
  expect(list.getAttribute('aria-labelledby')).toBe(heading.id);
  expect(list.hasAttribute('aria-label')).toBe(false);
  expect(heading.textContent).toBe('Your 2 answers go with your replies');
  const groups = [...list.querySelectorAll('[data-reply-answers-group]')].map((g) => g.getAttribute('data-reply-answers-group'));
  expect(groups).toEqual([message, later]);
  expect(answerRows(el)).toEqual(['Q1 Which layout should the invoice list use? Cards', 'Q1 Ship it behind a flag? Yes, a flag']);
  // Each Q1 says which message it answers, for a screen reader too.
  const labels = [...list.querySelectorAll('[data-reply-answer]')].map((b) => b.getAttribute('aria-label'));
  expect(labels[0]).toMatch(/^Q1, Which layout should the invoice list use\?: Cards\. Claude Code's message, .+\. Show the question\.$/);
  expect(el.querySelector('[data-picks-chip]')?.textContent).toContain('2 picks');
  // A pick still being saved counts in both at once.
  clickChoice(choice(cards(el)[1]!, 0));
  expect(el.querySelector('[data-picks-chip]')?.textContent).toContain('3 picks');
  expect(heading.textContent).toBe('Your 3 answers go with your replies');
  await until(async () => (await serverQuestions(message))[1]!.state === 'picked', 'the third pick saved');
}, 30_000);
