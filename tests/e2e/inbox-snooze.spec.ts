/**
 * Snooze (approval "inbox-snooze") in a real browser against the compiled
 * binary, with agents writing through `plannotator inbox mcp`
 * (scripts/inbox-sim.ts):
 *
 *  - the row's right-click menu: Snooze swaps the menu in place for its times;
 *    Tomorrow takes the thread out of its section and the counts into the
 *    folded Snoozed band; the toast's Undo puts it back;
 *  - the thread's ⋯ menu: Pick a time, two lists, by mouse, wheel and keys;
 *    the thread says "Snoozed until …" and Unsnooze ends it;
 *  - a Stopped thread: the folded band shows the triangle;
 *  - an agent's new question does not end a snooze; the person's reply does;
 *  - the return at its time (a short `until` through the window's own
 *    route): back in New, bold, with the clock until read;
 *  - a restart of the Inbox keeps a snooze;
 *  - a second window follows a snooze made in the first;
 *  - an iPhone in WebKit: ⋯ only, the times as a sheet.
 *
 * Light, dark and phone screenshots land in PLANNOTATOR_SNOOZE_SHOTS (default
 * .local/proof/snooze). Build the binary first (see inbox.spec.ts), then
 * `bun run test:e2e:inbox inbox-snooze`.
 */

import { devices, expect, test, webkit, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { inboxScratch, rememberInboxOf, removeInboxScratch, stopScratchInbox } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shots = resolve(process.env.PLANNOTATOR_SNOOZE_SHOTS ?? join(repo, '.local/proof/snooze'));

const ask = (prompt: string, extra: string[] = []) => [`${prompt}`, '', ':::question', prompt, '', ...extra, ...(extra.length ? [''] : []), '- [ ] Yes', '- [ ] No', ':::'].join('\n');
const STOPPED = ask('Rotate the staging signing key now?', ['Stopped: the migration cannot run with an expired key.']);

interface World {
  url: string;
  dataDir: string;
  env: Record<string, string>;
  agents: { claude: SimAgent; codex: SimAgent; pi: SimAgent };
  context: BrowserContext;
  page: Page;
  errors: string[];
  projects: { billing: string; pando: string; docs: string };
  threads: { refund: string; release: string; stopped: string; webhook: string; flags: string };
  messages: { flags: string };
}

let world: World;

test.describe.configure({ mode: 'serial' });

const row = (page: Page, id: string) => page.locator(`.ib-lbody [data-thread-id="${id}"]`);
const band = (page: Page) => page.locator('[data-section-id="snoozed"]');
const bandButton = (page: Page) => band(page).locator('.ib-band');
const groupOf = (page: Page, id: string) => row(page, id).evaluate((el) => el.closest('[data-section-id]')?.getAttribute('data-section-id') ?? null);
const inboxCount = (page: Page) => page.locator('.ib-nav-inbox .ib-n');
const toast = (page: Page) => page.locator('[data-inbox-toast]');

async function shot(page: Page, name: string) {
  await page.waitForTimeout(350);
  await page.screenshot({ path: join(shots, name) });
}

/** Snooze or unsnooze through the window's own route, from the page (same origin, its serverSession). */
async function snoozeFromPage(page: Page, id: string, until: string | null) {
  await page.evaluate(
    async ([threadId, value]) => {
      const list = (await (await fetch('/api/inbox/threads?archived=exclude')).json()) as { serverSession: string };
      const res = await fetch(`/api/inbox/threads/${threadId}/snooze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serverSession: list.serverSession, until: value }) });
      if (!res.ok) throw new Error(`snooze ${res.status}`);
    },
    [id, until] as const,
  );
}

const inHours = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();

function startInbox(env: Record<string, string>): string {
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  return started.stdout.trim();
}

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(shots, { recursive: true, force: true });
  mkdirSync(shots, { recursive: true });
  const root = inboxScratch('plannotator-inbox-zz-e2e-');
  const dataDir = join(root, 'data');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const url = startInbox(env);
  const src = join(root, 'src');
  const billing = scratchProject(src, 'billing-svc');
  const pando = scratchProject(src, 'pando');
  const docs = scratchProject(src, 'docs-site');
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const codex = await SimAgent.connect({ binary, env, name: 'Codex', host: 'codex' });
  const pi = await SimAgent.connect({ binary, env, name: 'Pi', host: 'pi' });
  const flags = await pi.send({ project_path: docs, subject: 'Remove the old feature flags', thread: 'old-flags', body: ask('Remove the old feature flags?') });
  const webhook = await claude.send({ project_path: billing, subject: 'Stripe webhook replay finished', thread: 'webhook-replay', body: 'The replay finished: 412 events, none failed.' });
  const release = await claude.send({ project_path: pando, subject: 'Review the 0.9 release notes', thread: 'release-notes', body: ask('Ship the 0.9 release notes as drafted?') });
  const refund = await codex.send({ project_path: billing, subject: 'Which refund window applies to annual plans?', thread: 'refund-window', body: ask('Use 30 days for annual plans?') });
  const stopped = await claude.send({ project_path: pando, subject: 'Rotate the staging signing key before the migration?', thread: 'key-rotation', body: STOPPED });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  world = {
    url,
    dataDir,
    env,
    agents: { claude, codex, pi },
    context,
    page,
    errors,
    projects: { billing, pando, docs },
    threads: {
      refund: refund.thread_id as string,
      release: release.thread_id as string,
      stopped: stopped.thread_id as string,
      webhook: webhook.thread_id as string,
      flags: flags.thread_id as string,
    },
    messages: { flags: flags.message_id as string },
  };
  await page.goto(url);
  await expect(row(page, world.threads.refund)).toBeVisible();
});

test.afterAll(async () => {
  try {
    if (!world) return;
    for (const agent of Object.values(world.agents)) await agent.close().catch(() => {});
    await world.context.close();
  } finally {
    await removeInboxScratch();
  }
});

test('the row menu: Snooze swaps the menu for its times; Tomorrow moves the thread into the folded band; Undo puts it back', async () => {
  const { page, threads } = world;
  await expect(band(page)).toHaveCount(0);
  await expect(inboxCount(page)).toHaveText('4');
  await row(page, threads.refund).click({ button: 'right' });
  const menu = page.locator(`[data-row-menu="${threads.refund}"]`);
  await expect(menu).toBeVisible();
  const before = await menu.boundingBox();
  // Hover moves nothing: the same menu, the same place.
  await menu.locator('[data-row-action="snooze"]').hover();
  expect(await menu.boundingBox()).toEqual(before);
  await shot(page, 'row-menu-light.png');
  await menu.locator('[data-row-action="snooze"]').click();
  // In place: the same popup now holds the times, each with its real time, and nothing else of the menu.
  await expect(menu.locator('[data-snooze-view="times"]')).toBeVisible();
  await expect(menu.locator('[data-row-action="copy-link"]')).toHaveCount(0);
  await expect(menu.locator('[data-snooze-choice="tomorrow"] .ib-zw')).toHaveText(/^\w{3} 8:00 AM$/);
  await expect(menu.locator('[data-snooze-choice="week"]')).toBeVisible();
  await expect(menu.locator('[data-snooze-pick-time]')).toBeVisible();
  await shot(page, 'row-menu-times-light.png');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, 'row-menu-times-dark.png');
  await page.emulateMedia({ colorScheme: 'light' });
  await menu.locator('[data-snooze-choice="tomorrow"]').click();
  await expect(menu).toHaveCount(0);
  await expect(toast(page)).toContainText('Snoozed');
  await expect(toast(page)).toContainText(/\w{3} 8:00 AM/);
  // Out of its section and the counts, into the band, folded.
  await expect(row(page, threads.refund)).toHaveCount(0);
  await expect(bandButton(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(bandButton(page)).toContainText('Snoozed 1');
  await expect(inboxCount(page)).toHaveText('3');
  await shot(page, 'toast-light.png');
  await toast(page).locator('[data-toast-undo]').click();
  await expect(row(page, threads.refund)).toBeVisible();
  expect(await groupOf(page, threads.refund)).toBe('waiting');
  await expect(band(page)).toHaveCount(0);
  await expect(inboxCount(page)).toHaveText('4');
  expect(world.errors).toEqual([]);
});

test("the ⋯ menu: Pick a time, two lists by mouse, wheel and keys; the thread says until when, opening it keeps the snooze, Unsnooze ends it", async () => {
  const { page, threads } = world;
  await row(page, threads.release).click();
  await expect(page).toHaveURL(new RegExp(`thread=${threads.release}`));
  await page.locator('[data-thread-more]').click();
  const menu = page.locator('[data-thread-menu]');
  await expect(menu.getByRole('menuitem').first()).toHaveText('Snooze');
  await shot(page, 'thread-menu-light.png');
  await menu.locator('[data-thread-snooze-item]').click();
  await expect(menu.locator('[data-snooze-view="times"]')).toBeVisible();
  await menu.locator('[data-snooze-pick-time]').click();
  const picker = menu.locator('[data-snooze-picker]');
  await expect(picker).toBeVisible();
  const days = picker.locator('[data-snooze-list="Day"]');
  const times = picker.locator('[data-snooze-list="Time"]');
  // The first position: two days out, 3:00 PM, each centred in its list.
  await expect(days).toBeFocused();
  await expect(days.locator('[aria-selected="true"]')).toHaveCount(1);
  await expect(times.locator('[aria-selected="true"]')).toHaveText('3:00 PM');
  await shot(page, 'picker-light.png');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, 'picker-dark.png');
  await page.emulateMedia({ colorScheme: 'light' });
  // Keys: Down a day, Right to the times, Down half an hour.
  const firstDay = await days.locator('[aria-selected="true"]').textContent();
  await page.keyboard.press('ArrowDown');
  await expect(days.locator('[aria-selected="true"]')).not.toHaveText(firstDay!);
  await page.keyboard.press('ArrowRight');
  await expect(times).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(times.locator('[aria-selected="true"]')).toHaveText('3:30 PM');
  // Wheel: the list scrolls, nothing else moves.
  const box = await picker.boundingBox();
  const scrolled = await times.evaluate((el) => el.scrollTop);
  await times.hover();
  await page.mouse.wheel(0, 240);
  await expect.poll(() => times.evaluate((el) => el.scrollTop)).toBeGreaterThan(scrolled);
  expect(await picker.boundingBox()).toEqual(box);
  // Mouse: a click picks 4:00 PM.
  await times.locator('[role="option"]', { hasText: /^4:00 PM$/ }).click();
  await expect(times.locator('[aria-selected="true"]')).toHaveText('4:00 PM');
  await picker.locator('[data-snooze-go]').click();
  await expect(menu).toHaveCount(0);
  await expect(toast(page)).toContainText('4:00 PM');
  // Open, it says until when; the thread stays open and snoozed (opening never ends it).
  const line = page.locator('[data-snooze-line]');
  await expect(line).toContainText(/^Snoozed until \w{3} 4:00 PM|^Snoozed until \w{3} \d+, 4:00 PM/);
  await bandButton(page).click();
  await expect(bandButton(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(row(page, threads.release).locator('[data-snoozed-until]')).toContainText('4:00 PM');
  await shot(page, 'thread-light.png');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, 'thread-dark.png');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.reload();
  await expect(page.locator('[data-snooze-line]')).toBeVisible();
  await page.locator('[data-unsnooze]').click();
  await expect(page.locator('[data-snooze-line]')).toHaveCount(0);
  await expect(toast(page)).toContainText('Unsnoozed');
  await expect(band(page)).toHaveCount(0);
  await page.locator('section.ib-pane').getByRole('button', { name: 'Close the thread' }).click();
  expect(await groupOf(page, threads.release)).toBe('waiting');
  expect(world.errors).toEqual([]);
});

test('a Stopped thread snoozed: the folded band shows the triangle; open, the row keeps its badge and says until when', async () => {
  const { page, threads } = world;
  await snoozeFromPage(page, threads.stopped, inHours(30));
  await expect(row(page, threads.stopped)).toHaveCount(0);
  const blocker = bandButton(page).locator('[data-snooze-blocker]');
  await expect(blocker).toHaveAttribute('data-stopped', '');
  await expect(blocker).toHaveAccessibleName('A snoozed thread is stopped on you');
  await shot(page, 'folded-light.png');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, 'folded-dark.png');
  await page.emulateMedia({ colorScheme: 'light' });
  await bandButton(page).click();
  await expect(blocker).toHaveCount(0);
  await expect(row(page, threads.stopped).locator('[data-snoozed-until]')).toBeVisible();
  await expect(row(page, threads.stopped)).toContainText('Stopped');
  await shot(page, 'band-open-light.png');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, 'band-open-dark.png');
  await page.emulateMedia({ colorScheme: 'light' });
  await snoozeFromPage(page, threads.stopped, null);
  await expect(band(page)).toHaveCount(0);
});

test("an agent's new question does not end a snooze; the person's own reply does", async () => {
  const { page, threads, agents, projects, messages } = world;
  await snoozeFromPage(page, threads.flags, inHours(30));
  await expect(row(page, threads.flags)).toHaveCount(0);
  await expect(inboxCount(page)).toHaveText('3');
  await agents.pi.send({ project_path: projects.docs, reply_to: messages.flags, body: ask('Also drop the flag cleanup cron?') });
  // The window hears the agent; the thread stays in the band, out of the count.
  await page.waitForTimeout(800);
  await expect(page.locator('[data-inbox-notice]')).toHaveCount(0);
  await expect(bandButton(page)).toContainText('Snoozed 1');
  await expect(inboxCount(page)).toHaveText('3');
  // The person's reply (the window's own route) ends it: out of the band, into Sent.
  await page.evaluate(
    async ([messageId]) => {
      const list = (await (await fetch('/api/inbox/threads?archived=exclude')).json()) as { serverSession: string };
      const res = await fetch(`/api/inbox/messages/${messageId}/reply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serverSession: list.serverSession, idempotency_key: 'zz-reply-1', words: 'Remove them; keep the cron.' }) });
      if (!res.ok) throw new Error(`reply ${res.status}`);
    },
    [messages.flags] as const,
  );
  await expect(band(page)).toHaveCount(0);
  await expect(row(page, threads.flags)).toBeVisible();
});

test('the return at its time: back in its own section (Quiet comes back as New), bold, the clock until read', async () => {
  const { page, threads } = world;
  // A thread looked at sits in Quiet; its return brings it back as New.
  await row(page, threads.webhook).click();
  await page.locator('section.ib-pane').getByRole('button', { name: 'Close the thread' }).click();
  await expect.poll(() => groupOf(page, threads.webhook)).toBe('quiet');
  await snoozeFromPage(page, threads.webhook, new Date(Date.now() + 4000).toISOString());
  await expect(bandButton(page)).toContainText('Snoozed 1');
  // No reload, no agent: the server's timer tells the window at the time. The list never moves under the
  // reader: the return waits behind "1 new", as an agent's message does, and Show brings it in.
  const notice = page.locator('[data-inbox-notice]');
  await expect(notice).toContainText('1 new', { timeout: 12_000 });
  await notice.click();
  await expect.poll(() => groupOf(page, threads.webhook)).toBe('new');
  await expect(row(page, threads.webhook)).toHaveClass(/\bib-u\b/);
  await expect(row(page, threads.webhook).locator('[data-snooze-back-mark]')).toBeVisible();
  await expect(band(page)).toHaveCount(0);
  await shot(page, 'returned-light.png');
  // Read, the clock goes.
  await row(page, threads.webhook).click();
  await page.locator('section.ib-pane').getByRole('button', { name: 'Close the thread' }).click();
  await expect(row(page, threads.webhook).locator('[data-snooze-back-mark]')).toHaveCount(0);
});

test('a restart of the Inbox keeps a snooze', async () => {
  const { page, threads } = world;
  await snoozeFromPage(page, threads.refund, inHours(30));
  await expect(bandButton(page)).toContainText('Snoozed 1');
  const mark = world.errors.length;
  await stopScratchInbox(world.dataDir);
  world.url = startInbox(world.env);
  rememberInboxOf(world.dataDir);
  await page.goto(world.url);
  await page.reload();
  await expect(bandButton(page)).toContainText('Snoozed 1');
  await expect(row(page, threads.refund)).toHaveCount(0);
  world.errors.splice(mark, world.errors.length - mark, ...world.errors.slice(mark).filter((e) => !/net::ERR_|Failed to fetch|Load failed/.test(e)));
  await snoozeFromPage(page, threads.refund, null);
  await expect(band(page)).toHaveCount(0);
});

test('a second window follows a snooze made in the first', async () => {
  const { page, threads, context } = world;
  const second = await context.newPage();
  try {
    await second.goto(world.url);
    await expect(row(second, threads.release)).toBeVisible();
    await row(page, threads.release).click({ button: 'right' });
    const menu = page.locator(`[data-row-menu="${threads.release}"]`);
    await menu.locator('[data-row-action="snooze"]').click();
    await menu.locator('[data-snooze-choice="week"]').click();
    await expect(row(second, threads.release)).toHaveCount(0);
    await expect(bandButton(second)).toContainText('Snoozed 1');
    // Unsnooze from the first's row menu: the second follows again.
    if ((await bandButton(page).getAttribute('aria-expanded')) !== 'true') await bandButton(page).click();
    await row(page, threads.release).click({ button: 'right' });
    await page.locator(`[data-row-menu="${threads.release}"] [data-row-action="unsnooze"]`).click();
    await expect(band(second)).toHaveCount(0);
    await expect(row(second, threads.release)).toBeVisible();
  } finally {
    await second.close();
  }
  expect(world.errors).toEqual([]);
});

test.describe('iPhone 15 (WebKit)', () => {
  const { defaultBrowserType: _browser, ...device } = devices['iPhone 15'];
  let browser: Browser | null = null;
  test.beforeAll(async () => {
    // WebKit refuses the config's Chromium flags.
    browser = await webkit.launch({ args: [] });
  });
  test.afterAll(async () => {
    await browser?.close();
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`⋯ only: Snooze, its times as a sheet, Pick a time; the list's band (${scheme})`, async () => {
      const { threads } = world;
      const context = await browser!.newContext({ ...device, colorScheme: scheme });
      try {
        const page = await context.newPage();
        await page.goto(world.url);
        const mrow = page.locator(`.ib-mrow[data-thread-id="${threads.refund}"]`);
        await expect(mrow).toBeVisible();
        await mrow.tap();
        await page.locator('[data-thread-more]').tap();
        const menu = page.locator('[data-thread-menu]');
        const item = menu.locator('[data-thread-snooze-item]');
        expect(Math.round((await item.boundingBox())!.height)).toBeGreaterThanOrEqual(44);
        await shot(page, `phone-menu-${scheme}.png`);
        await item.tap();
        await expect(menu.locator('[data-snooze-view="times"]')).toBeVisible();
        const sheet = await menu.boundingBox();
        expect(sheet!.y + sheet!.height).toBeGreaterThan(device.viewport.height - 40);
        await shot(page, `phone-times-${scheme}.png`);
        await menu.locator('[data-snooze-pick-time]').tap();
        const picker = menu.locator('[data-snooze-picker]');
        await expect(picker).toBeVisible();
        const option = picker.locator('[data-snooze-list="Time"] [role="option"]').first();
        expect(Math.round((await option.boundingBox())!.height)).toBeGreaterThanOrEqual(44);
        await shot(page, `phone-picker-${scheme}.png`);
        await menu.locator('[data-snooze-back]').tap();
        await menu.locator('[data-snooze-choice="tomorrow"]').tap();
        await expect(page.locator('[data-snooze-line]')).toBeVisible();
        await shot(page, `phone-thread-${scheme}.png`);
        await page.locator('[data-phone-back]').tap();
        await expect(mrow).toHaveCount(0);
        await page.locator('[data-section-id="snoozed"] .ib-band').tap();
        await expect(mrow.locator('[data-snoozed-until]')).toBeVisible();
        await shot(page, `phone-band-${scheme}.png`);
      } finally {
        await context.close();
      }
      await snoozeFromPage(world.page, threads.refund, null);
    });
  }
});
