/**
 * Settings in sections (design of record `.product/approved/inbox-settings-tabs/`,
 * approved 2026-10-12), in a real browser against the compiled binary under
 * a temp PLANNOTATOR_DATA_DIR and HOME, with phones on and `tailscale` a
 * script on PATH (fake-tailscale.ts), so nothing reaches a real tailnet.
 *
 * Desktop (Chromium, 1440 by 900): the sidebar's Settings opens General on a
 * focused page (the Inbox sidebar slides away, its cookie unwritten); the
 * section nav is a list of links with aria-current, keyboard-followable,
 * focus on the new section's heading; every section has its address and a
 * deep link opens it; Back and Forward move between sections; "← Inbox"
 * returns to the thread the person was in, with the sidebar back; an old
 * `#settings` link still lands in Settings.
 *
 * Phone (WebKit, iPhone 15): `#settings` is the list of sections; a section
 * opens with "‹ Settings", whose Back is the browser's; Pair a phone starts
 * at step 1 and shows the code once Tailscale is on.
 *
 * PNGs, light and dark, land in .local/proof/settings/.
 */

import { devices, expect, test, webkit, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent } from '../../scripts/inbox-sim';
import { E2E_MAGIC, fakeTailscale } from './fake-tailscale';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'settings');

interface World {
  root: string;
  url: string;
  env: Record<string, string>;
  context: BrowserContext;
  page: Page;
  errors: string[];
  thread: string;
}

let world: World;

async function shot(page: Page, name: string): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(proofDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-settings-e2e-');
  const ts = fakeTailscale(join(root, 'ts'));
  const env = { PATH: `${ts}:${process.env.PATH ?? ''}`, HOME: root, PLANNOTATOR_DATA_DIR: join(root, 'data'), PLANNOTATOR_BROWSER: 'none', PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9', PLANNOTATOR_INBOX_PHONES: '1' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  // One agent thread, so "← Inbox" has somewhere to return to.
  const project = join(root, 'billing');
  mkdirSync(project, { recursive: true });
  const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code', cwd: project });
  const sent = await agent.send({ project_path: project, body: 'The refund worker is ready for review.' });
  await agent.close();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  world = { root, url: started.stdout.trim(), env, context, page, errors, thread: sent.thread_id };
});

test.afterAll(async () => {
  try {
    if (!world) return;
    await world.context.close();
  } finally {
    await removeInboxScratch();
  }
});

const sidebarState = (page: Page) => page.locator('[data-collapsible]').first().getAttribute('data-state');
const sidebarCookie = async (context: BrowserContext) => (await context.cookies()).find((c) => c.name === 'plannotator-inbox-sidebar-open')?.value ?? null;

test('desktop: a focused page with a section nav; addresses, keyboard, focus, Back and Forward, and ← Inbox back to the thread with the sidebar', async () => {
  const { page, context } = world;
  await page.goto(`${world.url}#thread=${world.thread}`);
  await expect(page.locator('section.ib-pane h2.ib-subject')).toBeVisible();
  await expect.poll(() => sidebarState(page)).toBe('expanded');
  const cookieBefore = await sidebarCookie(context);

  await page.locator('.ib-setrow .ib-nav').click();
  await expect(page).toHaveURL(/#settings$/);
  await expect(page.getByRole('heading', { name: 'General', level: 1 })).toBeVisible();
  await expect.poll(() => sidebarState(page)).toBe('collapsed');
  expect(await sidebarCookie(context)).toBe(cookieBefore);
  const nav = page.getByRole('navigation', { name: 'Settings sections' });
  await expect(nav.getByRole('link')).toHaveText(['General', 'Agents', 'Devices', 'Archived', 'Storage', 'About']);
  await expect(nav.getByRole('link', { name: 'General' })).toHaveAttribute('aria-current', 'page');
  await shot(page, 'general');

  // The keyboard: Tab to a section link, Enter follows it, focus lands on the new heading.
  await nav.getByRole('link', { name: 'General' }).focus();
  await page.keyboard.press('Tab');
  await expect(nav.getByRole('link', { name: 'Agents' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#settings\/agents$/);
  await expect(page.getByRole('heading', { name: 'Agents', level: 1 })).toBeFocused();
  await expect(nav.getByRole('link', { name: 'Agents' })).toHaveAttribute('aria-current', 'page');
  await shot(page, 'agents');

  for (const [name, check] of [
    ['Devices', '[data-settings-phones]'],
    ['Archived', '[data-settings-archived]'],
    ['Storage', '[data-store-bytes]'],
    ['About', '[data-settings-about]'],
  ] as const) {
    await nav.getByRole('link', { name }).click();
    await expect(page.getByRole('heading', { name, level: 1 })).toBeFocused();
    await expect(page.locator(check).first()).toBeVisible();
    await shot(page, name.toLowerCase());
  }

  // Back and Forward walk the sections; ← Inbox ignores them and returns to the thread.
  await page.goBack();
  await expect(page).toHaveURL(/#settings\/storage$/);
  await page.goForward();
  await expect(page).toHaveURL(/#settings\/about$/);
  await page.locator('[data-settings-back]').click();
  await expect(page).toHaveURL(new RegExp(`#thread=${world.thread}$`));
  await expect.poll(() => sidebarState(page)).toBe('expanded');
  expect(await sidebarCookie(context)).toBe(cookieBefore);

  // Deep links, and an old `#settings` link.
  await page.goto('about:blank');
  await page.goto(`${world.url}#settings/devices/pair`);
  await expect(page.locator('[data-pair-flow][data-pair-step="reach"]')).toBeVisible();
  await page.goto('about:blank');
  await page.goto(`${world.url}#settings`);
  await expect(page.getByRole('heading', { name: 'General', level: 1 })).toBeVisible();
  expect(world.errors).toEqual([]);
});

test('iPhone (WebKit): the list of sections, a section with ‹ Settings, and Pair a phone from step 1 to the code', async () => {
  // The config's launch args are Chromium-only; Linux WebKit refuses them (inbox-mobile.spec.ts does the same).
  const phoneBrowser = await webkit.launch({ args: [] });
  try {
    const context = await phoneBrowser.newContext({ ...devices['iPhone 15'] });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${world.url}#settings`);
    const list = page.locator('[data-settings-list]');
    await expect(list.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await expect(list.getByRole('link')).toHaveCount(6);
    await expect(page.locator('.ib-snav')).toHaveCount(0);
    await shot(page, 'phone-1-list');

    await list.getByRole('link', { name: /Devices/ }).click();
    await expect(page).toHaveURL(/#settings\/devices$/);
    await expect(page.getByRole('heading', { name: 'Devices', level: 1 })).toBeVisible();
    const back = page.locator('.ib-sphead .ib-pback');
    await expect(back).toContainText('Settings');
    await shot(page, 'phone-2-devices');

    await page.getByRole('button', { name: 'Pair a phone' }).click();
    const flow = page.locator('[data-pair-flow]');
    await expect(flow.getByRole('heading', { name: 'How will your phone reach this computer?' })).toBeVisible();
    await shot(page, 'phone-3-pair-choose');
    await flow.getByRole('button', { name: 'Turn on Tailscale' }).click();
    await expect(flow.locator('[data-show-code]')).toHaveText('Continue to the code');
    await flow.locator('[data-show-code]').click();
    await expect(flow.locator('[data-pair-code]')).toBeVisible();
    await expect(flow.locator('[data-pair-address="tailscale"]')).toContainText(E2E_MAGIC);
    await flow.locator('[data-pair-offer]').scrollIntoViewIfNeeded();
    await shot(page, 'phone-4-pair-code');
    await flow.getByRole('button', { name: 'Cancel' }).first().click();
    await expect(page).toHaveURL(/#settings\/devices$/);
    await page.getByRole('switch', { name: 'Tailscale', exact: true }).click();
    await expect(page.getByRole('switch', { name: 'Tailscale', exact: true })).toHaveAttribute('aria-checked', 'false');

    await back.click();
    await expect(list).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await phoneBrowser.close();
  }
});
