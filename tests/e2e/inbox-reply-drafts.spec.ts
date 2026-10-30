/**
 * Reply drafts and the Draft label (approval "inbox-reply-drafts", variant
 * Label), proved in a real browser against the compiled binary: words typed
 * in a thread's reply box are kept as a server draft while typing, and come
 * back when the person leaves the thread and opens it again, reloads the
 * page, or restarts the Inbox. The list row says "Draft · Your reply" ("Draft" beside a thread or on a phone) and
 * the thread stays out of Quiet after it is looked at; a thread holding only
 * a pick not sent stays out of Quiet too ("Draft · 1 pick"). The sidebar's
 * Drafts row counts them and its page lists them above the messages.
 * Discard drops the words; the Send that carries them clears them.
 *
 * Agents write through `plannotator inbox mcp` (scripts/inbox-sim.ts). PNGs
 * (desktop 1440, beside a thread at 1280, inside the thread, a phone, dark)
 * land in .local/proof/reply-drafts/ (or PLANNOTATOR_E2E_PROOF_DIR).
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, rememberInboxOf, removeInboxScratch, stopScratchInbox } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'reply-drafts');

const question = (prompt: string, choices: string[]) => [':::question', prompt, '', ...choices.map((c) => `- [ ] ${c}`), ':::'].join('\n');
const WORDS = 'Cards, but keep the totals column from the table design.';

interface World {
  root: string;
  dataDir: string;
  env: Record<string, string>;
  url: string;
  agents: SimAgent[];
  browser: Browser;
  context: BrowserContext;
  page: Page;
  errors: string[];
  threads: { news: string; picks: string; asks: string };
}

let world: World;

const row = (page: Page, threadId: string) => page.locator(`.ib-lbody [data-thread-id="${threadId}"]`);
const sectionOf = (page: Page, threadId: string) => row(page, threadId).getAttribute('data-section');
const pane = (page: Page) => page.locator('section.ib-pane');
const box = (page: Page) => pane(page).locator('textarea');

function startInbox(): string {
  const started = spawnSync(binary, ['inbox', '--background'], { env: world?.env ?? {}, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  return started.stdout.trim();
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-reply-drafts-e2e-');
  const dataDir = join(root, 'data');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  const billing = scratchProject(join(root, 'src'), 'billing-svc');
  const docs = scratchProject(join(root, 'src'), 'docs-site');
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const codex = await SimAgent.connect({ binary, env, name: 'Codex', host: 'codex' });
  const pi = await SimAgent.connect({ binary, env, name: 'Pi', host: 'pi' });
  const picks = await codex.send({ project_path: docs, subject: 'Which search index should the docs use?', body: question('Which search index should the docs use?', ['Pagefind', 'Orama']) });
  const news = await claude.send({ project_path: billing, subject: 'The invoice list is built', body: 'The invoice list is built as cards. Tell me what to change.' });
  const asks = await pi.send({ project_path: billing, subject: 'Skip the tour for returning users?', body: question('Skip the tour for returning users?', ['Yes', 'No']) });
  world = { root, dataDir, env, url, agents: [claude, codex, pi], browser, context, page, errors, threads: { news: news.thread_id, picks: picks.thread_id, asks: asks.thread_id } };
});

test.afterAll(async () => {
  try {
    if (!world) return;
    await Promise.all(world.agents.map((a) => a.close().catch(() => {})));
    await world.context.close();
  } finally {
    await removeInboxScratch();
  }
});

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(proofDir, `${name}.png`) });
}

test('type, leave: the words are kept, the row says "Draft · Your reply", and the looked-at thread stays out of Quiet', async () => {
  const { page, threads } = world;
  await page.goto(world.url);
  await row(page, threads.news).click();
  await pane(page).locator('.ib-pfoot').getByRole('button', { name: 'Reply' }).click();
  await box(page).fill(WORDS);
  // The soft pill with when it was saved, and Discard.
  await expect(pane(page).locator('[data-draft-head] .ib-draft-pill')).toHaveText('Draft');
  await expect(pane(page).locator('[data-draft-head] .ib-draft-saved')).toHaveText(/^Saved \d{1,2}:\d{2} [AP]M$/);
  await expect(pane(page).locator('[data-draft-discard]')).toHaveText('Discard');
  await page.setViewportSize({ width: 1280, height: 860 });
  await shot(page, 'inside-thread-draft-1280');
  // Leave the thread: the row it settles in says what waits.
  await pane(page).getByRole('button', { name: 'Close the thread' }).click();
  await expect(pane(page)).toHaveCount(0);
  // A wide row in a list of 1150px or more draws the full words (the owner, 2026-10-29); a narrower one (1280's list
  // is about 1030px), a two-line or a phone row "Draft" (option A).
  await expect(row(page, threads.news).locator('[data-draft-label]')).toHaveText('Draft');
  await expect(row(page, threads.news).locator('.ib-c')).toHaveAttribute('data-count-words', 'Draft · Your reply');
  expect(await sectionOf(page, threads.news)).toBe('new');
  // Not bold: nothing new arrived; the label says what is there.
  await expect(row(page, threads.news)).not.toHaveClass(/\bib-u\b/);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(row(page, threads.news).locator('[data-draft-label]')).toHaveText('Draft · Your reply');
  await shot(page, 'list-1440');
});

test('come back: the words are in the box, which does not take focus; a reload keeps them', async () => {
  const { page, threads } = world;
  await row(page, threads.news).click();
  await expect(box(page)).toHaveValue(WORDS);
  await expect(box(page)).not.toBeFocused();
  await page.reload();
  await expect(box(page)).toHaveValue(WORDS);
});

test('a restart of the Inbox keeps them', async () => {
  const { page, threads } = world;
  const mark = world.errors.length;
  await stopScratchInbox(world.dataDir);
  world.url = startInbox();
  rememberInboxOf(world.dataDir);
  await page.goto(`${world.url}#thread=${threads.news}`);
  // The same address: a hash change would keep the old page (and its old server session), so load it again.
  await page.reload();
  await expect(box(page)).toHaveValue(WORDS);
  // The old page lost its stream while the Inbox was down, by design.
  world.errors.splice(mark, world.errors.length - mark, ...world.errors.slice(mark).filter((e) => !/net::ERR_(CONNECTION_REFUSED|CONNECTION_RESET|INCOMPLETE_CHUNKED_ENCODING)/.test(e)));
});

test('a pick not sent: "Draft" on the card and the foot; the thread stays out of Quiet after it is looked at ("Draft · 1 pick")', async () => {
  const { page, threads } = world;
  await page.goto(`${world.url}#thread=${threads.picks}`);
  await expect(pane(page).getByRole('heading', { name: 'Which search index should the docs use?' })).toBeVisible();
  await expect(pane(page).getByRole('radio', { name: 'Pagefind' })).toBeVisible();
  await pane(page).getByText('Pagefind', { exact: true }).click();
  await expect(pane(page).getByText(/^Picked \d{1,2}:\d{2} [AP]M · in your draft$/)).toBeVisible();
  await expect(pane(page).locator('[data-draft-foot]')).toHaveText('Draft, 1 pick');
  await expect(pane(page).locator('.ib-pfoot')).not.toContainText('Not sent');
  await expect(row(page, threads.picks).locator('.ib-c')).toHaveAttribute('data-count-words', 'Draft · 1 pick');
  await page.setViewportSize({ width: 1280, height: 860 });
  await shot(page, 'inside-thread-picks-1280');
  // Beside another thread: both drafts' rows in the narrow list.
  await row(page, threads.asks).click();
  await expect(pane(page).getByRole('heading', { name: 'Skip the tour for returning users?' })).toBeVisible();
  await expect(row(page, threads.picks).locator('.ib-c')).toHaveAttribute('data-count-words', 'Draft · 1 pick');
  await expect(row(page, threads.news).locator('.ib-c')).toHaveAttribute('data-count-words', 'Draft · Your reply');
  await shot(page, 'beside-thread-1280');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(world.url);
  expect(await sectionOf(page, threads.picks)).toBe('new');
  expect(await sectionOf(page, threads.news)).toBe('new');
});

test('the sidebar\'s Drafts row counts them, and its page lists them above the messages', async () => {
  const { page, threads } = world;
  await page.goto(world.url);
  const nav = page.locator('[data-drafts-nav]');
  await expect(nav).toHaveText(/^Drafts\s*2$/);
  await nav.click();
  await expect(page.locator('.ib-drafts-h').first()).toHaveText('Replies not sent');
  await expect(page.locator(`[data-reply-draft="${threads.news}"]`)).toContainText(WORDS);
  await expect(page.locator(`[data-reply-draft="${threads.picks}"] [data-draft-label]`)).toHaveText('Draft · 1 pick');
  await shot(page, 'drafts-page-1440');
});

test('dark and a phone: the label and the pill read', async () => {
  const { page, threads } = world;
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(world.url);
  await expect(row(page, threads.news).locator('[data-draft-label]')).toBeVisible();
  await shot(page, 'list-1440-dark');
  await row(page, threads.news).click();
  await expect(box(page)).toHaveValue(WORDS);
  await shot(page, 'inside-thread-draft-1440-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  const phone = await world.browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: 'light' });
  try {
    const p = await phone.newPage();
    await p.goto(world.url);
    await expect(p.locator(`[data-thread-id="${threads.news}"] .ib-c .ib-sr`)).toHaveText('Draft · Your reply');
    await expect(p.locator(`[data-thread-id="${threads.picks}"] .ib-c .ib-sr`)).toHaveText('Draft · 1 pick');
    await shot(p, 'phone-list');
    await p.locator(`[data-thread-id="${threads.news}"]`).tap();
    await expect(p.locator('section.ib-pane textarea')).toHaveValue(WORDS);
    // Discard's hit area is 44px tall on a phone.
    const discard = await p.locator('[data-draft-discard]').evaluate((el) => {
      const after = getComputedStyle(el, '::after');
      return el.getBoundingClientRect().height - parseFloat(after.top) - parseFloat(after.bottom);
    });
    expect(discard).toBeGreaterThanOrEqual(43);
    await shot(p, 'phone-thread');
  } finally {
    await phone.close();
  }
});

test('Discard drops the words; typing again and Send clears them, and the row goes to Sent', async () => {
  const { page, threads } = world;
  await page.goto(`${world.url}#thread=${threads.news}`);
  await expect(box(page)).toHaveValue(WORDS);
  await pane(page).locator('[data-draft-discard]').click();
  await expect(box(page)).toHaveCount(0);
  await expect(row(page, threads.news).locator('[data-draft-label]')).toHaveCount(0);
  await pane(page).locator('.ib-pfoot').getByRole('button', { name: 'Reply' }).click();
  await box(page).fill('Ship it as cards.');
  await expect(pane(page).locator('[data-draft-head] .ib-draft-pill')).toHaveText('Draft');
  await pane(page).getByRole('button', { name: 'Send', exact: true }).click();
  await expect(box(page)).toHaveCount(0);
  await page.goto(world.url);
  expect(await sectionOf(page, threads.news)).toBe('sent');
  await expect(row(page, threads.news).locator('[data-draft-label]')).toHaveCount(0);
  expect(world.errors).toEqual([]);
});
