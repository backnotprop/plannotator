/**
 * The owner's phone over the tailnet, in a real Chromium at phone widths
 * (approval "inbox-tailnet-owner"): every section the approval opened is drawn,
 * fits 390 and 320 px, and writes through the real tailnet listener; a guest's
 * phone is offered none of it.
 *
 * A release-version Inbox from source (as inbox-updates.spec.ts) under a temp
 * HOME and data dir, `tailscale` a script on PATH that keeps its serve config in
 * a file, and a small loopback proxy standing in for `tailscale serve`: it
 * sends what serve sends (the served Host, `Tailscale-User-Login`,
 * `X-Forwarded-Proto: https`) to the port the mapping names, and the page's
 * Origin as the tailnet address, so the page gets `via: "tailnet"` from the
 * real gate. The real `tailscale`, agents and install script never run.
 *
 * PNGs land in PLANNOTATOR_TAILNET_OWNER_SHOTS, else .local/proof/tailnet-owner/.
 * Needs the built apps (apps/hook/dist), as the other specs do.
 */

import { expect, test, type Browser, type Page } from '@playwright/test';
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const entry = join(repo, 'apps/hook/server/index.ts');
const shots = resolve(process.env.PLANNOTATOR_TAILNET_OWNER_SHOTS ?? join(repo, '.local/proof/tailnet-owner'));

const MAGIC = 'studio.tail0000.ts.net';
const OWNER = 'owner@example.com';
const GUEST = 'guest@example.com';
const KEY = 'sk-phone-e2e-0123456789abcd';
const NEXT = '0.28.12';

/** The fake CLI: `status --json`, `serve status --json`, serve on and off. */
const FAKE = `
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const state = process.argv[2];
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

let root = '';
let dataDir = '';
let inbox: ChildProcess;
let inboxErr = '';
let inboxPort = 0;
let url = '';
const proxies: Server[] = [];

const config = () => JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) as Record<string, unknown>;
const mapping = (): string => (JSON.parse(readFileSync(join(root, 'serve.json'), 'utf8')) as Record<string, string>)[String(inboxPort)]!;

/** What `tailscale serve` does for one login: this stand-in is the only thing that sets these headers. */
async function serveFor(login: string): Promise<string> {
  const server = createServer((req, res) => {
    const target = new URL(mapping());
    const headers = { ...req.headers, host: `${MAGIC}:${inboxPort}`, 'tailscale-user-login': login, 'x-forwarded-proto': 'https' };
    if (headers.origin) headers.origin = `https://${MAGIC}:${inboxPort}`;
    const up = request({ host: target.hostname, port: target.port, method: req.method, path: req.url, headers }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    });
    up.on('error', () => res.destroy());
    res.on('close', () => up.destroy());
    req.pipe(up);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  proxies.push(server);
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(existsSync(join(repo, 'apps/hook/dist/inbox.html')), 'build the apps first (bun run build:hook)').toBe(true);
  mkdirSync(shots, { recursive: true });
  root = inboxScratch('plannotator-inbox-tailnet-owner-e2e-');
  dataDir = join(root, 'data');
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(bin);
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  writeFileSync(join(root, 'fake-tailscale.cjs'), FAKE);
  writeFileSync(join(bin, 'tailscale'), `#!/bin/sh\nexec '${process.execPath}' '${join(root, 'fake-tailscale.cjs')}' '${join(root, 'serve.json')}' "$@"\n`);
  chmodSync(join(bin, 'tailscale'), 0o755);
  // Agents for Settings → Agents to find: scripts that answer nothing, so Voice's check of Codex fails at once.
  for (const agent of ['codex', 'claude', 'gemini']) {
    writeFileSync(join(bin, agent), '#!/bin/sh\nexit 1\n');
    chmodSync(join(bin, agent), 0o755);
  }
  // Bun counts as the binary the install script manages, so About and the dialog offer Update now.
  const bun = realpathSync(process.env.BUN_BINARY ?? execSync('command -v bun').toString().trim());
  symlinkSync(bun, join(home, '.local', 'bin', 'plannotator'));
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ inboxTailscale: true, inboxTailscaleAllow: [GUEST] }));
  writeFileSync(join(dataDir, 'update-state.json'), JSON.stringify({ latestRelease: { tag: NEXT, fetchedAt: Date.now(), publishedAt: '2026-10-09T15:00:00Z' } }));
  mkdirSync(join(dataDir, 'update-notes'));
  writeFileSync(join(dataDir, 'update-notes', `${NEXT}.json`), JSON.stringify({ version: NEXT, notes: 'A patch release for the Inbox.\n\n### Update notices\n\nOne click.', highlights: [] }));
  inbox = spawn(bun, ['--define', '__CLI_VERSION__="0.28.10"', entry, 'inbox', '--no-open'], {
    env: {
      // A PATH of its own: no real tailscale or agent can answer.
      PATH: bin,
      HOME: home,
      TMPDIR: tmpdir(),
      PLANNOTATOR_DATA_DIR: dataDir,
      PLANNOTATOR_BROWSER: NO_BROWSER,
      PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
      PLANNOTATOR_INBOX_PHONES: '0',
      PLANNOTATOR_INBOX_CONNECT: '0',
      PLANNOTATOR_UPDATE_API_URL: 'http://127.0.0.1:9/releases/latest',
      PLANNOTATOR_FEEDBACK_URL: 'http://127.0.0.1:9/feedback',
      PLANNOTATOR_INSTALL_SCRIPT_URL: 'http://127.0.0.1:9/install.sh',
      PLANNOTATOR_RELEASE_DOWNLOAD_URL: 'http://127.0.0.1:9/download',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  inbox.stderr!.on('data', (c) => (inboxErr += c));
  inbox.stdout!.on('data', (c) => (inboxErr += c));
  const deadline = Date.now() + 60_000;
  while (!/Plannotator Inbox: (\S+)/.test(inboxErr) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  url = /Plannotator Inbox: (\S+)/.exec(inboxErr)?.[1] ?? '';
  expect(url, inboxErr).not.toBe('');
  inboxPort = Number(new URL(url).port);
  while (!existsSync(join(root, 'serve.json')) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  expect(mapping(), 'published').toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  // One thread, so the list and not the first-run screen is what shows.
  const project = join(root, 'project');
  mkdirSync(project, { recursive: true });
  const sent = await fetch(new URL('/mcp', url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'send_message', arguments: { body: 'The migration is done; the report is in the PR.', subject: 'Migration finished', project_path: project, agent_session: 'ses_phone', agent_host: 'claude-code' } },
    }),
  });
  expect(sent.status).toBe(200);
});

test.afterAll(async () => {
  try {
    for (const proxy of proxies) proxy.closeAllConnections();
    for (const proxy of proxies) proxy.close();
    inbox?.kill('SIGTERM');
  } finally {
    await removeInboxScratch();
  }
});

/** Nothing of this page runs past the phone's edge, unless it sits in something that scrolls or clips on purpose. */
async function fits(page: Page, what: string, scope: string): Promise<void> {
  const past = await page.evaluate((selector) => {
    const width = document.documentElement.clientWidth;
    const out: string[] = [];
    if (document.documentElement.scrollWidth > width) out.push(`the page: ${document.documentElement.scrollWidth} in ${width}`);
    const held = (el: Element) => {
      for (let up = el.parentElement; up && up !== document.body; up = up.parentElement) {
        const overflow = getComputedStyle(up).overflowX;
        if (overflow === 'auto' || overflow === 'scroll' || overflow === 'hidden') return true;
      }
      return false;
    };
    for (const part of document.querySelectorAll(`${selector} button, ${selector} input, ${selector} label, ${selector} a, ${selector} h1, ${selector} h2, ${selector} code`)) {
      const box = part.getBoundingClientRect();
      if (box.width === 0 || held(part)) continue;
      if (box.right > width + 0.5 || box.left < -0.5) out.push(`${part.tagName} "${(part.textContent ?? '').slice(0, 40)}": ${Math.round(box.left)} to ${Math.round(box.right)} in ${width}`);
    }
    return out;
  }, scope);
  expect(past, what).toEqual([]);
}

async function phone(browser: Browser, width: number) {
  const context = await browser.newContext({ viewport: { width, height: 700 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, colorScheme: 'light', reducedMotion: 'reduce' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return { context, page, errors };
}

const go = async (page: Page, base: string, hash: string) => {
  await page.goto(`${base}/${hash}`);
};

const picture = (page: Page, name: string, width: number) => page.screenshot({ path: join(shots, `${name}-${width}.png`), fullPage: true });

for (const width of [390, 320]) {
  test(`the owner at ${width} px: every section the approval opened is there, fits, and saves`, async ({ browser }) => {
    const base = await serveFor(OWNER);
    const { context, page, errors } = await phone(browser, width);
    await go(page, base, '#settings/agents');
    const seen = await page.evaluate(() => fetch('/api/inbox/settings').then((r) => r.json()));
    expect([seen.via, seen.guest]).toEqual(['tailnet', false]);

    await expect(page.locator('[data-agent]').first()).toBeVisible();
    await fits(page, 'Settings → Agents', '[data-settings-section]');
    await picture(page, 'settings-agents', width);

    await go(page, base, '#settings/about');
    const about = page.locator('[data-settings-about]');
    await expect(about.getByRole('button', { name: 'Update now' })).toBeVisible();
    await fits(page, 'About', '[data-settings-section]');
    await picture(page, 'about-update-available', width);

    await about.getByRole('button', { name: 'Update now' }).tap();
    await expect(page.locator('[data-update-now]')).toBeVisible();
    await fits(page, 'the update dialog', '[role="dialog"]');
    await picture(page, 'update-dialog', width);
    await page.getByRole('button', { name: 'Cancel' }).tap();

    await go(page, base, '#settings/general');
    await expect(page.locator('[data-general-update]')).toBeVisible();
    await expect(page.locator('[data-settings-cookie-host] h2')).toHaveText('The computer’s browser');
    await fits(page, 'General', '[data-settings-section]');
    await picture(page, 'general', width);

    await go(page, base, '#settings/prompts');
    await page.getByRole('button', { name: 'Edit' }).first().tap();
    await expect(page.getByRole('button', { name: 'Save' })).toBeVisible();
    await fits(page, 'Prompts, editing', '[data-settings-section]');
    await picture(page, 'prompts-edit', width);

    await go(page, base, '#settings/voice');
    const voice = page.locator('[data-settings-voice]');
    await expect(voice).toBeVisible();
    const on = voice.getByRole('switch', { name: 'Voice' });
    if ((await on.getAttribute('aria-checked')) !== 'true') await on.tap();
    await page.getByText('OpenAI API key').tap();
    const key = page.locator('[data-voice-key]');
    await expect(key).toBeVisible();
    await fits(page, 'the voice key', '[data-settings-section]');
    await picture(page, 'voice-key', width);
    if ((await key.getAttribute('data-voice-key')) === 'empty') {
      await page.locator('#ib-vkey').fill(KEY);
      await key.getByRole('button', { name: 'Save' }).tap();
      await expect(page.locator('[data-voice-key="saved"]')).toContainText('abcd');
      await fits(page, 'the saved key', '[data-settings-section]');
    }
    expect(context.pages()).toHaveLength(1);
    expect(errors).toEqual([]);
    await context.close();
  });
}

test('the Board at 390 and 320 px: the off page turns it on from the phone, and Capabilities turns it off', async ({ browser }) => {
  const base = await serveFor(OWNER);
  for (const width of [390, 320]) {
    const { context, page, errors } = await phone(browser, width);
    await go(page, base, '#board');
    await expect(page.locator('[data-board-view="off"]')).toBeVisible();
    await fits(page, 'the Board off', '[data-board-view]');
    await picture(page, 'board-off', width);
    await page.locator('[data-board-turn-on]').tap();
    await expect.poll(() => config().inboxBoard).toBe(true);
    await go(page, base, '#settings/capabilities');
    const board = page.locator('[data-settings-board]');
    await expect(board.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    await fits(page, 'Capabilities', '[data-settings-section]');
    await picture(page, 'board-settings', width);
    await board.getByRole('switch').tap();
    await expect.poll(() => config().inboxBoard).toBe(false);
    expect(errors).toEqual([]);
    await context.close();
  }
});

test('the key typed on the phone reached the file and no log', async () => {
  expect(readFileSync(join(dataDir, 'inbox', 'voice-key'), 'utf8').trim()).toBe(KEY);
  expect(inboxErr).not.toContain(KEY);
});

test('a guest’s phone: none of it is offered, and its window works', async ({ browser }) => {
  const base = await serveFor(GUEST);
  const { context, page, errors } = await phone(browser, 390);
  await go(page, base, '#settings/about');
  await expect(page.locator('[data-settings-section="about"]')).toBeVisible();
  const seen = await page.evaluate(() => fetch('/api/inbox/settings').then((r) => r.json()));
  expect([seen.via, seen.guest]).toEqual(['tailnet', true]);
  await expect(page.getByRole('button', { name: 'Update now' })).toHaveCount(0);
  await go(page, base, '#settings/agents');
  await expect(page.locator('[data-settings-section="agents"]')).toBeVisible();
  await expect(page.locator('[data-agent]')).toHaveCount(0);
  await go(page, base, '#settings/general');
  await expect(page.locator('[data-settings-section="general"]')).toBeVisible();
  await expect(page.locator('[data-general-update]')).toHaveCount(0);
  await expect(page.locator('[data-settings-cookie-host]')).toHaveCount(0);
  await go(page, base, '#settings/voice');
  await expect(page.locator('[data-settings-voice="guest"]')).toBeVisible();
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await picture(page, 'guest-voice', 390);
  expect(errors).toEqual([]);
  await context.close();
});
