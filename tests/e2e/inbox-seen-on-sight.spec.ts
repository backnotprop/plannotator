/**
 * A new message in the thread you have open (design record
 * "inbox-new-in-open-thread", variant A "seen on sight", approved 2026-10-12;
 * not in this repo), proved in real browsers against the compiled binary,
 * with an agent writing into the open thread through `plannotator inbox mcp`
 * (scripts/inbox-sim.ts):
 *
 * - At the end of the thread: the arrival scrolls just into view, a screen
 *   reader hears it, the row goes bold in place, and about a second later it
 *   counts as seen (the store's look covers it) and the row unbolds in place.
 *   The "N new · Show" line never counts or names the open thread; another
 *   thread's news still waits behind it.
 * - Scrolled up: nothing moves, the pill says "1 new" and goes to it; the
 *   store keeps it unseen until it has been on screen. With messages new at
 *   the open also below the view, the pill counts the arrival alone and one
 *   click lands on it.
 * - Closed before seeing it: the row settles unread (Waiting, it asks).
 *   Closed after seeing it: Quiet.
 * - A phone (WebKit, iPhone 15): the same rule; Back shows the row unbolded in
 *   place when seen, and back unread in Waiting when not. An arrival under a
 *   bottom sheet (New message's "not running" sheet) is not seen until the
 *   sheet closes.
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 * PNGs land in .local/proof/seen-on-sight/ (PLANNOTATOR_E2E_PROOF_DIR).
 */

import { devices, expect, test, webkit, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'seen-on-sight');

/** seenOnSight.ts: the dwell. */
const DWELL_MS = 1000;

/** A first message long enough that the thread scrolls. */
const LONG = ['The refund pipeline, step by step.', ...Array.from({ length: 40 }, (_, i) => `Step ${i + 1}: the worker reads the event, checks the idempotency key, and writes the ledger row.`)].join('\n\n');
const QUESTION = [':::question', 'Retry a refund on a Stripe 409?', '', '- [ ] Yes, with the same key', '- [ ] No, dead-letter it', ':::'].join('\n');

type Key = 'end' | 'up' | 'pill' | 'unseen' | 'seen' | 'phoneSeen' | 'phoneUnseen' | 'phoneSheet' | 'other';

interface World {
  url: string;
  agent: SimAgent;
  projects: Record<Key, { path: string; id: string; thread: string; root: string }>;
}

let world: World;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-seen-on-sight-e2e-');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: join(root, 'data'), PLANNOTATOR_BROWSER: 'none' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const projects = {} as World['projects'];
  const bodies: Record<Key, string> = {
    end: 'The refund webhook is wired.',
    up: LONG,
    pill: 'The refund webhook is wired.',
    unseen: LONG,
    seen: 'The refund webhook is wired.',
    phoneSeen: 'The refund webhook is wired.',
    phoneUnseen: LONG,
    phoneSheet: LONG,
    other: 'Unrelated.',
  };
  for (const key of ['end', 'up', 'pill', 'unseen', 'seen', 'phoneSeen', 'phoneUnseen', 'phoneSheet'] as const) {
    const path = scratchProject(join(root, 'src'), `billing-${key}`);
    const sent = await agent.send({ project_path: path, subject: `Refund events (${key})`, body: bodies[key], agent_session: `ses_${key}` } as Parameters<SimAgent['send']>[0]);
    projects[key] = { path, id: '', thread: String(sent.thread_id), root: String(sent.message_id) };
  }
  projects.other = { path: scratchProject(join(root, 'src'), 'docs-other'), id: '', thread: '', root: '' };
  const url = started.stdout.trim().replace(/\/$/, '');
  const list = (await (await fetch(`${url}/api/inbox/projects`)).json()) as { projects: { id: string; root: string }[] };
  for (const project of Object.values(projects)) project.id = list.projects.find((p) => p.root === project.path)?.id ?? '';
  world = { url, agent, projects };
});

test.afterAll(async () => {
  try {
    await world?.agent.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

const row = (page: Page, id: string) => page.locator(`.ib-listcol .ib-lbody [data-thread-id="${id}"]`);
const isBold = (page: Page, id: string) => row(page, id).evaluate((r) => r.classList.contains('ib-u'));
const sectionOf = (page: Page, id: string) =>
  row(page, id).evaluateAll((rows) => rows[0]?.closest('[data-section-id]')?.getAttribute('data-section-id') ?? null);
const rowsOf = (page: Page) => page.locator('.ib-listcol .ib-lbody [data-thread-id]').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-thread-id')!));
/** What the store says about the thread now (its list row). */
async function storeRow(threadId: string): Promise<{ section: string; unseen: number; unread: boolean }> {
  const answer = (await (await fetch(`${world.url}/api/inbox/threads/${threadId}`)).json()) as { row: { section: string; unseen: number; unread: boolean } };
  return answer.row;
}
const reply = (key: Key, body: string) => world.agent.send({ project_path: world.projects[key].path, reply_to: world.projects[key].root, body });
const noticeText = (page: Page) => page.locator('[data-inbox-notice]').evaluateAll((n) => n.map((e) => e.textContent ?? '').join(' '));

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(proofDir, `${name}.png`) });
}

async function openRow(page: Page, key: Key, tap = false): Promise<void> {
  const id = world.projects[key].thread;
  if (tap) await row(page, id).tap();
  else await row(page, id).click();
  await expect(page.locator('section.ib-pane')).toBeVisible();
  await expect.poll(() => isBold(page, id)).toBe(false);
  await expect.poll(async () => (await storeRow(id)).unseen).toBe(0);
}

async function inFront(page: Page): Promise<void> {
  await page.bringToFront();
  await expect.poll(() => page.evaluate(() => document.visibilityState === 'visible' && document.hasFocus())).toBe(true);
}

test('desktop, at the end of the thread: the arrival scrolls into view, the row bolds in place, and a second later it is seen', async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  try {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${world.url}/`);
    await inFront(page);
    const id = world.projects.end.thread;
    await expect(row(page, id)).toBeVisible();
    await openRow(page, 'end');
    const order = await rowsOf(page);
    const section = await sectionOf(page, id);

    // The agent answers in the open thread, and starts a thread elsewhere.
    const arrived = await reply('end', 'Retries are on: three attempts, then the dead-letter queue.');
    await world.agent.send({ project_path: world.projects.other.path, subject: 'Docs deploy', body: 'The docs deploy finished.', agent_session: 'ses_other' } as Parameters<SimAgent['send']>[0]);
    const article = page.locator(`[data-message-article="${arrived.message_id}"]`);
    await expect(article).toBeVisible();
    await expect(page.locator('[data-fold-live]')).toHaveText('New message from Claude Code');
    // In place and bold, before the dwell: the store still has it unseen.
    await expect.poll(() => isBold(page, id)).toBe(true);
    expect(await rowsOf(page)).toEqual(order);
    expect(await sectionOf(page, id)).toBe(section);
    expect((await storeRow(id)).unseen).toBe(1);
    // The Show line counts only the other thread, and names only its project.
    await expect(page.locator('[data-inbox-notice]')).toContainText('1 new in docs-other');
    expect(await noticeText(page)).not.toContain('billing-end');
    await shot(page, '01-desktop-arrived-bold');
    // Its first lines are on screen (the view followed it to the end).
    const box = await article.evaluate((a) => {
      const body = a.closest('.ib-pbody')!.getBoundingClientRect();
      const r = a.getBoundingClientRect();
      return { top: r.top, viewBottom: body.bottom };
    });
    expect(box.top).toBeLessThan(box.viewBottom - 100);

    // About a second later: seen. The store's look covers it, and the row unbolds in place.
    const t0 = Date.now();
    await expect.poll(async () => (await storeRow(id)).unseen, { timeout: 5000 }).toBe(0);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(DWELL_MS - 400);
    await expect.poll(() => isBold(page, id)).toBe(false);
    expect(await rowsOf(page)).toEqual(order);
    expect(await sectionOf(page, id)).toBe(section);
    await expect(page.locator('[data-new-pill]')).toHaveAttribute('data-off', '');
    await shot(page, '02-desktop-seen-unbold');
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('desktop, scrolled up: nothing moves, the pill says 1 new, the store keeps it unseen until it is on screen', async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  try {
    const page = await context.newPage();
    await page.goto(`${world.url}/`);
    await inFront(page);
    const id = world.projects.up.thread;
    await openRow(page, 'up');
    const body = page.locator('section.ib-pane .ib-pbody');
    await body.evaluate((b) => (b.scrollTop = 0));
    const arrived = await reply('up', 'One more: the 409 path retries with the same key.');
    await expect.poll(() => isBold(page, id)).toBe(true);
    const pill = page.locator('[data-new-pill]');
    await expect(pill).not.toHaveAttribute('data-off', '');
    await expect(pill).toHaveText('1 new');
    expect(await body.evaluate((b) => b.scrollTop)).toBe(0);
    await page.waitForTimeout(DWELL_MS + 800);
    expect((await storeRow(id)).unseen).toBe(1);
    expect(await isBold(page, id)).toBe(true);
    await shot(page, '03-desktop-scrolled-up-pill');

    await pill.click();
    await expect(page.locator(`[data-message-article="${arrived.message_id}"]`)).toBeInViewport();
    await expect.poll(async () => (await storeRow(id)).unseen, { timeout: 6000 }).toBe(0);
    await expect.poll(() => isBold(page, id)).toBe(false);
    await expect(pill).toHaveAttribute('data-off', '');
    await shot(page, '04-desktop-pill-clicked-seen');
  } finally {
    await context.close();
  }
});

// The failure this guards: the pill counted the messages that were new when
// the thread opened as well as the arrival, and went to the first of them, so
// reaching the arrival took more than one click.
test('desktop, new messages below at the open and an arrival: the pill counts the arrival alone, and one click lands on it', async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  try {
    const id = world.projects.pill.thread;
    // Two long messages the person has not seen yet: new when the thread opens.
    const first = await reply('pill', LONG);
    await reply('pill', LONG);
    const page = await context.newPage();
    await page.goto(`${world.url}/`);
    await inFront(page);
    await openRow(page, 'pill');
    // It opens at the "New since you looked" divider; the second new message is below the view.
    await expect(page.locator(`[data-message-article="${first.message_id}"]`)).toBeInViewport();
    const arrived = await reply('pill', 'One more: the 409 path retries with the same key.');
    const pill = page.locator('[data-new-pill]');
    await expect(pill).not.toHaveAttribute('data-off', '');
    await expect(pill).toHaveText('1 new');
    await shot(page, '06a-desktop-pill-arrival-only');
    await pill.click();
    await expect(page.locator(`[data-message-article="${arrived.message_id}"]`)).toBeInViewport();
    await expect.poll(async () => (await storeRow(id)).unseen, { timeout: 6000 }).toBe(0);
    await expect(pill).toHaveAttribute('data-off', '');
  } finally {
    await context.close();
  }
});

test('desktop, closed before seeing it: the row settles unread in Waiting; closed after seeing it: Quiet', async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  try {
    const page = await context.newPage();
    await page.goto(`${world.url}/`);
    await inFront(page);

    const unseen = world.projects.unseen.thread;
    await openRow(page, 'unseen');
    await page.locator('section.ib-pane .ib-pbody').evaluate((b) => (b.scrollTop = 0));
    await reply('unseen', QUESTION);
    await expect.poll(() => isBold(page, unseen)).toBe(true);
    expect(await noticeText(page)).not.toContain('billing-unseen');
    await page.keyboard.press('Escape');
    await expect(page.locator('section.ib-pane')).toHaveCount(0);
    await expect.poll(() => sectionOf(page, unseen)).toBe('waiting');
    expect(await isBold(page, unseen)).toBe(true);
    expect((await storeRow(unseen)).unseen).toBe(1);
    expect(await noticeText(page)).not.toContain('billing-unseen');
    await shot(page, '05-desktop-closed-unseen-waiting');

    const seen = world.projects.seen.thread;
    await openRow(page, 'seen');
    await reply('seen', 'Retries are on.');
    await expect.poll(() => isBold(page, seen)).toBe(true);
    await expect.poll(() => isBold(page, seen), { timeout: 5000 }).toBe(false);
    await page.keyboard.press('Escape');
    await expect(page.locator('section.ib-pane')).toHaveCount(0);
    // Quiet is folded: the row is out of the open sections.
    await expect.poll(() => sectionOf(page, seen)).toBeNull();
    expect((await storeRow(seen)).section).toBe('quiet');
    await shot(page, '06-desktop-closed-seen-quiet');
  } finally {
    await context.close();
  }
});

test('phone (WebKit, iPhone 15): seen on sight with the same rule; Back shows it unbolded in place, or unread in Waiting', async () => {
  let own: Browser | null = null;
  let context: BrowserContext | null = null;
  try {
    own = await webkit.launch({ args: [] });
    context = await own.newContext({ ...devices['iPhone 15'], colorScheme: 'dark' });
    const page = await context.newPage();
    await page.goto(`${world.url}/`);
    await inFront(page);

    const seen = world.projects.phoneSeen.thread;
    await expect(row(page, seen)).toBeVisible();
    await openRow(page, 'phoneSeen', true);
    const section = await sectionOf(page, seen);
    const arrived = await reply('phoneSeen', 'Retries are on: three attempts.');
    await expect(page.locator(`[data-message-article="${arrived.message_id}"]`)).toBeVisible();
    await shot(page, '07-phone-arrived');
    await expect.poll(async () => (await storeRow(seen)).unseen, { timeout: 5000 }).toBe(0);
    await page.locator('section.ib-pane [data-phone-back]').click();
    await expect(page.locator('section.ib-pane')).toHaveCount(0);
    expect(await sectionOf(page, seen)).toBe(section);
    expect(await isBold(page, seen)).toBe(false);
    await shot(page, '08-phone-back-seen');

    const unseen = world.projects.phoneUnseen.thread;
    await openRow(page, 'phoneUnseen', true);
    await page.locator('section.ib-pane .ib-pbody').evaluate((b) => (b.scrollTop = 0));
    await reply('phoneUnseen', QUESTION);
    await expect(page.locator('[data-new-pill]')).toHaveText('1 new');
    await page.locator('section.ib-pane [data-phone-back]').click();
    await expect(page.locator('section.ib-pane')).toHaveCount(0);
    await expect.poll(() => sectionOf(page, unseen)).toBe('waiting');
    expect(await isBold(page, unseen)).toBe(true);
    await shot(page, '09-phone-back-unseen-waiting');
  } finally {
    await context?.close();
    await own?.close();
  }
});

// The failure this guards: a bottom sheet over the end of the thread (here New
// message's "not running" sheet) hid the arrival, and it was marked seen anyway.
test('phone (WebKit, iPhone 15): an arrival under New message\'s sheet is not seen until the sheet closes', async () => {
  let own: Browser | null = null;
  let context: BrowserContext | null = null;
  try {
    own = await webkit.launch({ args: [] });
    context = await own.newContext({ ...devices['iPhone 15'], colorScheme: 'dark' });
    const page = await context.newPage();
    await page.goto(`${world.url}/`);
    await inFront(page);

    const id = world.projects.phoneSheet.thread;
    await expect(row(page, id)).toBeVisible();
    await openRow(page, 'phoneSheet', true);
    // At the end of the thread, then the sheet over it.
    const body = page.locator('section.ib-pane .ib-pbody');
    await body.evaluate((b) => (b.scrollTop = b.scrollHeight));
    await page.locator('section.ib-pane [data-new-message]').tap();
    const sheet = page.locator('[data-not-running]');
    await expect(sheet).toBeVisible();

    const arrived = await reply('phoneSheet', 'Retries are on: three attempts, then the dead-letter queue.');
    const article = page.locator(`[data-message-article="${arrived.message_id}"]`);
    await expect(article).toHaveCount(1);
    await expect.poll(() => isBold(page, id)).toBe(true);
    // The view followed it to the end: its first lines are inside the thread's view, under the sheet.
    const under = await article.evaluate((a) => {
      const view = a.closest('.ib-pbody')!.getBoundingClientRect();
      const r = (a.querySelector('.ib-sender') ?? a).getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + 8);
      return { inView: r.top >= view.top && r.bottom <= view.bottom, covered: hit !== null && hit.closest('[data-not-running]') !== null };
    });
    expect(under).toEqual({ inView: true, covered: true });
    await shot(page, '10-phone-arrival-under-sheet');
    await page.waitForTimeout(DWELL_MS + 1200);
    expect((await storeRow(id)).unseen).toBe(1);
    expect(await isBold(page, id)).toBe(true);

    // The sheet closes (a press outside it): now it is on screen, and seen a second later.
    await body.dispatchEvent('mousedown');
    await expect(sheet).toHaveCount(0);
    await expect.poll(async () => (await storeRow(id)).unseen, { timeout: 6000 }).toBe(0);
    await expect.poll(() => isBold(page, id)).toBe(false);
    await shot(page, '11-phone-sheet-closed-seen');
  } finally {
    await context?.close();
    await own?.close();
  }
});
