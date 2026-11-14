/**
 * The review window's launch pad, in a real Chromium against the compiled
 * binary: with no guide yet, the header's Guide button opens the Agents tab,
 * one click on Start runs a Guided Review with the saved defaults (no dialog),
 * the finished guide opens by itself, and the tab then lists it under
 * "This diff".
 *
 * The only agent is a stand-in `claude` on the review server's own PATH: it
 * answers `--version`, refuses the SDK's model probe (so the built-in list is
 * used), and prints one stream-json result for a guide job. No real agent
 * CLI, no network, a temp PLANNOTATOR_DATA_DIR and HOME. Build the binary
 * first (see inbox.spec.ts).
 */

import { expect, test } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { accessSync, chmodSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { NO_BROWSER } from '../helpers/no-browser';

const repoRoot = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repoRoot, '.local/plannotator'));

const FIRST_RUN: Record<string, string> = {
  'plannotator-announce-agent-tool-seen': '1',
  'plannotator-announce-ask-session-seen': '1',
  'plannotator-announce-inbox-seen': '1',
  'plannotator-announce-tui-herdr-seen': '1',
  'plannotator-auto-viewed-notice-seen': '1',
  'plannotator-edit-mode-announcement-seen': '3',
  'plannotator-guide-hint-acked': 'true',
  'plannotator-guide-intro-seen': '2',
  'plannotator-plan-look-choice-resolved': 'true',
  'plannotator-review-dest-spotlight-seen': '1',
  'plannotator-token-hover-announcement-seen': '1',
};

const GUIDE = {
  title: 'Billing parts, read the core first',
  intent: 'Splits billing into parts.',
  sections: [
    { title: 'Core', overview: 'The first part.', diffs: [{ file: 'src/billing/part0.ts', summary: 'The base.' }] },
    { title: 'Routes', overview: 'Wiring.', diffs: [{ file: 'src/api/routes.ts', summary: 'Exposes it.' }] },
  ],
  unplacedFiles: ['README.md'],
};

function fakeClaude(bin: string): string {
  const log = join(bin, 'claude-calls.log');
  writeFileSync(
    join(bin, 'claude'),
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
      'case "$*" in',
      '  *--version*) echo "2.1.323 (Claude Code)"; exit 0 ;;',
      '  *--input-format*) exit 1 ;;',
      'esac',
      'cat >/dev/null',
      `printf '%s\\n' '${JSON.stringify({ type: 'result', is_error: false, structured_output: GUIDE })}'`,
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, 'claude'), 0o755);
  return log;
}

function ownPath(root: string): { path: string; log: string } {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const found = (process.env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, 'git'))
    .find((file) => {
      try {
        accessSync(file, constants.X_OK);
        return statSync(file).isFile();
      } catch {
        return false;
      }
    });
  if (found) symlinkSync(found, join(bin, 'git'));
  return { path: [bin, '/usr/bin', '/bin'].join(delimiter), log: fakeClaude(bin) };
}

function git(cwd: string, args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
}

function write(root: string, path: string, content: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function buildRepo(root: string): string {
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, ['init', '-q']);
  git(repo, ['branch', '-M', 'main']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  write(repo, 'README.md', '# Billing\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'initial']);
  git(repo, ['checkout', '-q', '-b', 'feature/billing']);
  write(repo, 'src/billing/part0.ts', 'export const part0 = 0;\n');
  write(repo, 'src/api/routes.ts', 'export const routes = {};\n');
  write(repo, 'README.md', '# Billing\n\nNow in parts.\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'billing']);
  return repo;
}

test('with no guide yet, Guide opens the launch pad and one click on Start runs a Guided Review', async ({ browser }) => {
  test.skip(!existsSync(binary), `compile the binary first: ${binary}`);
  test.setTimeout(90_000);
  const root = mkdtempSync(join(tmpdir(), 'plannotator-launch-pad-'));
  const repo = buildRepo(root);
  const readyFile = join(root, 'ready.jsonl');
  const { path, log } = ownPath(root);
  let child: ChildProcess | undefined;
  try {
    child = spawn(binary, ['review'], {
      cwd: repo,
      stdio: 'ignore',
      env: {
        PATH: path,
        HOME: root,
        PLANNOTATOR_TEST_SANDBOX: root,
        PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
        PLANNOTATOR_DATA_DIR: join(root, 'data'),
        PLANNOTATOR_READY_FILE: readyFile,
        PLANNOTATOR_BROWSER: NO_BROWSER,
        PLANNOTATOR_SKIP_BROWSER_OPEN: '1',
        NO_BROWSER,
        PLANNOTATOR_REMOTE: '0',
        PLANNOTATOR_UPDATE_CHECK: '0',
      },
    });
    await expect.poll(() => (existsSync(readyFile) ? readFileSync(readyFile, 'utf8') : ''), { timeout: 30_000 }).toContain('"url"');
    const url = (JSON.parse(readFileSync(readyFile, 'utf8').trim().split('\n')[0]!) as { url: string }).url;
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addCookies(Object.entries(FIRST_RUN).map(([name, value]) => ({ name, value, url })));
    const page = await context.newPage();
    await page.goto(url);
    await expect(page.locator('[data-review-sticky-tools]')).toBeVisible();

    await page.getByRole('button', { name: 'Guide', exact: true }).click();
    const pad = page.locator('[data-launch-pad]');
    await expect(pad).toBeVisible();
    await expect(page.locator('[data-launch-scope]')).toHaveText(/3 files · \+\d+ −\d+$/);
    await expect(page.locator('[data-guides-empty]')).toBeVisible();

    const start = page.locator('[data-launch-start="guide"]');
    await expect(start).toBeEnabled({ timeout: 20_000 });
    await start.click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await expect(page.getByText(GUIDE.title).first()).toBeVisible({ timeout: 30_000 });
    expect(readFileSync(log, 'utf8')).toMatch(/--model sonnet/);

    await page.getByRole('button', { name: 'Go back' }).click();
    await expect(page.locator('[data-guide-group="diff"] [data-saved-guide]')).toHaveCount(1);
    await expect(page.locator('[data-guide-group="diff"] [data-guide-progress]')).toHaveText('2 chapters, not started');
    await context.close();
  } finally {
    if (child && child.exitCode === null) {
      const exited = new Promise<void>((r) => child!.once('exit', () => r()));
      child.kill('SIGTERM');
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
