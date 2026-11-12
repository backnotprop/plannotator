/**
 * Click Inbox to refresh (the owner, 2026-10-20: "Just click inbox, it
 * refreshes. That way I don't have to refresh the page"), proved in real
 * browsers against the compiled binary, with an agent writing through
 * `plannotator inbox mcp` (scripts/inbox-sim.ts):
 *
 * - Desktop (Chromium, 1440 by 900, light and dark): an agent's message waits
 *   behind "1 new · Show"; hovering Inbox in the sidebar swaps its icon for ↻
 *   with the component tooltip "Refresh" (no native title); a click turns the
 *   icon once (a running animation, then gone), the live region says "Inbox
 *   refreshed", the message comes in and "1 new" goes, focus stays on Inbox.
 * - The project the list shows: the same ↻ after its name and "Refresh".
 * - A phone (the iPhone 15's screen, touch and mobile layout, in the config's Chromium): a tap on
 *   the list's title does the same. No browser is launched by hand.
 * - Reduced motion: the click still gives the signal, with nothing animated.
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 * Screenshots (hover ↻, the turn, before and after) land in
 * PLANNOTATOR_REFRESH_SHOTS, else .local/proof/inbox-refresh/.
 */

import { devices, expect, test, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shotsDir = resolve(process.env.PLANNOTATOR_REFRESH_SHOTS ?? join(repo, '.local/proof/inbox-refresh'));

interface World {
  url: string;
  agent: SimAgent;
  path: string;
}

let world: World;
let sent = 0;

async function agentWrites(subject: string): Promise<string> {
  sent += 1;
  const reply = await world.agent.send({ project_path: world.path, subject, body: `${subject}. Nothing to answer.`, agent_session: `ses_refresh_${sent}` } as Parameters<SimAgent['send']>[0]);
  return String(reply.thread_id);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  mkdirSync(shotsDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-refresh-e2e-');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: join(root, 'data'), PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const path = scratchProject(join(root, 'src'), 'docs-site');
  world = { url: started.stdout.trim().replace(/\/$/, ''), agent, path };
  for (const subject of ['Search index built', 'Install page links fixed', 'Changelog drafted']) await agentWrites(subject);
});

test.afterAll(async () => {
  try {
    await world?.agent.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

const row = (page: Page, id: string) => page.locator(`.ib-listcol .ib-lbody [data-thread-id="${id}"]`);
const notice = (page: Page) => page.locator('[data-inbox-notice]');
const live = (page: Page) => page.locator('[data-inbox-live]');

/** Which of the Inbox row's two icons shows. */
const shownIcon = (page: Page) =>
  page.locator('.ib-side [data-inbox-nav]').evaluate((nav) => {
    const visible = (sel: string) => getComputedStyle(nav.querySelector(sel)!).visibility === 'visible';
    return visible('.ib-ic-refresh') ? 'refresh' : visible('.ib-ic-inbox') ? 'inbox' : 'none';
  });

/** The turn's animation on the refresh icon, while it runs. */
const turning = (page: Page, sel: string) =>
  page.locator(sel).evaluate((el) => el.getAnimations().some((a) => a.playState === 'running'));

async function heldArrival(page: Page, subject: string): Promise<string> {
  const id = await agentWrites(subject);
  await expect(notice(page)).toContainText('1 new');
  await expect(row(page, id)).toHaveCount(0);
  return id;
}

for (const scheme of ['light', 'dark'] as const) {
  test(`desktop ${scheme}: hover shows ↻ and "Refresh", a click turns it once and brings the held message in`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(world.url);
    await expect(page.locator('.ib-lbody [data-thread-id]').first()).toBeVisible();
    const id = await heldArrival(page, `Deploy notes (${scheme})`);
    await page.mouse.move(1000, 600);
    await page.screenshot({ path: join(shotsDir, `desktop-${scheme}-1-before.png`) });

    const nav = page.locator('.ib-side [data-inbox-nav]');
    await expect(nav).toHaveAttribute('data-refreshes', '');
    expect(await shownIcon(page)).toBe('inbox');
    await nav.hover();
    expect(await shownIcon(page)).toBe('refresh');
    const tip = page.locator('[data-pn-tooltip]');
    await expect(tip).toHaveText('Refresh');
    // Component tooltips only: no native title anywhere in the window.
    expect(await page.locator('.pn-inbox [title]:not(iframe)').count()).toBe(0);
    await page.screenshot({ path: join(shotsDir, `desktop-${scheme}-2-hover.png`) });

    await nav.click();
    await expect(nav).toHaveAttribute('data-refreshing', '');
    expect(await turning(page, '.ib-side [data-inbox-nav] .ib-ic-refresh')).toBe(true);
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(shotsDir, `desktop-${scheme}-3-turning.png`) });

    await expect(row(page, id)).toBeVisible();
    await expect(notice(page)).toHaveCount(0);
    await expect(live(page)).toHaveText('Inbox refreshed');
    await expect(nav).not.toHaveAttribute('data-refreshing', '');
    await expect(nav).toBeFocused();
    // The row it brought in lights up, as Show's do.
    await expect(row(page, id)).toHaveAttribute('data-lit', '');
    await page.mouse.move(1000, 600);
    await page.screenshot({ path: join(shotsDir, `desktop-${scheme}-4-after.png`) });
  });
}

for (const scheme of ['light', 'dark'] as const) {
  test(`desktop ${scheme}: the project the list shows offers the same ↻ and "Refresh"`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    const list = (await (await fetch(`${world.url}/api/inbox/projects`)).json()) as { projects: { id: string; root: string }[] };
    const id = list.projects[0]!.id;
    await page.goto(`${world.url}/#project=${id}`);
    await expect(page.locator('.ib-lbody [data-thread-id]').first()).toBeVisible();
    const row = page.locator(`.ib-side [data-project="${id}"] .ib-proj`);
    await expect(row).toHaveAttribute('data-refreshes', '');
    const icon = row.locator('svg.ib-ic-refresh');
    expect(await icon.evaluate((el) => getComputedStyle(el).visibility)).toBe('hidden');
    await row.hover();
    expect(await icon.evaluate((el) => getComputedStyle(el).visibility)).toBe('visible');
    await expect(page.locator('[data-pn-tooltip]')).toHaveText('Refresh');
    await page.screenshot({ path: join(shotsDir, `desktop-${scheme}-5-project-hover.png`) });
    await row.click();
    await expect(row).toHaveAttribute('data-refreshing', '');
    await expect(live(page)).toHaveText('docs-site refreshed');
  });
}

test('reduced motion: the click still gives the signal, with nothing animated', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(world.url);
  await expect(page.locator('.ib-lbody [data-thread-id]').first()).toBeVisible();
  const nav = page.locator('.ib-side [data-inbox-nav]');
  await nav.click();
  await expect(nav).toHaveAttribute('data-refreshing', '');
  expect(await shownIcon(page)).toBe('refresh');
  expect(await turning(page, '.ib-side [data-inbox-nav] .ib-ic-refresh')).toBe(false);
  await expect(live(page)).toHaveText('Inbox refreshed');
});

// The iPhone 15's screen, touch and mobile layout in the config's own browser: launching another
// browser by hand from this Chromium project dies on the CI runner (the config's Chromium flags reach
// it). inbox-mobile.spec.ts covers the window in WebKit itself.
const { defaultBrowserType: _phoneBrowser, ...iPhone } = devices['iPhone 15'];
test.describe('a phone (iPhone 15 screen)', () => {
  test.use(iPhone);
  test('a tap on the list title refreshes it', async ({ page }) => {
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(world.url);
      await expect(page.locator('.ib-lbody [data-thread-id]').first()).toBeVisible();
      const id = await heldArrival(page, `Phone note (${scheme})`);
      await page.screenshot({ path: join(shotsDir, `phone-${scheme}-1-before.png`) });
      const title = page.locator('.ib-lhead [data-list-refresh]');
      await title.tap();
      await expect(title).toHaveAttribute('data-refreshing', '');
      await page.waitForTimeout(200);
      await page.screenshot({ path: join(shotsDir, `phone-${scheme}-2-turning.png`) });
      await expect(row(page, id)).toBeVisible();
      await expect(notice(page)).toHaveCount(0);
      await expect(live(page)).toHaveText('Inbox refreshed');
      await expect(title).not.toHaveAttribute('data-refreshing', '');
      await page.screenshot({ path: join(shotsDir, `phone-${scheme}-3-after.png`) });
    }
  });
});
