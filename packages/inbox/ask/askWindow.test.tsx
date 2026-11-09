/**
 * Ask AI's window in the whole Inbox window (InboxApp) over a REAL Inbox in a
 * temp data dir, with a scripted agent on a live connection (its own process,
 * tests/helpers/inbox-ask-dom-server.ts), with no switch and Code review off
 * (Ask is on in every Inbox). What is proved: Side shows only for a thread that can
 * ask, and no top bar has an Ask icon; a question gets its answer under the real agent's name and icon, and the
 * surface the agent gets comes from the thread; the dropdown's pick moves
 * `#thread=`; the box's words stay across a thread switch; Mod+Enter in the
 * window never sends the reply draft, even after a pressed button goes away;
 * Escape in it never closes the thread, and bare keys never reach the Inbox; a
 * busy choice goes only to the session it was shown for; Ask again keeps one
 * question; Reply in the thread leaves the reply in sight; a POST that lands
 * after a switch harms neither thread; a damaged file keeps Ask AI and says so.
 *
 * The same in a real browser on the built Inbox: tests/e2e/inbox-ask-window.spec.ts.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { HostMark } from '@plannotator/ui/components/inbox-thread/icons';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { NO_BROWSER } from '../../../tests/helpers/no-browser';
import { writeInboxAsk } from '../../shared/inbox/ask';
import { PHONE_QUERY, TOUCH_QUERY } from '../phone';
import { emitAskChange } from './askEvents';

setDefaultTimeout(30_000);

const hasDom = typeof document !== 'undefined';
const { InboxApp } = (hasDom ? await import('../App') : {}) as typeof import('../App');

const SERVER_SCRIPT = resolve(import.meta.dir, '../../../tests/helpers/inbox-ask-dom-server.ts');
/** The icon of the agent that owns the seeded threads, not the fallback an unknown host gets. */
const claudeMark = renderToStaticMarkup(<HostMark host="claude-code" />);

interface World {
  port: number;
  control: number;
  serverSession: string;
  project: string;
  first: string;
  second: string;
  mine: string;
  busy: string;
  moved: string;
  flaky: string;
  note: string;
  damaged: string;
  resolved: string;
  inboxDir: string;
  stop: () => Promise<void>;
}

const dirs: string[] = [];
let on: World;
let world: World;
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedEventSource: unknown;
let savedMatchMedia: typeof window.matchMedia;
/** Every request the window made. */
let requests: { method: string; path: string; body: Record<string, unknown> }[] = [];
/** While set, the answers to POST /ask wait for it: the server has them, the window does not yet. */
let postsLand: Promise<void> | null = null;
/** While set, POST /ask is refused as the Inbox refuses a question it can't take, and nothing reaches the server. */
let refuseAsks = false;

async function startWorld(): Promise<World> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-ask-dom-')));
  dirs.push(dir);
  const child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects')], {
    env: {
      ...process.env,
      DOM_TESTS: '0',
      HOME: dir,
      PLANNOTATOR_DATA_DIR: join(dir, 'data'),
      CLAUDE_CONFIG_DIR: join(dir, 'claude'),
      CODEX_HOME: join(dir, 'codex'),
      OPENCODE_CONFIG_DIR: join(dir, 'opencode'),
      PLANNOTATOR_INBOX_CONNECT: '0',
      PLANNOTATOR_UPDATE_CHECK: '0',
      PLANNOTATOR_BROWSER: NO_BROWSER,
    },
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
  let line = '';
  while (!line.includes('\n')) {
    const { value, done } = await reader.read();
    if (done) throw new Error('the Inbox stopped');
    line += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  const started = JSON.parse(line.trim()) as Omit<World, 'stop' | 'inboxDir'>;
  return {
    ...started,
    inboxDir: join(dir, 'data', 'inbox'),
    stop: async () => {
      child.kill();
      await child.exited;
    },
  };
}

function loopback(port: number, path: string, method: string, body?: string, signal?: AbortSignal | null): Promise<{ status: number; text: string }> {
  return new Promise((done, fail) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { 'Content-Type': 'application/json', Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin' } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => done({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
    });
    signal?.addEventListener('abort', () => req.destroy());
    req.on('error', fail);
    if (body) req.write(body);
    req.end();
  });
}

beforeAll(async () => {
  if (!hasDom) return;
  on = await startWorld();
});

afterAll(async () => {
  if (!hasDom) return;
  await on?.stop();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  if (!hasDom) return;
  requests = [];
  postsLand = null;
  refuseAsks = false;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const path = String(input);
    requests.push({ method, path, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {} });
    if (refuseAsks && method === 'POST' && path.endsWith('/ask')) {
      return new Response(JSON.stringify({ error: 'Another question is running in this session.', code: 'ask_busy' }), { status: 409, headers: { 'Content-Type': 'application/json' } });
    }
    const answer = await loopback(world.port, path, method, init?.body ? String(init.body) : undefined, init?.signal);
    if (postsLand && method === 'POST' && path.endsWith('/ask')) await postsLand;
    return new Response(answer.text, { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  savedEventSource = (globalThis as Record<string, unknown>).EventSource;
  (globalThis as Record<string, unknown>).EventSource = class {
    addEventListener() {}
    close() {}
  };
  savedMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({ matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia;
  window.location.hash = '';
  window.sessionStorage.clear();
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
  (globalThis as Record<string, unknown>).EventSource = savedEventSource;
  window.matchMedia = savedMatchMedia;
});

async function wait(ms: number) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

async function until(check: () => boolean | Promise<boolean>, what: string) {
  for (let i = 0; i < 120; i++) {
    if (await check()) return;
    await wait(50);
  }
  throw new Error(`timed out waiting for ${what}; the window reads: ${askWindow()?.textContent?.slice(0, 300) ?? '(none)'}`);
}

async function openInbox(target: World, threadId: string): Promise<HTMLElement> {
  world = target;
  window.location.hash = `#thread=${threadId}`;
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<InboxApp />);
  });
  await until(() => host!.querySelector('.ib-phead') !== null, 'the thread');
  return host;
}

/** The top bar's Ask icon, gone (the owner, 2026-11-09). */
const askIcon = () => document.querySelector('[data-ask-open], section.ib-pane .ib-phead [aria-label="Ask AI about this thread"]');
const askWindow = () => document.querySelector<HTMLElement>('[data-chat-window]');
const askBox = () => askWindow()?.querySelector('textarea') ?? null;

function type(field: HTMLTextAreaElement, words: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, words);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const side = () => document.querySelector<HTMLButtonElement>('.annotation-toolbar [data-annotation-side]');
/** Ask's mark in the corner (floaters/useReplyFloaters.tsx): a thread that already has a chat, minimized. */
const askCorner = () => document.querySelector<HTMLButtonElement>('[data-rf-card="ask"] button, button[data-rf-corner]');

/** Selects the words of the thread's first message, as a drag does: the selection bar opens over them. */
async function selectMessage() {
  const block = document.querySelector<HTMLElement>('section.ib-pane [data-block-id]');
  const walker = block ? document.createTreeWalker(block, NodeFilter.SHOW_TEXT) : null;
  let node: Text | null = null;
  for (let n = walker?.nextNode() ?? null; n; n = walker!.nextNode()) if ((n.textContent ?? '').trim().length > 3) {
    node = n as Text;
    break;
  }
  if (!node) return;
  const range = document.createRange();
  range.selectNodeContents(node);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  await act(async () => {
    node!.parentElement!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
  });
  await wait(20);
}

/** Side shows in a selection only on a thread that can ask (the top bar has no Ask icon, the owner 2026-11-09). */
async function sideOffered(): Promise<boolean> {
  await selectMessage();
  const offered = side() !== null;
  act(() => document.querySelector<HTMLElement>('.annotation-toolbar [aria-label="Cancel"]')?.click());
  window.getSelection()!.removeAllRanges();
  return offered;
}

/** Opens the thread's chat: Side on the message's words, or on a phone (no Side there) Ask's row in the corner. */
async function openChat(phone = false) {
  if (phone) {
    await until(() => askCorner() !== null, 'Ask in the corner');
    act(() => askCorner()!.click());
  } else {
    await until(async () => {
      await selectMessage();
      return side() !== null;
    }, 'Side in the selection bar');
    act(() => side()!.click());
  }
  await until(() => askBox() !== null, 'the window');
}

function pressEnter(target: HTMLElement, mod = false) {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', metaKey: mod, ctrlKey: mod, bubbles: true, cancelable: true }));
  });
}

async function openMenu() {
  const chip = askWindow()!.querySelector<HTMLElement>('[data-ask-chip]')!;
  act(() => chip.click());
  await until(() => document.querySelector('[data-ask-menu] [data-ask-chat]') !== null, 'the dropdown');
}

function switchTo(threadId: string) {
  act(() => {
    window.location.hash = `#thread=${threadId}`;
    window.dispatchEvent(new Event('hashchange'));
  });
}

/** A press as a browser makes it: the button takes focus, then the click. */
function press(button: HTMLElement) {
  act(() => {
    button.focus();
    button.click();
  });
}

const buttonNamed = (name: string) => [...askWindow()!.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === name);
const noteOf = (kind: string) => askWindow()!.querySelector<HTMLElement>(`[data-ask-note="${kind}"]`);
const footButton = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('section.ib-pane .ib-pfoot button')].find((button) => button.textContent?.trim() === name);
const replySends = () => requests.filter((r) => r.method === 'POST' && r.path.endsWith('/reply')).length;
const asksPosted = () => requests.filter((r) => r.method === 'POST' && r.path.endsWith('/ask'));
const queries = () => requests.filter((r) => r.path === '/api/ai/query');

/** The Send the key looks for must count as on screen (happy-dom lays nothing out). */
async function laidOut(run: () => Promise<void>) {
  const savedRects = HTMLElement.prototype.getClientRects;
  HTMLElement.prototype.getClientRects = () => [{}] as unknown as DOMRectList;
  try {
    await run();
  } finally {
    HTMLElement.prototype.getClientRects = savedRects;
  }
}

async function writeReplyDraft(words: string): Promise<HTMLTextAreaElement> {
  act(() => footButton('Reply')!.click());
  await until(() => document.querySelector('section.ib-pane textarea') !== null, 'the reply box');
  const box = document.querySelector<HTMLTextAreaElement>('section.ib-pane textarea')!;
  type(box, words);
  await until(() => footButton('Send') !== undefined, 'the Send');
  return box;
}

/** Focus is in the window, and Mod+Enter from it leaves the reply draft a draft. */
async function replyStaysDraft(box: HTMLTextAreaElement, words: string) {
  expect(askWindow()!.contains(document.activeElement)).toBe(true);
  pressEnter(document.activeElement as HTMLElement, true);
  await wait(150);
  expect(replySends()).toBe(0);
  expect(box.value).toBe(words);
}

const driveAgents = (path: string, body?: unknown) => loopback(world.control, path, body ? 'POST' : 'GET', body ? JSON.stringify(body) : undefined);
const agentSaw = async (session: string) => JSON.parse((await driveAgents(`/agent?session=${session}`)).text) as { asked: string[]; interrupts: number };
const savedTurns = async (threadId: string) => (JSON.parse((await loopback(world.port, `/api/inbox/threads/${threadId}/ask`, 'GET')).text) as { conversation: { turns: { id: string; answer?: string }[] } | null }).conversation?.turns ?? [];

/** Answers to POST /ask land when the returned function is called. */
function holdPosts(): () => void {
  let land = () => {};
  postsLand = new Promise((done) => {
    land = done;
  });
  return () => {
    postsLand = null;
    land();
  };
}

function aPhone() {
  window.matchMedia = ((query: string) => ({ matches: query === PHONE_QUERY || query === TOUCH_QUERY, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia;
}

function saveUnanswered(threadId: string, session: string, question: string) {
  writeInboxAsk(world.inboxDir, { v: 1, thread_id: threadId, seen_at: null, turns: [{ id: `saved-${threadId.slice(-12)}`, at: new Date().toISOString(), session, host: 'claude-code', question }] });
}

test('a resolved thread offers no Side; an open one does, with no Ask icon in its top bar, and Side opens and the × minimizes the window', async () => {
  if (!hasDom) return;
  await openInbox(on, on.resolved);
  await wait(300);
  expect(await sideOffered()).toBe(false);
  act(() => {
    window.location.hash = `#thread=${on.first}`;
    window.dispatchEvent(new Event('hashchange'));
  });
  await until(() => sideOffered(), 'Side on an open thread');
  expect(askIcon()).toBeNull();
  expect(askWindow()).toBeNull();
  await openChat();
  await until(() => document.activeElement === askBox(), 'focus in the box');
  // The window is outside the thread's section, which is what keeps its keys off the reply.
  expect(askWindow()!.closest('.ib-pane')).toBeNull();
  expect(askWindow()!.closest('.pn-inbox')).not.toBeNull();
  act(() => askWindow()!.querySelector<HTMLElement>('[aria-label="Close"]')!.click());
  expect(askWindow()).toBeNull();
  // The × minimizes: the thread's chat stays, and Side gives it back.
  await openChat();
});

test('a question gets its answer, under the real agent name and icon', async () => {
  if (!hasDom) return;
  await openInbox(on, on.first);
  await openChat();
  const header = askWindow()!.querySelector('[data-ask-chip]')!;
  expect(header.textContent).toContain('Why did the retry fail?');
  // The header tells Ask's window from a floating draft's (approval "inbox-reply-floaters"): Ask's sparkle and
  // "Ask AI · <thread>"; the agent's own mark is on its answers.
  expect(header.textContent).toContain('Ask AI · ');
  expect(header.querySelector('[data-ask-sparkle]')).not.toBeNull();
  type(askBox()!, 'What ran out?');
  pressEnter(askBox()!);
  await until(() => askWindow()!.textContent!.includes('Answered: What ran out?'), 'the answer');
  expect(askBox()!.value).toBe('');
  const answer = askWindow()!.querySelector<HTMLElement>('[data-message-role="assistant"]')!;
  expect(answer.textContent).toContain('Claude Code');
  expect(answer.querySelector('.ib-mk')!.outerHTML).toBe(claudeMark);
  // Always names the provider; the surface is the server's, so the window never sends a thread's name.
  const session = requests.find((r) => r.path === '/api/ai/session')!;
  expect(typeof session.body.providerId).toBe('string');
  expect(String(session.body.providerId)).toContain('#');
  expect(JSON.stringify(session.body)).not.toContain('retry');
  expect(requests.some((r) => r.path === '/api/ai/abort' && r.body.reason === 'supersede')).toBe(false);
});

test('picking a chat moves to its thread, and its box keeps its own words', async () => {
  if (!hasDom) return;
  await openInbox(on, on.second);
  await openChat();
  type(askBox()!, 'Half a question about the deploy');
  await wait(20);
  await openMenu();
  await until(() => document.querySelector(`[data-ask-menu] [data-ask-chat="${on.first}"]`) !== null, 'the list of chats');
  const rows = [...document.querySelectorAll<HTMLElement>('[data-ask-menu] [data-ask-chat]')];
  expect(rows[0]!.getAttribute('data-ask-chat')).toBe(on.second);
  expect(rows[0]!.getAttribute('data-state')).toBe('current');
  // The chat from the last test, with its real agent, and no close control on any row.
  const other = rows.find((row) => row.getAttribute('data-ask-chat') === on.first)!;
  expect(other.textContent).toContain('Why did the retry fail?');
  expect(other.textContent).toContain('api');
  expect(other.querySelector('.ib-mk')!.outerHTML).toBe(claudeMark);
  expect(document.querySelectorAll('[data-ask-menu] button').length).toBe(0);
  act(() => other.click());
  await until(() => window.location.hash.includes(on.first), 'the route');
  await until(() => askWindow()?.textContent?.includes('Why did the retry fail?') === true, 'that chat');
  await until(() => askWindow()?.textContent?.includes('Answered: What ran out?') === true, 'its transcript');
  expect(askBox()!.value).toBe('');
  // Back to the first (it has no question yet, so no row): open as it was left, the words as they were.
  act(() => {
    window.location.hash = `#thread=${on.second}`;
    window.dispatchEvent(new Event('hashchange'));
  });
  await until(() => askBox()?.value === 'Half a question about the deploy', 'the words');
});

test('Mod+Enter from the window never sends the reply draft', async () => {
  if (!hasDom) return;
  await openInbox(on, on.mine);
  await until(() => sideOffered(), 'Side');
  await laidOut(async () => {
    const replyBox = await writeReplyDraft('A reply that must stay a draft');
    await openChat();
    await wait(300);
    requests = [];
    for (const target of [askWindow()!.querySelector<HTMLElement>('[tabindex="0"]')!, askWindow()!.querySelector<HTMLElement>('[data-ask-chip]')!, askBox()!]) {
      act(() => target.focus());
      pressEnter(target, true);
      await wait(150);
      expect(replySends()).toBe(0);
    }
    expect(replyBox.value).toBe('A reply that must stay a draft');
    // The same key from the thread does send: the checks above can fail.
    act(() => document.querySelector<HTMLElement>('section.ib-pane')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, ctrlKey: true, bubbles: true, cancelable: true })));
    await until(() => replySends() === 1, 'the Send from the thread');
  });
});

test('Escape from the window leaves the thread where it is', async () => {
  if (!hasDom) return;
  await openInbox(on, on.first);
  await openChat();
  const pane = askWindow()!.querySelector<HTMLElement>('[tabindex="0"]')!;
  act(() => {
    pane.focus();
    pane.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
  });
  await wait(100);
  expect(window.location.hash).toContain(on.first);
  expect(document.querySelector('.ib-phead')).not.toBeNull();
  expect(askWindow()).not.toBeNull();
});

test('a bare key from the window stays out of the Inbox', async () => {
  if (!hasDom) return;
  await openInbox(on, on.first);
  await openChat();
  // `?` has no check on where the key came from, so only the window's overlay mark keeps it from the Inbox.
  const pressMapKey = (target: HTMLElement) => act(() => target.dispatchEvent(new KeyboardEvent('keydown', { key: '?', code: 'Slash', shiftKey: true, bubbles: true, cancelable: true })));
  const shortcutMap = () => document.querySelector('.ib-map');
  for (const target of [askWindow()!.querySelector<HTMLElement>('[tabindex="0"]')!, askWindow()!.querySelector<HTMLElement>('[data-ask-chip]')!]) {
    act(() => target.focus());
    pressMapKey(target);
    await wait(100);
    expect(shortcutMap() === null).toBe(true);
  }
  // The same key from the thread does open it: the check above can fail.
  pressMapKey(document.querySelector<HTMLElement>('section.ib-pane')!);
  await until(() => shortcutMap() !== null, 'the shortcut map');
});

test('a busy agent gets a note, and its choice asks that session once, with focus kept in the window', async () => {
  if (!hasDom) return;
  await openInbox(on, on.busy);
  await driveAgents('/busy', { session: 'session-busy', busy: true });
  await until(() => sideOffered(), 'Side');
  await laidOut(async () => {
    const replyBox = await writeReplyDraft('A half-written reply');
    await openChat();
    type(askBox()!, 'Can you stop for this?');
    pressEnter(askBox()!);
    await until(() => noteOf('busy') !== null, 'the busy note');
    expect(noteOf('busy')!.textContent).toContain('Claude Code is working on something else.');
    expect((await agentSaw('session-busy')).asked.length).toBe(0);
    requests = [];
    press(buttonNamed('Interrupt and ask now')!);
    await until(() => askWindow()!.textContent!.includes('Answered: Can you stop for this?'), 'the answer');
    await replyStaysDraft(replyBox, 'A half-written reply');
  });
  const saw = await agentSaw('session-busy');
  expect(saw.interrupts).toBe(1);
  expect(saw.asked.length).toBe(1);
  expect((await savedTurns(on.busy)).length).toBe(1);
});

test('a busy choice goes only to the session it was shown for: after a hand-off the new owner gets its own note', async () => {
  if (!hasDom) return;
  await openInbox(on, on.moved);
  await driveAgents('/busy', { session: 'session-moved', busy: true });
  await driveAgents('/busy', { session: 'session-new-owner', busy: true });
  await openChat();
  type(askBox()!, 'Who has this now?');
  pressEnter(askBox()!);
  await until(() => noteOf('busy') !== null, 'the first session being busy');
  await driveAgents('/hand-off', {});

  requests = [];
  press(buttonNamed('Interrupt and ask now')!);
  await until(() => queries().length === 1, 'the question to go out');
  expect(queries()[0]!.body.busyPolicy).toBeUndefined();
  await until(() => noteOf('busy') !== null, 'the new owner being busy');
  expect((await agentSaw('session-new-owner')).interrupts).toBe(0);

  // Now the person saw this session busy, and may choose.
  press(buttonNamed('Interrupt and ask now')!);
  await until(() => askWindow()!.textContent!.includes('Answered: Who has this now?'), 'the answer');
  expect(queries()[1]!.body.busyPolicy).toBe('interrupt');
  expect((await agentSaw('session-new-owner')).interrupts).toBe(1);
  expect(await agentSaw('session-moved')).toEqual({ asked: [], interrupts: 0 });
});

test('Ask again asks the same turn, with focus kept in the window', async () => {
  if (!hasDom) return;
  await openInbox(on, on.flaky);
  await until(() => sideOffered(), 'Side');
  await laidOut(async () => {
    const replyBox = await writeReplyDraft('Another half-written reply');
    await openChat();
    type(askBox()!, 'A flaky question');
    pressEnter(askBox()!);
    await until(() => {
      // What the event stream does when the answer ends (the test's EventSource has none).
      act(() => emitAskChange(on.flaky));
      return buttonNamed('Ask again') !== undefined;
    }, 'the note');
    expect(noteOf('unanswered')!.textContent).toContain('The scripted agent failed this one.');
    // The scripted agent's status reaches the Inbox on its 500 ms push: asking sooner finds it busy.
    await wait(700);
    requests = [];
    press(buttonNamed('Ask again')!);
    await until(() => askWindow()!.textContent!.includes('Answered: A flaky question'), 'the answer');
    await replyStaysDraft(replyBox, 'Another half-written reply');
  });
  expect((await savedTurns(on.flaky)).map((turn) => turn.answer)).toEqual(['Answered: A flaky question']);
  expect((await agentSaw('session-flaky')).asked.length).toBe(2);
});

test('Reply in the thread joins the draft, and a window filling the screen moves out of its way', async () => {
  if (!hasDom) return;
  world = on;
  saveUnanswered(on.note, 'session-note', 'What was the plan?');
  await openInbox(on, on.note);
  await until(() => sideOffered(), 'Side');
  const replyBox = await writeReplyDraft('Kept words');
  await openChat();
  await until(() => buttonNamed('Reply in the thread') !== undefined, 'the note');

  // A floating window leaves the reply in sight, so it stays.
  press(buttonNamed('Reply in the thread')!);
  await until(() => replyBox.value === 'Kept words\n\nWhat was the plan?', 'the question in the reply');
  expect(askWindow() !== null).toBe(true);

  act(() => askWindow()!.querySelector<HTMLElement>('[aria-label="Fullscreen"]')!.click());
  press(buttonNamed('Reply in the thread')!);
  await until(() => replyBox.value === 'Kept words\n\nWhat was the plan?\n\nWhat was the plan?', 'the question in the reply again');
  expect(askWindow() === null).toBe(true);
});

test('on a touch phone Enter is a new line, and Reply in the thread leaves the reply in sight', async () => {
  if (!hasDom) return;
  world = on;
  saveUnanswered(on.note, 'session-note', 'What was the plan?');
  aPhone();
  await openInbox(on, on.note);
  await openChat(true);
  type(askBox()!, 'one');
  requests = [];
  pressEnter(askBox()!);
  await wait(200);
  expect(asksPosted().length).toBe(0);
  expect(askBox()!.value).toBe('one');
  await until(() => buttonNamed('Reply in the thread') !== undefined, 'the note');
  press(buttonNamed('Reply in the thread')!);
  await until(() => document.querySelector<HTMLTextAreaElement>('section.ib-pane textarea')?.value.includes('What was the plan?') === true, 'the question in the reply');
  expect(askWindow() === null).toBe(true);
});

test('on a touch phone a note button hands focus to the transcript, so the keyboard stays down', async () => {
  if (!hasDom) return;
  world = on;
  saveUnanswered(on.note, 'session-note', 'What was the plan?');
  aPhone();
  await openInbox(on, on.note);
  await openChat(true);
  await until(() => buttonNamed('Ask again') !== undefined, 'the note');
  press(buttonNamed('Ask again')!);
  const focused = document.activeElement as HTMLElement | null;
  expect(focused?.tagName ?? 'none').not.toBe('TEXTAREA');
  expect(`${focused?.tagName} ${focused?.getAttribute('aria-label') ?? focused?.textContent?.slice(0, 30)}`).toBe('DIV Ask AI conversation');
});

test('a refused question keeps its words, across a thread switch too', async () => {
  if (!hasDom) return;
  await openInbox(on, on.second);
  await openChat();
  refuseAsks = true;
  type(askBox()!, 'Refused, then kept');
  pressEnter(askBox()!);
  await until(() => askWindow()!.querySelector('[role="alert"]')?.textContent?.includes('Another question') === true, 'the refusal');
  expect(askBox()!.value).toBe('Refused, then kept');
  // No typing since: only the restore can bring the words back to the copy a return reads.
  switchTo(on.first);
  await until(() => window.location.hash.includes(on.first) && askWindow() === null, 'the other thread');
  switchTo(on.second);
  await until(() => askWindow()?.getAttribute('data-ask-window') === on.second, 'the thread again');
  expect(askBox()!.value).toBe('Refused, then kept');
});

test('a POST that lands after a thread switch leaves the next thread its Ask', async () => {
  if (!hasDom) return;
  await openInbox(on, on.first);
  await openChat();
  const land = holdPosts();
  type(askBox()!, 'Landing late');
  pressEnter(askBox()!);
  await until(() => asksPosted().length === 1, 'the question to go out');
  switchTo(on.mine);
  await until(async () => window.location.hash.includes(on.mine) && (await sideOffered()), 'the next thread');
  await wait(100);
  land();
  await wait(400);
  expect(await sideOffered()).toBe(true);
});

test('words already sent do not come back when a POST lands after a thread switch', async () => {
  if (!hasDom) return;
  await openInbox(on, on.first);
  await openChat();
  const land = holdPosts();
  type(askBox()!, 'Sent only once');
  pressEnter(askBox()!);
  await until(() => asksPosted().length === 1, 'the question to go out');
  switchTo(on.mine);
  await until(() => window.location.hash.includes(on.mine), 'the next thread');
  await wait(100);
  land();
  await wait(100);
  switchTo(on.first);
  await until(() => askWindow()?.textContent?.includes('Sent only once') === true, 'the question in its chat');
  expect(askBox()!.value).toBe('');
});

test('a damaged conversation keeps Ask AI, says so, and the next question sets it aside', async () => {
  if (!hasDom) return;
  world = on;
  mkdirSync(join(on.inboxDir, 'ask'), { recursive: true });
  writeFileSync(join(on.inboxDir, 'ask', `${on.damaged}.json`), '{"v":1,"thread_id":');
  await openInbox(on, on.damaged);
  await openChat();
  await until(() => askWindow()!.querySelector('[role="alert"]')?.textContent?.includes('damaged') === true, 'the word on the page');
  type(askBox()!, 'Still there?');
  pressEnter(askBox()!);
  await until(() => askWindow()!.querySelector('[role="alert"]')?.textContent?.includes('set aside') === true, 'where it went');
  expect(askBox()!.value).toBe('Still there?');
  const kept = readdirSync(join(on.inboxDir, 'ask')).filter((name) => name.startsWith(on.damaged));
  expect(kept).toHaveLength(1);
  expect(kept[0]).toMatch(/\.json\.\d+\.bad$/);
  pressEnter(askBox()!);
  await until(() => askWindow()!.textContent!.includes('Answered: Still there?'), 'a new conversation');
  await until(() => askWindow()!.querySelector('[role="alert"]') === null, 'the word to go');
});

test('Stop works from a page that did not start the answer', async () => {
  if (!hasDom) return;
  await openInbox(on, on.second);
  await openChat();
  type(askBox()!, 'Answer this slowly');
  pressEnter(askBox()!);
  await until(() => askWindow()!.textContent!.includes('Connecting…'), 'the question to go out');
  // A reload: this page's stream and AI session are gone, the answer goes on at the Inbox.
  act(() => root?.unmount());
  host?.remove();
  await openInbox(on, on.second);
  await openChat();
  await until(() => askWindow()!.textContent!.includes('Answering…'), 'the read to say it runs');
  requests = [];
  act(() => askWindow()!.querySelector<HTMLElement>('[aria-label="Stop"]')!.click());
  await until(() => requests.some((r) => r.path.endsWith('/ask/stop')), 'the Stop');
  expect(requests.some((r) => r.path === '/api/ai/abort')).toBe(false);
  await until(() => askWindow()!.textContent!.includes('Stopped.'), 'the turn to say so');
  expect(askWindow()!.querySelector('[aria-label="Stop"]')).toBeNull();
});
