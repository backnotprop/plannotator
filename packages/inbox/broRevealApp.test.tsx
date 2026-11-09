/**
 * Bro mode's one-time offer in the whole window (InboxApp) over a real Inbox in a temp data dir
 * (tests/helpers/inbox-dom-server.ts `bro-offer`: heavy use, the line's other dialogs behind the person), where
 * `broReveal.test.tsx` drives the gate alone.
 *
 * What regresses: App not drawing the card, or not arming it when the line says `bro`, at its moment (back on the list
 * from a long agent message); a tab loaded while the line was held (the day after another dialog) never arming it
 * however long it stays loaded, so only a reload ever shows it; a click outside writing the switch, or not telling the Inbox (the line's Not now gap); a
 * tailnet guest changing what every agent here reads.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const hasDom = typeof document !== 'undefined';
const { InboxApp } = (hasDom ? await import('./App') : {}) as typeof import('./App');
const reveal = (hasDom ? await import('./reveal') : {}) as typeof import('./reveal');
const { resetPageSessionForTests } = (hasDom ? await import('./api') : {}) as typeof import('./api');

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');
const TIMES = { pageAgeMs: 200, readMs: 50, settledMs: 50, momentMs: 3_000, recheckMs: 20, claimRetryMs: 30, broReadMs: 250 };

interface Server {
  child: ReturnType<typeof Bun.spawn>;
  port: number;
  dataDir: string;
  thread: string;
  tailnet: { listener: number; host: string; login: string };
}

let dir: string | null = null;
let server: Server | null = null;
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedEventSource: unknown;
let savedMatchMedia: typeof window.matchMedia;
let savedTimes: typeof reveal.REVEAL_TIMES;
/** What the agents read answers, over the real answer. */
let agentsOver: ((model: Record<string, any>) => void) | null = null;

function call(port: number, path: string, method = 'GET', body?: string, headers: Record<string, string> = {}): Promise<{ status: number; text: string }> {
  return new Promise((done, fail) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { 'Content-Type': 'application/json', Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => done({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', fail);
    if (body) req.write(body);
    req.end();
  });
}

async function spawnServer(): Promise<Server> {
  const dataDir = join(dir!, 'data');
  mkdirSync(join(dir!, 'projects'), { recursive: true });
  const child = Bun.spawn(['bun', SERVER_SCRIPT, dataDir, join(dir!, 'projects'), '1', 'bro-offer'], {
    env: { ...process.env, DOM_TESTS: '0', PLANNOTATOR_DATA_DIR: dataDir, HOME: dir! },
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
  let line = '';
  while (!line.includes('\n')) {
    const { value, done } = await reader.read();
    if (done) throw new Error('the Inbox did not start');
    line += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  const started = JSON.parse(line.trim()) as { port: number; bro: string; tailnet: Server['tailnet'] };
  return { child, port: started.port, dataDir, thread: started.bro, tailnet: started.tailnet };
}

beforeEach(async () => {
  if (!hasDom) return;
  (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL('http://localhost:4000/');
  savedTimes = { ...reveal.REVEAL_TIMES };
  Object.assign(reveal.REVEAL_TIMES, TIMES);
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-bro-app-')));
  server = await spawnServer();
  // Each test's page is a new page on a new Inbox.
  resetPageSessionForTests();
  agentsOver = null;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    const answer = await call(server!.port, path, method, init?.body ? String(init.body) : undefined);
    let text = answer.text;
    if (agentsOver && method === 'GET' && path.split('?')[0] === '/api/inbox/agents') {
      const model = JSON.parse(text) as Record<string, any>;
      agentsOver(model);
      text = JSON.stringify(model);
    }
    return new Response(text, { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  savedEventSource = (globalThis as Record<string, unknown>).EventSource;
  (globalThis as Record<string, unknown>).EventSource = class {
    addEventListener() {}
    close() {}
  };
  savedMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    media: query,
    matches: false,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  window.location.hash = '';
}, 30_000);

afterEach(async () => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
  (globalThis as Record<string, unknown>).EventSource = savedEventSource;
  window.matchMedia = savedMatchMedia;
  Object.assign(reveal.REVEAL_TIMES, savedTimes);
  server?.child.kill();
  await server?.child.exited;
  server = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

const wait = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 160; i++) {
    if (check()) return;
    await wait(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const config = () => JSON.parse(readFileSync(join(server!.dataDir, 'config.json'), 'utf8')) as Record<string, any>;
const openDialogs = () => [...document.querySelectorAll('dialog[open]')].map((dialog) => dialog.getAttribute('data-dialog'));
const card = () => document.querySelector<HTMLDialogElement>('dialog[open][data-dialog="bro-intro"]');

async function renderApp(hash: string) {
  window.location.hash = hash;
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<InboxApp />);
  });
  await until(() => host!.querySelector('.ib-listcol, section.ib-pane') !== null, 'the window');
}

/** Read the thread whose last agent message is long, past the page's and the visit's times, then go back to the list: the moment. */
async function readAndLeave() {
  await renderApp(`#thread=${server!.thread}`);
  await wait(Math.max(TIMES.pageAgeMs, TIMES.broReadMs) + 100);
  expect(openDialogs()).toEqual([]);
  act(() => {
    window.location.hash = '';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
}

test.skipIf(!hasDom)('the card opens in the window when the queue says bro, at the moment and not at load; Turn it on saves the switch', async () => {
  await readAndLeave();
  await until(() => card() !== null, 'the card');
  expect(config().inboxBro).toBeUndefined();
  act(() => document.querySelector<HTMLButtonElement>('[data-bro-intro-on]')!.click());
  await until(() => config().inboxBro === true, 'config.json inboxBro true');
  await until(() => card() === null, 'the card to close');
}, 30_000);

test.skipIf(!hasDom)('a tab loaded the day after another dialog and left loaded shows the card once the line is free, with no reload', async () => {
  // The line's last dialog, as config.json keeps it (the Inbox reads it live).
  const lastDialog = (at: number) => {
    const stamp = new Date(at).toISOString();
    writeFileSync(join(server!.dataDir, 'config.json'), JSON.stringify({ ...config(), inboxReveals: { ...config().inboxReveals, lastShownAt: stamp, dayShownAt: stamp } }));
  };
  // A dialog showed a moment ago: this load may arm nothing.
  lastDialog(Date.now());
  reveal.REVEAL_TIMES.lineReadMs = 200;
  await readAndLeave();
  await wait(TIMES.settledMs + 400);
  expect(openDialogs()).toEqual([]);
  expect(config().inboxReveals.bro).toBeUndefined();
  // More than a day passes on the same tab: the Inbox has Bro mode next, and the tab asks it for the line again.
  lastDialog(Date.now() - 26 * 3_600_000);
  await wait(reveal.REVEAL_TIMES.lineReadMs + 300);
  act(() => {
    window.location.hash = `#thread=${server!.thread}`;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  await wait(TIMES.broReadMs + 150);
  act(() => {
    window.location.hash = '';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  await until(() => card() !== null, 'the card on the tab left loaded');
  expect(typeof config().inboxReveals.bro.shownAt).toBe('string');
}, 30_000);

test.skipIf(!hasDom)("a click outside is Not now: no switch, the line's gap stamped, and it does not come back", async () => {
  await readAndLeave();
  await until(() => card() !== null, 'the card');
  const shownAt = config().inboxReveals.bro.shownAt;
  act(() => card()!.click());
  await until(() => card() === null, 'the card to close');
  await wait(100);
  expect(config().inboxBro).toBeUndefined();
  expect(config().inboxReveals.bro.shownAt).toBe(shownAt);
  await until(() => typeof config().inboxReveals.notNowAt === 'string', 'the Not now stamp');
  const settings = JSON.parse((await call(server!.port, '/api/inbox/settings?store=0')).text) as { reveal: { next: string | null } };
  expect(settings.reveal.next).not.toBe('bro');
}, 30_000);

test.skipIf(!hasDom)("a tailnet guest's bro save is refused and writes nothing; the owner's over the tailnet saves", async () => {
  const { listener, host: tailnetHost, login } = server!.tailnet;
  const over = (who: string) =>
    call(listener, '/api/inbox/settings', 'POST', JSON.stringify({ bro: { on: true } }), {
      Host: tailnetHost,
      Origin: `https://${tailnetHost}`,
      'Sec-Fetch-Site': 'same-origin',
      'X-Forwarded-Proto': 'https',
      'Tailscale-User-Login': who,
    });
  const guest = await over('guest@example.com');
  expect(guest.status).toBe(403);
  expect((JSON.parse(guest.text) as { code?: string }).code).toBe('local_only');
  expect(config().inboxBro).toBeUndefined();
  expect((await over(login)).status).toBe(200);
  expect(config().inboxBro).toBe(true);
}, 30_000);
