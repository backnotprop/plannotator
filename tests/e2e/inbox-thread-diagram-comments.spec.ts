/**
 * Comments on the parts of a diagram in an agent's message, proved in a real
 * browser against the compiled binary, with an agent writing through
 * `plannotator inbox mcp` (scripts/inbox-sim.ts). Real Mermaid and Graphviz:
 * every place is read from the rendered part, never from a pixel constant.
 *
 *  - a click on a part in the thread opens the composer, Escape closes only
 *    it, Enter saves; the part keeps a numbered badge; the reply box's list
 *    names the part, and pointing at it from there brings it back;
 *  - a reload draws the badge again from the draft, and the same comment from
 *    the full-screen popout lands on the same message;
 *  - Send carries them, and the agent's wait_for_reply reads which part;
 *  - an archived message, a sent reply and the person's own message open
 *    nothing, as they take no comment on their words;
 *  - on a phone: a tap opens the composer inside the window, a swipe scrolls
 *    the thread, a sideways drag pans, and neither opens anything.
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 * PNGs land in <PLANNOTATOR_E2E_PROOF_DIR or .local/proof>/thread-diagram-comments/.
 */

import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';
import { finger } from './phone-touch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'thread-diagram-comments');

const BODY = [
  'Here is the release flow as it runs today.',
  '',
  '```mermaid',
  'flowchart TD',
  '  A[Build image] --> B{Tests pass?}',
  '  B -->|Yes| C[Deploy]',
  '  B -->|No| D[Fix the build]',
  '```',
  '',
  'And the queue behind it:',
  '',
  '```dot',
  'digraph queue {',
  '  intake -> worker;',
  '  worker -> done;',
  '}',
  '```',
  '',
  'Nothing needs you yet.',
].join('\n');

/** The fence opens on line 3, so `B` is declared on line 5 and `worker` (the dot fence opens on line 12) on line 14. */
const B_LINE = 5;
const WORKER_LINE = 14;

/** How far the phone's swipe travels. */
const SWIPE_PX = 200;

const LONG = [...Array.from({ length: 12 }, (_, i) => `Paragraph ${i + 1} of the notes above the diagram, long enough to take a few lines on a phone.`), '', BODY, '', ...Array.from({ length: 12 }, (_, i) => `Paragraph ${i + 1} of the notes under the diagram, long enough to take a few lines on a phone.`)].join('\n\n');

interface World {
  root: string;
  url: string;
  claude: SimAgent;
  context: BrowserContext;
  page: Page;
  errors: string[];
  project: string;
}

let world: World;

const message = (page: Page, id: string) => page.locator(`[data-message-id="${id}"]`);
const composer = (page: Page) => page.locator('[data-diagram-composer]');
const badges = (scope: Page | Locator) => scope.locator('[data-diagram-badge]');
/** A rendered part by its words: Mermaid's `g.node`, Graphviz's `g.node`. */
const part = (scope: Locator, words: string) => scope.locator('[data-diagram-canvas] g.node', { hasText: words }).first();

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(proofDir, `${name}.png`) });
}

/** The middle of a part once the canvas has fitted it: two frames in a row agree. */
async function centreOf(target: Locator): Promise<{ x: number; y: number }> {
  await expect(target).toBeVisible();
  let last = '';
  let centre = { x: 0, y: 0 };
  await expect
    .poll(async () => {
      const box = await target.boundingBox();
      if (!box) return false;
      centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      const key = JSON.stringify(box);
      const same = key === last;
      last = key;
      return same;
    })
    .toBe(true);
  return centre;
}

async function clickPart(page: Page, target: Locator): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const { x, y } = await centreOf(target);
  await page.mouse.click(x, y);
}

async function saveComment(page: Page, words: string): Promise<void> {
  const box = composer(page).locator('textarea');
  await expect(box).toBeFocused();
  await box.fill(words);
  await box.press('Enter');
  await expect(composer(page)).toHaveCount(0);
}

const openReply = (page: Page) => page.locator('section.ib-pane .ib-pfoot').getByRole('button', { name: /^(Reply|Edit draft)$/ }).first().click();

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-thread-diagram-e2e-');
  const dataDir = join(root, 'data');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const project = scratchProject(join(root, 'src'), 'billing');
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  world = { root, url, claude, context, page, errors, project };
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

test('a part in the thread and in the popout takes a comment; the draft survives a reload; Send names the parts', async () => {
  const { page, claude, project } = world;
  const sent = await claude.send({ project_path: project, subject: 'Release flow', thread: 'release-flow', body: BODY });
  const id = sent.message_id as string;
  await page.goto(`${world.url}#thread=${sent.thread_id}`);
  const body = message(page, id);
  const mermaid = body.locator('[data-diagram-block="mermaid"]');
  const graphviz = body.locator('[data-diagram-block="graphviz"]');
  await expect(mermaid.locator('[data-diagram-svg] svg')).toBeVisible();
  await expect(graphviz.locator('[data-diagram-svg] svg')).toBeVisible();

  // The composer on the part; Escape closes it, never the thread.
  await clickPart(page, part(mermaid, 'Tests pass?'));
  await expect(composer(page)).toContainText('Tests pass?');
  await expect(composer(page)).toContainText('node B');
  await expect(composer(page).locator('textarea')).toBeFocused();
  await composer(page).locator('textarea').press('Escape');
  await expect(composer(page)).toHaveCount(0);
  await expect(body).toBeVisible();

  await clickPart(page, part(mermaid, 'Tests pass?'));
  await composer(page).locator('textarea').fill('Run the integration suite here too.');
  await shot(page, '01-desktop-composing-on-a-part');
  await composer(page).locator('textarea').press('Enter');
  await expect(composer(page)).toHaveCount(0);
  await expect(badges(mermaid)).toHaveCount(1);

  // Graphviz is the same path.
  await clickPart(page, part(graphviz, 'worker'));
  await saveComment(page, 'One worker is not enough.');
  await expect(badges(graphviz)).toHaveCount(1);

  // The draft: a reload draws the badges again from the store, each on its own diagram.
  await page.reload();
  await expect(badges(mermaid)).toHaveCount(1);
  await expect(badges(graphviz)).toHaveCount(1);
  await expect(page.locator('section.ib-pane .ib-pfoot')).toContainText('2 comments');

  // The full-screen popout: the same viewer, the same draft.
  await mermaid.hover();
  await mermaid.locator('[data-diagram-expand]').click();
  const popout = page.locator('[data-diagram-popout]');
  await expect(popout.locator('[data-diagram-svg] svg')).toBeVisible();
  await expect(badges(popout)).toHaveCount(1);
  // Escape on the popout's canvas closes the popout, not the thread under it.
  await expect(popout.locator('[data-diagram-canvas]')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(popout).toHaveCount(0);
  await expect(body).toBeVisible();
  await mermaid.hover();
  await mermaid.locator('[data-diagram-expand]').click();
  await expect(popout.locator('[data-diagram-svg] svg')).toBeVisible();
  await clickPart(page, part(popout, 'Deploy'));
  await expect(composer(page)).toContainText('Deploy');
  await shot(page, '02-desktop-popout-composing');
  await saveComment(page, 'Add a canary first.');
  await expect(badges(popout)).toHaveCount(2);
  // The thread's keys stand down under the popout (R would open the reply box behind it).
  await page.keyboard.press('r');
  await page.keyboard.press('Escape');
  await expect(popout).toHaveCount(0);
  await expect(body).toBeVisible();
  await expect(badges(mermaid)).toHaveCount(2);
  await expect(page.locator('.ib-rbox')).toHaveCount(0);

  // The reply box's list names the part, and points back at it.
  await openReply(page);
  const chip = page.locator('[data-annotations-chip]');
  await expect(chip).toHaveText('3 annotations');
  await chip.click();
  const row = page.locator('.ib-annpop [data-annotation-row]').filter({ hasText: 'Tests pass?' });
  await expect(row).toContainText('node B');
  await expect(row).toContainText('Run the integration suite here too.');
  await shot(page, '03-desktop-reply-list');
  await row.locator('button').first().click();
  await expect(mermaid).toHaveClass(/ib-q-target/);
  await expect(mermaid.locator('[data-diagram-mark] .animate-pulse')).toHaveCount(1);
  await expect(mermaid.locator('[data-diagram-mark] .animate-pulse')).toHaveCount(0);

  // Send: the agent reads which part each comment is on.
  if (await page.locator('.ib-annpop').count()) await page.locator('.ib-annpop').getByRole('button', { name: 'Close the list' }).click();
  await page.locator('.ib-rbox textarea').fill('Two notes on the flow.');
  await page.locator('section.ib-pane').getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('.ib-rbox')).toHaveCount(0);
  const answer = await claude.waitForReply(sent.thread_id as string, 10);
  expect(answer.status).toBe('replied');
  const text = (answer.reply as { body: string }).body;
  expect(text).toContain('# Feedback on your messages');
  expect(text).toContain('Feedback on: "Tests pass?"');
  expect(text).toContain(`Diagram node Tests pass? (B), line ${B_LINE}`);
  expect(text).toContain('> Run the integration suite here too.');
  expect(text).toContain('Feedback on: "Deploy"');
  expect(text).toContain('Diagram node Deploy (C), line 6');
  expect(text).toContain(`Diagram node worker, line ${WORKER_LINE}`);
  expect(text).toContain('> One worker is not enough.');

  // Sent: the comments wait no more, so the parts carry no badge.
  await page.reload();
  await expect(page.locator('article[data-author="person"]')).toContainText('Two notes on the flow.');
  await page.locator(`[data-message-article="${id}"] [data-fold-head]`).first().click();
  await expect(mermaid.locator('[data-diagram-svg] svg')).toBeVisible();
  await expect(badges(mermaid)).toHaveCount(0);
  expect(world.errors).toEqual([]);
});

test("the person's own message, a sent reply and an archived message open no composer, as their words open no toolbar", async () => {
  const { page, claude, project } = world;
  const sent = await claude.send({ project_path: project, subject: 'Locked diagrams', thread: 'locked-diagrams', body: BODY });
  const id = sent.message_id as string;
  await page.goto(`${world.url}#thread=${sent.thread_id}`);
  const mermaid = message(page, id).locator('[data-diagram-block="mermaid"]');
  await expect(mermaid.locator('[data-diagram-svg] svg')).toBeVisible();

  // The person's own reply shows a diagram: nothing to comment on.
  await openReply(page);
  await page.locator('.ib-rbox textarea').fill(['Mine:', '', '```mermaid', 'flowchart TD', '  X[My part] --> Y[Other part]', '```'].join('\n'));
  await page.locator('section.ib-pane').getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('.ib-rbox')).toHaveCount(0);
  const mine = page.locator('article[data-author="person"] [data-diagram-block="mermaid"]').last();
  await expect(mine.locator('[data-diagram-svg] svg')).toBeVisible();
  await clickPart(page, part(mine, 'My part'));
  await expect(composer(page)).toHaveCount(0);

  // Archived: the agent's message before the archive takes none either.
  await page.locator('section.ib-pane').getByRole('button', { name: /Archive/ }).first().click();
  await expect(page.locator('section.ib-pane').getByRole('button', { name: 'Unarchive the thread' })).toBeVisible();
  await page.reload();
  await page.locator(`[data-message-article="${id}"] [data-fold-head]`).first().click();
  await expect(message(page, id).locator('[data-diagram-svg] svg').first()).toBeVisible();
  await expect(message(page, id)).not.toHaveAttribute('data-text-comments', '');
  await clickPart(page, part(mermaid, 'Deploy'));
  await expect(composer(page)).toHaveCount(0);
});

test('on a phone: a tap opens the composer in the window, a swipe scrolls, a sideways drag pans, and Send names the part', async ({ browser }) => {
  const { claude, project } = world;
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, colorScheme: 'light' });
  const page = await context.newPage();
  try {
    const sent = await claude.send({ project_path: project, subject: 'Release flow on a phone', thread: 'release-flow-phone', body: LONG });
    const id = sent.message_id as string;
    await page.goto(`${world.url}#thread=${sent.thread_id}`);
    const mermaid = message(page, id).locator('[data-diagram-block="mermaid"]');
    await expect(mermaid.locator('[data-diagram-svg] svg')).toBeVisible();
    const target = part(mermaid, 'Tests pass?');
    await target.scrollIntoViewIfNeeded();
    const cdp = await context.newCDPSession(page);
    const scroller = page.locator('.ib-pbody');
    // Real touches (phone-touch.ts): Input.synthesizeScrollGesture sends no moves on Linux, on a diagram or on plain text.
    const hand = await finger(page, 'chromium');

    // A swipe over the diagram scrolls the thread and opens nothing. It starts on the diagram, with room left to scroll.
    const start = await centreOf(target);
    const before = await scroller.evaluate((el) => el.scrollTop);
    expect(await scroller.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeGreaterThan(SWIPE_PX);
    expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-diagram-canvas]') != null, start)).toBe(true);
    await hand.down(start.x, start.y, 0, -SWIPE_PX);
    await hand.up();
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(before + SWIPE_PX / 2);
    await expect(composer(page)).toHaveCount(0);

    // A sideways drag pans the diagram and opens nothing.
    await target.scrollIntoViewIfNeeded();
    const from = await centreOf(target);
    const svg = mermaid.locator('[data-diagram-svg]');
    const transform = await svg.evaluate((el) => (el as HTMLElement).style.transform);
    await hand.down(from.x, from.y, 48, 0, 8);
    await hand.up();
    await expect.poll(() => svg.evaluate((el) => (el as HTMLElement).style.transform)).not.toBe(transform);
    await expect(composer(page)).toHaveCount(0);

    // Two fingers are never a tap on a part.
    const two = await centreOf(target);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: two.x, y: two.y, id: 0 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: two.x, y: two.y, id: 0 }, { x: two.x + 40, y: two.y + 30, id: 1 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [{ x: two.x, y: two.y, id: 0 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(composer(page)).toHaveCount(0);

    // A tap on a part at the bottom of the canvas: the composer, whole, inside the window and the diagram's box.
    const insideTheCanvas = async () => {
      const box = (await composer(page).boundingBox())!;
      const frame = (await mermaid.locator('[data-diagram-canvas]').boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
      expect(box.y).toBeGreaterThanOrEqual(frame.y - 1);
      expect(box.y + box.height).toBeLessThanOrEqual(frame.y + frame.height + 1);
    };
    const low = await centreOf(part(mermaid, 'Fix the build'));
    await page.touchscreen.tap(low.x, low.y);
    await expect(composer(page)).toContainText('Fix the build');
    await insideTheCanvas();
    await composer(page).getByRole('button', { name: 'Cancel' }).tap();
    await expect(composer(page)).toHaveCount(0);

    // A tap on a part names it, and the comment goes out with the reply.
    const tap = await centreOf(target);
    await page.touchscreen.tap(tap.x, tap.y);
    await expect(composer(page)).toContainText('Tests pass?');
    await insideTheCanvas();
    await shot(page, '04-phone-composing-on-a-part');
    await saveComment(page, 'Say what fails the gate.');
    await expect(badges(mermaid)).toHaveCount(1);

    // The foot's Send carries it.
    await openReply(page);
    await page.locator('section.ib-pane').getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.ib-rbox')).toHaveCount(0);
    const answer = await claude.waitForReply(sent.thread_id as string, 10);
    expect((answer.reply as { body: string }).body).toContain('Diagram node Tests pass? (B)');
  } finally {
    await context.close();
  }
});
