/**
 * Picks made while the reply box is open, in a real browser against the
 * compiled binary (the owner, 2026-10-21: "When i edit a reply, and then add
 * new answers... do they get added to the reply? Because I dont see them").
 * Nothing is mocked: `plannotator inbox --background` under a temp
 * PLANNOTATOR_DATA_DIR and HOME, a Claude Code agent asking six pick-one
 * questions through `plannotator inbox mcp` (scripts/inbox-sim.ts).
 *
 * The person picks one answer, opens the reply (Edit draft), types words,
 * then clicks more answers with the mouse while the words have focus. Every
 * click saves a pick (read back from the server), and the box lists every
 * answer live under the words; the words are never rewritten. Then Send: the
 * words once, the answers once. Last, the box on an iPhone 15's screen
 * (touch and mobile layout, in the config's Chromium).
 *
 * `PLANNOTATOR_PICKS_LEGACY=1` runs only the save half (no list asserted),
 * for an older binary (`PLANNOTATOR_E2E_BINARY=~/.local/bin/plannotator`).
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 * PNGs land in .local/proof/picks-composing/ (or PLANNOTATOR_PICKS_SHOTS).
 */

import { devices, expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = resolve(process.env.PLANNOTATOR_PICKS_SHOTS ?? join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'picks-composing'));
const legacy = process.env.PLANNOTATOR_PICKS_LEGACY === '1';

const QUESTIONS: [string, string, string][] = [
  ['Which layout should the invoice list use?', 'Cards', 'A dense table'],
  ['Should overdue invoices sort to the top?', 'Yes', 'No'],
  ['Which currency format?', 'Symbol first', 'Code after'],
  ['Where does the export button go?', 'Header', 'Footer'],
  ['Paginate or scroll?', 'Paginate', 'Infinite scroll'],
  ['Default date range?', 'Last 30 days', 'This month'],
];
const BODY = [
  'Six choices before I build the billing screens.',
  '',
  ...QUESTIONS.flatMap(([prompt, a, b]) => [':::question', prompt, '', `- [ ] ${a}`, `- [ ] ${b}`, ':::', '']),
].join('\n');

interface World {
  dataDir: string;
  env: Record<string, string>;
  url: string;
  billing: string;
  claude: SimAgent;
  context: BrowserContext;
  page: Page;
  errors: string[];
}
let world: World;

function registry(): { port: number } {
  return JSON.parse(readFileSync(join(world.dataDir, 'inbox', 'inbox.json'), 'utf8'));
}
type Question = { key: string; state: string; answer: { selected?: string[] } | null };
type Message = { id: string; author: { kind: string }; body: string; questions?: Question[] };
async function messages(threadId: string): Promise<Message[]> {
  const response = await fetch(`http://127.0.0.1:${registry().port}/api/inbox/threads/${threadId}`);
  return ((await response.json()) as { thread: { messages: Message[] } }).thread.messages;
}
const states = async (threadId: string) => ((await messages(threadId))[0]!.questions ?? []).map((q) => q.state);

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(proofDir, { recursive: true });
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(proofDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

/** Each test asks in a thread of its own (a named thread: the session's default thread would be the first one). */
async function ask(subject: string, thread: string): Promise<string> {
  const sent = await world.claude.send({ project_path: world.billing, subject, thread, body: BODY }, { wakes: true });
  return sent.thread_id as string;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  const root = inboxScratch('plannotator-inbox-picks-composing-e2e-');
  const dataDir = join(root, 'data');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const billing = scratchProject(join(root, 'src'), 'billing');
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  world = { dataDir, env, url, billing, claude, context, page, errors };
  await fetch(`http://127.0.0.1:${registry().port}/api/inbox/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notifications: { dismissed: true } }) });
});

test.afterAll(async () => {
  try {
    if (!world) return;
    await world.claude.close().catch(() => {});
    await world.context.close();
  } finally {
    await removeInboxScratch();
  }
});

test('desktop: answers clicked while writing the reply save, and the box lists them live', async () => {
  const { page } = world;
  const threadId = await ask('Billing screens: six choices', 'billing-desktop');
  await page.goto(`${world.url}#thread=${threadId}`);
  const pane = page.locator('section.ib-pane');
  const cards = pane.locator('fieldset[data-question-key]');
  await expect(cards).toHaveCount(6);
  const choice = (n: number, label: string) => cards.nth(n).locator('[data-question-option]').filter({ hasText: label });

  await choice(0, 'Cards').click();
  await expect.poll(() => states(threadId)).toEqual(['picked', 'open', 'open', 'open', 'open', 'open']);
  await pane.locator('.ib-pfoot').getByRole('button', { name: /^(Edit draft|Edit the reply)$/ }).click();
  const box = pane.locator('.ib-rbox textarea');
  await expect(box).toBeFocused();
  if (!legacy) {
    await expect(box).toHaveValue('');
    await expect(pane.locator('[data-reply-answers]')).toContainText('Your answer goes with this reply');
  }
  await box.press('End');
  await box.pressSequentially(' Cards: the list is short, a table hides the totals.', { delay: 5 });
  const words = await box.inputValue();

  // More answers, each a mouse click on the card while the words have focus.
  for (const [n, label] of [
    [1, 'Yes'],
    [2, 'Symbol first'],
    [3, 'Header'],
  ] as const) {
    await box.click();
    await choice(n, label).click();
  }
  await expect.poll(() => states(threadId)).toEqual(['picked', 'picked', 'picked', 'picked', 'open', 'open']);
  await expect(pane.locator('[data-picks-chip]')).toContainText('4 picks');
  await expect(box).toHaveValue(words);
  if (legacy) {
    // The box as an older Inbox draws it: the words seeded once with the first answer, never updated.
    await pane.locator('.ib-rbox').scrollIntoViewIfNeeded();
    await shot(page, '0-before-legacy');
    return;
  }
  const list = pane.locator('[data-reply-answers]');
  await expect(list).toContainText('Your 4 answers go with this reply');
  await expect(list.locator('[data-reply-answer]')).toHaveText([
    /Q1\s+Which layout should the invoice list use\?\s+Cards/,
    /Q2\s+Should overdue invoices sort to the top\?\s+Yes/,
    /Q3\s+Which currency format\?\s+Symbol first/,
    /Q4\s+Where does the export button go\?\s+Header/,
  ]);
  await list.scrollIntoViewIfNeeded();
  await shot(page, '1-desktop-composing');

  // A row goes to its card.
  await list.locator('[data-reply-answer]').nth(2).click();
  await expect(cards.nth(2)).toBeFocused();

  // Changing an answer shows at once.
  await choice(0, 'A dense table').click();
  await expect(list.locator('[data-reply-answer]').first()).toContainText('A dense table');
  await expect.poll(async () => (await messages(threadId))[0]!.questions![0]!.answer?.selected?.[0]).toBe('A dense table');

  // Send: the words once, every answer once, no summary line in the words.
  await pane.locator('.ib-rbox').scrollIntoViewIfNeeded();
  await pane.locator('.ib-acts').getByRole('button', { name: 'Send', exact: true }).last().click();
  await expect.poll(async () => (await messages(threadId)).filter((m) => m.author.kind === 'person').length).toBe(1);
  const reply = (await messages(threadId)).find((m) => m.author.kind === 'person')!.body;
  expect(reply.split('Cards: the list is short').length).toBe(2);
  expect(reply).toContain('Answer: A dense table');
  expect(reply).toContain('Answer: Header');
  expect(reply).not.toContain('Which layout should the invoice list use: ');
  expect(world.errors).toEqual([]);
});

test('a long "Other" answer behind slow saves: a few saves, and Send carries the final words right after them', async () => {
  test.skip(legacy, 'the collapsed saves are new');
  const { page } = world;
  const threadId = await ask('Billing screens: a long answer', 'billing-long-answer');
  await page.goto(`${world.url}#thread=${threadId}`);
  const pane = page.locator('section.ib-pane');
  const cards = pane.locator('fieldset[data-question-key]');
  await expect(cards).toHaveCount(6);
  await cards.nth(0).locator('[data-question-option]').filter({ hasText: 'Cards' }).click();
  await expect.poll(() => states(threadId)).toEqual(['picked', 'open', 'open', 'open', 'open', 'open']);

  // The owner's phone over a tailnet: each save takes a while, and the answer changes faster than that.
  let saves = 0;
  await page.route('**/picks', async (route) => {
    saves += 1;
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.continue();
  });
  const words = 'The header, beside the filters, where the eye already goes when it wants the numbers out.';
  const other = cards.nth(1).getByRole('textbox', { name: /Other answer/ });
  await other.pressSequentially(words, { delay: 10 });
  const send = pane.locator('.ib-pfoot').getByRole('button', { name: 'Send', exact: true });
  await send.click();
  await expect.poll(async () => (await messages(threadId)).filter((m) => m.author.kind === 'person').length).toBe(1);
  await page.unroute('**/picks');
  const reply = (await messages(threadId)).find((m) => m.author.kind === 'person')!.body;
  expect(reply).toContain(`Answer: ${words}`);
  // One save per key would be about 90, a Send 27 s behind them. A slow runner types slower, so not an exact count.
  expect(saves).toBeLessThan(45);
  expect(world.errors).toEqual([]);
});

// The iPhone 15's screen, touch and mobile layout in the config's own browser: launching WebKit by hand
// from this Chromium project dies on the CI runner (as inbox-refresh.spec.ts notes). inbox-mobile.spec.ts
// covers the window in WebKit itself.
const { defaultBrowserType: _phoneBrowser, ...iPhone } = devices['iPhone 15'];
test.describe('a phone (iPhone 15 screen)', () => {
  test.use(iPhone);
  test('the box lists the answers, capped with the keyboard up', async ({ page }) => {
    test.skip(legacy, 'the list is new');
    const threadId = await ask('Billing screens on a phone', 'billing-phone');
    await page.goto(`${world.url}#thread=${threadId}`);
    const pane = page.locator('section.ib-pane');
    const cards = pane.locator('fieldset[data-question-key]');
    await expect(cards).toHaveCount(6);
    const choice = (n: number, label: string) => cards.nth(n).locator('[data-question-option]').filter({ hasText: label });
    await choice(0, 'Cards').tap();
    await expect.poll(() => states(threadId)).toContain('picked');
    await pane.locator('.ib-pfoot').getByRole('button', { name: 'Edit draft' }).tap();
    const box = pane.locator('.ib-rbox textarea');
    await box.fill('Cards: the list is short.');
    await choice(1, 'Yes').tap();
    await choice(4, 'Infinite scroll').tap();
    await expect.poll(() => states(threadId)).toEqual(['picked', 'picked', 'open', 'open', 'picked', 'open']);
    const list = pane.locator('[data-reply-answers]');
    await expect(list).toContainText('Your 3 answers go with this reply');
    const row = await list.locator('[data-reply-answer]').first().boundingBox();
    expect(row!.height).toBeGreaterThanOrEqual(44);
    await expect(box).toHaveValue('Cards: the list is short.');
    // More answers than fit: the list holds about two and a half rows and scrolls, so the box
    // never eats the thread with the keyboard up.
    // One tap at a time, each seen saved (two taps close together read as a double tap in Chromium's touch emulation).
    await page.waitForTimeout(600);
    await choice(2, 'Code after').tap();
    await expect.poll(() => states(threadId)).toEqual(['picked', 'picked', 'picked', 'open', 'picked', 'open']);
    await page.waitForTimeout(600);
    await choice(3, 'Footer').tap();
    await expect(list).toContainText('Your 5 answers go with this reply');
    const rows = list.locator('.ib-ranswers-l');
    const [shown, whole] = await rows.evaluate((el) => [el.clientHeight, el.scrollHeight]);
    expect(shown).toBeLessThanOrEqual(112);
    expect(whole).toBeGreaterThan(shown);
    // The keyboard up: the words focused, the window as tall as iOS leaves above the keyboard.
    await page.setViewportSize({ width: 393, height: 470 });
    await box.focus();
    await page.waitForTimeout(300);
    await expect(box).toBeFocused();
    const boxTop = (await pane.locator('.ib-rbox').boundingBox())!.y;
    expect(boxTop).toBeGreaterThan(120);
    await shot(page, '2-phone-keyboard-up');
  });
});
