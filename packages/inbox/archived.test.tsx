/**
 * Archived threads out of the list, and Settings' Archived block (owner
 * ruling 2026-10-12): the whole window (InboxApp) over a REAL Inbox server in
 * a temp data dir (its own process, tests/helpers/inbox-dom-server.ts), the
 * window's fetches carried to it over loopback. What is proved: archiving the
 * open thread keeps its row in place (shown archived) until the person leaves
 * the thread, then the row is gone from every section; Settings lists it with
 * its project, agent and message count; Unarchive puts it back in the list
 * and opens it there; a deep link still opens an archived thread with
 * Unarchive in its foot; several projects group the rows under a header
 * per project (no dropdown); an agent's reply into an archived thread brings
 * it back to the list and out of the block; nothing archived says so.
 *
 * The tests share one server (the window keeps the first server session it
 * saw), so each archives its own world's threads and puts back what it took.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from the test.yml DOM list.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';

// Each test waits on another process's answers several times over.
setDefaultTimeout(20_000);
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const hasDom = typeof document !== 'undefined';
const { InboxApp } = (hasDom ? await import('./App') : {}) as typeof import('./App');

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');

type World = { project: string; stopped: string; waiting: string; mixed: string; filed: string };
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

/** Archive or unarchive a thread straight on the server (the thread id is its first message's). */
async function setArchived(threadId: string, resolved: boolean) {
  const answer = await loopback(`/api/inbox/messages/${threadId}/resolve`, 'POST', JSON.stringify({ resolved }));
  expect(answer.status).toBe(200);
  await new Promise((r) => setTimeout(r, 5));
}

beforeAll(async () => {
  if (!hasDom) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-archived-dom-')));
  // Never the real tailscale, never the real data dir.
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(dir, 'bin', 'tailscale'), 0o755);
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), '2'], {
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
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const answer = await loopback(String(input), init?.method ?? 'GET', init?.body ? String(init.body) : undefined);
    return new Response(answer.text, { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  savedEventSource = (globalThis as Record<string, unknown>).EventSource;
  // The event stream is not needed: every action reads the list again itself.
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
  await settle();
  return host;
}

function button(el: ParentNode, text: string): HTMLButtonElement {
  const found = [...el.querySelectorAll('button')].find((b) => b.textContent?.replace(/\s+/g, ' ').trim() === text);
  if (!found) throw new Error(`no button "${text}" in ${[...el.querySelectorAll('button')].map((b) => b.textContent?.trim()).join(' | ')}`);
  return found as HTMLButtonElement;
}

const listRow = (el: HTMLElement, threadId: string) => el.querySelector(`.ib-listcol [data-row="${threadId}"], [data-row="${threadId}"]`);
const archivedRow = (el: HTMLElement, threadId: string) => el.querySelector(`[data-archived-thread="${threadId}"]`);
const go = async (hash: string) => {
  act(() => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  await settle();
};

// First, while the server holds nothing archived.
test.skipIf(!hasDom)('Settings says when nothing is archived', async () => {
  const el = await renderApp('#settings/archived');
  await until(() => el.querySelector('[data-archived-empty]') !== null, 'the empty Archived block');
  expect(el.querySelector('[data-settings-archived]')?.textContent).toContain('Nothing archived.');
  expect(el.querySelector('[data-archived-project]')).toBeNull();
});

test.skipIf(!hasDom)('archive the open thread: its row stays until the person leaves; Settings lists it; Unarchive puts it back and opens it', async () => {
  const world = worlds[0]!;
  const el = await renderApp(`#thread=${world.waiting}`);
  await until(() => listRow(el, world.waiting) !== null && el.querySelector('[aria-label="Archive the thread"]') !== null, 'the thread and its row');

  act(() => (el.querySelector('[aria-label="Archive the thread"]') as HTMLButtonElement).click());
  await until(() => el.textContent?.includes('Archived. The next message from') ?? false, 'the archived foot');
  // The person's own write never reorders the list while the thread is open: the row stays, shown archived.
  const held = listRow(el, world.waiting)!;
  expect(held).not.toBeNull();
  expect(held.textContent).toContain('Archived');

  act(() => (el.querySelector('.ib-phead [aria-label="Close the thread"]') as HTMLButtonElement).click());
  await until(() => listRow(el, world.waiting) === null, 'the row gone from the list');
  // Gone from every section, Quiet included; the rest of the world is still there.
  expect(listRow(el, world.stopped)).not.toBeNull();

  await go('#settings/archived');
  await until(() => archivedRow(el, world.waiting) !== null, 'the row in Settings');
  const row = archivedRow(el, world.waiting)!;
  expect(row.textContent).toContain('Which search index should the docs use?');
  expect(row.textContent).toContain('Archived today');
  expect(row.querySelector('.ib-d')?.textContent).toMatch(/· 1 message$/);
  expect(el.querySelector('[data-archived-count]')?.textContent).toBe('1 archived thread');

  act(() => button(row, 'Unarchive').click());
  await until(() => window.location.hash === `#thread=${world.waiting}`, 'the thread opened');
  await until(() => listRow(el, world.waiting) !== null, 'the row back in the list');
  await until(() => el.querySelector('[aria-label="Archive the thread"]') !== null, 'the thread open, not archived');
  expect(el.querySelector('[data-inbox-toast]')?.textContent).toContain('Back in your Inbox');
  const archived = JSON.parse((await loopback('/api/inbox/threads/archived')).text) as { total: number };
  expect(archived.total).toBe(0);
});

test.skipIf(!hasDom)('a deep link opens an archived thread with Unarchive in its foot, and the list leaves it out', async () => {
  const world = worlds[0]!;
  await setArchived(world.mixed, true);
  try {
    const el = await renderApp(`#thread=${world.mixed}`);
    await until(() => el.textContent?.includes('Archived. The next message from') ?? false, 'the archived foot');
    expect(listRow(el, world.mixed)).toBeNull();
    act(() => button(el.querySelector('.ib-acts')!, 'Unarchive').click());
    await until(() => el.querySelector('[aria-label="Archive the thread"]') !== null, 'the thread unarchived');
    act(() => (el.querySelector('.ib-phead [aria-label="Close the thread"]') as HTMLButtonElement).click());
    await until(() => listRow(el, world.mixed) !== null, 'the row back in the list');
  } finally {
    await setArchived(world.mixed, false);
  }
});

test.skipIf(!hasDom)('several projects: rows grouped under a header per project with its count, newest archived first, no dropdown', async () => {
  const [a, b] = [worlds[0]!, worlds[1]!];
  await setArchived(a.stopped, true);
  await setArchived(b.waiting, true);
  await setArchived(a.filed, true);
  try {
    const el = await renderApp('#settings/archived');
    await until(() => el.querySelectorAll('[data-archived-thread]').length === 3, 'three archived rows');
    const block = el.querySelector('[data-settings-archived]')!;
    expect(block.querySelector('select')).toBeNull();
    expect(el.querySelector('[data-archived-count]')?.textContent).toBe('3 archived threads');
    const groups = [...block.querySelectorAll('[data-archived-group]')];
    // The project archived most recently first, each with its own rows in order.
    expect(groups.map((g) => g.getAttribute('data-archived-group'))).toEqual([a.project, b.project]);
    expect(groups.map((g) => g.querySelector('h3')?.textContent?.replace(/\s+/g, ' ').trim())).toEqual([expect.stringMatching(/ · 2$/), expect.stringMatching(/ · 1$/)]);
    expect([...groups[0]!.querySelectorAll('[data-archived-thread]')].map((r) => r.getAttribute('data-archived-thread'))).toEqual([a.filed, a.stopped]);
    expect([...groups[1]!.querySelectorAll('[data-archived-thread]')].map((r) => r.getAttribute('data-archived-thread'))).toEqual([b.waiting]);
  } finally {
    await setArchived(a.stopped, false);
    await setArchived(b.waiting, false);
    await setArchived(a.filed, false);
  }
});

/** An agent's reply_to reply, over the Inbox's own MCP (stateless: one tools/call). */
function agentReply(replyTo: string, body: string, project = 'billing-1'): Promise<{ status: number; text: string }> {
  const payload = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'send_message', arguments: { project_path: join(dir!, 'projects', project), agent_session: 'ses_reply', agent_name: 'Claude Code', reply_to: replyTo, body } },
  });
  return new Promise((done, fail) => {
    const req = request(
      { host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Host: `127.0.0.1:${port}` } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => done({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', fail);
    req.write(payload);
    req.end();
  });
}

test.skipIf(!hasDom)("an agent's reply into an archived thread brings it back to the list and out of the Archived block", async () => {
  const world = worlds[1]!;
  await setArchived(world.filed, true);
  try {
    const el = await renderApp('#settings/archived');
    await until(() => archivedRow(el, world.filed) !== null, 'the archived row');
    const answer = await agentReply(world.filed, 'One more thing.\n\n:::question\nShip the CSV export today?\n\n- [ ] Yes\n- [ ] No\n:::');
    expect(answer.status).toBe(200);
    expect(answer.text).not.toContain('"isError":true');
    // The event stream is stubbed here, so load the window again to read the store as it now is.
    act(() => root?.unmount());
    host?.remove();
    const list = await renderApp('#');
    await until(() => listRow(list, world.filed) !== null, 'the row back in the list');
    expect(listRow(list, world.filed)!.closest('[data-section-id]')?.getAttribute('data-section-id')).toBe('waiting');
    await go('#settings/archived');
    await until(() => list.querySelector('[data-settings-archived]')?.getAttribute('data-settings-archived') === '0', 'the Archived block without it');
    expect(archivedRow(list, world.filed)).toBeNull();
    // Opened, it still says archived (the agent wrote after it), with Unarchive in its foot.
    await go(`#thread=${world.filed}`);
    await until(() => list.querySelector('[data-came-back]')?.textContent?.includes('Unarchive') ?? false, 'the came-back foot');
  } finally {
    await setArchived(world.filed, false);
  }
});

function type(el: HTMLElement, words: string) {
  const text = el.querySelector('textarea') as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(text, words);
    text.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

test.skipIf(!hasDom)('a came-back thread is answered without unarchiving: its later message takes a reply, the foot says so, the thread stays archived', async () => {
  const world = worlds[0]!;
  await setArchived(world.waiting, true);
  try {
    const answer = await agentReply(world.waiting, 'Follow-up.\n\n:::question\nKeep the old index too?\n\n- [ ] Yes\n- [ ] No\n:::', 'billing-0');
    expect(answer.status).toBe(200);
    const el = await renderApp(`#thread=${world.waiting}`);
    await until(() => el.querySelector('[data-came-back]') !== null, 'the came-back note');
    expect(el.querySelector('[data-came-back]')!.textContent).toContain('wrote after you archived it. Your reply goes to it; the thread stays archived.');
    // Not the read-only archived foot: the reply box is offered.
    expect(el.textContent).not.toContain('starts a new thread');
    act(() => button(el.querySelector('.ib-pfoot')!, 'Reply').click());
    await settle();
    type(el, 'Keep it for a week.');
    act(() => button(el.querySelector('.ib-pfoot')!, 'Send').click());
    await until(() => el.querySelector('textarea') === null, 'the Send');
    const model = JSON.parse((await loopback(`/api/inbox/threads/${world.waiting}`)).text) as {
      thread: { resolved_at: string | null; messages: { id: string; author: { kind: string }; reply_to: string | null; body: string }[] };
    };
    const later = model.thread.messages.filter((m) => m.author.kind === 'agent').at(-1)!;
    const sent = model.thread.messages.at(-1)!;
    expect(sent).toMatchObject({ author: { kind: 'person' }, reply_to: later.id });
    expect(sent.body).toContain('Keep it for a week.');
    expect(model.thread.resolved_at).not.toBeNull();
  } finally {
    await setArchived(world.waiting, false);
  }
});
