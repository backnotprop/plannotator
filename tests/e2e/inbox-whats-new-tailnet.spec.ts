/**
 * What's new on a phone-width page that came through the tailnet, in a real
 * browser against the CLI from source, run as a release-numbered Inbox (bun
 * --define __CLI_VERSION__, the way inbox-update-notice.spec.ts does: the
 * shared 0.0.0-dev binary has no "just updated" notice to link to), under a
 * temp PLANNOTATOR_DATA_DIR and
 * HOME. `tailscale` is a script on PATH that keeps its serve config in a file
 * (the real CLI never runs); the browser reaches the Inbox's tailnet-only
 * listener through a small proxy in this spec that adds what `tailscale serve`
 * adds (the MagicDNS Host and the owner's `Tailscale-User-Login`).
 *
 * Proved at 390 by 844 with touch: the page is `via: tailnet`; the sidebar's
 * quiet "What's new in X" link and Settings → About (the computer's block,
 * with a link to the running release) open the notes; the notes scroll, show
 * their saved image, fit the width, and close back to the Inbox. No newer
 * release is known here, so nothing offers an update.
 *
 * Needs the built apps (apps/hook/dist), as the other specs do; then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-whats-new-tailnet.spec.ts`.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { deflateSync, crc32 } from 'node:zlib';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const entry = join(repo, 'apps/hook/server/index.ts');
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'whats-new-tailnet');

const MAGIC = 'studio.tail0000.ts.net';
const OWNER = 'owner@example.com';
/** The Inbox's version (--define __CLI_VERSION__ below): a release build, so What's new names it. */
const VERSION = '0.28.10';
let inbox: ChildProcess | undefined;
const IMAGE_SRC = 'https://github.com/user-attachments/assets/11111111-2222-3333-4444-555555555555';

const FAKE = `
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const [state] = process.argv.slice(2, 3);
const args = process.argv.slice(3);
const out = (text) => { process.stdout.write(text); process.exit(0); };
const serve = existsSync(state) ? JSON.parse(readFileSync(state, "utf8")) : {};
if (args[0] === "status") out(JSON.stringify({ Self: { DNSName: "${MAGIC}.", UserID: 1 }, User: { "1": { LoginName: "${OWNER}" } } }));
if (args[0] === "serve" && args[1] === "status") {
  const ports = Object.keys(serve);
  if (ports.length === 0) out("{}");
  out(JSON.stringify({ TCP: Object.fromEntries(ports.map((p) => [p, { HTTPS: true }])), Web: Object.fromEntries(ports.map((p) => ["${MAGIC}:" + p, { Handlers: { "/": { Proxy: serve[p] } } }])) }));
}
const port = (/--https=(\\d+)/.exec(args.join(" ")) || [])[1];
if (args[0] === "serve" && port && args.includes("off")) { delete serve[port]; writeFileSync(state, JSON.stringify(serve)); out(""); }
if (args[0] === "serve" && port && args.includes("--bg")) { serve[port] = args[args.length - 1]; writeFileSync(state, JSON.stringify(serve)); out("https://${MAGIC}:" + port + "/\\n"); }
process.exit(2);
`;

/** A solid-colour PNG, wide enough to need the phone's width. */
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(body));
    return Buffer.concat([head, body, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x6b)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

interface World {
  root: string;
  dataDir: string;
  context: BrowserContext;
  page: Page;
  proxy: Server;
  url: string;
  errors: string[];
}

let world: World;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(join(repo, 'apps/hook/dist/inbox.html')), 'build the apps first: apps/hook/dist').toBe(true);
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-whatsnew-tailnet-e2e-');
  const dataDir = join(root, 'data');
  const bin = join(root, 'bin');
  mkdirSync(bin);
  mkdirSync(join(dataDir, 'update-notes', VERSION), { recursive: true });
  writeFileSync(join(root, 'fake-tailscale.cjs'), FAKE);
  writeFileSync(join(bin, 'tailscale'), `#!/bin/sh\nexec '${process.execPath}' '${join(root, 'fake-tailscale.cjs')}' '${join(root, 'serve.json')}' "$@"\n`);
  chmodSync(join(bin, 'tailscale'), 0o755);

  // This run is "just updated" from the version before it, with its notes and one image already saved (no network).
  const [major, minor, patch] = VERSION.split('.').map(Number);
  writeFileSync(join(dataDir, 'update-state.json'), JSON.stringify({ inboxVersion: `${major}.${minor}.${patch! - 1}` }));
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ inboxTailscale: true }));
  const filler = Array.from({ length: 40 }, (_, n) => `- Item ${n + 1} of the long list of things that changed in this release, long enough to wrap on a phone.`).join('\n');
  writeFileSync(
    join(dataDir, 'update-notes', `${VERSION}.json`),
    JSON.stringify({ version: VERSION, notes: `Opening line of ${VERSION}.\n\n![A wide screenshot](${IMAGE_SRC})\n\n${filler}\n\nThe last line.`, highlights: [] }) + '\n',
  );
  const bytes = png(900, 300);
  const sha = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(join(dataDir, 'update-notes', VERSION, `${sha}.png`), bytes);
  writeFileSync(join(dataDir, 'update-notes', VERSION, 'images.json'), JSON.stringify({ images: { [IMAGE_SRC]: { file: `${sha}.png`, content_type: 'image/png', bytes: bytes.length, width: 900, height: 300 } } }) + '\n');

  const bun = realpathSync(process.env.BUN_BINARY ?? execSync('command -v bun').toString().trim());
  const env = {
    // The fake tailscale first; no system directory, so no real tailscale is ever reachable.
    PATH: `${bin}:${dirname(bun)}:${dirname(process.execPath)}`,
    PLANNOTATOR_TEST_SANDBOX: root,
    HOME: root,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_BROWSER,
    PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
  };
  inbox = spawn(bun, ['--define', `__CLI_VERSION__="${VERSION}"`, entry, 'inbox', '--no-open'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  inbox.stderr!.on('data', (c) => (err += c));
  const deadline = Date.now() + 60_000;
  while (!/Plannotator Inbox: (\S+)/.test(err) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  expect(err, 'the Inbox did not start').toMatch(/Plannotator Inbox: (\S+)/);
  rememberInboxOf(dataDir);
  // The tailnet mapping is recorded once the listener is up.
  const registryFile = join(dataDir, 'inbox', 'inbox.json');
  while (Date.now() < deadline && !(existsSync(registryFile) && JSON.parse(readFileSync(registryFile, 'utf8')).tailscale?.proxy_port)) await new Promise((r) => setTimeout(r, 100));
  const registry = JSON.parse(readFileSync(registryFile, 'utf8'));
  const listener: number = registry.tailscale.proxy_port;
  const httpsPort: number = registry.tailscale.https_port;
  // What `tailscale serve` hands the listener: the MagicDNS Host with the HTTPS port and the peer's login.
  const proxy = createServer((req, res) => {
    const headers = { ...req.headers, host: `${MAGIC}:${httpsPort}`, 'tailscale-user-login': OWNER };
    if (headers.origin) headers.origin = `https://${MAGIC}:${httpsPort}`;
    const upstream = request({ host: '127.0.0.1', port: listener, path: req.url, method: req.method, headers }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    });
    upstream.on('error', () => res.destroy());
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });
  await new Promise<void>((done) => proxy.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(proxy.address() as { port: number }).port}/`;

  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  world = { root, dataDir, context, page, proxy, url, errors };
});

test.afterAll(async () => {
  try {
    await world?.context.close();
    world?.proxy.close();
  } finally {
    await removeInboxScratch();
  }
});

const noUpdateOffered = async (page: Page) => {
  await expect(page.locator('.ib-upd, [data-about-update], [data-general-update], [data-whats-new-update]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^update/i })).toHaveCount(0);
};

test('the sidebar link opens What\'s new on a phone through the tailnet: it scrolls, shows the image, fits, and closes', async () => {
  const { page } = world;
  await page.goto(world.url);
  const settings = await page.evaluate(async () => (await fetch('/api/inbox/settings')).json());
  expect(settings.via).toBe('tailnet');
  expect(settings.guest).toBe(false);

  // The phone's sidebar is a drawer behind the toggle.
  await page.locator('[data-sidebar="trigger"]').first().click();
  const link = page.locator(`[data-whats-new-link="${VERSION}"]`);
  await expect(link).toBeVisible();
  await noUpdateOffered(page);
  await link.click();

  const wn = page.locator('.ib-wn');
  await expect(wn).toBeVisible();
  await expect(wn).toContainText(`Opening line of ${VERSION}.`);
  await expect(page.locator('.ib-error')).toHaveCount(0);
  await noUpdateOffered(page);

  // The saved image loads through the tailnet path.
  const image = wn.locator('img').first();
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(900);
  expect(await image.evaluate((img: HTMLImageElement) => img.currentSrc)).toContain('/api/inbox/whats-new/image');
  // Fits the phone: nothing is wider than the screen.
  const overflow = await page.evaluate(() => ({ page: document.documentElement.scrollWidth - window.innerWidth, wn: (document.querySelector('.ib-wn') as HTMLElement).scrollWidth - (document.querySelector('.ib-wn') as HTMLElement).clientWidth }));
  expect(overflow.page).toBeLessThanOrEqual(0);
  expect(overflow.wn).toBeLessThanOrEqual(0);
  const box = await image.boundingBox();
  expect(box!.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: join(proofDir, 'whats-new-phone-top.png') });

  // It scrolls.
  await wn.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await expect.poll(() => wn.evaluate((el) => el.scrollTop)).toBeGreaterThan(200);
  await expect(wn).toContainText('The last line.');
  await page.screenshot({ path: join(proofDir, 'whats-new-phone-bottom.png') });

  // It closes.
  await page.locator('[data-whats-new-back]').click();
  await expect(page.locator('.ib-wn')).toHaveCount(0);
  expect(world.errors).toEqual([]);
});

test('Settings → About over the tailnet: the computer\'s block and the link to this release; the link opens the notes', async () => {
  const { page } = world;
  await page.goto(`${world.url}#settings/about`);
  const about = page.locator('[data-settings-about]');
  await expect(about).toBeVisible();
  await expect(about).toHaveAttribute('data-settings-about', '');
  await expect(about).toContainText(`Plannotator ${VERSION}`);
  await noUpdateOffered(page);
  await page.screenshot({ path: join(proofDir, 'about-phone.png') });
  await page.locator(`[data-about-whats-new="${VERSION}"]`).click();
  await expect(page.locator('.ib-wn')).toContainText(`Opening line of ${VERSION}.`);
  await expect(page.locator('.ib-wn img').first()).toBeVisible();
  await page.locator('[data-whats-new-back]').click();
  await expect(page.locator('.ib-wn')).toHaveCount(0);
  expect(world.errors).toEqual([]);
});
