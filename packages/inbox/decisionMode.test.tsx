/**
 * Decision mode (experimental; approval "inbox-decision-mode", the Queue
 * direction), as the window draws it: the whole window (InboxApp) over a REAL
 * Inbox server in a temp data dir (its own process,
 * tests/helpers/inbox-dom-server.ts in its `decisions` mode, which turns the
 * feature on in the scratch config.json and seeds Claude Code asking two
 * questions, one Stopped, and Codex asking one). What is proved: the ways in
 * (the sidebar's "Decide N", the list header's button) and that nothing of it
 * renders with the gate off; walking the queue (a pick saves through the
 * picks route at once and the next card shows); the per-agent Send after the
 * Hold (one reply for the session, in its thread); Undo and Previous; Later;
 * a question the agent replaces while it is on screen; closing with an agent
 * half answered.
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
import type { InboxDecisionsModel, InboxQuestion, InboxThread } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { InboxApp } = (hasDom ? await import('./App') : {}) as typeof import('./App');

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');

type World = { project: string; root: string; decide: { a: string; b: string; sessionA: string; sessionB: string } };
let child: ReturnType<typeof Bun.spawn> | null = null;
let childOut: ReadableStreamDefaultReader<Uint8Array> | null = null;
let port = 0;
let worlds: World[] = [];
let all: World[] = [];
let world: World = { project: '', root: '', decide: { a: '', b: '', sessionA: '', sessionB: '' } };
let dir: string | null = null;
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedEventSource: unknown;
let posted: { path: string; body: Record<string, unknown> }[] = [];
/** A test may answer a request itself (a failed reply, a refused pick); null passes it to the Inbox. */
let intercept:
  | ((path: string, method: string) => { status: number; body: Record<string, unknown> } | null | Promise<{ status: number; body: Record<string, unknown> } | null>)
  | null = null;
/** The window's event stream, fired by hand: `poke(json)` is one record frame. */
let poke: ((data: string) => void) | null = null;

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
const api = async <T,>(path: string): Promise<T> => JSON.parse((await loopback(path)).text) as T;
const apiPost = (path: string, body: Record<string, unknown>) => loopback(path, 'POST', JSON.stringify(body));

async function readLine(): Promise<string> {
  let line = '';
  while (!line.includes('\n')) {
    const { value, done } = await childOut!.read();
    if (done) throw new Error('the Inbox stopped');
    line += new TextDecoder().decode(value);
  }
  return line.trim();
}

/** An agent writing while the test runs (the server's stdin). */
async function agentSends(send: Record<string, unknown>): Promise<string> {
  (child!.stdin as { write: (s: string) => void; flush?: () => void }).write(`${JSON.stringify({ send })}\n`);
  (child!.stdin as { flush?: () => void }).flush?.();
  return (JSON.parse(await readLine()) as { sent: string }).sent;
}

/** One seeded world per test (and one to spare): raise it with each test added. */
const TESTS = 28;

beforeAll(async () => {
  if (!hasDom) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-decide-dom-')));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(dir, 'bin', 'tailscale'), 0o755);
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), String(TESTS), 'decisions'], {
    env: { ...process.env, INBOX_DOM_SET_ASIDE_MS: '400', DOM_TESTS: '0', PLANNOTATOR_DATA_DIR: join(dir, 'data'), PLANNOTATOR_EXPERIMENTAL: '', HOME: dir, PATH: `${join(dir, 'bin')}:${process.env.PATH}` },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
  });
  childOut = (child.stdout as ReadableStream<Uint8Array>).getReader();
  const started = JSON.parse(await readLine()) as { port: number; worlds: World[] };
  port = started.port;
  worlds = started.worlds;
  all = [...worlds];
});

afterAll(async () => {
  if (!hasDom) return;
  child?.kill();
  await child?.exited;
  child = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

beforeEach(async () => {
  if (!hasDom) return;
  world = worlds.shift()!;
  // Only this test's decisions wait: the other worlds' threads are archived.
  for (const other of all) {
    if (other === world) continue;
    for (const id of [other.decide.a, other.decide.b]) await apiPost(`/api/inbox/messages/${id}/resolve`, { resolved: true });
  }
  await apiPost(`/api/inbox/messages/${world.decide.a}/resolve`, { resolved: false });
  await apiPost(`/api/inbox/messages/${world.decide.b}/resolve`, { resolved: false });
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? String(init.body) : undefined;
    if (method === 'POST') posted.push({ path, body: body ? JSON.parse(body) : {} });
    const forced = await intercept?.(path, method);
    if (forced) return new Response(JSON.stringify(forced.body), { status: forced.status, headers: { 'Content-Type': 'application/json' } });
    const answer = await loopback(path, method, body);
    return new Response(answer.text, { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  savedEventSource = (globalThis as Record<string, unknown>).EventSource;
  (globalThis as Record<string, unknown>).EventSource = class {
    addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
      if (type === 'record') poke = (data) => listener({ data } as MessageEvent<string>);
    }
    close() {}
  };
  posted = [];
  intercept = null;
  window.location.hash = '';
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  poke = null;
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
  for (let i = 0; i < 120; i++) {
    if (await check()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function renderApp(hash = '') {
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

const dialog = () => document.querySelector('[data-decision-mode]') as HTMLDialogElement | null;
const prompt = () => dialog()?.querySelector('[data-decision-prompt]')?.textContent?.trim() ?? null;

/** A click on a choice, as a pointer makes it (a press, then the click). */
function choose(label: string) {
  const choice = [...dialog()!.querySelectorAll('.ib-dm-choice')].find((c) => c.querySelector('.ib-dm-chl')?.textContent?.trim() === label) as HTMLElement;
  if (!choice) throw new Error(`no choice ${label}`);
  act(() => {
    choice.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    (choice.querySelector('input') as HTMLInputElement).click();
  });
}

async function questionsOf(messageId: string, threadId = messageId): Promise<InboxQuestion[]> {
  const model = await api<{ thread: InboxThread }>(`/api/inbox/threads/${threadId}`);
  return model.thread.messages.find((m) => m.id === messageId)?.questions ?? [];
}

async function openDecide(el: HTMLElement) {
  await until(() => el.querySelector('[data-decide-nav]') !== null, 'the Decide row');
  act(() => (el.querySelector('[data-decide-nav]') as HTMLButtonElement).click());
  await until(() => prompt() !== null, 'the first card');
}

test.skipIf(!hasDom)('the ways in show from two decisions; with the gate off nothing of decision mode renders and the route is gone', async () => {
  const el = await renderApp();
  await until(() => el.querySelector('[data-decide-nav]') !== null, 'the Decide row');
  expect(el.querySelector('[data-decide-nav]')!.textContent).toContain('Decide3');
  expect(el.querySelector('[data-decide-head]')!.textContent).toBe('Decide 3');
  act(() => root?.unmount());
  host?.remove();
  // Off: Settings' switch, then a fresh window.
  expect((await apiPost('/api/inbox/settings', { experimental: { decision_mode: false } })).status).toBe(200);
  try {
    expect((await loopback('/api/inbox/decisions')).status).toBe(404);
    const off = await renderApp();
    await until(() => off.querySelector('[data-inbox-nav]') !== null, 'the sidebar');
    await settle();
    expect(off.querySelector('[data-decide-nav]')).toBeNull();
    expect(off.querySelector('[data-decide-head]')).toBeNull();
    expect(document.querySelector('[data-decision-mode]')).toBeNull();
    // Settings → General shows the switch, off.
    act(() => root?.unmount());
    host?.remove();
    const settings = await renderApp('#settings/general');
    await until(() => settings.querySelector('[data-settings-experimental]') !== null, 'the Experimental group');
    const sw = settings.querySelector('[data-settings-experimental] [role="switch"]') as HTMLButtonElement;
    expect(sw.getAttribute('aria-checked')).toBe('false');
    act(() => sw.click());
    await until(async () => (await loopback('/api/inbox/decisions')).status === 200, 'the switch to turn it on');
    expect(posted.some((p) => p.path === '/api/inbox/settings' && (p.body.experimental as { decision_mode?: boolean })?.decision_mode === true)).toBe(true);
  } finally {
    await apiPost('/api/inbox/settings', { experimental: { decision_mode: true } });
  }
}, 30_000);

test.skipIf(!hasDom)('walks the queue: Stopped first, a pick saves at once, the next card shows; the session sends one reply after the Hold', async () => {
  const el = await renderApp();
  await openDecide(el);
  expect(dialog()!.querySelector('[data-decision-head]')!.textContent).toContain('1 of 3 · 2 agents waiting');
  expect(prompt()).toBe('Which way should the worker go on a Stripe 409?');
  expect(dialog()!.querySelector('[data-decision-stopped]')!.textContent).toContain('the refund worker cannot ship without this.');
  choose('Retry with the same key');
  await until(async () => (await questionsOf(world.decide.a))[0]?.state === 'picked', 'the pick saved');
  expect((await questionsOf(world.decide.a))[0]!.answer?.selected).toEqual(['Retry with the same key']);
  await until(() => prompt() === 'Page on-call after 5 tries?', 'the second card');
  expect(dialog()!.querySelector('[data-decision-live]')!.textContent).toContain('Answered: Retry with the same key. 2 left.');
  choose('Yes, page on-call');
  // Claude Code's last decision here is handled: its chip holds the reply for 5 s.
  await until(() => dialog()!.querySelector('[data-decision-hold]') !== null, 'the Hold');
  // The countdown starts at 5, never more (it read "10 s" for a frame from an old clock).
  expect(dialog()!.querySelector('[data-decision-hold]')!.textContent).toMatch(/Sending in 5 s · Hold/);
  act(() => button(dialog()!.querySelector('[data-decision-hold]')!, 'Hold').click());
  await until(() => dialog()!.querySelector('[data-decision-held]') !== null, 'Held');
  expect(posted.some((p) => p.path.endsWith('/reply'))).toBe(false);
  expect((await questionsOf(world.decide.a)).map((q) => q.state)).toEqual(['picked', 'picked']);
  act(() => button(dialog()!.querySelector('[data-decision-held]')!, 'Send').click());
  await until(async () => (await questionsOf(world.decide.a)).every((q) => q.state === 'sent'), 'the reply');
  // One reply for the session in its thread, carrying both answers; Codex's question is untouched.
  const replies = posted.filter((p) => p.path.endsWith('/reply'));
  expect(replies).toHaveLength(1);
  expect(replies[0]!.path).toBe(`/api/inbox/messages/${world.decide.a}/reply`);
  expect((replies[0]!.body.questions as unknown[]).length).toBe(2);
  expect(replies[0]!.body.words).toBe('');
  expect((await questionsOf(world.decide.b))[0]!.state).toBe('open');
  await until(() => prompt() === 'Ship the new flag off by default?', "Codex's card");
}, 30_000);

test.skipIf(!hasDom)('Undo puts the last pick back and returns to its card; Previous goes back a card', async () => {
  const el = await renderApp();
  await openDecide(el);
  choose('Fail to the dead-letter queue');
  await until(() => prompt() === 'Page on-call after 5 tries?', 'the second card');
  await until(async () => (await questionsOf(world.decide.a))[0]?.state === 'picked', 'the pick saved');
  act(() => (dialog()!.querySelector('[data-decision-undo]') as HTMLButtonElement).click());
  await until(() => prompt() === 'Which way should the worker go on a Stripe 409?', 'back to the first card');
  await until(async () => (await questionsOf(world.decide.a))[0]?.state === 'open', 'the pick taken back');
  // Previous: from the second card back to the first.
  choose('Retry with the same key');
  await until(() => prompt() === 'Page on-call after 5 tries?', 'the second card');
  const prev = dialog()!.querySelector('[data-decision-previous]') as HTMLButtonElement;
  expect(prev.disabled).toBe(false);
  act(() => prev.click());
  await settle();
  expect(prompt()).toBe('Which way should the worker go on a Stripe 409?');
  // The saved pick shows on the card it was made on.
  expect(dialog()!.querySelector('.ib-dm-choice[data-saved] .ib-dm-chl')?.textContent?.trim()).toBe('Retry with the same key');
}, 30_000);

test.skipIf(!hasDom)('Later puts a decision at the end: the others first, then it comes back; its session does not send meanwhile', async () => {
  const el = await renderApp();
  await openDecide(el);
  act(() => (dialog()!.querySelector('[data-decision-later]') as HTMLButtonElement).click());
  await until(() => prompt() === 'Page on-call after 5 tries?', 'the next card');
  choose('No, a daily digest');
  await until(() => prompt() === 'Ship the new flag off by default?', "Codex's card");
  // Claude Code still has a decision put off: no Hold for it.
  const chipA = dialog()!.querySelector(`[data-decision-chip="s:claude-code:${world.decide.sessionA}"]`) as HTMLElement;
  expect(chipA.querySelector('[data-decision-hold]')).toBeNull();
  choose('No');
  await until(() => prompt() === 'Which way should the worker go on a Stripe 409?', 'the card put off');
  // Nothing was sent for Claude Code while its decision was put off (Codex's own reply may have gone after its Hold).
  expect(posted.filter((p) => p.path === `/api/inbox/messages/${world.decide.a}/reply`)).toHaveLength(0);
  expect((await questionsOf(world.decide.a)).map((q) => q.state)).toEqual(['open', 'picked']);
}, 30_000);

test.skipIf(!hasDom)('a question the agent replaces while it is on screen swaps in with a banner; the old pick is not sent', async () => {
  const el = await renderApp();
  await openDecide(el);
  const old = (await questionsOf(world.decide.a))[0]!;
  const replacement = await agentSends({
    project: world.project,
    session: world.decide.sessionA,
    reply_to: world.decide.a,
    body: [':::question', 'Retry on 409 with the same key, or fail it?', '', '- [ ] Same key', '- [ ] Fail it', ':::'].join('\n'),
    supersedes: [`${world.decide.a}/${old.key}`],
  });
  const superseded = (await questionsOf(world.decide.a))[0]!;
  expect(superseded.state).toBe('superseded');
  // The event stream's question line (the window reads the projection again with it).
  await act(async () => {
    poke!(JSON.stringify({ seq: 999, kind: 'question', id: `${world.decide.a}/${old.key}`, question: superseded }));
  });
  await until(() => dialog()!.querySelector('[data-decision-replaced]') !== null, 'the banner');
  expect(dialog()!.querySelector('[data-decision-replaced]')!.textContent).toContain('Claude Code replaced this question just now.');
  await until(() => prompt() === 'Retry on 409 with the same key, or fail it?', 'the replacement');
  expect(replacement).toMatch(/^msg_/);
}, 30_000);

test.skipIf(!hasDom)('closing with an agent half answered asks first: Keep as a draft leaves the pick saved and sends nothing', async () => {
  const el = await renderApp();
  await openDecide(el);
  choose('Retry with the same key');
  await until(() => prompt() === 'Page on-call after 5 tries?', 'the second card');
  act(() => (dialog()!.querySelector('[data-decision-close]') as HTMLButtonElement).click());
  await until(() => (dialog()?.querySelector('[data-decision-confirm]') ?? null) !== null, 'the question');
  // Escape closes the question first, not the dialog.
  act(() => {
    dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  await settle();
  expect(dialog()?.querySelector('[data-decision-confirm]')).toBeNull();
  expect(dialog()).not.toBeNull();
  act(() => (dialog()!.querySelector('[data-decision-close]') as HTMLButtonElement).click());
  await until(() => (dialog()?.querySelector('[data-decision-keep-draft]') ?? null) !== null, 'the question again');
  act(() => (dialog()!.querySelector('[data-decision-keep-draft]') as HTMLButtonElement).click());
  await until(() => dialog() === null, 'the dialog to close');
  expect(posted.filter((p) => p.path.endsWith('/reply'))).toHaveLength(0);
  expect((await questionsOf(world.decide.a)).map((q) => q.state)).toEqual(['picked', 'open']);
  const model = await api<InboxDecisionsModel>('/api/inbox/decisions');
  expect(model.decisions.map((d) => d.question.state)).toEqual(['picked', 'open', 'open']);
}, 30_000);

test.skipIf(!hasDom)('Open the thread tucks decision mode into a pill; Resume brings it back on the same card', async () => {
  const el = await renderApp();
  await openDecide(el);
  act(() => (dialog()!.querySelector('[data-decision-open-thread]') as HTMLButtonElement).click());
  await until(() => el.querySelector('[data-decision-pill]') !== null, 'the pill');
  expect(window.location.hash).toContain(`thread=${world.decide.a}`);
  expect(el.querySelector('[data-decision-pill]')!.textContent).toContain('3 left');
  expect(dialog()!.open).toBe(false);
  act(() => (el.querySelector('[data-decision-resume]') as HTMLButtonElement).click());
  await settle();
  expect(dialog()!.open).toBe(true);
  expect(prompt()).toBe('Which way should the worker go on a Stripe 409?');
}, 30_000);

// ─────────────────────────────── Review round ───────────────────────────────

const replies = () => posted.filter((p) => p.path.endsWith('/reply'));
const sleep = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));

/** The overview ("All"), then the row of this prompt: its card. */
async function goTo(text: string) {
  act(() => (dialog()!.querySelector('[data-decision-overview]') as HTMLButtonElement).click());
  await until(() => dialog()!.querySelector('[data-decision-all]') !== null, 'the overview');
  const row = [...dialog()!.querySelectorAll('.ib-dm-allrow')].find((r) => r.querySelector('.ib-dm-allp')?.textContent?.includes(text)) as HTMLButtonElement;
  if (!row) throw new Error(`no row ${text}`);
  act(() => row.click());
  await until(() => prompt()?.includes(text) === true, `the card ${text}`);
}

/** Close, and the close question's words. */
async function closeAsks(): Promise<string> {
  act(() => (dialog()!.querySelector('[data-decision-close]') as HTMLButtonElement).click());
  await until(() => (dialog()?.querySelector('[data-decision-confirm]') ?? null) !== null, 'the close question');
  return dialog()!.querySelector('[data-decision-confirm]')!.textContent!.replace(/\s+/g, ' ');
}

/** Words typed into a textarea, as React sees typing. */
function typeInto(box: HTMLTextAreaElement, words: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, words);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function escapeOn(el: Element) {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
}

const chipA = () => dialog()!.querySelector(`[data-decision-chip="s:claude-code:${world.decide.sessionA}"]`) as HTMLElement;

test.skipIf(!hasDom)('reopening after "Keep as a draft" sends nothing: picks saved before the sitting wait as Held · Send', async () => {
  const el = await renderApp();
  await openDecide(el);
  choose('Retry with the same key');
  await until(() => prompt() === 'Page on-call after 5 tries?', 'the second card');
  choose('Yes, page on-call');
  await until(() => chipA().querySelector('[data-decision-hold]') !== null, 'the Hold');
  // Close during the Hold: the question says a reply waits to send.
  expect(await closeAsks()).toContain('answered and not sent yet');
  act(() => (dialog()!.querySelector('[data-decision-keep-draft]') as HTMLButtonElement).click());
  await until(() => dialog() === null, 'the dialog to close');
  await until(async () => (await questionsOf(world.decide.a)).every((q) => q.state === 'picked'), 'the picks saved');
  // A new sitting: the group is ready, but the person did nothing in it yet.
  await openDecide(el);
  await until(() => chipA()?.querySelector('[data-decision-held]') !== null, 'Held · Send');
  expect(chipA().querySelector('[data-decision-hold]')).toBeNull();
  await sleep(6000);
  expect(replies()).toHaveLength(0);
  expect((await questionsOf(world.decide.a)).map((q) => q.state)).toEqual(['picked', 'picked']);
  // The person's own Send still sends it.
  act(() => button(chipA().querySelector('[data-decision-held]')!, 'Send').click());
  await until(async () => (await questionsOf(world.decide.a)).every((q) => q.state === 'sent'), 'the reply');
  expect(replies()).toHaveLength(1);
}, 40_000);

test.skipIf(!hasDom)('a follow-up question after a send does send, in a reply of its own with a new key', async () => {
  const el = await renderApp();
  await openDecide(el);
  choose('Retry with the same key');
  await until(() => prompt() === 'Page on-call after 5 tries?', 'the second card');
  choose('Yes, page on-call');
  await until(() => chipA().querySelector('[data-decision-hold]') !== null, 'the Hold');
  act(() => button(chipA().querySelector('[data-decision-hold]')!, 'Hold').click());
  act(() => button(chipA().querySelector('[data-decision-held]')!, 'Send').click());
  await until(async () => (await questionsOf(world.decide.a)).every((q) => q.state === 'sent'), 'the first reply');
  // Claude Code asks a follow-up in the same thread while the sitting is open.
  const followUp = await agentSends({
    project: world.project,
    session: world.decide.sessionA,
    reply_to: world.decide.a,
    body: [':::question', 'Keep the old key for a day?', '', '- [ ] Keep it', '- [ ] Drop it', ':::'].join('\n'),
  });
  const q = (await questionsOf(followUp, world.decide.a))[0]!;
  await act(async () => {
    poke!(JSON.stringify({ seq: 1001, kind: 'question', id: `${followUp}/${q.key}`, question: q }));
  });
  // It joins the queue (after Codex's card, which is on screen now).
  await until(() => dialog()!.querySelector('[data-decision-head]')!.textContent!.includes(' of 4 '), 'the follow-up in the queue');
  await goTo('Keep the old key for a day?');
  choose('Keep it');
  // The group goes round again: a Hold, then its reply.
  await until(() => chipA().querySelector('[data-decision-hold]') !== null, 'a Hold for the follow-up');
  expect(chipA().querySelector('[data-decision-hold]')!.textContent).toMatch(/Sending in 5 s/);
  await until(async () => (await questionsOf(followUp, world.decide.a))[0]?.state === 'sent', 'the follow-up sent');
  const sent = replies();
  expect(sent).toHaveLength(2);
  expect(sent[1]!.path).toBe(`/api/inbox/messages/${followUp}/reply`);
  expect(sent[1]!.body.idempotency_key).not.toBe(sent[0]!.body.idempotency_key);
  expect((sent[1]!.body.questions as { key: string }[]).map((x) => x.key)).toEqual([q.key]);
}, 40_000);

test.skipIf(!hasDom)('closing after a failed send warns, and says the reply did not send', async () => {
  intercept = (path) => (path.endsWith('/reply') ? { status: 500, body: { error: 'The Inbox could not write.', code: 'error' } } : null);
  const el = await renderApp();
  await openDecide(el);
  await goTo('Ship the new flag off by default?');
  choose('Yes');
  const chipB = () => dialog()!.querySelector(`[data-decision-chip="s:codex:${world.decide.sessionB}"]`) as HTMLElement;
  await until(() => chipB().querySelector('[data-decision-hold]') !== null, "Codex's Hold");
  act(() => button(chipB().querySelector('[data-decision-hold]')!, 'Hold').click());
  act(() => button(chipB().querySelector('[data-decision-held]')!, 'Send').click());
  await until(() => chipB().textContent?.includes('Not sent') === true, 'the failure');
  const asked = await closeAsks();
  expect(asked).toContain("A reply didn't send");
  expect(asked).toContain('1 reply failed to send');
  // Sending again fails again: the dialog stays open and says so.
  act(() => (dialog()!.querySelector('[data-decision-send-answered]') as HTMLButtonElement).click());
  await until(() => dialog()?.querySelector('.ib-dm-error')?.textContent?.includes('not sent') === true, 'the error');
  expect(dialog()).not.toBeNull();
  expect((await questionsOf(world.decide.b))[0]!.state).toBe('picked');
}, 30_000);

test.skipIf(!hasDom)('a thread with a reply draft: "Send what you answered" leaves it untouched, and nothing sends by itself', async () => {
  const thread = world.decide.a;
  expect((await apiPost(`/api/inbox/threads/${thread}/draft`, { body: 'My own words for Claude.', base: null })).status).toBe(200);
  try {
    const el = await renderApp();
    await openDecide(el);
    choose('Retry with the same key');
    await until(() => prompt() === 'Page on-call after 5 tries?', 'the second card');
    act(() => (dialog()!.querySelector('[data-decision-close]') as HTMLButtonElement).click());
    await until(() => (dialog()?.querySelector('[data-decision-send-answered]') ?? null) !== null, 'the close question');
    act(() => (dialog()!.querySelector('[data-decision-send-answered]') as HTMLButtonElement).click());
    await until(() => dialog() === null, 'the dialog to close');
    expect(replies().filter((r) => r.path.includes(world.decide.a))).toHaveLength(0);
    const draft = await api<{ draft: { body: string } | null }>(`/api/inbox/threads/${thread}/draft`);
    expect(draft.draft?.body).toBe('My own words for Claude.');
    // Again, answering the rest: the chip says to send from the thread, and nothing goes after the Hold.
    await openDecide(el);
    await goTo('Page on-call after 5 tries?');
    choose('Yes, page on-call');
    await until(() => chipA()?.querySelector('[data-decision-draft]') !== null, 'the draft line');
    expect(chipA().querySelector('[data-decision-draft]')!.textContent).toContain('This thread has a draft reply; send it from the thread');
    expect(chipA().querySelector('[data-decision-hold]')).toBeNull();
    await sleep(5800);
    expect(replies().filter((r) => r.path.includes(world.decide.a))).toHaveLength(0);
    expect((await questionsOf(world.decide.a)).map((q) => q.state)).toEqual(['picked', 'picked']);
    expect((await api<{ draft: { body: string } | null }>(`/api/inbox/threads/${thread}/draft`)).draft?.body).toBe('My own words for Claude.');
    // Its way to the thread.
    act(() => button(chipA().querySelector('[data-decision-draft]')!, 'Open the thread').click());
    await until(() => el.querySelector('[data-decision-pill]') !== null, 'the pill');
    expect(window.location.hash).toContain(`thread=${thread}`);
  } finally {
    await apiPost(`/api/inbox/threads/${thread}/draft/delete`, {});
  }
}, 40_000);

test.skipIf(!hasDom)("an action item's Undo the server refuses (past its window) says so, and the card stays done", async () => {
  const action = await agentSends({
    project: world.project,
    session: world.decide.sessionB,
    host: 'codex',
    reply_to: world.decide.b,
    body: [':::action', 'Run the migration on staging', ':::'].join('\n'),
  });
  const el = await renderApp();
  await openDecide(el);
  await goTo('Run the migration on staging');
  act(() => (dialog()!.querySelector('[data-decision-done]') as HTMLButtonElement).click());
  await until(async () => {
    const model = await api<{ thread: InboxThread }>(`/api/inbox/threads/${world.decide.b}`);
    const q = model.thread.messages.find((m) => m.id === action)?.questions?.[0];
    return q?.action_result?.outcome === 'done';
  }, 'Done saved');
  // The server's Undo window (400 ms here) passes; the window still offers Undo (its own is 9 s).
  await sleep(900);
  const undo = dialog()!.querySelector('[data-decision-undo]') as HTMLButtonElement;
  expect(undo).not.toBeNull();
  act(() => undo.click());
  await until(() => dialog()!.querySelector('.ib-dm-error')?.textContent?.includes('Not undone') === true, 'the refusal');
  expect(prompt()).not.toBe('Run the migration on staging');
}, 30_000);

test.skipIf(!hasDom)('Escape in a filled text box lets go of it first; closing then asks about the words', async () => {
  await agentSends({
    project: world.project,
    session: world.decide.sessionB,
    host: 'codex',
    reply_to: world.decide.b,
    body: [':::question-text', 'What should the flag be called?', ':::'].join('\n'),
  });
  const el = await renderApp();
  await openDecide(el);
  await goTo('What should the flag be called?');
  const box = dialog()!.querySelector('.ib-dm-ta') as HTMLTextAreaElement;
  box.focus();
  typeInto(box, 'refunds-v2');
  escapeOn(box);
  await settle();
  // The dialog is still open, the words are kept, and focus left the box.
  expect(dialog()).not.toBeNull();
  expect(dialog()!.querySelector('[data-decision-confirm]')).toBeNull();
  expect((dialog()!.querySelector('.ib-dm-ta') as HTMLTextAreaElement).value).toBe('refunds-v2');
  expect(document.activeElement).not.toBe(box);
  // Escape again: closing would lose them, so it asks.
  escapeOn(dialog()!.querySelector('[data-decision-prompt]')!);
  await until(() => (dialog()?.querySelector('[data-decision-confirm]') ?? null) !== null, 'the question');
  expect(dialog()!.querySelector('[data-decision-confirm]')!.textContent).toContain("The words you typed on this card aren't saved");
  escapeOn(dialog()!.querySelector('[data-decision-confirm]')!);
  await settle();
  expect(dialog()?.querySelector('[data-decision-confirm]')).toBeNull();
  expect((dialog()!.querySelector('.ib-dm-ta') as HTMLTextAreaElement).value).toBe('refunds-v2');
}, 30_000);

test.skipIf(!hasDom)('a Hold waits while decision mode is tucked behind a thread, and runs on once it is back', async () => {
  const el = await renderApp();
  await openDecide(el);
  choose('Retry with the same key');
  await until(() => prompt() === 'Page on-call after 5 tries?', 'the second card');
  choose('Yes, page on-call');
  await until(() => chipA().querySelector('[data-decision-hold]') !== null, 'the Hold');
  act(() => (dialog()!.querySelector('[data-decision-open-thread]') as HTMLButtonElement).click());
  await until(() => el.querySelector('[data-decision-pill]') !== null, 'the pill');
  await until(() => el.querySelector('[data-decision-pill-paused]') !== null, 'the pill says a reply waits');
  await sleep(6500);
  expect(replies()).toHaveLength(0);
  act(() => (el.querySelector('[data-decision-resume]') as HTMLButtonElement).click());
  await settle();
  expect(chipA().querySelector('[data-decision-hold]')!.textContent).toMatch(/Sending in [1-5] s/);
  await until(async () => (await questionsOf(world.decide.a)).every((q) => q.state === 'sent'), 'the reply once back');
  expect(replies()).toHaveLength(1);
}, 40_000);

test.skipIf(!hasDom)('a pick the Inbox refuses with a validation error is shown, not swallowed', async () => {
  intercept = (path) => (path.endsWith('/picks') ? { status: 422, body: { error: 'answer: "Retry" is not one of the choices.', code: 'validation_error' } } : null);
  const el = await renderApp();
  await openDecide(el);
  choose('Retry with the same key');
  await until(() => dialog()?.querySelector('.ib-dm-error')?.textContent?.includes('is not one of the choices') === true, 'the error');
  expect((await questionsOf(world.decide.a))[0]!.state).toBe('open');
}, 30_000);

test.skipIf(!hasDom)('a committed swipe keeps moving the way it was thrown, from where the finger left it; a short one goes back', async () => {
  const el = await renderApp();
  await openDecide(el);
  await goTo('Page on-call after 5 tries?');
  const card = () => dialog()!.querySelector('[data-decision-card]') as HTMLElement;
  const swipe = (target: HTMLElement, from: number, to: number) => {
    const at = (type: string, x: number) => {
      const event = new Event(type, { bubbles: true }) as Event & Record<string, unknown>;
      Object.assign(event, { pointerType: 'touch', pointerId: 7, clientX: x, clientY: 300 });
      target.dispatchEvent(event);
    };
    act(() => at('pointerdown', from));
    act(() => at('pointermove', to));
    act(() => at('pointerup', to));
  };
  // Short of the threshold: back to the centre, nothing answered.
  swipe(card(), 200, 250);
  expect(card().style.translate).toBe('');
  expect(card().hasAttribute('data-stamped')).toBe(false);
  // Committed (right: the first choice): it stays where the finger left it, never at the centre...
  const before = card();
  swipe(before, 200, 360);
  expect(before.hasAttribute('data-flung')).toBe(true);
  expect(before.style.translate).toBe('160px 0');
  // ...then keeps going right, past the edge.
  await until(() => parseFloat(before.style.translate) > 500, 'the exit');
  await until(async () => (await questionsOf(world.decide.a))[1]?.answer?.selected[0] === 'Yes, page on-call', 'the pick');
}, 30_000);

// ─────────────────────────────── Re-review ───────────────────────────────

const chipB = () => dialog()!.querySelector(`[data-decision-chip="s:codex:${world.decide.sessionB}"]`) as HTMLElement;
const waitMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Answer both of Claude Code's questions, so its group starts its Hold. */
async function answerA(el: HTMLElement) {
  await openDecide(el);
  choose('Retry with the same key');
  await until(() => prompt() === 'Page on-call after 5 tries?', 'the second card');
  choose('Yes, page on-call');
  await until(() => chipA().querySelector('[data-decision-hold]') !== null, 'the Hold');
  // The stamp lands and the queue moves on to Codex's card.
  await until(() => prompt() === 'Ship the new flag off by default?', "Codex's card");
}

test.skipIf(!hasDom)('H1: a Hold waits behind the close question, so "Keep as a draft" sends nothing', async () => {
  const el = await renderApp();
  await answerA(el);
  act(() => (dialog()!.querySelector('[data-decision-close]') as HTMLButtonElement).click());
  await until(() => (dialog()?.querySelector('[data-decision-confirm]') ?? null) !== null, 'the close question');
  // Longer than the Hold: nothing goes while the question is up.
  await sleep(6500);
  expect(replies()).toHaveLength(0);
  act(() => (dialog()!.querySelector('[data-decision-keep-draft]') as HTMLButtonElement).click());
  await until(() => dialog() === null, 'the dialog to close');
  await sleep(800);
  expect(replies()).toHaveLength(0);
  expect((await questionsOf(world.decide.a)).map((q) => q.state)).toEqual(['picked', 'picked']);
}, 40_000);

test.skipIf(!hasDom)('H2: the cards of a group whose reply is on its way are read only, then read Sent', async () => {
  let release!: () => void;
  const landed = new Promise<void>((r) => (release = r));
  intercept = async (path) => {
    if (!path.endsWith('/reply')) return null;
    await landed;
    return null;
  };
  const el = await renderApp();
  await openDecide(el);
  await goTo('Ship the new flag off by default?');
  choose('Yes');
  await until(() => chipB().querySelector('[data-decision-hold]') !== null, "Codex's Hold");
  act(() => button(chipB().querySelector('[data-decision-hold]')!, 'Hold').click());
  act(() => button(chipB().querySelector('[data-decision-held]')!, 'Send').click());
  await goTo('Ship the new flag off by default?');
  await until(() => dialog()!.querySelector('[data-decision-sending]') !== null, 'the card read only while sending');
  expect(dialog()!.querySelectorAll('.ib-dm-choice')).toHaveLength(0);
  expect(dialog()!.querySelector('[data-decision-skip]')).toBeNull();
  release();
  await until(async () => (await questionsOf(world.decide.b))[0]?.state === 'sent', 'the reply');
  await until(() => dialog()!.querySelector('[data-decision-sent]') !== null, 'the card reads Sent');
}, 30_000);

// Guards how the lock is rendered (from state, so the render that ends the send clears it), not a reproduced
// bug: the ref-based lock this replaced passed it too, since its final render happened to land after the ref cleared.
test.skipIf(!hasDom)('the Sending lock clears on the card on screen once its reply fails, without moving the queue', async () => {
  let release!: () => void;
  const landed = new Promise<void>((r) => (release = r));
  intercept = async (path) => {
    if (!path.endsWith('/reply')) return null;
    await landed;
    return { status: 500, body: { error: 'The Inbox could not write.', code: 'error' } };
  };
  const el = await renderApp();
  await openDecide(el);
  await goTo('Ship the new flag off by default?');
  choose('Yes');
  await until(() => chipB().querySelector('[data-decision-hold]') !== null, "Codex's Hold");
  act(() => button(chipB().querySelector('[data-decision-hold]')!, 'Hold').click());
  act(() => button(chipB().querySelector('[data-decision-held]')!, 'Send').click());
  await goTo('Ship the new flag off by default?');
  await until(() => dialog()!.querySelector('[data-decision-sending]') !== null, 'the card read only while sending');
  release();
  await until(() => chipB().textContent?.includes('Not sent') === true, 'the failure');
  // Same card, nothing else touched: the lock is gone and the choices are back.
  await until(() => dialog()!.querySelector('[data-decision-sending]') === null, 'the lock cleared');
  expect(prompt()).toBe('Ship the new flag off by default?');
  expect(dialog()!.querySelectorAll('.ib-dm-choice').length).toBeGreaterThan(0);
}, 30_000);

test.skipIf(!hasDom)('H2: an unchanged retry replays its key; a changed answer takes a new one', async () => {
  let failing = true;
  intercept = (path) => (path.endsWith('/reply') && failing ? { status: 500, body: { error: 'The Inbox could not write.', code: 'error' } } : null);
  const el = await renderApp();
  await openDecide(el);
  await goTo('Ship the new flag off by default?');
  choose('Yes');
  await until(() => chipB().querySelector('[data-decision-hold]') !== null, "Codex's Hold");
  act(() => button(chipB().querySelector('[data-decision-hold]')!, 'Hold').click());
  act(() => button(chipB().querySelector('[data-decision-held]')!, 'Send').click());
  await until(() => chipB().textContent?.includes('Not sent') === true, 'the failure');
  act(() => button(chipB(), 'Try again').click());
  await until(() => replies().length === 2, 'the retry');
  await until(() => chipB().textContent?.includes('Not sent') === true, 'the second failure');
  const [first, second] = replies();
  expect(second!.body.idempotency_key).toBe(first!.body.idempotency_key);
  // The person changes the answer, then the Inbox takes it: a new key, so the server cannot replay the old one.
  await goTo('Ship the new flag off by default?');
  choose('No');
  await until(async () => (await questionsOf(world.decide.b))[0]?.answer?.selected[0] === 'No', 'the new pick');
  failing = false;
  act(() => button(chipB(), 'Try again').click());
  await until(async () => (await questionsOf(world.decide.b))[0]?.state === 'sent', 'the reply');
  const third = replies().at(-1)!;
  expect(third.body.idempotency_key).not.toBe(first!.body.idempotency_key);
  expect((await questionsOf(world.decide.b))[0]!.answer?.selected).toEqual(['No']);
}, 30_000);

test.skipIf(!hasDom)('M1: a Hold starts for an answer given in this sitting, and Undo takes that back', async () => {
  const el = await renderApp();
  await answerA(el);
  act(() => (dialog()!.querySelector('[data-decision-close]') as HTMLButtonElement).click());
  await until(() => (dialog()?.querySelector('[data-decision-keep-draft]') ?? null) !== null, 'the close question');
  act(() => (dialog()!.querySelector('[data-decision-keep-draft]') as HTMLButtonElement).click());
  await until(() => dialog() === null, 'the dialog to close');
  // A new sitting: both picks were saved before it, so Held · Send.
  await openDecide(el);
  await until(() => chipA()?.querySelector('[data-decision-held]') !== null, 'Held · Send');
  await goTo('Which way should the worker go on a Stripe 409?');
  choose('Fail to the dead-letter queue');
  await until(() => chipA().querySelector('[data-decision-hold]') !== null, 'a Hold for the new answer');
  act(() => (dialog()!.querySelector('[data-decision-undo]') as HTMLButtonElement).click());
  await until(() => chipA().querySelector('[data-decision-held]') !== null, 'Held · Send again');
  await sleep(6000);
  expect(replies()).toHaveLength(0);
  expect((await questionsOf(world.decide.a))[0]!.answer?.selected).toEqual(['Retry with the same key']);
}, 50_000);

test.skipIf(!hasDom)("M2: a group's Hold waits while one of its cards is being edited", async () => {
  const el = await renderApp();
  await answerA(el);
  await goTo('Page on-call after 5 tries?');
  act(() => (dialog()!.querySelector('[data-decision-note]') as HTMLButtonElement).click());
  await until(() => chipA().querySelector('[data-decision-hold]')?.textContent?.includes('Waiting') === true, 'the Hold paused');
  await sleep(6500);
  expect(replies()).toHaveLength(0);
  // The note box closes: the Hold runs on, and the reply goes.
  act(() => (dialog()!.querySelector('[data-decision-note]') as HTMLButtonElement).click());
  await until(async () => (await questionsOf(world.decide.a)).every((q) => q.state === 'sent'), 'the reply once done editing');
  expect(replies()).toHaveLength(1);
}, 40_000);

test.skipIf(!hasDom)('M3: comments waiting in a thread count as its draft, and a draft check that fails sends nothing', async () => {
  const comment = { id: 'ann-dm-1', blockId: 'block-1', startOffset: 0, endOffset: 4, type: 'COMMENT', text: 'Check the flag name.', originalText: 'Ship', createdA: 1 };
  expect((await apiPost(`/api/inbox/messages/${world.decide.b}/annotations`, { annotation: comment })).status).toBe(200);
  try {
    const el = await renderApp();
    await openDecide(el);
    await goTo('Ship the new flag off by default?');
    choose('Yes');
    await until(() => chipB().querySelector('[data-decision-draft]') !== null, 'the draft line for comments');
    await sleep(5600);
    expect(replies()).toHaveLength(0);
  } finally {
    await apiPost('/api/inbox/annotations/ann-dm-1/remove', {});
  }
  act(() => root?.unmount());
  host?.remove();
  // The draft read fails: nothing is sent, and the chip says why.
  intercept = (path, method) => (method === 'GET' && path.endsWith('/draft') ? { status: 500, body: { error: 'down', code: 'error' } } : null);
  const el = await renderApp();
  await openDecide(el);
  await goTo('Ship the new flag off by default?');
  await until(() => chipB()?.querySelector('[data-decision-held], [data-decision-hold]') !== null, 'ready');
  const hold = chipB().querySelector('[data-decision-hold]');
  if (hold) act(() => button(hold, 'Hold').click());
  act(() => button(chipB().querySelector('[data-decision-held]')!, 'Send').click());
  await until(() => chipB().textContent?.includes('Not sent') === true, 'the failure');
  expect(replies()).toHaveLength(0);
  expect((await questionsOf(world.decide.b))[0]!.state).toBe('picked');
}, 40_000);

test.skipIf(!hasDom)('comments made after the last list read are read fresh before a send: the reply goes from the thread', async () => {
  const el = await renderApp();
  await openDecide(el);
  await goTo('Ship the new flag off by default?');
  choose('Yes');
  await until(() => chipB().querySelector('[data-decision-hold]') !== null, "Codex's Hold");
  // A comment on the message, made elsewhere while the Hold runs; the window's list read is older than it.
  const comment = { id: 'ann-dm-fresh', blockId: 'block-1', startOffset: 0, endOffset: 4, type: 'COMMENT', text: 'Check the flag name.', originalText: 'Ship', createdA: 1 };
  expect((await apiPost(`/api/inbox/messages/${world.decide.b}/annotations`, { annotation: comment })).status).toBe(200);
  try {
    await until(() => chipB().querySelector('[data-decision-draft]') !== null, 'the draft line, from the fresh read');
    expect(replies()).toHaveLength(0);
    expect((await questionsOf(world.decide.b))[0]!.state).toBe('picked');
  } finally {
    await apiPost('/api/inbox/annotations/ann-dm-fresh/remove', {});
  }
}, 30_000);

test.skipIf(!hasDom)('M4: the draft state follows the latest row: the draft discarded, the group starts its Hold', async () => {
  const thread = world.decide.a;
  expect((await apiPost(`/api/inbox/threads/${thread}/draft`, { body: 'Words for Claude.', base: null })).status).toBe(200);
  const el = await renderApp();
  await openDecide(el);
  choose('Retry with the same key');
  await until(() => prompt() === 'Page on-call after 5 tries?', 'the second card');
  choose('Yes, page on-call');
  await until(() => chipA()?.querySelector('[data-decision-draft]') !== null, 'the draft line');
  await apiPost(`/api/inbox/threads/${thread}/draft/delete`, {});
  // The next list read (any event) says the draft went.
  await act(async () => {
    poke!(JSON.stringify({ seq: 2001, kind: 'question', id: 'x', question: (await questionsOf(world.decide.a))[0] }));
  });
  await until(() => chipA().querySelector('[data-decision-draft]') === null, 'the draft line gone');
  await until(async () => (await questionsOf(world.decide.a)).every((q) => q.state === 'sent'), 'the reply after its Hold');
}, 40_000);

test.skipIf(!hasDom)('M5: closing while a reply is on its way waits for it, and its failure is said, never silent', async () => {
  intercept = async (path) => {
    if (!path.endsWith('/reply')) return null;
    await waitMs(1500);
    return { status: 500, body: { error: 'The Inbox could not write.', code: 'error' } };
  };
  const el = await renderApp();
  await openDecide(el);
  await goTo('Ship the new flag off by default?');
  choose('Yes');
  await until(() => chipB().querySelector('[data-decision-hold]') !== null, "Codex's Hold");
  act(() => button(chipB().querySelector('[data-decision-hold]')!, 'Hold').click());
  act(() => button(chipB().querySelector('[data-decision-held]')!, 'Send').click());
  const asked = await closeAsks();
  expect(asked).toContain('1 reply still sending');
  act(() => (dialog()!.querySelector('[data-decision-keep-draft]') as HTMLButtonElement).click());
  await until(() => dialog()?.querySelector('.ib-dm-error')?.textContent?.includes('not sent') === true, 'the failure said');
  expect(dialog()).not.toBeNull();
}, 30_000);

test.skipIf(!hasDom)('a notification for another card while words are typed here moves nothing; a banner offers the move, and the words stay', async () => {
  await agentSends({ project: world.project, session: world.decide.sessionB, host: 'codex', reply_to: world.decide.b, body: [':::question-text', 'What should the flag be called?', ':::'].join('\n') });
  const { DecisionMode } = await import('./decisions/DecisionMode');
  const model = await api<InboxDecisionsModel>('/api/inbox/decisions');
  const stopped = model.decisions.find((d) => d.question.stopped !== null)!;
  const text = model.decisions.find((d) => d.question.prompt === 'What should the flag be called?')!;
  host = document.createElement('div');
  document.body.appendChild(host);
  const draw = (start: string | null, startNonce: number) =>
    root!.render(
      <DecisionMode
        open
        decisions={model.decisions}
        rows={new Map()}
        start={start}
        startNonce={startNonce}
        phone={false}
        refresh={() => {}}
        subscribeQuestions={() => () => {}}
        onTuck={() => {}}
        onClose={() => {}}
      />,
    );
  act(() => {
    root = createRoot(host!);
    draw(text.id, 1);
  });
  await until(() => prompt() === 'What should the flag be called?', 'the text card');
  typeInto(dialog()!.querySelector('.ib-dm-ta') as HTMLTextAreaElement, 'refunds-v2');
  // A Stopped notification while the sitting is open: a new start.
  act(() => draw(stopped.id, 2));
  await settle();
  expect(prompt()).toBe('What should the flag be called?');
  expect((dialog()!.querySelector('.ib-dm-ta') as HTMLTextAreaElement).value).toBe('refunds-v2');
  expect(dialog()!.querySelector('[data-decision-start-banner]')!.textContent).toContain(stopped.question.prompt);
  // The person moves; the words are kept for when the card comes back.
  act(() => (dialog()!.querySelector('[data-decision-start-go]') as HTMLButtonElement).click());
  await until(() => prompt() === stopped.question.prompt, 'the Stopped card');
  await goTo('What should the flag be called?');
  expect((dialog()!.querySelector('.ib-dm-ta') as HTMLTextAreaElement).value).toBe('refunds-v2');
  // With nothing typed, a new start moves at once.
  typeInto(dialog()!.querySelector('.ib-dm-ta') as HTMLTextAreaElement, '');
  act(() => draw(stopped.id, 3));
  await until(() => prompt() === stopped.question.prompt, 'moved');
}, 30_000);
