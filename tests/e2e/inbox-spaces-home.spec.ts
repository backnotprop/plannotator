/**
 * The Spaces home (approval "plans-home"): with Plans on, the sidebar's Spaces row opens the home; "Now" holds the
 * plan that waits on the person, "Recent" the rest; the list view is kept for the person (config.json, so a reload
 * opens on it); a card's pin lists the space in the sidebar; on a touch screen the rows show no pin at rest and a
 * long-press opens a row's menu, which pins it; a card opens its plan page, whose crumbs say Spaces. An
 * HTML page's face moves nothing in a real browser: its CSS animation computes to none (approval "plans-home": "Idle
 * page: nothing moves").
 * Real browser, compiled binary, temp PLANNOTATOR_DATA_DIR and HOME; the plan library is seeded with the store before
 * the Inbox starts (Plans on in config.json).
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-spaces-home.spec.ts`.
 * PNGs land in .local/proof/spaces-home/.
 */

import { expect, test } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { NO_ACTOR } from '../../packages/core/plans';
import { createPlanStore } from '../../packages/shared/plans/store';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'spaces-home');

test.afterAll(async () => {
  await removeInboxScratch();
});

test('the Spaces home: Now and Recent, the list kept for the person, a pin in the sidebar, a card opens its plan', async ({ browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-spaces-home-e2e-');
  const dataDir = join(root, 'data');
  const configFile = join(dataDir, 'config.json');
  writeFileSync(configFile, JSON.stringify({ ...JSON.parse(readFileSync(configFile, 'utf8')), inboxPlans: true }));
  const store = createPlanStore({ dataDir });
  // Times from the run's own clock, all within Now's 3 days (a plan that waits is in Now only while its version is new):
  // a higher `slot` is newer, an hour apart; `later` minutes after it.
  const at = (slot: number, later = 0) => new Date(Date.now() - (20 - slot) * 3_600_000 + later * 60_000).toISOString();
  const seed = (name: string, project: string, slot: number, decided: boolean) => {
    const { plan, document } = store.createPlan({ name, project_name: project, created_at: at(slot), document: { title: name } });
    const v1 = store.addVersion(plan.id, document.id, { bytes: new TextEncoder().encode(`# ${name}\n\n## Context\n\nWhy ${name.toLowerCase()} now.\n`), committed_at: at(slot), source: 'plan-review', author_via: 'plan-review' });
    if (decided) store.addEvent(plan.id, { ...NO_ACTOR, author_via: 'person', kind: 'decision', at: at(slot, 1), subject: { document_id: document.id, version_number: 1 }, decision: { document_id: document.id, version: v1.version, version_number: 1, decision: 'approved', at: at(slot, 1), feedback: null, feedback_record: null, snapshot: null }, legacy: null });
    return plan.id;
  };
  const waiting = seed('Rate limits per API key', 'ledger', 14, false);
  // An HTML main page whose own CSS animates (and says so with !important): its face must not move.
  const mockup = store.createPlan({ name: 'Pricing page mockup', project_name: 'ledger', created_at: at(13), document: { title: 'Pricing page mockup', kind: 'html' } });
  const spinning = '<style>.spin { animation: spin 1s linear infinite !important; } @keyframes spin { to { transform: rotate(1turn); } }</style><h1>Pricing</h1><div class="spin" style="animation: spin 2s infinite">Loading</div>';
  store.addVersion(mockup.plan.id, mockup.document.id, { bytes: new TextEncoder().encode(spinning), committed_at: at(13), source: 'plan-review', author_via: 'plan-review' });
  const done = ['Nightly export in batches', 'Checkout on one page', 'Sessions in Redis', 'Offline drafts'].map((name, i) => seed(name, i % 2 ? 'ledger' : 'field-notes', 10 + i, true));

  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9', PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  try {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(url);
    const nav = page.locator('[data-plans-nav]');
    await expect(nav).toContainText('Spaces');
    await nav.click();
    const home = page.locator('[data-spaces-home]');
    await expect(home.locator('h1')).toHaveText('What do you want to plan?');
    await expect(home.locator('[data-spaces-local]')).toHaveText('On this computer');
    const now = home.locator('[data-spaces-section="now"] [data-space]');
    await expect(now).toHaveCount(2);
    await expect(now.first()).toHaveAttribute('data-space', waiting);
    await expect(now.first().locator('[data-frame-card-line]')).toHaveText('Your move');
    await expect(home.locator('[data-spaces-section="recent"] [data-space]')).toHaveCount(done.length);
    // The face is the plan's own top, its title not said twice.
    await expect(now.first().locator('[data-space-face="document"]')).toContainText('Why rate limits per api key now.');
    await expect(now.first().locator('[data-space-face="document"]')).not.toContainText('Rate limits per API key');
    // The HTML page's face: drawn, and still (its animation, the page's own with !important and inline, is none).
    const frameEl = home.locator(`[data-space="${mockup.plan.id}"] iframe`);
    await expect(frameEl).toHaveCount(1);
    const frame = await (await frameEl.elementHandle())!.contentFrame();
    await expect.poll(() => frame!.evaluate(() => getComputedStyle(document.querySelector('.spin')!).animationName)).toBe('none');
    // What would loop forever (its loading ring) is not drawn stopped mid-turn: a still page looks finished.
    await expect.poll(() => frame!.evaluate(() => getComputedStyle(document.querySelector('.spin')!).visibility)).toBe('hidden');
    await page.screenshot({ path: join(proofDir, 'cards-light.png') });

    // The list view, kept for the person: config.json says so and a reload opens on it.
    await home.locator('[data-spaces-view-pick="list"]').click();
    await expect(home).toHaveAttribute('data-spaces-view', 'list');
    await expect.poll(() => JSON.parse(readFileSync(configFile, 'utf8')).inboxSpacesView).toBe('list');
    await page.reload();
    await expect(page.locator('[data-spaces-home]')).toHaveAttribute('data-spaces-view', 'list');
    await page.screenshot({ path: join(proofDir, 'list-light.png') });

    // A pin: the space is listed under Spaces in the sidebar, and kept in the library.
    const card = page.locator(`[data-space="${done[0]}"]`);
    await card.hover();
    await card.locator('[data-space-pin-toggle]').click();
    await expect(page.locator(`[data-space-pins] [data-pinned-space="${done[0]}"]`)).toBeVisible();
    await expect.poll(() => createPlanStore({ dataDir }).pins()).toEqual([done[0]]);
    await page.screenshot({ path: join(proofDir, 'pinned-light.png') });

    // A touch screen: the rows show no pin at rest (the card's `actionAtRest="never"`), a pinned row keeps the pin after
    // its title, and a long-press (Base UI's 500 ms) opens the row's menu, which pins it.
    const touchContext = await browser.newContext({ viewport: { width: 820, height: 1180 }, hasTouch: true, isMobile: true, colorScheme: 'light' });
    try {
      const touchPage = await touchContext.newPage();
      touchPage.on('pageerror', (error) => errors.push(error.message));
      await touchPage.goto(`${url}#plans`);
      expect(await touchPage.evaluate(() => matchMedia('(hover: none)').matches)).toBe(true);
      await expect(touchPage.locator('[data-spaces-home]')).toHaveAttribute('data-spaces-view', 'list');
      const kept = touchPage.locator(`[data-space="${done[0]}"]`);
      const loose = touchPage.locator(`[data-space="${done[1]}"]`);
      await expect(kept.locator('a [data-frame-card-pinned-mark]')).toBeVisible();
      for (const row of [kept, loose]) {
        const pin = row.locator('[data-space-pin-toggle]');
        await expect(pin).toHaveCount(1);
        expect(await pin.evaluate((el) => { const box = el.closest('[data-frame-card-action]') ?? el; return [getComputedStyle(box).opacity, getComputedStyle(box).pointerEvents]; })).toEqual(['0', 'none']);
      }
      const titleEl = loose.locator('[data-frame-card-title]');
      await titleEl.scrollIntoViewIfNeeded({ timeout: 15_000 });
      const title = await titleEl.boundingBox({ timeout: 15_000 });
      const cdp = await touchContext.newCDPSession(touchPage);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: title!.x + 20, y: title!.y + title!.height / 2 }] });
      await touchPage.waitForTimeout(700);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      const item = touchPage.locator(`[data-space-menu="${done[1]}"] [data-space-menu-pin="pin"]`);
      await expect(item).toBeVisible();
      await touchPage.screenshot({ path: join(proofDir, 'touch-menu-light.png') });
      await item.tap({ timeout: 15_000 });
      await expect.poll(() => createPlanStore({ dataDir }).pins()).toEqual([done[0], done[1]]);
      await expect(loose.locator('a [data-frame-card-pinned-mark]')).toBeVisible();
      expect(await touchPage.evaluate(() => location.hash)).toBe('#plans');
    } finally {
      await touchContext.close();
    }

    // A card opens its plan page; its crumbs say Spaces.
    await page.locator(`[data-space="${waiting}"] a`).click();
    await expect(page.locator(`[data-plan-page="${waiting}"]`)).toBeVisible();
    await expect(page.locator('[data-page-header] [data-breadcrumb-root]')).toHaveText('Spaces');
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
