/**
 * The project menu as the window draws it (design record
 * "inbox-project-menu", approved 2026-10-14): the whole window (InboxApp)
 * over a REAL Inbox server in a temp data dir (its own process,
 * tests/helpers/inbox-dom-server.ts), the window's fetches carried to it
 * over loopback. What is proved: ⋯ and a right-click open the same menu, its
 * two items, Mark all as read greyed out when nothing waits, Mark all as
 * read and Archive all with their toast and one Undo (the button and `Z`),
 * a project with nothing listed leaving the sidebar (the one the list shows
 * staying, with its empty state, until the person leaves it) and coming
 * back with the next agent message, and the phone's always-shown ⋯ and
 * sheet.
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
import type { InboxListSection } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { InboxApp } = (hasDom ? await import('./App') : {}) as typeof import('./App');
const { PHONE_QUERY } = (hasDom ? await import('./phone') : {}) as typeof import('./phone');

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');

let child: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;
type World = { project: string; stopped: string; waiting: string; mixed: string; same: string; picked: string; filed: string };
let worlds: World[] = [];
let ids: World;
let dir: string | null = null;
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedEventSource: unknown;
let savedMatchMedia: typeof window.matchMedia;
let phone = false;
let posted: { path: string; body: Record<string, unknown> }[] = [];
let agentLines: ReadableStreamDefaultReader<Uint8Array> | null = null;

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

async function serverSections(): Promise<Map<string, string>> {
  const model = JSON.parse((await loopback('/api/inbox/threads')).text) as { sections: InboxListSection[] };
  return new Map(model.sections.flatMap((s) => s.threads.map((r) => [r.thread_id, s.id] as const)));
}

/** An agent writes, as the server's stdin command does. */
async function agentWrites(project: string, body: string, replyTo?: string): Promise<void> {
  const stdin = child!.stdin as import('bun').FileSink;
  stdin.write(`${JSON.stringify({ send: { project, session: 'ses_back', body, ...(replyTo ? { reply_to: replyTo } : {}) } })}\n`);
  await stdin.flush();
  let line = '';
  while (!line.includes('\n')) {
    const { value, done } = await agentLines!.read();
    if (done) throw new Error('the Inbox stopped');
    line += new TextDecoder().decode(value);
  }
}

const TESTS = 9;

beforeAll(async () => {
  if (!hasDom) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-projmenu-dom-')));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(dir, 'bin', 'tailscale'), 0o755);
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), String(TESTS)], {
    env: { ...process.env, DOM_TESTS: '0', PLANNOTATOR_DATA_DIR: join(dir, 'data'), HOME: dir, PATH: `${join(dir, 'bin')}:${process.env.PATH}` },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
  });
  agentLines = (child.stdout as ReadableStream<Uint8Array>).getReader();
  let line = '';
  while (!line.includes('\n')) {
    const { value, done } = await agentLines.read();
    if (done) throw new Error('the Inbox did not start');
    line += new TextDecoder().decode(value);
  }
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
  phone = false;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? String(init.body) : undefined;
    if (method === 'POST') posted.push({ path, body: body ? JSON.parse(body) : {} });
    const answer = await loopback(path, method, body);
    return new Response(answer.text, { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  savedEventSource = (globalThis as Record<string, unknown>).EventSource;
  (globalThis as Record<string, unknown>).EventSource = class {
    addEventListener() {}
    close() {}
  };
  savedMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    media: query,
    matches: query === PHONE_QUERY ? phone : false,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
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
  window.matchMedia = savedMatchMedia;
  document.body.innerHTML = '';
});

async function until(check: () => boolean | Promise<boolean>, what: string) {
  for (let i = 0; i < 100; i++) {
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
  // The projects, or (every project hidden) the line that says where they went.
  await until(() => !!document.querySelector('.ib-projrow, [data-projects-hidden]'), 'the sidebar');
}

const projectRow = (id = ids.project) => document.querySelector<HTMLElement>(`.ib-projrow[data-project="${id}"]`);
const menu = () => document.querySelector<HTMLElement>(`[data-project-menu="${ids.project}"]`);
const item = (action: 'read' | 'archive') => menu()?.querySelector<HTMLElement>(`[data-project-action="${action}"]`) ?? null;

/** Base UI opens on the pointer's press, as a person's click does. */
async function press(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    el.click();
  });
}

async function openMenu() {
  const more = projectRow()!.querySelector<HTMLElement>('.ib-pmore')!;
  await press(more);
  await until(() => !!menu(), 'the menu');
}

async function choose(action: 'read' | 'archive') {
  const el = item(action)!;
  await act(async () => {
    el.click();
  });
}

const toast = () => document.querySelector<HTMLElement>('[data-inbox-toast]');
/** The project's name as the sidebar shows it (billing-N: one world per test). */
const projectName = () => projectRow()!.querySelector('.ib-name')!.textContent!;

test.skipIf(!hasDom)('⋯ is a real button beside the row, named for the project, and opens the two items', async () => {
  await renderApp();
  const row = projectRow()!;
  const open = row.querySelector<HTMLButtonElement>('.ib-proj')!;
  const more = row.querySelector<HTMLButtonElement>('.ib-pmore')!;
  // Two buttons side by side, never one inside the other.
  expect(open.contains(more)).toBe(false);
  expect(more.getAttribute('aria-label')).toBe(`${projectName()} options`);
  expect(more.getAttribute('aria-haspopup')).toBe('menu');
  await openMenu();
  expect(more.getAttribute('aria-expanded')).toBe('true');
  expect(row.hasAttribute('data-menu')).toBe(true);
  const items = [...menu()!.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent?.trim());
  expect(items).toEqual(['Mark all as read', 'Archive all']);
  expect(item('read')!.hasAttribute('data-disabled')).toBe(false);
});

test.skipIf(!hasDom)('a right-click on the row opens the same menu', async () => {
  await renderApp();
  const row = projectRow()!;
  await act(async () => {
    row.querySelector('.ib-proj')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 200 }));
  });
  await until(() => !!menu(), 'the context menu');
  expect([...menu()!.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent?.trim())).toEqual(['Mark all as read', 'Archive all']);
});

test.skipIf(!hasDom)('Mark all as read: one batch, the warning toast, and one Undo (Z) puts every thread back', async () => {
  await renderApp();
  const before = await serverSections();
  const name = projectName();
  await openMenu();
  await choose('read');
  await until(() => !!toast(), 'the toast');
  const call = posted.find((p) => p.path === `/api/inbox/projects/${ids.project}/read`)!;
  expect(typeof call.body.batch_id).toBe('string');
  // An agent was stopped on one of them: the warning, and no Reply (several threads).
  expect(toast()!.textContent).toContain('Marked 6 threads read');
  // The warning is the whole detail (one line); the project rides only the live region.
  expect(toast()!.querySelector('.ib-tdetail')?.textContent).toBe('Claude Code was stopped');
  await until(() => (document.querySelector('[data-inbox-live]')?.textContent ?? '').startsWith(`Marked 6 threads read in ${name}. Claude Code was stopped.`), 'the live region names the project');
  expect(toast()!.querySelector('[data-toast-reply]')).toBeNull();
  const after = await serverSections();
  for (const id of [ids.stopped, ids.waiting, ids.mixed, ids.same, ids.picked, ids.filed]) expect(after.get(id)).toBe('quiet');
  // Nothing waits there now: the item greys out.
  await openMenu();
  expect(item('read')!.hasAttribute('data-disabled')).toBe(true);
  await act(async () => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', bubbles: true }));
  });
  await until(() => posted.some((p) => p.path === `/api/inbox/projects/${ids.project}/unread`), 'the Undo');
  const undo = posted.find((p) => p.path === `/api/inbox/projects/${ids.project}/unread`)!;
  expect(new Set(undo.body.threads as string[])).toEqual(new Set([ids.stopped, ids.waiting, ids.mixed, ids.same, ids.picked, ids.filed]));
  await until(async () => {
    const now = await serverSections();
    return [...before].every(([id, section]) => now.get(id) === section);
  }, 'every thread back');
});

test.skipIf(!hasDom)('Archive all hides the project; the toast Undo brings it back', async () => {
  await renderApp();
  const name = projectName();
  await openMenu();
  await choose('archive');
  await until(() => !!toast(), 'the toast');
  expect(toast()!.textContent).toContain('Archived 6 threads');
  await until(() => (document.querySelector('[data-inbox-live]')?.textContent ?? '').startsWith(`Archived 6 threads in ${name}.`), 'the live region names the project');
  await until(() => projectRow() === null, 'the project to leave the sidebar');
  // Focus never falls to the page.
  expect(document.activeElement).not.toBe(document.body);
  await act(async () => {
    toast()!.querySelector<HTMLButtonElement>('[data-toast-undo]')!.click();
  });
  await until(() => projectRow() !== null, 'the project back');
  const now = await serverSections();
  expect(now.get(ids.stopped)).toBe('stopped');
});

test.skipIf(!hasDom)('the project the list shows stays while the person is there, says why it is empty, and leaves once they go', async () => {
  await renderApp(`#project=${ids.project}`);
  const name = projectName();
  await openMenu();
  await choose('archive');
  await until(() => !!document.querySelector('[data-project-archived]'), 'the empty state');
  expect(document.querySelector('[data-project-archived]')!.textContent).toContain(`Everything in ${name} is archived.`);
  expect(projectRow()!.hasAttribute('data-held')).toBe(true);
  const inbox = [...document.querySelectorAll<HTMLButtonElement>('.ib-nav')].find((b) => b.textContent?.includes('Inbox'))!;
  await act(async () => {
    inbox.click();
  });
  await until(() => projectRow() === null, 'the project to leave');
});

test.skipIf(!hasDom)('a hidden project comes back with the next agent message there', async () => {
  await renderApp();
  await openMenu();
  await choose('archive');
  await until(() => projectRow() === null, 'the project to leave');
  act(() => root?.unmount());
  host?.remove();
  await agentWrites(ids.project, 'One more question came up.', ids.waiting);
  await renderApp();
  expect(projectRow()).not.toBeNull();
});

test.skipIf(!hasDom)('with a thread open the list holds still: Mark all as read shows each row read in place, and Archive all keeps the rows until the thread closes', async () => {
  await renderApp(`#thread=${ids.waiting}`);
  await until(() => !!document.querySelector('section.ib-pane'), 'the thread');
  const placed = () =>
    [...document.querySelectorAll('.ib-listcol [data-row]')].map((el) => [el.getAttribute('data-row'), el.closest('[data-section-id]')?.getAttribute('data-section-id')]);
  const before = placed();
  await openMenu();
  await choose('read');
  await until(() => !!toast(), 'the toast');
  // The person's own write: nothing moved on screen while the thread is open.
  expect(placed()).toEqual(before);
  expect((await serverSections()).get(ids.stopped)).toBe('quiet');
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', bubbles: true }));
  });
  await until(async () => (await serverSections()).get(ids.stopped) === 'stopped', 'the Undo');
  await openMenu();
  await choose('archive');
  await until(() => !!toast() && toast()!.textContent!.includes('Archived'), 'the archive toast');
  // Still on screen, shown archived, while the thread is open (the list is the Inbox, not this project:
  // the project itself leaves the sidebar, as it is not the list's filter).
  const archivedRow = document.querySelector(`.ib-listcol [data-row="${ids.stopped}"]`);
  expect(archivedRow).not.toBeNull();
  expect(archivedRow!.textContent).toContain('Archived');
  await until(() => projectRow() === null, 'the project to leave the sidebar');
});

test.skipIf(!hasDom)('with every project hidden the sidebar says where they went', async () => {
  // Archive every remaining world's project, this one included.
  for (const w of [ids, ...worlds]) await loopback(`/api/inbox/projects/${w.project}/resolve`, 'POST', JSON.stringify({ resolved: true }));
  const others = JSON.parse((await loopback('/api/inbox/projects')).text) as { projects: { id: string; listed: number }[] };
  for (const p of others.projects) if (p.listed > 0) await loopback(`/api/inbox/projects/${p.id}/resolve`, 'POST', JSON.stringify({ resolved: true }));
  await renderApp();
  await until(() => !!document.querySelector('[data-projects-hidden]'), 'the empty line');
  expect(document.querySelector('[data-projects-hidden]')!.textContent).toBe('Nothing open. Archived projects are in Settings → Archived.');
  // Leave the rest for the phone test: bring this world back.
  await loopback(`/api/inbox/projects/${ids.project}/resolve`, 'POST', JSON.stringify({ resolved: false, threads: { resolved: [ids.stopped, ids.waiting, ids.mixed, ids.same, ids.picked, ids.filed], read: [] } }));
  worlds.unshift(ids);
});

test.skipIf(!hasDom)('a phone: ⋯ always shown on every row, the menu a sheet titled by the project', async () => {
  phone = true;
  window.location.hash = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<InboxApp />);
  });
  // The navigation is a sheet on a phone: open it.
  await until(() => !!document.querySelector('[data-sidebar="trigger"]'), 'the trigger');
  const trigger = document.querySelector<HTMLButtonElement>('[data-sidebar="trigger"]')!;
  await act(async () => {
    trigger.click();
  });
  await until(() => !!projectRow(), 'the project row in the sheet');
  await openMenu();
  const positioner = menu()!.closest('.ib-pm-pos')!;
  expect(positioner.hasAttribute('data-phone')).toBe(true);
  expect(menu()!.querySelector('.ib-pm-title')!.textContent).toBe(projectRow()!.querySelector('.ib-name')!.textContent);
  // The popup is named by the project; the title is for the eye only.
  expect(menu()!.querySelector('.ib-pm-title')!.getAttribute('aria-hidden')).toBe('true');
  expect(menu()!.getAttribute('aria-label')).toBe(projectRow()!.querySelector('.ib-name')!.textContent);
});

test.skipIf(!hasDom)('every project hidden with nothing archived (threads deleted): the line does not send the person to Settings → Archived', async () => {
  const { Sidebar } = await import('./components/Sidebar');
  const { SidebarProvider } = await import('./shell/sidebar');
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  const folder = { id: 'prj_gone', key: 'gone-abc123', name: 'gone', root: '/tmp/gone', created_at: '2026-10-14T10:00:00.000Z', threads: 0, unread: 0, listed: 0, archived: 0 };
  const noop = () => {};
  const draw = (archived: number) =>
    act(() =>
      root!.render(
        <SidebarProvider>
          <Sidebar page="inbox" projectId={null} inboxCount={0} projects={[{ ...folder, archived }]} projectCounts={new Map()} update={null} restarting={false} updated={null} onInbox={noop} onProject={noop} onSettings={noop} onUpdate={noop} onWhatsNew={noop} onProjectAction={noop} />
        </SidebarProvider>,
      ),
    );
  root = createRoot(host);
  draw(0);
  expect(document.querySelector('[data-projects-hidden]')!.textContent).toBe('Nothing open.');
  draw(2);
  expect(document.querySelector('[data-projects-hidden]')!.textContent).toBe('Nothing open. Archived projects are in Settings → Archived.');
});
