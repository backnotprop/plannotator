/**
 * Sent questions are read-only one by one, as the window draws them over a
 * REAL Inbox server in a temp data dir (its own process,
 * tests/helpers/inbox-dom-server.ts with its `sent-multi` seed): one message
 * holds a pick-any question the person already sent (`Toasts`, not the
 * recommendation) and a pick-one question still open.
 * The failure this catches: the sent card offering "Accept recommended" or
 * live boxes (the server answers "already sent"), or the lock spilling over
 * onto the open question in the same message.
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

/** The real Inbox, in its own process: happy-dom's Response cannot be served from this one. */
const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');

type World = { project: string; sentMulti: string };

let child: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;
let worlds: World[] = [];
let ids: World;
let dir: string | null = null;
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedEventSource: unknown;

/** One request to the real Inbox over loopback (happy-dom's own fetch would resolve against its page). */
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

const TESTS = 2;

beforeAll(async () => {
  if (!hasDom) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-sent-q-dom-')));
  // Never the real tailscale, never the real data dir.
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(dir, 'bin', 'tailscale'), 0o755);
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), String(TESTS), 'sent-multi'], {
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
  ids = worlds.shift()!;
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

async function settle(ms = 40) {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, ms));
    });
  }
}

/** Act until `check` holds (the window's reads go to another process), or fail after 5 s. */
async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
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

const cardsOf = (el: ParentNode, messageId: string) =>
  [...el.querySelectorAll<HTMLFieldSetElement>(`[data-message-id="${messageId}"] fieldset[data-question-key]`)];
/** Open the thread and unfold the asking message (the person's reply after it is the last message, so it opens folded). */
async function openThread() {
  const el = await renderApp(`#thread=${ids.sentMulti}`);
  const article = () => el.querySelector<HTMLElement>(`[data-message-article="${ids.sentMulti}"]`);
  await until(() => !!article(), 'the asking message');
  if (article()!.hasAttribute('data-folded')) {
    await act(async () => article()!.querySelector<HTMLButtonElement>('[data-fold-head]')!.click());
  }
  await until(() => cardsOf(el, ids.sentMulti).length === 2, 'the two question cards');
  return el;
}
const buttonIn =(card: HTMLElement, label: string) =>
  [...card.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;

test.skipIf(!hasDom)('a sent pick-any card is read-only; the open question beside it still answers', async () => {
  const el = await openThread();
  const [sent, open] = cardsOf(el, ids.sentMulti);

  // The sent card: its answer drawn, nothing to press.
  const boxes = [...sent.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  expect(boxes).toHaveLength(3);
  expect(boxes.every((b) => b.disabled)).toBe(true);
  expect(boxes.filter((b) => b.checked)).toHaveLength(1);
  expect(buttonIn(sent, 'Accept recommended')).toBeUndefined();
  expect(buttonIn(sent, 'Skip')).toBeUndefined();
  expect(buttonIn(sent, 'Add note')).toBeUndefined();

  // The open card in the same message keeps every control, and a pick saves.
  const radios = [...open.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
  expect(radios.every((r) => !r.disabled)).toBe(true);
  expect(buttonIn(open, 'Accept recommended')).toBeDefined();
  expect(buttonIn(open, 'Skip')).toBeDefined();
  await act(async () => buttonIn(open, 'Accept recommended')!.click());
  await until(() => {
    const now = cardsOf(el, ids.sentMulti)[1];
    return !!now && now.querySelector<HTMLInputElement>('input[type="radio"]:checked') !== null;
  }, 'the pick on the open card');
  let saved: { state: string; answer?: { selected: string[] } } | undefined;
  await until(() => {
    void loopback(`/api/inbox/threads/${ids.sentMulti}`).then((r) => {
      const thread = JSON.parse(r.text).thread as { messages: { id: string; questions?: { kind: string; state: string; answer?: { selected: string[] } }[] }[] };
      saved = thread.messages.find((m) => m.id === ids.sentMulti)?.questions?.find((q) => q.kind === 'single');
    });
    return saved?.state === 'picked';
  }, 'the pick saved on the server');
  expect(saved!.answer?.selected).toEqual(['Changelog']);
});

test.skipIf(!hasDom)('clicking a box on the sent card changes nothing on the server', async () => {
  const el = await openThread();
  const dot = cardsOf(el, ids.sentMulti)[0].querySelector<HTMLLabelElement>('label')!;
  await act(async () => dot.click());
  await settle();
  const thread = JSON.parse((await loopback(`/api/inbox/threads/${ids.sentMulti}`)).text).thread as {
    messages: { id: string; questions?: { kind: string; state: string; answer?: { selected: string[] } }[] }[];
  };
  const multi = thread.messages.find((m) => m.id === ids.sentMulti)!.questions!.find((q) => q.kind === 'multi')!;
  expect(multi.state).toBe('sent');
  expect(multi.answer?.selected).toEqual(['Toasts']);
  expect(el.textContent).not.toContain('already sent');
});
