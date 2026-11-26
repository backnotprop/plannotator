/**
 * The plan page's header (approval "inbox-plan-page-header-a3"): the document's own title is the header. On a phone
 * the bar holds the project, Share (off here: its switch is off) and the page's menu; the approval and the version
 * sit above the document's title; the bar takes the plan's name once that title scrolls away; the tools, the
 * comments and Send are one bar at the bottom. On a computer Edit and the version stay on the pinned reading line,
 * with the menu at its end. Real browser, compiled binary, temp PLANNOTATOR_DATA_DIR and HOME; the plan library is
 * seeded with the store before the Inbox starts (Plans on in config.json).
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-plan-header.spec.ts`.
 * PNGs land in .local/proof/plan-header/: phone-<light|dark>, phone-scrolled-<scheme>, phone-menu-<scheme>,
 * phone-<390|375|320>-light, phone-long-name-light, desktop-<scheme>, desktop-menu-<scheme>, desktop-copied-light,
 * desktop-scrolled-light, desktop-narrow-light, desktop-clock-tip-<scheme>, desktop-versions-<scheme>, desktop-panel-p2-<scheme> (the panel with no
 * head, Pages first, the back arrow first in the top bar).
 */

import { expect, test, type Browser, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { NO_ACTOR } from '../../packages/core/plans';
import { createPlanStore } from '../../packages/shared/plans/store';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'plan-header');

const DOC = `# Rate limiting for public endpoints

## Context

The public API has no limit today. One client sent 40k requests in a minute last week and slowed every other tenant.

## Approach

- Limit per API key, a token bucket that refills every second.
- Answer \`429\` with a \`Retry-After\` header.
- Keep counters in Redis so every node agrees.
- If Redis is down, allow the request and count it locally.

## Limits

| Tier | Requests / minute | Burst |
| --- | --- | --- |
| Free | 60 | 120 |
| Team | 600 | 1200 |
| Enterprise | 6000 | 12000 |

## Steps

1. Add the limiter middleware in \`server/middleware/limit.ts\`.
2. Read the tier from the key record.
3. Log every refusal with the key id.
4. Add a dashboard panel for refusals per tier.
`;

test.afterAll(async () => {
  await removeInboxScratch();
});

/** Focus off whatever the last step pressed, so a picture shows the page at rest. */
const blur = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

/** The phone's bottom bar is one row: its seven controls (five tools, the comments, Send) share a top within 2 px. */
async function dockOneRow(page: Page) {
  const tops = await page.locator('[data-plan-dock]').evaluate((dock) => [...dock.querySelectorAll('.ib-toolstrip button, [data-annotations-sheet], [data-plan-send-button]')].map((el) => el.getBoundingClientRect().top));
  expect(tops.length).toBe(7);
  expect(Math.max(...tops) - Math.min(...tops)).toBeLessThanOrEqual(2);
}

async function phonePage(browser: Browser, url: string, scheme: 'light' | 'dark', width = 393) {
  const context = await browser.newContext({ viewport: { width, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: scheme });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  return { context, page, errors };
}

test('the document’s title is the header: a phone’s bar, state line, bottom bar and menu; a computer’s pinned reading line', async ({ browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-plan-header-e2e-');
  const dataDir = join(root, 'data');
  const configFile = join(dataDir, 'config.json');
  writeFileSync(configFile, JSON.stringify({ ...JSON.parse(readFileSync(configFile, 'utf8')), inboxPlans: true }));
  const store = createPlanStore({ dataDir });
  const { plan, document } = store.createPlan({ name: 'Rate limiting for public endpoints', project_name: 'trailhead-api', created_at: '2026-11-10T09:00:00.000Z', document: { title: 'Rate limiting for public endpoints' } });
  const v1 = store.addVersion(plan.id, document.id, { bytes: new TextEncoder().encode(DOC), committed_at: '2026-11-10T09:00:00.000Z', source: 'plan-review', author_via: 'plan-review' });
  store.addEvent(plan.id, { ...NO_ACTOR, author_via: 'person', kind: 'decision', at: '2026-11-10T10:00:00.000Z', subject: { document_id: document.id, version_number: 1 }, decision: { document_id: document.id, version: v1.version, version_number: 1, decision: 'approved-with-notes', at: '2026-11-10T10:00:00.000Z', feedback: null, feedback_record: null, snapshot: null }, legacy: null });
  const notes = store.addDocument(plan.id, { title: 'Load test notes', kind: 'markdown', created_at: '2026-11-10T09:30:00.000Z' });
  store.addVersion(plan.id, notes.id, { bytes: new TextEncoder().encode('# Load test notes\n\nPeak at 2k requests a second.\n'), committed_at: '2026-11-10T09:30:00.000Z', source: 'plan-review', author_via: 'plan-review' });
  const long = store.createPlan({ name: 'Move every public endpoint behind the new rate limiter and retire the old per-route throttles', project_name: 'trailhead-api-gateway-and-edge-services', created_at: '2026-11-10T09:00:00.000Z', document: { title: 'Move every public endpoint behind the new rate limiter and retire the old per-route throttles' } });
  store.addVersion(long.plan.id, long.document.id, { bytes: new TextEncoder().encode(`# ${long.plan.name}\n\n${DOC.split('\n').slice(1).join('\n')}`), committed_at: '2026-11-10T09:00:00.000Z', source: 'plan-review', author_via: 'plan-review' });

  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9', PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const planUrl = `${url}#plans=${plan.id}`;

  for (const scheme of ['light', 'dark'] as const) {
    const { context, page, errors } = await phonePage(browser, planUrl, scheme);
    try {
      const planPage = page.locator(`[data-plan-page="${plan.id}"]`);
      const kicker = page.locator('.ib-docscroll > [data-plan-kicker]');
      await expect(kicker.locator('[data-plan-approval="approved"]')).toHaveText('Approved by you, with notes');
      // No version text (approval A2): the history clock at the line's end carries the version in its name.
      await expect(kicker.locator('[data-reading-versions]')).toHaveAccessibleName('Versions · v1, newest');
      expect(await kicker.innerText()).not.toContain('v1');
      // At rest: the project in the bar, the plan's name once (the document's own title), no file-name row.
      await expect(planPage).toHaveAttribute('data-plan-header', 'project');
      await expect(page.locator('[data-plan-bartitle-rest]')).toHaveText('trailhead-api');
      await expect(page.locator('.ib-vhead')).toHaveCount(0);
      await expect(page.locator('[data-plan-titleblock]')).toHaveCSS('opacity', '0');
      // Share is off by default: not in the bar.
      await expect(page.locator('[data-plan-share]')).toHaveCount(0);
      // One bar at the bottom: the tools, the comments, Send (its mark, named Send; its line its description).
      const dock = page.locator('[data-plan-dock]');
      await expect(dock.locator('.ib-toolstrip button')).toHaveCount(5);
      await expect(dock.locator('[data-plan-send-button]')).toHaveAttribute('aria-label', 'Send');
      expect(await page.locator('[data-plan-send-line="described"]').evaluate((el) => el.getBoundingClientRect().width)).toBeLessThanOrEqual(1);
      // 44 px targets.
      for (const target of [page.locator('nav [data-plan-more]'), dock.locator('[data-plan-send-button]'), dock.locator('.ib-toolstrip button').first(), page.locator('[data-plan-kicker] [data-reading-versions]')]) {
        const box = (await target.boundingBox())!;
        expect(box.height, await target.evaluate((el) => el.outerHTML.slice(0, 80))).toBeGreaterThanOrEqual(44);
      }
      await blur(page);
      await page.screenshot({ path: join(proofDir, `phone-${scheme}.png`) });

      // Scrolled: the bar takes the plan's name, its version and its decision.
      await page.locator('[data-plan-annotate] .ib-docscroll').evaluate((el) => el.scrollTo(0, 420));
      await expect(planPage).toHaveAttribute('data-plan-header', 'name');
      await expect(page.locator('[data-plan-titleblock] .ib-plan-title-n')).toBeVisible();
      await blur(page);
      await page.screenshot({ path: join(proofDir, `phone-scrolled-${scheme}.png`) });
      await page.locator('[data-plan-annotate] .ib-docscroll').evaluate((el) => el.scrollTo(0, 0));
      await expect(planPage).toHaveAttribute('data-plan-header', 'project');

      // The menu: what the file-name row and the chips held.
      await page.locator('nav [data-plan-more]').click();
      const sheet = page.locator('[data-plan-menu]');
      await expect(sheet).toBeVisible();
      await expect(sheet.locator('[data-plan-menu-row]')).toHaveText(['Edit', 'Global comment', 'Files2', 'Contents', 'Copy file', 'Download', 'Close']);
      await page.waitForTimeout(400);
      // Drawn inside the Inbox's root: its icons are strokes (not filled blobs) and its group lines have a colour.
      const glyph = await sheet.locator('[data-plan-menu-row="edit"] svg').evaluate((el) => ({ fill: getComputedStyle(el).fill, stroke: getComputedStyle(el).stroke }));
      expect(glyph.fill).toBe('none');
      expect(glyph.stroke).not.toBe('none');
      const lineColour = await sheet.locator('.ib-sheet-line').first().evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(lineColour).not.toBe('rgba(0, 0, 0, 0)');
      expect(lineColour).not.toBe('transparent');
      await page.screenshot({ path: join(proofDir, `phone-menu-${scheme}.png`) });
      await sheet.locator('[data-plan-menu-row="files"]').click();
      await expect(page.locator('[data-plan-sidebar="compact"]')).toContainText('Load test notes');
      await page.keyboard.press('Escape');
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }

  // 390, 375 and 320 px: the bottom bar stays one row, each target still 44 px; the bar opens on the project, cut.
  for (const width of [390, 375] as const) {
    const { context, page, errors } = await phonePage(browser, planUrl, 'light', width);
    try {
      await expect(page.locator('[data-plan-kicker]')).toBeVisible();
      await dockOneRow(page);
      await blur(page);
      await page.screenshot({ path: join(proofDir, `phone-${width}-light.png`) });
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }
  // 320 px and a long name: nothing runs off the screen; the name is cut at its end.
  {
    const { context, page, errors } = await phonePage(browser, planUrl, 'light', 320);
    try {
      await expect(page.locator('[data-plan-kicker]')).toBeVisible();
      // The plan's name is not in the bar at rest (it never fades in and out as the page opens).
      await expect(page.locator('[data-plan-titleblock]')).toHaveCSS('opacity', '0');
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
      const dock = page.locator('[data-plan-dock]');
      expect(await dock.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      await dockOneRow(page);
      // A tool drawn narrower keeps a 44 px wide hit area: a press 21 px left of the first tool's middle is that tool.
      const first = dock.locator('.ib-toolstrip button').first();
      const box = (await first.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(await first.evaluate((el, x) => el.contains(document.elementFromPoint(x, el.getBoundingClientRect().top + 22)), box.x + box.width / 2 - 21)).toBe(true);
      await blur(page);
      await page.screenshot({ path: join(proofDir, 'phone-320-light.png') });
      await page.goto(`${url}#plans=${long.plan.id}`);
      await expect(page.locator('[data-plan-kicker]')).toBeVisible();
      await page.locator('[data-plan-annotate] .ib-docscroll').evaluate((el) => el.scrollTo(0, 600));
      await expect(page.locator(`[data-plan-page="${long.plan.id}"]`)).toHaveAttribute('data-plan-header', 'name');
      expect(await page.locator('[data-plan-titleblock] .ib-plan-title-n').evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
      await blur(page);
      await page.screenshot({ path: join(proofDir, 'phone-long-name-light.png') });
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }

  for (const scheme of ['light', 'dark'] as const) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
    try {
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(planUrl);
      const reading = page.locator('[data-plan-reading]');
      await expect(reading.locator('[data-plan-approval="approved"]')).toHaveText('Approved by you, with notes');
      await expect(reading.locator('[data-plan-edit]')).toBeVisible();
      await expect(page.locator('.ib-vhead')).toHaveCount(0);
      // The bar (approval A2): the approval's words and three marks, no version text; Versions closed until the clock.
      expect((await reading.innerText()).trim()).toBe('Approved by you, with notes');
      await expect(page.locator('[data-versions-panel]')).toHaveCount(0);
      const clock = reading.locator('[data-reading-versions]');
      await clock.hover();
      await expect(page.getByRole('tooltip').or(page.locator('[data-pn-tooltip]')).first()).toHaveText('Versions · v1, newest');
      await page.screenshot({ path: join(proofDir, `desktop-clock-tip-${scheme}.png`) });
      await clock.click();
      await expect(page.locator('[data-versions-panel]')).toBeVisible();
      await expect(clock).toHaveAttribute('aria-pressed', 'true');
      await page.screenshot({ path: join(proofDir, `desktop-versions-${scheme}.png`) });
      await clock.click();
      await expect(page.locator('[data-versions-panel]')).toHaveCount(0);
      await expect(page.locator('[data-plan-dock] [data-plan-global]')).toBeVisible();
      await blur(page);
      await page.screenshot({ path: join(proofDir, `desktop-${scheme}.png`) });
      // The panel has no head (approval P2): Pages comes first; the head's back arrow, its name kept, is the top
      // bar's first, before the crumbs.
      await expect(page.locator('[data-pages-rail-head]')).toHaveCount(0);
      const back = page.locator('[data-page-header] [data-plan-crumb-back]');
      await expect(back).toBeVisible();
      await expect(back).toHaveAccessibleName('Back to Rate limiting for public endpoints');
      expect((await back.boundingBox())!.x).toBeLessThan((await page.locator('[data-page-header] [data-breadcrumb-root]').boundingBox())!.x);
      await page.screenshot({ path: join(proofDir, `desktop-panel-p2-${scheme}.png`), clip: { x: 0, y: 0, width: 760, height: 320 } });
      await reading.locator('[data-plan-more]').click();
      await expect(page.locator('[data-plan-menu] [data-plan-menu-row]')).toHaveText(['Copy file', 'Download', 'Full screen']);
      await page.screenshot({ path: join(proofDir, `desktop-menu-${scheme}.png`) });
      await page.keyboard.press('Escape');
      if (scheme === 'light') {
        // Copy file says it copied, as the Viewer's own Copy does, then the menu closes.
        await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(url).origin });
        await reading.locator('[data-plan-more]').click();
        await page.locator('[data-plan-menu] [data-plan-menu-row="copy"]').click();
        await expect(page.locator('[data-plan-menu] [data-plan-menu-row="copy"]')).toHaveText('Copied!');
        await page.screenshot({ path: join(proofDir, 'desktop-copied-light.png') });
        await expect(page.locator('[data-plan-menu]')).toHaveCount(0);
      }
      if (scheme === 'light') {
        // Pinned: Edit and the version never scroll away.
        const before = (await reading.boundingBox())!;
        await page.locator('[data-plan-annotate] .ib-docscroll').evaluate((el) => el.scrollTo(0, 500));
        await expect(reading.locator('[data-plan-edit]')).toBeInViewport();
        expect((await reading.boundingBox())!.y).toBe(before.y);
        await blur(page);
        await page.screenshot({ path: join(proofDir, 'desktop-scrolled-light.png') });
        // The back arrow goes where the panel's did: the Spaces home.
        await page.locator('[data-page-header] [data-plan-crumb-back]').click();
        await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#plans');
        await expect(page.locator(`[data-plan-page="${plan.id}"]`)).toHaveCount(0);
      }
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }

  // A narrow computer window: the Send line stays (words above the controls where the bar is short), and Contents
  // is still on screen. At 820 px the document keeps 480 px and more, so the Contents rail shows beside it (on main
  // as here); the pane's own Contents button, for a card too narrow for the rail, is guarded by planHeader.test.tsx.
  {
    const context = await browser.newContext({ viewport: { width: 820, height: 900 }, colorScheme: 'light' });
    try {
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(planUrl);
      await expect(page.locator('[data-plan-reading] [data-plan-edit]')).toBeVisible();
      const line = page.locator('[data-plan-dock] [data-plan-send-line="shown"]');
      await expect(line).toBeVisible();
      expect(await line.evaluate((el) => el.getBoundingClientRect().width)).toBeGreaterThan(40);
      expect(await line.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      // The controls stay one row (the line is words above them where the bar is narrow).
      const controlTops = await page.locator('[data-plan-dock]').evaluate((dock) => [...dock.querySelectorAll('.ib-toolstrip button, [data-plan-global], [data-annotations-sheet], [data-plan-send-button]')].map((el) => Math.round(el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2)));
      expect(Math.max(...controlTops) - Math.min(...controlTops)).toBeLessThanOrEqual(2);
      await expect(page.locator('.pn-contents-rail').first()).toBeVisible({ timeout: 10_000 });
      await blur(page);
      await page.screenshot({ path: join(proofDir, 'desktop-narrow-light.png') });
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }
});
