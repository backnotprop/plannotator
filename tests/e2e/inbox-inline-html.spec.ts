/**
 * Live HTML in a message (approval "inbox-inline-html", 2026-10-28), proved
 * in a real browser against the compiled binary: `plannotator inbox
 * --background` under a temp PLANNOTATOR_DATA_DIR and HOME, an agent writing
 * through `plannotator inbox mcp` (scripts/inbox-sim.ts), the browser opening
 * the thread. No real network: the web the page loads from is stubbed with
 * `context.route`. Chromium and WebKit.
 *
 * What regresses if this fails:
 * - an agent's ```html fence no longer draws as a page (or ```mermaid stops
 *   drawing), or the page loses its sandbox (an opaque origin);
 * - the page's requests reach the Inbox: any request from the embed's frame
 *   to the Inbox that leaves the browser, other than its own document (an
 *   absolute URL, a relative one, an image; counted in Chromium);
 * - the page can no longer load from the web over https (the owner's choice:
 *   "anything, like t3code's pages");
 * - a link the person clicks in the page does not open, or a page opens one
 *   on its own (T3 Code's rule: only while the frame has focus and the
 *   person's activation);
 * - the page paints its own background or the window's theme does not reach
 *   it (it would not look embedded), or it does not size to its content;
 * - Code, Full screen or Escape stop working; on a phone the page spills
 *   past the column.
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 */

import { expect, test, type BrowserContext, type Frame, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));

/** A stand-in for the web: never resolved, every request answered by `stubWeb`. */
const CDN = 'https://cdn.example.test';

/**
 * The agent's page: it loads a script and data from the web, then tries the
 * Inbox every way a page could, and writes what happened into itself.
 */
const PAGE = [
  '<style>p{margin:0 0 6px} #chart{height:160px;border-radius:6px;background:var(--chart-1)}</style>',
  `<script src="${CDN}/lib.js"></script>`,
  '<p id="lib">lib: pending</p><p id="cdn">cdn: pending</p><p id="inbox">inbox: pending</p><p id="relative">relative: pending</p><p id="img">img: pending</p>',
  '<div id="chart"></div>',
  `<p><a id="docs" href="${CDN}/docs">The docs</a></p>`,
  '<script>',
  "const say = (id, text) => { document.getElementById(id).textContent = id + ': ' + text; };",
  "say('lib', typeof window.LIB === 'string' ? window.LIB : 'missing');",
  `fetch('${CDN}/data.json').then((r) => r.json()).then((d) => say('cdn', d.ok ? 'ok' : 'bad'), () => say('cdn', 'blocked'));`,
  // The page's own address is on the Inbox: try it absolutely and relatively.
  "const inbox = new URL('/api/inbox/threads', location.href).href;",
  "fetch(inbox).then(() => say('inbox', 'reached'), () => say('inbox', 'blocked'));",
  "fetch('/api/inbox/health', { credentials: 'include' }).then(() => say('relative', 'reached'), () => say('relative', 'blocked'));",
  "const img = new Image(); img.onload = () => say('img', 'reached'); img.onerror = () => say('img', 'blocked'); img.src = '/api/inbox/health';",
  '</script>',
].join('\n');

async function stubWeb(context: BrowserContext): Promise<string[]> {
  const asked: string[] = [];
  await context.route(`${CDN}/**`, (route) => {
    const url = route.request().url();
    asked.push(url);
    if (url.endsWith('/lib.js')) return route.fulfill({ status: 200, contentType: 'text/javascript', body: 'window.LIB = "loaded";' });
    if (url.endsWith('/data.json')) return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"ok":true}' });
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<title>docs</title>docs' });
  });
  return asked;
}

const fence = (html: string) => ['```html', html, '```'].join('\n');

interface World {
  url: string;
  /** The window's origin, which serves its embeds too. */
  windowOrigin: string;
  agent: SimAgent;
  project: string;
  close(): Promise<void>;
}

async function startWorld(prefix: string): Promise<World> {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const scratch = inboxScratch(prefix);
  const root = realpathSync(scratch);
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    PLANNOTATOR_DATA_DIR: join(root, 'data'),
    PLANNOTATOR_BROWSER: NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
  };
  try {
    const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
    expect(started.status, started.stderr).toBe(0);
    const url = started.stdout.trim();
    const windowOrigin = new URL(url).origin;
    const project = scratchProject(join(root, 'src'), 'docs');
    const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
    return {
      url,
      windowOrigin,
      agent,
      project,
      close: async () => {
        await agent.close().catch(() => {});
        await removeInboxScratch(scratch);
      },
    };
  } catch (error) {
    await removeInboxScratch(scratch);
    throw error;
  }
}

/** The embed's frame in `scope`, once its page has run (`ready`: an element the page writes). */
async function embedFrame(page: Page, scope = page.locator('body'), ready = '#img', pending = 'img: pending'): Promise<Frame> {
  const handle = await scope.locator('iframe[data-html-embed-frame="inline"]').first().elementHandle();
  const frame = (await handle!.contentFrame())!;
  await expect(frame.locator(ready)).not.toHaveText(pending);
  return frame;
}

test('an html fence draws as a live, sandboxed page that loads from the web and never reaches the Inbox', async ({ browser, browserName }) => {
  // The request accounting reads Chromium's failure reasons; the rest runs in both engines.
  const accounting = browserName === 'chromium';
  const world = await startWorld('plannotator-inbox-inline-html-e2e-');
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const web = await stubWeb(context);
    await stubWeb(phone);
    const sent = await world.agent.send({
      project_path: world.project,
      subject: 'Build time per deploy',
      body: ['The index adds 40 seconds to each build:', '', fence(PAGE), '', '```mermaid', 'flowchart LR', '  A --> B', '```'].join('\n'),
    });
    const page = await context.newPage();
    // Every request the page's frame sent to the Inbox (at either loopback name). Chromium reports a
    // load its policy stopped (reason `csp`) as a request that failed; that one never left the browser.
    const toInbox: string[] = [];
    const stoppedByPolicy: string[] = [];
    const inboxOrigins = [world.windowOrigin, world.windowOrigin.replace('localhost', '127.0.0.1')];
    const fromFrame = (request: { frame(): Frame; url(): string }) =>
      request.frame() !== page.mainFrame() && inboxOrigins.some((origin) => request.url().startsWith(origin));
    page.on('request', (request) => {
      if (fromFrame(request)) toInbox.push(request.url());
    });
    page.on('requestfailed', (request) => {
      if (fromFrame(request) && request.failure()?.errorText === 'csp') stoppedByPolicy.push(request.url());
    });
    await page.goto(`${world.url}#thread=${sent.thread_id}`);
    const message = page.locator(`[data-message-id="${sent.message_id as string}"]`);

    // Diagrams still draw (Stage 0: agents are now told).
    await expect(message.locator('[data-block-id] svg').first()).toBeVisible();

    const iframe = message.locator('iframe[data-html-embed-frame="inline"]');
    await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts allow-forms');
    const frame = await embedFrame(page, message);
    const documentUrl = frame.url();
    expect(documentUrl.startsWith(`${world.windowOrigin}/api/inbox/embeds/`)).toBe(true);

    // The web over https: allowed.
    await expect(frame.locator('#lib')).toHaveText('lib: loaded');
    await expect(frame.locator('#cdn')).toHaveText('cdn: ok');
    expect(web.some((asked) => asked.endsWith('/data.json'))).toBe(true);
    // The Inbox: never, however the page asks.
    await expect(frame.locator('#inbox')).toHaveText('inbox: blocked');
    await expect(frame.locator('#relative')).toHaveText('relative: blocked');
    await expect(frame.locator('#img')).toHaveText('img: blocked');
    if (accounting) {
      const leftTheBrowser = toInbox.filter((asked) => !stoppedByPolicy.includes(asked));
      expect(leftTheBrowser.map((asked) => asked.split('#')[0])).toEqual([documentUrl.split('#')[0]]);
    }
    // An opaque origin.
    expect(await frame.evaluate(() => self.origin)).toBe('null');

    // It looks embedded: no background of its own, the window's theme and color-scheme, sized to its content.
    const look = await frame.evaluate(() => ({
      background: getComputedStyle(document.body).backgroundColor,
      htmlBackground: getComputedStyle(document.documentElement).backgroundColor,
      foreground: getComputedStyle(document.documentElement).getPropertyValue('--foreground').trim(),
      scheme: document.documentElement.style.colorScheme,
      height: Math.ceil(document.documentElement.getBoundingClientRect().height),
    }));
    expect(look.background).toBe('rgba(0, 0, 0, 0)');
    expect(look.htmlBackground).toBe('rgba(0, 0, 0, 0)');
    const windowForeground = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--foreground').trim());
    expect(look.foreground).toBe(windowForeground);
    expect(await iframe.evaluate((el: HTMLIFrameElement) => el.style.colorScheme)).toBe(look.scheme);
    await expect.poll(() => iframe.evaluate((el: HTMLIFrameElement) => el.getBoundingClientRect().height)).toBe(look.height);

    // A link the person clicks opens in a new tab.
    const embed = message.locator('[data-html-embed]');
    const opened = context.waitForEvent('page');
    await frame.locator('#docs').click();
    expect((await opened).url()).toBe(`${CDN}/docs`);

    // Code shows the source; again, the page.
    await embed.locator('[data-html-embed-code]').click();
    await expect(iframe).toHaveCount(0);
    await expect(embed).toContainText('cdn.example.test/lib.js');
    await embed.locator('[data-html-embed-code]').click();
    await expect(iframe).toHaveCount(1);

    // Full screen: the same page, large; Escape closes it and the thread stays open.
    await embed.locator('[data-html-embed-full]').click();
    const popout = page.locator('[data-html-embed-popout]');
    await expect(popout.locator('iframe[data-html-embed-frame="full"]')).toHaveAttribute('sandbox', 'allow-scripts allow-forms');
    await page.keyboard.press('Escape');
    await expect(popout).toHaveCount(0);
    await expect(message).toBeVisible();

    // A phone: the page fits the column.
    const small = await phone.newPage();
    await small.goto(`${world.url}#thread=${sent.thread_id}`);
    const smallFrame = small.locator('iframe[data-html-embed-frame="inline"]');
    await expect(smallFrame).toHaveAttribute('sandbox', 'allow-scripts allow-forms');
    await embedFrame(small);
    const box = await smallFrame.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  } finally {
    await context.close().catch(() => {});
    await phone.close().catch(() => {});
    await world.close();
  }
});


/** A page that tries to open a link on its own, every 300 ms (no one clicked it). */
const OPENER = `<p id="at">ready</p><a id="go" href="${CDN}/phish">go</a><script>setInterval(() => document.getElementById('go').click(), 300);</script>`;

test('a page cannot open a link on its own: only a click in it while it has focus opens one', async ({ browser }) => {
  const world = await startWorld('plannotator-inbox-inline-html-opener-e2e-');
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  try {
    await stubWeb(context);
    const sent = await world.agent.send({ project_path: world.project, subject: 'A page that opens links', body: ['A page:', '', fence(OPENER)].join('\n') });
    const page = await context.newPage();
    await page.goto(`${world.url}#thread=${sent.thread_id}`);
    await embedFrame(page, page.locator(`[data-message-id="${sent.message_id as string}"]`), '#at', 'never');
    await page.waitForTimeout(1500);
    expect(context.pages()).toHaveLength(1);
  } finally {
    await context.close().catch(() => {});
    await world.close();
  }
});
