/**
 * The sidebar's Connect agent pill switches itself off once (the owner, 2026-11-23; packages/server/inbox-connect-pill-off.ts),
 * proved in a real Chromium against the compiled binary under temp data dirs, each Inbox seeded before it starts with
 * agents' threads (inbox-board-reveal-seed.ts):
 *
 *  - Agents first wrote 11 hours ago: the pill reads "Connect agent" at the top of the sidebar's foot, nothing stamped.
 *  - Agents first wrote two days ago: the Inbox turned the pill's sidebar switch off at start. No pill, the foot starts
 *    at Feedback as when the person hides it, and Customize sidebar shows Connect agent's switch off. Turned back on
 *    there, it shows at once and is still there after a reload (the switch-off never runs again).
 *
 * Build the binary first (see inbox.spec.ts). PNGs (light, 1440 wide) land in
 * PLANNOTATOR_E2E_PROOF_DIR/sidebar-connect-off, or .local/proof/sidebar-connect-off/.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { E2E_GROUP_TIP_SEEN, E2E_LAUNCH_OFF, inboxScratch, rememberInboxOf, removeInboxScratch, scratchEnv } from './inbox-scratch';
import { savedConfig } from '../helpers/saved-config';

const repo = resolve(__dirname, '../..');
const builtBinary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'sidebar-connect-off');
const PAST = '2026-10-01T10:00:00.000Z';
const PILL = 'Connect agent by copying a prompt';

const contexts: BrowserContext[] = [];

/** An Inbox whose agents' six threads began `daysAgo` days back, an hour apart; the one-time cards behind the person. */
async function world(browser: Browser, daysAgo: string): Promise<{ dataDir: string; page: Page }> {
  const root = inboxScratch('plannotator-inbox-connect-off-e2e-');
  const env = { PATH: process.env.PATH ?? '', ...scratchEnv(root), PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_UPDATE_CHECK: '0', PLANNOTATOR_INBOX_PHONES: '0' };
  const dataDir = env.PLANNOTATOR_DATA_DIR;
  const src = join(root, 'src');
  mkdirSync(src, { recursive: true });
  const seeded = spawnSync('bun', [join(repo, 'tests/e2e/inbox-board-reveal-seed.ts'), dataDir, src, daysAgo], { cwd: repo, encoding: 'utf8', env });
  expect(seeded.status, seeded.stderr).toBe(0);
  writeFileSync(
    join(dataDir, 'config.json'),
    JSON.stringify({
      ...E2E_LAUNCH_OFF,
      inboxTour: { version: 2, seen_at: PAST, skipped_at: PAST },
      inboxNotifications: { dismissed: true },
      inboxAgentNotes: { offered: true, asked: ['claude-code', 'codex', 'opencode', 'pi', 'gemini', 'qwen', 'cursor'] },
      // The Sidebar tip (a development build asks no tenure): seen, so no card sits beside the sidebar in the pictures.
      inboxReveals: { ...E2E_GROUP_TIP_SEEN, sidebar_tip: { shownAt: PAST } },
    }),
  );
  const started = spawnSync(builtBinary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  contexts.push(context);
  const page = await context.newPage();
  await page.goto(started.stdout.trim());
  await expect(side(page)).toBeVisible();
  return { dataDir, page };
}

const side = (page: Page) => page.getByRole('complementary', { name: 'Inbox navigation' });
const foot = (page: Page) => side(page).locator('.ib-side-foot');
const footItems = (page: Page) => foot(page).locator('[data-sidebar-item]').evaluateAll((els) => els.map((el) => el.getAttribute('data-sidebar-item')));

/** The window, and the sidebar's foot alone, in light at 1440 wide. */
async function shot(page: Page, name: string): Promise<void> {
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(proofDir, `${name}.png`) });
  await foot(page).screenshot({ path: join(proofDir, `${name}-foot.png`) });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  expect(existsSync(builtBinary), `build the binary first: ${builtBinary}`).toBe(true);
  mkdirSync(proofDir, { recursive: true });
});

test.afterAll(async () => {
  try {
    for (const context of contexts) await context.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

test('within the day the first agent wrote: the pill reads Connect agent at the top of the foot', async ({ browser }) => {
  const { dataDir, page } = await world(browser, '0.5');
  const pill = foot(page).getByRole('button', { name: PILL });
  await expect(pill).toBeVisible();
  await expect(pill.locator('.ib-cpill-l')).toHaveText(PILL);
  expect((await footItems(page))[0]).toBe('copy-prompt');
  await page.waitForTimeout(500);
  expect(savedConfig(dataDir).inboxSidebarConnectOff).toBeUndefined();
  await shot(page, 'pill-connect-agent');
});

test('a day after: the pill has left through its own switch, Customize shows it off, and turned back on it stays', async ({ browser }) => {
  const { dataDir, page } = await world(browser, '2');
  await expect(foot(page).locator('.ib-setrow')).toBeVisible();
  await expect(page.locator('[data-connect-prompt]')).toHaveCount(0);
  // Nothing else moved: the foot is the default's without the pill.
  expect(await footItems(page)).toEqual(['feedback', 'settings']);
  const stamp = savedConfig(dataDir).inboxSidebarConnectOff;
  expect(stamp).toEqual({ at: expect.stringMatching(/^\d{4}-/), rev: 1, first: true });
  expect(savedConfig(dataDir).inboxSidebar.hidden).toEqual(['copy-prompt']);
  await shot(page, 'pill-left');

  // Customize sidebar: Connect agent's switch, off.
  await side(page).locator('[data-sidebar-item="inbox"]').click({ button: 'right' });
  await page.locator('[data-sidebar-menu] [data-sidebar-toggle="copy-prompt"]').waitFor();
  await expect(page.locator('[data-sidebar-toggle="copy-prompt"]')).toHaveText('Connect agent');
  await expect(page.locator('[data-sidebar-toggle="copy-prompt"]')).toHaveAttribute('aria-checked', 'false');
  await page.locator('[data-sidebar-customize]').click();
  const panel = page.locator('[data-sidebar-customizer]');
  await expect(panel).toBeVisible();
  const sw = panel.locator('[data-sidebar-switch="copy-prompt"]');
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  await expect(panel.locator('[data-sbc-row="copy-prompt"]')).toContainText('Connect agent');
  await sw.scrollIntoViewIfNeeded();
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(proofDir, 'customize-switch-off.png') });

  // Back on: at once, and after a reload too.
  await sw.click();
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  await expect(foot(page).getByRole('button', { name: PILL })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect.poll(() => savedConfig(dataDir).inboxSidebar.hidden).toEqual([]);
  await page.reload();
  await expect(foot(page).getByRole('button', { name: PILL })).toBeVisible();
  await page.waitForTimeout(500);
  await expect(foot(page).getByRole('button', { name: PILL })).toBeVisible();
  expect(savedConfig(dataDir).inboxSidebarConnectOff).toEqual(stamp);
  await shot(page, 'pill-back-on');
});
