/**
 * Live sites in the Inbox (packages/server/inbox-live.ts; NOT FOR RELEASE,
 * the pane is provisional until the Files design lands), proved in a real
 * browser against the compiled binary, with an agent writing through
 * `plannotator inbox mcp` (scripts/inbox-sim.ts) and a scratch dev app on a
 * free loopback port (two pages, a session cookie, X-Frame-Options DENY):
 *
 *  - the agent attaches the running app; the message shows a tile with the
 *    full URL, and nothing opens until the person clicks it;
 *  - the site opens beside the thread through the live proxy; a pin on `/`
 *    and, after following the app's own link, a pin on `/settings`;
 *  - a bridge message forged by the app's own script (with the token it can
 *    read) opens a draft at most: nothing is saved until the person saves;
 *  - Send: the agent's wait_for_reply gets the comments grouped by page with
 *    each element's context;
 *  - an HTML attachment frames nothing on another localhost port, and
 *    cannot navigate its own frame there either (`location.href`, a meta
 *    refresh, a `_self` link): the window's policy names no local port, and
 *    the live pane frames its proxy through a same-origin wrapper page; the
 *    live frame is sandboxed without top navigation;
 *  - on a phone-wide window the pane says "Open this on your computer".
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 * PNGs land in <PLANNOTATOR_E2E_PROOF_DIR or .local/proof>/live-sites/.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'live-sites');

/** The scratch dev app: a checkout and a settings page, linked to each other. */
function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px system-ui;margin:24px}nav a{margin-right:12px}button{font:inherit;padding:8px 14px;margin-top:12px}</style></head>
<body><nav><a href="/">Checkout</a><a href="/settings">Settings</a></nav><h1>${title}</h1>${body}</body></html>`;
}

function startApp(): Promise<Server> {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    const html =
      path === '/settings'
        ? page('Settings', '<p>Pro plan, renews on the 1st.</p><button id="cancel">Cancel plan</button>')
        : page('Checkout', '<p id="price">$240</p><button id="pay">Pay now</button>');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', 'Set-Cookie': 'session=scratch; HttpOnly; SameSite=Lax' });
    res.end(html);
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done(server)));
}

interface World {
  root: string;
  url: string;
  claude: SimAgent;
  context: BrowserContext;
  page: Page;
  errors: string[];
  project: string;
  app: Server;
  appUrl: string;
}

let world: World;

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(proofDir, `${name}.png`) });
}

async function pending(threadId: string): Promise<{ id: string; live?: { page_url: string | null } }[]> {
  const response = await fetch(new URL(`/api/inbox/threads/${threadId}/attachments`, world.url));
  return ((await response.json()) as { annotations: { id: string; live?: { page_url: string | null } }[] }).annotations;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-live-sites-e2e-');
  const dataDir = join(root, 'data');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_UPDATE_CHECK: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const app = await startApp();
  const appUrl = `http://localhost:${(app.address() as AddressInfo).port}/`;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const tab = await context.newPage();
  const errors: string[] = [];
  tab.on('pageerror', (error) => errors.push(error.message));
  const project = scratchProject(join(root, 'src'), 'shop');
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  world = { root, url, claude, context, page: tab, errors, project, app, appUrl };
});

test.afterAll(async () => {
  try {
    if (!world) return;
    await world.claude.close().catch(() => {});
    await world.context.close();
    await new Promise((done) => world.app.close(done));
  } finally {
    await removeInboxScratch();
  }
});

test('an agent attaches its running app; the person opens it, pins on two pages, and Send hands the agent the comments by page', async () => {
  const { page, claude, project, appUrl } = world;
  const sent = await claude.send({ project_path: project, subject: 'Checkout and settings', thread: 'checkout', body: 'The checkout and the settings page are done. Try them.', live_sites: [appUrl] });
  const threadId = sent.thread_id as string;
  const site = (sent.live_sites as { id: string; url: string }[])[0]!;
  expect(site.url).toBe(appUrl);

  await page.goto(`${world.url}#thread=${threadId}`);
  const tile = page.locator('[data-live-tile]');
  await expect(tile.locator('[data-live-tile-url]')).toHaveText(appUrl);
  // Nothing opens until the person clicks.
  await expect(page.locator('[data-live-pane]')).toHaveCount(0);
  await shot(page, '01-tile');

  await tile.click();
  const pane = page.locator('[data-live-pane]');
  await expect(pane).toBeVisible();
  await expect(pane.locator('[data-live-url-shown]')).toHaveText(appUrl);
  // The pane frames the Inbox's wrapper page, which frames the proxy.
  const frame = page.frameLocator('[data-live-pane] iframe').first().frameLocator('iframe');
  await expect(frame.locator('#price')).toHaveText('$240');
  await shot(page, '02-open');

  // A pin on the checkout page.
  const composer = page.locator('[data-comment-popover] textarea').last();
  await frame.locator('#price').click();
  await expect(composer).toBeVisible();
  await composer.fill('Say per month next to the price.');
  await composer.press('ControlOrMeta+Enter');
  await expect(page.locator('[data-comment-popover]')).toHaveCount(0);
  await expect(pane.locator('[data-live-count]')).toContainText('1 comment on 1 page');

  // The app's own link to Settings, then a pin there.
  await frame.getByRole('link', { name: 'Settings' }).click();
  await expect(frame.locator('#cancel')).toBeVisible();
  await expect(pane.locator('[data-live-route]')).toHaveText('/settings');
  await frame.locator('#cancel').click();
  await expect(composer).toBeVisible();
  await composer.fill('Ask before cancelling.');
  await composer.press('ControlOrMeta+Enter');
  await expect(page.locator('[data-comment-popover]')).toHaveCount(0);
  await expect(pane.locator('[data-live-count]')).toContainText('2 comments on 2 pages');
  await shot(page, '03-two-pages');
  expect((await pending(threadId)).map((r) => r.live?.page_url)).toEqual(['/', '/settings']);

  // The app's own script forges a bridge message with the token it can read: a draft at most, never saved.
  const handle = await page.locator('[data-live-pane] iframe').elementHandle();
  const inner = (await handle!.contentFrame())!.childFrames()[0]!;
  await inner.evaluate(() => {
    const config = (window as unknown as { __plannotatorLiveConfig: { token: string } }).__plannotatorLiveConfig;
    window.top!.postMessage(
      {
        type: 'plannotator-bridge-selection',
        text: 'Forged',
        rect: { top: 40, left: 40, width: 80, height: 24 },
        anchor: { selector: '#cancel', tagName: 'button', text: 'Cancel plan' },
        pinpoint: true,
        token: config.token,
      },
      '*',
    );
  });
  // The person sees the draft; it is theirs to save or drop.
  await expect(page.locator('[data-comment-popover]')).toBeVisible();
  await shot(page, '04-forged-draft-only');
  await page.waitForTimeout(400);
  expect(await pending(threadId)).toHaveLength(2);
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-comment-popover]')).toHaveCount(0);
  expect(await pending(threadId)).toHaveLength(2);

  // Send.
  await pane.locator('[data-live-reply]').click();
  await page.locator('.ib-rbox textarea').fill('Two things on the running app.');
  await page.locator('section.ib-pane').getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('.ib-rbox')).toHaveCount(0);
  const answer = await claude.waitForReply(threadId, 10);
  expect(answer.status).toBe('replied');
  const body = (answer.reply as { body: string }).body;
  for (const part of [
    'Two things on the running app.',
    '# Feedback on your running app',
    `## ${appUrl} (live site)`,
    "I've reviewed this site and have 2 pieces of feedback:",
    '### Page: /\n',
    '### Page: /settings',
    '#price',
    '#cancel',
    '> Say per month next to the price.',
    '> Ask before cancelling.',
  ]) {
    expect(body, part).toContain(part);
  }
  expect(body).not.toContain('Forged');
  expect(body.indexOf('Ask before cancelling.')).toBeGreaterThan(body.indexOf('### Page: /settings'));
  expect(await pending(threadId)).toEqual([]);
  expect(world.errors).toEqual([]);
});

test("an HTML attachment can frame nothing on another localhost port, in the viewer or as an Artifacts tile; the live frame is sandboxed without top navigation", async () => {
  const { page, claude, project } = world;
  // Another local service, and a page that frames it (statically and by script), as an agent could attach.
  const hits: string[] = [];
  const victim = createServer((req, res) => {
    hits.push(req.url ?? '');
    res.end('<p>victim</p>');
  });
  await new Promise<void>((done) => victim.listen(0, '127.0.0.1', done));
  const port = (victim.address() as AddressInfo).port;
  try {
    writeFileSync(
      join(project, 'report.html'),
      `<!doctype html><html><head><script>const f=document.createElement('iframe');f.src='http://localhost:${port}/script-frame';document.documentElement.appendChild(f);</script></head><body><h1>Report</h1><iframe src="http://localhost:${port}/static-frame"></iframe><script>const g=document.createElement('iframe');g.src='http://127.0.0.1:${port}/body-frame';document.body.appendChild(g);</script></body></html>`,
    );
    const sent = await claude.send({ project_path: project, subject: 'A report', thread: 'report', body: 'The report is attached.', attachments: ['report.html'] });
    await page.goto(`${world.url}#thread=${sent.thread_id}`);
    await page.getByRole('button', { name: 'Open report.html' }).click();
    await expect(page.frameLocator('[data-attachment-pane] iframe').first().getByRole('heading', { name: 'Report' })).toBeVisible();
    await page.waitForTimeout(1000);
    await page.goto(`${world.url}#thread=${sent.thread_id}&artifacts`);
    await expect(page.locator('.ib-art-frame iframe').first()).toBeAttached();
    await page.waitForTimeout(1000);
    expect(hits).toEqual([]);
  } finally {
    await new Promise((done) => victim.close(done));
  }

  // The live frame (the first test's site) is sandboxed, and the app still works in it.
  const live = await claude.send({ project_path: project, subject: 'Checkout again', thread: 'checkout-sandbox', body: 'Once more.', live_sites: [world.appUrl] });
  await page.goto(`${world.url}#thread=${live.thread_id}`);
  await page.locator('[data-live-tile]').click();
  const frame = page.locator('[data-live-pane] iframe');
  const sandbox = (await frame.getAttribute('sandbox')) ?? '';
  expect(sandbox.split(' ')).toEqual(expect.arrayContaining(['allow-scripts', 'allow-same-origin', 'allow-forms']));
  expect(sandbox).not.toContain('allow-top-navigation');
  await expect(page.frameLocator('[data-live-pane] iframe').first().frameLocator('iframe').locator('#price')).toHaveText('$240');
  // "Open in browser" is the site's own address.
  await expect(page.locator('[data-live-pane] a[aria-label="Open in browser"]')).toHaveAttribute('href', world.appUrl);
  expect(world.errors).toEqual([]);
});

test('an HTML attachment cannot navigate its own frame to another localhost port: location.href, a meta refresh, a _self link', async () => {
  const { page, claude, project } = world;
  // The window's policy decides where an attachment's frame may navigate itself; the attachment's own meta policy does not.
  const hits: string[] = [];
  const victim = createServer((req, res) => {
    hits.push(req.url ?? '');
    res.end('<p>victim</p>');
  });
  await new Promise<void>((done) => victim.listen(0, '127.0.0.1', done));
  const port = (victim.address() as AddressInfo).port;
  const pages: Record<string, string> = {
    'nav-location.html': `<!doctype html><html><body><h1>Location</h1><script>setTimeout(() => { location.href = 'http://localhost:${port}/self-location'; }, 50);</script></body></html>`,
    'nav-meta.html': `<!doctype html><html><head><meta http-equiv="refresh" content="0;url=http://localhost:${port}/self-meta-refresh"></head><body><h1>Meta</h1></body></html>`,
    // The page's head script runs before the bridge's, so its window listener keeps the click from the bridge's link handler.
    'nav-link.html': `<!doctype html><html><head><script>window.addEventListener('click', (e) => e.stopImmediatePropagation(), true);</script></head><body><h1>Link</h1><a id="go" href="http://localhost:${port}/self-link" target="_self">go</a><script>setTimeout(() => document.getElementById('go').click(), 50);</script></body></html>`,
  };
  try {
    for (const [name, html] of Object.entries(pages)) writeFileSync(join(project, name), html);
    const sent = await claude.send({ project_path: project, subject: 'Navigating reports', thread: 'nav-reports', body: 'Three pages.', attachments: Object.keys(pages) });
    for (const name of Object.keys(pages)) {
      await page.goto(`${world.url}#thread=${sent.thread_id}`);
      await page.getByRole('button', { name: `Open ${name}` }).click();
      await expect(page.locator('[data-attachment-pane] iframe').first()).toBeAttached();
      await page.waitForTimeout(1500);
    }
    expect(hits).toEqual([]);
  } finally {
    await new Promise((done) => victim.close(done));
  }
});

test('on a phone-wide window the site does not open: "Open this on your computer"', async ({ browser }: { browser: Browser }) => {
  const { claude, project, appUrl } = world;
  const sent = await claude.send({ project_path: project, subject: 'Checkout on a phone', thread: 'checkout-phone', body: 'Try the checkout.', live_sites: [appUrl] });
  const site = (sent.live_sites as { id: string }[])[0]!;
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  try {
    const phone = await context.newPage();
    await phone.goto(`${world.url}#thread=${sent.thread_id}&live=${site.id}`);
    const away = phone.locator('[data-live-away]');
    await expect(away).toContainText('Open this on your computer');
    await expect(phone.locator('[data-live-pane]')).toContainText(appUrl);
    await expect(phone.locator('[data-live-pane] iframe')).toHaveCount(0);
    await phone.screenshot({ path: join(proofDir, '05-phone.png') });
  } finally {
    await context.close();
  }
});
