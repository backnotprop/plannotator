/**
 * Split | Unified in a guided review (approval "inbox-guide-diff-style",
 * #2107): the control sits in a tab rising out of the FIRST section card
 * only, switches every diff in the guide, and is kept where code review keeps
 * its layout (the `plannotator-diff-style` cookie and config.json
 * `diffOptions.diffStyle`). On a phone there is no control and every diff is
 * drawn Unified, the saved layout left as it is.
 *
 * The whole window (InboxApp) over a REAL Inbox server in a temp data dir
 * (tests/helpers/inbox-dom-server.ts, `guide` mode: an agent sent a guided
 * review of two sections through the Inbox's own MCP).
 *
 * The failures this catches: a tab on every card (or none), a click that does
 * not reach the diffs or the server, a choice config.json does not keep (code
 * review would undo it), config.json's layout not adopted on load, and a
 * phone drawing two narrow columns or rewriting the person's setting.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { plugin } from 'bun';
import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// The window's tsconfig points `#guide-reader` at the reader's type shape (reader-module.d.ts), which Bun
// would load as the module; the real reader is package.json's `imports` entry.
plugin({
  name: 'inbox-guide-reader',
  setup(build) {
    build.onLoad({ filter: /guide\/reader-module\.d\.ts$/ }, () => ({
      contents: `export { default } from ${JSON.stringify(resolve(import.meta.dir, 'guide/GuideReader.tsx'))};`,
      loader: 'ts',
    }));
  },
});

// The review app's worker pool imports Vite's `?worker&inline`, which Bun cannot load; the diffs then
// highlight on the main thread. The same stand-in AllFilesCodeView.lifecycle.test.tsx installs.
mock.module(resolve(import.meta.dir, '../review-editor/workerPool.tsx'), () => ({
  useIsWorkerPoolReadyOrDisabled: () => true,
  useWorkerPoolThemeSync: () => {},
}));

const hasDom = typeof document !== 'undefined';
const { InboxApp } = (hasDom ? await import('./App') : {}) as typeof import('./App');
const { resetInboxDiffStyleForTests } = (hasDom ? await import('./diffStyle') : {}) as typeof import('./diffStyle');
const { configStore } = (hasDom ? await import('@plannotator/ui/config') : {}) as typeof import('@plannotator/ui/config');

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');

let child: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;
let guide = { thread: '', message: '' };
let dir: string | null = null;
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedEventSource: unknown;
let savedMatchMedia: typeof window.matchMedia;
let phone = false;
/** Every POST /api/inbox/settings body the window sent. */
let settingsPosts: Record<string, unknown>[] = [];

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

const configPath = () => join(dir!, 'data', 'config.json');
function styleOnDisk(): unknown {
  if (!existsSync(configPath())) return undefined;
  return (JSON.parse(readFileSync(configPath(), 'utf8')) as { diffOptions?: { diffStyle?: unknown } }).diffOptions?.diffStyle;
}
function writeStyleOnDisk(style: 'split' | 'unified' | undefined) {
  const current = existsSync(configPath()) ? (JSON.parse(readFileSync(configPath(), 'utf8')) as Record<string, unknown>) : {};
  const diffOptions: Record<string, unknown> = { ...((current.diffOptions as Record<string, unknown> | undefined) ?? {}), overflow: 'wrap' };
  if (style) diffOptions.diffStyle = style;
  else delete diffOptions.diffStyle;
  current.diffOptions = diffOptions;
  writeFileSync(configPath(), JSON.stringify(current, null, 2));
}
const cookieStyle = () => /(?:^|; )plannotator-diff-style=([^;]*)/.exec(document.cookie)?.[1];

/** The page's own start: the cookie and the store say `style`, and the Inbox has not read its settings yet. */
function startPage(style: 'split' | 'unified') {
  resetInboxDiffStyleForTests();
  configStore.init({ diffOptions: { diffStyle: style } });
}

beforeAll(async () => {
  if (!hasDom) return;
  (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL('http://localhost:4000/');
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-guide-diff-style-dom-')));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(dir, 'bin', 'tailscale'), 0o755);
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), '1', 'guide'], {
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
  const first = JSON.parse(line.trim()) as { port: number; worlds: { guide: { thread: string; message: string } }[] };
  port = first.port;
  guide = first.worlds[0]!.guide;
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
  phone = false;
  settingsPosts = [];
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    if (path === '/api/inbox/settings' && method === 'POST' && init?.body) settingsPosts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    const answer = await loopback(path, method, init?.body ? String(init.body) : undefined);
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
    matches: query.includes('max-width: 767px') ? phone : false,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
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
});

async function until(check: () => boolean | Promise<boolean>, what: string) {
  for (let i = 0; i < 120; i++) {
    if (await check()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The window on the guided review, both section cards drawn. */
async function openGuide() {
  window.location.hash = `#thread=${guide.thread}&guide=${guide.message}`;
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<InboxApp />);
  });
  await until(() => host!.querySelectorAll('[data-guide-section]').length === 2, 'the two section cards');
  return host;
}

/** The layout each diff of the guide is drawn in: Pierre's `pre[data-diff-type]` inside each file's shadow root. */
const diffTypes = (el: ParentNode) =>
  [...el.querySelectorAll('diffs-container')].map((c) => (c as HTMLElement).shadowRoot?.querySelector('pre[data-diff]')?.getAttribute('data-diff-type') ?? null);
/** Both files' diffs drawn, each in `style` (Pierre names Unified `single`). */
const allDrawnIn = (el: ParentNode, style: 'split' | 'unified') => {
  const types = diffTypes(el);
  return types.length === 2 && types.every((t) => t === (style === 'unified' ? 'single' : 'split'));
};

const sectionTabs = (el: ParentNode) => [...el.querySelectorAll('[data-guide-section-tab]')];
const radio = (el: ParentNode, style: 'split' | 'unified') => el.querySelector<HTMLInputElement>(`[data-diff-style-switch] input[value="${style}"]`)!;

test.skipIf(!hasDom)('the Split | Unified tab rises out of the first section card only', async () => {
  startPage('split');
  writeStyleOnDisk(undefined);
  const el = await openGuide();
  const tabs = sectionTabs(el);
  expect(tabs).toHaveLength(1);
  // The tab sits right above the first card, which squares its top-right corner under it; the second card is untouched.
  const wrap = tabs[0]!.parentElement!;
  expect(wrap.hasAttribute('data-guide-section-tabbed')).toBe(true);
  const [first, second] = [...el.querySelectorAll<HTMLElement>('[data-guide-section]')];
  expect(first!.parentElement).toBe(wrap);
  expect(first!.style.borderTopRightRadius).toBe('0px');
  expect(second!.parentElement!.hasAttribute('data-guide-section-tabbed')).toBe(false);
  expect(second!.style.borderTopRightRadius).toBe('');
  // A radio group named for what it sets, the saved layout checked.
  const group = tabs[0]!.querySelector('[role="radiogroup"]')!;
  expect(group.getAttribute('aria-label')).toBe('Diff layout');
  expect(radio(el, 'split').checked).toBe(true);
  expect(radio(el, 'unified').checked).toBe(false);
  await until(() => allDrawnIn(el, 'split'), 'both diffs drawn split');
}, 30_000);

test.skipIf(!hasDom)('choosing Unified switches the setting every diff reads and saves it where code review reads it', async () => {
  startPage('split');
  writeStyleOnDisk('split');
  const el = await openGuide();
  await until(() => radio(el, 'split').checked, 'Split from config.json');

  await until(() => allDrawnIn(el, 'split'), 'both diffs drawn split');

  act(() => radio(el, 'unified').click());
  // Every diff of the guide, both cards, redraws in one column.
  await until(() => allDrawnIn(el, 'unified'), 'both diffs drawn unified');
  // The one setting code review reads; its cookie has it at once.
  expect(configStore.get('diffStyle')).toBe('unified');
  expect(cookieStyle()).toBe('unified');
  expect(radio(el, 'unified').checked).toBe(true);
  expect(el.querySelector('[data-diff-style-switch]')!.getAttribute('data-diff-style-switch')).toBe('unified');
  // And config.json, through the Inbox's settings route, keeping code review's other diff options.
  await until(() => styleOnDisk() === 'unified', 'config.json to say unified');
  expect(settingsPosts.some((body) => body.diff_style === 'unified')).toBe(true);
  expect((JSON.parse(readFileSync(configPath(), 'utf8')) as { diffOptions: Record<string, unknown> }).diffOptions.overflow).toBe('wrap');

  act(() => radio(el, 'split').click());
  expect(configStore.get('diffStyle')).toBe('split');
  await until(() => allDrawnIn(el, 'split'), 'both diffs back to split');
  await until(() => styleOnDisk() === 'split', 'config.json to say split');
}, 30_000);

test.skipIf(!hasDom)("a layout chosen in code review (config.json) is the one the guide opens on, over this browser's cookie", async () => {
  startPage('split');
  writeStyleOnDisk('unified');
  const el = await openGuide();
  await until(() => radio(el, 'unified').checked, 'Unified from config.json');
  expect(configStore.get('diffStyle')).toBe('unified');
  await until(() => allDrawnIn(el, 'unified'), 'both diffs drawn unified');
}, 30_000);

test.skipIf(!hasDom)('a phone draws no tab and every diff in one column, and leaves the saved layout alone', async () => {
  phone = true;
  startPage('split');
  writeStyleOnDisk('split');
  const el = await openGuide();
  expect(sectionTabs(el)).toHaveLength(0);
  expect(el.querySelector('[data-diff-style-switch]')).toBeNull();
  expect(el.querySelector('[data-guide-section-tabbed]')).toBeNull();
  // Every diff in one column though the saved layout says Split.
  await until(() => allDrawnIn(el, 'unified'), 'both diffs drawn unified on a phone');
  // Settled: nothing asked to write a layout.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 400));
  });
  expect(settingsPosts.some((body) => 'diff_style' in body)).toBe(false);
  expect(configStore.get('diffStyle')).toBe('split');
  expect(styleOnDisk()).toBe('split');
}, 30_000);
