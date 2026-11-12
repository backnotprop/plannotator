import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const hasDom = typeof document !== 'undefined';
const { InboxApp } = (hasDom ? await import('./App') : {}) as typeof import('./App');

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');
type World = { project: string; restart: { thread: string; session: string; project: string; installPath: string; oldPath: string } };

let child: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;
let worlds: World[] = [];
let ids: World;
let dir: string | null = null;
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedEventSource: unknown;
let savedClipboard: PropertyDescriptor | undefined;
let copied: string[] = [];
let lines: ReadableStreamDefaultReader<Uint8Array> | null = null;

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

async function sessionPolls(body: Record<string, unknown>): Promise<void> {
  const stdin = child!.stdin as import('bun').FileSink;
  stdin.write(`${JSON.stringify({ poll: { session: ids.restart.session, body: { project_path: ids.restart.project, ...body } } })}\n`);
  await stdin.flush();
  let line = '';
  while (!line.includes('\n')) {
    const { value, done } = await lines!.read();
    if (done) throw new Error('the Inbox stopped');
    line += new TextDecoder().decode(value);
  }
}

const resumeLine = () => `cd ~${ids.restart.project.slice(dir!.length)} && claude --resume ${ids.restart.session}`;

const OLD = () => ({ version: '0.28.23', root: ids.restart.oldPath, loaded_at: Date.parse('2026-10-16T00:00:00Z') });
const CURRENT = () => ({ version: '0.28.25', root: ids.restart.installPath, loaded_at: Date.now() });

const TESTS = 8;

beforeAll(async () => {
  if (!hasDom) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-restart-dom-')));
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), String(TESTS), 'restart'], {
    env: { ...process.env, DOM_TESTS: '0', PLANNOTATOR_DATA_DIR: join(dir, 'data'), HOME: dir, PLANNOTATOR_INBOX_CONNECT: '0', NO_BROWSER: '/usr/bin/true' },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
  });
  lines = (child.stdout as ReadableStream<Uint8Array>).getReader();
  let line = '';
  while (!line.includes('\n')) {
    const { value, done } = await lines.read();
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
  copied = [];
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
  savedClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => void copied.push(text) } });
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
  if (savedClipboard) Object.defineProperty(navigator, 'clipboard', savedClipboard);
  else delete (navigator as unknown as Record<string, unknown>).clipboard;
  document.body.innerHTML = '';
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

async function settle(ms = 300) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

async function renderApp(hash = '') {
  window.location.hash = hash;
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<InboxApp />);
  });
  await until(() => !!document.querySelector('.ib-side'), 'the sidebar');
}

const delivered = () => document.querySelector<HTMLElement>('.ib-delivered');
const note = () => document.querySelector<HTMLElement>('[data-restart-note]');

async function openThread() {
  await renderApp(`#thread=${ids.restart.thread}`);
  await until(() => delivered()?.getAttribute('data-delivery') === 'queued' && delivered()!.textContent!.includes('is working'), 'the queued line');
}

test.skipIf(!hasDom)('a busy session on an older plugin: the lead copies /reload-plugins; /exit and the resume command stay folded until asked', async () => {
  await sessionPolls({ busy: true, plugin: OLD(), engine: '2.1.305' });
  await openThread();
  await until(() => !!note(), 'the restart note');
  expect(!!delivered()!.querySelector('[data-send-now]')).toBe(false);
  const lead = note()!.querySelector<HTMLElement>('[data-reload-lead="restart"]')!;
  expect(lead.querySelector('code')!.textContent).toBe('/reload-plugins');
  const reloadCopy = lead.querySelector<HTMLButtonElement>('[data-restart-copy]')!;
  expect(reloadCopy.getAttribute('aria-label')).toBe('Copy /reload-plugins');
  await act(async () => reloadCopy.click());
  await settle(100);
  expect(copied).toEqual(['/reload-plugins']);
  expect(lead.querySelector('[data-restart-live]')!.getAttribute('aria-live')).toBe('polite');
  expect(lead.querySelector('[data-restart-live]')!.textContent).toBe('/reload-plugins copied.');
  const toggle = note()!.querySelector<HTMLButtonElement>('[data-restart-toggle]')!;
  expect(toggle.tagName).toBe('BUTTON');
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  const steps = document.getElementById(toggle.getAttribute('aria-controls')!)!;
  expect(steps.hidden).toBe(true);
  await act(async () => toggle.click());
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(steps.hidden).toBe(false);
  const fallback = steps.querySelector<HTMLElement>('[data-restart-fallback]')!;
  expect(fallback.textContent).toContain('/exit');
  expect(fallback.querySelector('.ib-rw-cmd code')!.textContent).toBe(resumeLine());
  const copy = fallback.querySelector<HTMLButtonElement>('[data-restart-copy]')!;
  expect(copy.getAttribute('aria-label')).toBe('Copy the command that restarts this Claude Code session');
  copied = [];
  await act(async () => copy.click());
  await settle(100);
  expect(copied).toEqual([resumeLine()]);
  expect(copy.textContent).toBe('Copied');
  expect(fallback.querySelector('[data-restart-live]')!.textContent).toBe('Restart command copied.');
}, 30_000);

test.skipIf(!hasDom)('no line while the session is idle, or while it has Send now (nothing was missed)', async () => {
  await sessionPolls({ busy: false, plugin: OLD() });
  await renderApp(`#thread=${ids.restart.thread}`);
  await until(() => delivered()?.getAttribute("data-delivery") === "sending", "the sending line");
  await settle();
  expect(!!note()).toBe(false);
  await sessionPolls({ busy: true, plugin: OLD(), send_now: true });
  act(() => root?.unmount());
  host?.remove();
  await renderApp(`#thread=${ids.restart.thread}`);
  await until(() => !!delivered()?.querySelector('[data-send-now]'), 'Send now');
  expect(!!note()).toBe(false);
}, 30_000);

test.skipIf(!hasDom)('a session on a plugin that has Send now (0.28.24 on) without it now (its own Ask question holds the turn): no line blaming the plugin', async () => {
  await sessionPolls({ busy: true, plugin: { version: '0.28.24', root: ids.restart.oldPath, loaded_at: Date.parse('2026-10-16T00:00:00Z') }, engine: '2.1.305' });
  await openThread();
  await settle();
  expect(!!note()).toBe(false);
}, 30_000);

test.skipIf(!hasDom)('an engine too old for Send now: the line says nothing about a restart (a restart would not bring it)', async () => {
  await sessionPolls({ busy: true, plugin: OLD(), engine: '2.1.290' });
  await openThread();
  await settle();
  expect(!!note()).toBe(false);
}, 30_000);

test.skipIf(!hasDom)('restarted on the installed plugin: no line', async () => {
  await sessionPolls({ busy: true, plugin: CURRENT(), engine: '2.1.305' });
  await openThread();
  await settle();
  expect(!!note()).toBe(false);
}, 30_000);

test.skipIf(!hasDom)('the sidebar: "Reload Claude Code N", a real button, opens Settings → Agents with Open sessions and Copy restart', async () => {
  await sessionPolls({ busy: true, plugin: OLD(), engine: '2.1.305' });
  await renderApp();
  await until(() => !!document.querySelector('[data-restart-sidebar]'), 'the sidebar row');
  const row = document.querySelector<HTMLButtonElement>('[data-restart-sidebar]')!;
  expect(row.tagName).toBe('BUTTON');
  const count = Number(row.getAttribute('data-restart-sidebar'));
  expect(count).toBeGreaterThanOrEqual(1);
  expect(row.querySelector('.ib-rw-label')!.textContent).toBe('Reload Claude Code');
  expect(row.querySelector('.ib-n')!.textContent).toBe(String(count));
  expect(row.textContent).toContain('the plugin from before the update; /reload-plugins loads the new one. Opens Settings, Agents.');
  const foot = document.querySelector('.ib-side-foot')!;
  const order = [...foot.children].map((el) => (el.matches('[data-restart-sidebar]') ? 'restart' : el.matches('.ib-setrow, [data-sidebar-item="settings"]') ? 'settings' : 'other'));
  expect(order.indexOf('restart')).toBeLessThan(order.indexOf('settings'));
  await act(async () => row.click());
  await until(() => window.location.hash.includes('settings/agents'), 'Settings → Agents');
  await until(() => !!document.querySelector('[data-agent-sessions="claude-code"]'), 'Open sessions');
  const sessions = document.querySelector<HTMLElement>('[data-agent-sessions="claude-code"]')!;
  expect(sessions.querySelector('.ib-agk')!.textContent).toBe('Open sessions');
  expect(sessions.querySelector('.ib-agv')!.textContent).toMatch(/on (plugin 0\.28\.23|an older plugin)/);
  expect(document.querySelector('[data-agent="claude-code"] .ib-agstate')!.textContent).toMatch(/Connected · \d+ needs? a reload/);
  const lead = sessions.querySelector<HTMLElement>('[data-reload-lead="restart"]')!;
  expect(lead.querySelector('code')!.textContent).toBe('/reload-plugins');
  await act(async () => lead.querySelector<HTMLButtonElement>('[data-restart-copy]')!.click());
  await settle(100);
  expect(copied).toEqual(['/reload-plugins']);
  const mine = sessions.querySelector<HTMLElement>(`[data-session-row="${ids.restart.session}"]`)!;
  expect(mine.textContent).toContain('working');
  expect(mine.querySelector('button')).toBeNull();
  const toggle = sessions.querySelector<HTMLButtonElement>('[data-restart-toggle]')!;
  const fold = document.getElementById(toggle.getAttribute('aria-controls')!)!;
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(fold.hidden).toBe(true);
  await act(async () => toggle.click());
  expect(fold.hidden).toBe(false);
  const restartRow = fold.querySelector<HTMLElement>(`[data-session-restart="${ids.restart.session}"]`)!;
  const copy = restartRow.querySelector<HTMLButtonElement>('[data-restart-copy]')!;
  expect(copy.textContent).toBe('Copy restart');
  copied = [];
  await act(async () => copy.click());
  await settle(100);
  expect(copied).toEqual([resumeLine()]);
  expect(!!document.querySelector('[data-settings-link="agents"] [data-agents-dot]')).toBe(true);
}, 30_000);

function installedPlugin(version: string) {
  const folder = join(dir!, 'data', 'claude', 'plugins', 'cache', 'plannotator', 'plannotator', version);
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(dir!, 'data', 'claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'plannotator@plannotator': [{ scope: 'user', installPath: folder, version, installedAt: '2026-10-04T22:07:24.658Z', lastUpdated: '2026-10-17T05:27:07.299Z' }] } }),
  );
}

test.skipIf(!hasDom)('the installed plugin behind this Inbox (0.28.24 under Inbox 0.28.25): the update command leads with Copy, then /reload-plugins, in Settings and under the reply', async () => {
  installedPlugin('0.28.24');
  try {
    await sessionPolls({ busy: true, plugin: OLD(), engine: '2.1.305' });
    await renderApp('#settings/agents');
    await until(() => !!document.querySelector('[data-agent-sessions="claude-code"] [data-reload-lead="update_plugin"]'), 'the update lead');
    const lead = document.querySelector<HTMLElement>('[data-agent-sessions="claude-code"] [data-reload-lead="update_plugin"]')!;
    const [update, reload] = [...lead.querySelectorAll<HTMLButtonElement>('[data-restart-copy]')];
    await act(async () => update!.click());
    await settle(100);
    expect(copied[0]).toContain('claude plugin');
    await act(async () => reload!.click());
    await settle(100);
    expect(copied[1]).toBe('/reload-plugins');
    act(() => root?.unmount());
    host?.remove();
    await openThread();
    await until(() => !!note()?.querySelector('[data-reload-lead="update_plugin"]'), 'the update lead under the reply');
    act(() => root?.unmount());
    host?.remove();
    await renderApp();
    await until(() => !!document.querySelector('[data-restart-sidebar]'), 'the sidebar row, plugin behind');
    const behind = document.querySelector<HTMLButtonElement>('[data-restart-sidebar]')!;
    expect(Number(behind.getAttribute('data-restart-update'))).toBeGreaterThanOrEqual(1);
    await act(async () => behind.click());
    await until(() => !!document.querySelector('[data-agent-sessions="claude-code"] [data-reload-lead="update_plugin"]'), 'the update lead from the row');
    act(() => root?.unmount());
    host?.remove();
    installedPlugin('0.28.25');
    await settle(2_200);
    await renderApp();
    await until(() => !!document.querySelector('[data-restart-sidebar]') && !document.querySelector('[data-restart-update]'), 'the row, a reload alone');
  } finally {
    installedPlugin('0.28.25');
    await settle(2_200);
  }
}, 30_000);

test.skipIf(!hasDom)('the row clears itself once those sessions restart (read at the next list read)', async () => {
  for (let i = 0; i < TESTS; i++) {
    const stdin = child!.stdin as import('bun').FileSink;
    stdin.write(`${JSON.stringify({ poll: { session: `ses_r${i}`, body: { busy: false, plugin: { version: '0.28.25', root: ids.restart.installPath, loaded_at: Date.now() } } } })}\n`);
    await stdin.flush();
  }
  await settle(500);
  await renderApp();
  await settle();
  expect(!!document.querySelector('[data-restart-sidebar]')).toBe(false);
}, 30_000);
