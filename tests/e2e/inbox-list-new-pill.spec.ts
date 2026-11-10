/**
 * The list's "N new" pill and Show's light (packages/inbox/components/ListNewPill.tsx, packages/inbox/showLight.ts),
 * proved in a browser against the compiled binary with an agent writing through `plannotator inbox mcp`
 * (scripts/inbox-sim.ts). The DOM tests (packages/inbox/listNewPill.test.tsx, showLight.test.tsx) prove the rules
 * with stand-ins; this proves what needs a layout.
 *
 * - The reader is scrolled down, so the "N new · Show" line at the list's top is out of view: news shows the pill
 *   at the list's bottom edge, counting, the list's rows stay as they are, and the pill stays (it is still there
 *   after the seven seconds a fading pill would have taken).
 * - A press on it is Show and "take me there": the line goes, the rows come to the middle of the list, and each is
 *   lit only once it is in view, for the light's whole 3 s from there.
 * - With the line in view there is no pill, and scrolling to where the rows will land draws and lights nothing.
 * - Show on the line never scrolls the list. The row it brought in below the view is not lit; the pill counts it;
 *   a press on the pill goes there and the row is lit for its whole time.
 * - A 390 px phone: the pill is above the list's bottom edge with a 44 px target, and a tap brings the row in view.
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-list-new-pill.spec.ts`.
 */

import { devices, expect, test, type Browser, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, rememberInboxOf, removeInboxScratch, scratchEnv } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));

let world: { url: string; agent: SimAgent; project: string };
let sent = 0;

type Send = Parameters<SimAgent['send']>[0];
const QUESTION = ':::question\nShip it this week?\n- Yes\n- Next week\n:::';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-inbox-newpill-e2e-');
  // Never a real agent's CLI: no connection runs (PLANNOTATOR_INBOX_CONNECT=0), and stubs that refuse come first on PATH.
  const stubs = join(root, 'bin');
  mkdirSync(stubs, { recursive: true });
  for (const name of ['claude', 'codex', 'opencode', 'pi', 'gemini', 'cursor-agent', 'amp']) writeFileSync(join(stubs, name), '#!/bin/sh\necho "this stub never runs" >&2\nexit 1\n', { mode: 0o755 });
  const scratch = scratchEnv(root, { home: root });
  const dataDir = scratch.PLANNOTATOR_DATA_DIR;
  const env = {
    ...scratch,
    PATH: `${stubs}:${process.env.PATH ?? ''}`,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_TEST_SANDBOX: root,
    CLAUDE_CONFIG_DIR: join(root, 'claude-config'),
  };
  const project = scratchProject(join(root, 'src'), 'billing-svc');
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  // A busy Inbox: a long "Waiting on you", so "New since you looked" starts far below the fold on every screen, and
  // enough rows in it that its first row can come to the middle of the list (the list's end would stop it short).
  for (let n = 0; n < 16; n++) await agent.send({ project_path: project, subject: `Update ${n}`, body: 'Done. Nothing to answer.', agent_session: `ses_seed_new_${n}` } as Send);
  for (let n = 0; n < 30; n++) await agent.send({ project_path: project, subject: `Question ${n}`, body: QUESTION, agent_session: `ses_seed_wait_${n}` } as Send);
  world = { url: started.stdout.trim().replace(/\/$/, ''), agent, project };
});

test.afterAll(async () => {
  try {
    await world?.agent.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

/** An update with no question arrives: it lands in "New since you looked", below the long "Waiting on you". */
async function news(): Promise<string> {
  sent += 1;
  const made = (await world.agent.send({ project_path: world.project, subject: `Fresh update ${sent}`, body: 'Finished. Nothing to answer.', agent_session: `ses_fresh_${sent}` } as Send)) as { thread_id: string };
  return made.thread_id;
}

const body = (page: Page) => page.locator('.ib-listcol .ib-lbody');
const pill = (page: Page) => page.locator('[data-list-new-pill]');
const line = (page: Page) => page.locator('[data-inbox-notice]');

/** The list, loaded and scrolled down inside "Waiting on you": whatever the line says, it is out of view. */
async function openScrolled(page: Page): Promise<void> {
  await page.goto(world.url);
  await expect(body(page).locator('[data-thread-id]').first()).toBeVisible();
  await body(page).evaluate((el) => {
    el.scrollTop = 400;
  });
  await expect(pill(page)).toHaveAttribute('data-off', '');
}

/** Where the pill and a row are inside the list's scroll box. */
function placeIn(page: Page, selector: string) {
  return page.evaluate((sel) => {
    const box = document.querySelector('.ib-listcol .ib-lbody')!.getBoundingClientRect();
    const el = [...document.querySelectorAll<HTMLElement>(sel)].find((node) => node.getClientRects().length > 0)!;
    const rect = el.getBoundingClientRect();
    return { top: rect.top - box.top, bottom: box.bottom - rect.bottom, middle: (rect.top + rect.bottom) / 2 - (box.top + box.bottom) / 2, height: rect.height, boxHeight: box.height };
  }, selector);
}

test('scrolled down, news shows the pill at the bottom edge and the list holds; it counts and stays; a press shows the rows in the middle, lit once in view', async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const page = await context.newPage();
    await openScrolled(page);
    const order = () => body(page).locator('[data-thread-id]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-thread-id')));
    const before = await order();

    const first = await news();
    await expect(pill(page)).not.toHaveAttribute('data-off', '');
    await expect(pill(page)).toHaveText('1 new');
    await expect(pill(page)).toHaveAccessibleName('1 new message below, show');
    await expect(line(page)).not.toBeInViewport();
    // At the list's bottom edge, inside it, once it has risen into place (it comes in from 6 px lower).
    await expect.poll(async () => (await placeIn(page, '[data-list-new-pill]')).bottom).toBeGreaterThanOrEqual(8);
    expect((await placeIn(page, '[data-list-new-pill]')).bottom).toBeLessThanOrEqual(24);
    // The list held still: the same rows in the same order, the new one not drawn.
    expect(await order()).toEqual(before);

    const second = await news();
    await expect(pill(page)).toHaveText('2 new');
    await expect(pill(page)).toHaveAccessibleName('2 new messages below, show');
    // It stays: past the time a fading pill would be gone, it is still there, whole.
    await page.waitForTimeout(7000);
    await expect(pill(page)).not.toHaveAttribute('data-off', '');
    await expect(pill(page)).not.toHaveAttribute('data-fading', '');

    // Each frame from the press on: when each new row is first in view in the list, when it is lit, when the light goes.
    await page.evaluate((ids) => {
      const seen: Record<string, { inView: number | null; lit: number | null; off: number | null }> = {};
      (window as unknown as { __light: typeof seen }).__light = seen;
      const box = document.querySelector('.ib-listcol .ib-lbody')!;
      let pressed: number | null = null;
      document.addEventListener('pointerdown', (event) => {
        if ((event.target as Element).closest('[data-list-new-pill]')) pressed = performance.now();
      }, true);
      const tick = () => {
        if (pressed !== null) {
          const view = box.getBoundingClientRect();
          for (const id of ids) {
            const el = [...box.querySelectorAll<HTMLElement>(`[data-thread-id="${id}"]`)].find((node) => node.getClientRects().length > 0);
            if (!el) continue;
            const at = (seen[id] ??= { inView: null, lit: null, off: null });
            const rect = el.getBoundingClientRect();
            const share = Math.max(0, Math.min(rect.bottom, view.bottom) - Math.max(rect.top, view.top)) / rect.height;
            const now = performance.now() - pressed;
            if (at.inView === null && share >= 0.9) at.inView = now;
            if (at.lit === null && el.hasAttribute('data-lit')) at.lit = now;
            if (at.lit !== null && at.off === null && !el.hasAttribute('data-lit')) at.off = now;
          }
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }, [first, second]);

    await pill(page).click();
    await expect(line(page)).toHaveCount(0);
    await expect(pill(page)).toHaveAttribute('data-off', '');
    const row = page.locator(`.ib-lbody [data-thread-id="${first}"]`);
    await expect(row).toBeInViewport({ ratio: 1 });
    await expect(row).toHaveAttribute('data-lit', '');
    // Both rows the pill counted: never lit before they are in view, and lit for the light's whole 3 s from there.
    type Light = Record<string, { inView: number | null; lit: number | null; off: number | null }>;
    await expect.poll(async () => Object.values(await page.evaluate(() => (window as unknown as { __light: Light }).__light)).filter((at) => at.off !== null).length, { timeout: 8000 }).toBe(2);
    for (const at of Object.values(await page.evaluate(() => (window as unknown as { __light: Light }).__light))) {
      expect(at.inView).not.toBeNull();
      expect(at.lit!).toBeGreaterThanOrEqual(at.inView! - 34);
      expect(at.off! - at.lit!).toBeGreaterThanOrEqual(2800);
      expect(at.off! - at.lit!).toBeLessThanOrEqual(3600);
    }
    // Near the middle of the list, not at the edge the pointer pressed at (the smooth scroll has ended).
    await expect.poll(async () => Math.abs((await placeIn(page, `.ib-lbody [data-thread-id="${first}"]`)).middle)).toBeLessThan(150);
  } finally {
    await context.close();
  }
});

test('with the "N new" line in view there is no pill; Show never scrolls, and the pill then goes to the row it brought in below', async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const page = await context.newPage();
    await page.goto(world.url);
    await expect(body(page).locator('[data-thread-id]').first()).toBeVisible();
    const held = await news();
    await expect(line(page)).toBeInViewport();
    await expect(line(page)).toContainText('1 new');
    await expect(pill(page)).toHaveAttribute('data-off', '');
    // The reader scrolls down afterwards: that news had its sign, so still none.
    await body(page).evaluate((el) => {
      el.scrollTop = 400;
    });
    await expect(line(page)).not.toBeInViewport();
    await page.waitForTimeout(500);
    await expect(pill(page)).toHaveAttribute('data-off', '');
    // They scroll on to where the row will land: it is still held behind the line, so nothing is drawn or lit.
    await body(page).evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(500);
    await expect(page.locator(`.ib-lbody [data-thread-id="${held}"]`)).toHaveCount(0);
    await expect(page.locator('.ib-lbody [data-lit]')).toHaveCount(0);

    // Back at the top, Show: the list does not move. The row it brought in is far below, so it is not lit yet.
    await body(page).evaluate((el) => {
      el.scrollTop = 0;
    });
    await expect(line(page)).toBeInViewport();
    await line(page).click();
    await expect(line(page)).toHaveCount(0);
    const row = page.locator(`.ib-lbody [data-thread-id="${held}"]`);
    await expect(row).toHaveCount(1);
    await page.waitForTimeout(800);
    expect(await body(page).evaluate((el) => el.scrollTop)).toBe(0);
    await expect(row).not.toBeInViewport();
    await expect(page.locator('.ib-lbody [data-lit]')).toHaveCount(0);
    // The pill counts it, at the bottom edge, and stays.
    await expect(pill(page)).not.toHaveAttribute('data-off', '');
    await expect(pill(page)).toHaveText('1 new');
    await expect(pill(page)).toHaveAccessibleName('1 new message below, show');
    await expect(pill(page).locator('..')).toHaveAttribute('data-edge', 'bottom');
    // Well past the light's own 3 s: it has not run out of sight.
    await page.waitForTimeout(3500);
    await expect(row).not.toHaveAttribute('data-lit', '');

    // The pill is "take me there": the row comes into view and is lit for its whole time from then.
    await pill(page).click();
    await expect(row).toBeInViewport({ ratio: 1 });
    await expect(row).toHaveAttribute('data-lit', '');
    const litAt = Date.now();
    await expect(pill(page)).toHaveAttribute('data-off', '');
    await expect(row).not.toHaveAttribute('data-lit', '', { timeout: 6000 });
    expect(Date.now() - litAt).toBeGreaterThanOrEqual(2500);
  } finally {
    await context.close();
  }
});

test('a 390 px phone: the pill is above the bottom edge with a 44 px target, and a tap brings the row into view', async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext({ ...devices['iPhone 15'], viewport: { width: 390, height: 844 } });
  try {
    const page = await context.newPage();
    await openScrolled(page);
    const first = await news();
    await expect(pill(page)).not.toHaveAttribute('data-off', '');
    await expect(pill(page)).toHaveText('1 new');
    // Once it has risen into place (it comes in from 6 px lower).
    await expect.poll(async () => (await placeIn(page, '[data-list-new-pill]')).bottom).toBeGreaterThanOrEqual(8);
    const target = await pill(page).evaluate((el) => {
      const after = getComputedStyle(el, '::after');
      return el.getBoundingClientRect().height - parseFloat(after.top) - parseFloat(after.bottom);
    });
    expect(target).toBeGreaterThanOrEqual(44);

    await pill(page).tap();
    await expect(line(page)).toHaveCount(0);
    await expect(page.locator(`.ib-lbody [data-thread-id="${first}"]`)).toBeInViewport({ ratio: 1 });
    await expect(pill(page)).toHaveAttribute('data-off', '');
  } finally {
    await context.close();
  }
});
