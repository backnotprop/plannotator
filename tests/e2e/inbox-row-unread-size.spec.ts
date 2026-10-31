/**
 * The unread thread name is bigger in the list (approval
 * "inbox-row-unread-bigger", 2026-10-30), proved in a real Chromium against
 * the compiled binary under a temp HOME and PLANNOTATOR_DATA_DIR; agents write
 * through `plannotator inbox mcp` (scripts/inbox-sim.ts). Nothing is mocked.
 *
 *  - Beside an open thread (1440): an unread row's name is 15 px, weight 600;
 *    a read row's is 13.5 px, weight 400. Mark read from the row's menu drops
 *    the row to the read size.
 *  - A 390 px phone: unread 16 px, weight 600; read 14 px, weight 400.
 *  - The wide one-line view (1440, no thread open) keeps its 14.5 px name.
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-row-unread-size.spec.ts`.
 * PNGs land in PLANNOTATOR_E2E_PROOF_DIR/row-unread-size, or .local/proof/row-unread-size/.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'row-unread-size');

const LONG_PROJECT = 'northwind-industries-reconciliation-platform-monorepo';

let url = '';
let agents: SimAgent[] = [];
const threads = { calendar: '', matcher: '', fx: '', intercompany: '', vendor: '', accrual: '', opened: '' };

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-row-unread-e2e-');
  const dataDir = join(root, 'data');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_UPDATE_CHECK: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  url = started.stdout.trim();
  rememberInboxOf(dataDir);
  const project = scratchProject(join(root, 'src'), LONG_PROJECT);
  for (const [name, host] of [['Claude Code', 'claude-code'], ['Codex', 'codex'], ['Pi', 'pi']]) agents.push(await SimAgent.connect({ binary, env, name, host }));
  const [claude, codex, pi] = agents;
  // Each its own named thread (an agent's unnamed messages join its last thread): the name is the row's title, the subject its preview.
  const say = async (agent: SimAgent, thread: string, subject: string, body = `${subject}.`) => (await agent.send({ project_path: project, thread, subject, body })).thread_id;
  threads.opened = await say(claude!, 'The release notes for 0.29 are drafted', 'Release notes');
  threads.fx = await say(claude!, 'FX revaluation job moved to the nightly queue', 'FX revaluation');
  threads.matcher = await say(claude!, 'Bank feed matcher: partial payment tolerance', 'Matcher tolerance');
  await codex!.send({ project_path: project, reply_to: threads.matcher, body: 'Matcher tolerance agrees on my side.' });
  threads.intercompany = await say(pi!, 'March intercompany balances reconciled for the auditors’ Friday export, including both Singapore entities', 'Intercompany March');
  threads.vendor = await say(pi!, 'Vendor dedupe report is ready to review', 'Vendor dedupe');
  threads.calendar = await say(codex!, 'Close calendar synced with the payroll cutoff dates', 'Close calendar');
  threads.accrual = await say(codex!, 'Accrual reminders synced with the payroll cutoff', 'Accrual reminders', [':::question', 'Send the accrual reminders on Monday?', '', '- [ ] Yes', '- [ ] No', ':::'].join('\n'));
  expect(new Set(Object.values(threads)).size, 'seven threads').toBe(7);
  // Two read rows, through the window's own route.
  for (const id of [threads.matcher, threads.fx]) {
    const health = (await (await fetch(new URL('/api/inbox/health', url))).json()) as { serverSession: string };
    const res = await fetch(new URL(`/api/inbox/threads/${id}/read`, url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serverSession: health.serverSession }) });
    expect(res.ok, `mark ${id} read`).toBe(true);
  }
});

test.afterAll(async () => {
  try {
    for (const agent of agents) await agent.close().catch(() => {});
    agents = [];
  } finally {
    await removeInboxScratch();
  }
});

type Look = { unread: boolean; size: number; weight: number; spacing: number };

/** The class `rowClass` row's title for thread `id`: is it marked unread, and its computed size, weight and tracking. */
async function look(page: Page, rowClass: string, titleClass: string, id: string): Promise<Look> {
  return page.evaluate(
    ([rowClass, titleClass, id]) => {
      const row = document.querySelector(`.ib-lbody .${rowClass}[data-thread-id="${id}"]`)!;
      const style = getComputedStyle(row.querySelector(`.${titleClass}`)!);
      return { unread: row.classList.contains('ib-u'), size: parseFloat(style.fontSize), weight: Number(style.fontWeight), spacing: parseFloat(style.letterSpacing) || 0 };
    },
    [rowClass, titleClass, id] as const,
  );
}

async function openQuiet(page: Page) {
  const band = page.locator('.ib-lbody [data-section-id="quiet"] button.ib-band');
  if ((await band.getAttribute('aria-expanded')) !== 'true') await band.click();
  await expect(band).toHaveAttribute('aria-expanded', 'true');
}

const UNREAD_BESIDE: Omit<Look, 'spacing'> = { unread: true, size: 15, weight: 600 };
const READ_BESIDE: Omit<Look, 'spacing'> = { unread: false, size: 13.5, weight: 400 };

test('beside an open thread: an unread name is 15 px 600, a read one 13.5 px 400, and Mark read drops a row to the read size', async ({ browser }: { browser: Browser }) => {
  const context: BrowserContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light', reducedMotion: 'reduce' });
  try {
    const page = await context.newPage();
    await page.goto(`${url}#thread=${threads.opened}`);
    await expect(page.locator(`.ib-nrow[data-thread-id="${threads.calendar}"]`)).toBeVisible();
    await openQuiet(page);
    await expect(page.locator(`.ib-nrow[data-thread-id="${threads.matcher}"]`)).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    for (const id of [threads.calendar, threads.intercompany, threads.vendor, threads.accrual]) {
      const l = await look(page, 'ib-nrow', 'ib-title', id);
      expect(l, `unread ${id}`).toMatchObject(UNREAD_BESIDE);
      expect(l.spacing, `unread ${id}: tracking`).toBeCloseTo(-0.006 * 15, 3);
    }
    for (const id of [threads.matcher, threads.fx, threads.opened]) {
      const l = await look(page, 'ib-nrow', 'ib-title', id);
      expect(l, `read ${id}`).toMatchObject(READ_BESIDE);
      expect(l.spacing, `read ${id}: tracking`).toBe(0);
    }
    await page.screenshot({ path: join(proofDir, 'beside-thread-light.png') });
    // The theme change fades in; the shot waits for it to land (as inbox-row-badges.spec.ts does).
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(proofDir, 'beside-thread-dark.png') });
    await page.emulateMedia({ colorScheme: 'light' });

    // Mark read from the row's menu: the row (held in its place for now) drops to the read size.
    await page.locator(`.ib-lbody [data-thread-id="${threads.vendor}"]`).click({ button: 'right' });
    await page.locator('[data-row-action="read"]').click();
    await expect(page.locator('[data-inbox-toast]')).toContainText('Marked read');
    await expect(page.locator(`.ib-nrow[data-thread-id="${threads.vendor}"]`)).not.toHaveClass(/\bib-u\b/);
    expect(await look(page, 'ib-nrow', 'ib-title', threads.vendor)).toMatchObject(READ_BESIDE);
  } finally {
    await context.close();
  }
});

test('a 390 px phone: an unread name is 16 px 600, a read one 14 px 400', async ({ browser }: { browser: Browser }) => {
  const context: BrowserContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'light', reducedMotion: 'reduce' });
  try {
    const page = await context.newPage();
    await page.goto(url);
    await expect(page.locator(`.ib-mrow[data-thread-id="${threads.calendar}"]`)).toBeVisible();
    await openQuiet(page);
    await expect(page.locator(`.ib-mrow[data-thread-id="${threads.matcher}"]`)).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    for (const id of [threads.calendar, threads.intercompany, threads.accrual]) {
      const l = await look(page, 'ib-mrow', 'ib-m2', id);
      expect(l, `unread ${id}`).toMatchObject({ unread: true, size: 16, weight: 600 });
      expect(l.spacing, `unread ${id}: tracking`).toBeCloseTo(-0.006 * 16, 3);
    }
    for (const id of [threads.matcher, threads.fx, threads.opened, threads.vendor]) {
      const l = await look(page, 'ib-mrow', 'ib-m2', id);
      expect(l, `read ${id}`).toMatchObject({ unread: false, size: 14, weight: 400 });
      expect(l.spacing, `read ${id}: tracking`).toBe(0);
    }
    await page.screenshot({ path: join(proofDir, 'phone-390.png') });
  } finally {
    await context.close();
  }
});

test('the wide one-line view keeps its 14.5 px name, unread or read', async ({ browser }: { browser: Browser }) => {
  const context: BrowserContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce' });
  try {
    const page = await context.newPage();
    await page.goto(url);
    await expect(page.locator(`.ib-row[data-thread-id="${threads.calendar}"]`)).toBeVisible();
    await openQuiet(page);
    expect(await look(page, 'ib-row', 'ib-title', threads.calendar)).toMatchObject({ unread: true, size: 14.5, weight: 600 });
    expect(await look(page, 'ib-row', 'ib-title', threads.matcher)).toMatchObject({ unread: false, size: 14.5, weight: 400 });
  } finally {
    await context.close();
  }
});
