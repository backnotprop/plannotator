/**
 * The reload line for Pi, Oh My Pi and OpenCode 2 as the window draws it
 * (owner approval "reload-hosts", 2026-10-26): the whole window (InboxApp)
 * over a REAL Inbox 0.28.25 (tests/helpers/inbox-dom-server.ts
 * `reload-hosts`), with each session's connection polling what it loaded
 * and what is on disk (`plugin: { version, on_disk, host }`). What is proved:
 * under a reply that waits on a busy session (the "can't go in sooner"
 * band), each runtime's own command leads with a Copy for exactly it
 * (Pi `/reload`, Oh My Pi `/restart`, OpenCode `opencode2 reload` to run in a
 * shell), never Claude Code's `/reload-plugins`; Pi folds quit and
 * `pi --continue`, OpenCode folds `opencode2 service restart` under one quiet
 * line, Oh My Pi folds nothing; OpenCode behind this Inbox names its
 * configured spec, or the pin to change; the same rule as Claude
 * Code (no line once the plugin has Send now); Settings → Agents leads with
 * the same command per runtime, the update first when the package on disk is
 * itself behind this Inbox; the sidebar's row names the agents and clears
 * once they reload.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from the test.yml DOM list.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { NO_BROWSER } from '../../tests/helpers/no-browser';

const hasDom = typeof document !== 'undefined';
const { InboxApp } = (hasDom ? await import('./App') : {}) as typeof import('./App');

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');
type Ask = { thread: string; session: string };
type World = { project: string; hosts: { pi: Ask; omp: Ask; opencode: Ask } };

let child: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;
let worlds: World[] = [];
let all: World[] = [];
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

/** A session's connection polls: Pi and Oh My Pi as host `pi`, OpenCode 2 as `opencode`. */
async function polls(session: string, hostId: 'pi' | 'opencode', body: Record<string, unknown>): Promise<void> {
  const stdin = child!.stdin as import('bun').FileSink;
  stdin.write(`${JSON.stringify({ poll: { session, body: { host: hostId, ...body } } })}\n`);
  await stdin.flush();
  let line = '';
  while (!line.includes('\n')) {
    const { value, done } = await lines!.read();
    if (done) throw new Error('the Inbox stopped');
    line += new TextDecoder().decode(value);
  }
}

const TESTS = 8;

beforeAll(async () => {
  if (!hasDom) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-reload-hosts-dom-')));
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), String(TESTS), 'reload-hosts'], {
    env: { ...process.env, DOM_TESTS: '0', PLANNOTATOR_DATA_DIR: join(dir, 'data'), HOME: dir, PLANNOTATOR_INBOX_CONNECT: '0', NO_BROWSER },
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
  all = [...started.worlds];
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

/** The commands a box shows (its code elements), in order. */
const codesIn = (el: Element) => [...el.querySelectorAll('code')].map((c) => c.textContent);
const delivered = () => document.querySelector<HTMLElement>('.ib-delivered');
const note = () => document.querySelector<HTMLElement>('[data-restart-note]');

async function openThread(thread: string) {
  await renderApp(`#thread=${thread}`);
  await until(() => delivered()?.getAttribute('data-delivery') === 'queued' && delivered()!.textContent!.includes('is working'), 'the queued line');
}

/** A plugin from before Send now (0.28.23), with 0.28.25 now on disk: a reload alone brings it up to date. */
const STALE = (h?: 'oh-my-pi') => ({ version: '0.28.23', on_disk: '0.28.25', ...(h ? { host: h } : { host: 'pi' }) });

async function copyLead(lead: HTMLElement): Promise<string> {
  copied = [];
  await act(async () => lead.querySelector<HTMLButtonElement>('[data-restart-copy]')!.click());
  await settle(100);
  return copied[0]!;
}

test.skipIf(!hasDom)('Pi: the line under the reply leads with /reload and its Copy; quitting and pi --continue stay folded', async () => {
  await polls(ids.hosts.pi.session, 'pi', { busy: true, plugin: STALE() });
  await openThread(ids.hosts.pi.thread);
  await until(() => !!note(), 'the reload note');
  expect(note()!.getAttribute('data-restart-runtime')).toBe('pi');
  const lead = note()!.querySelector<HTMLElement>('[data-reload-lead="restart"]')!;
  expect(lead.getAttribute('data-reload-command')).toBe('/reload');
  expect(lead.querySelector('code')!.textContent).toBe('/reload');
  expect(lead.querySelector('[data-restart-copy]')!.getAttribute('aria-label')).toBe('Copy /reload');
  expect(await copyLead(lead)).toBe('/reload');
  expect(lead.querySelector('[data-restart-live]')!.textContent).toBe('/reload copied.');
  expect(codesIn(note()!)).not.toContain('/reload-plugins');
  const toggle = note()!.querySelector<HTMLButtonElement>('[data-restart-toggle]')!;
  const steps = document.getElementById(toggle.getAttribute('aria-controls')!)!;
  expect(steps.hidden).toBe(true);
  await act(async () => toggle.click());
  expect(steps.hidden).toBe(false);
  const codes = [...steps.querySelectorAll('[data-restart-fallback] code')].map((c) => c.textContent);
  expect(codes).toEqual(['/quit', 'pi --continue']);
}, 30_000);

test.skipIf(!hasDom)('Oh My Pi: /restart leads, named Oh My Pi, with nothing folded (/restart already restarts it)', async () => {
  await polls(ids.hosts.omp.session, 'pi', { busy: true, plugin: STALE('oh-my-pi') });
  await openThread(ids.hosts.omp.thread);
  await until(() => !!note(), 'the reload note');
  expect(note()!.getAttribute('data-restart-runtime')).toBe('oh-my-pi');
  const lead = note()!.querySelector<HTMLElement>('[data-reload-lead="restart"]')!;
  expect(lead.getAttribute('data-reload-command')).toBe('/restart');
  expect(await copyLead(lead)).toBe('/restart');
  expect(note()!.querySelector('[data-restart-toggle]')).toBeNull();
}, 30_000);

test.skipIf(!hasDom)('OpenCode 2 with its plugin generation deleted: opencode2 reload with its Copy, one quiet line, the server restart folded', async () => {
  await polls(ids.hosts.opencode.session, 'opencode', { busy: true, plugin: { version: '0.28.23', on_disk: null } });
  await openThread(ids.hosts.opencode.thread);
  await until(() => !!note(), 'the reload note');
  expect(note()!.getAttribute('data-restart-runtime')).toBe('opencode');
  const lead = note()!.querySelector<HTMLElement>('[data-reload-lead="restart"]')!;
  expect(lead.getAttribute('data-reload-command')).toBe('opencode2 reload');
  expect(await copyLead(lead)).toBe('opencode2 reload');
  // One quiet line on what a reload cancels; nothing about quitting.
  expect(note()!.querySelectorAll('[data-opencode-quiet]')).toHaveLength(1);
  expect(note()!.querySelector('[data-opencode-quit-note]')).toBeNull();
  const toggle = note()!.querySelector<HTMLButtonElement>('[data-restart-toggle]')!;
  await act(async () => toggle.click());
  const fallback = document.getElementById(toggle.getAttribute('aria-controls')!)!.querySelector<HTMLElement>('[data-restart-fallback]')!;
  expect(fallback.querySelector('.ib-rw-cmd code')!.textContent).toBe('opencode2 service restart');
  copied = [];
  await act(async () => fallback.querySelector<HTMLButtonElement>('[data-restart-copy]')!.click());
  await settle(100);
  expect(copied).toEqual(['opencode2 service restart']);
}, 30_000);

test.skipIf(!hasDom)('the same rule as Claude Code: a Pi on a plugin that has Send now (0.28.24 on) gets no line under the reply, idle or working', async () => {
  await polls(ids.hosts.pi.session, 'pi', { busy: true, plugin: { version: '0.28.24', on_disk: '0.28.25', host: 'pi' } });
  await openThread(ids.hosts.pi.thread);
  await settle();
  expect(note()).toBeNull();
}, 30_000);

test.skipIf(!hasDom)('Settings → Agents: per runtime, the reload leads with Copy; the update first when the package on disk is behind this Inbox', async () => {
  // This world's Pi: the extension on disk (0.28.24) is itself behind Inbox 0.28.25. Its Oh My Pi: a reload alone.
  await polls(ids.hosts.pi.session, 'pi', { busy: false, plugin: { version: '0.28.24', on_disk: '0.28.24', host: 'pi' } });
  await polls(ids.hosts.omp.session, 'pi', { busy: false, plugin: STALE('oh-my-pi') });
  await polls(ids.hosts.opencode.session, 'opencode', { busy: false, plugin: { version: '0.28.24', on_disk: '0.28.24' } });
  await renderApp('#settings/agents');
  await until(() => !!document.querySelector('[data-agent-sessions="pi"] [data-reload-sessions="pi"] [data-reload-lead="update_plugin"]'), 'the Pi update lead');
  const pi = document.querySelector<HTMLElement>('[data-agent-sessions="pi"]')!;
  // Two steps: `pi update --extensions`, then /reload.
  const update = pi.querySelector<HTMLElement>('[data-reload-sessions="pi"] [data-reload-lead="update_plugin"]')!;
  const [updateCopy, reloadCopy] = [...update.querySelectorAll<HTMLButtonElement>('[data-restart-copy]')];
  copied = [];
  await act(async () => updateCopy!.click());
  await act(async () => reloadCopy!.click());
  await settle(100);
  expect(copied).toEqual(['pi update --extensions', '/reload']);
  // Oh My Pi's own group (earlier worlds' Pi sessions need only /reload: their group leads with it alone).
  const omp = pi.querySelector<HTMLElement>('[data-reload-sessions="oh-my-pi"] [data-reload-lead="restart"]')!;
  expect(omp.getAttribute('data-reload-command')).toBe('/restart');
  expect(await copyLead(omp)).toBe('/restart');
  expect(codesIn(pi)).not.toContain('/reload-plugins');
  // OpenCode: the deleted generation (earlier world) reloads with `opencode2 reload`; this one's plugin is behind on disk
  // and OpenCode's config is unknown here, so the update names no target (and says it updates every plugin).
  const opencode = document.querySelector<HTMLElement>('[data-agent-sessions="opencode"]')!;
  const leads = [...opencode.querySelectorAll<HTMLElement>('[data-reload-sessions="opencode"] [data-reload-lead="restart"]')];
  expect(leads.map((l) => l.getAttribute('data-reload-command')).sort()).toEqual(['opencode2 plugin list && opencode2 plugin update', 'opencode2 reload']);
  const copiedFrom = [];
  for (const lead of leads) copiedFrom.push(await copyLead(lead));
  expect(copiedFrom.sort()).toEqual(['opencode2 plugin list && opencode2 plugin update', 'opencode2 reload']);
  // Each OpenCode box: one quiet line (what a reload cancels; that an untargeted update updates every plugin), no quitting note.
  for (const box of opencode.querySelectorAll('[data-reload-sessions="opencode"]')) expect(box.querySelectorAll('[data-opencode-quiet]')).toHaveLength(1);
  expect(opencode.querySelector('[data-opencode-quit-note]')).toBeNull();
  expect(opencode.querySelector(`[data-session-row="${ids.hosts.opencode.session}"]`)).not.toBeNull();
}, 30_000);

test.skipIf(!hasDom)('the sidebar: "Reload agents N" when more than one runtime waits, a real button that opens Settings → Agents', async () => {
  await polls(ids.hosts.pi.session, 'pi', { busy: false, plugin: STALE() });
  await polls(ids.hosts.opencode.session, 'opencode', { busy: false, plugin: { version: '0.28.23', on_disk: null } });
  await renderApp();
  await until(() => !!document.querySelector('[data-restart-sidebar]'), 'the sidebar row');
  const row = document.querySelector<HTMLButtonElement>('[data-restart-sidebar]')!;
  expect(row.tagName).toBe('BUTTON');
  expect(row.querySelector('.ib-rw-label')!.textContent).toBe('Reload agents');
  const count = Number(row.getAttribute('data-restart-sidebar'));
  expect(count).toBeGreaterThanOrEqual(2);
  expect(row.querySelector('.ib-n')!.textContent).toBe(String(count));
  await act(async () => row.click());
  await until(() => window.location.hash.includes('settings/agents'), 'Settings → Agents');
  await until(() => !!document.querySelector('[data-reload-sessions="pi"]'), 'the Pi reload');
}, 30_000);

/** OpenCode's global config in the Inbox's scratch HOME (read at most every 2 s): OpenCode 2's `plugins`, or OpenCode 1's `plugin` pair our installer writes. */
async function openCodeConfig(spec: string | null, key: 'plugins' | 'plugin' = 'plugins') {
  const folder = join(dir!, '.config', 'opencode');
  mkdirSync(folder, { recursive: true });
  const entry = key === 'plugins' ? { package: spec, options: { workflow: 'manual' } } : [spec, { workflow: 'manual' }];
  if (spec) writeFileSync(join(folder, 'opencode.json'), JSON.stringify({ [key]: [entry] }));
  else rmSync(join(folder, 'opencode.json'), { force: true });
  await settle(2_200);
}

test.skipIf(!hasDom)('OpenCode behind this Inbox: the update names its configured spec (only Plannotator updates); a pinned spec changes first, then opencode2 reload; neither counts as a reload', async () => {
  try {
    await openCodeConfig('@plannotator/opencode@latest');
    await polls(ids.hosts.opencode.session, 'opencode', { busy: true, plugin: { version: '0.28.23', on_disk: '0.28.23' } });
    await openThread(ids.hosts.opencode.thread);
    await until(() => !!note(), 'the update note');
    let lead = note()!.querySelector<HTMLElement>('[data-reload-lead="restart"]')!;
    expect(lead.getAttribute('data-reload-command')).toBe('opencode2 plugin list && opencode2 plugin update @plannotator/opencode@latest');
    expect(await copyLead(lead)).toBe('opencode2 plugin list && opencode2 plugin update @plannotator/opencode@latest');
    // An update with a target cancels nothing a reload does, updates nothing else: no quiet line, no server restart folded.
    expect(note()!.querySelector('[data-opencode-quiet]')).toBeNull();
    expect(note()!.querySelector('[data-restart-toggle]')).toBeNull();
    act(() => root?.unmount());
    host?.remove();

    // The pin under OpenCode 1's `plugin` key, as our installer writes it.
    await openCodeConfig('@plannotator/opencode@0.28.23', 'plugin');
    await polls(ids.hosts.opencode.session, 'opencode', { busy: true, plugin: { version: '0.28.23', on_disk: '0.28.23' } });
    await openThread(ids.hosts.opencode.thread);
    await until(() => !!note()?.querySelector('[data-reload-lead="pin"]'), 'the pin note');
    lead = note()!.querySelector<HTMLElement>('[data-reload-lead="pin"]')!;
    expect(lead.getAttribute('data-reload-command')).toBe('opencode2 reload');
    expect(codesIn(lead)).toEqual(['@plannotator/opencode@0.28.23', '@plannotator/opencode@latest', 'opencode2 reload']);
    // One Copy, right after the value of the first step: what to write in the config.
    expect(lead.querySelectorAll('[data-restart-copy]')).toHaveLength(1);
    expect(await copyLead(lead)).toBe('@plannotator/opencode@latest');
    // Not a reload alone: the sidebar does not count it (as Pi's update and Claude Code's are not counted).
    const list = JSON.parse((await loopback('/api/inbox/threads')).text) as { restart_agents: { runtimes: Record<string, number> } };
    const agents = JSON.parse((await loopback('/api/inbox/agents')).text) as { sessions: { opencode: { sessions: { session: string; outdated: { fix: string } | null }[] } } };
    expect(agents.sessions.opencode.sessions.find((x) => x.session === ids.hosts.opencode.session)!.outdated!.fix).toBe('update_extension');
    const reloads = agents.sessions.opencode.sessions.filter((x) => x.outdated && x.outdated.fix === 'reload').length;
    expect(list.restart_agents.runtimes.opencode ?? 0).toBe(reloads);
  } finally {
    await openCodeConfig(null);
  }
}, 30_000);

test.skipIf(!hasDom)('the row clears itself once every session reloads onto the version on disk', async () => {
  for (const world of all) {
    await polls(world.hosts.pi.session, 'pi', { busy: false, plugin: { version: '0.28.25', on_disk: '0.28.25', host: 'pi' } });
    await polls(world.hosts.omp.session, 'pi', { busy: false, plugin: { version: '0.28.25', on_disk: '0.28.25', host: 'oh-my-pi' } });
    await polls(world.hosts.opencode.session, 'opencode', { busy: false, plugin: { version: '0.28.25', on_disk: '0.28.25' } });
  }
  await renderApp('#settings/agents');
  await until(() => !!document.querySelector('[data-agent-sessions="pi"]'), 'Open sessions');
  await settle();
  expect(document.querySelector('[data-restart-sidebar]')).toBeNull();
  expect(document.querySelector('[data-reload-sessions]')).toBeNull();
  expect(document.querySelector('[data-agent-sessions="opencode"] .ib-agv')!.textContent).toContain('up to date');
}, 30_000);
