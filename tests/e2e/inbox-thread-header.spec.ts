/**
 * The thread header's order (owner, 2026-10-16: "the archive button needs to
 * move next to the close button. Mark read should be the furthest."; the
 * amendment in the "inbox-mark-read" approval). Proved in a real browser
 * against the compiled binary, in every layout the header has:
 *
 *  - desktop beside the list: the thread's full screen ("Hide the sidebar and
 *    the list") leads, then Mark read; at the right, icons only (approval
 *    "inbox-thread-artifacts"): Artifacts, Expand all (chevrons), Archive,
 *    ⋯ More, a hairline, the ×;
 *  - the thread in full screen (approval "inbox-files-tabs", amendment
 *    2026-10-30, B): the sidebar and the list hide, the thread keeps a centred
 *    760 px measure, ‹ Inbox leads in the button's place and there is no ×;
 *    ‹ Inbox, Escape or ⌘B brings them back (Escape leaves full screen before
 *    it closes the thread); a file opened there opens beside the thread and
 *    closing it returns to full screen; another thread keeps it; a stacked
 *    window never counts as full screen;
 *  - a stacked window (1000 px): ‹ Inbox leads, then Mark read; Archive, then
 *    ⋯ More (the copy menu, design record "inbox-copy-message") end it;
 *  - a file beside the thread: the same, with ‹ Inbox closing the file;
 *  - full screen: the file covers the thread;
 *  - a phone: ‹ Inbox, Mark read, then Archive and ⋯ More at the right edge, 44 px targets;
 *  - a thread that came back from the archive, and an archived thread
 *    (Unarchive in its foot, the header's Archive button reading Unarchive).
 *
 * The keyboard's tab order follows the visual order. Build the binary first
 * (see inbox.spec.ts), then `bun run test:e2e:inbox`. PNGs land in
 * .local/proof/thread-header/.
 */

import { devices, expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { forgetFileViewChoice } from './file-view';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'thread-header');

const ASK = ['The invoice list needs a call before I build it.', '', ':::question', 'Which layout should the invoice list use?', '', '- [ ] Cards', '- [ ] A dense table', ':::'].join('\n');

interface World {
  url: string;
  context: BrowserContext;
  page: Page;
  claude: SimAgent;
  threads: { invoices: string; archived: string; back: string };
  attachment: string;
}

let world: World;

async function shot(page: Page, name: string, schemes: readonly ('light' | 'dark')[] = ['light']): Promise<void> {
  for (const scheme of schemes) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(proofDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

/** The header's visible controls, left to right, by a short name. */
async function headerOrder(pane: Locator): Promise<string[]> {
  return pane.locator('.ib-phead').evaluate((head) =>
    [...head.querySelectorAll('button')]
      .filter((b) => {
        const r = b.getBoundingClientRect();
        return r.width > 0 && getComputedStyle(b).visibility !== 'hidden';
      })
      .sort((a, b) => a.getBoundingClientRect().x - b.getBoundingClientRect().x)
      .map((b) =>
        b.hasAttribute('data-mark-read')
          ? 'mark-read'
          : b.hasAttribute('data-artifacts-button')
            ? 'artifacts'
          : b.hasAttribute('data-full-in')
            ? 'full'
          : b.hasAttribute('data-archive')
            ? 'archive'
          : b.hasAttribute('data-thread-more')
            ? 'more'
            : b.hasAttribute('data-expand-all')
              ? 'expand'
              : b.classList.contains('ib-pback')
                ? 'back'
                : b.getAttribute('aria-label') === 'Close the thread'
                  ? 'close'
                  : (b.getAttribute('aria-label') ?? '?'),
      ),
  );
}

async function post(url: string, path: string, body: unknown): Promise<void> {
  const res = await fetch(new URL(path, url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  expect(res.status, await res.clone().text()).toBe(200);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-header-e2e-');
  const dataDir = join(root, 'data');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const project = scratchProject(join(root, 'src'), 'billing');
  mkdirSync(join(project, 'docs'), { recursive: true });
  writeFileSync(join(project, 'docs', 'invoice-plan.md'), '# Invoice list\n\nA dense table, overdue first, with an empty state that says what to do next.\n');
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });

  // A thread of two messages (so Expand all shows), with a question and a file.
  const first = await claude.send({ project_path: project, subject: 'Invoice list: cards or a table?', thread: 'invoices', body: 'Starting on the invoice list.' });
  await new Promise((r) => setTimeout(r, 20));
  const second = await claude.send({ project_path: project, thread: 'invoices', body: ASK, attachments: ['docs/invoice-plan.md'] });
  // A thread the person archived.
  const archived = await claude.send({ project_path: project, subject: 'Nightly build is green', body: 'The nightly build is green again.' });
  await post(url, `/api/inbox/messages/${archived.message_id}/resolve`, { resolved: true });
  // A thread that came back: archived, then the agent wrote into it with a question.
  const back = await claude.send({ project_path: project, subject: 'Search for the docs site', body: 'Search is wired up.' });
  await post(url, `/api/inbox/messages/${back.message_id}/resolve`, { resolved: true });
  await claude.send({ project_path: project, reply_to: back.message_id as string, body: ['One more thing.', '', ':::question', 'Which search index should the docs use?', '', '- [ ] Pagefind', '- [ ] Orama', ':::'].join('\n') });

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  world = {
    url,
    context,
    page,
    claude,
    threads: { invoices: first.thread_id as string, archived: archived.thread_id as string, back: back.thread_id as string },
    attachment: (second.attachments as { id: string }[])[0].id,
  };
});

/** A view pressed in a test is remembered: forgotten after each, so the next opens by today's rule (file-view.ts). */
test.afterEach(async () => forgetFileViewChoice(world?.page));

test.afterAll(async () => {
  try {
    if (!world) return;
    await world.claude.close().catch(() => {});
    await world.context.close();
  } finally {
    await removeInboxScratch();
  }
});

test('desktop beside the list: full screen, then Mark read lead, Archive and ⋯ More sit beside the close; Tab follows that order', async () => {
  const { page, threads } = world;
  await page.goto(`${world.url}#thread=${threads.invoices}`);
  const pane = page.locator(`section.ib-pane[data-thread-id="${threads.invoices}"]`);
  await expect(pane.locator('[data-mark-read]')).toBeVisible();
  await expect(page.locator('.ib-listcol')).toBeVisible();
  await shot(page, '1-desktop', ['light', 'dark']);
  expect(await headerOrder(pane)).toEqual(['full', 'mark-read', 'artifacts', 'expand', 'archive', 'more', 'close']);
  await expect(pane.locator('[data-full-in]')).toHaveAccessibleName('Hide the sidebar and the list');
  // Its hairline sets it apart from Mark read.
  expect(await pane.locator('[data-full-in]').evaluate((b) => b.nextElementSibling?.className)).toBe('ib-vsep');
  // Archive, then ⋯ More (design record "inbox-copy-message", option B), then only the hairline before the close
  // (approval "inbox-thread-artifacts").
  expect(await pane.locator('[data-archive]').evaluate((b) => b.nextElementSibling?.hasAttribute('data-thread-more'))).toBe(true);
  expect(await pane.locator('[data-thread-more]').evaluate((b) => b.nextElementSibling?.className)).toBe('ib-vsep');
  expect(await pane.locator('[data-thread-more]').evaluate((b) => b.nextElementSibling?.nextElementSibling?.getAttribute('aria-label'))).toBe('Close the thread');
  // Names and states are unchanged.
  await expect(pane.locator('[data-archive]')).toHaveAccessibleName('Archive the thread');
  await expect(pane.locator('[data-mark-read]')).toHaveAttribute('aria-pressed', 'false');
  // The keyboard walks the header left to right.
  await pane.locator('[data-mark-read]').focus();
  await page.keyboard.press('Tab');
  await expect(pane.locator('[data-artifacts-button]')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(pane.locator('[data-expand-all]')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(pane.locator('[data-archive]')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(pane.locator('[data-thread-more]')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(pane.getByRole('button', { name: 'Close the thread' })).toBeFocused();
});

/** The thread's left edge: past the sidebar and the list beside them, at the window's edge in full screen. */
const leftOf = (pane: Locator) => async () => (await pane.boundingBox())?.x ?? -1;
const sidebarCookie = async (page: Page) => (await page.context().cookies()).find((c) => c.name === 'plannotator-inbox-sidebar-open')?.value ?? null;

test('the thread in full screen: the sidebar and the list hide; ‹ Inbox, Escape and ⌘B bring them back', async () => {
  const { page, threads } = world;
  await page.goto(`${world.url}#thread=${threads.invoices}`);
  const pane = page.locator(`section.ib-pane[data-thread-id="${threads.invoices}"]`);
  const enter = pane.locator('[data-full-in]');
  const leave = pane.locator('[data-full-back]');
  const sidebar = page.getByRole('complementary', { name: 'Inbox navigation' });
  await expect(page.locator('.ib-listcol')).toBeVisible();
  await expect(sidebar).toBeVisible();
  expect(await leftOf(pane)()).toBeGreaterThan(400);
  const cookieBefore = await sidebarCookie(page);

  // In: the list and the sidebar hide, the thread spans the window at a reading measure, ‹ Inbox in the button's place.
  await enter.click();
  await expect(pane).toHaveAttribute('data-full', '');
  await expect(page.locator('.ib-listcol')).toHaveCount(0);
  await expect.poll(leftOf(pane)).toBeLessThan(20);
  await expect(sidebar).toBeHidden();
  await expect(leave).toBeFocused();
  await expect(leave).toHaveAccessibleName('Back to Inbox');
  expect(await headerOrder(pane)).toEqual(['back', 'mark-read', 'artifacts', 'expand', 'archive', 'more']);
  await expect(pane.getByRole('button', { name: 'Close the thread' })).toHaveCount(0);
  const measure = await pane.locator('.ib-pbody').evaluate((b) => {
    const s = getComputedStyle(b);
    return { text: b.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight), left: parseFloat(s.paddingLeft), right: parseFloat(s.paddingRight) };
  });
  expect(measure.text).toBeGreaterThan(740);
  expect(measure.text).toBeLessThanOrEqual(761);
  expect(Math.abs(measure.left - measure.right)).toBeLessThan(1);
  // The person's sidebar choice is not written.
  expect(await sidebarCookie(page)).toBe(cookieBefore);
  await shot(page, '1b-thread-full-screen', ['light', 'dark']);

  // ‹ Inbox: the list and the sidebar come back, the thread stays open, focus on the way in.
  await leave.click();
  await expect(pane).not.toHaveAttribute('data-full', '');
  await expect(page.locator('.ib-listcol')).toBeVisible();
  await expect(sidebar).toBeVisible();
  await expect.poll(leftOf(pane)).toBeGreaterThan(400);
  await expect(enter).toBeFocused();
  await expect(pane.getByRole('button', { name: 'Close the thread' })).toBeVisible();

  // ⌘B leaves full screen too, and still writes no sidebar choice.
  await enter.click();
  await expect(page.locator('.ib-listcol')).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+b');
  await expect(page.locator('.ib-listcol')).toBeVisible();
  await expect(sidebar).toBeVisible();
  await expect(pane).not.toHaveAttribute('data-full', '');
  expect(await sidebarCookie(page)).toBe(cookieBefore);

  // Escape leaves full screen first (the thread stays), then closes the thread.
  await enter.click();
  await expect(page.locator('.ib-listcol')).toHaveCount(0);
  await expect(leave).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('.ib-listcol')).toBeVisible();
  await expect(pane).toBeVisible();
  await expect.poll(() => page.evaluate(() => location.hash)).toContain(`thread=${threads.invoices}`);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => location.hash)).not.toContain('thread=');
});

test('the thread in full screen with a file: the file opens beside it; closing the file returns to full screen', async () => {
  const { page, threads } = world;
  await page.goto(`${world.url}#thread=${threads.invoices}`);
  const pane = page.locator(`section.ib-pane[data-thread-id="${threads.invoices}"]`);
  await pane.locator('[data-full-in]').click();
  await expect(page.locator('.ib-listcol')).toHaveCount(0);
  await pane.getByRole('button', { name: 'Open invoice-plan.md' }).first().click();
  const view = page.locator(`[data-attachment-pane="${world.attachment}"]`);
  await expect(view).toBeVisible();
  await expect(view).not.toHaveClass(/ib-full/);
  // Beside a file the thread drops its measure (the file has the room); the file's ‹ Inbox leads.
  await expect(pane).not.toHaveAttribute('data-full', '');
  await expect(pane.locator('[data-file-back]')).toBeVisible();
  await expect(pane.locator('[data-full-back]')).toHaveCount(0);
  expect(await headerOrder(pane)).toEqual(['back', 'mark-read', 'artifacts', 'expand', 'archive', 'more']);
  await shot(page, '1c-thread-full-screen-with-file', ['light', 'dark']);
  // The file's ×: back to the thread in full screen, not to the list.
  await view.getByRole('button', { name: 'Close invoice-plan.md' }).click();
  await expect(view).toHaveCount(0);
  await expect(pane).toHaveAttribute('data-full', '');
  await expect(page.locator('.ib-listcol')).toHaveCount(0);
  await expect(pane.locator('[data-full-back]')).toBeVisible();
  // Escape from the file closes the file first, still in full screen.
  await pane.getByRole('button', { name: 'Open invoice-plan.md' }).first().click();
  await expect(view).toBeVisible();
  await view.focus();
  await page.keyboard.press('Escape');
  await expect(view).toHaveCount(0);
  await expect(pane).toHaveAttribute('data-full', '');
  await expect(page.locator('.ib-listcol')).toHaveCount(0);
  // The file's own full screen, then back beside the thread, then its ×: still the thread in full screen.
  await pane.getByRole('button', { name: 'Open invoice-plan.md' }).first().click();
  await expect(view).toBeVisible();
  await view.getByRole('button', { name: 'Full screen' }).click();
  await expect(view).toHaveClass(/ib-full/);
  await view.locator('[data-full-view-close]').click();
  await expect(view).not.toHaveClass(/ib-full/);
  await expect(pane.locator('[data-file-back]')).toBeVisible();
  await view.getByRole('button', { name: 'Close invoice-plan.md' }).click();
  await expect(view).toHaveCount(0);
  await expect(pane).toHaveAttribute('data-full', '');
  await expect(page.locator('.ib-listcol')).toHaveCount(0);
  // Pressing Full screen was remembered as the person's view (fileView.ts): forgotten, so the next file opens beside.
  await forgetFileViewChoice(page);
  // ‹ Inbox with a file open closes the file and leaves full screen: the list comes back.
  await pane.getByRole('button', { name: 'Open invoice-plan.md' }).first().click();
  await expect(view).toBeVisible();
  await pane.locator('[data-file-back]').click();
  await expect(view).toHaveCount(0);
  await expect(page.locator('.ib-listcol')).toBeVisible();
  await expect(pane.locator('[data-full-in]')).toBeVisible();
});

test('the thread in full screen is a reading mode: another thread keeps it; a stacked window never counts as full screen', async () => {
  const { page, threads } = world;
  await page.goto(`${world.url}#thread=${threads.invoices}`);
  const pane = page.locator(`section.ib-pane[data-thread-id="${threads.invoices}"]`);
  await pane.locator('[data-full-in]').click();
  await expect(pane).toHaveAttribute('data-full', '');
  // Another thread (a link, search, a notification): still full screen.
  await page.evaluate((id) => (location.hash = `#thread=${id}`), threads.back);
  const other = page.locator(`section.ib-pane[data-thread-id="${threads.back}"]`);
  await expect(other).toHaveAttribute('data-full', '');
  await expect(page.locator('.ib-listcol')).toHaveCount(0);
  await expect(other.locator('[data-full-back]')).toBeVisible();
  // A window too narrow for two panes: the stacked thread leads with its own ‹ Inbox, never full screen's.
  await page.setViewportSize({ width: 800, height: 800 });
  try {
    await expect(other.locator('[data-stack-back]')).toBeVisible();
    await expect(other).not.toHaveAttribute('data-full', '');
    await expect(other.locator('[data-full-back], [data-full-in]')).toHaveCount(0);
  } finally {
    await page.setViewportSize({ width: 1440, height: 900 });
  }
  // Wide again: back to full screen, as the person left it.
  await expect(other).toHaveAttribute('data-full', '');
  await expect(page.locator('.ib-listcol')).toHaveCount(0);
  // No thread open: it ends.
  await page.evaluate(() => (location.hash = ''));
  await expect(page.locator('.ib-listcol')).toBeVisible();
  await page.evaluate((id) => (location.hash = `#thread=${id}`), threads.invoices);
  await expect(pane).toBeVisible();
  await expect(pane).not.toHaveAttribute('data-full', '');
  await expect(pane.locator('[data-full-in]')).toBeVisible();
});

test('a stacked window: ‹ Inbox, then Mark read; Archive and ⋯ More end the header', async () => {
  const { page, threads } = world;
  await page.setViewportSize({ width: 1000, height: 800 });
  try {
    await page.goto(`${world.url}#thread=${threads.invoices}`);
    const pane = page.locator(`section.ib-pane[data-thread-id="${threads.invoices}"]`);
    await expect(pane.locator('[data-stack-back]')).toBeVisible();
    await shot(page, '2-stacked-1000');
    expect(await headerOrder(pane)).toEqual(['back', 'mark-read', 'artifacts', 'expand', 'archive', 'more']);
    await expect(pane.getByRole('button', { name: 'Close the thread' })).toHaveCount(0);
  } finally {
    await page.setViewportSize({ width: 1440, height: 900 });
  }
});

test('a file beside the thread: ‹ Inbox, then Mark read; Archive and ⋯ More end the header; full screen covers it', async () => {
  const { page, threads } = world;
  await page.goto(`${world.url}#thread=${threads.invoices}&file=${world.attachment}`);
  const pane = page.locator(`section.ib-pane[data-thread-id="${threads.invoices}"]`);
  const view = page.locator(`[data-attachment-pane="${world.attachment}"]`);
  await expect(view).toBeVisible();
  await expect(pane.locator('[data-file-back]')).toBeVisible();
  await shot(page, '3-file-beside', ['light', 'dark']);
  expect(await headerOrder(pane)).toEqual(['back', 'mark-read', 'artifacts', 'expand', 'archive', 'more']);
  await view.getByRole('button', { name: 'Full screen' }).click();
  await expect(view).toHaveClass(/ib-full/);
  await shot(page, '4-file-full-screen');
  await view.getByRole('button', { name: 'Side by side' }).click();
  await expect(view).not.toHaveClass(/ib-full/);
  expect(await headerOrder(pane)).toEqual(['back', 'mark-read', 'artifacts', 'expand', 'archive', 'more']);
});

test('a thread that came back from the archive, and an archived one: the same order, Unarchive in the foot', async () => {
  const { page, threads } = world;
  await page.goto(`${world.url}#thread=${threads.back}`);
  const backPane = page.locator(`section.ib-pane[data-thread-id="${threads.back}"]`);
  await expect(backPane.locator('[data-came-back]')).toBeVisible();
  await shot(page, '5-came-back');
  // A thread that came back is not resolved for the window, so Mark read is offered and leads.
  expect(await headerOrder(backPane)).toEqual(['full', 'mark-read', 'expand', 'archive', 'more', 'close']);

  await page.goto(`${world.url}#thread=${threads.archived}`);
  const archivedPane = page.locator(`section.ib-pane[data-thread-id="${threads.archived}"]`);
  await expect(archivedPane.getByRole('button', { name: 'Unarchive' }).first()).toBeVisible();
  await shot(page, '6-archived');
  expect((await headerOrder(archivedPane)).slice(-3)).toEqual(['archive', 'more', 'close']);
  await expect(archivedPane.locator('[data-archive]')).toHaveAccessibleName('Unarchive the thread');
  await expect(archivedPane.locator('[data-mark-read]')).toHaveCount(0);
});

for (const phone of [
  { name: 'Pixel 7', options: devices['Pixel 7'] },
  { name: '320 px', options: { ...devices['Pixel 7'], viewport: { width: 320, height: 640 } } },
]) {
  test(`a phone (${phone.name}): ‹ Inbox, Mark read, then Archive and ⋯ More at the right edge, 44 px targets`, async ({ browser }) => {
    const { threads } = world;
    const { defaultBrowserType: _ignored, ...options } = phone.options as typeof phone.options & { defaultBrowserType?: string };
    const context = await browser.newContext({ ...options, colorScheme: 'light' });
    try {
      const page = await context.newPage();
      await page.goto(`${world.url}#thread=${threads.invoices}`);
      const pane = page.locator(`section.ib-pane[data-thread-id="${threads.invoices}"]`);
      await expect(pane.locator('[data-phone-back]')).toBeVisible();
      await shot(page, `7-phone-${phone.name.replace(/\W+/g, '-').toLowerCase()}`, ['light', 'dark']);
      expect(await headerOrder(pane)).toEqual(['back', 'mark-read', 'artifacts', 'expand', 'archive', 'more']);
      // Under 360 px Mark read shows its icon alone; its words stay its name.
      await expect(pane.locator('[data-mark-read]')).toHaveAccessibleName(/Mark read/);
      // The pin lives in ⋯ More's menu (a phone's way to pin), not the header.
      await expect(pane.locator('[data-pin-toggle]')).toHaveCount(0);
      // Every header control is a 44 px target and none overlaps another.
      // Measured against the header itself (the thread may still be sliding in).
      const boxes = await pane.locator('.ib-phead').evaluate((head) => {
        const h = head.getBoundingClientRect();
        return [...head.querySelectorAll('button')].map((b) => {
          const r = b.getBoundingClientRect();
          return { name: b.getAttribute('aria-label') ?? b.textContent?.trim() ?? '', x: r.x - h.x, w: r.width, h: r.height, right: r.right - h.x, head: h.width };
        });
      });
      for (const box of boxes) expect(box.h, `${box.name} is ${Math.round(box.w)}x${Math.round(box.h)}`).toBeGreaterThanOrEqual(43.9);
      for (const box of boxes) expect(box.w, `${box.name} is ${Math.round(box.w)}x${Math.round(box.h)}`).toBeGreaterThanOrEqual(43.9);
      const sorted = [...boxes].sort((a, b) => a.x - b.x);
      for (let i = 1; i < sorted.length; i++) expect(sorted[i].x, `${sorted[i - 1].name} overlaps ${sorted[i].name}`).toBeGreaterThanOrEqual(sorted[i - 1].right - 0.5);
      expect(sorted.at(-1)!.right).toBeLessThanOrEqual(sorted.at(-1)!.head);
      // ⋯ More (the copy menu, design record "inbox-copy-message") ends the row, after Archive.
      expect(sorted.at(-1)!.name).toBe('More');
      expect(sorted.at(-2)!.name).toBe('Archive the thread');
    } finally {
      await context.close();
    }
  });
}
