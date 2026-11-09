/**
 * A note on a question card reaches the agent with the Send (the owner: "When
 * I skip a message but add a note, that note needs to go to the reply"). The
 * person writes the note and presses Send right away, before the window's
 * copy of the thread has caught up with the saved picks: the reply must still
 * carry the note under "Answers to your questions". Cases: Skip plus a note;
 * a note alone with the default (Keep open, approval "inbox-explicit-skip");
 * a note alone with Skip them. The window
 * over a REAL Inbox (tests/helpers/inbox-dom-server.ts).
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

const TESTS = 5;

beforeAll(async () => {
  if (!hasDom) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-skipnote-dom-')));
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

function button(el: ParentNode, text: string): HTMLButtonElement {
  const found = [...el.querySelectorAll('button')].find((b) => b.textContent?.replace(/\s+/g, ' ').trim() === text);
  if (!found) throw new Error(`no button "${text}" in ${[...el.querySelectorAll('button')].map((b) => b.textContent?.trim()).join(' | ')}`);
  return found as HTMLButtonElement;
}

function note(card: HTMLElement, words: string) {
  act(() => button(card, 'Add note').click());
  typeNote(card, words);
}

function typeNote(card: HTMLElement, words: string, from = 0) {
  const text = card.querySelector('textarea') as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  // Typed one character at a time, as a person types: each keystroke saves.
  for (let i = from + 1; i <= words.length; i++) {
    act(() => {
      setter.call(text, words.slice(0, i));
      text.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
}

const cards = (el: ParentNode) => [...el.querySelectorAll('fieldset[data-question-key]')] as HTMLElement[];

async function personReply(): Promise<string> {
  const model = await readThread(world.stopped);
  const mine = model.thread.messages.filter((m) => m.author.kind === 'person');
  expect(mine).toHaveLength(1);
  return mine[0]!.body;
}

async function openStopped() {
  const el = await renderApp(`#thread=${world.stopped}`);
  await until(() => cards(el).length === 2, 'both questions');
  return el;
}

/** The Send in view: the foot's, or the reply box's when it is open. */
const sendButton = (el: ParentNode) => {
  const all = [...el.querySelectorAll('button')].filter((b) => b.textContent?.replace(/\s+/g, ' ').trim() === 'Send');
  if (all.length === 0) throw new Error('no Send button');
  return all.at(-1) as HTMLButtonElement;
};

async function sentReply() {
  // A refused Send shows its reason instead of a reply.
  for (let i = 0; i < 40; i++) {
    if ((await readThread(world.stopped)).thread.messages.some((m) => m.author.kind === 'person')) break;
    await settle(25);
  }
  await settle();
  expect(el().querySelector('.ib-error')?.textContent ?? null).toBeNull();
  return personReply();
}
let current: HTMLElement | null = null;
const el = () => current!;

test.skipIf(!hasDom)('Skip and a note on a card, Send pressed while the note is still saving: the reply carries the skip and the note', async () => {
  current = await openStopped();
  act(() => button(cards(el())[0]!, 'Skip').click());
  // The skip saved: the foot offers Send.
  await until(() => [...el().querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Send'), 'the foot Send');
  note(cards(el())[0]!, 'Ask me after the design review');
  act(() => sendButton(el()).click());
  const body = await sentReply();
  expect(body).toContain('### Q1. Which layout should the invoice list use? (line 4)\nSkipped\nNote: Ask me after the design review');
  const qs = (await readThread(world.stopped)).thread.messages[0]!.questions!;
  // The card's own Skip is the person's; the other question stays open (a Send never skips on its own).
  expect(qs.map((q) => q.state)).toEqual(['sent', 'open']);
  expect(qs[0]!.answer).toMatchObject({ skipped: true, note: 'Ask me after the design review' });
}, 20_000);

test.skipIf(!hasDom)('a note alone in the reply box flow, the default (Keep open): the note goes with the Send, the other question stays open', async () => {
  current = await openStopped();
  act(() => button(el(), 'Reply').click());
  await settle();
  note(cards(el())[0]!, 'Leaning to cards');
  act(() => sendButton(el()).click());
  const body = await sentReply();
  expect(body).toContain('### Q1. Which layout should the invoice list use? (line 4)\nNote: Leaning to cards');
  const qs = (await readThread(world.stopped)).thread.messages[0]!.questions!;
  expect(qs.map((q) => q.state)).toEqual(['sent', 'open']);
  expect(qs[0]!.answer).toMatchObject({ note: 'Leaning to cards' });
  expect(qs[1]!.answer).toBeNull();
  expect(body).toContain("You have 1 other question open in this thread.");
}, 20_000);

test.skipIf(!hasDom)('a note alone, then Skip them: the note goes, the other question is skipped with the reply', async () => {
  current = await openStopped();
  act(() => button(el(), 'Reply').click());
  await settle();
  note(cards(el())[0]!, 'Leaning to cards');
  await settle();
  // The default keeps the other question open whatever the Send carries: Skip them instead.
  expect(el().querySelector('[data-skip-chip]')?.getAttribute('data-skip-chip')).toBe('keep');
  act(() => (el().querySelector('[data-skip-toggle]') as HTMLButtonElement).click());
  expect(el().querySelector('[data-skip-chip]')?.getAttribute('data-skip-chip')).toBe('skip');
  // More of the note, and Send while it saves.
  typeNote(cards(el())[0]!, 'Leaning to cards, for now', 'Leaning to cards'.length);
  act(() => sendButton(el()).click());
  const body = await sentReply();
  expect(body).toContain('### Q1. Which layout should the invoice list use? (line 4)\nNote: Leaning to cards, for now');
  const qs = (await readThread(world.stopped)).thread.messages[0]!.questions!;
  expect(qs.map((q) => q.state)).toEqual(['sent', 'sent']);
  expect(qs[1]!.answer).toMatchObject({ skipped: true, by_reply: true });
}, 20_000);

test.skipIf(!hasDom)('a pick, then Skip and a note, Send at once: the skip and the note go, not the dropped pick', async () => {
  current = await openStopped();
  act(() => (cards(el())[0]!.querySelector('[data-question-option] input') as HTMLInputElement).click());
  await until(async () => (await readThread(world.stopped)).thread.messages[0]!.questions![0]!.state === 'picked', 'the pick saved');
  await settle();
  act(() => button(cards(el())[0]!, 'Skip').click());
  note(cards(el())[0]!, 'Not this sprint');
  act(() => sendButton(el()).click());
  const body = await sentReply();
  expect(body).toContain('Skipped\nNote: Not this sprint');
  expect(body).not.toContain('Cards');
}, 20_000);

test.skipIf(!hasDom)('Re-ask pressed while a pick and a note are still saving: the picks go as a reply with the note, no error', async () => {
  current = await openStopped();
  act(() => (cards(el())[0]!.querySelector('[data-question-option] input') as HTMLInputElement).click());
  await until(async () => (await readThread(world.stopped)).thread.messages[0]!.questions![0]!.state === 'picked', 'the first pick saved');
  await settle();
  // The second question is still open as drawn: the open-questions list (Re-ask at its foot, owner,
  // 2026-10-23) is offered. Open it now, so pressing Re-ask below is one synchronous click.
  const trigger = el().querySelector('[data-open-questions]') as HTMLElement;
  expect(trigger).not.toBeNull();
  await act(async () => {
    trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
    trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    trigger.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }));
    trigger.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    trigger.click();
  });
  await until(() => !!document.querySelector('[data-open-questions-list] [data-reask]'), 'Re-ask in the list');
  // Pick the second and write a note on the first; Re-ask before either save lands.
  act(() => (cards(el())[1]!.querySelector('[data-question-option] input') as HTMLInputElement).click());
  note(cards(el())[0]!, 'Keep it simple');
  act(() => (document.querySelector('[data-open-questions-list] [data-reask]') as HTMLElement).click());
  const body = await sentReply();
  // Nothing is open any more, so no Re-ask note: one plain reply carrying both picks and the note.
  expect(body).toContain('### Q1. Which layout should the invoice list use? (line 4)\nAnswer: Cards\nNote: Keep it simple');
  expect(body).toContain('### Q2. Should overdue invoices sort to the top? (line 13)\nAnswer: Yes');
  const qs = (await readThread(world.stopped)).thread.messages[0]!.questions!;
  expect(qs.map((q) => q.state)).toEqual(['sent', 'sent']);
  expect(qs[0]!.answer).toMatchObject({ selected: ['Cards'], note: 'Keep it simple' });
}, 20_000);
