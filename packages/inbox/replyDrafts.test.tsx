/**
 * Reply drafts in the window (approval "inbox-reply-drafts", variant Label):
 * the words typed in a thread's reply box are kept as a server draft while
 * typing, come back (without taking focus) when the thread opens again,
 * survive Cancel, go with Discard and with the Send that carries them; the
 * list row says "Draft · Your reply" (or "Draft · 1 pick"), and the Drafts
 * page lists the threads holding unsent work above the messages.
 *
 * The window over a REAL Inbox (tests/helpers/inbox-dom-server.ts), its
 * fetches carried over loopback. DOM-gated: runs under DOM_TESTS=1
 * (happy-dom), from tests/dom-test-list.txt.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { unsentReply } from './unsent';
import { configStore } from '@plannotator/ui/config';

const hasDom = typeof document !== 'undefined';
const { InboxApp } = (hasDom ? await import('./App') : {}) as typeof import('./App');

// Every test here drives the window against a real Inbox with deliberate delays (a
// 1.5 s held reply, 200 ms settles); on CI's runners several take just over bun's 5 s
// default. A test that times out also makes bun kill "dangling" processes, which takes
// the shared DOM server (spawned in beforeAll) down with it, so every later test then
// fails on "the foot". Give them room.
setDefaultTimeout(30_000);

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');

type World = { project: string; waiting: string; picked: string };
let child: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;
let worlds: World[] = [];
let world: World = { project: '', waiting: '', picked: '' };
let dir: string | null = null;
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedEventSource: unknown;
let posted: { path: string; body: Record<string, unknown> }[] = [];
/** How long the reply route's answer is held back (the delayed-reply probe), in ms. */
let replyDelay = 0;
/** The window's event streams (a stand-in EventSource), to hand it an `event: drafts`. */
let streams: { listeners: Map<string, ((event: { data: string }) => void)[]> }[] = [];
function emit(type: string, data: unknown) {
  for (const stream of streams) for (const listener of stream.listeners.get(type) ?? []) listener({ data: JSON.stringify(data) });
}
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

const TESTS = 39;

beforeAll(async () => {
  if (!hasDom) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-replydrafts-dom-')));
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
    // Only the reply's answer is held back: the request itself has reached the server.
    if (replyDelay > 0 && method === 'POST' && path.endsWith('/reply')) await new Promise((r) => setTimeout(r, replyDelay));
    return new Response(answer.text, { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  savedEventSource = (globalThis as Record<string, unknown>).EventSource;
  streams = [];
  (globalThis as Record<string, unknown>).EventSource = class {
    listeners = new Map<string, ((event: { data: string }) => void)[]>();
    constructor() {
      streams.push(this);
    }
    addEventListener(type: string, listener: (event: { data: string }) => void) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }
    close() {}
  };
  replyDelay = 0;
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

const serverDraft = async (threadId: string) =>
  (JSON.parse((await loopback(`/api/inbox/threads/${threadId}/draft`)).text) as { draft: { body: string; updated_at: string } | null }).draft;

const leave = () => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
};

test.skipIf(!hasDom)('typed words are saved while typing, and come back in the box when the thread opens again, without taking focus', async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  await until(() => [...el.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Reply'), 'the foot');
  act(() => button(el, 'Reply').click());
  await settle();
  type(el, 'Pagefind, but index the changelog too');
  await until(async () => (await serverDraft(world.waiting))?.body === 'Pagefind, but index the changelog too', 'the draft saved');
  // The soft pill with when it was saved, and Discard.
  await until(() => el.querySelector('[data-draft-head] .ib-draft-pill') !== null, 'the Draft pill');
  expect(el.querySelector('[data-draft-head] .ib-draft-saved')?.textContent).toMatch(/^Saved \d{1,2}:\d{2} [AP]M$/);
  expect(el.querySelector('[data-draft-discard]')?.textContent).toBe('Discard');
  leave();

  const again = await renderApp(`#thread=${world.waiting}`);
  await until(() => (again.querySelector('textarea') as HTMLTextAreaElement | null)?.value === 'Pagefind, but index the changelog too', 'the words back');
  expect(document.activeElement).not.toBe(again.querySelector('textarea'));
});

test.skipIf(!hasDom)('the reply box is a message, not a comment: "Enter saves a comment" leaves its Enter a new line (#1934)', async () => {
  configStore.set('enterSavesComment', true);
  try {
    const el = await renderApp(`#thread=${world.waiting}`);
    await until(() => [...el.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Reply'), 'the foot');
    act(() => button(el, 'Reply').click());
    await settle();
    type(el, 'Pagefind');
    const box = el.querySelector('textarea') as HTMLTextAreaElement;
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    act(() => {
      box.dispatchEvent(enter);
    });
    await settle();
    expect(enter.defaultPrevented).toBe(false);
    expect(posted.some((p) => p.path.endsWith('/reply'))).toBe(false);
    expect(el.querySelector('textarea')).not.toBeNull();
  } finally {
    configStore.set('enterSavesComment', false);
  }
});

test.skipIf(!hasDom)('leaving the thread before the pause in typing still saves the words', async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  await until(() => [...el.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Reply'), 'the foot');
  act(() => button(el, 'Reply').click());
  await settle(5);
  type(el, 'Orama.');
  leave();
  await until(async () => (await serverDraft(world.waiting))?.body === 'Orama.', 'the draft saved as the thread closed');
});

test.skipIf(!hasDom)('Cancel keeps the words: the foot says "Draft · Your reply", Send and Edit draft; Edit draft brings them back', async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  await until(() => [...el.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Reply'), 'the foot');
  act(() => button(el, 'Reply').click());
  await settle();
  type(el, 'Pagefind.');
  act(() => button(el, 'Cancel').click());
  await until(async () => (await serverDraft(world.waiting))?.body === 'Pagefind.', 'the draft saved on Cancel');
  await until(() => el.querySelector('[data-draft-foot]') !== null, 'the foot says Draft');
  expect(el.querySelector('[data-draft-foot]')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Draft, Your reply');
  expect(el.querySelector('.ib-pfoot')?.textContent).not.toContain('Not sent');
  button(el, 'Send');
  act(() => button(el, 'Edit draft').click());
  await settle();
  expect((el.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Pagefind.');
});

test.skipIf(!hasDom)('Discard drops the draft, here and on the server', async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  await until(() => [...el.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Reply'), 'the foot');
  act(() => button(el, 'Reply').click());
  await settle();
  type(el, 'Never mind this.');
  await until(() => el.querySelector('[data-draft-discard]') !== null, 'Discard');
  act(() => (el.querySelector('[data-draft-discard]') as HTMLButtonElement).click());
  await until(() => el.querySelector('textarea') === null, 'the box closed');
  await until(async () => (await serverDraft(world.waiting)) === null, 'the draft gone');
  button(el, 'Reply');
  expect(el.querySelector('[data-draft-foot]')).toBeNull();
});

test.skipIf(!hasDom)('the Send that carries the words clears the draft (clear_draft on that reply)', async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  await until(() => [...el.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Reply'), 'the foot');
  act(() => button(el, 'Reply').click());
  await settle();
  type(el, 'Pagefind, thanks.');
  await until(async () => (await serverDraft(world.waiting)) !== null, 'the draft saved');
  act(() => button(el, 'Send').click());
  await until(() => el.querySelector('textarea') === null, 'the Send');
  const reply = posted.filter((p) => p.path.endsWith('/reply')).at(-1)!;
  // The draft the words were saved as, by its updated_at: the server clears that draft only.
  expect(reply.body).toMatchObject({ words: 'Pagefind, thanks.' });
  expect(reply.body.clear_draft).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(await serverDraft(world.waiting)).toBeNull();
});

test.skipIf(!hasDom)('a Send pressed before the pause in typing, whose answer is slow, never brings the words back as a draft', async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  await until(() => [...el.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Reply'), 'the foot');
  act(() => button(el, 'Reply').click());
  await settle(5);
  // The reply's answer comes 800 ms late; Send goes well inside the 500 ms pause before the save.
  replyDelay = 800;
  type(el, 'Sent quickly.');
  act(() => button(el, 'Send').click());
  await until(() => el.querySelector('textarea') === null, 'the Send');
  const reply = posted.filter((p) => p.path.endsWith('/reply')).at(-1)!;
  expect(reply.body.words).toBe('Sent quickly.');
  // Past any save the typing scheduled: the server holds no draft, and the window shows none.
  await settle(200);
  expect(await serverDraft(world.waiting)).toBeNull();
  expect(el.querySelector('[data-draft-foot]')).toBeNull();
  // The save that ran before the Send is the only one; none came after it.
  const saves = posted.filter((p) => /\/draft$/.test(p.path));
  const replyAt = posted.indexOf(reply);
  expect(saves.every((p) => posted.indexOf(p) < replyAt)).toBe(true);
});

test.skipIf(!hasDom)('the foot\'s Send (box closed) carries the draft as it is now, and a newer draft from another window survives a Send of older words', async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  await until(() => [...el.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Reply'), 'the foot');
  act(() => button(el, 'Reply').click());
  await settle();
  type(el, 'Pagefind.');
  act(() => button(el, 'Cancel').click());
  await until(async () => (await serverDraft(world.waiting))?.body === 'Pagefind.', 'the draft saved on Cancel');
  // Another window types over the draft; no event reaches this one.
  const mine = (await serverDraft(world.waiting))!;
  const theirs = await loopback(`/api/inbox/threads/${world.waiting}/draft`, 'POST', JSON.stringify({ body: 'Orama, after all.', base: mine.updated_at }));
  expect(theirs.status).toBe(200);
  await until(() => el.querySelector('[data-draft-foot]') !== null, 'the foot says Draft');
  act(() => button(el, 'Send').click());
  await until(() => posted.some((p) => p.path.endsWith('/reply')), 'the Send');
  const reply = posted.filter((p) => p.path.endsWith('/reply')).at(-1)!;
  expect(reply.body.words).toBe('Orama, after all.');
  await until(async () => (await serverDraft(world.waiting)) === null, 'the draft it carried cleared');
});

test.skipIf(!hasDom)('an `event: drafts` for the open thread reads its draft again: Edit draft brings back the other window\'s words', async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  await until(() => [...el.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Reply'), 'the foot');
  act(() => button(el, 'Reply').click());
  await settle();
  type(el, 'First words.');
  act(() => button(el, 'Cancel').click());
  await until(async () => (await serverDraft(world.waiting))?.body === 'First words.', 'the draft saved on Cancel');
  const mine = (await serverDraft(world.waiting))!;
  await loopback(`/api/inbox/threads/${world.waiting}/draft`, 'POST', JSON.stringify({ body: 'Newer words.', base: mine.updated_at }));
  await act(async () => emit('drafts', { thread_id: world.waiting }));
  await settle();
  act(() => button(el, 'Edit draft').click());
  await settle();
  expect((el.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Newer words.');
});

test.skipIf(!hasDom)('the list says "Draft" ("Draft · Your reply", "Draft · 1 pick" in full); the Drafts row counts them and its page lists them above the messages', async () => {
  // Words typed in this world's waiting thread, through the window's route.
  const saved = await loopback(`/api/inbox/threads/${world.waiting}/draft`, 'POST', JSON.stringify({ body: 'Pagefind.', base: null }));
  expect(saved.status).toBe(200);
  const el = await renderApp('');
  // The full words (`data-count-words`); the row draws them on a wide row, "Draft" on a two-line or phone row
  // (approval "inbox-row-byline", option A).
  const label = (id: string) => el.querySelector(`[data-thread-id="${id}"] [data-draft-label]`)?.textContent?.replace(/\s+/g, ' ').trim();
  const full = (id: string) => el.querySelector(`[data-thread-id="${id}"] .ib-c`)?.getAttribute('data-count-words');
  const drawn = (id: string) => (el.querySelector(`.ib-row[data-thread-id="${id}"] .ib-cfull`) ? full(id) ?? undefined : 'Draft');
  await until(() => full(world.waiting) === 'Draft · Your reply', 'the waiting row');
  expect(label(world.waiting)).toBe(drawn(world.waiting));
  expect(full(world.picked)).toBe('Draft · 1 pick');
  expect(label(world.picked)).toBe(drawn(world.picked));
  const nav = el.querySelector('[data-drafts-nav]')!;
  const replies = (JSON.parse((await loopback('/api/inbox/drafts')).text) as { replies: { thread_id: string }[] }).replies;
  expect(replies.map((r) => r.thread_id)).toContain(world.waiting);
  expect(nav.textContent).toBe(`Drafts${replies.length}`);
  act(() => (nav as HTMLButtonElement).click());
  await until(() => el.querySelector(`[data-reply-draft="${world.waiting}"]`) !== null, 'the Drafts page');
  const row = el.querySelector(`[data-reply-draft="${world.waiting}"]`)!;
  expect(row.textContent).toContain('Pagefind.');
  expect(row.querySelector('[data-draft-label]')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Draft · Your reply');
  expect(el.querySelector('.ib-drafts-h')?.textContent).toBe('Replies not sent');
  act(() => (row.querySelector('.ib-draft-open') as HTMLButtonElement).click());
  await until(() => window.location.hash.includes(`thread=${world.waiting}`), 'the thread opened');
});

test.skipIf(!hasDom)('a pick not sent: the card says "Draft", its footer "in your draft", the foot "Draft · 1 pick"', async () => {
  const el = await renderApp(`#thread=${world.picked}`);
  await until(() => el.querySelector('[data-draft-foot]') !== null, 'the foot');
  expect(el.querySelector('[data-draft-foot]')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Draft, 1 pick');
  expect(el.textContent).toMatch(/Picked \d{1,2}:\d{2} [AP]M · in your draft/);
  expect(el.textContent).not.toContain('Not sent');
});

test.skipIf(!hasDom)('typing during a slow Send never brings back a draft holding the sent words: the box is read-only while it goes', async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  await until(() => [...el.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Reply'), 'the foot');
  act(() => button(el, 'Reply').click());
  await settle();
  type(el, 'First words.');
  await until(async () => (await serverDraft(world.waiting))?.body === 'First words.', 'the words saved');
  // The reply's answer is held 1.5 s; the person keeps typing meanwhile.
  replyDelay = 1500;
  act(() => button(el, 'Send').click());
  await until(() => posted.some((p) => p.path.endsWith('/reply')), 'the reply posted');
  expect((el.querySelector('textarea') as HTMLTextAreaElement).readOnly).toBe(true);
  type(el, 'First words. And more.');
  // The box keeps the words the Send carries.
  expect((el.querySelector('textarea') as HTMLTextAreaElement).value).toBe('First words.');
  await until(() => el.querySelector('textarea') === null, 'the Send');
  await settle(200);
  expect(await serverDraft(world.waiting)).toBeNull();
  // No save went after the reply.
  const reply = posted.findIndex((p) => p.path.endsWith('/reply'));
  expect(posted.slice(reply).some((p) => /\/draft$/.test(p.path))).toBe(false);
  // The next visit shows no draft.
  leave();
  const again = await renderApp(`#thread=${world.waiting}`);
  await until(() => [...again.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Reply'), 'the foot');
  await settle();
  expect(again.querySelector('textarea')).toBeNull();
  expect(again.querySelector('[data-draft-foot]')).toBeNull();
});

test.skipIf(!hasDom)('a Send that fails gives the thread back: the words are saved again', async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  await until(() => [...el.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Reply'), 'the foot');
  act(() => button(el, 'Reply').click());
  await settle();
  type(el, 'Kept after a failure.');
  await until(async () => (await serverDraft(world.waiting))?.body === 'Kept after a failure.', 'the words saved');
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'POST' && String(input).endsWith('/reply')) return new Response(JSON.stringify({ error: 'down' }), { status: 500 });
    return real(input, init);
  }) as typeof fetch;
  act(() => button(el, 'Send').click());
  await until(() => !(el.querySelector('textarea') as HTMLTextAreaElement).readOnly && el.textContent!.includes('down'), 'the failure');
  globalThis.fetch = real;
  type(el, 'Kept after a failure, edited.');
  await until(async () => (await serverDraft(world.waiting))?.body === 'Kept after a failure, edited.', 'saved again after the failure');
});

test.skipIf(!hasDom)('another window sent the words: this window\'s next save is refused, never re-creates the draft, and keeps its words as not saved', async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  await until(() => [...el.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Reply'), 'the foot');
  act(() => button(el, 'Reply').click());
  await settle();
  type(el, 'First words.');
  await until(async () => (await serverDraft(world.waiting))?.body === 'First words.', 'the words saved');
  // Window A sends those words (its Send clears the draft it saved).
  const mine = (await serverDraft(world.waiting))!;
  const sent = await loopback(`/api/inbox/messages/${world.waiting}/reply`, 'POST', JSON.stringify({ idempotency_key: 'other-window', words: 'First words.', clear_draft: mine.updated_at }));
  expect(sent.status).toBe(200);
  expect(await serverDraft(world.waiting)).toBeNull();
  // This window keeps typing: its save is refused, and it adopts the server's state.
  type(el, 'First words. And more.');
  await until(() => el.querySelector('[data-draft-conflict]') !== null, 'the conflict');
  expect(el.querySelector('[data-draft-conflict] .ib-draft-saved')?.textContent).toBe('Not saved: this reply was sent or discarded in another window.');
  await settle(200);
  expect(await serverDraft(world.waiting)).toBeNull();
  // More typing stays here, not saved.
  type(el, 'First words. And more, still.');
  await settle(200);
  expect(await serverDraft(world.waiting)).toBeNull();
  expect((el.querySelector('textarea') as HTMLTextAreaElement).value).toBe('First words. And more, still.');
  // Keep mine: the person's choice saves them.
  act(() => (el.querySelector('[data-draft-keep-mine]') as HTMLButtonElement).click());
  await until(async () => (await serverDraft(world.waiting))?.body === 'First words. And more, still.', 'kept on purpose');
  expect(el.querySelector('[data-draft-conflict]')).toBeNull();
});

/** Open the waiting thread's box with words saved there; answers the draft as the server holds it. */
async function openWithSaved(words: string) {
  const el = await renderApp(`#thread=${world.waiting}`);
  const opener = () => [...el.querySelectorAll('.ib-pfoot button')].find((b) => ['Reply', 'Edit draft'].includes(b.textContent?.replace(/\s+/g, ' ').trim() ?? '')) as HTMLButtonElement | undefined;
  await until(() => opener() !== undefined, 'the foot');
  act(() => opener()!.click());
  await settle();
  type(el, words);
  await until(async () => (await serverDraft(world.waiting))?.body === words, 'the words saved');
  await settle();
  return { el, saved: (await serverDraft(world.waiting))! };
}
const box = (el: HTMLElement) => el.querySelector('textarea') as HTMLTextAreaElement | null;
const liveText = (el: HTMLElement) => [...el.querySelectorAll('[aria-live]')].map((n) => n.textContent).join(' ');

test.skipIf(!hasDom)('event: drafts, sent elsewhere: a box with no edits closes, and the sent words never come back', async () => {
  const { el, saved } = await openWithSaved('First words.');
  // Another window (or the phone, then the computer's window) sends them and clears the draft.
  await loopback(`/api/inbox/messages/${world.waiting}/reply`, 'POST', JSON.stringify({ idempotency_key: 'elsewhere-1', words: 'First words.', clear_draft: saved.updated_at }));
  await act(async () => emit('drafts', { thread_id: world.waiting }));
  await until(() => box(el) === null, 'the box closed');
  expect(liveText(el)).toContain('This reply was sent or discarded in another window.');
  // Opening the box again and typing makes a new draft of new words only.
  act(() => button(el, 'Reply').click());
  await settle();
  expect(box(el)!.value).toBe('');
  await settle(200);
  expect(await serverDraft(world.waiting)).toBeNull();
});

const unloadAsks = () => {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};

test.skipIf(!hasDom)('event: drafts, sent elsewhere while this box has edits: the save is refused, the conflict shows, nothing comes back', async () => {
  const { el, saved } = await openWithSaved('First words.');
  // Nothing would be lost yet: a reload is not asked about.
  expect(unloadAsks()).toBe(false);
  type(el, 'First words. And more.');
  await loopback(`/api/inbox/messages/${world.waiting}/reply`, 'POST', JSON.stringify({ idempotency_key: 'elsewhere-2', words: 'First words.', clear_draft: saved.updated_at }));
  await act(async () => emit('drafts', { thread_id: world.waiting }));
  await until(() => el.querySelector('[data-draft-conflict]') !== null, 'the conflict');
  await settle(200);
  expect(await serverDraft(world.waiting)).toBeNull();
  expect(box(el)!.value).toBe('First words. And more.');
  // Announced in the thread's live region; the box names the line.
  expect(liveText(el)).toContain('Not saved: this reply was sent or discarded in another window.');
  const line = el.querySelector('[data-draft-conflict] .ib-draft-saved')!;
  expect(line.getAttribute('role')).toBeNull();
  expect(box(el)!.getAttribute('aria-describedby')).toContain(line.id);
  // The restart guard and a reload ask while those words are not saved.
  expect(unsentReply()).not.toBeNull();
  expect(unloadAsks()).toBe(true);
});

test.skipIf(!hasDom)('event: drafts, the other window typed: a box with no edits takes its words', async () => {
  const { el, saved } = await openWithSaved('Mine.');
  await loopback(`/api/inbox/threads/${world.waiting}/draft`, 'POST', JSON.stringify({ body: 'Theirs.', base: saved.updated_at }));
  await act(async () => emit('drafts', { thread_id: world.waiting }));
  await until(() => box(el)?.value === 'Theirs.', 'their words in the box');
  expect(el.querySelector('[data-draft-conflict]')).toBeNull();
  // Typing on from there saves over it, as an edit of the newest words.
  type(el, 'Theirs. And mine.');
  await until(async () => (await serverDraft(world.waiting))?.body === 'Theirs. And mine.', 'saved on top');
});

test.skipIf(!hasDom)('event: drafts, the other window typed while this box has edits: neither window\'s words are lost; Discard drops only mine', async () => {
  const { el, saved } = await openWithSaved('Mine.');
  type(el, 'Mine, and more.');
  await loopback(`/api/inbox/threads/${world.waiting}/draft`, 'POST', JSON.stringify({ body: 'Theirs.', base: saved.updated_at }));
  await act(async () => emit('drafts', { thread_id: world.waiting }));
  await until(() => el.querySelector('[data-draft-conflict]') !== null, 'the conflict');
  expect(el.querySelector('[data-draft-conflict] .ib-draft-saved')?.textContent).toBe('Not saved: this reply changed in another window.');
  await settle(200);
  expect((await serverDraft(world.waiting))?.body).toBe('Theirs.');
  expect(box(el)!.value).toBe('Mine, and more.');
  // Two choices only, and their hit areas apart (the gap is wider than both ::after reaches).
  const acts = el.querySelector('[data-draft-conflict] .ib-draft-acts')!;
  expect([...acts.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Keep mine', 'Discard mine']);
  act(() => (el.querySelector('[data-draft-conflict] [data-draft-discard]') as HTMLButtonElement).click());
  await settle();
  expect(box(el)!.value).toBe('Theirs.');
  expect(document.activeElement).toBe(box(el));
  expect((await serverDraft(world.waiting))?.body).toBe('Theirs.');
  expect(el.querySelector('[data-draft-conflict]')).toBeNull();
});

test.skipIf(!hasDom)('an empty box refused by a newer draft shows nothing and never deletes it', async () => {
  const { el, saved } = await openWithSaved('Mine.');
  await loopback(`/api/inbox/threads/${world.waiting}/draft`, 'POST', JSON.stringify({ body: 'Theirs.', base: saved.updated_at }));
  // This window empties its box (no event reached it): the delete is refused.
  type(el, '');
  await settle(200);
  expect(el.querySelector('[data-draft-conflict]')).toBeNull();
  expect((await serverDraft(world.waiting))?.body).toBe('Theirs.');
});

test.skipIf(!hasDom)('a Send after a conflict carries this window\'s words and then shows the other window\'s draft', async () => {
  const { el, saved } = await openWithSaved('Mine.');
  type(el, 'Mine, sent.');
  await loopback(`/api/inbox/threads/${world.waiting}/draft`, 'POST', JSON.stringify({ body: 'Theirs.', base: saved.updated_at }));
  await act(async () => emit('drafts', { thread_id: world.waiting }));
  await until(() => el.querySelector('[data-draft-conflict]') !== null, 'the conflict');
  act(() => button(el, 'Send').click());
  await until(() => box(el) === null, 'the Send');
  const reply = posted.filter((p) => p.path.endsWith('/reply')).at(-1)!;
  expect(reply.body.words).toBe('Mine, sent.');
  // No updated_at named (not the other window's draft's): the server clears only a draft holding these words.
  expect(reply.body.clear_draft).toBe('');
  expect((await serverDraft(world.waiting))?.body).toBe('Theirs.');
  await until(() => el.querySelector('[data-draft-foot]') !== null, 'the foot shows the other window\'s draft');
  act(() => button(el, 'Edit draft').click());
  await settle();
  expect(box(el)!.value).toBe('Theirs.');
});

/** An agent writing in the thread while the test runs (the DOM server's `send`): answers the new message's id. */
async function agentSend(body: string, replyTo: string): Promise<string> {
  const before = lines.length;
  (child!.stdin as import('bun').FileSink).write(`${JSON.stringify({ send: { project: world.project, session: 'ses_later', body, reply_to: replyTo } })}\n`);
  await (child!.stdin as import('bun').FileSink).flush();
  await until(() => lines.slice(before).some((l) => l.includes('"sent"')), 'the agent\'s message');
  return (JSON.parse(lines.slice(before).find((l) => l.includes('"sent"'))!) as { sent: string }).sent;
}

/** The reply's answer is lost after the Inbox took it. */
function loseReplyAnswers(real: typeof fetch) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const answer = await real(input, init);
    if ((init?.method ?? 'GET') === 'POST' && String(input).endsWith('/reply')) throw new TypeError('Failed to fetch');
    return answer;
  }) as typeof fetch;
}

const personReplies = async (startsWith: string) =>
  (JSON.parse((await loopback(`/api/inbox/threads/${world.waiting}`)).text) as { thread: { messages: { author: { kind: string }; body: string; reply_to: string | null }[] } }).thread.messages.filter(
    (m) => m.author.kind === 'person' && m.body.startsWith(startsWith),
  );

test.skipIf(!hasDom)('a Send whose answer is lost after it went is read back: the box closes, the reply is there once, no draft', async () => {
  const { el } = await openWithSaved('Went, answer lost.');
  const real = globalThis.fetch;
  loseReplyAnswers(real);
  act(() => button(el, 'Send').click());
  await until(() => box(el) === null, 'the box closed');
  globalThis.fetch = real;
  expect(el.textContent).not.toContain('Failed to fetch');
  expect(liveText(el)).toContain('Your reply went.');
  await settle(200);
  expect(await serverDraft(world.waiting)).toBeNull();
  expect(await personReplies('Went, answer lost.')).toHaveLength(1);
}, 30_000);

test.skipIf(!hasDom)('a Send carrying a comment whose answer is lost after it went: the box closes; the reply and its comment went once', async () => {
  const made = await loopback(
    `/api/inbox/messages/${world.waiting}/annotations`,
    'POST',
    JSON.stringify({ annotation: { id: 'ann-lost-answer', blockId: 'block-1', startOffset: 0, endOffset: 13, type: 'COMMENT', text: 'Pagefind, please.', originalText: 'The docs site', createdA: 1 } }),
  );
  expect(made.status).toBe(200);
  const { el } = await openWithSaved('Went with a comment.');
  const real = globalThis.fetch;
  loseReplyAnswers(real);
  act(() => button(el, 'Send').click());
  await until(() => box(el) === null, 'the box closed');
  globalThis.fetch = real;
  await settle();
  const replies = posted.filter((p) => p.path.endsWith('/reply'));
  expect(replies).toHaveLength(1);
  expect(replies[0]!.body.annotation_ids).toEqual(['ann-lost-answer']);
  expect(await personReplies('Went with a comment.')).toHaveLength(1);
  // No "Draft · 1 comment": it went with the reply.
  expect(el.querySelector('[data-draft-foot]')).toBeNull();
}, 30_000);

test.skipIf(!hasDom)('after a lost answer, the same words sent later to a new question go to it as a new reply, never the old request', async () => {
  const { el } = await openWithSaved('Yes.');
  const real = globalThis.fetch;
  loseReplyAnswers(real);
  act(() => button(el, 'Send').click());
  await until(() => box(el) === null, 'the box closed');
  globalThis.fetch = real;
  const first = posted.filter((p) => p.path.endsWith('/reply')).at(-1)!;
  // The agent asks something new in the thread; the person answers "Yes." again.
  const asked = await agentSend(['One more:', '', ':::question', 'Ship it today?', '', '- [ ] Yes', '- [ ] No', ':::'].join('\n'), world.waiting);
  await act(async () => emit('record', { seq: 1 }));
  leave();
  const again = await renderApp(`#thread=${world.waiting}`);
  await until(() => again.textContent!.includes('Ship it today?'), 'the new question');
  const opener = () => [...again.querySelectorAll('.ib-pfoot button')].find((b) => ['Reply', 'Edit draft'].includes(b.textContent?.replace(/\s+/g, ' ').trim() ?? '')) as HTMLButtonElement;
  act(() => opener().click());
  await settle();
  type(again, 'Yes.');
  act(() => button(again, 'Send').click());
  await until(() => box(again) === null, 'the second Send');
  const second = posted.filter((p) => p.path.endsWith('/reply')).at(-1)!;
  expect(second.path).toContain(asked);
  expect(second.body.idempotency_key).not.toBe(first.body.idempotency_key);
  expect(await personReplies('Yes.')).toHaveLength(2);
}, 30_000);

test.skipIf(!hasDom)('a Send the Inbox never got, then a new comment: the next Send of the same words carries the comment', async () => {
  const { el } = await openWithSaved('Words, then a comment.');
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (((init?.method ?? 'GET') === 'POST' && path.endsWith('/reply')) || /\/api\/inbox\/threads\/[^/]+$/.test(path)) throw new TypeError('Failed to fetch');
    return real(input, init);
  }) as typeof fetch;
  act(() => button(el, 'Send').click());
  await until(() => !!el.textContent?.includes('The reply may not have gone.'), 'the error');
  globalThis.fetch = real;
  // A comment made after the lost Send (the thread read again: leave and come back).
  await loopback(
    `/api/inbox/messages/${world.waiting}/annotations`,
    'POST',
    JSON.stringify({ annotation: { id: 'ann-after', blockId: 'block-1', startOffset: 0, endOffset: 13, type: 'COMMENT', text: 'Also this.', originalText: 'The docs site', createdA: 1 } }),
  );
  leave();
  const again = await renderApp(`#thread=${world.waiting}`);
  await until(() => box(again)?.value === 'Words, then a comment.', 'the words back');
  act(() => button(again, 'Send').click());
  await until(() => box(again) === null, 'the Send');
  const reply = posted.filter((p) => p.path.endsWith('/reply')).at(-1)!;
  expect(reply.body.annotation_ids).toEqual(['ann-after']);
  expect(reply.body.words).toBe('Words, then a comment.');
  expect(await personReplies('Words, then a comment.')).toHaveLength(1);
}, 30_000);

test.skipIf(!hasDom)('a Send the Inbox took while its thread could not be read: the next Send finds it and sends nothing again', async () => {
  const { el } = await openWithSaved('Landed while unread.');
  const real = globalThis.fetch;
  // The reply reaches the Inbox but its answer is lost, and the thread read fails too.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (/\/api\/inbox\/threads\/[^/]+$/.test(path)) throw new TypeError('Failed to fetch');
    const answer = await real(input, init);
    if ((init?.method ?? 'GET') === 'POST' && path.endsWith('/reply')) throw new TypeError('Failed to fetch');
    return answer;
  }) as typeof fetch;
  act(() => button(el, 'Send').click());
  await until(() => !!el.textContent?.includes('The reply may not have gone.'), 'the error');
  globalThis.fetch = real;
  const before = posted.filter((p) => p.path.endsWith('/reply')).length;
  act(() => button(el, 'Send').click());
  await until(() => box(el) === null, 'the box closed');
  expect(posted.filter((p) => p.path.endsWith('/reply')).length).toBe(before);
  expect(await personReplies('Landed while unread.')).toHaveLength(1);
  expect(await serverDraft(world.waiting)).toBeNull();
}, 30_000);

test.skipIf(!hasDom)('a Send while the Inbox is down: the draft stays, and the retry clears it with the Send (no draft of the sent words)', async () => {
  const { el, saved } = await openWithSaved('Sent while it was down.');
  const real = globalThis.fetch;
  // The reply and the thread read both fail before reaching the Inbox.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (((init?.method ?? 'GET') === 'POST' && path.endsWith('/reply')) || /\/api\/inbox\/threads\/[^/]+$/.test(path)) throw new TypeError('Failed to fetch');
    return real(input, init);
  }) as typeof fetch;
  act(() => button(el, 'Send').click());
  await until(() => !!el.textContent?.includes('The reply may not have gone.'), 'the error');
  globalThis.fetch = real;
  // Nothing reached the Inbox: the draft is still there.
  expect((await serverDraft(world.waiting))?.updated_at).toBe(saved.updated_at);
  act(() => button(el, 'Send').click());
  await until(() => box(el) === null, 'the retry');
  const reply = posted.filter((p) => p.path.endsWith('/reply')).at(-1)!;
  expect(reply.body.clear_draft).toBe(saved.updated_at);
  await settle(200);
  expect(await serverDraft(world.waiting)).toBeNull();
}, 30_000);

test.skipIf(!hasDom)('words a conflict left unsaved come back when the thread is left and opened again', async () => {
  const { el, saved } = await openWithSaved('Mine.');
  type(el, 'Mine, kept through a switch.');
  await loopback(`/api/inbox/threads/${world.waiting}/draft`, 'POST', JSON.stringify({ body: 'Theirs.', base: saved.updated_at }));
  await act(async () => emit('drafts', { thread_id: world.waiting }));
  await until(() => el.querySelector('[data-draft-conflict]') !== null, 'the conflict');
  // Leave the thread (the pane goes), then open it again.
  leave();
  expect(unsentReply()).not.toBeNull();
  const again = await renderApp(`#thread=${world.waiting}`);
  await until(() => box(again)?.value === 'Mine, kept through a switch.', 'the unsaved words back');
  await until(() => again.querySelector('[data-draft-conflict]') !== null, 'the conflict line back');
  expect((await serverDraft(world.waiting))?.body).toBe('Theirs.');
  // Keep mine still works from here.
  act(() => (again.querySelector('[data-draft-keep-mine]') as HTMLButtonElement).click());
  await until(async () => (await serverDraft(world.waiting))?.body === 'Mine, kept through a switch.', 'kept');
  // Nothing of this thread is left unsaved: the line is gone (other threads' unsaved words are kept as they are).
  expect(again.querySelector('[data-draft-conflict]')).toBeNull();
}, 30_000);

/** The reply reaches the Inbox but its answer is lost, and thread reads fail (the Inbox stops answering). */
function landUnread(real: typeof fetch) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (/\/api\/inbox\/threads\/[^/]+$/.test(path)) throw new TypeError('Failed to fetch');
    const answer = await real(input, init);
    if ((init?.method ?? 'GET') === 'POST' && path.endsWith('/reply')) throw new TypeError('Failed to fetch');
    return answer;
  }) as typeof fetch;
}

test.skipIf(!hasDom)('an unconfirmed Send is forgotten when the person leaves: the same words sent later to a new question go to it', async () => {
  const { el } = await openWithSaved('Yes.');
  const real = globalThis.fetch;
  landUnread(real);
  act(() => button(el, 'Send').click());
  await until(() => !!el.textContent?.includes('The reply may not have gone.'), 'the error');
  globalThis.fetch = real;
  const first = posted.filter((p) => p.path.endsWith('/reply')).at(-1)!;
  // The Inbox recovers; the agent asks something new; the person leaves and comes back.
  const asked = await agentSend(['One more:', '', ':::question', 'Ship it today?', '', '- [ ] Yes', '- [ ] No', ':::'].join('\n'), world.waiting);
  leave();
  const again = await renderApp(`#thread=${world.waiting}`);
  await until(() => again.textContent!.includes('Ship it today?'), 'the new question');
  const opener = () => [...again.querySelectorAll('.ib-pfoot button')].find((b) => ['Reply', 'Edit draft'].includes(b.textContent?.replace(/\s+/g, ' ').trim() ?? '')) as HTMLButtonElement;
  act(() => opener().click());
  await settle();
  type(again, 'Yes.');
  act(() => button(again, 'Send').click());
  await until(() => box(again) === null, 'the Send');
  const second = posted.filter((p) => p.path.endsWith('/reply')).at(-1)!;
  expect(second).not.toBe(first);
  expect(second.path).toContain(asked);
  expect(await personReplies('Yes.')).toHaveLength(2);
}, 30_000);

test.skipIf(!hasDom)('an unconfirmed Send that a thread read shows landed is finished while the box still holds its words', async () => {
  const { el } = await openWithSaved('Landed, seen on a read.');
  const real = globalThis.fetch;
  landUnread(real);
  act(() => button(el, 'Send').click());
  await until(() => !!el.textContent?.includes('The reply may not have gone.'), 'the error');
  globalThis.fetch = real;
  // The Inbox answers again: the stream's next record reads the thread, and the reply is there.
  await act(async () => emit('record', { seq: 1 }));
  await until(() => box(el) === null, 'the box closed');
  await until(() => liveText(el).includes('Your reply went.'), 'said in the live region');
  expect(await personReplies('Landed, seen on a read.')).toHaveLength(1);
}, 30_000);

test.skipIf(!hasDom)('an unconfirmed Send found by the next Send: a pick made since is named as not sent, and the next Send sends it', async () => {
  const { el } = await openWithSaved('Words first.');
  const real = globalThis.fetch;
  landUnread(real);
  act(() => button(el, 'Send').click());
  await until(() => !!el.textContent?.includes('The reply may not have gone.'), 'the error');
  globalThis.fetch = real;
  // A pick, made after the lost Send.
  const choice = [...el.querySelectorAll('fieldset[data-question-key] label')].find((l) => l.textContent?.includes('Pagefind')) as HTMLElement;
  act(() => choice.click());
  await until(() => el.textContent!.includes('in your draft'), 'the pick saved');
  const before = posted.filter((p) => p.path.endsWith('/reply')).length;
  act(() => button(el, 'Send').click());
  await until(() => !!el.textContent?.includes('Not sent yet: 1 pick.'), 'the pick named');
  expect(posted.filter((p) => p.path.endsWith('/reply')).length).toBe(before);
  expect(liveText(el)).toContain('Your reply went. Not sent yet: 1 pick.');
  expect(await personReplies('Words first.')).toHaveLength(1);
  // Send sends the pick as an ordinary reply.
  act(() => button(el, 'Send').click());
  await until(() => posted.filter((p) => p.path.endsWith('/reply')).length === before + 1, 'the pick sent');
  const pickReply = posted.filter((p) => p.path.endsWith('/reply')).at(-1)!;
  expect((pickReply.body.questions as unknown[]).length).toBe(1);
}, 30_000);

test.skipIf(!hasDom)('words edited after a lost Send: an honest line replaces the error, and the edits save with no "another window" conflict', async () => {
  const { el } = await openWithSaved('First take.');
  const real = globalThis.fetch;
  landUnread(real);
  act(() => button(el, 'Send').click());
  await until(() => !!el.textContent?.includes('The reply may not have gone.'), 'the error');
  globalThis.fetch = real;
  type(el, 'First take, and a second thought.');
  await until(() => !!el.textContent?.includes('Your earlier reply went; Send sends your edited words as another reply.'), 'the honest line');
  expect(el.textContent).not.toContain('The reply may not have gone.');
  await until(async () => (await serverDraft(world.waiting))?.body === 'First take, and a second thought.', 'the edits saved as the draft');
  expect(el.querySelector('[data-draft-conflict]')).toBeNull();
  expect(el.textContent).not.toContain('another window');
}, 30_000);

test.skipIf(!hasDom)('a thread read finds the lost Send landed: what was added since is said in the live region', async () => {
  const { el } = await openWithSaved('Then a pick.');
  const real = globalThis.fetch;
  landUnread(real);
  act(() => button(el, 'Send').click());
  await until(() => !!el.textContent?.includes('The reply may not have gone.'), 'the error');
  globalThis.fetch = real;
  const choice = [...el.querySelectorAll('fieldset[data-question-key] label')].find((l) => l.textContent?.includes('Pagefind')) as HTMLElement;
  act(() => choice.click());
  await until(() => el.textContent!.includes('in your draft'), 'the pick saved');
  await act(async () => emit('record', { seq: 1 }));
  await until(() => box(el) === null, 'the box closed');
  await until(() => liveText(el).includes('Your reply went. Not sent yet: 1 pick.'), 'the pick said');
}, 30_000);

test.skipIf(!hasDom)('a lost Send then Cancel: the reply is read back, and no stale "Draft · Your reply" stays in the foot', async () => {
  const { el } = await openWithSaved('Cancelled after.');
  const real = globalThis.fetch;
  landUnread(real);
  act(() => button(el, 'Send').click());
  await until(() => !!el.textContent?.includes('The reply may not have gone.'), 'the error');
  globalThis.fetch = real;
  act(() => button(el, 'Cancel').click());
  await until(() => box(el) === null, 'the box closed');
  await until(() => el.querySelector('[data-draft-foot]') === null, 'no stale Draft foot');
  await until(() => liveText(el).includes('Your reply went.'), 'said');
  expect(await serverDraft(world.waiting)).toBeNull();
}, 30_000);

/** No `/draft` save went after the reply (a save after it would bring the sent words back as a draft). */
const noSaveAfterReply = () => {
  const reply = posted.findIndex((p) => p.path.endsWith('/reply'));
  return reply >= 0 && !posted.slice(reply).some((p) => /\/draft$/.test(p.path));
};

test.skipIf(!hasDom)('a Send whose own save lands without its answer leaves no draft of the sent words', async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  await until(() => [...el.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Reply'), 'the foot');
  act(() => button(el, 'Reply').click());
  await settle(5);
  const real = globalThis.fetch;
  let lost = 0;
  // The save the Send flushes reaches the Inbox; its answer never reaches the window.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const answer = await real(input, init);
    if (lost === 0 && (init?.method ?? 'GET') === 'POST' && /\/draft$/.test(String(input)) && String(init?.body).includes('Dictated, sent at once.')) {
      lost += 1;
      throw new TypeError('Load failed');
    }
    return answer;
  }) as typeof fetch;
  try {
    // Send inside the 500 ms pause: the Send's claim saves the words.
    type(el, 'Dictated, sent at once.');
    act(() => button(el, 'Send').click());
    await until(() => box(el) === null, 'the Send');
  } finally {
    globalThis.fetch = real;
  }
  expect(lost).toBe(1);
  // The `drafts` frames for that save and the Send reach the window late.
  await act(async () => emit('drafts', { thread_id: world.waiting }));
  await settle(100);
  expect(await serverDraft(world.waiting)).toBeNull();
  expect(el.querySelector('[data-draft-foot]')).toBeNull();
  expect(noSaveAfterReply()).toBe(true);
});

test.skipIf(!hasDom)('a drafts read answered after the Send never writes the sent words back as a draft', async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  await until(() => [...el.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Reply'), 'the foot');
  act(() => button(el, 'Reply').click());
  await settle(5);
  const real = globalThis.fetch;
  let replyIssued = false;
  let held = 0;
  let releaseReads!: () => void;
  const replied = new Promise<void>((done) => (releaseReads = done));
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    if (replyIssued && method === 'GET' && /\/draft$/.test(path)) {
      // Served now, before the reply clears the draft; answered only after the reply's answer.
      held += 1;
      const answer = await real(input, init);
      await replied;
      return answer;
    }
    if (method === 'POST' && path.endsWith('/reply')) {
      replyIssued = true;
      await new Promise((r) => setTimeout(r, 300));
      const answer = await real(input, init);
      setTimeout(releaseReads, 100);
      return answer;
    }
    return real(input, init);
  }) as typeof fetch;
  try {
    type(el, 'Sent while a read was out.');
    act(() => button(el, 'Send').click());
    await until(() => replyIssued, 'the reply going');
    // The window's own `drafts` frame (its save just landed) while the Send is in flight.
    await act(async () => emit('drafts', { thread_id: world.waiting }));
    await until(() => box(el) === null, 'the Send');
    await settle(100);
  } finally {
    globalThis.fetch = real;
  }
  expect(held).toBeGreaterThan(0);
  expect(await serverDraft(world.waiting)).toBeNull();
  expect(noSaveAfterReply()).toBe(true);
  expect(el.querySelector('[data-draft-foot]')).toBeNull();
});

test.skipIf(!hasDom)('pagehide then pageshow (back/forward cache) inside the pause in typing, then Send: no draft of the sent words', async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  await until(() => [...el.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Reply'), 'the foot');
  act(() => button(el, 'Reply').click());
  await settle(5);
  const transition = (name: 'pagehide' | 'pageshow') => Object.defineProperty(new Event(name), 'persisted', { value: true });
  type(el, 'Kept alive, then sent.');
  // The page goes inside the 500 ms pause: the words go as the keepalive save, whose answer is never read.
  act(() => {
    window.dispatchEvent(transition('pagehide'));
  });
  await until(async () => (await serverDraft(world.waiting))?.body === 'Kept alive, then sent.', 'the keepalive save');
  await act(async () => {
    window.dispatchEvent(transition('pageshow'));
  });
  await settle();
  act(() => button(el, 'Send').click());
  await until(() => box(el) === null, 'the Send');
  await settle(100);
  expect(await serverDraft(world.waiting)).toBeNull();
  expect(el.querySelector('[data-draft-foot]')).toBeNull();
  expect(noSaveAfterReply()).toBe(true);
});

test.skipIf(!hasDom)('after the keepalive save and pageshow, typing on saves over it: never a conflict with this window\'s own words', async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  await until(() => [...el.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Reply'), 'the foot');
  act(() => button(el, 'Reply').click());
  await settle(5);
  const transition = (name: 'pagehide' | 'pageshow') => Object.defineProperty(new Event(name), 'persisted', { value: true });
  type(el, 'Kept alive.');
  act(() => {
    window.dispatchEvent(transition('pagehide'));
  });
  await until(async () => (await serverDraft(world.waiting))?.body === 'Kept alive.', 'the keepalive save');
  await act(async () => {
    window.dispatchEvent(transition('pageshow'));
  });
  await settle();
  type(el, 'Kept alive. And typed on.');
  await until(async () => (await serverDraft(world.waiting))?.body === 'Kept alive. And typed on.', 'saved over the keepalive');
  expect(el.querySelector('[data-draft-conflict]')).toBeNull();
});

test.skipIf(!hasDom)('after a Send, another window\'s draft of the same words is never saved over: the conflict shows', async () => {
  const { el } = await openWithSaved('ok');
  act(() => button(el, 'Send').click());
  await until(() => box(el) === null, 'the Send');
  await settle();
  act(() => button(el, 'Reply').click());
  await settle();
  // Another window drafts the same words (no event reaches this one).
  const theirs = await loopback(`/api/inbox/threads/${world.waiting}/draft`, 'POST', JSON.stringify({ body: 'ok', base: null }));
  expect(theirs.status).toBe(200);
  type(el, 'no, wait');
  await until(() => el.querySelector('[data-draft-conflict]') !== null, 'the conflict');
  expect(el.querySelector('[data-draft-conflict] .ib-draft-saved')?.textContent).toBe('Not saved: this reply changed in another window.');
  await settle(200);
  expect((await serverDraft(world.waiting))?.body).toBe('ok');
});

test.skipIf(!hasDom)('a Send whose own save lands without its answer, and whose read back fails too, leaves no draft of the sent words', async () => {
  const el = await renderApp(`#thread=${world.waiting}`);
  await until(() => [...el.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Reply'), 'the foot');
  act(() => button(el, 'Reply').click());
  await settle(5);
  const real = globalThis.fetch;
  let lost = 0;
  let unread = 0;
  // The save the Send flushes reaches the Inbox without its answer; the read back that follows fails too.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const draftPath = /\/draft$/.test(String(input));
    if (lost === 1 && unread === 0 && method === 'GET' && draftPath) {
      unread += 1;
      throw new TypeError('Load failed');
    }
    const answer = await real(input, init);
    if (lost === 0 && method === 'POST' && draftPath && String(init?.body).includes('Unread, sent at once.')) {
      lost += 1;
      throw new TypeError('Load failed');
    }
    return answer;
  }) as typeof fetch;
  try {
    type(el, 'Unread, sent at once.');
    act(() => button(el, 'Send').click());
    await until(() => box(el) === null, 'the Send');
  } finally {
    globalThis.fetch = real;
  }
  expect([lost, unread]).toEqual([1, 1]);
  await act(async () => emit('drafts', { thread_id: world.waiting }));
  await settle(100);
  // The window knew no updated_at: the Send's clear_draft ('') and its words cleared the draft.
  expect(await serverDraft(world.waiting)).toBeNull();
  expect(el.querySelector('[data-draft-foot]')).toBeNull();
  expect(noSaveAfterReply()).toBe(true);
});
