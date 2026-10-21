/**
 * The Board (approval "inbox-board", step 2): the whole window (InboxApp) over
 * a REAL Inbox in a temp data dir (its own process,
 * tests/helpers/inbox-dom-server.ts `board`, seeded with
 * tests/helpers/inbox-board-world.ts), the window's fetches carried to it over
 * loopback. What is proved:
 *  - the five lanes in COLUMNS.md's order, each card's two lines ("You: …" in
 *    the person's lanes, the agent's last word otherwise) and its last-heard
 *    age, the header's sums and links, the sidebar's Board count; no amber;
 *  - "N dropped by an agent" lists each agent's drop with its reason until the
 *    person looks: Restore puts one back in one click, Got it clears the rest,
 *    and opening Dropped (the Icebox page) clears a new one;
 *  - the open card: its threads (opening one goes to the thread) and PRs,
 *    Move to, Pause (the Icebox) and Take out, Drop with a reason, Restore,
 *    each said in the card;
 *  - "Ask where this is" opens a message to the card's live agent with the
 *    card named, and says so when nobody is running.
 *
 * The tests share one server (the window keeps the first server session it
 * saw), so each puts back what it moved or works on its own card.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from the test.yml DOM list.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';

// Each test waits on another process's answers many times over (a loaded machine is slow).
setDefaultTimeout(45_000);
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const hasDom = typeof document !== 'undefined';
const { InboxApp } = (hasDom ? await import('./App') : {}) as typeof import('./App');

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');

type Board = { ids: Record<string, string>; projects: Record<string, string>; projectIds: Record<string, string> };
let child: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;
let board: Board;
let dir: string | null = null;
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedEventSource: unknown;
let lines: AsyncIterator<string> | null = null;
/** Whether the page is in front (visible, with focus): a test puts it in the background. */
const front = { visible: true, focused: true };
let savedHasFocus: () => boolean;
let savedVisibility: PropertyDescriptor | undefined;

function loopbackOnce(path: string, method: string, body: string | undefined): Promise<{ status: number; text: string }> {
  return new Promise((done, fail) => {
    // A fresh connection each time (no keep-alive reuse), and a time limit: a request that never answers fails, never hangs a test.
    const req = request(
      { host: '127.0.0.1', port, path, method, agent: false, headers: { 'Content-Type': 'application/json', Host: `127.0.0.1:${port}`, Connection: 'close' } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => done({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.setTimeout(5000, () => req.destroy(new Error(`no answer to ${method} ${path}`)));
    req.on('error', fail);
    if (body) req.write(body);
    req.end();
  });
}

/** A read is safe to send twice; a write is sent once. */
async function loopback(path: string, method = 'GET', body?: string): Promise<{ status: number; text: string }> {
  try {
    return await loopbackOnce(path, method, body);
  } catch (error) {
    if (method !== 'GET') throw error;
    return loopbackOnce(path, method, body);
  }
}

async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += new TextDecoder().decode(value);
    let at: number;
    while ((at = buffer.indexOf('\n')) >= 0) {
      yield buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
    }
  }
}

/** A command to the server process (an agent's write, a connection's poll); its one-line answer. */
async function command(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  (child!.stdin as import('bun').FileSink).write(`${JSON.stringify(body)}\n`);
  (child!.stdin as import('bun').FileSink).flush();
  const next = await lines!.next();
  return JSON.parse(next.value as string);
}

async function serverCards(): Promise<{ cards: { id: string; column: string; dropped: { reason: string | null; by: { kind: string } } | null }[]; dropped_unseen: number }> {
  return JSON.parse((await loopback('/api/inbox/cards')).text);
}
const columnOf = async (id: string) => (await serverCards()).cards.find((c) => c.id === id)!.column;

beforeAll(async () => {
  if (!hasDom) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-board-dom-')));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(dir, 'bin', 'tailscale'), 0o755);
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), '1', 'board'], {
    env: { ...process.env, DOM_TESTS: '0', PLANNOTATOR_DATA_DIR: join(dir, 'data'), HOME: dir, PATH: `${join(dir, 'bin')}:${process.env.PATH}` },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
  });
  lines = readLines(child.stdout as ReadableStream<Uint8Array>);
  const first = await lines.next();
  if (first.done) throw new Error('the Inbox did not start');
  const started = JSON.parse(first.value) as { port: number; board: Board };
  port = started.port;
  board = started.board;
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
  front.visible = true;
  front.focused = true;
  savedHasFocus = document.hasFocus;
  document.hasFocus = () => front.focused;
  savedVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (front.visible ? 'visible' : 'hidden') });
});

afterEach(() => {
  if (!hasDom) return;
  document.hasFocus = savedHasFocus;
  if (savedVisibility) Object.defineProperty(document, 'visibilityState', savedVisibility);
  else delete (document as unknown as Record<string, unknown>).visibilityState;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  // A dialog the test left open belongs to the next render otherwise.
  for (const dialog of document.querySelectorAll('dialog')) dialog.remove();
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
  throw new Error(`timed out waiting for ${what}; the card: ${document.querySelector('[data-open-card]')?.outerHTML.slice(0, 3000) ?? 'none'}`);
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

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
const card = (el: ParentNode, key: string) => el.querySelector<HTMLButtonElement>(`.ib-bcard[data-card-id="${board.ids[key]}"]`);
const dialog = () => document.querySelector<HTMLElement>('[data-open-card]');
const click = (el: Element | null) => act(() => (el as HTMLElement).click());
/** Press a button in the open card once it is enabled (its buttons wait while a move is out). */
async function press(selector: string) {
  await until(() => {
    const button = dialog()?.querySelector<HTMLButtonElement>(selector);
    return !!button && !button.disabled;
  }, `${selector} enabled`);
  click(dialog()!.querySelector(selector));
}

test.skipIf(!hasDom)('five lanes in order; each card is two lines and an age; the header sums and links; the sidebar counts what is on you', async () => {
  const el = await renderApp('#board');
  await until(() => card(el, 'portless') !== null, 'the Board');
  expect([...el.querySelectorAll('.ib-lane-l')].map((l) => l.textContent)).toEqual(['Asked', 'Designing', 'Your look', 'Building', 'Your review']);
  expect([...el.querySelectorAll('[data-lane]')].map((l) => text(l.querySelector('.ib-lane-h .ib-n')))).toEqual(['3', '2', '4', '3', '4']);
  // "on you" marks the person's two lanes only.
  expect([...el.querySelectorAll('[data-lane] .ib-onyou')].map((o) => o.closest('[data-lane]')!.getAttribute('data-lane'))).toEqual(['your_look', 'your_review']);
  expect(text(el.querySelector('[data-board-sum]'))).toBe('16 in flight · 8 on you');
  expect(text(el.querySelector('[data-board-link="shipped"]'))).toBe('Shipped 3');
  expect(text(el.querySelector('[data-board-link="icebox"]'))).toBe('Icebox 4');
  // The sidebar's Board count: the 8 on you, plus the 2 drops an agent made that the person has not seen.
  expect(text(el.querySelector('[data-board-nav] [data-board-count]'))).toBe('10');
  expect(el.querySelector('[data-board-nav] [data-board-count]')!.getAttribute('aria-label')).toBe('8 on you, 2 dropped by an agent');

  // In the person's lanes, "You: …"; in the agents', the agent's last word.
  const portless = card(el, 'portless')!;
  expect(portless.closest('[data-lane]')!.getAttribute('data-lane')).toBe('your_look');
  expect(text(portless.querySelector('.ib-bcard-t'))).toBe('One fixed address for the Inbox (portless)');
  expect(text(portless.querySelector('.ib-bcard-l'))).toBe('You: Pick a dialog (three options in the thread); screenshots follow within the hour');
  expect(text(portless.querySelector('[data-card-age]'))).toBe('4d ago');
  const herdr = card(el, 'herdr')!;
  expect(text(herdr.querySelector('.ib-bcard-l'))).toBe('Triage the open PRs, then diffs-rs');
  expect(herdr.querySelector('.ib-bcard-l b')).toBeNull();
  expect(text(herdr.querySelector('[data-card-age]'))).toBe('3d ago');
  // The accessible name says the whole card, the age in words.
  expect(portless.getAttribute('aria-label')).toContain('Last heard 4 days ago.');
  // Shipped, the Icebox and Dropped are not lanes.
  expect(card(el, 'tabcount')).toBeNull();
  expect(card(el, 'triage')).toBeNull();
  expect(card(el, 'oldhero')).toBeNull();
  // No amber anywhere: nothing on the page is marked stalled or late.
  expect(el.querySelector('[data-amber], .ib-amber, [data-stalled]')).toBeNull();
});

test.skipIf(!hasDom)('an agent\'s drops show with their reasons until the person looks: Restore puts one back in one click, Got it clears the rest', async () => {
  const el = await renderApp('#board');
  await until(() => el.querySelector('[data-drop-notice]') !== null, 'the drop notice');
  const notice = el.querySelector('[data-drop-notice]')!;
  expect(text(notice.querySelector('h2'))).toBe('2 cards dropped by an agent');
  const cursors = notice.querySelector(`[data-drop-card="${board.ids.cursors}"]`)!;
  expect(text(cursors)).toContain('Pricing cursors follow-up');
  expect(text(cursors)).toContain('Claude Code: Not needed: PR 1120 brought the cursors back');
  // The person's own drop is never in it.
  expect(notice.querySelector(`[data-drop-card="${board.ids.oldhero}"]`)).toBeNull();

  // Restore: one click, the card is back where it was (Building), and it leaves the notice.
  click(notice.querySelector(`[data-restore="${board.ids.cursors}"]`));
  await until(async () => (await columnOf(board.ids.cursors)) === 'building', 'the card restored on the server');
  await until(() => card(el, 'cursors') !== null, 'the card back in its lane');
  expect(card(el, 'cursors')!.closest('[data-lane]')!.getAttribute('data-lane')).toBe('building');
  expect(text(el.querySelector('[data-drop-notice] h2'))).toBe('1 card dropped by an agent');
  expect(text(el.querySelector('[data-inbox-toast]'))).toContain('Back in Building');

  // Got it: the person has looked; the notice goes, the server says nothing is unseen.
  click(el.querySelector('[data-drop-notice-ok]'));
  await until(() => el.querySelector('[data-drop-notice]') === null, 'the notice gone');
  expect((await serverCards()).dropped_unseen).toBe(0);
  // The drop itself stays in Dropped.
  expect(await columnOf(board.ids.notify)).toBe('dropped');

  // Put the restored card back in Dropped for the tests after (the agent drops it again: unseen).
  expect((await command({ card: { id: board.ids.cursors, by: 'agent', column: 'dropped', reason: 'Not needed after all' } })).carded).toBe('dropped');
});

test.skipIf(!hasDom)('a tab in the background marks nothing: the Icebox page drawn while hidden waits until the person brings it forward', async () => {
  front.visible = false;
  front.focused = false;
  const el = await renderApp('#board=icebox');
  await until(() => el.querySelector('[data-board-group="dropped"]') !== null, 'the Icebox page');
  await settle(80);
  expect((await serverCards()).dropped_unseen).toBe(1);
  // Visible but without focus: still nothing.
  front.visible = true;
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  await settle(60);
  expect((await serverCards()).dropped_unseen).toBe(1);
  // In front: the drop it drew is seen. Put it back unseen for the next test (the agent drops it again).
  front.focused = true;
  act(() => window.dispatchEvent(new Event('focus')));
  await until(async () => (await serverCards()).dropped_unseen === 0, 'the drop seen once in front');
  await command({ card: { id: board.ids.cursors, by: 'person', restore: true } });
  expect((await command({ card: { id: board.ids.cursors, by: 'agent', column: 'dropped', reason: 'Not needed after all' } })).carded).toBe('dropped');
});

test.skipIf(!hasDom)('opening Dropped is looking: a new agent drop leaves the notice once the Icebox page shows it, with its reason', async () => {
  const el = await renderApp('#board');
  await until(() => text(el.querySelector('[data-drop-notice] h2')) === '1 card dropped by an agent', 'the agent drop in the notice');
  click(el.querySelector('[data-drop-notice-see]'));
  await until(() => el.querySelector('[data-board-page="icebox"]') !== null, 'the Icebox page');
  const dropped = el.querySelector('[data-board-group="dropped"]')!;
  expect(text(dropped.querySelector('h2'))).toBe('Dropped 3');
  expect(text(dropped)).toContain('Dropped by Claude Code');
  expect(text(dropped)).toContain('Not needed after all');
  expect(text(dropped)).toContain('Dropped by you');
  expect(text(dropped)).toContain('Replaced by the converge round');
  const icebox = el.querySelector('[data-board-group="icebox"]')!;
  expect(text(icebox)).toContain('Triage #1786 and #1787');
  expect(text(icebox)).toContain('from Your look');
  await until(async () => (await serverCards()).dropped_unseen === 0, 'the drops seen');

  // Back to the Board: no notice.
  click(el.querySelector('[data-board-back]'));
  await until(() => el.querySelector('[data-board-page="live"]') !== null, 'the Board again');
  await settle();
  expect(el.querySelector('[data-drop-notice]')).toBeNull();
});

test.skipIf(!hasDom)('the open card: its threads and PRs; Move to, Pause and Take out, each said in the card', async () => {
  const el = await renderApp('#board');
  await until(() => card(el, 'explorer') !== null, 'the Board');
  click(card(el, 'explorer'));
  await until(() => dialog() !== null, 'the open card');
  const open = dialog()!;
  expect(window.location.hash).toBe(`#board&card=${board.ids.explorer}`);
  expect(text(open.querySelector('h2'))).toBe('Code review explorer (4 stacked PRs and a sidebar)');
  expect(text(open.querySelector('.ib-cd-meta'))).toContain('Your review');
  expect(text(open.querySelector('.ib-cd-meta'))).toContain('plannotator');
  expect(text(open.querySelector('[data-card-line]'))).toBe("You: Merge the stack, or say what's missing; a local build of all four runs on :64606 and the sidebar PR is the last one");
  // Its thread, named by its subject and where it sits in the list.
  const thread = open.querySelector<HTMLButtonElement>('[data-card-thread]')!;
  expect(text(thread)).toContain('The explorer stack is ready for your look');
  expect(text(thread)).toContain('New since you looked');
  // Its PRs, each a link to the PR.
  expect([...open.querySelectorAll('[data-card-pr]')].map((a) => (a as HTMLAnchorElement).getAttribute('href'))).toEqual([
    'https://github.com/backnotprop/plannotator/pull/1964',
    'https://github.com/backnotprop/plannotator/pull/1966',
    'https://github.com/backnotprop/plannotator/pull/1969',
    'https://github.com/backnotprop/plannotator/pull/1976',
  ]);
  expect(open.querySelector('[data-card-move="your_review"]')!.getAttribute('aria-pressed')).toBe('true');
  // The status line is in the card from the start, empty and not hidden, so the first move's words are announced.
  const status = open.querySelector<HTMLElement>('[data-card-note]')!;
  expect(status.getAttribute('role')).toBe('status');
  expect(status.hidden).toBe(false);
  expect(status.textContent).toBe('');

  // Move to Building.
  click(open.querySelector('[data-card-move="building"]'));
  await until(async () => (await columnOf(board.ids.explorer)) === 'building', 'the move on the server');
  await until(() => dialog()?.querySelector('[data-card-move="building"]')?.getAttribute('aria-pressed') === 'true', 'the open card moved');
  // Said in the card itself (the modal covers the window's toast).
  expect(text(dialog()!.querySelector('[data-card-note]'))).toBe('Moved to Building.');
  // The same element took the words (a new one would not be announced).
  expect(dialog()!.querySelector('[data-card-note]')).toBe(status);

  // Pause: the Icebox, with Undo.
  await press('[data-card-icebox]');
  await until(async () => (await columnOf(board.ids.explorer)) === 'icebox', 'paused on the server');
  await until(() => dialog()?.querySelector('[data-card-state="icebox"]') !== null, 'the open card paused');
  expect(text(dialog()!.querySelector('[data-card-note]'))).toBe('Paused: it is in the Icebox. Take out puts it back.');
  await press('[data-card-restore]');
  await until(async () => (await columnOf(board.ids.explorer)) === 'building', 'Take out puts it back');
});

test.skipIf(!hasDom)('the open card: Escape leaves the drop form; Drop with a reason closes the form; Restore brings back its actions; a thread opens', async () => {
  await renderApp(`#board&card=${board.ids.explorer}`);
  await until(() => dialog() !== null, 'the open card');
  // Escape in the reason field steps back: the form closes, the card stays open, focus on Drop.
  // (Enabled once the Take out has answered: the card's buttons wait while a move is out.)
  await until(() => dialog()?.querySelector<HTMLButtonElement>('[data-card-drop]')?.disabled === false, 'Drop offered again');
  await press('[data-card-drop]');
  await until(() => dialog()?.querySelector('[data-card-drop-form] input') !== null, 'the drop form');
  act(() => {
    dialog()!.querySelector('[data-card-drop-form] input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
  await until(() => dialog()?.querySelector('[data-card-drop-form]') === null, 'the form closed by Escape');
  expect(dialog()).not.toBeNull();
  await until(() => document.activeElement === dialog()?.querySelector('[data-card-drop]'), 'focus back on Drop');

  // Drop, with a reason the person writes.
  await until(() => dialog()?.querySelector<HTMLButtonElement>('[data-card-drop]')?.disabled === false, 'Drop enabled');
  await press('[data-card-drop]');
  const input = dialog()!.querySelector<HTMLInputElement>('[data-card-drop-form] input')!;
  act(() => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    set.call(input, 'Splitting it into smaller cards');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await press('[data-card-drop-confirm]');
  await until(async () => (await columnOf(board.ids.explorer)) === 'dropped', 'dropped on the server');
  const dropped = (await serverCards()).cards.find((c) => c.id === board.ids.explorer)!;
  expect(dropped.dropped).toMatchObject({ reason: 'Splitting it into smaller cards', by: { kind: 'person' } });
  // The person's own drop never reaches the notice.
  expect((await serverCards()).dropped_unseen).toBe(0);
  // The drop went through: the form is gone (no second Drop card to press), the card shows it dropped.
  await until(() => dialog()?.querySelector('[data-card-state="dropped"]') !== null, 'the open card dropped');
  // (Compared as booleans: a failing match on an element would print the whole DOM.)
  expect(dialog()!.querySelector('[data-card-drop-form]') === null).toBe(true);
  expect(dialog()!.querySelector('[data-card-drop-confirm]') === null).toBe(true);
  expect(dialog()!.querySelector('[data-card-note]')!.getAttribute('role')).toBe('status');
  expect(text(dialog()!.querySelector('[data-card-note]'))).toBe('Dropped. Restore puts it back.');

  // Restore from the open card: back where it was.
  await until(() => dialog()?.querySelector('[data-card-restore]') !== null, 'Restore offered');
  await press('[data-card-restore]');
  await until(async () => (await columnOf(board.ids.explorer)) === 'building', 'restored');
  // Back in a lane: Ask, Pause and Drop are offered again.
  await until(() => dialog()?.querySelector('[data-card-icebox]') !== null, 'Pause offered again');
  expect(dialog()!.querySelector('[data-card-ask]')).not.toBeNull();
  expect(dialog()!.querySelector('[data-card-drop]')).not.toBeNull();

  // Opening a thread from the card goes to the thread.
  await until(() => dialog()?.querySelector('[data-card-thread]') !== null, 'the thread again');
  await press('[data-card-thread]');
  await until(() => window.location.hash.startsWith('#thread='), 'the thread route');
  await until(() => document.querySelector('[data-open-card]') === null, 'the card closed');
});

test.skipIf(!hasDom)('Ask where this is: nobody running says so; with the card\'s agent live, a message to it names the card', async () => {
  const el = await renderApp(`#board&card=${board.ids.portless}`);
  await until(() => dialog() !== null, 'the open card');
  await settle(80);
  const ask = dialog()!.querySelector<HTMLButtonElement>('[data-card-ask]')!;
  expect(ask.disabled).toBe(true);
  expect(text(dialog()!.querySelector('[data-card-ask-note]'))).toBe('No agent is running in plannotator now, so there is no one to ask.');

  // The card's own agent session polls the Inbox: it is live.
  await command({ poll: { session: 'ses_cc_portless', body: { project_path: board.projects.plannotator, started_at: Date.now() - 60_000 } } });
  await until(() => dialog()?.querySelector<HTMLButtonElement>('[data-card-ask]')?.disabled === false, 'Ask enabled');
  await press('[data-card-ask]');
  await until(() => document.querySelector('[data-open-card]') === null && document.querySelector('textarea') !== null, 'compose open');
  const body = document.querySelector<HTMLTextAreaElement>('dialog textarea')!;
  expect(body.value).toContain('One fixed address for the Inbox (portless)');
  expect(body.value).toContain(board.ids.portless);
  // To is the card's own agent session.
  await until(() => text(el.ownerDocument.querySelector('dialog')).includes('Claude Code'), 'To filled with the card\'s agent');
});

test.skipIf(!hasDom)('closing the card after a move puts focus on the card in its new lane; after a Pause, on the Board heading', async () => {
  const el = await renderApp('#board');
  await until(() => card(el, 'vite') !== null, 'the Board');
  click(card(el, 'vite'));
  await until(() => dialog() !== null, 'the open card');
  await press('[data-card-move="designing"]');
  await until(() => card(el, 'vite')?.closest('[data-lane]')?.getAttribute('data-lane') === 'designing', 'the card in Designing');
  await press('[data-card-close]');
  await until(() => document.querySelector('[data-open-card]') === null, 'the card closed');
  await settle();
  expect(document.activeElement).toBe(card(el, 'vite'));
  expect(document.activeElement).not.toBe(document.body);

  click(card(el, 'vite'));
  await until(() => dialog() !== null, 'the card again');
  await press('[data-card-icebox]');
  await until(() => dialog()?.querySelector('[data-card-state="icebox"]') !== null, 'paused');
  await press('[data-card-close]');
  await until(() => document.querySelector('[data-open-card]') === null, 'the card closed');
  await settle();
  expect(document.activeElement).toBe(el.querySelector('.ib-board .ib-bhead h1'));
  // Put it back for the tests after.
  await command({ card: { id: board.ids.vite, by: 'person', restore: true } });
  await command({ card: { id: board.ids.vite, by: 'agent', column: 'building' } });
});

test.skipIf(!hasDom)('Ask where this is, when the card\'s own agent has ended: the card says it asks another session in its project', async () => {
  // A Claude Code session is live in plannotator (the test before polled one); the caret card's own session is not.
  await command({ poll: { session: 'ses_cc_other', body: { project_path: board.projects.plannotator, started_at: Date.now() - 60_000 } } });
  await renderApp(`#board&card=${board.ids.caret}`);
  await until(() => dialog()?.querySelector('[data-card-ask-other]') !== null, 'the note');
  expect(text(dialog()!.querySelector('[data-card-ask-other]'))).toBe("Its agent's session ended; this asks another Claude Code session in plannotator.");
  expect(dialog()!.querySelector<HTMLButtonElement>('[data-card-ask]')!.disabled).toBe(false);
});
