/**
 * The diff controls of a guided review (approvals "inbox-guide-diff-style",
 * #2107, and "diff-controls-headers"): one Split / Unified button, Collapse
 * all and the "Diff display" gear in the review's top bar, before Close, and
 * no tab on any card. Every setting is code review's own (its
 * `plannotator-diff-*` cookie and config.json `diffOptions`); the popover
 * leaves out Whole file and Hide whitespace. On a phone there are no controls
 * and every diff is drawn Unified, the saved layout left as it is.
 *
 * The whole window (InboxApp) over a REAL Inbox server in a temp data dir
 * (tests/helpers/inbox-dom-server.ts, `guide` mode: an agent sent a guided
 * review of two sections through the Inbox's own MCP).
 *
 * The failures this catches: the controls missing from the bar (or a tab
 * left on a card), a click that does not reach the diffs or the server, a
 * choice config.json does not keep (code review would undo it), config.json's
 * options not adopted on load, the popover offering the two rows that need the
 * local repository, Collapse all not folding every file, and a phone drawing
 * two narrow columns or rewriting the person's setting.
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
const { resetInboxDiffOptionsForTests } = (hasDom ? await import('./diffOptions') : {}) as typeof import('./diffOptions');
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
const diffOptionsOnDisk = (): Record<string, unknown> =>
  existsSync(configPath()) ? ((JSON.parse(readFileSync(configPath(), 'utf8')) as { diffOptions?: Record<string, unknown> }).diffOptions ?? {}) : {};
const styleOnDisk = () => diffOptionsOnDisk().diffStyle;
/** config.json's `diffOptions` as code review left them: these, and its own Whole file and font. */
function writeOptionsOnDisk(options: Record<string, unknown>) {
  const current = existsSync(configPath()) ? (JSON.parse(readFileSync(configPath(), 'utf8')) as Record<string, unknown>) : {};
  current.diffOptions = { expandUnchanged: true, fontSize: '13', ...options };
  writeFileSync(configPath(), JSON.stringify(current, null, 2));
}
const writeStyleOnDisk = (style: 'split' | 'unified' | undefined) => writeOptionsOnDisk(style ? { diffStyle: style } : {});
const cookieStyle = () => /(?:^|; )plannotator-diff-style=([^;]*)/.exec(document.cookie)?.[1];

/** The page's own start: the cookies and the store say `style` and the defaults, and the Inbox has not read its settings yet. */
function startPage(style: 'split' | 'unified') {
  resetInboxDiffOptionsForTests();
  configStore.init({ diffOptions: { diffStyle: style, overflow: 'scroll', diffIndicators: 'bars', lineDiffType: 'word-alt', showLineNumbers: true, showDiffBackground: true, lineBgIntensity: 'subtle', tabSize: 2 } });
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
const bar = (el: ParentNode) => el.querySelector<HTMLElement>('[data-guide-message] .ib-vhead')!;
const toggle = (el: ParentNode) => bar(el).querySelector<HTMLButtonElement>('[data-diff-layout-toggle]')!;
/** How many files' diffs show their lines (a folded file draws only its header). */
const openDiffs = (el: ParentNode) => [...el.querySelectorAll('diffs-container')].filter((c) => (c as HTMLElement).shadowRoot?.querySelector('pre[data-diff] [data-line]')).length;

test.skipIf(!hasDom)('the bar carries the diff controls before Close, and no card has a Split | Unified tab', async () => {
  startPage('split');
  writeStyleOnDisk(undefined);
  const el = await openGuide();
  expect(sectionTabs(el)).toHaveLength(0);
  expect(el.querySelector('[data-diff-style-switch]')).toBeNull();
  const order = [...bar(el).querySelectorAll('button')].map((b) => b.getAttribute('aria-label'));
  expect(order.slice(-4)).toEqual(['Switch to Unified view', 'Collapse all files', 'Diff display options', 'Close the guided review']);
  expect(toggle(el).getAttribute('data-diff-layout-toggle')).toBe('split');
  await until(() => allDrawnIn(el, 'split'), 'both diffs drawn split');
}, 30_000);

test.skipIf(!hasDom)('the one button switches every diff and saves the layout where code review reads it', async () => {
  startPage('split');
  writeStyleOnDisk('split');
  const el = await openGuide();
  await until(() => allDrawnIn(el, 'split'), 'both diffs drawn split');

  act(() => toggle(el).click());
  // Every diff of the guide, both cards, redraws in one column.
  await until(() => allDrawnIn(el, 'unified'), 'both diffs drawn unified');
  // The one setting code review reads; its cookie has it at once.
  expect(configStore.get('diffStyle')).toBe('unified');
  expect(cookieStyle()).toBe('unified');
  expect(toggle(el).getAttribute('data-diff-layout-toggle')).toBe('unified');
  expect(toggle(el).getAttribute('aria-label')).toBe('Switch to Split view');
  // And config.json, through the Inbox's settings route, keeping code review's other diff options.
  await until(() => styleOnDisk() === 'unified', 'config.json to say unified');
  expect(settingsPosts.some((body) => (body.diff_options as Record<string, unknown> | undefined)?.diff_style === 'unified')).toBe(true);
  expect(diffOptionsOnDisk()).toMatchObject({ expandUnchanged: true, fontSize: '13' });

  act(() => toggle(el).click());
  expect(configStore.get('diffStyle')).toBe('split');
  await until(() => allDrawnIn(el, 'split'), 'both diffs back to split');
  await until(() => styleOnDisk() === 'split', 'config.json to say split');
}, 30_000);

test.skipIf(!hasDom)("the options chosen in code review (config.json) are the ones the guide opens on, over this browser's cookies", async () => {
  startPage('split');
  writeOptionsOnDisk({ diffStyle: 'unified', overflow: 'wrap', tabSize: 4, lineDiffType: 'char' });
  const el = await openGuide();
  await until(() => toggle(el).getAttribute('data-diff-layout-toggle') === 'unified', 'Unified from config.json');
  expect(configStore.get('diffStyle')).toBe('unified');
  expect(configStore.get('diffOverflow')).toBe('wrap');
  expect(configStore.get('diffLineDiffType')).toBe('char');
  expect(configStore.get('diffTabSize')).toBe(4);
  // The reader applies the tab size, as code review does.
  await until(() => document.documentElement.style.getPropertyValue('--diffs-tab-size') === '4', 'the tab size on the page');
  await until(() => allDrawnIn(el, 'unified'), 'both diffs drawn unified');
}, 30_000);

test.skipIf(!hasDom)('the Diff display popover has no Whole file or Hide whitespace, and what it sets reaches config.json', async () => {
  startPage('split');
  writeStyleOnDisk('split');
  const el = await openGuide();
  await until(() => allDrawnIn(el, 'split'), 'both diffs drawn split');
  act(() => bar(el).querySelector<HTMLButtonElement>('[data-diff-display-options]')!.click());
  await until(() => !!document.querySelector('[data-diff-display-popup]'), 'the popover');
  const popup = document.querySelector<HTMLElement>('[data-diff-display-popup]')!;
  const switches = [...popup.querySelectorAll('[role="switch"]')];
  expect(switches.map((s) => s.textContent)).toEqual(['Wrap long lines', 'Line numbers', 'Backgrounds']);
  expect(popup.textContent).not.toContain('Whole file');
  expect(popup.textContent).not.toContain('Hide whitespace');
  // No Split / Unified row: the bar's button sets it.
  expect(popup.textContent).not.toContain('Unified');

  act(() => (switches[0] as HTMLElement).click());
  act(() => popup.querySelector<HTMLButtonElement>('[aria-label="Increase tab size"]')!.click());
  expect(configStore.get('diffOverflow')).toBe('wrap');
  expect(configStore.get('diffTabSize')).toBe(3);
  await until(() => diffOptionsOnDisk().overflow === 'wrap' && diffOptionsOnDisk().tabSize === 3, 'config.json to keep wrap and tab size 3');
  // One POST for the two, under the wire's names; code review's own options stay.
  expect(settingsPosts.filter((body) => 'diff_options' in body).at(-1)).toMatchObject({ diff_options: { overflow: 'wrap', tab_size: 3 } });
  expect(diffOptionsOnDisk()).toMatchObject({ diffStyle: 'split', expandUnchanged: true, fontSize: '13' });
}, 30_000);

test.skipIf(!hasDom)('Collapse all folds every file, then opens them all, and writes nothing', async () => {
  startPage('split');
  writeStyleOnDisk('split');
  const el = await openGuide();
  await until(() => openDiffs(el) === 2, 'both diffs open');
  const button = () => bar(el).querySelector<HTMLButtonElement>('[data-diff-collapse-all]')!;
  const posts = settingsPosts.length;
  act(() => button().click());
  await until(() => openDiffs(el) === 0, 'both diffs folded');
  expect(button().getAttribute('aria-label')).toBe('Expand all files');
  act(() => button().click());
  await until(() => openDiffs(el) === 2, 'both diffs open again');
  expect(button().getAttribute('aria-label')).toBe('Collapse all files');
  await act(async () => {
    await new Promise((r) => setTimeout(r, 400));
  });
  expect(settingsPosts.length).toBe(posts);
}, 30_000);

test.skipIf(!hasDom)('a phone draws no controls and every diff in one column, and leaves the saved layout alone', async () => {
  phone = true;
  startPage('split');
  writeStyleOnDisk('split');
  const el = await openGuide();
  expect(sectionTabs(el)).toHaveLength(0);
  expect(el.querySelector('[data-diff-controls]')).toBeNull();
  expect(el.querySelector('[data-diff-style-switch]')).toBeNull();
  // Every diff in one column though the saved layout says Split.
  await until(() => allDrawnIn(el, 'unified'), 'both diffs drawn unified on a phone');
  // Settled: nothing asked to write a layout.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 400));
  });
  expect(settingsPosts.some((body) => 'diff_style' in body || 'diff_options' in body)).toBe(false);
  expect(configStore.get('diffStyle')).toBe('split');
  expect(styleOnDisk()).toBe('split');
}, 30_000);
