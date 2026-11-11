/**
 * A thread's pull requests on a phone, in a real browser against the compiled
 * binary: the thread header's PR button opens the list as a bottom sheet that
 * floats as the thread's ⋯ sheet does: the same inset from the screen's sides
 * and bottom edge, all corners rounded alike.
 *
 * What regresses: the Pull requests page's popover (prs/prs.css) also uses the
 * `.ib-prpop` class, and its rules come later than the thread card's own, so
 * on a phone the sheet was drawn 352 px wide from the left edge (the thread
 * showing down the right side), with all four corners rounded and an outline
 * all round. A tablet gets the card anchored to the button, as its ⋯ menus
 * do, not a sheet.
 *
 * Build the binary first (see inbox.spec.ts). PLANNOTATOR_E2E_BINARY names
 * another binary (an older release, to see the bug).
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));

const PULLS = ['https://github.com/acme/widgets/pull/3092', 'https://github.com/acme/widgets/pull/3094', 'https://github.com/acme/widgets/pull/3096'];
const SUBJECT = 'Checkout retry and receipts';

let world: { url: string; threadId: string; claude: SimAgent };

test.beforeAll(async () => {
  test.setTimeout(180_000);
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-thread-pulls-sheet-');
  const dataDir = join(root, 'data');
  markTourDecided(dataDir);
  for (const dir of ['claude', 'codex', 'xdg']) mkdirSync(join(root, dir), { recursive: true });
  // Nothing reaches a forge: gh and glab are signed-out fakes.
  const stubs = join(root, 'stubs');
  mkdirSync(stubs, { recursive: true });
  writeFileSync(join(stubs, 'gh'), `#!/bin/sh\necho 'You are not logged into any GitHub hosts.' >&2\nexit 1\n`);
  writeFileSync(join(stubs, 'glab'), `#!/bin/sh\nexit 1\n`);
  for (const name of ['gh', 'glab', 'open', 'xdg-open']) {
    if (!existsSync(join(stubs, name))) writeFileSync(join(stubs, name), '#!/bin/sh\nexit 0\n');
    chmodSync(join(stubs, name), 0o755);
  }
  const env: Record<string, string> = {
    PATH: `${stubs}:${process.env.PATH ?? ''}`,
    HOME: root,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_ANON_PING: '1',
    PLANNOTATOR_INBOX_NOTES: '0',
    PLANNOTATOR_TEST_SANDBOX: '1',
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    CODEX_HOME: join(root, 'codex'),
    XDG_CONFIG_HOME: join(root, 'xdg'),
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  const url = started.stdout.trim();
  // Never the person's own Inbox.
  expect(url).not.toContain(':49606');
  expect(url).not.toContain(':59812');
  const project = scratchProject(join(root, 'src'), 'widgets');
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const sent = await claude.send({ project_path: project, subject: SUBJECT, body: 'The retry fix is merged; the receipts change is open.', pulls: PULLS } as never);
  world = { url, threadId: sent.thread_id as string, claude };
});

test.afterAll(async () => {
  try {
    await world?.claude.close();
  } finally {
    await removeInboxScratch();
  }
});

async function openPulls(browser: Browser, viewport: { width: number; height: number }): Promise<Page> {
  const page = await (await browser.newContext({ viewport, isMobile: true, hasTouch: true, reducedMotion: 'reduce' })).newPage();
  await page.goto(world.url);
  await page.locator(`.ib-lbody [data-thread-id="${world.threadId}"]`).first().click();
  const button = page.locator('[data-pr-button]').first();
  await expect(button).toHaveAttribute('data-pr-n', '3');
  await button.tap();
  await expect(page.locator('[data-pr-popover] [data-pr-row]')).toHaveCount(3);
  return page;
}

/**
 * A sheet's gaps to the window's left, right and bottom edges, and its corners. It runs in the page
 * (`locator.evaluate`), so it reads nothing from this file's scope: only the element it is given.
 */
function placeOf(el: Element) {
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  return { left: Math.round(r.left), right: Math.round(innerWidth - r.right), bottom: Math.round(innerHeight - r.bottom), corners: [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius] };
}

test("a phone: the thread's PRs open as a sheet that floats as the thread's ⋯ sheet does, at the bottom", async ({ browser }) => {
  for (const viewport of [{ width: 390, height: 844 }, { width: 360, height: 640 }]) {
    const page = await openPulls(browser, viewport);
    const sheet = page.locator('[data-pr-popover]');
    await expect(sheet).toHaveAttribute('data-sheet', '');
    const pulls = await sheet.evaluate(placeOf);
    const field = (await page.locator('[data-pr-add-input]').boundingBox())!;
    // A tap on the scrim closes it.
    await page.locator('[data-pr-scrim]').tap({ position: { x: 20, y: 20 } });
    await expect(sheet).toHaveCount(0);
    // The thread's ⋯ sheet, in the same window.
    await page.locator('[data-thread-more]').first().tap();
    const menu = page.locator('.ib-pm-pos[data-phone] .ib-pm');
    await expect(menu).toBeVisible();
    await page.waitForTimeout(400);
    const more = await menu.evaluate(placeOf);
    const seen = JSON.stringify({ viewport, pulls, more });
    // The same inset on each side and at the bottom, a small one (not flush, not the old 352 px card from the left).
    expect(pulls.left, seen).toBe(more.left);
    expect(pulls.right, seen).toBe(more.right);
    expect(pulls.bottom, seen).toBe(more.bottom);
    expect(pulls.left, seen).toBeGreaterThan(0);
    expect(pulls.left, seen).toBeLessThan(24);
    expect(pulls.left, seen).toBe(pulls.right);
    // Every corner rounded, as the ⋯ sheet's.
    expect(pulls.corners, seen).toEqual(more.corners);
    expect(pulls.corners[2], seen).not.toBe('0px');
    // The Add field has the row's width beside Add.
    expect(field.width, seen).toBeGreaterThan(viewport.width * 0.65);
    await page.context().close();
  }
});

test("a tablet: the thread's PRs open as the card under the button, as its ⋯ menu does", async ({ browser }) => {
  const page = await openPulls(browser, { width: 820, height: 1180 });
  const card = page.locator('[data-pr-popover]');
  await expect(card).not.toHaveAttribute('data-sheet', '');
  const box = (await card.boundingBox())!;
  const button = (await page.locator('[data-pr-button]').first().boundingBox())!;
  expect(box.width).toBeLessThan(820);
  expect(box.y).toBeGreaterThan(button.y + button.height - 1);
  await page.context().close();
});
