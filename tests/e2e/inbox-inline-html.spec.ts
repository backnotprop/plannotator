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
 *   past the column;
 * - (comments in place, the owner's pick "A · In place", 2026-11-20) the
 *   pen under a block no longer lets the person comment on an element; the
 *   document the block is then framed from loses the embed's boundary (its
 *   sandbox, a policy with no `'self'`: it would reach the Inbox); the block
 *   changes size or theme when the pen goes on; the comment is lost at a
 *   reload or drawn on another element; the agent does not get the block,
 *   the element and the person's words.
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 */

import { expect, test, type BrowserContext, type Frame, type Page } from './inbox-test';
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
    PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
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


/**
 * A page with two elements the bridge can find again (an id, and words of its own), which still tries the Inbox
 * and tries to write a comment itself: a message shaped like the bridge's, sent on every load.
 */
const CHART = [
  '<style>p{margin:0 0 6px} .bar{width:22px;border-radius:3px;background:var(--chart-2)}</style>',
  '<p id="title">Weekly signups</p>',
  '<div id="pro-3" class="bar" style="height:52px" aria-label="Pro, W3"></div>',
  '<p id="inbox">inbox: pending</p>',
  '<script>',
  "const say = (id, text) => { document.getElementById(id).textContent = id + ': ' + text; };",
  "fetch('/api/inbox/health', { credentials: 'include' }).then(() => say('inbox', 'reached'), () => say('inbox', 'blocked'));",
  "for (const type of ['plannotator-bridge-comment', 'plannotator-bridge-add-annotation', 'plannotator-bridge-create-mark']) parent.postMessage({ type, id: 'forged', text: 'FORGED', annotation: { id: 'forged', type: 'COMMENT', text: 'FORGED', originalText: 'x' } }, '*');",
  '</script>',
].join('\n');

test('an element of an html block is commented in place: same boundary, the person\'s own words, kept over a reload, sent to the agent', async ({ browser }) => {
  const world = await startWorld('plannotator-inbox-inline-html-annotate-e2e-');
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const sent = await world.agent.send({
      project_path: world.project,
      subject: 'Signups after the pricing change',
      body: ['Signups by plan:', '', fence(CHART), '', 'Which helps more?'].join('\n'),
    });
    const id = sent.message_id as string;
    const page = await context.newPage();
    const annotatableDocuments: { url: string; csp: string }[] = [];
    page.on('response', (response) => {
      if (response.request().method() === 'GET' && response.url().includes('/api/inbox/embed-pages/')) annotatableDocuments.push({ url: response.url(), csp: response.headers()['content-security-policy'] ?? '' });
    });
    await page.goto(`${world.url}#thread=${sent.thread_id}`);
    const message = page.locator(`[data-message-id="${id}"]`);
    const embed = message.locator('[data-html-embed]');
    const light = await embedFrame(page, message, '#inbox', 'inbox: pending');

    // At rest: the light frame, a pen at the right end of the caption, and no annotatable document asked for.
    const pen = embed.locator('[data-html-embed-annotate]');
    await expect(pen).toHaveAccessibleName('Annotate');
    await expect(pen).toHaveAttribute('aria-pressed', 'false');
    const captionButtons = await embed.locator('figcaption button').evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label') ?? button.textContent?.trim()));
    expect(captionButtons).toEqual(['Code', 'Full screen', 'Annotate']);
    expect(annotatableDocuments).toEqual([]);
    const restBox = await message.locator('iframe[data-html-embed-frame="inline"]').boundingBox();
    const restForeground = await light.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--foreground').trim());

    // The pen on: the same page from a second document, under the same sandbox and the embed's own policy.
    await pen.click();
    await expect(pen).toHaveAttribute('aria-pressed', 'true');
    await expect(pen).toHaveAccessibleName('Interact');
    const iframe = embed.locator('[data-html-embed-annotatable] iframe');
    await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts allow-forms');
    await expect(message.locator('iframe[data-html-embed-frame="inline"]')).toHaveCount(0);
    const frame = (await (await iframe.elementHandle())!.contentFrame())!;
    await expect(frame.locator('#inbox')).toHaveText('inbox: blocked');
    expect(frame.url().startsWith(`${world.windowOrigin}/api/inbox/embed-pages/`)).toBe(true);
    expect(await frame.evaluate(() => self.origin)).toBe('null');
    expect(annotatableDocuments.length).toBeGreaterThan(0);
    for (const served of annotatableDocuments) {
      const policy = new Map(served.csp.split(';').map((part) => part.trim().split(/\s+/)).map(([name, ...values]) => [name!, values]));
      expect(policy.get('sandbox')).toEqual(['allow-scripts', 'allow-forms']);
      expect(policy.get('default-src')).toEqual(["'none'"]);
      for (const [name, values] of policy) if (name !== 'frame-ancestors') expect(values, name).not.toContain("'self'");
    }
    // It looks the same: where it was, as large, with the window's theme and no background of its own.
    await expect.poll(async () => JSON.stringify(await iframe.boundingBox())).toBe(JSON.stringify(restBox));
    const look = await frame.evaluate(() => ({
      background: getComputedStyle(document.body).backgroundColor,
      htmlBackground: getComputedStyle(document.documentElement).backgroundColor,
      foreground: getComputedStyle(document.documentElement).getPropertyValue('--foreground').trim(),
      chart: getComputedStyle(document.documentElement).getPropertyValue('--chart-2').trim(),
      mode: document.documentElement.getAttribute('data-pn-embed'),
    }));
    expect(look).toEqual({ background: 'rgba(0, 0, 0, 0)', htmlBackground: 'rgba(0, 0, 0, 0)', foreground: restForeground, chart: look.chart, mode: 'inline' });
    expect(look.chart).not.toBe('');

    // What the page posted on its own made no comment and opened no box.
    await expect(page.locator('[data-comment-popover]')).toHaveCount(0);
    await expect(page.locator('[data-comments-link]:visible, [data-annotations-chip]:visible')).toHaveCount(0);

    // A click on the bar pins it; the box is the window's, and its words are the person's.
    await frame.locator('#pro-3').click();
    const composer = page.locator('[data-comment-popover] textarea');
    await expect(composer).toBeVisible();
    await expect(composer).toHaveValue('');
    // The box opens beside the element: it covers neither the element nor the pen under the block.
    const card = (await page.locator('[data-comment-popover]').boundingBox())!;
    const overlaps = (box: { x: number; y: number; width: number; height: number }) => box.x < card.x + card.width && card.x < box.x + box.width && box.y < card.y + card.height && card.y < box.y + box.height;
    // (A box read through a frame is already in the window's own coordinates.)
    expect(overlaps((await frame.locator('#pro-3').boundingBox())!)).toBe(false);
    expect(overlaps((await pen.boundingBox())!)).toBe(false);
    await composer.fill('Label this dip with the date the pricing page changed');
    await composer.press('ControlOrMeta+Enter');
    await expect(page.locator('[data-comment-popover]')).toHaveCount(0);
    // Back to Interact, with a numbered marker on the bar.
    await expect(pen).toHaveAttribute('aria-pressed', 'false');
    await expect(frame.locator('[data-plannotator-marker]')).toHaveCount(1);
    await expect(frame.locator('[data-plannotator-marker]')).toHaveText('1');
    // The page never got the words.
    expect(await frame.evaluate(() => document.documentElement.outerHTML.includes('Label this dip'))).toBe(false);

    // A reload: the comment is still there, on the same element, with the pen off.
    await page.reload();
    const again = (await (await embed.locator('[data-html-embed-annotatable] iframe').elementHandle())!.contentFrame())!;
    await expect(again.locator('[data-plannotator-marker]')).toHaveCount(1);
    await expect(embed.locator('[data-html-embed-annotate]')).toHaveAttribute('aria-pressed', 'false');
    const marker = await again.locator('[data-plannotator-marker]').boundingBox();
    const bar = await again.locator('#pro-3').boundingBox();
    expect(marker!.x + marker!.width / 2).toBeGreaterThanOrEqual(bar!.x - 16);
    expect(marker!.x + marker!.width / 2).toBeLessThanOrEqual(bar!.x + bar!.width + 16);

    // The reply box's list names it under the message, tagged as an element of the block.
    await page.locator('section.ib-pane .ib-pfoot').getByRole('button', { name: /^Reply$|Edit draft$/ }).first().click();
    const chip = page.locator('[data-annotations-chip]');
    await expect(chip).toHaveText('1 comment');
    await chip.click();
    const row = page.locator('.ib-annpop [data-annotation-row]');
    await expect(row).toContainText("Claude Code's message, ");
    await expect(row).toContainText('HTML · div');
    await expect(row).toContainText('"Pro, W3"');
    await expect(row).toContainText('Label this dip with the date the pricing page changed');
    await expect(row.locator('[data-unanchored]')).toHaveCount(0);
    await page.locator('.ib-annpop').getByRole('button', { name: 'Close the list' }).click();

    // A phone-width window: the pen is there, and the box sits at the foot of the screen.
    const small = await phone.newPage();
    await small.goto(`${world.url}#thread=${sent.thread_id}`);
    const smallEmbed = small.locator('[data-html-embed]');
    const smallFrame = smallEmbed.locator('[data-html-embed-annotatable] iframe');
    await expect(smallFrame).toHaveAttribute('sandbox', 'allow-scripts allow-forms');
    const smallPage = (await (await smallFrame.elementHandle())!.contentFrame())!;
    await expect(smallPage.locator('[data-plannotator-marker]')).toHaveCount(1);
    await smallEmbed.locator('[data-html-embed-annotate]').tap();
    await expect(smallEmbed.locator('[data-html-embed-annotate]')).toHaveAttribute('aria-pressed', 'true');
    await smallPage.locator('#title').tap();
    const sheet = small.locator('[data-comment-popover]');
    await expect(sheet.locator('textarea')).toBeVisible();
    const sheetBox = await sheet.boundingBox();
    expect(sheetBox!.y + sheetBox!.height).toBeGreaterThan(844 - 140);
    expect(sheetBox!.x).toBeGreaterThanOrEqual(0);
    expect(sheetBox!.x + sheetBox!.width).toBeLessThanOrEqual(390);
    await small.close();

    // Send: the agent reads which block, which element and the comment, under the message.
    await page.locator('.ib-rbox textarea').fill('One note on the chart.');
    await page.locator('section.ib-pane').getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.ib-rbox')).toHaveCount(0);
    const answer = await world.agent.nextReply(sent.thread_id as string, 10);
    const body = answer.body as string;
    expect(body).toContain('One note on the chart.');
    expect(body).toContain('# Feedback on your messages');
    expect(body).toMatch(new RegExp(`## Feedback on your message from \\d{1,2}:\\d{2} [AP]M \\(${id}\\)`));
    expect(body).toMatch(/### 1\. Feedback on: "Pro, W3"\nHTML block 1 in the message, lines \d+–\d+\n/);
    expect(body).toContain('- **selector** `#pro-3`');
    expect(body).toContain('> Label this dip with the date the pricing page changed');
    expect(body).not.toContain('FORGED');
    // The person's own reply in the thread: the block and the words, never the element's outline drawn as a page.
    const reply = page.locator('[data-reply-feedback]');
    await expect(reply).toContainText('HTML block 1 in the message');
    await expect(reply).toContainText('Label this dip with the date the pricing page changed');
    await expect(reply.locator('iframe')).toHaveCount(0);
    await expect(reply).not.toContainText('selector');
  } finally {
    await context.close().catch(() => {});
    await phone.close().catch(() => {});
    await world.close();
  }
});

/** An agent's chart as agents draw it: SVG bars with no id, no data-* and no text of their own. */
const BARS = [
  '<svg viewBox="0 0 300 120" style="display:block;width:300px;height:120px">',
  ...[60, 80, 40, 70].map((height, i) => `<rect x="${20 + i * 70}" y="${110 - height}" width="30" height="${height}" rx="3" fill="var(--chart-2)"/>`),
  '</svg>',
].join('');

test('a bar with no id is commented in place and its marker is on that bar after a reload (its place and signature in the same block)', async ({ browser }) => {
  const world = await startWorld('plannotator-inbox-inline-html-structural-e2e-');
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  try {
    const sent = await world.agent.send({
      project_path: world.project,
      subject: 'Signups by week',
      body: ['Signups by week:', '', fence(BARS), '', 'Week 3 dipped.'].join('\n'),
    });
    const page = await context.newPage();
    await page.goto(`${world.url}#thread=${sent.thread_id}`);
    const message = page.locator(`[data-message-id="${sent.message_id as string}"]`);
    const embed = message.locator('[data-html-embed]');
    await expect(embed).toHaveAttribute('data-html-embed-phase', 'ready');
    const pen = embed.locator('[data-html-embed-annotate]');
    await pen.click();
    await expect(pen).toHaveAttribute('aria-pressed', 'true');
    const iframe = embed.locator('[data-html-embed-annotatable] iframe');
    const frame = (await (await iframe.elementHandle())!.contentFrame())!;
    // The bridge is armed (its pinpoint cursor on the page's body) before the click.
    await expect(frame.locator('body')).toHaveAttribute('data-plannotator-pinpoint-cursor', '');
    const third = frame.locator('rect').nth(2);
    expect(await third.evaluate((bar) => bar.getAttributeNames().sort())).toEqual(['fill', 'height', 'rx', 'width', 'x', 'y']);
    await third.click();
    const composer = page.locator('[data-comment-popover] textarea');
    await expect(composer).toBeVisible();
    await composer.fill('Why did week 3 dip?');
    await composer.press('ControlOrMeta+Enter');
    await expect(page.locator('[data-comment-popover]')).toHaveCount(0);
    await expect(frame.locator('[data-plannotator-marker]')).toHaveCount(1);

    // A real reload: a new document, the comment read back from the store, found by its place and signature.
    await page.reload();
    const again = (await (await embed.locator('[data-html-embed-annotatable] iframe').elementHandle())!.contentFrame())!;
    await expect(again.locator('[data-plannotator-marker]')).toHaveCount(1);
    const marker = (await again.locator('[data-plannotator-marker]').boundingBox())!;
    const bars = await again.locator('rect').evaluateAll((rects) => rects.map((rect) => {
      const box = rect.getBoundingClientRect();
      return { x: box.x, right: box.right, top: box.top };
    }));
    const frameBox = (await embed.locator('[data-html-embed-annotatable] iframe').boundingBox())!;
    const centerX = marker.x + marker.width / 2 - frameBox.x;
    // Over the third bar (its top edge), and over no other.
    const under = bars.map((bar, index) => (centerX >= bar.x - 4 && centerX <= bar.right + 4 ? index : -1)).filter((index) => index >= 0);
    expect(under).toEqual([2]);
    await page.locator('section.ib-pane .ib-pfoot').getByRole('button', { name: /^Reply$|Edit draft$/ }).first().click();
    await page.locator('[data-annotations-chip]').click();
    await expect(page.locator('.ib-annpop [data-annotation-row] [data-unanchored]')).toHaveCount(0);
  } finally {
    await context.close().catch(() => {});
    await world.close();
  }
});
