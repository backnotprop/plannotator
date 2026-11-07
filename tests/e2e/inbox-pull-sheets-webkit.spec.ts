/**
 * The flat PR view's folded sheets in WebKit, against the compiled binary: in Safari a click does not focus a button, so
 * a sheet opened by mouse leaves focus on the page, and Escape has to close it from there. `gh` and `glab` are sh fakes
 * first on PATH. The rest of the view, in Chromium: inbox-pull-requests.spec.ts.
 *
 * Runs in the playwright config's `webkit` project. Build the binary first (see inbox.spec.ts).
 */

import { expect, test, type Locator, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(__dirname, '../../.local/plannotator'));
const REPO = 'northwind/web-app';
const KEY = `github.com/${REPO}#880`;
const PATCH = 'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,2 +1,2 @@\n one\n-two\n+three\n';

let url = '';

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-inbox-pull-sheets-webkit-');
  const dataDir = join(root, 'data');
  markTourDecided(dataDir);
  const configFile = join(dataDir, 'config.json');
  writeFileSync(configFile, JSON.stringify({ ...JSON.parse(readFileSync(configFile, 'utf8')), inboxBoard: false }));
  for (const dir of ['claude', 'codex', 'xdg']) mkdirSync(join(root, dir), { recursive: true });
  const forgeDir = join(root, 'forge');
  mkdirSync(forgeDir);
  const pull = {
    number: 880,
    title: 'RTL layout for the settings pages',
    url: `https://github.com/${REPO}/pull/880`,
    state: 'OPEN',
    isDraft: false,
    updatedAt: new Date().toISOString(),
    mergedAt: null,
    baseRefName: 'main',
    headRefName: 'tomas/rtl-settings',
    headRefOid: '880'.padStart(40, '0'),
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    reviewDecision: 'REVIEW_REQUIRED',
    repository: { nameWithOwner: REPO },
    headRepository: { nameWithOwner: REPO },
    author: { login: 'tomas' },
    reviewRequests: { nodes: [] },
    latestReviews: { nodes: [] },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
  };
  writeFileSync(join(forgeDir, 'pulls.json'), JSON.stringify({ data: { viewer: { login: 'dana' }, requested: { nodes: [pull] }, authored: { nodes: [] }, merged: { nodes: [] } } }));
  writeFileSync(join(forgeDir, 'patch'), PATCH);
  writeFileSync(
    join(forgeDir, 'gh'),
    [
      '#!/bin/sh',
      `dir='${forgeDir}'`,
      `if [ "$1" = auth ]; then echo '{"hosts":{"github.com":[{"login":"dana","active":true,"state":"success","tokenSource":"keyring"}]}}'; exit 0; fi`,
      'if [ "$2" = graphql ]; then cat "$dir/pulls.json"; exit 0; fi',
      `if [ "$5" = --jq ]; then printf '{"sha":"%040d","body":null}\\n' "\${4##*/}"; exit 0; fi`,
      'if [ "$2" = --hostname ]; then cat "$dir/patch"; exit 0; fi',
      'exit 1',
      '',
    ].join('\n'),
  );
  writeFileSync(join(forgeDir, 'glab'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(forgeDir, 'gh'), 0o755);
  chmodSync(join(forgeDir, 'glab'), 0o755);
  const env: Record<string, string> = {
    PATH: `${forgeDir}:${process.env.PATH ?? ''}`,
    HOME: root,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_ANON_PING: '1',
    PLANNOTATOR_INBOX_NOTES: '0',
    PLANNOTATOR_TEST_SANDBOX: '1',
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    CODEX_HOME: join(root, 'codex'),
    XDG_CONFIG_HOME: join(root, 'xdg'),
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  url = started.stdout.trim();
  // Only the hosts of the Inbox's projects' remotes are asked for pull requests: one project, from one agent's message.
  const project = scratchProject(join(root, 'src'), 'web-app');
  spawnSync('git', ['remote', 'add', 'origin', `https://github.com/${REPO}.git`], { cwd: project, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  await agent.send({ project_path: project, thread: 'rtl', subject: 'RTL', body: 'Hello.' });
  await agent.close();
});

test.afterAll(async () => {
  await removeInboxScratch();
});

async function openReview(page: Page): Promise<Locator> {
  await page.setViewportSize({ width: 800, height: 900 });
  const response = await page.request.post(`${url}api/inbox/settings`, { data: { code_review: { on: true } } });
  expect(response.status()).toBe(200);
  const key = encodeURIComponent(KEY);
  await page.goto(`${url}#pulls&stack=${key}&layer=${key}&scope=layer`);
  const review = page.locator('[data-pull-review]');
  await expect(review.locator('[data-guide-file-shell]').first()).toBeVisible({ timeout: 30_000 });
  return review;
}

test('a sheet opened by mouse, focus still on the page: Escape closes it, back on its button', async ({ page }) => {
  const review = await openReview(page);
  const comments = review.locator('.ib-vcomments');
  const panel = review.locator('.ib-gpanel');
  await comments.click();
  await expect(panel).toBeVisible();
  // The case this file is for: Safari leaves focus where it was. Only Apple's WebKit does; Linux's (GTK and WPE, what
  // CI runs) focuses a clicked button like Chromium, so the page takes focus back here, as Safari leaves it.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('BODY');
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(comments).toBeFocused();
  await expect(review).toBeVisible();

  // The rail is a sheet on a phone only.
  await page.setViewportSize({ width: 390, height: 844 });
  const files = review.locator('[data-pull-review-files-button]');
  const rail = review.locator('.ib-rrail');
  await files.click();
  await expect(rail).toBeVisible();
  // The head's right end, clear of its Changes | All files switch.
  await review.locator('.ib-prp-fileshead').click({ position: { x: (await review.locator('.ib-prp-fileshead').boundingBox())!.width - 2, y: 6 } });
  await page.keyboard.press('Escape');
  await expect(rail).toBeHidden();
  await expect(files).toBeFocused();
});
