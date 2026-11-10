/**
 * The order of the sidebar's Projects (packages/inbox/projectSort.ts), proved in
 * a real Chromium against the compiled binary under a temp HOME and data dir:
 * the default is the order the projects came in; the icon hides until the
 * header is hovered; the first press goes A to Z, then the icon goes between most
 * recent and A to Z, never back to the first order; each choice survives a real
 * reload; a new message moves its project up in most recent; a
 * phone's sheet always shows it as a 44 px target and a tap keeps the sheet open.
 *
 * Build the binary first (see inbox.spec.ts). The PNGs land in
 * .local/proof/projects-sort/ (PLANNOTATOR_E2E_PROOF_DIR names another parent).
 */

import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const builtBinary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'projects-sort');

const LONG = 'payments-platform-monorepo-checkout-service';
// The order they first write in: today's order, oldest first.
const ADDED = ['plannotator', 'acme-web', 'Zephyr', 'édition-api', 'infra', 'app2', 'app10', 'billing-svc', LONG];
const AZ = ['acme-web', 'app2', 'app10', 'billing-svc', 'édition-api', 'infra', LONG, 'plannotator', 'Zephyr'];
// acme-web, then infra, write again: the two newest. The rest by when they last wrote.
const RECENT = ['infra', 'acme-web', LONG, 'billing-svc', 'app10', 'app2', 'édition-api', 'Zephyr', 'plannotator'];

interface World {
  url: string;
  agent: SimAgent;
  paths: Map<string, string>;
  /** Each project's first thread. */
  threads: Map<string, string>;
  context: BrowserContext;
  page: Page;
}
let world: World;

const side = (page: Page) => page.getByRole('complementary', { name: 'Inbox navigation' });
const header = (scope: Locator) => scope.locator('[data-sidebar-section="projects"]');
const toggle = (scope: Locator) => scope.locator('[data-projects-sort]');
const names = (scope: Locator) => scope.locator('.ib-projs .ib-name');
const SORT_COOKIE = 'plannotator-inbox-projects-sort';
const cookie = async (page: Page) => (await page.context().cookies()).find((c) => c.name === SORT_COOKIE)?.value;

async function shot(page: Page, name: string, clip?: { x: number; y: number; width: number; height: number }): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(proofDir, `${name}-${scheme}.png`), ...(clip ? { clip } : {}) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(builtBinary), `build the binary first: ${builtBinary}`).toBe(true);
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-projects-sort-e2e-');
  const dataDir = join(root, 'data');
  const home = join(root, 'home');
  mkdirSync(home);
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_INBOX_NOTES: '0',
    PLANNOTATOR_TEST_SANDBOX: '1',
    NO_ANON_PING: '1',
  };
  const started = spawnSync(builtBinary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  // The Inbox runs on this run's own folders: its registry is under the temp data dir.
  const entry = JSON.parse(readFileSync(join(dataDir, 'inbox', 'inbox.json'), 'utf8')) as { pid: number };
  expect(entry.pid).toBeGreaterThan(0);
  const url = started.stdout.trim();
  const agent = await SimAgent.connect({ binary: builtBinary, env, name: 'Claude Code', host: 'claude-code' });
  const paths = new Map(ADDED.map((name) => [name, scratchProject(join(root, 'src'), name)]));
  const threads = new Map<string, string>();
  for (const name of ADDED) {
    const sent = await agent.send({ project_path: paths.get(name)!, subject: `Status of ${name}`, body: 'The build passed and the change is ready to read.' });
    threads.set(name, sent.thread_id as string);
    await new Promise((done) => setTimeout(done, 5));
  }
  for (const name of ['acme-web', 'infra']) {
    await agent.send({ project_path: paths.get(name)!, subject: `Follow-up on ${name}`, body: 'One more change landed after the first.' });
    await new Promise((done) => setTimeout(done, 5));
  }
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: 'light' });
  const page = await context.newPage();
  world = { url, agent, paths, threads, context, page };
});

test.afterAll(async () => {
  try {
    if (!world) return;
    await world.agent.close().catch(() => {});
    await world.context.close();
  } finally {
    await removeInboxScratch();
  }
});

test('desktop: the default is the order they came in, and the icon goes A to Z, most recent and A to Z again, across reloads', async () => {
  const { page, url } = world;
  await page.goto(url);
  const nav = side(page);
  const clip = { x: 0, y: 0, width: 640, height: 800 };
  await expect(names(nav)).toHaveText(ADDED);
  expect(await cookie(page)).toBeUndefined();

  // At rest it is not there to see; the header's hover shows it, and a press there is not the header's.
  await page.mouse.move(900, 450);
  await expect(toggle(nav)).toHaveCSS('opacity', '0');
  await shot(page, 'desktop-1-default-at-rest', clip);
  await header(nav).hover();
  await expect(toggle(nav)).toHaveCSS('opacity', '1');
  await shot(page, 'desktop-1-default-hover', clip);

  // The row is exactly the header: the gap above it is not hover, and the header keeps its 12 px above.
  const headerBox = (await header(nav).boundingBox())!;
  const projectsRow = nav.locator('.ib-secrow', { has: page.locator('[data-sidebar-section="projects"]') });
  const rowBox = (await projectsRow.boundingBox())!;
  expect([rowBox.y, rowBox.height]).toEqual([headerBox.y, headerBox.height]);
  await expect(projectsRow).toHaveCSS('margin-top', '12px');
  await page.mouse.move(headerBox.x + headerBox.width / 2, headerBox.y - 6);
  await expect(toggle(nav)).toHaveCSS('opacity', '0');

  await toggle(nav).click();
  await expect(names(nav)).toHaveText(AZ);
  await expect(header(nav)).toHaveAttribute('aria-expanded', 'true');
  expect(await cookie(page)).toBe('name');
  await page.reload();
  await expect(names(nav)).toHaveText(AZ);
  await page.mouse.move(900, 450);
  await shot(page, 'desktop-2-az-at-rest', clip);
  await toggle(nav).hover();
  await expect(page.getByText('Sorted A to Z. Sort by most recent')).toBeVisible();
  await shot(page, 'desktop-2-az-tooltip', clip);

  await toggle(nav).click();
  await expect(names(nav)).toHaveText(RECENT);
  expect(await cookie(page)).toBe('recent');
  await page.reload();
  await expect(names(nav)).toHaveText(RECENT);
  await header(nav).hover();
  await shot(page, 'desktop-3-recent-hover', clip);

  // The keyboard reaches it: focus shows it where the mouse is away.
  await page.mouse.move(900, 450);
  await header(nav).focus();
  await page.keyboard.press('Tab');
  await expect(toggle(nav)).toBeFocused();
  await expect(toggle(nav)).toHaveCSS('opacity', '1');

  // Most recent is live: a new message moves its project to the top.
  await world.agent.send({ project_path: world.paths.get('Zephyr')!, subject: 'Another one on Zephyr', body: 'A later change.' });
  await expect(names(nav).first()).toHaveText('Zephyr');

  // From most recent a press goes back to A to Z, never to the order they came in.
  await toggle(nav).click();
  await expect(names(nav)).toHaveText(AZ);
  expect(await cookie(page)).toBe('name');
  await page.reload();
  await expect(names(nav)).toHaveText(AZ);

  // A closed section has no toggle.
  await header(nav).click();
  await expect(toggle(nav)).toHaveCount(0);
  await header(nav).click();
  await expect(toggle(nav)).toHaveCount(1);
});

test("a phone: the sheet always shows it, a 44 px target beside the heading's fold area, and a tap keeps the sheet open", async () => {
  const { page, url } = world;
  // A browser that has not chosen, as a phone decides on its own.
  await page.context().clearCookies({ name: SORT_COOKIE });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(url);
  await page.locator('.ib-lhead').getByRole('button', { name: 'Toggle Sidebar' }).click();
  const sheet = page.getByRole('dialog');
  // Away from the row, as a finger is: nothing hovers on a phone.
  const away = () => page.mouse.move(100, 680);
  await expect(toggle(sheet)).toBeVisible();
  await expect(names(sheet)).toHaveText(ADDED);
  await expect(toggle(sheet)).toHaveCSS('opacity', '1');
  const box = (await toggle(sheet).boundingBox())!;
  expect([box.width, box.height]).toEqual([44, 44]);
  // Beside the heading, never over it (approval "inbox-phone-sidebar-sheet"): a tap on the heading only folds the section.
  const fold = (await header(sheet).boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(fold.x + fold.width);
  await away();
  await shot(page, 'phone-1-default');

  await toggle(sheet).click();
  await expect(sheet).toBeVisible();
  await expect(names(sheet)).toHaveText(AZ);
  await away();
  await shot(page, 'phone-2-az');

  await toggle(sheet).click();
  await expect(sheet).toBeVisible();
  await expect(names(sheet).first()).toHaveText('Zephyr');
  await away();
  await shot(page, 'phone-3-recent');

  await toggle(sheet).click();
  await expect(sheet).toBeVisible();
  await expect(names(sheet)).toHaveText(AZ);
});

test('most recent: a row in view moving up leaves the sidebar scrolled where it was', async () => {
  const { context, page, url } = world;
  await context.addCookies([{ name: SORT_COOKIE, value: 'recent', url }]);
  await page.setViewportSize({ width: 1280, height: 480 });
  await page.goto(url);
  const nav = side(page);
  const scroller = nav.locator('.ib-sidescroll');
  await expect(names(nav)).toHaveCount(ADDED.length);
  // Scrolled to the end: the first row fully in view is the one scroll anchoring would pick and follow.
  const { top, name } = await scroller.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    const box = el.getBoundingClientRect();
    const row = [...el.querySelectorAll('.ib-projs .ib-name')].find((node) => node.getBoundingClientRect().top >= box.top)!;
    return { top: el.scrollTop, name: row.textContent! };
  });
  expect(top).toBeGreaterThan(0);
  expect(await names(nav).first().textContent()).not.toBe(name);
  await world.agent.send({ project_path: world.paths.get(name)!, subject: `Newer on ${name}`, body: 'A later change.' });
  await expect(names(nav).first()).toHaveText(name);
  expect(await scroller.evaluate((el) => el.scrollTop)).toBe(top);
});

test('most recent counts a snoozed thread, which is in the list but in no section', async () => {
  const { context, page, url } = world;
  await context.addCookies([{ name: SORT_COOKIE, value: 'recent', url }]);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(url);
  const nav = side(page);
  await expect(names(nav)).toHaveCount(ADDED.length);
  // Its project has this thread only, and newer ones than the last row: with no activity read from it, it would fall to the bottom.
  const before = await names(nav).allTextContents();
  expect(before.indexOf('app10')).toBeLessThan(before.length - 1);
  await page.evaluate(
    async ([threadId, until]) => {
      const list = (await (await fetch('/api/inbox/threads?archived=exclude')).json()) as { serverSession: string };
      const res = await fetch(`/api/inbox/threads/${threadId}/snooze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serverSession: list.serverSession, until }) });
      if (!res.ok) throw new Error(`snooze ${res.status}`);
    },
    [world.threads.get('app10')!, new Date(Date.now() + 3_600_000).toISOString()] as const,
  );
  await page.reload();
  await expect(page.locator('[data-section-id="snoozed"]')).toBeVisible();
  await expect(names(nav)).toHaveText(before);
});
