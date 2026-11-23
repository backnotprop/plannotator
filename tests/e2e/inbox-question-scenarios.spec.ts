/**
 * A question's scenario table on the Inbox's card (approval
 * "question-scenario-table", design A), proved in a real browser against the
 * compiled binary. Nothing is mocked: the binary runs `plannotator inbox
 * --background` under a temp PLANNOTATOR_DATA_DIR and HOME, and a Claude Code
 * agent asks through `plannotator inbox mcp` (scripts/inbox-sim.ts).
 *
 * On a desktop card the table shows (scenarios as rows, options as columns)
 * under Why and above Trade-offs, and the list form is hidden; a pick fills
 * the picked option's column. On a phone (390 and 320 wide) each scenario is
 * a heading with one line per option, the table is hidden, and nothing on
 * the page or in the card scrolls sideways; a 4 by 4 table too. Pictures land
 * in PLANNOTATOR_E2E_PROOF_DIR/question-scenarios/ (default
 * .local/proof/question-scenarios/).
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'question-scenarios');

const CHOICES = [
  '- [ ] Nowhere — the losing edit is dropped',
  '- [ ] Local only, purged after 30 days — kept on the device that lost',
  '    Pros: no server change; works offline',
  '    Cons: other devices never see it',
  '- [ ] Server-side per user — kept on our server, for every device',
  '    Pros: survives a reinstall',
  '    Cons: needs a retention policy; storage cost',
];

const THREE = [
  ':::question',
  'Where should an edit that loses a sync conflict go?',
  'Stakes: decides whether a lost edit can ever come back.',
  '',
  'When two copies of a note disagree, the newest edit wins and the other one is set aside.',
  '',
  ...CHOICES,
  '',
  'Recommended: Local only, purged after 30 days',
  'Why: covers a plane or a train with no server work; coming back after 6 weeks is rare.',
  '',
  '| Scenario | Nowhere | Local only | Server-side |',
  '| --- | --- | --- | --- |',
  '| You edit offline on a plane while a teammate edits the same note | Lost — nothing says so | Kept — in the note\'s History on this laptop | Kept — in History on every device |',
  '| Ada and Bob edit the same line at once | Lost — Bob\'s line is gone; Ada never knows | Kept on Bob\'s laptop — Ada can\'t see it | Kept — both see Bob\'s line in History |',
  '| You come back after 6 weeks to look for your edit | Lost — nothing to find | Lost — purged at 30 days | Kept — still in History |',
  ':::',
].join('\n');

const FOUR = [
  ':::question',
  'Where should an edit that loses a sync conflict go, now with a fourth way?',
  '',
  ...CHOICES,
  '- [ ] Ask every time — show both versions and let the person pick',
  '',
  'Recommended: Local only, purged after 30 days',
  'Why: covers a plane or a train with no server work.',
  '',
  '| Scenario | Nowhere | Local only | Server-side | Ask every time |',
  '| --- | --- | --- | --- | --- |',
  '| You edit offline on a plane while a teammate edits the same note | Lost — nothing says so | Kept — in the note\'s History on this laptop | Kept — in History on every device | You pick — both versions show when you land |',
  '| Ada and Bob edit the same line at once | Lost — Bob\'s line is gone; Ada never knows | Kept on Bob\'s laptop — Ada can\'t see it | Kept — both see Bob\'s line in History | Bob picks — Ada is not asked |',
  '| You come back after 6 weeks to look for your edit | Lost — nothing to find | Lost — purged at 30 days | Kept — still in History | Nothing to find — you chose back then |',
  '| You reinstall the app | Lost | Lost — it went with the old install | Kept — back after you sign in | Lost — unless you kept yours then |',
  ':::',
].join('\n');

interface World {
  url: string;
  claude: SimAgent;
  context: BrowserContext;
  page: Page;
  errors: string[];
  project: string;
  three: string;
  four: string;
}

let world: World;

const cardOf = (page: Page) => page.locator('section.ib-pane fieldset.question-block');

async function snap(page: Page, name: string, target: ReturnType<Page['locator']>, scheme: 'light' | 'dark' = 'light'): Promise<void> {
  await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
  await page.waitForTimeout(300);
  await target.screenshot({ path: join(proofDir, `${name}.png`) });
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

/** Nothing scrolls sideways: not the page, not the card or anything in it, and nothing in the scenarios section pokes past the card. */
async function expectNoSideScroll(page: Page): Promise<void> {
  const report = await page.evaluate(() => {
    const doc = document.documentElement;
    const card = document.querySelector('section.ib-pane fieldset.question-block') as HTMLElement;
    const box = card.getBoundingClientRect();
    const poking = [...card.querySelectorAll('[data-question-part="scenarios"] *')]
      .filter((el) => (el as HTMLElement).offsetParent !== null)
      .filter((el) => el.getBoundingClientRect().right > box.right + 0.5 || el.getBoundingClientRect().left < box.left - 0.5)
      .map((el) => el.textContent?.slice(0, 40));
    const scrollers = [...card.querySelectorAll('*')]
      .filter((el) => el.scrollWidth > el.clientWidth + 1 && ['auto', 'scroll'].includes(getComputedStyle(el).overflowX))
      .map((el) => `${el.tagName}.${(el as HTMLElement).className}`.slice(0, 80));
    return { page: doc.scrollWidth - doc.clientWidth, card: card.scrollWidth - card.clientWidth, poking, scrollers };
  });
  expect(report).toEqual({ page: 0, card: 0, poking: [], scrollers: [] });
}

async function onPhone(browser: Browser, width: number, threadId: string, run: (page: Page) => Promise<void>): Promise<void> {
  const phone = await browser.newContext({ viewport: { width, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'light' });
  try {
    const page = await phone.newPage();
    page.on('pageerror', (error) => world.errors.push(error.message));
    await page.goto(`${world.url}#thread=${threadId}`);
    await expect(cardOf(page)).toBeVisible();
    await run(page);
  } finally {
    await phone.close();
  }
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-scenarios-e2e-');
  const dataDir = join(root, 'data');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9', PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const project = scratchProject(join(root, 'src'), 'notes');
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const three = (await claude.send({ project_path: project, subject: 'Sync conflicts', body: THREE }, { wakes: true })).thread_id as string;
  const four = (await claude.send({ project_path: project, subject: 'Sync conflicts, four ways', body: FOUR }, { wakes: true })).thread_id as string;
  world = { url, claude, context, page, errors, project, three, four };
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

test('desktop: a real table under Why and above Trade-offs; a pick fills its column; phones get a list that never scrolls sideways', async ({ browser }: { browser: Browser }) => {
  const { page, three, four } = world;
  await page.goto(`${world.url}#thread=${three}`);
  const card = cardOf(page);
  await expect(card).toBeVisible();
  const section = card.locator('[data-question-part="scenarios"]');
  const table = section.getByRole('table', { name: 'Scenarios' });
  await expect(table).toBeVisible();
  await expect(section.locator('[data-question-scenarios-list]')).toBeHidden();
  await expect(table.getByRole('columnheader')).toHaveText(['Scenario', 'Nowhere', 'Local only', 'Server-side']);
  await expect(table.getByRole('rowheader')).toHaveCount(3);
  // Under Why, above Trade-offs, in the drawn order.
  const tops = await card.evaluate((el) => ['why', 'scenarios', 'tradeoffs'].map((part) => Math.round(el.querySelector(`[data-question-part="${part}"]`)!.getBoundingClientRect().top)));
  expect(tops[0]).toBeLessThan(tops[1]!);
  expect(tops[1]).toBeLessThan(tops[2]!);
  // The table stays in the question's context, but the card leaves it out of the context it draws: one table.
  await expect(card.locator('table')).toHaveCount(1);
  await expectNoSideScroll(page);
  await snap(page, '01-desktop-light', card);
  await snap(page, '02-desktop-dark', card, 'dark');

  await card.locator('label[data-question-option]', { hasText: 'Local only, purged after 30 days' }).click();
  const on = table.locator('[data-question-scenario-on]');
  await expect(on).toHaveCount(4);
  expect(await on.evaluateAll((cells) => cells.map((c) => (c as HTMLTableCellElement).cellIndex))).toEqual([2, 2, 2, 2]);
  // The same fill as the picked row.
  const fills = () => card.evaluate((el) => [
    getComputedStyle(el.querySelector('label[data-question-option]:has(input:checked)')!).backgroundColor,
    getComputedStyle(el.querySelector('[data-question-scenarios-table] [data-question-scenario-on]')!).backgroundColor,
  ]);
  // The row's fill eases in: wait for it to settle, then compare.
  await expect.poll(async () => { const [row, column] = await fills(); return row === column && column !== 'rgba(0, 0, 0, 0)'; }).toBe(true);
  await snap(page, '03-picked-light', card);

  for (const [width, name] of [[390, '04-phone-390-light'], [320, '05-phone-320-light']] as const) {
    await onPhone(browser, width, three, async (p) => {
      const phoneCard = cardOf(p);
      const list = phoneCard.locator('[data-question-scenarios-list]');
      await expect(list).toBeVisible();
      await expect(phoneCard.locator('[data-question-scenarios-table]')).toBeHidden();
      await expect(list.getByRole('list', { name: 'Scenarios' })).toBeVisible();
      await expect(list.getByRole('heading')).toHaveText([
        'You edit offline on a plane while a teammate edits the same note',
        'Ada and Bob edit the same line at once',
        'You come back after 6 weeks to look for your edit',
      ]);
      // An option's name wraps between words, never inside one.
      const broken = await list.evaluate((el) => [...el.querySelectorAll('[data-question-scenario-name]')].flatMap((name) => {
        const words: string[] = [];
        const walk = document.createTreeWalker(name, NodeFilter.SHOW_TEXT);
        for (let node = walk.nextNode(); node; node = walk.nextNode()) {
          if ((node.parentElement as HTMLElement).closest('.sr-only')) continue;
          for (const m of (node.textContent ?? '').matchAll(/\S+/g)) {
            const range = document.createRange();
            range.setStart(node, m.index!);
            range.setEnd(node, m.index! + m[0].length);
            const lines = new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)));
            if (lines.size > 1) words.push(m[0]);
          }
        }
        return words;
      }));
      expect(broken).toEqual([]);
      await expectNoSideScroll(p);
      await snap(p, name, phoneCard);
    });
  }

  await onPhone(browser, 390, four, async (p) => {
    const phoneCard = cardOf(p);
    await phoneCard.locator('label[data-question-option]', { hasText: 'Local only, purged after 30 days' }).click();
    const list = phoneCard.locator('[data-question-scenarios-list]');
    await expect(list).toBeVisible();
    await expect(list.getByRole('heading')).toHaveCount(4);
    await expect(list.locator('[data-question-scenario-on]')).toHaveCount(4);
    await expectNoSideScroll(p);
    await snap(p, '06-four-by-four-phone-light', phoneCard);
  });
  expect(world.errors).toEqual([]);
});
