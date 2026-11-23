/**
 * The plan page's Share panel, "B1 · Three lines" (approval "inbox-share-panel-b1"): every state is a status line, at
 * most two lines about the space, and one row of actions with one main button at most; the address is never drawn,
 * Copy link is a button and one small mark at the end of the status line opens the space. On a phone the panel is the
 * Inbox's own bottom sheet, with 44 px targets; on a desktop the open mark is 28 px.
 *
 * Real browser, compiled binary, temp PLANNOTATOR_DATA_DIR and HOME, Plans and Share this space on in config.json.
 * The share's status (`GET /api/plans/:id/share`) is answered in the browser by a stand-in per state, so nothing here
 * reaches a Spaces host and no share runs; nothing is pressed that would send one.
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-share-panel.spec.ts`.
 * PNGs (`b1-<state>-<phone|desktop>-<light|dark>.png`) land in .local/proof/share-panel/.
 */

import { expect, test, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { SpaceShareDetails, SpaceShareStatus } from '../../packages/core/space-share';
import { createPlanStore } from '../../packages/shared/plans/store';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'share-panel');

const LINK = 'https://spaces.example/s/rate-limiting-7f3k9q';
const details: SpaceShareDetails = { pages: 4, files: 3, comments: 1, approval: 4, not: { sent_comments: 3, pictures: 2, original_dates: true, files_over: 0, pages_over: 0, long_comments: 0, older_approvals: 0 } };
const status = (more: Partial<SpaceShareStatus> = {}): SpaceShareStatus => ({ phase: 'none', progress: null, waiting: null, link: null, shared_once: false, kept: false, access: 'edit', signed_in: false, who: null, keep: null, mode: 'all', versions: 4, changes: 0, stopped_pages: [], details: { all: details, newest: details }, ...more });
const shared = (more: Partial<SpaceShareStatus> = {}) => status({ phase: 'shared', link: LINK, shared_once: true, ...more });

/** The eight states drawn in the approved sheets: their status line, their actions in order, and the main one. */
const STATES: { name: string; s: SpaceShareStatus; title: string; actions: string[]; primary: string | null; open: boolean }[] = [
  { name: 'first', s: status(), title: 'Share', actions: ['share'], primary: 'share', open: false },
  { name: 'sharing', s: status({ phase: 'sharing', progress: { done: 12, total: 40 }, link: LINK }), title: 'Sharing', actions: ['stop', 'copy'], primary: null, open: false },
  { name: 'shared', s: shared(), title: 'Shared', actions: ['keep', 'copy'], primary: 'copy', open: true },
  { name: 'kept', s: shared({ kept: true, access: 'comment', signed_in: true, who: 'Ada Novak' }), title: 'Shared', actions: ['invite', 'copy'], primary: 'copy', open: true },
  { name: 'update', s: shared({ changes: 2 }), title: '2 changes here', actions: ['copy', 'update'], primary: 'update', open: true },
  { name: 'over', s: status({ phase: 'over_limit', limit_own: true, link: LINK, access: 'private', kept: true, shared_once: true, progress: { done: 3, total: 9 } }), title: 'Over the limit', actions: ['try-again', 'open-space'], primary: 'open-space', open: false },
  { name: 'gone', s: status({ phase: 'gone', shared_once: true }), title: 'This space is gone', actions: ['share-new'], primary: 'share-new', open: false },
  { name: 'refused', s: status({ phase: 'refused', link: LINK, shared_once: true }), title: 'Someone else kept this space', actions: ['open-space', 'share-new'], primary: 'share-new', open: false },
];

test.afterAll(async () => {
  await removeInboxScratch();
});

/** Answers the page's reads of the share's status with `current()`; anything else goes to the Inbox. */
async function standIn(page: Page, current: () => SpaceShareStatus) {
  await page.route(/\/api\/plans\/[^/]+\/share(\?.*)?$/, (route) => (route.request().method() === 'GET' ? route.fulfill({ json: current() }) : route.fallback()));
}

test('the Share panel, B1: three parts in every state, one row of actions with one main button, no address; the phone\'s bottom sheet with 44 px targets', async ({ browser }) => {
  test.setTimeout(240_000);
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-share-panel-e2e-');
  const dataDir = join(root, 'data');
  const configFile = join(dataDir, 'config.json');
  writeFileSync(configFile, JSON.stringify({ ...JSON.parse(readFileSync(configFile, 'utf8')), inboxPlans: true, inboxSpaceShare: true }));
  const store = createPlanStore({ dataDir });
  const { plan, document } = store.createPlan({ name: 'Rate limiting', project_name: 'ledger', created_at: '2026-11-10T09:00:00.000Z', document: { title: 'Rate limiting' } });
  const text = '# Rate limiting\n\nLimit each tenant so one cannot starve every other tenant.\n\n## Approach\n\n- Limit per API key, a token bucket that refills every second.\n- Answer `429` with a `Retry-After` header.\n- Keep counters in Redis so every node agrees.\n';
  store.addVersion(plan.id, document.id, { bytes: new TextEncoder().encode(text), committed_at: '2026-11-10T09:00:00.000Z', source: 'plan-review', author_via: 'plan-review' });

  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9', PLANNOTATOR_SPACES_URL: 'http://127.0.0.1:9', PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();

  for (const form of ['desktop', 'phone'] as const) {
    const phone = form === 'phone';
    const context = await browser.newContext(phone ? { viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, colorScheme: 'light' } : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light' });
    try {
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      let current = STATES[0]!.s;
      await standIn(page, () => current);
      await page.goto(`${url}#plans=${plan.id}`);
      const button = page.locator('[data-plan-share]');
      await expect(button).toBeVisible();

      for (const state of STATES) {
        current = state.s;
        await button.click();
        const panel = page.locator('[data-plan-share-panel]');
        await expect(panel).toBeVisible();
        await expect(panel.locator('[data-share-status] h2')).toHaveText(state.title);
        if (phone) {
          // The Inbox's own bottom sheet, risen all the way.
          const sheet = page.locator('[data-sheet][data-plan-share-sheet]');
          await expect(sheet).toHaveAttribute('data-shown', '');
          await expect.poll(() => sheet.evaluate((el) => getComputedStyle(el).transform)).toBe('none');
          await expect(sheet.locator('[data-plan-share-panel]')).toHaveCount(1);
        }

        // One row of actions, holding every button; its main button; no address anywhere.
        // (Polled: the panel draws the state it had until the read on opening answers, and two states say "Shared".)
        await expect.poll(() => panel.locator('.ib-shr-b').evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.shareAct))).toEqual(state.actions);
        const actions = panel.locator('[data-share-actions]');
        await expect(actions).toHaveCount(1);
        expect(await actions.locator('.ib-shr-b').count()).toBe(state.actions.length);
        expect(await panel.locator('.ib-shr-pri').evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.shareAct))).toEqual(state.primary ? [state.primary] : []);
        await expect(panel.locator('input')).toHaveCount(0);
        await expect(panel).not.toContainText('spaces.example');
        await expect(panel).not.toContainText('Make it yours');
        // The buttons sit on one line, inside the panel, none cut.
        const boxes = await panel.locator('.ib-shr-b').evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), left: r.left, right: r.right, height: r.height, cut: el.scrollWidth > el.clientWidth + 1 }; }));
        const frame = (await panel.boundingBox())!;
        expect(new Set(boxes.map((b) => b.top)).size).toBeLessThanOrEqual(1);
        for (const b of boxes) {
          expect(b.cut).toBe(false);
          expect(b.left).toBeGreaterThanOrEqual(frame.x - 0.5);
          expect(b.right).toBeLessThanOrEqual(frame.x + frame.width + 0.5);
          expect(b.height).toBe(phone ? 44 : 30);
        }
        // The open mark: there in the shared states, 28 px on a desktop and 44 px on a phone, opening the space.
        const open = panel.locator('[data-share-status] [data-share-act="open"]');
        await expect(open).toHaveCount(state.open ? 1 : 0);
        if (state.open) {
          await expect(open).toHaveAttribute('href', LINK);
          await expect(open).toHaveAttribute('target', '_blank');
          const box = (await open.boundingBox())!;
          expect([box.width, box.height]).toEqual(phone ? [44, 44] : [28, 28]);
        }
        if (phone) {
          const details = panel.locator('[data-share-act="details"]');
          if (await details.count()) expect((await details.boundingBox())!.height).toBeGreaterThanOrEqual(44);
          const info = panel.locator('[data-share-info]');
          if (await info.count()) expect((await info.boundingBox())!.height).toBe(44);
        }

        // The pictures: focus off any control first, so no ring is drawn.
        await page.evaluate(() => {
          const active = document.activeElement as HTMLElement | null;
          if (active?.matches('button, a') && !active.matches('[data-plan-share-panel], [data-sheet]')) active.blur();
        });
        for (const scheme of ['light', 'dark'] as const) {
          await page.emulateMedia({ colorScheme: scheme });
          await page.waitForTimeout(150);
          await page.screenshot({ path: join(proofDir, `b1-${state.name}-${form}-${scheme}.png`) });
        }
        await page.emulateMedia({ colorScheme: 'light' });

        await page.keyboard.press('Escape');
        await expect(page.locator('[data-plan-share-panel]')).toHaveCount(0);
      }
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }
});
