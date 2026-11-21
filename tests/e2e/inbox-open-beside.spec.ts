/**
 * "Open to the side" (config.json `inboxSplitView`, Settings → General → Appearance, off by default), in a real browser against the compiled
 * binary, with an agent writing through `plannotator inbox mcp` (scripts/inbox-sim.ts):
 *
 * - On, at 1600 by 900 (the list and two 400 px threads fit beside the docked sidebar): a row's menu offers "Open
 *   to the side" while another thread is open; choosing it draws the two threads side by side after the list, which
 *   stays, each its own pane with its own header, reply box and ✕, the person in the new one. A message arriving in
 *   the other pane stays unread there until the person clicks into that pane. The list's edge hides the list (the
 *   pair takes the window) and the first pane's ‹ Inbox brings it back. Closing the second pane is today's one pane.
 * - On, at 1330 with the sidebar docked (two panes fit only with it folded): offered; choosing it folds the sidebar on screen (the person's choice not
 *   written) and closing the second pane brings it back. At 1180 the list and two threads cannot fit: still offered,
 *   the new pane shows, a toast names the pane that stepped aside, and its Undo brings that pane back.
 * - On, at 1920: a row dragged onto a pane's edge opens beside it; a pane dragged by its header goes to another's
 *   half; the ⋯ menu's Move pane up and Close pane do the same without a drag; the layout comes back after a reload.
 * - Off (another Inbox, no key): the item does not exist; Settings' "Threads side by side" turns it on, no reload.
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-open-beside.spec.ts`.
 */
import { expect, test, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { E2E_LAUNCH_OFF, inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(resolve(__dirname, '../..'), '.local/plannotator'));

interface Inbox {
  url: string;
  agent: SimAgent;
  path: string;
  threads: string[];
}

let on: Inbox;
let off: Inbox;

async function start(prefix: string, splitView: boolean): Promise<Inbox> {
  const root = inboxScratch(prefix);
  const data = join(root, 'data');
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, 'config.json'), JSON.stringify({ ...E2E_LAUNCH_OFF, ...(splitView ? { inboxSplitView: true } : {}) }));
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9', PLANNOTATOR_DATA_DIR: data, PLANNOTATOR_TEST_SANDBOX: root, PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_INBOX_TAILSCALE: '0', PLANNOTATOR_INBOX_PHONES: '0', PLANNOTATOR_INBOX_NOTES: '0', PLANNOTATOR_UPDATE_CHECK: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(data);
  const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const path = scratchProject(join(root, 'src'), 'billing-svc');
  const threads: string[] = [];
  for (const [n, subject] of ['Retry worker wired', 'Ledger export ready', 'Webhook signatures checked'].entries()) {
    const sent = await agent.send({ project_path: path, subject, body: `${subject}. Nothing to answer.`, agent_session: `ses_beside_${n}` } as Parameters<SimAgent['send']>[0]);
    threads.push(String(sent.thread_id));
  }
  return { url: started.stdout.trim().replace(/\/$/, ''), agent, path, threads };
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  on = await start('inbox-open-beside-on-', true);
  off = await start('inbox-open-beside-off-', false);
});

test.afterAll(async () => {
  try {
    await on?.agent.close().catch(() => {});
    await off?.agent.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

const pane = (page: Page, thread: string) => page.locator(`section.ib-pane[data-thread-id="${thread}"]`);
/** The free layout's place for a thread's pane (packages/inbox/panes/FreeLayout.tsx): it carries the quieter header's mark. */
const host = (page: Page, thread: string) => page.locator('.ib-layout > [data-layout-pane]', { has: pane(page, thread) });
const row = (page: Page, thread: string) => page.locator(`.ib-listcol .ib-lbody [data-thread-id="${thread}"]`);
const besideItem = (page: Page) => page.locator('[data-row-menu] [data-row-action="open-beside"]');

async function openThread(page: Page, inbox: Inbox, thread: string): Promise<void> {
  await page.goto(`${inbox.url}#thread=${thread}`);
  await expect(pane(page, thread).locator('h2.ib-subject')).toBeVisible({ timeout: 30_000 });
  await expect(row(page, thread)).toBeVisible();
}

test('two threads side by side after the list: each its own pane, unread stays in the other until clicked, the list hides and comes back, and closing one is one pane again', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  const [a, b] = on.threads.slice(-2).reverse() as [string, string];
  await openThread(page, on, a);
  await row(page, b).click({ button: 'right' });
  await expect(besideItem(page)).toHaveText('Open to the side');
  await besideItem(page).click();

  await expect(pane(page, a)).toBeVisible();
  await expect(pane(page, b)).toBeVisible();
  await expect(page.locator('.ib-layout > .pierre-layout-separator')).toHaveCount(1);
  // The list stays, left of the two.
  await expect(page.locator('.ib-listcol')).toBeVisible();
  const list = (await page.locator('.ib-listcol').boundingBox())!;
  expect(list.x + list.width).toBeLessThanOrEqual((await pane(page, a).boundingBox())!.x + 1);
  const [left, right] = [(await pane(page, a).boundingBox())!, (await pane(page, b).boundingBox())!];
  expect(left.x + left.width).toBeLessThanOrEqual(right.x + 1);
  expect(Math.abs(left.width - right.width)).toBeLessThan(24);
  // The person is in the new pane: the address names it, and the first pane's header is the quieter.
  await expect(page).toHaveURL(new RegExp(`#thread=${b}`));
  await expect(host(page, a)).toHaveAttribute('data-pane-quiet', '');
  await expect(host(page, b)).not.toHaveAttribute('data-pane-quiet', '');
  for (const thread of [a, b]) await expect(pane(page, thread).getByRole('button', { name: 'Close the thread' })).toBeVisible();

  // An agent writes in the other pane's thread: it stays unread there while the person is in this one.
  await on.agent.send({ project_path: on.path, reply_to: a, body: 'One more retry case found.', agent_session: 'ses_beside_late' } as Parameters<SimAgent['send']>[0]);
  await expect(pane(page, a).getByText('One more retry case found.')).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(3_000);
  const unseen = () =>
    page.evaluate(async (id) => {
      const list = (await (await fetch('/api/inbox/threads?archived=exclude&snoozed=exclude')).json()) as { sections: { threads: { thread_id: string; unread: boolean }[] }[] };
      return list.sections.flatMap((section) => section.threads).find((row) => row.thread_id === id)?.unread;
    }, a);
  expect(await unseen()).toBe(true);
  // A click in it: the person is there now, and it is seen.
  await pane(page, a).locator('h2.ib-subject').click();
  await expect(page).toHaveURL(new RegExp(`#thread=${a}`));
  await expect(host(page, b)).toHaveAttribute('data-pane-quiet', '');
  await expect.poll(unseen, { timeout: 15_000 }).toBe(false);

  // The list's edge hides the list: the two take the window; the first pane's ‹ Inbox brings it back.
  await page.locator('.ib-listcol [role="separator"][aria-label="List width"]').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.pn-inbox[data-thread-full]')).toHaveCount(1);
  await expect(page.locator('.ib-listcol')).toBeHidden();
  await expect(pane(page, b)).toBeVisible();
  await expect(pane(page, a).locator('[data-full-back]')).toBeVisible();
  await expect(pane(page, b).locator('[data-full-back]')).toHaveCount(0);
  await pane(page, a).locator('[data-full-back]').click();
  await expect(page.locator('.pn-inbox[data-thread-full]')).toHaveCount(0);
  await expect(page.locator('.ib-listcol')).toBeVisible();
  await expect(pane(page, b)).toBeVisible();

  // Closing the second pane: one pane, the list beside it, as before.
  await pane(page, b).getByRole('button', { name: 'Close the thread' }).click();
  await expect(pane(page, b)).toHaveCount(0);
  await expect(page.locator('.ib-layout > .pierre-layout-separator')).toHaveCount(0);
  await expect(host(page, a)).not.toHaveAttribute('data-pane-quiet', '');
  await expect(page.locator('.ib-listcol')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`#thread=${a}`));
});

/** Two fresh threads: the first test read the others, and read rows can fold away under Quiet. */
async function freshPair(tag: string): Promise<[string, string]> {
  const fresh: string[] = [];
  for (const [n, subject] of [`Refund retries capped (${tag})`, `Payout report ready (${tag})`].entries()) {
    const sent = await on.agent.send({ project_path: on.path, subject, body: `${subject}. Nothing to answer.`, agent_session: `ses_beside_${tag}_${n}` } as Parameters<SimAgent['send']>[0]);
    fresh.push(String(sent.thread_id));
  }
  return fresh as [string, string];
}

const sidebar = (page: Page) => page.locator('.pn-inbox .ib-sb');

/**
 * A window where the list and two panes fit only with the docked sidebar folded, with a wide margin both ways
 * (sidebarHold.ts `listAndThreads`: the list's 380 px, two 400 px panes and the gutters, 1180 to 1212 px): 1330 less the
 * 232 px sidebar is 1098, about 100 px short; 1330 is about 120 px more. (1440 folds too, but by 4 px, and only with
 * the Soft panes' 8 px gutters.)
 */
const FOLDS_FOR_TWO = 1330;

test('with room for two panes only without the docked sidebar: offered; choosing it folds the sidebar, and closing the second pane brings it back', async ({ page }) => {
  await page.setViewportSize({ width: FOLDS_FOR_TWO, height: 900 });
  const [a, b] = await freshPair('docked');
  await openThread(page, on, a);
  await expect(sidebar(page)).toHaveAttribute('data-state', 'expanded');
  await row(page, b).click({ button: 'right' });
  await expect(besideItem(page)).toHaveText('Open to the side');
  await besideItem(page).click();
  await expect(pane(page, b)).toBeVisible();
  await expect(pane(page, a)).toBeVisible();
  // The sidebar folded for room: the list stays left of the two, nothing covers it.
  await expect(sidebar(page)).toHaveAttribute('data-state', 'collapsed');
  await expect(page.locator('.ib-listcol')).toBeVisible();
  // Measured once the fold has settled (data-state flips as it starts), both boxes in one frame: during the spring
  // the list and the panes slide left together, so two reads a frame apart differ by the slide.
  await expect(page.locator('.ib-sb-panel[data-hidden]')).toHaveCount(1);
  const [listRight, paneLeft] = await page.evaluate(
    (id) => [document.querySelector('.ib-listcol')!.getBoundingClientRect().right, document.querySelector(`section.ib-pane[data-thread-id="${id}"]`)!.getBoundingClientRect().left],
    a,
  );
  expect(listRight).toBeLessThanOrEqual(paneLeft + 1);
  // The person's choice was not written: a reload would draw it docked.
  expect(await page.evaluate(() => document.cookie)).not.toContain('plannotator-inbox-sidebar-open=false');
  await pane(page, b).getByRole('button', { name: 'Close the thread' }).click();
  await expect(pane(page, b)).toHaveCount(0);
  await expect(sidebar(page)).toHaveAttribute('data-state', 'expanded');
});

test('a window where the list and two threads cannot fit even with the sidebar folded: still offered; the new pane shows, a toast names the pane that stepped aside, and Undo brings it back', async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 900 });
  const [a, b] = await freshPair('narrow');
  await openThread(page, on, a);
  await row(page, b).click({ button: 'right' });
  await expect(besideItem(page)).toHaveText('Open to the side');
  await besideItem(page).click();
  // B alone beside the list: A stepped aside for room (its pane kept off the page, so not in it at all), and the toast says so.
  await expect(pane(page, b)).toBeVisible();
  await expect(pane(page, a)).toHaveCount(0);
  await expect(page.locator('.ib-layout > [data-layout-pane][data-pane-hidden="true"]')).toHaveCount(1);
  await expect(page).toHaveURL(new RegExp(`#thread=${b}`));
  const toast = page.locator('[data-inbox-toast]');
  await expect(toast).toContainText('No room for another pane');
  await expect(toast).toContainText('“Refund retries capped (narrow)” stepped aside');
  // Undo closes the new pane: A is back, alone, and the address names it.
  await toast.locator('[data-toast-undo]').click();
  await expect(pane(page, a)).toBeVisible();
  await expect(pane(page, b)).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`#thread=${a}`));
  await expect(toast).toHaveCount(0);
});

/** A real pointer drag from `from` to `to`, in steps, as a person's mouse moves. */
async function dragBetween(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 12, from.y + 4, { steps: 3 });
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.mouse.up();
}

test('a row dragged onto a pane opens there; a pane dragged by its header moves; the ⋯ menu moves and closes it; the layout survives a reload', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  const [a, b] = await freshPair('drag');
  await openThread(page, on, a);
  // The row onto the right edge of A's pane: B opens right of it, the person in it.
  const rowBox = (await row(page, b).boundingBox())!;
  const aBox = (await pane(page, a).boundingBox())!;
  await dragBetween(page, { x: rowBox.x + 40, y: rowBox.y + rowBox.height / 2 }, { x: aBox.x + aBox.width - 20, y: aBox.y + aBox.height / 2 });
  await expect(pane(page, b)).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`#thread=${b}`));
  const [left, right] = [(await pane(page, a).boundingBox())!, (await pane(page, b).boundingBox())!];
  expect(left.x + left.width).toBeLessThanOrEqual(right.x + 1);
  // B's pane by its header onto the bottom half of A's: one over the other.
  const head = (await pane(page, b).locator('.ib-phead').boundingBox())!;
  const aNow = (await pane(page, a).boundingBox())!;
  await dragBetween(page, { x: head.x + head.width - 120, y: head.y + head.height / 2 }, { x: aNow.x + aNow.width / 2, y: aNow.y + aNow.height - 30 });
  await expect.poll(async () => (await pane(page, b).boundingBox())!.y).toBeGreaterThan(aNow.y + 100);
  // The pane's ⋯ menu: Move pane up puts it back over A; the layout comes back after a reload; Close pane closes it.
  await pane(page, b).locator('[data-thread-more]').click();
  await page.locator('[data-pane-move="top"]').click();
  // Both read on every try: A's place read once, before the move lands, is the top B moves to.
  await expect.poll(async () => (await pane(page, b).boundingBox())!.y < (await pane(page, a).boundingBox())!.y).toBe(true);
  await page.reload();
  await expect(pane(page, a)).toBeVisible({ timeout: 30_000 });
  await expect(pane(page, b)).toBeVisible();
  await pane(page, b).locator('[data-thread-more]').click();
  await page.locator('[data-pane-close]').click();
  await expect(pane(page, b)).toHaveCount(0);
  await expect(page.locator('.ib-layout > .pierre-layout-separator')).toHaveCount(0);
});

test('with the switch off there is no Open to the side; the Settings switch turns it on without a reload', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  const [a, b] = off.threads as [string, string];
  await openThread(page, off, a);
  await row(page, b).click({ button: 'right' });
  await expect(page.locator('[data-row-menu]')).toBeVisible();
  await expect(besideItem(page)).toHaveCount(0);
  await page.keyboard.press('Escape');
  // Settings → General → Appearance: the switch, off by default. On, and back to the thread in the same page.
  // This writes `inboxSplitView: true` into the "off" Inbox's config.json: a test added after this one on `off` finds
  // the switch on (give it its own Inbox, or turn the switch off first).
  await page.goto(`${off.url}#settings`);
  const toggle = page.locator('[data-settings-split-view] button[role="switch"]');
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();
  await expect(page.locator('[data-settings-split-view="on"]')).toHaveCount(1);
  await page.goto(`${off.url}#thread=${a}`);
  await expect(pane(page, a).locator('h2.ib-subject')).toBeVisible({ timeout: 30_000 });
  await row(page, b).click({ button: 'right' });
  await expect(besideItem(page)).toHaveText('Open to the side');
});
