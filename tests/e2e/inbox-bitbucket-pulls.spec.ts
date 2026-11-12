/**
 * Bitbucket Cloud pull requests in the Inbox, against the compiled binary and
 * the fake Bitbucket API (tests/test-fixtures/bitbucket/fake-bitbucket.ts, run
 * with Bun beside the spec). The token comes from `bitbucketTokenCommand` in
 * config.json: no PLANNOTATOR_BITBUCKET_TOKEN anywhere.
 *
 * The failures these guard: an agent's Bitbucket PR link refused as "not a
 * full PR ref"; the row and the header reading `unknown` forever because no
 * reader asks Bitbucket; the token command run for every read instead of once;
 * a Bitbucket link in a message that shows no card, or a GitHub-shaped one.
 *
 * Screenshots: set PLANNOTATOR_BB_SHOTS to a folder.
 */

import { expect, test, type Page } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { E2E_LAUNCH_OFF, inboxScratch, removeInboxScratch, scratchEnv } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shotsDir = process.env.PLANNOTATOR_BB_SHOTS;

const EMAIL = 'ada@example.invalid';
const TOKEN = 'fake-token-never-real-1234567890';
const PR_URL = 'https://bitbucket.org/ws/repo/pull-requests/1';

async function shot(page: Page, name: string) {
  if (!shotsDir) return;
  mkdirSync(shotsDir, { recursive: true });
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(shotsDir, `${name}.png`) });
}

/** The fake API in a Bun process; resolves with its base URL once it serves. */
function startFakeBitbucket(): Promise<{ apiUrl: string; proc: ChildProcess }> {
  const proc = spawn('bun', [join(repo, 'tests/test-fixtures/bitbucket/fake-bitbucket.ts')], {
    cwd: repo,
    env: { PATH: process.env.PATH ?? '', PLANNOTATOR_BITBUCKET_TOKEN: TOKEN, PLANNOTATOR_BITBUCKET_EMAIL: EMAIL },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((done, fail) => {
    const lines = createInterface({ input: proc.stdout! });
    lines.once('line', (apiUrl) => done({ apiUrl: apiUrl.trim(), proc }));
    proc.once('exit', (code) => fail(new Error(`fake Bitbucket exited with ${code}`)));
  });
}

test.describe('Bitbucket Cloud pull requests in the Inbox', () => {
  let url = '';
  let threadId = '';
  let root = '';
  let runs = '';
  let fake: ChildProcess | null = null;

  test.beforeAll(async () => {
    expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
    root = inboxScratch('plannotator-inbox-bitbucket-e2e-');
    const started = await startFakeBitbucket();
    fake = started.proc;

    // The token command: prints the token and counts its runs.
    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    runs = join(root, 'token-runs');
    const command = join(bin, 'bb-token');
    writeFileSync(command, `#!/bin/sh\necho run >> "${runs}"\nprintf '%s\\n' '${TOKEN}'\n`);
    chmodSync(command, 0o755);
    const dataDir = join(root, 'data');
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ ...E2E_LAUNCH_OFF, bitbucketEmail: EMAIL, bitbucketTokenCommand: [command] }));

    const env = { ...scratchEnv(root), PATH: process.env.PATH ?? '', PLANNOTATOR_BITBUCKET_API_URL: started.apiUrl };
    const inbox = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
    expect(inbox.status, inbox.stderr).toBe(0);
    url = inbox.stdout.trim();

    const project = scratchProject(join(root, 'src'), 'repo');
    spawnSync('git', ['remote', 'add', 'origin', 'git@bitbucket.org:ws/repo.git'], { cwd: project });
    const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
    try {
      const sent = await agent.send({
        project_path: project,
        subject: 'Add mul and greet',
        body: `Opened the PR: ${PR_URL}\n\nThe unit tests pass; the integration run is still going.`,
        pulls: [PR_URL],
      });
      threadId = sent.thread_id as string;
    } finally {
      await agent.close().catch(() => {});
    }
  });

  test.afterAll(async () => {
    await removeInboxScratch(root);
    fake?.kill('SIGTERM');
  });

  test("the agent's Bitbucket PR shows its state on the row, in the header and in its card", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light' });
    const page = await context.newPage();
    try {
      await page.goto(`${url}#thread=${threadId}`);

      // The header's PR button and the row's mark: read through the fake API, so open, not unknown.
      const button = page.locator('[data-pr-button]');
      await expect(button).toHaveAttribute('data-pr-button', 'open', { timeout: 15_000 });
      await expect(page.locator(`[data-thread-id="${threadId}"] [data-pr-mark]`).first()).toHaveAttribute('data-pr-mark', 'open');

      for (const scheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await shot(page, `${scheme}-thread`);

        // Its popover: the PR's card, Bitbucket's own words and link.
        await button.click();
        const popover = page.locator('[data-pr-popover]');
        await expect(popover.locator('[data-ref-card-title]')).toContainText('Add mul and greet');
        await expect(popover.locator('[data-ref-card-state]')).toHaveAttribute('data-ref-card-state', 'open');
        await expect(popover.locator('[data-ref-card-branch]')).toHaveText('main ← feature/smoke');
        await expect(popover.locator('[data-ref-card-checks="pending"]')).toHaveText(/1 running · 1 passed/);
        await expect(popover.locator('[data-ref-card-review]')).toHaveText('Changes requested');
        await expect(popover).toContainText('Open on Bitbucket');
        await shot(page, `${scheme}-popover`);
        await page.keyboard.press('Escape');
        await expect(popover).toHaveCount(0);

        // The link in the message: the same card on hover.
        await page.mouse.move(2, 2);
        await page.locator(`[data-message-id] a[href="${PR_URL}"]`).first().hover();
        const card = page.locator('[data-ref-card]');
        await expect(card.locator('[data-ref-card-title]')).toContainText('Add mul and greet');
        expect(await card.getAttribute('aria-label')).toBe('Pull request #1: Add mul and greet');
        await shot(page, `${scheme}-hover-card`);
        await page.mouse.move(2, 2);
        await expect(card).toHaveCount(0);
      }
    } finally {
      await context.close();
    }
    // Every read above shared the one token the command printed.
    expect(readFileSync(runs, 'utf8').trim().split('\n')).toEqual(['run']);
  });
});
