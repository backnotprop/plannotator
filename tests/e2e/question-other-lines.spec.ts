/**
 * The question card's Other field takes several lines (the owner: "the add
 * your own answer blocks..., should allow for multiline input"), proved in
 * Chromium against the compiled binary: `plannotator inbox --background`
 * under a temp PLANNOTATOR_DATA_DIR and HOME, a Claude Code agent asking
 * through `plannotator inbox mcp` (scripts/inbox-sim.ts). Nothing is mocked.
 *
 * - Empty, the field is one line tall, exactly as tall as with one line in
 *   it, so a card nobody types several lines into does not move.
 * - Shift+Enter and Enter make a new line (the note's rule: the field is a
 *   textarea); text inserted with line breaks (a paste, dictation) keeps them.
 * - It grows a line at a time, its "+" mark staying beside the first line,
 *   up to a cap, then scrolls inside.
 * - The reply the agent gets quotes the lines under `Answer: Other:`, the way
 *   a multi-line note is quoted under `Note:`.
 * - On a phone (390 px, touch) one line is the 40 px field it was.
 *
 * Build the binary first (see inbox.spec.ts).
 */
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));

const BODY = [
  'Two calls before the sync work starts.',
  '',
  ':::question',
  'Where should the losing edit of a sync conflict go?',
  '',
  '- [ ] Nowhere',
  '- [ ] Local only',
  ':::',
  '',
  ':::question-multi',
  'Which exports should the ledger keep?',
  '',
  '- [ ] CSV',
  '- [ ] Parquet',
  ':::',
  '',
].join('\n');

interface World {
  dataDir: string;
  url: string;
  project: string;
  claude: SimAgent;
  context: BrowserContext;
  page: Page;
  errors: string[];
}
let world: World;

function registry(): { port: number } {
  return JSON.parse(readFileSync(join(world.dataDir, 'inbox', 'inbox.json'), 'utf8'));
}
type Message = { id: string; author: { kind: string }; body: string };
async function messages(threadId: string): Promise<Message[]> {
  const response = await fetch(`http://127.0.0.1:${registry().port}/api/inbox/threads/${threadId}`);
  return ((await response.json()) as { thread: { messages: Message[] } }).thread.messages;
}
async function ask(thread: string): Promise<string> {
  const sent = await world.claude.send({ project_path: world.project, subject: 'Sync conflicts', thread, body: BODY }, { wakes: true });
  return sent.thread_id as string;
}

/** The field's box, and its "+" mark's middle measured from the field's top. */
async function measure(field: Locator) {
  return field.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const mark = el.parentElement!.querySelector<HTMLElement>('[data-question-control]')!.getBoundingClientRect();
    const style = getComputedStyle(el);
    return {
      height: box.height,
      markMiddle: mark.top + mark.height / 2 - box.top,
      scrolls: el.scrollHeight > el.clientHeight + 1,
      overflowY: style.overflowY,
      maxHeight: parseFloat(style.maxHeight),
    };
  });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-question-other-lines-e2e-');
  const dataDir = join(root, 'data');
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    PLANNOTATOR_DATA_DIR: dataDir,
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    CODEX_HOME: join(root, 'codex'),
    OPENCODE_CONFIG_DIR: join(root, 'opencode'),
    PLANNOTATOR_BROWSER: NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const project = scratchProject(join(root, 'src'), 'sync');
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  world = { dataDir, url, project, claude, context, page, errors };
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

test('desktop: one line tall until it holds more, Shift+Enter and Enter make lines, a cap, and the agent gets the lines quoted', async () => {
  const { page } = world;
  const threadId = await ask('sync-desktop');
  await page.goto(`${world.url}#thread=${threadId}`);
  const cards = page.locator('section.ib-pane fieldset[data-question-key]');
  await expect(cards).toHaveCount(2);
  const other = cards.nth(0).getByRole('textbox', { name: /Other answer/ });

  const empty = await measure(other);
  await other.click();
  await page.keyboard.type('Keep the loser locally.');
  const oneLine = await measure(other);
  // No layout shift for one line: the empty field and a one-line answer are the same height, the mark where it was.
  expect(Math.abs(oneLine.height - empty.height)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(oneLine.markMiddle - empty.markMiddle)).toBeLessThanOrEqual(0.5);
  expect(empty.scrolls).toBe(false);

  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('Show it under History.');
  const twoLines = await measure(other);
  await page.keyboard.press('Enter');
  await page.keyboard.type('Purge it after a week.');
  const threeLines = await measure(other);
  await expect(other).toHaveValue('Keep the loser locally.\nShow it under History.\nPurge it after a week.');
  // A line at a time, the mark beside the first line.
  const step = twoLines.height - oneLine.height;
  expect(step).toBeGreaterThan(10);
  expect(Math.abs(threeLines.height - twoLines.height - step)).toBeLessThanOrEqual(1);
  expect(Math.abs(threeLines.markMiddle - empty.markMiddle)).toBeLessThanOrEqual(0.5);
  expect(threeLines.scrolls).toBe(false);

  // Lines inserted at once (a paste, dictation) keep their breaks, on the pick-any card too.
  const multiOther = cards.nth(1).getByRole('textbox', { name: /Other answer/ });
  await cards.nth(1).locator('[data-question-option]').filter({ hasText: 'CSV' }).click();
  await multiOther.click();
  await page.keyboard.insertText('JSON lines\nfor the audit team');
  await expect(multiOther).toHaveValue('JSON lines\nfor the audit team');

  // Saved, then sent: what the agent reads.
  await expect.poll(async () => JSON.stringify((await (await fetch(`http://127.0.0.1:${registry().port}/api/inbox/threads/${threadId}`)).json()).thread.messages[0].questions.map((q: { answer: { other?: string } | null }) => q.answer?.other ?? null))).toBe(
    JSON.stringify(['Keep the loser locally.\nShow it under History.\nPurge it after a week.', 'JSON lines\nfor the audit team']),
  );
  await page.locator('section.ib-pane .ib-pfoot').getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(async () => (await messages(threadId)).filter((m) => m.author.kind === 'person').length).toBe(1);
  const reply = (await messages(threadId)).find((m) => m.author.kind === 'person')!.body;
  expect(reply).toContain('Answer: Other:\n> Keep the loser locally.\n> Show it under History.\n> Purge it after a week.\n\n');
  expect(reply).toContain('Answer:\n- CSV\n- Other:\n  > JSON lines\n  > for the audit team');

  // The answered card shows the lines.
  await expect(cards.nth(0).getByRole('textbox', { name: /Other answer/ })).toHaveValue('Keep the loser locally.\nShow it under History.\nPurge it after a week.');
  expect(world.errors).toEqual([]);
});

test('desktop: a very long answer stops growing at the cap and scrolls inside', async () => {
  const { page } = world;
  const threadId = await ask('sync-long');
  await page.goto(`${world.url}#thread=${threadId}`);
  const cards = page.locator('section.ib-pane fieldset[data-question-key]');
  await expect(cards).toHaveCount(2);
  const other = cards.nth(0).getByRole('textbox', { name: /Other answer/ });
  await other.click();
  await page.keyboard.insertText(Array.from({ length: 30 }, (_, i) => `Line ${i + 1} of a very long answer.`).join('\n'));
  const capped = await measure(other);
  expect(capped.maxHeight).toBeGreaterThan(0);
  expect(Math.abs(capped.height - capped.maxHeight)).toBeLessThanOrEqual(0.5);
  expect(capped.scrolls).toBe(true);
  expect(capped.overflowY).toBe('auto');
  expect(world.errors).toEqual([]);
});

test('a phone: one line is the 40 px field it was, and a second line grows it', async ({ browser }) => {
  const threadId = await ask('sync-phone');
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'light' });
  try {
    const page = await phone.newPage();
    await page.goto(`${world.url}#thread=${threadId}`);
    const cards = page.locator('section.ib-pane fieldset[data-question-key]');
    await expect(cards).toHaveCount(2);
    const other = cards.nth(0).getByRole('textbox', { name: /Other answer/ });
    await other.scrollIntoViewIfNeeded();
    const empty = await measure(other);
    expect(Math.abs(empty.height - 40)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(empty.markMiddle - 20)).toBeLessThanOrEqual(0.5);
    await other.tap();
    await page.keyboard.insertText('Keep the loser locally.');
    expect(Math.abs((await measure(other)).height - 40)).toBeLessThanOrEqual(0.5);
    // The return key on a phone makes a new line, as in the note.
    await page.keyboard.press('Enter');
    await page.keyboard.insertText('Show it under History.');
    await expect(other).toHaveValue('Keep the loser locally.\nShow it under History.');
    const two = await measure(other);
    expect(two.height).toBeGreaterThan(50);
    expect(Math.abs(two.markMiddle - empty.markMiddle)).toBeLessThanOrEqual(0.5);
  } finally {
    await phone.close();
  }
});
