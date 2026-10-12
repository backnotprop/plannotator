/**
 * The Decisions page's project switch (DecisionsProjectPicker), as the window
 * draws it: the whole window (InboxApp) over a REAL Inbox server in a temp
 * data dir (its own process, tests/helpers/inbox-dom-server.ts), the window's
 * fetches carried to it over loopback. Three projects are seeded through the
 * window's own routes: billing-0 with two questions waiting on a decision and
 * one decision settled at Send, billing-1 with nothing to decide, billing-2
 * with one question waiting. What is proved: every project's counts come
 * from the server and show in the list (and the current project's on the
 * button), keyboard selection moves the route, Escape and a pick hand focus
 * back to the button, and a press outside closes the list.
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

type World = { project: string; stopped: string; waiting: string };
let child: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;
let worlds: World[] = [];
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

async function post(path: string, body: Record<string, unknown>) {
  const answer = await loopback(path, 'POST', JSON.stringify(body));
  if (answer.status !== 200) throw new Error(`${path}: ${answer.status} ${answer.text}`);
  return JSON.parse(answer.text);
}

async function questions(messageId: string): Promise<InboxQuestion[]> {
  const model = JSON.parse((await loopback(`/api/inbox/threads/${messageId}`)).text) as { thread: { messages: { id: string; questions?: InboxQuestion[] }[] } };
  return model.thread.messages.find((m) => m.id === messageId)?.questions ?? [];
}

beforeAll(async () => {
  if (!hasDom) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-decisions-picker-dom-')));
  // Never the real tailscale, never the real data dir.
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(dir, 'bin', 'tailscale'), 0o755);
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), '3'], {
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

  // billing-0: both stopped questions record a decision (2 waiting); the waiting question is answered and sent with its switch on (1 settled).
  for (const q of await questions(worlds[0]!.stopped)) await post(`/api/inbox/messages/${worlds[0]!.stopped}/decision`, { key: q.key, recording: true });
  const [ask] = await questions(worlds[0]!.waiting);
  await post(`/api/inbox/messages/${worlds[0]!.waiting}/decision`, { key: ask!.key, recording: true });
  await post(`/api/inbox/messages/${worlds[0]!.waiting}/picks`, {
    questions: [{ key: ask!.key, revision: ask!.revision, answer: { v: 1, key: ask!.key, kind: ask!.kind, prompt: ask!.prompt, selected: ['Pagefind'] } }],
  });
  await post(`/api/inbox/messages/${worlds[0]!.waiting}/reply`, { idempotency_key: 'picker-send', questions: [{ key: ask!.key, revision: ask!.revision + 1 }] });
  // billing-2: one question waiting.
  const [two] = await questions(worlds[2]!.waiting);
  await post(`/api/inbox/messages/${worlds[2]!.waiting}/decision`, { key: two!.key, recording: true });
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

async function renderDecisions(projectId: string) {
  window.location.hash = `#decisions=${projectId}`;
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<InboxApp />);
  });
  const el = host;
  await until(() => (el.querySelector('[data-project-picker-trigger]')?.getAttribute('aria-label') ?? '').includes(', '), 'the switch with its counts');
  return el;
}

const trigger = (el: HTMLElement) => el.querySelector('[data-project-picker-trigger]') as HTMLButtonElement;
const list = (el: HTMLElement) => el.querySelector('[role="listbox"]') as HTMLElement | null;
const option = (el: HTMLElement, projectId: string) => el.querySelector(`[data-project-option="${projectId}"]`) as HTMLElement;
/** A primary pointer press as a browser makes it: pointerdown, pointerup, then the click (detail 1), in one task. */
const primaryPress = (target: HTMLElement) => {
  target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, buttons: 1 }));
  target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
  target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
};
const press = (target: HTMLElement, key: string) =>
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });

test.skipIf(!hasDom)("the switch names the project and its counts, and the list shows every project's folder and counts from the server", async () => {
  const el = await renderDecisions(worlds[0]!.project);
  expect(trigger(el).getAttribute('aria-label')).toBe('Project: billing-0, 2 waiting · 1 settled');
  expect(trigger(el).getAttribute('aria-haspopup')).toBe('listbox');
  expect(trigger(el).getAttribute('aria-expanded')).toBe('false');
  // The Waiting and Settled groups agree with the switch's counts.
  await until(() => el.querySelectorAll('[data-decision-group="settled"] [data-decision-id]').length === 1, 'the settled decision');
  expect(el.querySelectorAll('[data-decision-group="waiting"] [data-waiting-question]')).toHaveLength(2);

  act(() => trigger(el).click());
  expect(trigger(el).getAttribute('aria-expanded')).toBe('true');
  expect(trigger(el).getAttribute('aria-controls')).toBe(list(el)!.id);
  const options = [...list(el)!.querySelectorAll('[role="option"]')];
  // The sidebar's order (the store's), every project.
  expect(options.map((o) => o.getAttribute('data-project-option'))).toEqual(worlds.map((w) => w.project));
  expect(option(el, worlds[0]!.project).getAttribute('aria-label')).toBe('billing-0, ~/projects/billing-0, 2 waiting · 1 settled');
  expect(option(el, worlds[1]!.project).getAttribute('aria-label')).toBe('billing-1, ~/projects/billing-1, No decisions yet');
  expect(option(el, worlds[2]!.project).getAttribute('aria-label')).toBe('billing-2, ~/projects/billing-2, 1 waiting');
  // What a sighted reader sees: the counts drawn per row, the folder muted under the name.
  expect(option(el, worlds[0]!.project).querySelector('[data-count="waiting"]')?.textContent).toBe('2 waiting');
  expect(option(el, worlds[0]!.project).querySelector('[data-count="settled"]')?.textContent).toBe('1 settled');
  expect(option(el, worlds[1]!.project).textContent).toContain('No decisions yet');
  expect(option(el, worlds[2]!.project).querySelector('[data-count="settled"]')).toBeNull();
  expect(option(el, worlds[2]!.project).querySelector('.ib-ppick-p')?.textContent).toBe('~/projects/billing-2');
  // The current project is checked and takes focus.
  expect(option(el, worlds[0]!.project).getAttribute('aria-selected')).toBe('true');
  expect(options.filter((o) => o.getAttribute('aria-selected') === 'true')).toHaveLength(1);
  expect(document.activeElement).toBe(option(el, worlds[0]!.project));
});

test.skipIf(!hasDom)('the keyboard: arrows, Home, End and type-ahead move; Enter picks, the route follows and focus returns to the button', async () => {
  const el = await renderDecisions(worlds[0]!.project);
  trigger(el).focus();
  press(trigger(el), 'ArrowDown');
  expect(list(el)).not.toBeNull();
  expect(document.activeElement).toBe(option(el, worlds[0]!.project));
  press(document.activeElement as HTMLElement, 'ArrowDown');
  expect(document.activeElement).toBe(option(el, worlds[1]!.project));
  press(document.activeElement as HTMLElement, 'End');
  expect(document.activeElement).toBe(option(el, worlds[2]!.project));
  press(document.activeElement as HTMLElement, 'ArrowDown');
  expect(document.activeElement).toBe(option(el, worlds[2]!.project));
  press(document.activeElement as HTMLElement, 'Home');
  expect(document.activeElement).toBe(option(el, worlds[0]!.project));
  // Type-ahead: "billing-1" typed quickly lands on billing-1.
  for (const key of 'billing-1') press(document.activeElement as HTMLElement, key);
  expect(document.activeElement).toBe(option(el, worlds[1]!.project));
  press(document.activeElement as HTMLElement, 'ArrowDown');
  press(document.activeElement as HTMLElement, 'Enter');
  expect(list(el)).toBeNull();
  expect(window.location.hash).toBe(`#decisions=${worlds[2]!.project}`);
  expect(document.activeElement).toBe(trigger(el));
  await until(() => trigger(el).getAttribute('aria-label') === 'Project: billing-2, 1 waiting', 'billing-2 on the button');
  expect(el.querySelector('.ib-dsub')?.textContent).toContain('billing-2');
});

test.skipIf(!hasDom)('Escape closes the list without a change and puts focus back on the button; a press outside closes it too', async () => {
  const el = await renderDecisions(worlds[1]!.project);
  expect(trigger(el).getAttribute('aria-label')).toBe('Project: billing-1, No decisions yet');
  act(() => trigger(el).click());
  press(document.activeElement as HTMLElement, 'ArrowDown');
  expect(document.activeElement).toBe(option(el, worlds[2]!.project));
  press(document.activeElement as HTMLElement, 'Escape');
  expect(list(el)).toBeNull();
  expect(document.activeElement).toBe(trigger(el));
  expect(trigger(el).getAttribute('aria-expanded')).toBe('false');
  expect(window.location.hash).toBe(`#decisions=${worlds[1]!.project}`);

  act(() => trigger(el).click());
  expect(list(el)).not.toBeNull();
  act(() => {
    el.querySelector('.ib-dsub')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  });
  expect(list(el)).toBeNull();
  expect(window.location.hash).toBe(`#decisions=${worlds[1]!.project}`);

  // A click on a row picks it.
  act(() => trigger(el).click());
  act(() => option(el, worlds[0]!.project).click());
  expect(window.location.hash).toBe(`#decisions=${worlds[0]!.project}`);
  await until(() => trigger(el).getAttribute('aria-label') === 'Project: billing-0, 2 waiting · 1 settled', 'billing-0 on the button');
});

test.skipIf(!hasDom)('the press that closes the list never also opens what lay under it; the next press works as usual', async () => {
  const el = await renderDecisions(worlds[0]!.project);
  await until(() => el.querySelector('[data-decision-group="settled"] [data-decision-id]') !== null, 'the settled decision');
  const row = () => el.querySelector('[data-decision-group="settled"] [data-decision-id]') as HTMLButtonElement;
  act(() => trigger(el).click());
  expect(list(el)).not.toBeNull();
  // A real press: pointerdown, pointerup, then the pointer's click (detail 1) on the same row, in one task.
  act(() => primaryPress(row()));
  expect(list(el)).toBeNull();
  expect(window.location.hash).toBe(`#decisions=${worlds[0]!.project}`);
  expect(el.querySelector('[data-decision-pane]')).toBeNull();
  // The list is closed now: the next press opens the decision.
  act(() => primaryPress(row()));
  expect(window.location.hash).toContain('&decision=dec_');
});

test.skipIf(!hasDom)('a press that makes no click (a right click, a cancelled touch) never eats a later keyboard click', async () => {
  const el = await renderDecisions(worlds[0]!.project);
  await until(() => el.querySelector('[data-decision-group="waiting"] [data-waiting-question] button') !== null, 'the waiting rows');
  const openButton = () => el.querySelector('[data-decision-group="waiting"] [data-waiting-question] button') as HTMLButtonElement;
  const sub = () => el.querySelector('.ib-dsub') as HTMLElement;

  // A right click outside: pointerdown with the secondary button, then contextmenu, no click.
  act(() => trigger(el).click());
  act(() => {
    sub().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 2, buttons: 2 }));
    sub().dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 2 }));
    sub().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
  });
  expect(list(el)).toBeNull();
  press(document.body, 'Escape');
  // Enter on a Waiting row's Open: the keyboard's click (detail 0) opens its thread on the first press.
  openButton().focus();
  act(() => openButton().click());
  expect(window.location.hash).toStartWith('#thread=');

  // A touch that turns into a scroll: pointerdown, pointercancel, no click. The swallower disarms on the next tick.
  window.location.hash = `#decisions=${worlds[0]!.project}`;
  await until(() => el.querySelector('[data-decision-group="waiting"] [data-waiting-question] button') !== null, 'the Decisions page again');
  act(() => trigger(el).click());
  act(() => {
    sub().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, buttons: 1 }));
    sub().dispatchEvent(new PointerEvent('pointercancel', { bubbles: true }));
  });
  expect(list(el)).toBeNull();
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
  // Even a pointer's click after that is not swallowed.
  act(() => {
    openButton().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
  });
  expect(window.location.hash).toStartWith('#thread=');
});

test.skipIf(!hasDom)("the browser's Back, or any route change, closes the list", async () => {
  const el = await renderDecisions(worlds[0]!.project);
  act(() => trigger(el).click());
  expect(list(el)).not.toBeNull();
  act(() => {
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  expect(list(el)).toBeNull();

  act(() => trigger(el).click());
  expect(list(el)).not.toBeNull();
  // The route moves to another project under the open list (as Back does on a phone).
  act(() => {
    window.history.replaceState(null, '', `#decisions=${worlds[2]!.project}`);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  await until(() => (trigger(el).getAttribute('aria-label') ?? '').startsWith('Project: billing-2'), 'billing-2 on the button');
  expect(list(el)).toBeNull();
});

test.skipIf(!hasDom)('type-ahead: the same letter again cycles through the projects it starts; a space while typing never picks', async () => {
  const el = await renderDecisions(worlds[0]!.project);
  act(() => trigger(el).click());
  expect(document.activeElement).toBe(option(el, worlds[0]!.project));
  press(document.activeElement as HTMLElement, 'b');
  expect(document.activeElement).toBe(option(el, worlds[1]!.project));
  press(document.activeElement as HTMLElement, 'b');
  expect(document.activeElement).toBe(option(el, worlds[2]!.project));
  press(document.activeElement as HTMLElement, 'b');
  expect(document.activeElement).toBe(option(el, worlds[0]!.project));
  // "b", then a space inside the window: part of a name being typed, not a pick.
  press(document.activeElement as HTMLElement, ' ');
  expect(list(el)).not.toBeNull();
  expect(window.location.hash).toBe(`#decisions=${worlds[0]!.project}`);
  // Once the typing has lapsed, Space picks again.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 700));
  });
  press(document.activeElement as HTMLElement, 'ArrowDown');
  press(document.activeElement as HTMLElement, ' ');
  expect(list(el)).toBeNull();
  expect(window.location.hash).toBe(`#decisions=${worlds[1]!.project}`);
});

test.skipIf(!hasDom)('on a phone the button carries one whole count, the name it all, and the sheet has a Close that hands focus back', async () => {
  const { DecisionsProjectPicker } = await import('./components/DecisionsProjectPicker');
  const projects = [
    { id: 'prj_a', key: 'a', name: 'billing-svc', root: '/home/me/src/billing-svc', created_at: '2026-10-01T00:00:00.000Z', threads: 1, unread: 0 },
    { id: 'prj_b', key: 'b', name: 'docs', root: '/home/me/src/docs', created_at: '2026-10-02T00:00:00.000Z', threads: 1, unread: 0 },
  ];
  const counts = new Map([
    ['prj_a', { project_id: 'prj_a', waiting: 12, settled: 31 }],
    ['prj_b', { project_id: 'prj_b', waiting: 0, settled: 4 }],
  ]);
  const picks: string[] = [];
  host = document.createElement('div');
  document.body.appendChild(host);
  const draw = (current: number) =>
    act(() => {
      root ??= createRoot(host!);
      root.render(<DecisionsProjectPicker projects={projects} current={projects[current]!} counts={counts} home="/home/me" phone onPick={(id) => picks.push(id)} />);
    });
  draw(0);
  const el = host;
  // The button shows "12 waiting" whole and drops the settled part; its name keeps both.
  expect(el.querySelector('.ib-ppick-tc')?.textContent).toBe('12 waiting');
  expect(trigger(el).getAttribute('aria-label')).toBe('Project: billing-svc, 12 waiting · 31 settled');
  draw(1);
  expect(el.querySelector('.ib-ppick-tc')?.textContent).toBe('4 settled');

  act(() => trigger(el).click());
  const sheet = el.querySelector('[data-project-sheet]') as HTMLElement;
  expect(sheet).not.toBeNull();
  // The Close sits in the sheet's head, outside the listbox (a listbox holds options only).
  const closeButton = sheet.querySelector('[data-project-sheet-close]') as HTMLButtonElement;
  expect(closeButton.getAttribute('aria-label')).toBe('Close the project list');
  expect(list(el)!.contains(closeButton)).toBe(false);
  expect(list(el)!.querySelectorAll('[role="option"]')).toHaveLength(2);
  // Tab moves between the list and Close, inside the sheet (Shift+Tab back); the sheet stays open.
  const selected = list(el)!.querySelector('[aria-selected="true"]') as HTMLElement;
  expect(document.activeElement).toBe(selected);
  press(selected, 'Tab');
  expect(document.activeElement).toBe(closeButton);
  act(() => {
    closeButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
  });
  expect(document.activeElement).toBe(selected);
  expect(el.querySelector('[data-project-sheet]')).not.toBeNull();
  act(() => closeButton.click());
  expect(el.querySelector('[data-project-sheet]')).toBeNull();
  expect(document.activeElement).toBe(trigger(el));
  expect(picks).toEqual([]);
});
