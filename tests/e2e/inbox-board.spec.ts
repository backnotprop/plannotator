/**
 * The Board (approval "inbox-board", step 2), in a real browser against the
 * compiled binary. The store is seeded before the Inbox starts
 * (tests/helpers/inbox-board-world.ts: every column, real ages, long titles
 * and long "You:" lines, the Icebox, Dropped), and an agent drops cards live
 * through `plannotator inbox mcp`'s `card` tool (scripts/inbox-sim.ts):
 *
 *  - the five lanes and the header at 1440 and 1280, light and dark; each
 *    card's title and line wrap and clamp at two lines, the age on its own
 *    line; the whole text in a component tooltip only while clamped; a lane
 *    with many cards scrolls on its own;
 *  - "N dropped by an agent" with each reason, Restore in one click, Got it;
 *  - the open card: threads, PRs, Move to, Pause and its Undo;
 *  - the Icebox page with Dropped (opening it clears the notice);
 *  - a phone (390 px): the stacked lanes, a lane that folds, the open card and
 *    the Icebox page.
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 * PNGs land in PLANNOTATOR_BOARD_SHOTS, else .local/proof/board/.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shots = resolve(process.env.PLANNOTATOR_BOARD_SHOTS ?? join(repo, '.local/proof/board'));

interface World {
  url: string;
  ids: Record<string, string>;
  projects: Record<string, string>;
  agent: SimAgent;
  env: Record<string, string>;
}
let world: World;

test.describe.configure({ mode: 'serial' });

const shot = (page: Page, name: string) => page.screenshot({ path: join(shots, `${name}.png`) });

async function open(browser: Browser, options: { scheme: 'light' | 'dark'; phone?: boolean }): Promise<{ context: BrowserContext; page: Page; errors: string[] }> {
  const context = await browser.newContext(
    options.phone
      ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: options.scheme }
      : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: options.scheme },
  );
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return { context, page, errors };
}

/** Nothing on the page wider than the window, and no card's text drawn outside its card. */
async function expectNoSpill(page: Page) {
  const spill = await page.evaluate(() => {
    const out: string[] = [];
    const width = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth > width + 1) out.push(`page ${document.documentElement.scrollWidth} > ${width}`);
    for (const card of document.querySelectorAll<HTMLElement>('.ib-bcard')) {
      const box = card.getBoundingClientRect();
      for (const part of card.querySelectorAll<HTMLElement>('.ib-bcard-t, .ib-bcard-l, .ib-bcard-age')) {
        const r = part.getBoundingClientRect();
        if (r.right > box.right + 0.5 || r.left < box.left - 0.5) out.push(`${part.className} of ${card.dataset.cardId}`);
      }
    }
    return out;
  });
  expect(spill).toEqual([]);
}

/**
 * Each card's title and line wrap and clamp at two lines (never cut to one), and its age sits on a line of its
 * own under them, never beside the words. A long "You:" line shows at least a full line of words.
 */
async function expectCardText(page: Page) {
  const bad = await page.evaluate(() => {
    const out: string[] = [];
    for (const card of document.querySelectorAll<HTMLElement>('.ib-bcard')) {
      for (const part of card.querySelectorAll<HTMLElement>('.ib-bcard-t, .ib-bcard-l')) {
        const lines = Math.round(part.getBoundingClientRect().height / parseFloat(getComputedStyle(part).lineHeight));
        if (lines > 2) out.push(`${card.dataset.cardId} ${part.className}: ${lines} lines`);
        if (getComputedStyle(part).whiteSpace === 'nowrap') out.push(`${card.dataset.cardId} ${part.className}: one line`);
      }
      const age = card.querySelector<HTMLElement>('.ib-bcard-age')!.getBoundingClientRect();
      for (const part of card.querySelectorAll<HTMLElement>('.ib-bcard-t, .ib-bcard-l')) {
        if (age.top < part.getBoundingClientRect().bottom - 0.5) out.push(`${card.dataset.cardId}: the age beside ${part.className}`);
      }
    }
    return out;
  });
  expect(bad).toEqual([]);
}

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(shots, { recursive: true, force: true });
  mkdirSync(shots, { recursive: true });
  const root = inboxScratch('plannotator-inbox-board-e2e-');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: join(root, 'data'), PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const seeded = spawnSync('bun', [join(repo, 'tests/helpers/inbox-board-world.ts'), env.PLANNOTATOR_DATA_DIR, join(root, 'src')], { env: { ...env, TMPDIR: process.env.TMPDIR ?? '' }, encoding: 'utf8', timeout: 60_000 });
  expect(seeded.status, seeded.stderr).toBe(0);
  const { ids, projects } = JSON.parse(seeded.stdout) as { ids: Record<string, string>; projects: Record<string, string> };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const agent = await SimAgent.connect({ binary, env, name: 'OpenCode', host: 'opencode', cwd: projects.machine });
  world = { url: started.stdout.trim(), ids, projects, agent, env };
});

test.afterAll(async () => {
  try {
    await world?.agent.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

test('the Board at 1440: five lanes, two lines a card, last-heard ages, no amber; an agent drops a card live and the notice says why', async ({ browser }) => {
  // An agent drops a card through the real tool: it reaches the person with its reason.
  await world.agent.card({ op: 'drop', project_path: world.projects.machine, card_id: world.ids.video, reason: 'The drag-drop change was reverted, so there is nothing to film yet' });
  for (const scheme of ['light', 'dark'] as const) {
    const { context, page, errors } = await open(browser, { scheme });
    await page.goto(`${world.url}#board`);
    await expect(page.locator('.ib-lane-l')).toHaveText(['Asked', 'Designing', 'Your look', 'Building', 'Your review']);
    await expect(page.locator('[data-board-sum]')).toHaveText('15 in flight · 8 on you');
    await expect(page.locator('[data-board-link="shipped"]')).toHaveText('Shipped 3');
    await expect(page.locator('[data-board-link="icebox"]')).toHaveText('Icebox 5');
    const portless = page.locator(`.ib-bcard[data-card-id="${world.ids.portless}"]`);
    await expect(portless.locator('.ib-bcard-l')).toHaveText(/^You: Pick a dialog/);
    await expect(portless.locator('[data-card-age]')).toHaveText('4d ago');
    await expectCardText(page);
    await expectNoSpill(page);
    const notice = page.locator('[data-drop-notice]');
    await expect(notice.locator('h2')).toHaveText('3 cards dropped by an agent');
    await expect(notice.locator(`[data-drop-card="${world.ids.video}"]`)).toContainText('OpenCode: The drag-drop change was reverted');
    await shot(page, `board-1440-${scheme}`);
    await notice.screenshot({ path: join(shots, `agent-drop-notice-1440-${scheme}.png`) });
    expect(errors).toEqual([]);
    await context.close();
  }
});

test('the open card at 1440: threads and PRs; Move to; Pause, said in the card, and Take out', async ({ browser }) => {
  for (const scheme of ['light', 'dark'] as const) {
    const { context, page, errors } = await open(browser, { scheme });
    await page.goto(`${world.url}#board`);
    await page.locator(`.ib-bcard[data-card-id="${world.ids.explorer}"]`).click();
    const card = page.locator('[data-open-card]');
    await expect(card.locator('h2')).toHaveText('Code review explorer (4 stacked PRs and a sidebar)');
    await expect(card.locator('[data-card-line]')).toHaveText(/^You: Merge the stack/);
    await expect(card.locator('[data-card-thread]')).toContainText('The explorer stack is ready for your look');
    await expect(card.locator('[data-card-pr]')).toHaveCount(4);
    await expect(card.locator('[data-card-move="your_review"]')).toHaveAttribute('aria-pressed', 'true');
    await shot(page, `open-card-1440-${scheme}`);
    expect(errors).toEqual([]);
    await context.close();
  }
  // The moves, on a card of the agents' lanes (its last word survives a move; "You:" would not).
  const { context, page, errors } = await open(browser, { scheme: 'light' });
  await page.goto(`${world.url}#board&card=${world.ids.vite}`);
  const card = page.locator('[data-open-card]');
  await card.locator('[data-card-move="designing"]').click();
  await expect(card.locator('[data-card-move="designing"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(card.locator('[data-card-note]')).toHaveText('Moved to Designing.');
  await card.locator('[data-card-move="building"]').click();
  await expect(card.locator('[data-card-move="building"]')).toHaveAttribute('aria-pressed', 'true');
  await card.locator('[data-card-icebox]').click();
  await expect(card.locator('[data-card-state="icebox"]')).toBeVisible();
  // The card says what happened, and its own Take out undoes it (a toast under the modal could not be reached).
  await expect(card.locator('[data-card-note]')).toHaveText('Paused: it is in the Icebox. Take out puts it back.');
  await shot(page, 'open-card-paused-1440-light');
  await card.locator('[data-card-restore]').click();
  await expect(card.locator('[data-card-move="building"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(card.locator('[data-card-note]')).toHaveText('Back in Building.');
  await card.locator('[data-card-close]').click();
  await expect(page.locator(`[data-lane="building"] .ib-bcard[data-card-id="${world.ids.vite}"]`)).toBeVisible();
  expect(errors).toEqual([]);
  await context.close();
});

test('a phone: the stacked lanes, the notice, a lane that folds, the open card', async ({ browser }) => {
  for (const scheme of ['light', 'dark'] as const) {
    const { context, page, errors } = await open(browser, { scheme, phone: true });
    await page.goto(`${world.url}#board`);
    await expect(page.locator('[data-lane="asked"] .ib-lane-fold')).toBeVisible();
    await expect(page.locator('[data-drop-notice] h2')).toHaveText('3 cards dropped by an agent');
    await expectNoSpill(page);
    await shot(page, `board-phone-${scheme}`);
    await page.locator('[data-drop-notice]').screenshot({ path: join(shots, `agent-drop-notice-phone-${scheme}.png`) });
    // Every lane in order, then Shipped and the Icebox at the end.
    await expect(page.locator('.ib-lane-l')).toHaveText(['Asked', 'Designing', 'Your look', 'Building', 'Your review']);
    await expect(page.locator('.ib-blinks-foot .ib-blink')).toHaveCount(2);
    if (scheme === 'light') {
      const fold = page.locator('[data-lane="asked"] .ib-lane-fold');
      await fold.click();
      await expect(fold).toHaveAttribute('aria-expanded', 'false');
      await expect(page.locator('[data-lane="asked"] .ib-bcard')).toHaveCount(0);
      await fold.click();
    }
    await page.locator(`.ib-bcard[data-card-id="${world.ids.portless}"]`).click();
    await expect(page.locator('[data-open-card] h2')).toHaveText('One fixed address for the Inbox (portless)');
    await shot(page, `open-card-phone-${scheme}`);
    expect(errors).toEqual([]);
    await context.close();
  }
});

test('the notice: Restore in one click puts a card back where it was', async ({ browser }) => {
  const { context, page } = await open(browser, { scheme: 'light' });
  await page.goto(`${world.url}#board`);
  await page.locator(`[data-restore="${world.ids.video}"]`).click();
  await expect(page.locator(`[data-lane="asked"] .ib-bcard[data-card-id="${world.ids.video}"]`)).toBeVisible();
  await expect(page.locator('[data-drop-notice] h2')).toHaveText('2 cards dropped by an agent');
  await context.close();
});

test('the Icebox page lists Dropped with reasons; opening it is looking, so the notice goes', async ({ browser }) => {
  for (const [scheme, phone] of [['light', false], ['dark', false], ['light', true], ['dark', true]] as const) {
    const { context, page, errors } = await open(browser, { scheme, phone });
    await page.goto(`${world.url}#board=icebox`);
    const dropped = page.locator('[data-board-group="dropped"]');
    await expect(dropped.locator('h2')).toHaveText('Dropped 3');
    await expect(dropped).toContainText('Not needed: PR 1120 brought the cursors back');
    await expect(dropped).toContainText('Dropped by you');
    await expect(page.locator('[data-board-group="icebox"]')).toContainText('Triage #1786 and #1787');
    await shot(page, `icebox-${phone ? 'phone' : '1440'}-${scheme}`);
    expect(errors).toEqual([]);
    await context.close();
  }
  const { context, page } = await open(browser, { scheme: 'light' });
  await page.goto(`${world.url}#board`);
  await expect(page.locator('.ib-lane-l').first()).toBeVisible();
  await expect(page.locator('[data-drop-notice]')).toHaveCount(0);
  await context.close();
});

test('at 1280 the words still read: two lines each, the whole text in a tooltip only while clamped (never a native title)', async ({ browser }) => {
  for (const scheme of ['light', 'dark'] as const) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: scheme });
    const page = await context.newPage();
    await page.goto(`${world.url}#board`);
    await expect(page.locator('.ib-lane-l')).toHaveCount(5);
    await expectCardText(page);
    await expectNoSpill(page);
    await shot(page, `board-1280-${scheme}`);
    if (scheme === 'light') {
      // No native title on any card.
      expect(await page.locator('.ib-bcard [title], .ib-bcard[title]').count()).toBe(0);
      // A clamped title: its whole text in the component tooltip.
      const blend = page.locator(`.ib-bcard[data-card-id="${world.ids.blend}"]`);
      expect(await blend.locator('.ib-bcard-t').evaluate((el) => el.scrollHeight > el.clientHeight + 1)).toBe(true);
      await blend.locator('.ib-bcard-t').hover();
      await expect(page.locator('[data-pn-tooltip]')).toHaveText('Landing: a third style blend from interfere.com with scroll-faded screenshots, real popovers and stacked guided plans');
      await page.mouse.move(5, 5);
      await expect(page.locator('[data-pn-tooltip]')).toHaveCount(0);
      // A short title that fits: no tooltip.
      await page.locator(`.ib-bcard[data-card-id="${world.ids.caret}"] .ib-bcard-t`).hover();
      await page.waitForTimeout(500);
      await expect(page.locator('[data-pn-tooltip]')).toHaveCount(0);
    }
    await context.close();
  }
});

test('a lane with many cards scrolls on its own; the page does not', async ({ browser }) => {
  for (let i = 1; i <= 14; i++) {
    await world.agent.card({ op: 'create', project_path: world.projects.machine, title: `Follow-up ${i}: split the drag-drop work into smaller pieces so each one lands on its own`, column: 'building', say: `Piece ${i} of 14 is in a lane; the PR follows once the tests are green on the runner` });
  }
  const { context, page } = await open(browser, { scheme: 'light' });
  await page.goto(`${world.url}#board`);
  const cards = page.locator('[data-lane="building"] .ib-lane-cards');
  await expect(cards.locator('.ib-bcard')).toHaveCount(17);
  const box = await cards.evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
  expect(box.scroll).toBeGreaterThan(box.client);
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1)).toBe(true);
  await cards.evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect(cards.locator('.ib-bcard').last()).toBeInViewport();
  await expectCardText(page);
  await shot(page, 'board-1440-many-light');
  await context.close();
});
