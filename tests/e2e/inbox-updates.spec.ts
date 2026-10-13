/**
 * The Inbox's update control in a real Chromium: a release-version Inbox
 * (the CLI from source with --define __CLI_VERSION__, since the e2e binary is
 * 0.0.0-dev and a dev build shows no update) under a temp HOME and data dir,
 * with update-state.json seeded with a newer release (so nothing asks
 * GitHub) and a fake install script on loopback. The Update button shows for
 * an AVAILABLE release, opens the update dialog, and Update now runs the
 * install script once for that version while the button reads Updating….
 *
 * Needs the built apps (apps/hook/dist), as the other specs do.
 */

import { expect, test } from '@playwright/test';
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const entry = join(repo, 'apps/hook/server/index.ts');
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'updates');

let root: string;
let dataDir: string;
let home: string;
let inbox: ChildProcess;
let installer: Server;
let installerPort = 0;
let url = '';

test.beforeAll(async () => {
  expect(existsSync(join(repo, 'apps/hook/dist/inbox.html')), 'build the apps first (bun run build:hook)').toBe(true);
  mkdirSync(proofDir, { recursive: true });
  root = inboxScratch('plannotator-inbox-updates-e2e-');
  dataDir = join(root, 'data');
  home = join(root, 'home');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  // The running bun counts as the binary the install script manages, so the dialog offers Update now.
  const bun = realpathSync(process.env.BUN_BINARY ?? execSync('command -v bun').toString().trim());
  symlinkSync(bun, join(home, '.local', 'bin', 'plannotator'));
  writeFileSync(join(dataDir, 'update-state.json'), JSON.stringify({ latestRelease: { tag: '0.28.12', fetchedAt: Date.now(), publishedAt: '2026-10-09T15:00:00Z' } }));
  mkdirSync(join(dataDir, 'update-notes'));
  writeFileSync(
    join(dataDir, 'update-notes', '0.28.12.json'),
    JSON.stringify({ version: '0.28.12', notes: 'A patch release for the Inbox.\n\n### Update notices\n\nOne click.', highlights: [] }),
  );
  writeFileSync(join(dataDir, 'install-flags.json'), '{"v":1,"flags":["skip-gemini"]}');

  // The fake install script: records its arguments, then takes a moment so Updating… shows.
  installer = createServer((_req, res) => {
    res.end(`printf '%s\\n' "$@" > "$HOME/installer-args"\nsleep 3\nexit 0\n`);
  });
  await new Promise<void>((r) => installer.listen(0, '127.0.0.1', () => r()));
  installerPort = (installer.address() as { port: number }).port;

  inbox = spawn(bun, ['--define', '__CLI_VERSION__="0.28.10"', entry, 'inbox', '--no-open'], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      TMPDIR: tmpdir(),
      PLANNOTATOR_DATA_DIR: dataDir,
      PLANNOTATOR_BROWSER: 'none',
      PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
      PLANNOTATOR_INBOX_PHONES: '0',
      // Never a real agent's CLI from PATH (packages/server/inbox-agents.ts).
      PLANNOTATOR_INBOX_CONNECT: '0',
      // Never GitHub (the seeded cache answers), never the real install script.
      PLANNOTATOR_UPDATE_API_URL: 'http://127.0.0.1:9/releases/latest',
      PLANNOTATOR_INSTALL_SCRIPT_URL: `http://127.0.0.1:${installerPort}/install.sh`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  inbox.stderr!.on('data', (c) => (err += c));
  const deadline = Date.now() + 60_000;
  while (!/Plannotator Inbox: (\S+)/.test(err) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  url = /Plannotator Inbox: (\S+)/.exec(err)?.[1] ?? '';
  expect(url, err).not.toBe('');
});

test.afterAll(async () => {
  try {
    inbox?.kill('SIGTERM');
    installer?.close();
  } finally {
    // The Inbox (waited for, SIGKILL if it hangs), then the folder (inbox-scratch.ts).
    await removeInboxScratch();
  }
});

test('an available release shows Update; the dialog runs the install script once with Update now', async ({ page }) => {
  await page.goto(url);
  const button = page.locator('.ib-upd[data-update-state="available"]').getByRole('button', { name: 'Update to Plannotator 0.28.12' });
  await expect(button).toBeVisible();
  await page.screenshot({ path: join(proofDir, '1-available.png') });

  await button.click();
  const dialog = page.locator('dialog[data-dialog="update"]');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Update to Plannotator 0.28.12');
  await expect(dialog).toContainText('You have 0.28.10');
  await expect(dialog).toContainText('A patch release for the Inbox.');
  await expect(dialog).toContainText('--skip-gemini');
  await page.screenshot({ path: join(proofDir, '2-dialog.png') });

  await dialog.getByRole('button', { name: 'Update now' }).click();
  await expect(page.locator('.ib-upd[data-update-state="updating"]')).toBeVisible();
  await expect(page.locator('.ib-upd-btn')).toBeDisabled();
  await page.screenshot({ path: join(proofDir, '3-updating.png') });

  // The fake install script ran for exactly that version with the remembered flags.
  await expect.poll(() => (existsSync(join(home, 'installer-args')) ? readFileSync(join(home, 'installer-args'), 'utf8').trim().split('\n') : [])).toEqual([
    '--version',
    'v0.28.12',
    '--non-interactive',
    '--skip-gemini',
  ]);
  // It finished: the lock is released and the result recorded.
  await expect.poll(() => existsSync(join(dataDir, 'update.lock')), { timeout: 20_000 }).toBe(false);
  expect(JSON.parse(readFileSync(join(dataDir, 'update-result.json'), 'utf8'))).toEqual({ version: 'v0.28.12', exitCode: 0 });
});
