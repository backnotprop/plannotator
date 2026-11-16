/**
 * "Open beside" (config.json `inboxSplitView`, a preview with no Settings row), in a real browser against the compiled
 * binary, with an agent writing through `plannotator inbox mcp` (scripts/inbox-sim.ts):
 *
 * - On, at 1600 by 900 (the list and two 440 px threads fit beside the docked sidebar): a row's menu offers "Open
 *   beside" while another thread is open; choosing it draws the two threads side by side after the list, which
 *   stays, each its own pane with its own header, reply box and ✕, the person in the new one. A message arriving in
 *   the other pane stays unread there until the person clicks into that pane. The list's edge hides the list (the
 *   pair takes the window) and the first pane's ‹ Inbox brings it back. Closing the second pane is today's one pane.
 * - On, at 1440 with the sidebar docked: no room for the list and two threads, so no item.
 * - Off (another Inbox, no key): the item does not exist.
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
  await expect(besideItem(page)).toHaveText('Open beside');
  await besideItem(page).click();

  await expect(pane(page, a)).toBeVisible();
  await expect(pane(page, b)).toBeVisible();
  await expect(page.locator('.ib-main > [data-pane-split]')).toHaveCount(1);
  // The list stays, left of the two.
  await expect(page.locator('.ib-listcol')).toBeVisible();
  const list = (await page.locator('.ib-listcol').boundingBox())!;
  expect(list.x + list.width).toBeLessThanOrEqual((await pane(page, a).boundingBox())!.x + 1);
  const [left, right] = [(await pane(page, a).boundingBox())!, (await pane(page, b).boundingBox())!];
  expect(left.x + left.width).toBeLessThanOrEqual(right.x + 1);
  expect(Math.abs(left.width - right.width)).toBeLessThan(24);
  // The person is in the new pane: the address names it, and the first pane's header is the quieter.
  await expect(page).toHaveURL(new RegExp(`#thread=${b}`));
  await expect(pane(page, a)).toHaveAttribute('data-pane-quiet', '');
  await expect(pane(page, b)).not.toHaveAttribute('data-pane-quiet', '');
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
  await expect(pane(page, b)).toHaveAttribute('data-pane-quiet', '');
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
  await expect(page.locator('.ib-main > [data-pane-split]')).toHaveCount(0);
  await expect(pane(page, a)).not.toHaveAttribute('data-pane-quiet', '');
  await expect(page.locator('.ib-listcol')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`#thread=${a}`));
});

test('at 1440 with the sidebar docked the list and two threads do not fit: no Open beside', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // Two fresh threads: the first test read the others, and read rows can fold away under Quiet.
  const fresh: string[] = [];
  for (const [n, subject] of ['Refund retries capped', 'Payout report ready'].entries()) {
    const sent = await on.agent.send({ project_path: on.path, subject, body: `${subject}. Nothing to answer.`, agent_session: `ses_beside_narrow_${n}` } as Parameters<SimAgent['send']>[0]);
    fresh.push(String(sent.thread_id));
  }
  const [a, b] = fresh as [string, string];
  await openThread(page, on, a);
  await row(page, b).click({ button: 'right' });
  await expect(page.locator('[data-row-menu]')).toBeVisible();
  await expect(besideItem(page)).toHaveCount(0);
});

test('with the switch off there is no Open beside', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  const [a, b] = off.threads as [string, string];
  await openThread(page, off, a);
  await row(page, b).click({ button: 'right' });
  await expect(page.locator('[data-row-menu]')).toBeVisible();
  await expect(besideItem(page)).toHaveCount(0);
});
