/**
 * Links in annotate's HTML surfaces follow one rule with the Inbox (the
 * owner's ruling html-link-click and its amendment, 2026-10-20), proved in a
 * real browser against the compiled binary: armed (Annotate, the default), a
 * plain click on a link follows it and a Cmd/Ctrl-click pins it for a
 * comment; on a phone a tap follows and a press-and-hold pins, and the
 * release after a hold follows nothing. On a touchscreen laptop (touch seen,
 * then a mouse drag) a selection across a link still quotes the link's words.
 * Shift-click joins more elements, a link among them, to one comment.
 *
 * Two surfaces: a local HTML file (`plannotator annotate index.html`, the
 * srcdoc viewer) and a live app (`plannotator annotate http://localhost:<port>/`,
 * the loopback proxy), where following a link is the app navigating for real.
 * The live app is a tiny loopback server started here; nothing is mocked.
 * Each annotate CLI runs under a temp PLANNOTATOR_DATA_DIR and HOME and is
 * closed with /api/exit.
 *
 * Screenshots go to PLANNOTATOR_HTML_LINKS_SHOTS when it is set.
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 */

import { chromium, devices, expect, test, webkit, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shots = process.env.PLANNOTATOR_HTML_LINKS_SHOTS ?? '';

const STYLE = '<style>body{font:16px/1.5 system-ui;margin:32px;color:#222;background:#fafaf7}a{color:#2563eb;display:inline-block;padding:6px 0}</style>';

async function shot(page: Page, name: string) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(shots, `${name}.png`) });
}

/** A live app on loopback: two pages that link to each other. */
async function liveApp(): Promise<{ server: Server; origin: string }> {
  const pages: Record<string, string> = {
    '/': `<!doctype html><html><head><meta charset="utf-8"><title>Live home</title>${STYLE}</head><body><h1>Live home</h1><p>An app running on this computer.</p><p><a href="/settings">Settings</a></p><script>/* A press library's shape: open on pointerdown, closed on pointerup or pointercancel. */window.__press=false;window.__cancels=0;var l=document.querySelector('a');l.addEventListener('pointerdown',function(){window.__press=true});l.addEventListener('pointerup',function(){window.__press=false});l.addEventListener('pointercancel',function(){window.__press=false;window.__cancels++});</script></body></html>`,
    '/settings': `<!doctype html><html><head><meta charset="utf-8"><title>Settings</title>${STYLE}</head><body><h1>Settings page</h1><p><a href="/">Home</a></p></body></html>`,
  };
  const server = createServer((req, res) => {
    const body = pages[(req.url ?? '/').split('?')[0]!];
    if (!body) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return { server, origin: `http://localhost:${(server.address() as AddressInfo).port}` };
}

/** `plannotator annotate <target>` in a scratch folder; resolves its session URL. */
async function annotate(target: (root: string) => string) {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-annotate-htmllinks-e2e-');
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  const readyFile = join(root, 'ready.jsonl');
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_READY_FILE: readyFile,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_BROWSER,
    PLANNOTATOR_SKIP_BROWSER_OPEN: '1',
    PLANNOTATOR_REMOTE: '0',
    PLANNOTATOR_INBOX_CONNECT: '0',
  };
  const child: ChildProcess = spawn(binary, ['annotate', target(root)], { env, cwd: root, stdio: 'ignore' });
  await expect.poll(() => (existsSync(readyFile) ? readFileSync(readyFile, 'utf8') : ''), { timeout: 30_000 }).toContain('"url"');
  const url = (JSON.parse(readFileSync(readyFile, 'utf8').trim().split('\n')[0]!) as { url: string }).url;
  const close = async () => {
    await fetch(new URL('/api/exit', url), { method: 'POST' }).catch(() => {});
    if (child.exitCode === null) {
      await new Promise((done) => {
        const timer = setTimeout(done, 5_000);
        child.once('exit', () => {
          clearTimeout(timer);
          done(undefined);
        });
      });
      // inbox-guard: own child (the annotate CLI this test spawned, never an Inbox)
      if (child.exitCode === null) child.kill('SIGTERM');
    }
    await removeInboxScratch(root);
  };
  return { url, close };
}

async function newSession(browser: Browser, url: string, options: Parameters<Browser['newContext']>[0] = {}): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext(options);
  // The first-run dialogs already answered.
  await context.addCookies(
    [
      ['plannotator-plan-look-choice-resolved', 'true'],
      ['plannotator-announce-tui-herdr-seen', '1'],
      ['plannotator-announce-inbox-seen', '1'],
      ['plannotator-announce-ask-session-seen', '1'],
      ['plannotator-announce-agent-tool-seen', '1'],
    ].map(([name, value]) => ({ name: name!, value: value!, url })),
  );
  const page = await context.newPage();
  await page.goto(url);
  return { context, page };
}

/** Press and hold for `ms`, then lift: a real touch in Chromium (DevTools protocol), the page's touch events in WebKit. */
async function holdLink(page: Page, link: Locator, browserName: string, ms = 750) {
  const box = (await link.boundingBox())!;
  const x = box.x + Math.min(12, box.width / 2);
  const y = box.y + box.height / 2;
  if (browserName === 'chromium') {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await page.waitForTimeout(ms);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
    return;
  }
  await link.evaluate(async (el, hold) => {
    const r = el.getBoundingClientRect();
    const point = { identifier: 1, clientX: r.left + Math.min(12, r.width / 2), clientY: r.top + r.height / 2, target: el };
    const fire = (type: string, touches: unknown[]) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'touches', { value: touches });
      Object.defineProperty(event, 'changedTouches', { value: [point] });
      el.dispatchEvent(event);
      return event;
    };
    fire('touchstart', [point]);
    await new Promise((done) => setTimeout(done, hold));
    const end = fire('touchend', []);
    if (!end.defaultPrevented) el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: point.clientX, clientY: point.clientY }));
  }, ms);
}

const LOCAL_INDEX = `<!doctype html><html><head><meta charset="utf-8"><title>Index</title>${STYLE}</head><body><h1>Report index</h1><p id="lead">Start with <a href="02-detail.html">the detail page</a> today.</p></body></html>`;
const LOCAL_DETAIL = `<!doctype html><html><head><meta charset="utf-8"><title>Detail</title>${STYLE}</head><body><h1>Detail page</h1><p><a href="index.html">Back to the index</a></p></body></html>`;

function writeSite(root: string) {
  const site = join(root, 'site');
  mkdirSync(site, { recursive: true });
  writeFileSync(join(site, 'index.html'), LOCAL_INDEX);
  writeFileSync(join(site, '02-detail.html'), LOCAL_DETAIL);
  return join(site, 'index.html');
}

test('a local HTML file, armed: a plain click follows the link, a Cmd/Ctrl-click pins it', async ({ browser }) => {
  const { url, close } = await annotate(writeSite);
  try {
    const { context, page } = await newSession(browser, url, { viewport: { width: 1280, height: 860 } });
    try {
      const frame = page.frameLocator('iframe[sandbox]');
      await expect(frame.locator('h1')).toHaveText('Report index');
      await frame.getByRole('link', { name: 'the detail page' }).click({ modifiers: ['ControlOrMeta'] });
      const composer = page.locator('[data-comment-popover]');
      await expect(composer).toBeVisible();
      await expect(frame.locator('h1')).toHaveText('Report index');
      await shot(page, 'annotate-1-cmd-click-pins');
      await page.keyboard.press('Escape');
      await expect(composer).toHaveCount(0);
      await frame.getByRole('link', { name: 'the detail page' }).click();
      await expect(frame.locator('h1')).toHaveText('Detail page');
      await expect(composer).toHaveCount(0);
      await shot(page, 'annotate-2-click-follows');
    } finally {
      await context.close();
    }
  } finally {
    await close();
  }
});

/**
 * A click with Shift held down first, as a person makes it: the composer over
 * the page lets the pointer through while Shift is held, once the pointer is
 * over the page (waited for here, so the press lands on the page, not the composer).
 */
async function shiftClick(page: Page, target: Locator) {
  const box = (await target.boundingBox())!;
  const x = box.x + Math.min(10, box.width / 2);
  const y = box.y + box.height / 2;
  await page.keyboard.down('Shift');
  await page.mouse.move(x, y);
  await expect.poll(() => page.evaluate(([px, py]) => document.elementFromPoint(px!, py!)?.tagName, [x, y])).toBe('IFRAME');
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.up('Shift');
}

test('a local HTML file, armed: shift-click joins more elements to one comment, a link among them', async ({ browser }) => {
  const { url, close } = await annotate(writeSite);
  try {
    const { context, page } = await newSession(browser, url, { viewport: { width: 1280, height: 860 } });
    try {
      const frame = page.frameLocator('iframe[sandbox]');
      await expect(frame.locator('h1')).toHaveText('Report index');
      await frame.locator('h1').click();
      const composer = page.locator('[data-comment-popover]');
      await expect(composer).toBeVisible();
      await shiftClick(page, frame.locator('#lead'));
      await shiftClick(page, frame.getByRole('link', { name: 'the detail page' }));
      await expect(page.locator('[data-target-chip]')).toHaveCount(3);
      // The link was added, not followed.
      await expect(frame.locator('h1')).toHaveText('Report index');
      await shot(page, 'annotate-shift-click-three-targets');
    } finally {
      await context.close();
    }
  } finally {
    await close();
  }
});

test('a touchscreen laptop: after a touch, a mouse drag across a link still quotes the link text', async ({ browser }) => {
  const { url, close } = await annotate(writeSite);
  try {
    const { context, page } = await newSession(browser, url, { viewport: { width: 1280, height: 860 }, hasTouch: true });
    try {
      const frame = page.frameLocator('iframe[sandbox]');
      await expect(frame.locator('h1')).toHaveText('Report index');
      // One touch: a tap on the heading pins it; Escape closes the composer.
      await frame.locator('h1').tap();
      const composer = page.locator('[data-comment-popover]');
      await expect(composer).toBeVisible();
      // A touch-opened composer is the full-screen dialog, which takes focus on a 0 ms timer and handles
      // Escape itself; pressed before that timer runs (a loaded runner), the key goes nowhere.
      await expect(page.getByRole('dialog', { name: 'Comment' })).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(composer).toHaveCount(0);
      expect(await frame.locator('body').evaluate((b) => b.hasAttribute('data-plannotator-touch'))).toBe(true);
      // A mouse drag from the paragraph's first word to its last, across the link.
      const lead = frame.locator('#lead');
      const box = (await lead.boundingBox())!;
      const right = await lead.evaluate((p) => {
        const r = document.createRange();
        r.selectNodeContents(p);
        const rects = r.getClientRects();
        return rects[rects.length - 1]!.right - p.getBoundingClientRect().left;
      });
      await page.mouse.move(box.x + 1, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + right / 2, box.y + box.height / 2, { steps: 5 });
      await page.mouse.move(box.x + right - 1, box.y + box.height / 2, { steps: 5 });
      await page.mouse.up();
      expect(await lead.evaluate(() => (getSelection()?.toString() ?? '').replace(/\s+/g, ' ').trim())).toBe('Start with the detail page today.');
      // The selection toolbar's Comment opens the composer quoting the whole sentence, link words included.
      await page.getByRole('button', { name: 'Comment', exact: true }).click();
      await expect(composer).toBeVisible();
      await expect(composer).toContainText('Start with the detail page today.');
      await shot(page, 'annotate-3-touch-laptop-drag-quotes-link');
    } finally {
      await context.close();
    }
  } finally {
    await close();
  }
});

test('a live app, armed: a plain click navigates the app for real, a Cmd/Ctrl-click pins the link', async ({ browser }) => {
  const app = await liveApp();
  const { url, close } = await annotate(() => `${app.origin}/`);
  try {
    const { context, page } = await newSession(browser, url, { viewport: { width: 1280, height: 860 } });
    try {
      const frame = page.frameLocator('iframe:not([sandbox])');
      await expect(frame.locator('h1')).toHaveText('Live home');
      await frame.getByRole('link', { name: 'Settings' }).click({ modifiers: ['ControlOrMeta'] });
      const composer = page.locator('[data-comment-popover]');
      await expect(composer).toBeVisible();
      await page.waitForTimeout(400);
      await expect(frame.locator('h1')).toHaveText('Live home');
      await shot(page, 'live-1-cmd-click-pins');
      await page.keyboard.press('Escape');
      await expect(composer).toHaveCount(0);
      await frame.getByRole('link', { name: 'Settings' }).click();
      await expect(frame.locator('h1')).toHaveText('Settings page');
      await expect(composer).toHaveCount(0);
      await shot(page, 'live-2-click-follows');
    } finally {
      await context.close();
    }
  } finally {
    await close();
    await new Promise((done) => app.server.close(done));
  }
});

for (const phone of [
  { name: 'iPhone 15 (WebKit)', device: devices['iPhone 15'], browserName: 'webkit' as const },
  { name: 'Pixel 7 (Chromium)', device: devices['Pixel 7'], browserName: 'chromium' as const },
]) {
  test(`a live app on a phone, ${phone.name}: a tap follows a link, a press-and-hold pins it and navigates nothing`, async () => {
    const app = await liveApp();
    const { url, close } = await annotate(() => `${app.origin}/`);
    // (WebKit launches without the config's Chromium flags, --use-mock-keychain and --password-store=basic, which Linux WebKit exits on.)
    const browser = phone.browserName === 'webkit' ? await webkit.launch({ args: [] }) : await chromium.launch();
    try {
      const { context, page } = await newSession(browser, url, { ...phone.device });
      const frame = page.frameLocator('iframe:not([sandbox])');
      await expect(frame.locator('h1')).toHaveText('Live home');
      await holdLink(page, frame.getByRole('link', { name: 'Settings' }), phone.browserName);
      const composer = page.locator('[data-comment-popover]');
      await expect(composer).toBeVisible();
      await page.waitForTimeout(600);
      await expect(frame.locator('h1')).toHaveText('Live home');
      // The app's press ended (the bridge stopped the release and sent cancels in its place).
      const press = await frame.locator('body').evaluate(() => ({ press: (window as unknown as { __press: boolean }).__press, cancels: (window as unknown as { __cancels: number }).__cancels }));
      expect(press.press).toBe(false);
      if (phone.browserName === 'chromium') expect(press.cancels).toBeGreaterThanOrEqual(1);
      await shot(page, `live-3-phone-hold-pins-${phone.browserName}`);
      await page.keyboard.press('Escape').catch(() => {});
      await expect(composer).toHaveCount(0);
      await frame.getByRole('link', { name: 'Settings' }).tap();
      await expect(frame.locator('h1')).toHaveText('Settings page');
      await shot(page, `live-4-phone-tap-follows-${phone.browserName}`);
      await context.close();
    } finally {
      await browser.close().catch(() => {});
      await close();
      await new Promise((done) => app.server.close(done));
    }
  });

  test(`a local HTML file on a phone, ${phone.name}: a tap follows a link, a press-and-hold pins it`, async () => {
    const { url, close } = await annotate(writeSite);
    // (WebKit launches without the config's Chromium flags, --use-mock-keychain and --password-store=basic, which Linux WebKit exits on.)
    const browser = phone.browserName === 'webkit' ? await webkit.launch({ args: [] }) : await chromium.launch();
    try {
      const { context, page } = await newSession(browser, url, { ...phone.device });
      const frame = page.frameLocator('iframe[sandbox]');
      await expect(frame.locator('h1')).toHaveText('Report index');
      const link = frame.getByRole('link', { name: 'the detail page' });
      await holdLink(page, link, phone.browserName);
      const composer = page.locator('[data-comment-popover]');
      await expect(composer).toBeVisible();
      await page.waitForTimeout(600);
      await expect(frame.locator('h1')).toHaveText('Report index');
      await page.keyboard.press('Escape').catch(() => {});
      await expect(composer).toHaveCount(0);
      await link.tap();
      await expect(frame.locator('h1')).toHaveText('Detail page');
      await context.close();
    } finally {
      await browser.close().catch(() => {});
      await close();
    }
  });
}
