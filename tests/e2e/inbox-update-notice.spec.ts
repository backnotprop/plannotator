/**
 * A new release shows in the Inbox within minutes, in a real Chromium.
 *
 * A release-version Inbox (the CLI from source with --define
 * __CLI_VERSION__) under a temp HOME and data dir, with no answer cached and
 * a fake GitHub on loopback: the "latest release" page redirects to a newer
 * tag, and the API answers 403 (its rate limit), as it can on a busy IP.
 * Before this change the only source was the API, so a 403 hid the button
 * for hours. Now the page answers and the Update button shows at once; a
 * newer release the page names after that shows on the next page load.
 *
 * PLANNOTATOR_E2E_RELEASE_BINARY names a binary compiled with
 * __CLI_VERSION__="0.28.10" to run instead of the CLI from source (CI does).
 * Needs the built apps (apps/hook/dist), as the other specs do.
 */

import { expect, test } from '@playwright/test';
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const entry = join(repo, 'apps/hook/server/index.ts');
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'update-notice');

let root: string;
let dataDir: string;
let inbox: ChildProcess;
let github: Server;
let latest = '0.28.12';
const requests: string[] = [];
let url = '';

test.beforeAll(async () => {
  expect(existsSync(join(repo, 'apps/hook/dist/inbox.html')), 'build the apps first (bun run build:hook)').toBe(true);
  mkdirSync(proofDir, { recursive: true });
  root = inboxScratch('plannotator-inbox-update-notice-e2e-');
  dataDir = join(root, 'data');
  const home = join(root, 'home');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(home, { recursive: true });

  github = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.url === '/r/p/releases/latest') {
      res.writeHead(302, { location: `/r/p/releases/tag/v${latest}` }).end();
      return;
    }
    res.writeHead(403, { 'x-ratelimit-remaining': '0' }).end('{"message":"API rate limit exceeded"}');
  });
  await new Promise<void>((r) => github.listen(0, '127.0.0.1', () => r()));
  const port = (github.address() as { port: number }).port;

  const release = process.env.PLANNOTATOR_E2E_RELEASE_BINARY;
  const bun = realpathSync(process.env.BUN_BINARY ?? execSync('command -v bun').toString().trim());
  const [command, args] = release
    ? [realpathSync(release), ['inbox', '--no-open']]
    : [bun, ['--define', '__CLI_VERSION__="0.28.10"', entry, 'inbox', '--no-open']];
  inbox = spawn(command, args, {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      TMPDIR: tmpdir(),
      PLANNOTATOR_DATA_DIR: dataDir,
      PLANNOTATOR_BROWSER: NO_BROWSER,
      NO_BROWSER,
      PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
      PLANNOTATOR_INBOX_PHONES: '0',
      PLANNOTATOR_INBOX_CONNECT: '0',
      PLANNOTATOR_INBOX_TAILSCALE: '0',
      PLANNOTATOR_INSTALL_SCRIPT_URL: 'http://127.0.0.1:9/install.sh',
      PLANNOTATOR_UPDATE_LATEST_URL: `http://127.0.0.1:${port}/r/p/releases/latest`,
      PLANNOTATOR_UPDATE_API_URL: `http://127.0.0.1:${port}/api/releases/latest`,
      PLANNOTATOR_FEEDBACK_URL: 'http://127.0.0.1:9/feedback',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  inbox.stderr!.on('data', (c) => (err += c));
  const deadline = Date.now() + 60_000;
  while (!/Plannotator Inbox: (\S+)/.test(err) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  url = /Plannotator Inbox: (\S+)/.exec(err)?.[1] ?? '';
  expect(url, err).not.toBe('');
  rememberInboxOf(dataDir);
});

test.afterAll(async () => {
  try {
    github?.close();
  } finally {
    // The Inbox (proven, SIGTERM then SIGKILL), then the folder (inbox-scratch.ts).
    await removeInboxScratch();
  }
});

test('the Update button shows without waiting an hour, though the API is rate limited', async ({ page }) => {
  await page.goto(url);
  const button = page.locator('.ib-upd[data-update-state="available"]').getByRole('button', { name: 'Update to 0.28.12', exact: true });
  await expect(button).toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: join(proofDir, '1-available.png') });
  expect(requests).toContain('HEAD /r/p/releases/latest');
  expect(requests).not.toContain('GET /api/releases/latest');

  // A newer release a minute later: a page load asks again (at most once a
  // minute), so wait out the minute instead of an hour.
  latest = '0.28.13';
  const asked = requests.filter((r) => r === 'HEAD /r/p/releases/latest').length;
  await page.waitForTimeout(61_000);
  await page.reload();
  await expect(page.locator('.ib-upd[data-update-state="available"]').getByRole('button', { name: 'Update to 0.28.13', exact: true })).toBeVisible({
    timeout: 10_000,
  });
  expect(requests.filter((r) => r === 'HEAD /r/p/releases/latest').length).toBe(asked + 1);
  await page.screenshot({ path: join(proofDir, '2-newer-on-reload.png') });
});
