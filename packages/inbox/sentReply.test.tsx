/**
 * The person's own sent reply reads in their own words (the onboarding
 * audit, finding 7; owner approval 2026-10-24), drawn by the whole window
 * over a REAL Inbox in a temp data dir (its own process,
 * tests/helpers/inbox-dom-server.ts `sent-reply`). Before this the thread
 * showed what the agent gets: "Answered 1 question." and "## Answers to your
 * questions … ### Q1. … (line 4)" in large headings. Now:
 * - their words, then a short list "Q1 <prompt> → <answer>" read from the
 *   questions (`sent_reply_id`), a skip marked, grouped by the message that
 *   asked when the reply answered several;
 * - their comments' feedback after it, as before;
 * - a row takes them to its card (a folded message opens);
 * - the stored body, which agents get, is unchanged.
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

const hasDom = typeof document !== 'undefined';
const { InboxApp } = (hasDom ? await import('./App') : {}) as typeof import('./App');

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');

type World = { project: string; sentReply: { thread: string; a: string; b: string; reply: string; simple: string; simpleReply: string } };

let child: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;
let worlds: World[] = [];
let ids: World['sentReply'];
let dir: string | null = null;
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedEventSource: unknown;

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

const TESTS = 3;

beforeAll(async () => {
  if (!hasDom) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-sent-reply-dom-')));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(dir, 'bin', 'tailscale'), 0o755);
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), String(TESTS), 'sent-reply'], {
    env: { ...process.env, DOM_TESTS: '0', PLANNOTATOR_DATA_DIR: join(dir, 'data'), HOME: dir, PATH: `${join(dir, 'bin')}:${process.env.PATH}` },
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
  let line = '';
  while (!line.includes('\n')) {
    const { value, done } = await reader.read();
    if (done) throw new Error('the Inbox did not start');
    line += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  const started = JSON.parse(line.trim()) as { port: number; worlds: World[] };
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
  ids = worlds.shift()!.sentReply;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const answer = await loopback(String(input), init?.method ?? 'GET', init?.body ? String(init.body) : undefined);
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

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function openThread(thread: string, reply: string) {
  window.location.hash = `#thread=${thread}`;
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<InboxApp />);
  });
  const body = () => host!.querySelector<HTMLElement>(`.ib-body[data-message-id="${reply}"]`);
  await until(() => !!body(), 'the sent reply');
  return { el: host, body: body()! };
}

const text = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
const rows = (body: HTMLElement) =>
  [...body.querySelectorAll<HTMLElement>('[data-sent-answer]')].map((row) => ({
    n: text(row.querySelector('.ib-ranswer-n')),
    prompt: text(row.querySelector('.ib-ranswer-p')),
    answer: text(row.querySelector('.ib-ranswer-a')),
    skipped: row.querySelector('[data-sent-skipped]') !== null,
  }));

test.skipIf(!hasDom)('a reply with words, answers on two messages, a skip and a comment: their words, the answers by message, the comment', async () => {
  const { body } = await openThread(ids.thread, ids.reply);
  expect(body.hasAttribute('data-sent-reply')).toBe(true);
  const shown = text(body);
  expect(shown.startsWith('Go with the dense table. Thanks!')).toBe(true);
  // None of what the store writes for the agent.
  expect(shown).not.toContain('Answered');
  expect(shown).not.toContain('Answers to your questions');
  expect(shown).not.toContain('(line');
  expect(shown).not.toContain('Your message msg_');
  expect(shown).not.toContain("Don't re-ask");
  expect(body.querySelector('h2, h3')?.textContent ?? '').not.toContain('Answers');

  const list = body.querySelector<HTMLElement>('[data-sent-answers]')!;
  expect(text(list.querySelector('.ib-ranswers-h'))).toBe('You answered 2 questions, skipped 1');
  // Two asking messages: grouped under each, in thread order.
  expect([...list.querySelectorAll('[data-sent-answers-group]')].map((g) => g.getAttribute('data-sent-answers-group'))).toEqual([ids.a, ids.b]);
  expect(rows(body)).toEqual([
    { n: 'Q1', prompt: 'Which layout should the export use?', answer: 'A dense table', skipped: false },
    { n: 'Q2', prompt: 'Should the export include voided invoices?', answer: 'Skipped', skipped: true },
    { n: 'Q1', prompt: 'Ship it behind a flag?', answer: 'Yes, behind a flag', skipped: false },
  ]);
  // The list sits between the words and the comment's feedback.
  const order = [...body.querySelectorAll('[data-sent-answers], .ib-body > *')].map((n) => n.hasAttribute('data-sent-answers'));
  expect(order.indexOf(true)).toBeGreaterThan(0);
  expect(shown.indexOf('Go with the dense table')).toBeLessThan(shown.indexOf('You answered'));
  expect(shown.indexOf('You answered')).toBeLessThan(shown.indexOf('Say which plan.'));
  expect(shown).toContain('Feedback on the attached files');
  // Hover text is component tooltips, never native titles.
  expect(list.querySelector('[title]')).toBeNull();

  // What the agent got is unchanged.
  const thread = JSON.parse((await loopback(`/api/inbox/threads/${ids.thread}`)).text).thread as { messages: { id: string; body: string }[] };
  const stored = thread.messages.find((m) => m.id === ids.reply)!.body;
  expect(stored.startsWith('Answered 2 questions, skipped 1.\n\nGo with the dense table. Thanks!')).toBe(true);
  expect(stored).toContain('## Answers to your questions');
  expect(stored).toContain(`### Your message ${ids.a}`);
}, 20_000);

test.skipIf(!hasDom)('a row shows its question: the folded message that asked opens, and its card is the target', async () => {
  const { el, body } = await openThread(ids.thread, ids.reply);
  const article = () => el.querySelector<HTMLElement>(`[data-message-article="${ids.a}"]`)!;
  expect(article().hasAttribute('data-folded')).toBe(true);
  const row = body.querySelector<HTMLButtonElement>(`button[data-sent-answer^="${ids.a}/"]`)!;
  expect(row.getAttribute('aria-label')).toContain('Q1, Which layout should the export use?: A dense table.');
  await act(async () => row.click());
  await until(() => !article().hasAttribute('data-folded'), 'the asking message opening');
  await until(() => el.querySelector(`[data-message-id="${ids.a}"] fieldset[data-question-key]`) !== null, 'its card');
}, 20_000);

test.skipIf(!hasDom)('answers alone: no words, one message, no group heading', async () => {
  const { body } = await openThread(ids.simple, ids.simpleReply);
  expect(text(body).startsWith('You answered 1 question')).toBe(true);
  expect(body.querySelector('[data-sent-answers-group]')).toBeNull();
  expect(rows(body)).toEqual([{ n: 'Q1', prompt: 'Which search index should the docs use?', answer: 'Pagefind', skipped: false }]);
  expect(text(body)).not.toContain('Answered');
}, 20_000);
