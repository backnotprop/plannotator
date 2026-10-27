/**
 * An action item's why drawn as markdown (the owner's report on 0.28.31:
 * `**App Manifest**` and code in backticks showed as raw marks), proved in a
 * real browser against the compiled binary with the owner's exact text, on a
 * desktop and a phone (WebKit, iPhone 15), light and dark: bold and code are
 * drawn, no raw marks show, and nothing overflows the card on the phone.
 *
 * Build the binary first (see inbox.spec.ts). PNGs land in
 * <PLANNOTATOR_E2E_PROOF_DIR or .local/proof>/action-markdown/.
 */

import { devices, expect, test, webkit, type Browser, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'action-markdown');

/** The owner's action item, word for word. */
const SLACK = [
  'The harness is set up.',
  '',
  ':::action',
  'Update the Slack app with the attached manifest, then reinstall it',
  "The app needs to be told when it's added to or removed from a channel. Steps: api.slack.com/apps → your superfan-test app → **App Manifest** → replace it with the contents of `slack-app.yaml` → **Save**, then **Install App** → **Reinstall**. If Slack shows a new Bot token (`xoxb-...`), run `pbpaste > /tmp/sfharness/slack-bot` on your Mac. Don't paste it here.",
  'Where: https://api.slack.com/apps',
  "Stopped: the test can't see channel joins without it",
  ':::',
].join('\n');

let url = '';
let threadId = '';
let claude: SimAgent;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-action-md-e2e-');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: join(root, 'data'), PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  url = started.stdout.trim();
  claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const sent = await claude.send({ project_path: scratchProject(join(root, 'src'), 'superfan'), thread: 'slack', body: SLACK });
  threadId = sent.thread_id as string;
});

test.afterAll(async () => {
  try {
    await claude?.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

async function check(page: Page, shot: string): Promise<void> {
  await page.goto(`${url}#thread=${threadId}`);
  const card = page.locator('section.ib-pane [data-action-group]');
  const why = card.locator('[data-action-why]');
  await expect(why).toBeVisible();
  await expect(why.locator('strong')).toHaveText(['App Manifest', 'Save', 'Install App', 'Reinstall']);
  await expect(why.locator('code')).toHaveText(['slack-app.yaml', 'xoxb-...', 'pbpaste > /tmp/sfharness/slack-bot']);
  expect(await why.textContent()).not.toMatch(/\*\*|`/);
  // Nothing wider than the card.
  const fit = await card.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
  expect(fit.scroll).toBeLessThanOrEqual(fit.client);
  await page.waitForTimeout(250);
  await card.screenshot({ path: join(proofDir, `${shot}.png`) });
}

for (const scheme of ['light', 'dark'] as const) {
  test(`desktop, ${scheme}: the owner's why reads as markdown`, async ({ browser }: { browser: Browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme, reducedMotion: 'reduce' });
    await check(await context.newPage(), `desktop-${scheme}`);
    await context.close();
  });

  test(`phone (WebKit, iPhone 15), ${scheme}: the owner's why reads as markdown and wraps inside the card`, async () => {
    const own = await webkit.launch({ args: [] });
    try {
      const context = await own.newContext({ ...devices['iPhone 15'], colorScheme: scheme, reducedMotion: 'reduce' });
      await check(await context.newPage(), `phone-${scheme}`);
      await context.close();
    } finally {
      await own.close();
    }
  });
}
