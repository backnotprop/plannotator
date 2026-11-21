/**
 * A question that proposes a change, on the Inbox's card (change lines,
 * approval "before-after", the Versions card), proved in a real browser
 * against the compiled binary. Nothing is mocked: the binary runs
 * `plannotator inbox --background` under a temp PLANNOTATOR_DATA_DIR and
 * HOME, and a Claude Code agent asks through `plannotator inbox mcp`
 * (scripts/inbox-sim.ts) with real PNGs beside the project.
 *
 * Words: the Where shows first with See it; a choice's version sits under
 * its row with the added words marked; the choice that keeps today's words
 * carries them (no separate Now); the radio is named by its label alone and
 * described by its version; and a pick sends the plain label the agent reads
 * back. Pictures: each pick-any choice's Now and After load from the message
 * image route, side by side (two across on a phone too, like picture tiles,
 * inside the card), and a picture opens the thread's viewer without picking.
 * Picture choices: a tile shows its choice's own After under its words.
 * Screenshots, light and dark, land in
 * PLANNOTATOR_BEFORE_AFTER_SHOTS (default .local/proof/before-after/).
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { png } from './test-png';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = resolve(process.env.PLANNOTATOR_BEFORE_AFTER_SHOTS ?? join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'before-after'));

const WORDS = [
  ':::question',
  'Reword the line above a file you open from a thread?',
  '',
  'Where: The line above a file you open from a thread, after you press Open the version it sent.',
  'Shows: ![The line above the file](shots/place.png)',
  'Before: The version Claude Code sent at 5:40 PM. [Open the file as it is now](#)',
  '',
  '- [ ] Say what you are viewing',
  '    After: You are viewing the version Claude Code sent at 5:40 PM. [Open the file as it is now](#)',
  '- [ ] Leave it',
  '',
  'Recommended: Say what you are viewing',
  ':::',
].join('\n');

const TILES = [
  ':::question',
  'Which toolbar button?',
  '',
  'Before: Button "Sync" · tooltip "Syncs your stuff."',
  '',
  '- [ ] A · Sync with team — ![Sync A](shots/sync-a.png) Keeps the word',
  '    After: Button "Sync with team" · tooltip "Sends your edits to the team."',
  '- [ ] B · Share — ![Share B](shots/share-b.png) Shorter',
  '    After: Button "Share" · tooltip "Syncs your stuff."',
  '',
  'Recommended: A · Sync with team',
  ':::',
].join('\n');

/** The card's text as drawn on screen: the screen reader's sentences (`.qc-sr`) left out. */
const shownText = (card: ReturnType<Page['locator']>) => card.evaluate((el) => {
  const copy = el.cloneNode(true) as HTMLElement;
  copy.querySelectorAll('.qc-sr').forEach((n) => n.remove());
  return copy.textContent ?? '';
});

const PICTURES = [
  ':::question-multi',
  'Which of these contrast fixes go in?',
  '',
  'Where: Two themes, each in the place the problem shows.',
  '',
  '- [ ] Tags on dark themes',
  '    Before: ![Now](shots/tags-now.png)',
  '    After: ![After](shots/tags-after.png)',
  '- [ ] Links in Dracula',
  '    Before: ![Now](shots/links-now.png)',
  '    After: ![After](shots/links-after.png)',
  '',
  'Recommended: Tags on dark themes',
  ':::',
].join('\n');

interface World {
  url: string;
  claude: SimAgent;
  context: BrowserContext;
  page: Page;
  errors: string[];
  project: string;
}

let world: World;

async function shot(page: Page, name: string, target: ReturnType<Page['locator']>): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(300);
    await target.screenshot({ path: join(proofDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

/** What the person sent on the thread's newest answered question, as the agent reads it. */
async function sentSelection(agent: SimAgent, threadId: string): Promise<string[]> {
  const thread = await agent.readThread(threadId);
  const questions = (thread.messages as { questions?: { state: string; answer?: { selected?: string[] } }[] }[]).flatMap((m) => m.questions ?? []);
  return questions.findLast((q) => q.state === 'sent')!.answer!.selected!;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-before-after-e2e-');
  const dataDir = join(root, 'data');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9', PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const project = scratchProject(join(root, 'src'), 'notes');
  mkdirSync(join(project, 'shots'), { recursive: true });
  writeFileSync(join(project, 'shots', 'place.png'), png(960, 400, [217, 119, 6]));
  writeFileSync(join(project, 'shots', 'tags-now.png'), png(640, 400, [120, 113, 108]));
  writeFileSync(join(project, 'shots', 'tags-after.png'), png(640, 400, [37, 99, 235]));
  writeFileSync(join(project, 'shots', 'links-now.png'), png(640, 400, [88, 28, 135]));
  writeFileSync(join(project, 'shots', 'links-after.png'), png(640, 400, [22, 163, 74]));
  writeFileSync(join(project, 'shots', 'sync-a.png'), png(640, 480, [14, 116, 144]));
  writeFileSync(join(project, 'shots', 'share-b.png'), png(640, 480, [190, 18, 60]));
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  world = { url, claude, context, page, errors, project };
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

test('words: the Where first, Now and After marked, the kept choice carries today\'s words, and a pick sends the plain label', async () => {
  const { page, claude, project } = world;
  const sent = await claude.send({ project_path: project, subject: 'File line', body: WORDS }, { wakes: true });
  const threadId = sent.thread_id as string;
  await page.goto(`${world.url}#thread=${threadId}`);
  const card = page.locator('section.ib-pane fieldset.question-block');
  await expect(card).toBeVisible();

  const where = card.locator('[data-question-part="where"]');
  await expect(where).toContainText('The line above a file you open from a thread');
  await expect(card.locator('[data-question-shows]')).toHaveCount(0);
  // The labels are drawn, never written out (the screen reader's sentences say them).
  expect(await shownText(card)).not.toContain('Where:');
  expect(await shownText(card)).not.toContain('After:');

  // Versions: the version shows only what it adds (the Now line goes, so nothing is struck); "Leave it" shows today's words.
  const rows = card.locator('[data-question-option-with-change]');
  await expect(rows).toHaveCount(2);
  const [version, keep] = [rows.nth(0), rows.nth(1)];
  await expect(version.locator('del.qc-del')).toHaveCount(0);
  await expect(version.locator('ins.qc-ins')).toHaveText(['You are viewing the']);
  await expect(keep.locator('[data-question-choice-keeps]')).toContainText('The version Claude Code sent at 5:40 PM.');
  await expect(card.locator('[data-question-change-now]')).toHaveCount(0);
  // The radio's name is its label; its version is its description.
  const radio = version.locator('input[type="radio"]');
  await expect(radio).toHaveAccessibleName(/^Say what you are viewing(?: Recommended)?$/);
  await expect(radio).toHaveAccessibleDescription(/After: You are viewing the version Claude Code sent at 5:40 PM\./);
  await shot(page, 'words-desktop', card);

  // See it opens the place picture in the thread's viewer.
  await where.locator('[data-question-see-it]').click();
  await expect(page.locator('.ib-view')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.goto(`${world.url}#thread=${threadId}`);

  // The words under a choice pick it; Send; the agent reads the plain label.
  await version.locator('[data-question-choice-words]').click();
  await expect(version.locator('input')).toBeChecked();
  // The row and its version are tinted as one picked choice.
  await expect(version).toHaveAttribute('data-question-option-checked', '');
  await shot(page, 'words-picked', card);
  // Send is in the pane's footer, not the card.
  await page.locator('section.ib-pane .ib-pfoot').getByRole('button', { name: 'Send' }).click();
  // The answer reaches the agent first; then the thread reads it as sent.
  const body = String((await claude.nextReply(threadId, 40)).body);
  expect(body).toContain('Say what you are viewing');
  expect(await sentSelection(claude, threadId)).toEqual(['Say what you are viewing']);
  expect(world.errors).toEqual([]);
});

test('pictures: each choice\'s Now and After load side by side, on a phone too, inside the card; a picture opens and never picks', async ({ browser }: { browser: Browser }) => {
  const { page, claude, project } = world;
  const sent = await claude.send({ project_path: project, subject: 'Contrast fixes', body: PICTURES }, { wakes: true });
  const threadId = sent.thread_id as string;
  await page.goto(`${world.url}#thread=${threadId}`);
  const card = page.locator('section.ib-pane fieldset.question-block');
  await expect(card).toBeVisible();
  const rows = card.locator('[data-question-option-with-change]');
  await expect(rows).toHaveCount(2);
  const pictures = rows.nth(0).locator('[data-question-choice-pictures] img[data-question-picture]');
  await expect(pictures).toHaveCount(2);
  for (const i of [0, 1]) {
    await expect.poll(() => pictures.nth(i).evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(640);
  }
  const top = async (p: Page) => p.locator('section.ib-pane [data-question-option-with-change]').first().locator('figure').evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)));
  const desktop = await top(page);
  expect(desktop[0]).toBe(desktop[1]);
  await shot(page, 'pictures-desktop', card);

  await rows.nth(0).getByRole('button', { name: 'Open the picture: After, Tags on dark themes' }).click();
  await expect(page.locator('.ib-view')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.goto(`${world.url}#thread=${threadId}`);
  await expect(card.locator('input:checked')).toHaveCount(0);

  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  try {
    const p = await phone.newPage();
    await p.goto(`${world.url}#thread=${threadId}`);
    const phoneCard = p.locator('section.ib-pane fieldset.question-block');
    await expect(phoneCard).toBeVisible();
    // A choice's own pair stays two across, as picture tiles do on a phone, and inside the card.
    const across = await top(p);
    expect(across[0]).toBe(across[1]);
    const overflow = await phoneCard.evaluate((el) => [...el.querySelectorAll('figure')].some((f) => f.getBoundingClientRect().right > el.getBoundingClientRect().right + 0.5));
    expect(overflow).toBe(false);
    await shot(p, 'pictures-phone-390', phoneCard);
  } finally {
    await phone.close();
  }
  expect(world.errors).toEqual([]);
});

test('picture choices: each tile shows its choice\'s own After under its words, marked against today\'s', async () => {
  const { page, claude, project } = world;
  const sent = await claude.send({ project_path: project, subject: 'Toolbar button', body: TILES }, { wakes: true });
  const threadId = sent.thread_id as string;
  await page.goto(`${world.url}#thread=${threadId}`);
  const card = page.locator('section.ib-pane fieldset.question-block');
  await expect(card).toBeVisible();
  const tiles = card.locator('[data-question-tile]');
  await expect(tiles).toHaveCount(2);
  await expect(tiles.nth(0).locator('[data-question-choice-change]')).toContainText('Button "Sync with team" · tooltip "Sends your edits to the team."');
  await expect(tiles.nth(1).locator('ins.qc-ins')).toHaveText(['Share']);
  const radio = tiles.nth(0).locator('input[type="radio"]');
  await expect(radio).not.toHaveAccessibleName(/After|tooltip/);
  await expect(radio).toHaveAccessibleDescription(/After: Button "Sync with team"/);
  await shot(page, 'tiles-desktop', card);
  expect(world.errors).toEqual([]);
});
