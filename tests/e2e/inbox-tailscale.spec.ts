/**
 * "Over your tailnet" in the Inbox window's Settings, proved in a real
 * browser against the compiled binary under a temp PLANNOTATOR_DATA_DIR and
 * HOME, with `tailscale` a script on PATH that keeps its serve config in a
 * file (CI has no tailnet, and the real CLI must never run here).
 *
 * Proved: the switch publishes at once (the row shows the tailnet address,
 * config.json and the fake serve config agree, the mapping is the Inbox's
 * own port pointed at another loopback port), off takes it down; with
 * Tailscale stopped the switch stays on and the error says why; an Inbox
 * started with `--tailscale` says "On for this run" and "Keep it on at
 * every start" saves the switch; a hand-made mapping onto the window's own
 * port is refused, named in Settings, and replaced on request.
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 * PNGs, light and dark at 1440 by 900, land in .local/proof/tailscale/.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'tailscale');

const MAGIC = 'studio.tail0000.ts.net';
const OWNER = 'owner@example.com';

/** The fake CLI (run by this Node): `status --json`, `serve status --json`, serve on and off; `down` in the mode file fails every call. */
const FAKE = `
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const [state, mode] = process.argv.slice(2, 4);
const args = process.argv.slice(4);
const out = (text) => { process.stdout.write(text); process.exit(0); };
if (existsSync(mode) && readFileSync(mode, "utf8").trim() === "down") { process.stderr.write("Tailscale is stopped.\\n"); process.exit(1); }
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

interface World {
  root: string;
  dataDir: string;
  bin: string;
  url: string;
  context: BrowserContext;
  page: Page;
  errors: string[];
}

let world: World;

const serveConfig = (): Record<string, string> => {
  const file = join(world.root, 'serve.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
};
const registry = () => JSON.parse(readFileSync(join(world.dataDir, 'inbox', 'inbox.json'), 'utf8'));
const config = () => {
  const file = join(world.dataDir, 'config.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
};

async function shot(name: string): Promise<void> {
  const page = world.page;
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(300);
    await page.locator('[data-settings-tailscale]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(proofDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

function startInbox(args: string[]): string {
  // PATH: the fake first, then this Node; no system directory, so no real tailscale is ever reachable.
  const env = { PATH: `${world.bin}:${dirname(process.execPath)}`, HOME: world.root, PLANNOTATOR_DATA_DIR: world.dataDir, PLANNOTATOR_BROWSER: 'none', PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9' };
  const started = spawnSync(binary, ['inbox', '--background', ...args], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  return started.stdout.trim();
}

function stopInbox(): void {
  try {
    process.kill(registry().pid, 'SIGTERM');
  } catch {
    // Already gone.
  }
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-tailscale-e2e-')));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(root, 'fake-tailscale.cjs'), FAKE);
  writeFileSync(join(bin, 'tailscale'), `#!/bin/sh\nexec '${process.execPath}' '${join(root, 'fake-tailscale.cjs')}' '${join(root, 'serve.json')}' '${join(root, 'mode')}' "$@"\n`);
  chmodSync(join(bin, 'tailscale'), 0o755);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  world = { root, dataDir: join(root, 'data'), bin, url: '', context, page, errors };
  world.url = startInbox([]);
});

test.afterAll(async () => {
  if (!world) return;
  await world.context.close();
  const { pid } = registry();
  stopInbox();
  await expect.poll(() => { try { process.kill(pid, 0); return 'alive'; } catch { return 'gone'; } }).toBe('gone');
  rmSync(world.root, { recursive: true, force: true });
});

test('the switch publishes at once and shows the tailnet address; off takes it down', async () => {
  const { page } = world;
  await page.goto(`${world.url}#settings`);
  const block = page.locator('[data-settings-tailscale]');
  await expect(block.getByRole('heading', { name: 'Over your tailnet' })).toBeVisible();
  const toggle = block.getByRole('switch', { name: 'Reach the Inbox over Tailscale' });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(block).toHaveAttribute('data-settings-tailscale', 'off');
  await shot('settings-tailscale-off');

  await toggle.click();
  const { port } = registry();
  const address = `https://${MAGIC}:${port}/`;
  await expect(block.locator('[data-tailscale-url]')).toHaveAttribute('data-tailscale-url', address);
  await expect(block.getByRole('link', { name: address })).toBeVisible();
  await expect(block).toContainText(OWNER);
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => config().inboxTailscale).toBe(true);
  const target = serveConfig()[String(port)];
  expect(target).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect(target).not.toBe(`http://127.0.0.1:${port}`);
  expect(registry().tailscale.url).toBe(address);
  await shot('settings-tailscale-on');

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(block.locator('[data-tailscale-url]')).toHaveAttribute('data-tailscale-url', '');
  await expect.poll(() => serveConfig()).toEqual({});
  await expect.poll(() => config().inboxTailscale).toBe(false);
  expect(world.errors).toEqual([]);
});

test('Tailscale stopped: the switch stays on and the error says why, and one click turns it off', async () => {
  const { page } = world;
  writeFileSync(join(world.root, 'mode'), 'down');
  await page.goto(`${world.url}#settings`);
  const block = page.locator('[data-settings-tailscale]');
  const toggle = block.getByRole('switch', { name: 'Reach the Inbox over Tailscale' });
  await toggle.click();
  await expect(block.locator('[data-tailscale-error]')).toContainText('Tailscale could not publish the Inbox');
  await expect(block.locator('[data-tailscale-error]')).toContainText('Tailscale is stopped.');
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await shot('settings-tailscale-unavailable');
  writeFileSync(join(world.root, 'mode'), 'up');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(block.locator('[data-tailscale-error]')).toHaveCount(0);
});

test('started with --tailscale: on for this run, and "Keep it on at every start" saves the switch', async () => {
  stopInbox();
  await expect.poll(() => fetch(`${world.url}api/inbox/health`).then(() => 'up', () => 'down')).toBe('down');
  world.url = startInbox(['--tailscale']);
  const { page } = world;
  // The same port and hash as before: a fresh document, not a same-document hop.
  await page.goto('about:blank');
  await page.goto(`${world.url}#settings`);
  const block = page.locator('[data-settings-tailscale]');
  await expect(block).toContainText('On for this run (plannotator inbox --tailscale).');
  await expect(block.getByRole('switch', { name: 'Reach the Inbox over Tailscale' })).toHaveAttribute('aria-checked', 'true');
  expect(config().inboxTailscale).toBe(false);
  await shot('settings-tailscale-this-run');
  await block.getByRole('button', { name: 'Keep it on at every start' }).click();
  await expect(block).toContainText('Applies now and at every start.');
  await expect.poll(() => config().inboxTailscale).toBe(true);
  expect(Object.keys(serveConfig())).toEqual([String(registry().port)]);
  expect(world.errors).toEqual([]);
});

test("a hand-made mapping onto the window's own port: Settings says it exposes the whole Inbox, and Replace publishes the owner-only address", async () => {
  const { page } = world;
  const { port } = registry();
  await page.goto('about:blank');
  await page.goto(`${world.url}#settings`);
  const block = page.locator('[data-settings-tailscale]');
  const toggle = block.getByRole('switch', { name: 'Reach the Inbox over Tailscale' });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  // The user's workaround, then a request through it as serve sends it.
  writeFileSync(join(world.root, 'serve.json'), JSON.stringify({ [String(port)]: `http://127.0.0.1:${port}` }));
  const through = await fetch(`http://127.0.0.1:${port}/api/inbox/threads`, { headers: { 'X-Forwarded-For': '100.64.0.9', 'Tailscale-User-Login': 'someone@example.com' } });
  expect(through.status).toBe(403);
  await page.goto('about:blank');
  await page.goto(`${world.url}#settings`);
  await expect(block.locator('[data-tailscale-exposed]')).toContainText('exposes the whole Inbox');
  await shot('settings-tailscale-exposed');
  await block.getByRole('button', { name: 'Replace it with the owner-only address' }).click();
  await expect(block.locator('[data-tailscale-url]')).toHaveAttribute('data-tailscale-url', `https://${MAGIC}:${port}/`);
  await expect(block.locator('[data-tailscale-exposed]')).toHaveCount(0);
  const target = serveConfig()[String(port)];
  expect(target).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect(target).not.toBe(`http://127.0.0.1:${port}`);
  expect(world.errors).toEqual([]);
});
