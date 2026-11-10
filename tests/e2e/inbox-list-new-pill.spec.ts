/**
 * The list's "N new" pill (packages/inbox/components/ListNewPill.tsx), proved in a browser against the compiled
 * binary with an agent writing through `plannotator inbox mcp` (scripts/inbox-sim.ts). The DOM test
 * (packages/inbox/listNewPill.test.tsx) proves its rules with a stand-in observer; this proves what needs a
 * layout: where the "N new" line really is, where the pill really sits, and where a press really brings the row.
 *
 * - The reader is scrolled down, so the line at the list's top is out of view: news shows the pill at the list's
 *   bottom edge, counting, and the list's rows stay as they are.
 * - A press is Show: the line goes, the row is lit near the middle of the list, the pill is gone.
 * - With the line in view there is no pill.
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
  // A busy Inbox: a long "Waiting on you", so "New since you looked" starts far below the fold on every screen.
  for (let n = 0; n < 4; n++) await agent.send({ project_path: project, subject: `Update ${n}`, body: 'Done. Nothing to answer.', agent_session: `ses_seed_new_${n}` } as Send);
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

test('scrolled down, news shows the pill at the bottom edge and the list holds; it counts; a press shows the row in the middle', async ({ browser }: { browser: Browser }) => {
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
    // At the list's bottom edge, inside it.
    const at = await placeIn(page, '[data-list-new-pill]');
    expect(at.bottom).toBeGreaterThanOrEqual(8);
    expect(at.bottom).toBeLessThanOrEqual(24);
    // The list held still: the same rows in the same order, the new one not drawn.
    expect(await order()).toEqual(before);

    await news();
    await expect(pill(page)).toHaveText('2 new');
    await expect(pill(page)).toHaveAccessibleName('2 new messages below, show');

    await pill(page).click();
    await expect(line(page)).toHaveCount(0);
    await expect(pill(page)).toHaveAttribute('data-off', '');
    const row = page.locator(`.ib-lbody [data-thread-id="${first}"]`);
    await expect(row).toBeInViewport({ ratio: 1 });
    await expect(row).toHaveAttribute('data-lit', '');
    // Near the middle of the list, not at the edge the pointer pressed at (the smooth scroll has ended).
    await expect.poll(async () => Math.abs((await placeIn(page, `.ib-lbody [data-thread-id="${first}"]`)).middle)).toBeLessThan(150);
  } finally {
    await context.close();
  }
});

test('with the "N new" line in view, news shows no pill', async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const page = await context.newPage();
    await page.goto(world.url);
    await expect(body(page).locator('[data-thread-id]').first()).toBeVisible();
    await news();
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
    const at = await placeIn(page, '[data-list-new-pill]');
    expect(at.bottom).toBeGreaterThanOrEqual(8);
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
