/**
 * The Inbox's update control in a real Chromium: a release-version Inbox
 * (the CLI from source with --define __CLI_VERSION__, since the e2e binary is
 * 0.0.0-dev and a dev build shows no update) under a temp HOME and data dir,
 * with update-state.json seeded with a newer release (so nothing asks
 * GitHub) and a fake install script on loopback. The Update button shows for
 * an AVAILABLE release, opens the update dialog, and Update now runs the
 * install script once for that version while the button reads Updating….
 *
 * PLANNOTATOR_E2E_RELEASE_BINARY names a binary compiled with
 * __CLI_VERSION__="0.28.10" to run instead of the CLI from source (CI does).
 * Needs the built apps (apps/hook/dist), as the other specs do.
 */

import { expect, test } from '@playwright/test';
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

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
  // The running program (bun, or the release binary) counts as the one the install script manages, so the dialog offers Update now.
  const release = process.env.PLANNOTATOR_E2E_RELEASE_BINARY;
  const bun = realpathSync(process.env.BUN_BINARY ?? execSync('command -v bun').toString().trim());
  const program = release ? realpathSync(release) : bun;
  symlinkSync(program, join(home, '.local', 'bin', 'plannotator'));
  writeFileSync(join(dataDir, 'update-state.json'), JSON.stringify({ latestRelease: { tag: '0.28.12', fetchedAt: Date.now(), publishedAt: '2026-10-09T15:00:00Z' } }));
  mkdirSync(join(dataDir, 'update-notes'));
  writeFileSync(
    join(dataDir, 'update-notes', '0.28.12.json'),
    JSON.stringify({ version: '0.28.12', notes: 'A patch release for the Inbox.\n\n### Update notices\n\nOne click.', highlights: [] }),
  );
  writeFileSync(join(dataDir, 'install-flags.json'), '{"v":1,"flags":["skip-gemini"]}');

  // The fake release (safe updates): the install script, which records its
  // arguments and takes a moment so Updating… shows, and the .sha256 files the
  // running Plannotator downloads itself before it runs the script.
  installer = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (path === '/install.sh') {
      res.end(`#!/bin/bash\nREPO="backnotprop/plannotator"\nprintf '%s\\n' "$@" > "$HOME/installer-args"\nsleep 3\nexit 0\n`);
    } else if (/^\/download\/v0\.28\.12\/plannotator-(darwin|linux)-(arm64|x64)\.sha256$/.test(path)) {
      res.end(`${'c'.repeat(64)}  x\n`);
    } else {
      res.statusCode = 404;
      res.end('not found');
    }
  });
  await new Promise<void>((r) => installer.listen(0, '127.0.0.1', () => r()));
  installerPort = (installer.address() as { port: number }).port;

  inbox = spawn(program, release ? ['inbox', '--no-open'] : ['--define', '__CLI_VERSION__="0.28.10"', entry, 'inbox', '--no-open'], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      TMPDIR: tmpdir(),
      PLANNOTATOR_DATA_DIR: dataDir,
      PLANNOTATOR_BROWSER: NO_BROWSER,
      PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
      PLANNOTATOR_INBOX_PHONES: '0',
      // Never a real agent's CLI from PATH (packages/server/inbox-agents.ts).
      PLANNOTATOR_INBOX_CONNECT: '0',
      // Never GitHub (the seeded cache answers), never the real install script.
      PLANNOTATOR_UPDATE_API_URL: 'http://127.0.0.1:9/releases/latest',
      PLANNOTATOR_FEEDBACK_URL: 'http://127.0.0.1:9/feedback',
      PLANNOTATOR_INSTALL_SCRIPT_URL: `http://127.0.0.1:${installerPort}/install.sh`,
      PLANNOTATOR_RELEASE_DOWNLOAD_URL: `http://127.0.0.1:${installerPort}/download`,
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

// Before Update now runs (the next test changes the state): the dot on the sidebar toggle while the sidebar is closed.
test('a closed sidebar puts a dot on its toggle while an update waits; open, it goes', async ({ page }) => {
  const shots = process.env.PLANNOTATOR_UPDATE_DOT_SHOTS ?? proofDir;
  mkdirSync(shots, { recursive: true });
  // One thread, so the list (not the first-run screen) is what shows.
  const project = join(root, 'project');
  mkdirSync(project, { recursive: true });
  const sent = await fetch(new URL('/mcp', url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'send_message', arguments: { body: 'The migration is done; the report is in the PR.', subject: 'Migration finished', project_path: project, agent_session: 'ses_dot', agent_host: 'claude-code' } },
    }),
  });
  expect(sent.status).toBe(200);
  const trigger = page.locator('.ib-lhead [data-sidebar="trigger"]').first();
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(url);
    await expect(page.locator('.ib-upd[data-update-state="available"]')).toBeVisible();
    // The notification ask line is not what the pictures are about.
    const hide = page.getByRole('button', { name: 'Hide', exact: true });
    if (await hide.isVisible().catch(() => false)) await hide.click();
    // Open: the Update button is in view, so the toggle has no dot.
    await expect(trigger).toHaveAttribute('aria-label', 'Toggle Sidebar');
    await expect(trigger.locator('.ib-sb-trigger-dot')).toHaveCount(0);
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-label', 'Toggle Sidebar, update available');
    const dot = trigger.locator('.ib-sb-trigger-dot');
    await expect(dot).toBeVisible();
    // Measure once the close has settled (the docked panel goes inert at progress zero).
    await expect(page.locator('.ib-sb-panel[data-hidden]')).toHaveCount(1);
    await expect(dot).toHaveAttribute('aria-hidden', 'true');
    // About 7 px, inside the toggle's top-right quarter.
    const [d, t] = [await dot.boundingBox(), await trigger.boundingBox()];
    expect(Math.round(d!.width)).toBe(7);
    expect(d!.x + d!.width / 2).toBeGreaterThan(t!.x + t!.width / 2);
    expect(d!.y + d!.height / 2).toBeLessThan(t!.y + t!.height / 2);
    await page.mouse.move(640, 600);
    await page.screenshot({ path: join(shots, `desktop-${scheme}.png`) });
    await page.screenshot({ path: join(shots, `desktop-${scheme}-toggle.png`), clip: { x: t!.x - 12, y: t!.y - 12, width: t!.width + 160, height: t!.height + 24 } });
    await trigger.click();
    await expect(dot).toHaveCount(0);

    // A phone: the sheet starts closed, so the dot shows; opening the sheet shows the Update button instead.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(url);
    const phoneTrigger = page.locator('.ib-lhead [data-sidebar="trigger"]').first();
    await expect(phoneTrigger).toHaveAttribute('aria-label', 'Toggle Sidebar, update available');
    await expect(phoneTrigger.locator('.ib-sb-trigger-dot')).toBeVisible();
    await page.screenshot({ path: join(shots, `phone-${scheme}.png`) });
    const pt = await phoneTrigger.boundingBox();
    await page.screenshot({ path: join(shots, `phone-${scheme}-toggle.png`), clip: { x: Math.max(0, pt!.x - 8), y: Math.max(0, pt!.y - 8), width: pt!.width + 160, height: pt!.height + 16 } });
  }
});

test('an available release shows Update; the dialog runs the install script once with Update now', async ({ page }) => {
  await page.goto(url);
  const button = page.locator('.ib-upd[data-update-state="available"]').getByRole('button', { name: 'Update to 0.28.12', exact: true });
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
