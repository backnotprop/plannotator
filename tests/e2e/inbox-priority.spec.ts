/**
 * The person's Priority, proved against the compiled binary under a temp data
 * dir, with an agent writing through `plannotator inbox mcp`
 * (scripts/inbox-sim.ts):
 *
 * - desktop (Chromium, 1440 wide), light and dark: a right-click's Add to
 *   Priority moves the row into a Priority group drawn first, with its toast;
 *   Undo puts it back where it was; Remove from Priority says where it went
 *   back to, and its Undo brings it back;
 * - an iPhone 15 (WebKit), light and dark: a finger held on a row opens the
 *   sheet, its Add to Priority moves the row, and the toast's Undo takes it out.
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-priority.spec.ts`.
 * PNGs land in PLANNOTATOR_PRIORITY_SHOTS (default /tmp/priority-shots).
 */

import { devices, expect, test, webkit, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shots = resolve(process.env.PLANNOTATOR_PRIORITY_SHOTS ?? '/tmp/priority-shots');

const ASK = ['Two options, both under 50 ms.', '', ':::question', 'Which search index?', '', '- [ ] Pagefind', '- [ ] Orama', ':::'].join('\n');

let world: { url: string; agent: SimAgent; ask: string; news: string[] };

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  mkdirSync(shots, { recursive: true });
  const root = inboxScratch('plannotator-inbox-priority-e2e-');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: join(root, 'data'), PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const path = scratchProject(join(root, 'src'), 'docs-site');
  const send = async (subject: string, body: string, session: string) =>
    String((await agent.send({ project_path: path, subject, body, agent_session: session } as Parameters<SimAgent['send']>[0])).thread_id);
  const news = [];
  for (const [i, subject] of ['Release notes draft', 'Install page links fixed', 'Changelog drafted'].entries()) news.push(await send(subject, `${subject}. Nothing to answer.`, `ses_priority_${i}`));
  const ask = await send('Which search index should the docs use?', ASK, 'ses_priority_ask');
  world = { url: started.stdout.trim().replace(/\/$/, ''), agent, ask, news };
});

test.afterAll(async () => {
  try {
    await world?.agent.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

const body = (page: Page) => page.locator('.ib-listcol .ib-lbody');
const row = (page: Page, id: string) => body(page).locator(`[data-thread-id="${id}"]`);
const group = (page: Page, id: string) => body(page).locator(`.ib-group[data-section-id="${id}"]`);
const menu = (page: Page) => page.locator('[data-row-menu]');
const toast = (page: Page) => page.locator('[data-inbox-toast]');

async function priorityOnServer(page: Page, id: string) {
  const model = (await (await page.request.get(`${world.url}/api/inbox/threads?archived=exclude`)).json()) as { sections: { threads: { thread_id: string; priority?: { at: string } | null }[] }[] };
  return model.sections.flatMap((s) => s.threads).find((r) => r.thread_id === id)?.priority ?? null;
}

for (const scheme of ['light', 'dark'] as const)
  test(`desktop (${scheme}): right-click Add to Priority, Undo, then Remove from Priority and its Undo`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(world.url);
    await expect(row(page, world.ask)).toBeVisible();
    await expect(group(page, 'priority')).toHaveCount(0);

    await row(page, world.ask).click({ button: 'right' });
    await expect(menu(page).getByRole('menuitem').nth(1)).toHaveText('Add to Priority');
    await page.screenshot({ path: join(shots, `desktop-${scheme}-menu.png`) });
    await menu(page).locator('[data-row-action="priority-add"]').click();
    await expect(group(page, 'priority').locator(`[data-thread-id="${world.ask}"]`)).toBeVisible();
    await expect(body(page).locator('.ib-group').first()).toHaveAttribute('data-section-id', 'priority');
    await expect(toast(page)).toContainText('Added to Priority');
    await expect(toast(page)).toContainText('“Which search index should the docs use?”');
    await page.screenshot({ path: join(shots, `desktop-${scheme}-added.png`) });

    await toast(page).locator('[data-toast-undo]').click();
    await expect(group(page, 'priority')).toHaveCount(0);
    await expect(group(page, 'waiting').locator(`[data-thread-id="${world.ask}"]`)).toBeVisible();
    expect(await priorityOnServer(page, world.ask)).toBeNull();

    // Add again, then Remove: the toast names where the row went back to; Undo keeps the add's first time.
    await row(page, world.ask).click({ button: 'right' });
    await menu(page).locator('[data-row-action="priority-add"]').click();
    await expect(group(page, 'priority').locator(`[data-thread-id="${world.ask}"]`)).toBeVisible();
    const first = (await priorityOnServer(page, world.ask))!.at;
    await row(page, world.ask).click({ button: 'right' });
    await expect(menu(page).getByRole('menuitem').nth(1)).toHaveText('Remove from Priority');
    await menu(page).locator('[data-row-action="priority-remove"]').click();
    await expect(toast(page)).toContainText('Removed from Priority');
    await expect(toast(page)).toContainText('Back in Waiting on you');
    await expect(group(page, 'waiting').locator(`[data-thread-id="${world.ask}"]`)).toBeVisible();
    await page.screenshot({ path: join(shots, `desktop-${scheme}-removed.png`) });
    await toast(page).locator('[data-toast-undo]').click();
    await expect(group(page, 'priority').locator(`[data-thread-id="${world.ask}"]`)).toBeVisible();
    expect((await priorityOnServer(page, world.ask))!.at).toBe(first);

    // Leave the world as it began for the next run.
    await row(page, world.ask).click({ button: 'right' });
    await menu(page).locator('[data-row-action="priority-remove"]').click();
    await expect(group(page, 'priority')).toHaveCount(0);
    expect(errors).toEqual([]);
    await context.close();
  });

for (const scheme of ['light', 'dark'] as const)
  test(`iPhone 15 (WebKit, ${scheme}): a held row's sheet adds it to Priority; the toast's Undo takes it out`, async () => {
    const { defaultBrowserType: _ignored, ...device } = devices['iPhone 15'];
    // (WebKit launches without the config's Chromium flags, which Linux WebKit exits on.)
    const browser = await webkit.launch({ args: [] });
    try {
      const context = await browser.newContext({ ...device, colorScheme: scheme });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(world.url);
      const target = world.news[0]!;
      await expect(row(page, target)).toBeVisible();

      // The hold, as iOS sends its touch events to the page (WebKit has no touch channel to drive).
      const box = (await row(page, target).boundingBox())!;
      await page.evaluate(
        ({ x, y }) => {
          const el = document.elementFromPoint(x, y)!;
          const point = { identifier: 1, clientX: x, clientY: y, pageX: x, pageY: y, target: el };
          const start = new Event('touchstart', { bubbles: true, cancelable: true, composed: true });
          Object.defineProperty(start, 'touches', { value: [point] });
          Object.defineProperty(start, 'changedTouches', { value: [point] });
          el.dispatchEvent(start);
          (window as unknown as { __held: Element }).__held = el;
        },
        { x: box.x + box.width / 2, y: box.y + box.height / 2 },
      );
      await page.waitForTimeout(700);
      await expect(page.locator('.ib-pm-pos[data-phone] [data-row-menu]')).toBeVisible();
      await page.evaluate(() => {
        const el = (window as unknown as { __held: Element }).__held;
        const end = new Event('touchend', { bubbles: true, cancelable: true, composed: true });
        Object.defineProperty(end, 'touches', { value: [] });
        Object.defineProperty(end, 'changedTouches', { value: [{ identifier: 1, target: el }] });
        el.dispatchEvent(end);
      });
      await page.waitForTimeout(500);
      await expect(menu(page).locator('[data-row-action="priority-add"]')).toHaveText('Add to Priority');
      await page.screenshot({ path: join(shots, `iphone-${scheme}-sheet.png`) });

      await menu(page).locator('[data-row-action="priority-add"]').tap();
      await expect(group(page, 'priority').locator(`[data-thread-id="${target}"]`)).toBeVisible();
      await expect(toast(page)).toContainText('Added to Priority');
      await page.screenshot({ path: join(shots, `iphone-${scheme}-added.png`) });
      await toast(page).locator('[data-toast-undo]').tap();
      await expect(group(page, 'priority')).toHaveCount(0);
      expect(await priorityOnServer(page, target)).toBeNull();
      expect(errors).toEqual([]);
      await context.close();
    } finally {
      await browser.close();
    }
  });
