/**
 * Decision mode (approval "inbox-decision-mode"; on unless Settings › Capabilities turns it off), as the window draws
 * it: the whole window (InboxApp) over a REAL Inbox server in a temp data dir (its own process,
 * tests/helpers/inbox-dom-server.ts in its `decisions` mode, which writes no config.json, so the default holds, and
 * seeds Claude Code asking two questions, one Stopped, and Codex asking one in the same thread).
 *
 * What is proved: on by default, and no global way in (no sidebar row, no list-header button); the one way in,
 * "Decide these N" in a thread's open-questions list, only from two decisions; the Capabilities switch off hides it
 * and the route. Each card is the thread's own question card, and its answer is the thread's draft ("Draft"). Nothing
 * sends without the person's press (the old 5 s Hold is gone): Send sends only what is answered, one reply per agent
 * session, and leaves the rest open. Closing asks nothing and keeps every answer as a draft, words typed just before
 * included. Undo, Previous, Later, a replaced question, the pill, follow-ups, failures and the thread's own draft.
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
/** Record frames fired by hand: far past any seq the seeded Inbox reached, so the window never takes one as old. */
let seq = 900_000_000;

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
const TESTS = 30;

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

const sleep = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));

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

function unmountApp() {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
}

function button(el: ParentNode, text: string): HTMLButtonElement {
  const found = [...el.querySelectorAll('button')].find((b) => b.textContent?.replace(/\s+/g, ' ').trim() === text);
  if (!found) throw new Error(`no button "${text}" in ${[...el.querySelectorAll('button')].map((b) => b.textContent?.trim()).join(' | ')}`);
  return found as HTMLButtonElement;
}

const dialog = () => document.querySelector('[data-decision-mode]') as HTMLDialogElement | null;
const cardEl = () => dialog()?.querySelector<HTMLElement>('[data-decision-card]') ?? null;
/** The card's prompt: the thread card's own (a question), or an action item's heading. */
const prompt = () => cardEl()?.querySelector('[data-question-part="prompt"], [data-decision-prompt]')?.textContent?.trim() ?? null;
const sendButton = () => dialog()!.querySelector('[data-decision-send]') as HTMLButtonElement;
const replies = () => posted.filter((p) => p.path.endsWith('/reply'));
const picks = () => posted.filter((p) => p.path.endsWith('/picks'));
const chipA = () => dialog()!.querySelector(`[data-decision-chip="s:claude-code:${world.decide.sessionA}"]`) as HTMLElement;
const chipB = () => dialog()!.querySelector(`[data-decision-chip="s:codex:${world.decide.sessionB}"]`) as HTMLElement;

/** The choices of the thread card on screen. */
const options = () => [...(cardEl()?.querySelectorAll<HTMLElement>('[data-question-option]') ?? [])];
const optionText = (option: HTMLElement) => option.textContent?.replace(/\s+/g, ' ').trim() ?? '';
const radioOf = (option: HTMLElement) => option.querySelector('input[data-question-control]') as HTMLInputElement;

/** A click on a choice of the thread card on screen, as a pointer makes it (a press, then the click). */
function choose(label: string) {
  const option = options().find((o) => optionText(o).startsWith(label));
  if (!option) throw new Error(`no choice ${label} in ${options().map(optionText).join(' | ')}`);
  act(() => {
    radioOf(option).dispatchEvent(new Event('pointerdown', { bubbles: true }));
    radioOf(option).click();
  });
}

/** The choice ticked on the card on screen. */
const checkedChoice = () => options().find((o) => radioOf(o)?.checked);

/** The card on screen is tagged "Draft" (answered, not sent), as the thread tags it. */
const draftTagged = (card: ParentNode | null = cardEl()) => [...(card?.querySelectorAll('[data-question-tag]') ?? [])].some((t) => t.textContent?.trim() === 'Draft');

async function questionsOf(messageId: string, threadId = world.decide.a): Promise<InboxQuestion[]> {
  const model = await api<{ thread: InboxThread }>(`/api/inbox/threads/${threadId}`);
  return model.thread.messages.find((m) => m.id === messageId)?.questions ?? [];
}

/** A question record frame, as the event stream sends it (a message the window does not hold yet makes it read the thread again). */
async function pokeQuestion(question: InboxQuestion) {
  await act(async () => {
    poke!(JSON.stringify({ seq: ++seq, kind: 'question', id: `${question.message_id}/${question.key}`, thread_id: world.decide.a, question }));
  });
}

/** A press as a pointer makes it (Base UI's Menu opens on it). */
async function press(target: HTMLElement) {
  await act(async () => {
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }));
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    target.click();
  });
}

/** The thread open in the window (its route), its open-questions list open: the list. */
async function openQuestionsOf(el: HTMLElement, threadId: string): Promise<HTMLElement> {
  if (!window.location.hash.includes(`thread=${threadId}`)) {
    act(() => {
      window.location.hash = `#thread=${threadId}`;
    });
  }
  const trigger = () => el.querySelector<HTMLElement>('section.ib-pane [data-open-questions]');
  // A thread with a reply draft opens with its reply box, which takes the foot: its close chevron keeps the draft
  // and brings the foot's buttons back, as the person would.
  const cancel = () => el.querySelector<HTMLButtonElement>('section.ib-pane .ib-pfoot [data-reply-close]');
  await until(() => window.location.hash.includes(`thread=${threadId}`) && (trigger() !== null || cancel() !== null), 'the thread foot');
  await settle();
  if (cancel()) act(() => cancel()!.click());
  await until(() => trigger() !== null, 'the open-questions button');
  if (trigger()!.getAttribute('aria-expanded') !== 'true') await press(trigger()!);
  await until(() => document.querySelector('[data-open-questions-list]') !== null, 'the open-questions list');
  return document.querySelector<HTMLElement>('[data-open-questions-list]')!;
}

/** Decision mode's one way in (thread only): the thread's open-questions list, then "Decide these N". */
async function openDecide(el: HTMLElement, threadId = world.decide.a) {
  const list = await openQuestionsOf(el, threadId);
  await until(() => list.querySelector('[data-thread-decide]') !== null, 'Decide these N');
  act(() => (list.querySelector('[data-thread-decide]') as HTMLElement).click());
  await until(() => prompt() !== null, 'the first card');
}

/** Another thread an agent opens in this test (archived again when the test ends, so later tests never see it). */
async function otherThread(session: string, questions: string[]): Promise<string> {
  const body = questions.map((p) => [':::question', p, '', '- [ ] Yes', '- [ ] No', ':::'].join('\n')).join('\n\n');
  return agentSends({ project: world.project, session, host: 'codex', body });
}

/** The overview ("All"), then the row of this prompt: its card. */
async function goTo(text: string) {
  act(() => (dialog()!.querySelector('[data-decision-overview]') as HTMLButtonElement).click());
  await until(() => dialog()!.querySelector('[data-decision-all]') !== null, 'the overview');
  const row = [...dialog()!.querySelectorAll('.ib-dm-allrow')].find((r) => r.querySelector('.ib-dm-allp')?.textContent?.includes(text)) as HTMLButtonElement;
  if (!row) throw new Error(`no row ${text}`);
  act(() => row.click());
  await until(() => prompt()?.includes(text) === true, `the card ${text}`);
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

function closeDialog() {
  act(() => (dialog()!.querySelector('[data-decision-close]') as HTMLButtonElement).click());
}

/** Codex asks a free-text question in the world's thread: its message id. */
const askText = () => agentSends({ project: world.project, session: world.decide.sessionB, host: 'codex', reply_to: world.decide.b, body: [':::question-text', 'What should the flag be called?', ':::'].join('\n') });

// ─────────────────────────────── The way in ───────────────────────────────

test.skipIf(!hasDom)('on by default with no global way in; the Capabilities switch off hides "Decide these N" and the route, and on brings them back', async () => {
  // This Inbox has no config.json: what shows is the default.
  expect((await loopback('/api/inbox/decisions')).status).toBe(200);
  const el = await renderApp();
  await until(() => el.querySelector('[data-inbox-nav]') !== null, 'the sidebar');
  expect((await api<InboxDecisionsModel>('/api/inbox/decisions')).decisions).toHaveLength(3);
  await settle();
  expect(el.querySelector('[data-decide-nav]')).toBeNull();
  expect(el.querySelector('[data-decide-head]')).toBeNull();
  expect([...el.querySelectorAll('button')].some((b) => /^Decide\b/.test(b.textContent?.trim() ?? ''))).toBe(false);
  unmountApp();
  // Settings › Capabilities: the switch reads on; a press turns it off.
  const settings = await renderApp('#settings/capabilities');
  const sw = () => settings.querySelector('[data-settings-decision-mode] [role="switch"]') as HTMLButtonElement | null;
  await until(() => sw() !== null, 'the Decision mode switch');
  expect(sw()!.getAttribute('aria-checked')).toBe('true');
  try {
    act(() => sw()!.click());
    await until(async () => (await loopback('/api/inbox/decisions')).status === 404, 'the switch to turn it off');
    expect(posted.some((p) => p.path.endsWith('/settings') && (p.body.decision_mode as { on?: boolean } | undefined)?.on === false)).toBe(true);
    unmountApp();
    // Off: the thread's list has its questions and no Decide row, and no dialog.
    const off = await renderApp(`#thread=${world.decide.a}`);
    const list = await openQuestionsOf(off, world.decide.a);
    await settle();
    expect(list.querySelectorAll('[data-open-question]')).toHaveLength(3);
    expect(list.querySelector('[data-thread-decide]')).toBeNull();
    expect(document.querySelector('[data-decision-mode]')).toBeNull();
    unmountApp();
    // On again from the same switch.
    const again = await renderApp('#settings/capabilities');
    const sw2 = () => again.querySelector('[data-settings-decision-mode] [role="switch"]') as HTMLButtonElement | null;
    await until(() => sw2()?.getAttribute('aria-checked') === 'false', 'the switch, off');
    act(() => sw2()!.click());
    await until(async () => (await loopback('/api/inbox/decisions')).status === 200, 'the switch to turn it on');
  } finally {
    await apiPost('/api/inbox/settings', { decision_mode: { on: true } });
  }
}, 40_000);

test.skipIf(!hasDom)('the thread\'s way in: "Decide these N" at the top of its open-questions list from two decisions, none at one', async () => {
  const single = await otherThread(`ses_one_${world.decide.sessionB}`, ['Bump the lockfile now?']);
  try {
    const el = await renderApp(`#thread=${world.decide.a}`);
    const list = await openQuestionsOf(el, world.decide.a);
    await until(() => list.querySelector('[data-thread-decide]') !== null, 'Decide these N');
    const entry = list.querySelector('[data-thread-decide]')!;
    // Three questions listed, three in the queue.
    expect(entry.textContent?.trim()).toBe('Decide these 3');
    expect(entry.getAttribute('aria-haspopup')).toBe('dialog');
    // The list's first row, before the questions.
    expect(list.querySelector('[data-thread-decide], [data-open-question]')).toBe(entry);
    // A thread with one decision: answered on its card, no Decide row.
    unmountApp();
    const other = await renderApp(`#thread=${single}`);
    const one = await openQuestionsOf(other, single);
    await until(() => one.querySelectorAll('[data-open-question]').length === 1, "the one-question thread's list");
    await settle();
    expect(one.querySelector('[data-thread-decide]')).toBeNull();
  } finally {
    await apiPost(`/api/inbox/messages/${single}/resolve`, { resolved: true });
  }
}, 30_000);

test.skipIf(!hasDom)("the dialog from a thread holds only that thread's decisions, both agents' among them, each drawn by the thread's own card", async () => {
  const elsewhere = await otherThread(`ses_two_${world.decide.sessionB}`, ['Rename the queue table?', 'Drop the old index?']);
  try {
    expect((await api<InboxDecisionsModel>('/api/inbox/decisions')).decisions).toHaveLength(5);
    const el = await renderApp(`#thread=${world.decide.a}`);
    await openDecide(el);
    expect(dialog()!.querySelector('[data-decision-head]')!.textContent).toContain('1 of 3 · 2 agents waiting');
    // The thread's card, only this question's: its key, not the message's other question.
    const keys = (await questionsOf(world.decide.a)).map((q) => q.key);
    expect([...cardEl()!.querySelectorAll('fieldset[data-question-key]')].map((f) => f.getAttribute('data-question-key'))).toEqual([keys[0]!]);
    expect(prompt()).toBe('Which way should the worker go on a Stripe 409?');
    // The head names the thread it is scoped to.
    const subject = (await api<{ thread: InboxThread }>(`/api/inbox/threads/${world.decide.a}`)).thread.subject;
    expect(subject).toBeTruthy();
    expect(dialog()!.querySelector('[data-decision-scope]')!.textContent).toBe(subject!);
    act(() => (dialog()!.querySelector('[data-decision-overview]') as HTMLButtonElement).click());
    await until(() => dialog()!.querySelector('[data-decision-all]') !== null, 'the overview');
    const prompts = [...dialog()!.querySelectorAll('.ib-dm-allp')].map((p) => p.textContent?.trim());
    expect(prompts).toEqual(['Which way should the worker go on a Stripe 409?', 'Page on-call after 5 tries?', 'Ship the new flag off by default?']);
    // One chip per agent session in the thread, each named by its agent.
    expect(dialog()!.querySelectorAll('[data-decision-chip]')).toHaveLength(2);
    expect([...dialog()!.querySelectorAll('[data-decision-chip] .ib-dm-chipname')].map((n) => n.textContent)).toEqual(['Claude Code', 'Codex']);
    // The other thread's Decide opens its own two once this sitting ends.
    closeDialog();
    await until(() => dialog() === null, 'the dialog to close');
    await openDecide(el, elsewhere);
    expect(dialog()!.querySelector('[data-decision-head]')!.textContent).toContain('1 of 2 · 1 agent waiting');
  } finally {
    await apiPost(`/api/inbox/messages/${elsewhere}/resolve`, { resolved: true });
  }
}, 30_000);

// ─────────────────────────────── Drafts and Send ───────────────────────────────

test.skipIf(!hasDom)('nothing sends without a press: each click saves a draft the card tags "Draft"; every card answered and longer than the old Hold, no reply goes', async () => {
  const el = await renderApp();
  await openDecide(el);
  // Nothing answered: Send is there, and takes no press.
  expect(sendButton().disabled).toBe(true);
  expect(prompt()).toBe('Which way should the worker go on a Stripe 409?');
  expect(draftTagged()).toBe(false);
  choose('Retry with the same key');
  await until(async () => (await questionsOf(world.decide.a))[0]?.state === 'picked', 'the pick saved');
  expect((await questionsOf(world.decide.a))[0]!.answer?.selected).toEqual(['Retry with the same key']);
  // A click on a pick-one choice moves on.
  await until(() => prompt() === 'Page on-call after 5 tries?', 'the second card');
  // Previous: the card answered holds its pick, tagged Draft as in the thread.
  act(() => (dialog()!.querySelector('[data-decision-previous]') as HTMLButtonElement).click());
  await until(() => prompt() === 'Which way should the worker go on a Stripe 409?', 'back to the first card');
  await until(() => draftTagged(), 'the Draft tag');
  expect(optionText(checkedChoice()!)).toStartWith('Retry with the same key');
  act(() => (dialog()!.querySelector('[data-decision-next]') as HTMLButtonElement).click());
  await until(() => prompt() === 'Page on-call after 5 tries?', 'the second card again');
  choose('Yes, page on-call');
  await until(() => prompt() === 'Ship the new flag off by default?', "Codex's card");
  choose('No');
  await until(async () => (await questionsOf(world.decide.b))[0]?.state === 'picked', "Codex's pick saved");
  // Everything answered: the end, with Send counting all three.
  await until(() => dialog()!.querySelector('[data-decision-end]') !== null, 'the end');
  expect(sendButton().disabled).toBe(false);
  expect(sendButton().textContent).toContain('3');
  // Longer than the old 5 s Hold: nothing went.
  await sleep(6000);
  expect(replies()).toHaveLength(0);
  expect((await questionsOf(world.decide.a)).map((q) => q.state)).toEqual(['picked', 'picked']);
  expect((await questionsOf(world.decide.b))[0]!.state).toBe('picked');
}, 40_000);

test.skipIf(!hasDom)('Send sends only what is answered, one reply per agent session; a question left open stays open and in the sitting', async () => {
  const el = await renderApp();
  await openDecide(el);
  choose('Retry with the same key');
  await until(() => prompt() === 'Page on-call after 5 tries?', 'the second card');
  // This one stays open: on to Codex's.
  act(() => (dialog()!.querySelector('[data-decision-next]') as HTMLButtonElement).click());
  await until(() => prompt() === 'Ship the new flag off by default?', "Codex's card");
  choose('Yes');
  await until(() => !sendButton().disabled && sendButton().textContent?.includes('2') === true, 'Send 2');
  act(() => sendButton().click());
  await until(async () => (await questionsOf(world.decide.a))[0]?.state === 'sent' && (await questionsOf(world.decide.b))[0]?.state === 'sent', 'both replies');
  const sent = replies();
  expect(sent).toHaveLength(2);
  const keys = (await questionsOf(world.decide.a)).map((q) => q.key);
  const a = sent.find((r) => r.path.endsWith(`/messages/${world.decide.a}/reply`))!;
  const b = sent.find((r) => r.path.endsWith(`/messages/${world.decide.b}/reply`))!;
  // Claude Code's reply carries its one answer, not the question left open.
  expect((a.body.questions as { key: string }[]).map((q) => q.key)).toEqual([keys[0]!]);
  expect(a.body.words).toBe('');
  expect((b.body.questions as unknown[]).length).toBe(1);
  expect((await questionsOf(world.decide.a))[1]!.state).toBe('open');
  // Nothing more to send; the open one is still in the sitting.
  await until(() => sendButton().disabled, 'nothing left to send');
  expect(dialog()).not.toBeNull();
  await goTo('Page on-call after 5 tries?');
  expect(checkedChoice()).toBeUndefined();
}, 30_000);

test.skipIf(!hasDom)('closing asks nothing and sends nothing: every answer stays a draft on its card in the thread; Escape closes the same way', async () => {
  const el = await renderApp();
  await openDecide(el);
  choose('Retry with the same key');
  await until(() => prompt() === 'Page on-call after 5 tries?', 'the second card');
  closeDialog();
  // Gone at once: no question first.
  await until(() => dialog() === null, 'the dialog to close');
  await until(async () => (await questionsOf(world.decide.a))[0]?.state === 'picked', 'the draft saved');
  await sleep(800);
  expect(replies()).toHaveLength(0);
  expect((await questionsOf(world.decide.a)).map((q) => q.state)).toEqual(['picked', 'open']);
  // The thread behind: that question's own card holds the pick, tagged Draft.
  const key = (await questionsOf(world.decide.a))[0]!.key;
  const threadCard = () => el.querySelector<HTMLElement>(`section.ib-pane [data-message-id="${world.decide.a}"] fieldset[data-question-key="${key}"]`);
  await until(() => threadCard() !== null && draftTagged(threadCard()), "the thread card's Draft");
  // Escape closes at once too, and sends nothing.
  await openDecide(el);
  escapeOn(dialog()!);
  await until(() => dialog() === null, 'Escape to close');
  await sleep(300);
  expect(replies()).toHaveLength(0);
}, 30_000);

test.skipIf(!hasDom)('words typed in Other save once after the pause, however many changes; words typed just before closing are saved too', async () => {
  const el = await renderApp();
  await openDecide(el);
  const field = () => cardEl()!.querySelector('textarea[data-question-other]') as HTMLTextAreaElement;
  // The first letter answers the question (open → picked): that saves at once, as in the thread.
  typeInto(field(), 'step 1');
  await until(() => picks().length === 1, 'the first save');
  // Every change after it is words only: one save, after the pause.
  for (let i = 2; i <= 40; i += 1) typeInto(field(), `step ${i}`);
  expect(picks()).toHaveLength(1);
  await until(() => picks().length === 2, 'the save after the pause');
  await until(async () => (await questionsOf(world.decide.a))[0]?.answer?.other === 'step 40', 'the words saved');
  await sleep(800);
  expect(picks()).toHaveLength(2);
  // Typed, then closed at once: saved as the draft, not lost.
  typeInto(field(), 'step 41');
  closeDialog();
  await until(() => dialog() === null, 'the dialog to close');
  await until(async () => (await questionsOf(world.decide.a))[0]?.answer?.other === 'step 41', 'the words saved on close');
  expect(replies()).toHaveLength(0);
}, 30_000);

test.skipIf(!hasDom)('words typed on a free-text card are saved when the person moves on, and are there when the card comes back', async () => {
  const text = await askText();
  const el = await renderApp();
  await openDecide(el);
  await goTo('What should the flag be called?');
  const box = () => cardEl()!.querySelector('fieldset[data-question-key] textarea') as HTMLTextAreaElement;
  typeInto(box(), 'refunds-v2');
  // Moved before the pause: the move saves them.
  await goTo('Ship the new flag off by default?');
  await until(async () => (await questionsOf(text))[0]?.answer?.text === 'refunds-v2', 'the words saved');
  await goTo('What should the flag be called?');
  expect(box().value).toBe('refunds-v2');
  expect(replies()).toHaveLength(0);
}, 30_000);

test.skipIf(!hasDom)('Escape in a filled text box lets go of it first; the next Escape closes at once, the words kept as the draft', async () => {
  const text = await askText();
  const el = await renderApp();
  await openDecide(el);
  await goTo('What should the flag be called?');
  const box = cardEl()!.querySelector('fieldset[data-question-key] textarea') as HTMLTextAreaElement;
  box.focus();
  typeInto(box, 'refunds-v2');
  escapeOn(box);
  await settle();
  // Still open, the words kept, and focus left the box.
  expect(dialog()).not.toBeNull();
  expect((cardEl()!.querySelector('fieldset[data-question-key] textarea') as HTMLTextAreaElement).value).toBe('refunds-v2');
  expect(document.activeElement).not.toBe(box);
  // Again: closed, nothing asked, the words saved, nothing sent.
  escapeOn(document.activeElement && dialog()!.contains(document.activeElement) ? document.activeElement : dialog()!);
  await until(() => dialog() === null, 'the dialog to close');
  await until(async () => (await questionsOf(text))[0]?.answer?.text === 'refunds-v2', 'the words saved');
  expect(replies()).toHaveLength(0);
}, 30_000);

test.skipIf(!hasDom)('Undo puts the last pick back and returns to its card; Previous goes back a card, its pick shown', async () => {
  const el = await renderApp();
  await openDecide(el);
  choose('Fail to the dead-letter queue');
  await until(() => prompt() === 'Page on-call after 5 tries?', 'the second card');
  await until(async () => (await questionsOf(world.decide.a))[0]?.state === 'picked', 'the pick saved');
  act(() => (dialog()!.querySelector('[data-decision-undo]') as HTMLButtonElement).click());
  await until(() => prompt() === 'Which way should the worker go on a Stripe 409?', 'back to the first card');
  await until(async () => (await questionsOf(world.decide.a))[0]?.state === 'open', 'the pick taken back');
  choose('Retry with the same key');
  await until(() => prompt() === 'Page on-call after 5 tries?', 'the second card');
  const prev = dialog()!.querySelector('[data-decision-previous]') as HTMLButtonElement;
  expect(prev.disabled).toBe(false);
  act(() => prev.click());
  await settle();
  expect(prompt()).toBe('Which way should the worker go on a Stripe 409?');
  expect(optionText(checkedChoice()!)).toStartWith('Retry with the same key');
}, 30_000);

test.skipIf(!hasDom)('Later puts a decision at the end: the others first, then it comes back; nothing is sent meanwhile', async () => {
  const el = await renderApp();
  await openDecide(el);
  act(() => (dialog()!.querySelector('[data-decision-later]') as HTMLButtonElement).click());
  await until(() => prompt() === 'Page on-call after 5 tries?', 'the next card');
  choose('No, a daily digest');
  await until(() => prompt() === 'Ship the new flag off by default?', "Codex's card");
  choose('No');
  await until(() => prompt() === 'Which way should the worker go on a Stripe 409?', 'the card put off');
  expect(replies()).toHaveLength(0);
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
  // The event stream's question lines: the old one replaced, then the new message's (the window reads the thread again).
  await pokeQuestion(superseded);
  await pokeQuestion((await questionsOf(replacement))[0]!);
  await until(() => dialog()!.querySelector('[data-decision-replaced]') !== null, 'the banner');
  expect(dialog()!.querySelector('[data-decision-replaced]')!.textContent).toContain('Claude Code replaced this question just now.');
  await until(() => cardEl()?.getAttribute('data-decision-card')?.startsWith(`${replacement}/`) === true, 'the replacement card');
  await until(() => prompt() === 'Retry on 409 with the same key, or fail it?', "the replacement's prompt");
  expect(replies()).toHaveLength(0);
}, 30_000);

// ─────────────────────────────── The thread behind ───────────────────────────────

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

test.skipIf(!hasDom)("a card's Open the thread closes the dialog and lands the thread on that question, its prompt focused", async () => {
  const scrolled: Element[] = [];
  const saved = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
  try {
    const el = await renderApp();
    await openDecide(el);
    // Codex's card: the second agent's question, further down the thread.
    await goTo('Ship the new flag off by default?');
    const key = (await questionsOf(world.decide.b))[0]!.key;
    act(() => (dialog()!.querySelector('[data-decision-open-thread]') as HTMLButtonElement).click());
    await until(() => dialog()?.open === false, 'the dialog to close');
    const card = () => el.querySelector<HTMLElement>(`section.ib-pane [data-message-id="${world.decide.b}"] [data-question-key="${key}"]`);
    await until(() => card() !== null && document.activeElement?.id === card()!.getAttribute('aria-labelledby'), "focus on the question's prompt");
    expect(card()!.contains(document.activeElement)).toBe(true);
    expect(document.activeElement!.textContent).toContain('Ship the new flag off by default?');
    expect(scrolled).toContain(card()!);
    // The sitting is kept in its pill, and the address drops the landing.
    expect(el.querySelector('[data-decision-pill]')).not.toBeNull();
    await until(() => !window.location.hash.includes('msg='), 'the landing dropped from the address');
    expect(window.location.hash).toContain(`thread=${world.decide.a}`);
  } finally {
    Element.prototype.scrollIntoView = saved;
  }
}, 30_000);

test.skipIf(!hasDom)("an action item's Open the thread lands on its checklist row, focus on the row's task", async () => {
  const action = await agentSends({
    project: world.project,
    session: world.decide.sessionB,
    host: 'codex',
    reply_to: world.decide.b,
    body: [':::action', 'Approve the staging deploy', ':::'].join('\n'),
  });
  const scrolled: Element[] = [];
  const saved = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
  try {
    const el = await renderApp();
    await openDecide(el);
    await goTo('Approve the staging deploy');
    const key = (await questionsOf(action))[0]!.key;
    act(() => (dialog()!.querySelector('[data-decision-open-thread]') as HTMLButtonElement).click());
    await until(() => dialog()?.open === false, 'the dialog to close');
    const row = () => el.querySelector<HTMLElement>(`section.ib-pane [data-message-id="${action}"] [data-action-card="${key}"]`);
    await until(() => row() !== null && document.activeElement === row()!.querySelector('[data-action-toggle]'), "focus on the row's task");
    expect(scrolled).toContain(row()!);
    expect(scrolled.some((s) => s.hasAttribute('data-message-article'))).toBe(false);
  } finally {
    Element.prototype.scrollIntoView = saved;
  }
}, 30_000);

test.skipIf(!hasDom)("the Resume pill names the sitting's thread while another thread is on screen, and not in its own", async () => {
  const elsewhere = await otherThread(`ses_pill_${world.decide.sessionB}`, ['Rotate the webhook secret?']);
  try {
    const el = await renderApp();
    await openDecide(el);
    act(() => (dialog()!.querySelector('[data-decision-open-thread]') as HTMLButtonElement).click());
    await until(() => el.querySelector('[data-decision-pill]') !== null, 'the pill');
    await until(() => !window.location.hash.includes('msg='), 'the landing');
    expect(el.querySelector('[data-decision-pill-thread]')).toBeNull();
    const subject = (await api<{ thread: InboxThread }>(`/api/inbox/threads/${world.decide.a}`)).thread.subject!;
    act(() => {
      window.location.hash = `#thread=${elsewhere}`;
    });
    await until(() => el.querySelector('[data-decision-pill-thread]') !== null, "the pill's thread");
    expect(el.querySelector('[data-decision-pill-thread]')!.textContent).toBe(subject);
    expect(el.querySelector('[data-decision-pill]')!.textContent).toContain('3 left');
  } finally {
    await apiPost(`/api/inbox/messages/${elsewhere}/resolve`, { resolved: true });
  }
}, 30_000);

// ─────────────────────────────── After a Send ───────────────────────────────

test.skipIf(!hasDom)('a follow-up question after a send goes in a reply of its own, with a new key, only on the next press', async () => {
  const el = await renderApp();
  await openDecide(el);
  choose('Retry with the same key');
  await until(() => prompt() === 'Page on-call after 5 tries?', 'the second card');
  choose('Yes, page on-call');
  await until(() => !sendButton().disabled, 'Send');
  act(() => sendButton().click());
  await until(async () => (await questionsOf(world.decide.a)).every((q) => q.state === 'sent'), 'the first reply');
  // Claude Code asks a follow-up in the same thread while the sitting is open.
  const followUp = await agentSends({
    project: world.project,
    session: world.decide.sessionA,
    reply_to: world.decide.a,
    body: [':::question', 'Keep the old key for a day?', '', '- [ ] Keep it', '- [ ] Drop it', ':::'].join('\n'),
  });
  const q = (await questionsOf(followUp))[0]!;
  await pokeQuestion(q);
  await until(() => dialog()!.querySelector('[data-decision-head]')!.textContent!.includes(' of 4 '), 'the follow-up in the queue');
  await goTo('Keep the old key for a day?');
  choose('Keep it');
  await until(async () => (await questionsOf(followUp))[0]?.state === 'picked', 'the follow-up picked');
  await sleep(1500);
  expect(replies()).toHaveLength(1);
  act(() => sendButton().click());
  await until(async () => (await questionsOf(followUp))[0]?.state === 'sent', 'the follow-up sent');
  const sent = replies();
  expect(sent.filter((r) => r.path.includes(world.decide.a) || r.path.includes(followUp))).toHaveLength(2);
  const second = sent.find((r) => r.path.endsWith(`/messages/${followUp}/reply`))!;
  expect(second.body.idempotency_key).not.toBe(sent[0]!.body.idempotency_key);
  expect((second.body.questions as { key: string }[]).map((x) => x.key)).toEqual([q.key]);
}, 40_000);

test.skipIf(!hasDom)("a thread with a reply draft: Send leaves it untouched and sends nothing; the chip's way to the thread", async () => {
  const thread = world.decide.a;
  expect((await apiPost(`/api/inbox/threads/${thread}/draft`, { body: 'My own words for Claude.', base: null })).status).toBe(200);
  try {
    const el = await renderApp();
    await openDecide(el);
    choose('Retry with the same key');
    await until(() => prompt() === 'Page on-call after 5 tries?', 'the second card');
    choose('Yes, page on-call');
    await until(() => !sendButton().disabled, 'Send');
    act(() => sendButton().click());
    await until(() => chipA()?.querySelector('[data-decision-draft]') !== null, 'the draft line');
    expect(replies().filter((r) => r.path.includes(world.decide.a))).toHaveLength(0);
    expect((await questionsOf(world.decide.a)).map((q) => q.state)).toEqual(['picked', 'picked']);
    expect((await api<{ draft: { body: string } | null }>(`/api/inbox/threads/${thread}/draft`)).draft?.body).toBe('My own words for Claude.');
    act(() => button(chipA().querySelector('[data-decision-draft]')!, 'Open the thread').click());
    await until(() => el.querySelector('[data-decision-pill]') !== null, 'the pill');
    expect(window.location.hash).toContain(`thread=${thread}`);
  } finally {
    await apiPost(`/api/inbox/threads/${thread}/draft/delete`, {});
  }
}, 40_000);

test.skipIf(!hasDom)('the reply draft discarded since: the next Send sends', async () => {
  const thread = world.decide.a;
  expect((await apiPost(`/api/inbox/threads/${thread}/draft`, { body: 'Words for Claude.', base: null })).status).toBe(200);
  const el = await renderApp();
  await openDecide(el);
  choose('Retry with the same key');
  await until(() => prompt() === 'Page on-call after 5 tries?', 'the second card');
  choose('Yes, page on-call');
  await until(() => !sendButton().disabled, 'Send');
  act(() => sendButton().click());
  await until(() => chipA()?.querySelector('[data-decision-draft]') !== null, 'the draft line');
  await apiPost(`/api/inbox/threads/${thread}/draft/delete`, {});
  await until(() => !sendButton().disabled, 'Send again');
  act(() => sendButton().click());
  await until(async () => (await questionsOf(world.decide.a)).every((q) => q.state === 'sent'), 'the reply');
  expect(replies().filter((r) => r.path.includes(world.decide.a))).toHaveLength(1);
  await until(() => chipA().querySelector('[data-decision-draft]') === null, 'the draft line gone');
}, 40_000);

test.skipIf(!hasDom)('comments made on a message after the window read it are read fresh before a send: the reply goes from the thread; a draft check that fails sends nothing', async () => {
  const el = await renderApp();
  await openDecide(el);
  await goTo('Ship the new flag off by default?');
  choose('Yes');
  // A comment on Codex's message, made elsewhere after the window's list read.
  const comment = { id: 'ann-dm-fresh', blockId: 'block-1', startOffset: 0, endOffset: 4, type: 'COMMENT', text: 'Check the flag name.', originalText: 'Ship', createdA: 1 };
  expect((await apiPost(`/api/inbox/messages/${world.decide.b}/annotations`, { annotation: comment })).status).toBe(200);
  try {
    await until(() => !sendButton().disabled, 'Send');
    act(() => sendButton().click());
    await until(() => chipB().querySelector('[data-decision-draft]') !== null, 'the draft line, from the fresh read');
    expect(replies()).toHaveLength(0);
    expect((await questionsOf(world.decide.b))[0]!.state).toBe('picked');
  } finally {
    await apiPost('/api/inbox/annotations/ann-dm-fresh/remove', {});
  }
  unmountApp();
  // The draft read fails: nothing is sent, and the chip says so.
  intercept = (path, method) => (method === 'GET' && path.endsWith('/draft') ? { status: 500, body: { error: 'down', code: 'error' } } : null);
  const again = await renderApp();
  await openDecide(again);
  await until(() => !sendButton().disabled, 'Send, for the draft saved before');
  act(() => sendButton().click());
  await until(() => chipB()?.textContent?.includes('Not sent') === true, 'the failure');
  expect(replies()).toHaveLength(0);
  expect((await questionsOf(world.decide.b))[0]!.state).toBe('picked');
}, 40_000);

test.skipIf(!hasDom)('while a reply is on its way its cards are read only, then read as sent', async () => {
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
  await until(() => !sendButton().disabled, 'Send');
  act(() => sendButton().click());
  await goTo('Ship the new flag off by default?');
  await until(() => cardEl()!.hasAttribute('data-sent'), 'the card read only while sending');
  expect(options().every((o) => radioOf(o).disabled)).toBe(true);
  release();
  await until(async () => (await questionsOf(world.decide.b))[0]?.state === 'sent', 'the reply');
  // Reached again (Previous, the overview): read only, its answer already sent.
  await goTo('Ship the new flag off by default?');
  expect(cardEl()!.hasAttribute('data-sent')).toBe(true);
  expect(options().every((o) => radioOf(o).disabled)).toBe(true);
}, 30_000);

test.skipIf(!hasDom)('a Send that fails is said on its chip, the answers stay drafts, and the card takes picks again without moving the queue', async () => {
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
  await until(() => !sendButton().disabled, 'Send');
  act(() => sendButton().click());
  await goTo('Ship the new flag off by default?');
  await until(() => cardEl()!.hasAttribute('data-sent'), 'the card read only while sending');
  release();
  await until(() => chipB().textContent?.includes('Not sent') === true, 'the failure');
  await until(() => !cardEl()!.hasAttribute('data-sent'), 'the lock cleared');
  expect(prompt()).toBe('Ship the new flag off by default?');
  expect(options().some((o) => !radioOf(o).disabled)).toBe(true);
  expect((await questionsOf(world.decide.b))[0]!.state).toBe('picked');
  expect(dialog()!.querySelector('.ib-dm-error')?.textContent).toContain('not sent');
}, 30_000);

test.skipIf(!hasDom)('an unchanged retry replays its key; a changed answer takes a new one', async () => {
  let failing = true;
  intercept = (path) => (path.endsWith('/reply') && failing ? { status: 500, body: { error: 'The Inbox could not write.', code: 'error' } } : null);
  const el = await renderApp();
  await openDecide(el);
  await goTo('Ship the new flag off by default?');
  choose('Yes');
  await until(() => !sendButton().disabled, 'Send');
  act(() => sendButton().click());
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

test.skipIf(!hasDom)("a Done waiting in the thread's reply draft goes with the session's reply from here: one reply, not two", async () => {
  const action = await agentSends({
    project: world.project,
    session: world.decide.sessionB,
    host: 'codex',
    reply_to: world.decide.b,
    body: [':::action', 'Approve the staging deploy', ':::'].join('\n'),
  });
  const key = (await questionsOf(action))[0]!.key;
  await apiPost(`/api/inbox/messages/${action}/actions/${key}`, { outcome: 'done', note: 'Approved.', staged: true });
  const el = await renderApp();
  await openDecide(el);
  await goTo('Ship the new flag off by default?');
  choose('Yes');
  await until(async () => (await questionsOf(world.decide.b))[0]?.state === 'picked', 'the pick saved');
  await until(() => !sendButton().disabled, 'Send');
  act(() => sendButton().click());
  await until(async () => (await questionsOf(world.decide.b))[0]?.state === 'sent', 'the reply');
  // One reply for Codex's session (it answers its latest message), carrying the answer and the Done.
  const sent = replies();
  expect(sent).toHaveLength(1);
  expect((sent[0]!.body.questions as { key: string }[]).map((q) => q.key)).toEqual([(await questionsOf(world.decide.b))[0]!.key]);
  expect(sent[0]!.body.actions).toEqual(sent[0]!.path.includes(action) ? [{ key }] : [{ message_id: action, key }]);
  // The staged Done went with it: nothing of it is left in the thread's draft for a second Send.
  expect((await questionsOf(action))[0]!.state).toBe('sent');
}, 30_000);

test.skipIf(!hasDom)("an action item's Done waits in the thread's draft, sends nothing, and Undo takes it back even past the old Undo window", async () => {
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
  await until(async () => (await questionsOf(action))[0]?.action_result?.outcome === 'done', 'Done saved');
  // Staged in the draft, not sent: past the actions route's own Undo window (400 ms here), it is still the person's.
  await sleep(900);
  expect((await questionsOf(action))[0]!.state).toBe('picked');
  const undo = dialog()!.querySelector('[data-decision-undo]') as HTMLButtonElement;
  expect(undo).not.toBeNull();
  act(() => undo.click());
  await until(async () => !(await questionsOf(action))[0]?.action_result, 'the Done taken back');
  await until(() => prompt() === 'Run the migration on staging', 'back on the action item');
  expect(dialog()!.querySelector('.ib-dm-error')).toBeNull();
  expect(replies()).toHaveLength(0);
}, 30_000);

test.skipIf(!hasDom)('a pick the Inbox refuses with a validation error is shown, not swallowed', async () => {
  intercept = (path) => (path.endsWith('/picks') ? { status: 422, body: { error: 'answer: "Retry" is not one of the choices.', code: 'validation_error' } } : null);
  const el = await renderApp();
  await openDecide(el);
  choose('Retry with the same key');
  await until(() => dialog()?.querySelector('.ib-dm-error')?.textContent?.includes('is not one of the choices') === true, 'the error');
  expect((await questionsOf(world.decide.a))[0]!.state).toBe('open');
}, 30_000);

// ─────────────────────────────── Saves that fail ───────────────────────────────

/** The Other field of the card on screen. */
const otherField = () => cardEl()!.querySelector('textarea[data-question-other]') as HTMLTextAreaElement;
const toasts = () => [...document.querySelectorAll<HTMLElement>('[data-inbox-toast]')];

test.skipIf(!hasDom)('an answer that cannot be saved sends nothing and says so, its words kept; once it saves, Send carries them', async () => {
  let failing = true;
  intercept = (path, method) => (method === 'POST' && path.endsWith('/picks') && failing ? { status: 500, body: { error: 'The Inbox could not write.', code: 'error' } } : null);
  const el = await renderApp();
  await openDecide(el);
  typeInto(otherField(), 'Use a fresh key each time');
  await until(() => picks().length >= 1, 'the save tried');
  await until(() => !sendButton().disabled, 'Send');
  act(() => sendButton().click());
  await until(() => dialog()?.querySelector('.ib-dm-error')?.textContent?.includes('An answer was not saved, so nothing was sent.') === true, 'the not-saved line');
  await sleep(300);
  expect(replies()).toHaveLength(0);
  expect(otherField().value).toBe('Use a fresh key each time');
  expect((await questionsOf(world.decide.a))[0]!.state).toBe('open');
  // The Inbox takes saves again: the next Send saves the words first, then the reply carries them.
  failing = false;
  act(() => sendButton().click());
  await until(async () => (await questionsOf(world.decide.a))[0]?.state === 'sent', 'the reply');
  expect(replies()).toHaveLength(1);
  expect((await questionsOf(world.decide.a))[0]!.answer?.other).toBe('Use a fresh key each time');
}, 30_000);

test.skipIf(!hasDom)('Send, then close while the answer is still saving: the thread card shows the words, and the failed save is told once, with Open the thread', async () => {
  let release!: () => void;
  const answered = new Promise<void>((r) => (release = r));
  intercept = async (path, method) => {
    if (method !== 'POST' || !path.endsWith('/picks')) return null;
    await answered;
    return { status: 500, body: { error: 'The Inbox could not write.', code: 'error' } };
  };
  const el = await renderApp();
  await openDecide(el);
  const key = (await questionsOf(world.decide.a))[0]!.key;
  typeInto(otherField(), 'Use a fresh key each time');
  await until(() => picks().length >= 1, 'the save on its way');
  await until(() => !sendButton().disabled, 'Send');
  act(() => sendButton().click());
  closeDialog();
  await until(() => dialog() === null, 'the dialog to close');
  // The thread behind: that question's card holds the words still on their way.
  const threadCard = () => el.querySelector<HTMLElement>(`section.ib-pane [data-message-id="${world.decide.a}"] fieldset[data-question-key="${key}"]`);
  await until(() => [...(threadCard()?.querySelectorAll('textarea') ?? [])].some((t) => t.value === 'Use a fresh key each time'), "the words on the thread's card");
  expect(toasts()).toHaveLength(0);
  release();
  await until(() => toasts().length > 0, 'the toast');
  // Nothing replaces it with a Send's line (that answer is not a draft in the thread).
  await sleep(600);
  expect(toasts()).toHaveLength(1);
  expect(toasts()[0]!.textContent).toContain('Pick not saved.');
  expect(toasts()[0]!.textContent).not.toContain('A reply was not sent');
  expect(toasts()[0]!.querySelector('[data-toast-action]')?.textContent?.trim()).toBe('Open the thread');
  expect(replies()).toHaveLength(0);
}, 30_000);

test.skipIf(!hasDom)("a Can't do it reason is a draft: closed and opened again it is back; Save takes it into the mark, and Undo brings it back", async () => {
  const action = await agentSends({
    project: world.project,
    session: world.decide.sessionB,
    host: 'codex',
    reply_to: world.decide.b,
    body: [':::action', 'Rotate the staging keys', ':::'].join('\n'),
  });
  const key = (await questionsOf(action))[0]!.key;
  const savedReason = async () =>
    (await api<{ draft: { text: string } | null }>(`/api/inbox/threads/${world.decide.a}/comment-draft?key=${encodeURIComponent(`decision-reason:${action}/${key}`)}`)).draft?.text ?? '';
  const reasonBox = () => cardEl()?.querySelector<HTMLTextAreaElement>('textarea.ib-dm-ta') ?? null;
  const el = await renderApp();
  await openDecide(el);
  await goTo('Rotate the staging keys');
  act(() => (dialog()!.querySelector('[data-decision-cant]') as HTMLButtonElement).click());
  await until(() => reasonBox() !== null, 'the reason field');
  typeInto(reasonBox()!, 'No access to the vault');
  closeDialog();
  await until(() => dialog() === null, 'the dialog to close');
  await until(async () => (await savedReason()) === 'No access to the vault', 'the reason saved as a draft');
  // Opened again: the reason is back under the card.
  await openDecide(el);
  await goTo('Rotate the staging keys');
  await until(() => reasonBox()?.value === 'No access to the vault', 'the reason back');
  // Save: the mark takes the reason as its note, and the reason's own draft goes.
  act(() => (dialog()!.querySelector('[data-decision-cant-save]') as HTMLButtonElement).click());
  await until(async () => (await questionsOf(action))[0]?.action_result?.outcome === 'cant', "Can't do it saved");
  await until(async () => (await savedReason()) === '', 'the reason draft cleared');
  expect(dialog()!.querySelector('.ib-dm-error')).toBeNull();
  // Undo: the mark taken back, the reason the card's draft again.
  act(() => (dialog()!.querySelector('[data-decision-undo]') as HTMLButtonElement).click());
  await until(async () => !(await questionsOf(action))[0]?.action_result, 'the mark taken back');
  await until(() => prompt() === 'Rotate the staging keys', 'back on the action item');
  await until(() => reasonBox()?.value === 'No access to the vault', 'the reason back after Undo');
  await until(async () => (await savedReason()) === 'No access to the vault', 'the reason saved again');
  expect(replies()).toHaveLength(0);
}, 30_000);
