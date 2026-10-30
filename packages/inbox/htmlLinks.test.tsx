/**
 * Links inside an attached HTML page: the whole window (InboxApp) over a REAL
 * Inbox server in a temp data dir (its own process,
 * tests/helpers/inbox-dom-server.ts in its `html-links` mode). The page's
 * bridge is played by a `link-click` message from the page's own frame, as
 * the bridge posts it in Interact. What is proved: a sibling page that is not
 * attached opens read-only over the page with Back, the note and Open in new
 * tab, and Back returns; a link to another attachment of the thread opens it
 * in the pane as a new history entry; an image in the folder that is not
 * attached opens in the lightbox through the page's asset route; another
 * site opens a new tab; a PDF says why it does not open. A pinpoint draft on
 * the page arms shift-click multi-select without a cap of 0, so more elements
 * join the one comment (the bridge's selection and multi-target messages played
 * from the frame).
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { NO_BROWSER } from '../../tests/helpers/no-browser';

const hasDom = typeof document !== 'undefined';
const { InboxApp } = (hasDom ? await import('./App') : {}) as typeof import('./App');

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');
const LINK_CLICK = 'plannotator-bridge-link-click';

type World = { project: string; htmlLinks: { thread: string; ids: Record<string, string> } };

let child: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;
let worlds: World[] = [];
let world: World;
let dir: string | null = null;
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedEventSource: unknown;
let savedOpen: typeof window.open;
let opened: string[] = [];

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

const TESTS = 10;

beforeAll(async () => {
  if (!hasDom) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-htmllinks-dom-')));
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), String(TESTS), 'html-links'], {
    env: {
      ...process.env,
      DOM_TESTS: '0',
      PLANNOTATOR_DATA_DIR: join(dir, 'data'),
      PLANNOTATOR_BROWSER: NO_BROWSER,
      PLANNOTATOR_INBOX_CONNECT: '0',
      HOME: dir,
    },
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
  world = worlds.shift()!;
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
  opened = [];
  savedOpen = window.open;
  window.open = ((url?: string | URL) => {
    opened.push(String(url));
    return null;
  }) as typeof window.open;
  window.location.hash = '';
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
  window.open = savedOpen;
  (globalThis as Record<string, unknown>).EventSource = savedEventSource;
  // A view switch pressed in a test is remembered (fileView.ts): forgotten, so the next test opens by the rule.
  document.cookie = 'plannotator-inbox-file-view=; path=/; max-age=0';
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

async function renderSheet() {
  // Beside the thread (`view=side`), where the comments panel is docked: a link without it opens an HTML page full screen.
  window.location.hash = `#thread=${world.htmlLinks.thread}&file=${world.htmlLinks.ids['SHEET.html']}&view=side`;
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<InboxApp />);
  });
  await until(() => host!.querySelector('.ib-view .ib-htmlframe iframe') !== null, 'the attached page');
  return host;
}

/** The page's bridge relaying a link click (in Interact), from the frame it lives in. */
async function clickLink(frame: HTMLIFrameElement, href: string) {
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { type: LINK_CLICK, href } }));
  });
}

const sheetFrame = (el: ParentNode) => el.querySelector<HTMLIFrameElement>('.ib-view .ib-htmlframe iframe')!;

test.skipIf(!hasDom)('a sibling page that is not attached opens read-only over the page, with Back, and Back returns', async () => {
  const el = await renderSheet();
  await clickLink(sheetFrame(el), 'B-cards.html#pr1');
  await until(() => el.querySelector('[data-linked-page="B-cards.html"]') !== null, 'the linked page');
  const band = el.querySelector<HTMLElement>('.ib-linkband')!;
  expect(band.querySelector('[data-linked-back]')!.textContent).toContain('Back to SHEET.html');
  expect(band.querySelector('[data-linked-note]')!.textContent).toContain('is not attached, so comments are off');
  expect(band.querySelector<HTMLAnchorElement>('[data-linked-open-tab]')!.getAttribute('href')).toMatch(/^\/api\/html-assets\/[A-Za-z0-9_-]+\/B-cards\.html$/);
  // The attached page stays mounted under it, hidden and inert.
  const covered = el.querySelector<HTMLElement>('.ib-htmlframe.ib-covered')!;
  expect(covered.hasAttribute('inert')).toBe(true);
  // The page is in the route (one history entry each), and the panel says comments are off on it.
  expect(new URLSearchParams(window.location.hash.slice(1)).get('linked')).toBe('B-cards.html#pr1');
  expect(el.querySelector('[data-annotation-panel-note]')?.textContent).toBe('Off on B-cards.html');
  // The empty panel says where comments go, never "Select text to annotate" beside "Off on".
  expect(el.querySelector('.ib-view')!.textContent).not.toContain('Select text to annotate');
  expect(el.querySelector('.ib-view')!.textContent).toContain('Comment on SHEET.html, not on this page');
  // From the sibling, a further sibling: Back names the page before it.
  const linkedFrame = el.querySelector<HTMLIFrameElement>('.ib-linkedframe iframe')!;
  await clickLink(linkedFrame, 'C-between.html');
  await until(() => el.querySelector('[data-linked-page="C-between.html"]') !== null, 'the second linked page');
  expect(el.querySelector('[data-linked-back]')!.textContent).toContain('Back to B-cards.html');
  await act(async () => el.querySelector<HTMLButtonElement>('[data-linked-back]')!.click());
  await until(() => el.querySelector('[data-linked-page="B-cards.html"]') !== null, 'back on B');
  await act(async () => el.querySelector<HTMLButtonElement>('[data-linked-back]')!.click());
  await until(() => el.querySelector('[data-linked-page]') === null, 'back on the attached page');
  expect(el.querySelector('.ib-htmlframe.ib-covered')).toBeNull();
  // A link from a sibling back to the attached page clears the stack too.
  await clickLink(sheetFrame(el), 'B-cards.html');
  await until(() => el.querySelector('[data-linked-page="B-cards.html"]') !== null, 'the linked page again');
  await clickLink(el.querySelector<HTMLIFrameElement>('.ib-linkedframe iframe')!, 'SHEET.html');
  await until(() => el.querySelector('[data-linked-page]') === null, 'home');
});

test.skipIf(!hasDom)("Back from a linked page after a view switch goes back to the page's entry, in the view the person is in now", async () => {
  const el = await renderSheet();
  await clickLink(sheetFrame(el), 'B-cards.html');
  await until(() => el.querySelector('[data-linked-page="B-cards.html"]') !== null, 'the linked page');
  const params = () => new URLSearchParams(window.location.hash.slice(1));
  expect(params().get('view')).toBe('side');
  const entries = window.history.length;
  // Full screen, pressed on the linked page: a new entry over the linked page beside the thread (fullScreenOrigin.ts).
  await act(async () => el.querySelector<HTMLButtonElement>('.ib-vhead [data-full-screen-toggle]')!.click());
  await until(() => el.querySelector('.ib-view')?.hasAttribute('data-full-view') === true, 'full screen');
  expect(params().get('view')).toBe('full');
  expect(window.history.length).toBe(entries + 1);
  // Back: the browser's Back past the switch and the linked page to the page's entry, then full screen again with the switch.
  await act(async () => el.querySelector<HTMLButtonElement>('[data-linked-back]')!.click());
  await until(() => el.querySelector('[data-linked-page]') === null, 'back on the attached page');
  await until(() => params().get('view') === 'full', 'the page in full screen');
  expect(params().get('linked')).toBeNull();
  // No entry left over: back two, one new (happy-dom drops the entries left by a Back; a browser keeps them for Forward).
  expect(window.history.length).toBeLessThanOrEqual(entries);
  expect(el.querySelector('.ib-view')!.hasAttribute('data-full-view')).toBe(true);
  // × still knows full screen came from beside the thread: the page goes back beside it.
  const exit = el.querySelector<HTMLButtonElement>('[data-full-view-close]')!;
  expect(exit.getAttribute('aria-label')).toBe('Exit full screen');
  await act(async () => exit.click());
  await until(() => el.querySelector('.ib-view') !== null && !el.querySelector('.ib-view')!.hasAttribute('data-full-view'), 'the page beside the thread');
  expect(params().get('linked')).toBeNull();
  expect(params().get('view')).toBe('side');
});

test.skipIf(!hasDom)('Back takes focus once it is drawn, even when the next frame comes before React draws it', async () => {
  const el = await renderSheet();
  // A loaded browser can run the next animation frame before React commits the page a link opened.
  // Frames run as soon as asked (a microtask, ahead of React's commit); one asked from inside such a
  // frame waits for a real one, so no loop spins.
  const realFrame = window.requestAnimationFrame;
  let inEarlyFrame = false;
  window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    if (inEarlyFrame) return realFrame(cb);
    queueMicrotask(() => {
      inEarlyFrame = true;
      try {
        cb(performance.now());
      } finally {
        inEarlyFrame = false;
      }
    });
    return 0;
  }) as typeof window.requestAnimationFrame;
  try {
    await clickLink(sheetFrame(el), 'B-cards.html');
    await until(() => el.querySelector('[data-linked-page="B-cards.html"]') !== null, 'the linked page');
    await until(() => document.activeElement === el.querySelector('[data-linked-back]'), 'focus on Back');
    // A further page: the same Back button stays mounted, and takes focus again.
    (document.activeElement as HTMLElement).blur();
    await clickLink(el.querySelector<HTMLIFrameElement>('.ib-linkedframe iframe')!, 'C-between.html');
    await until(() => el.querySelector('[data-linked-page="C-between.html"]') !== null, 'the second linked page');
    await until(() => document.activeElement === el.querySelector('[data-linked-back]'), 'focus on Back again');
  } finally {
    window.requestAnimationFrame = realFrame;
  }
}, 20_000);

test.skipIf(!hasDom)('a linked page drawn after the person moved into the reply box leaves focus there', async () => {
  // A deep link names the linked page; its page reads before the file's own view, so Back is drawn late.
  let releaseView: () => void = () => {};
  const viewHeld = new Promise<void>((done) => (releaseView = done));
  let linkedRead = false;
  const answer = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (/\/attachments\/[^/]+\/view/.test(path)) await viewHeld;
    const response = await answer(input, init);
    if (path.includes('/linked-page?')) linkedRead = true;
    return response;
  }) as typeof fetch;
  window.location.hash = `#thread=${world.htmlLinks.thread}&file=${world.htmlLinks.ids['SHEET.html']}&linked=B-cards.html`;
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<InboxApp />);
  });
  const el = host;
  await until(() => linkedRead, 'the linked page read');
  // Meanwhile the person opens the reply box and starts typing.
  await until(() => [...el.querySelectorAll<HTMLButtonElement>('.ib-pfoot button')].some((b) => b.textContent?.trim() === 'Reply'), 'the Reply button');
  await act(async () => [...el.querySelectorAll<HTMLButtonElement>('.ib-pfoot button')].find((b) => b.textContent?.trim() === 'Reply')!.click());
  await until(() => el.querySelector('textarea[aria-label^="Reply to"]') !== null, 'the reply box');
  const reply = el.querySelector<HTMLTextAreaElement>('textarea[aria-label^="Reply to"]')!;
  reply.focus();
  expect(document.activeElement === reply).toBe(true);
  // The file's view arrives: the linked page is drawn, and focus stays in the reply box.
  await act(async () => releaseView());
  await until(() => el.querySelector('[data-linked-page="B-cards.html"] [data-linked-back]') !== null, 'the linked page');
  await act(async () => {
    await new Promise((r) => setTimeout(r, 100));
  });
  expect(document.activeElement?.hasAttribute('data-linked-back') ?? false).toBe(false);
  expect(document.activeElement === reply).toBe(true);
}, 20_000);

test.skipIf(!hasDom)('Escape from the pane steps back one linked page, before the rest of the ladder', async () => {
  const el = await renderSheet();
  await clickLink(sheetFrame(el), 'B-cards.html');
  await until(() => el.querySelector('[data-linked-page="B-cards.html"]') !== null, 'the linked page');
  await clickLink(el.querySelector<HTMLIFrameElement>('.ib-linkedframe iframe')!, 'C-between.html');
  await until(() => el.querySelector('[data-linked-page="C-between.html"]') !== null, 'the second linked page');
  const pane = el.querySelector<HTMLElement>('.ib-view')!;
  const escape = async () => {
    pane.focus();
    await act(async () => pane.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  };
  await escape();
  await until(() => el.querySelector('[data-linked-page="B-cards.html"]') !== null, 'back on B');
  await escape();
  await until(() => el.querySelector('[data-linked-page]') === null, 'back on the attached page');
  // The file is still open: the ladder's next rung is the file's own, not the linked page's.
  expect(el.querySelector(`[data-attachment-pane="${world.htmlLinks.ids['SHEET.html']}"]`)).not.toBeNull();
});

test.skipIf(!hasDom)('a link to another attachment of the thread opens it in the pane', async () => {
  const el = await renderSheet();
  const imageId = world.htmlLinks.ids['a.png']!;
  await clickLink(sheetFrame(el), 'frames/a.png');
  await until(() => window.location.hash.includes(`file=${imageId}`), 'the route on the image');
  await until(() => el.querySelector(`[data-attachment-pane="${imageId}"]`) !== null, 'the image in the pane');
});

test.skipIf(!hasDom)('an image in the folder that is not attached opens in the lightbox through the asset route', async () => {
  const el = await renderSheet();
  await clickLink(sheetFrame(el), 'frames/b.png');
  await until(() => document.querySelector('[data-image-lightbox]') !== null, 'the lightbox');
  const img = document.querySelector<HTMLImageElement>('[data-image-lightbox] img')!;
  expect(img.getAttribute('src')).toMatch(/^\/api\/html-assets\/[A-Za-z0-9_-]+\/frames\/b\.png$/);
  // The pane still shows the attached page.
  expect(el.querySelector(`[data-attachment-pane="${world.htmlLinks.ids['SHEET.html']}"]`)).not.toBeNull();
  await act(async () => document.querySelector<HTMLElement>('[data-image-lightbox]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
});

test.skipIf(!hasDom)('another site opens a new tab', async () => {
  const el = await renderSheet();
  await clickLink(sheetFrame(el), 'https://example.com/x');
  expect(opened).toEqual(['https://example.com/x']);
});

test.skipIf(!hasDom)('a file that is neither attached nor a page or image says why, never silent', async () => {
  const el = await renderSheet();
  await clickLink(sheetFrame(el), 'report.pdf');
  await until(() => el.querySelector('[data-link-note="shown"]') !== null, 'the note');
  expect(el.querySelector('[data-link-note]')!.textContent).toContain('report.pdf is not attached to this thread');
  expect(el.querySelector('[data-step-live]')!.textContent === '' || el.querySelector('[data-step-live]')!.textContent!.includes('report.pdf')).toBe(true);
  // Outside the page's folder.
  await clickLink(sheetFrame(el), '../../elsewhere.html');
  await until(() => el.querySelector('[data-link-note]')!.textContent!.includes('outside this page'), 'the outside note');
});

test.skipIf(!hasDom)('a pin on the page arms shift-click: more elements join the one comment', async () => {
  const el = await renderSheet();
  const frame = sheetFrame(el);
  // What the pane posts into the page (the arm the bridge waits for).
  const posted: Array<Record<string, unknown>> = [];
  const realPost = frame.contentWindow!.postMessage.bind(frame.contentWindow);
  (frame.contentWindow as unknown as { postMessage: (data: unknown, ...rest: unknown[]) => void }).postMessage = (data: unknown, ...rest: unknown[]) => {
    if (data && typeof data === 'object') posted.push(data as Record<string, unknown>);
    return (realPost as (...args: unknown[]) => void)(data, ...rest);
  };
  const fromPage = (data: Record<string, unknown>) =>
    act(async () => {
      window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data }));
    });
  const rect = { top: 10, left: 10, width: 120, height: 24 };
  await fromPage({
    type: 'plannotator-bridge-selection',
    text: 'Guided narrative: contact sheet',
    rect,
    pinpoint: true,
    targetKey: 'ht-1',
    targetLabel: 'Heading',
    anchor: { selector: 'h1', tagName: 'h1', text: 'Guided narrative: contact sheet' },
  });
  await until(() => document.querySelector('[data-comment-popover]') !== null, 'the composer');
  const arm = posted.find((m) => m.type === 'plannotator-bridge-arm-multi-select');
  expect(arm).toBeDefined();
  // No cap of 0: the bridge would refuse every shift-click.
  expect(arm!.max === undefined || (arm!.max as number) > 0).toBe(true);
  for (const [key, text] of [['ht-2', 'Three directions.'], ['ht-3', 'A: Story page']]) {
    await fromPage({ type: 'plannotator-bridge-multi-target-added', key, label: 'Element', text, rect, anchor: { selector: `#${key}`, tagName: 'p', text } });
  }
  await until(() => document.querySelectorAll('[data-target-chip]').length === 3, 'three targets on the one comment');
});
