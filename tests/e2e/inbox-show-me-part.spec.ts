/**
 * Show me from a board: on any part, the Annotate box offers Ask · Change it · Show me, and the agent draws a NEW
 * board; the one it was pressed on stays as it was, as many as the person needs, a board from a board from a board.
 * Proved in a real browser against the compiled binary. The agent is scripted (a real connection, the real pull
 * client, the real `plannotator shape`; never a real agent CLI).
 *
 * In order: from a review (Code review on, Shape's switch off), the box, the wait on the board, the new board, three
 * levels, the arrow, browser Back, each board intact, Show me again, the whole-board box, a part outside the diff,
 * the list with 2, 6 and 20 boards, several presses in a row, a phone's tap; the review's selection still works; then
 * Shape on its own (Code review off): the same on a board over its thread, with a plain Ask still refused; then both
 * off: nothing.
 *
 * HOME is a scratch folder. gh and glab are traps. Build the binary first (see inbox.spec.ts). 2x PNGs land in
 * PLANNOTATOR_E2E_SHOTS_DIR (default .local/proof/show-me-part).
 */

import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { inboxShowMeRequest } from '../../packages/core/inbox-review';
import { scratchProject } from '../../scripts/inbox-sim';
import { startScriptedAskAgent, type ScriptedAskAgent } from '../helpers/inbox-ask-agent';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shotsDir = resolve(process.env.PLANNOTATOR_E2E_SHOTS_DIR ?? join(repo, '.local/proof/show-me-part'));

const WORKER = 'src/jobs/retry-worker.ts';
const SCHEDULE = 'src/billing/schedule.ts';
/** In the project, in no review's diff. */
const OUTSIDE = 'src/billing/ledger.ts';

const FILES: Record<string, string[]> = {
  [SCHEDULE]: [
    'const DELAYS_H = [1, 6, 24];',
    '',
    'export function nextAttemptAt(failedAt: Date, attempt: number): Date | null {',
    '  const hours = DELAYS_H[attempt - 1];',
    '  if (hours === undefined) return null;',
    '  return new Date(failedAt.getTime() + hours * 3_600_000);',
    '}',
  ],
  [WORKER]: [
    "import { db } from '../db';",
    "import { charge } from '../billing/stripe';",
    "import { nextAttemptAt } from '../billing/schedule';",
    '',
    'export async function runRetryWorker(now: Date) {',
    '  const due = await db.failedCharges.due(now);',
    '  for (const row of due) {',
    '    const result = await charge(row.invoice);',
    '    if (result.ok) { await db.failedCharges.remove(row.id); continue; }',
    '    const next = nextAttemptAt(row.failedAt, row.attempt + 1);',
    '    if (next) await db.failedCharges.update(row.id, { attempt: row.attempt + 1, next_at: next });',
    '  }',
    '}',
  ],
};
const BASE_FILES: Record<string, string[]> = {
  [OUTSIDE]: ['export function post(entry: Entry) {', '  book.push(entry);', '  return book.length;', '}', 'export const book: Entry[] = [];'],
};

function chargesProject(parent: string) {
  const project = scratchProject(parent, 'charges');
  const git = (...args: string[]) => {
    const run = spawnSync('git', args, { cwd: project, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } });
    if (run.status !== 0) throw new Error(run.stderr);
    return run.stdout;
  };
  const write = (files: Record<string, string[]>) => {
    for (const [path, lines] of Object.entries(files)) {
      mkdirSync(join(project, path, '..'), { recursive: true });
      writeFileSync(join(project, path), `${lines.join('\n')}\n`);
    }
    git('add', '-A');
  };
  writeFileSync(join(project, 'README.md'), '# charges\n');
  write(BASE_FILES);
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  write(FILES);
  return { project, patch: git('diff', '--cached') };
}

const guide = {
  title: 'Retry failed charges on a schedule',
  intent: 'Retry only temporary failures, on a schedule.',
  overview: { text: 'A failed charge now retries on a schedule.' },
  sections: [
    { title: 'When the next attempt runs', overview: 'Three attempts: 1 h, 6 h and 24 h after the failure.', diffs: [{ file: SCHEDULE, summary: 'The schedule.' }] },
    { title: 'The worker', overview: 'The worker charges each due row.', diffs: [{ file: WORKER, summary: 'The worker.' }] },
  ],
  review: { gitRef: 'main...HEAD', base: 'main' },
  generator: { engine: 'claude-code', model: 'claude-opus-5' },
};

/** A board with a part in each view, titled so each is told from the others. */
function boardOf(title: string, version: number) {
  const box = (x: number, y: number, w: number, mark: string, code: string, words: string, sub: string) =>
    `<g data-mark="${mark}" data-code="${code}"><rect x="${x}" y="${y}" width="${w}" height="120" rx="10" fill="transparent" stroke="currentColor"/><text x="${x + 22}" y="${y + 52}" font-size="26" font-weight="600" fill="currentColor">${words}</text><text x="${x + 22}" y="${y + 88}" font-size="18" fill="currentColor" opacity=".65">${sub}</text></g>`;
  return {
    title,
    claim: `${title}, version ${version}.`,
    ...(version > 1 ? { note: `v${version}.` } : {}),
    views: {
      picture: {
        width: 1200,
        height: 420,
        html: `<svg viewBox="0 0 1200 420" xmlns="http://www.w3.org/2000/svg">${box(40, 40, 520, 'charge', `${WORKER}#L8-L9`, 'The worker charges a due row', 'then removes it, or plans the next')}${box(640, 40, 520, 'next', `${SCHEDULE}#L3-L6`, 'The next attempt', '1 h, 6 h, 24 h after the failure')}${box(40, 240, 1120, 'ledger', `${OUTSIDE}#L1-L3`, 'The ledger, outside the review', 'a click lands in the whole file')}</svg>`,
      },
      how: {
        width: 1000,
        height: 200,
        html: `<svg viewBox="0 0 1000 200" xmlns="http://www.w3.org/2000/svg">${box(40, 40, 920, 'how-due', `${WORKER}#L6`, 'Each minute it reads the due rows', 'db.failedCharges.due(now)')}</svg>`,
      },
      know: 'After the third failure the worker **stops**, and the row stays.',
      // The board's Code view: a whole file it may open, outside any diff.
      ...(title === 'On its own'
        ? { code: { stage: 'after', guide: { title, intent: 'Where entries go.', sections: [{ title: 'The ledger', overview: 'Where entries go.', diffs: [] }] }, files: [{ path: OUTSIDE, line: 1 }] } }
        : {}),
    },
    refs: [{ n: 1, kind: 'file', title: 'The worker', sub: 'Charges each due row', target: WORKER, line: 8 }],
  };
}

interface World {
  dataDir: string;
  env: Record<string, string>;
  url: string;
  project: string;
  patch: string;
  client: Client;
  agent: ScriptedAskAgent;
  /** Each request the agent got. */
  requests: string[];
  hold: { release: () => void; promise: Promise<void> } | null;
  shape: (args: string[]) => { status: number | null; stdout: string; stderr: string };
  storeBoard: (title: string, flags: string[]) => { id: string; v: number };
  context: BrowserContext;
  page: Page;
  errors: string[];
  review: { thread_id: string; message_id: string };
}
let world: World;

function gate() {
  let release = () => {};
  const promise = new Promise<void>((done) => (release = done));
  return { release, promise };
}
async function shot(page: Page, name: string, schemes: readonly ('light' | 'dark')[] = ['light']): Promise<void> {
  await expect(page.getByText('Tell your agents', { exact: false })).toHaveCount(0);
  for (const scheme of schemes) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(450);
    await page.screenshot({ path: join(shotsDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
}
const setSwitches = (on: { inboxCodeReview: boolean; inboxShape: boolean }) => {
  const path = join(world.dataDir, 'config.json');
  writeFileSync(path, JSON.stringify({ ...(JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>), ...on }));
};
const board = (page: Page) => page.locator('[data-shape-layer]');
const part = (page: Page, mark: string) => board(page).locator('.shp-drawn-host').first().locator(`[data-mark="${mark}"]`);
const title = (page: Page) => board(page).locator('.shp-title, h1').first();
// The crosshair (Comment), in Annotate's place on the Inbox's board.
const annotate = (page: Page) => board(page).locator('.shp-tstrip button[aria-label="Comment"]').locator('visible=true');
const startAnnotating = async (page: Page) => {
  await expect(annotate(page)).toBeVisible();
  if ((await annotate(page).getAttribute('aria-pressed')) !== 'true') await annotate(page).click();
};
const showMeButton = (page: Page) => page.locator('[data-comment-extra-action]');
const waitBox = (page: Page) => page.locator('[data-show-me-box]');
const boardsMenu = (page: Page) => page.locator('[data-shape-boards-menu]');
const boardsButton = (page: Page) => board(page).locator('[data-shape-boards]');
const boardBack = (page: Page) => board(page).locator('[data-shape-board-back]');
const openReview = async (page: Page) => {
  await page.goto(`${world.url}#thread=${world.review.thread_id}`);
  await page.locator('[data-review-card]').last().getByRole('button', { name: /review/ }).click();
  await expect(page.locator('[data-review-message]')).toBeVisible();
};
/** What the store holds for a board: its versions and each one's picture. */
/** The boards, from the store itself. */
const listed = () => (JSON.parse(world.shape(['list', '--json']).stdout) as { shapes: { id: string; title: string }[] }).shapes;
const stored = (id: string) => {
  const read = JSON.parse(world.shape(['read', id]).stdout) as { version: { n: number; views: { picture?: { html?: string } } }; title?: string };
  return { n: read.version.n, picture: read.version.views.picture?.html ?? '' };
};
/** From now on, every other board the page shows, in the order it showed them (the one open now is not counted). */
const watchOpened = (page: Page) =>
  page.evaluate(() => {
    const showing = () => [...document.querySelectorAll('[data-shape-layer]:not([hidden])')].map((el) => el.getAttribute('data-shape-layer')!);
    const open = new Set(showing());
    const seen: string[] = [];
    (window as unknown as { __opened: string[] }).__opened = seen;
    const note = () => {
      for (const id of showing()) if (!open.has(id) && !seen.includes(id)) seen.push(id);
    };
    new MutationObserver(note).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-shape-layer', 'hidden'] });
  });
const opened = (page: Page) => page.evaluate(() => (window as unknown as { __opened?: string[] }).__opened ?? []);
/** The boards made since `before`, oldest first (ids sort by time). */
const madeSince = (before: Set<string>) => listed().map((s) => s.id).filter((id) => !before.has(id)).sort();
/** The new board has the focus on its title, and the window's live region says it. */
const focusedAndSaid = async (page: Page, newTitle: RegExp) => {
  try {
    await expect(board(page).locator('h1')).toBeFocused();
  } catch (error) {
    // Where the focus went instead, and whether the title was said, so a failure in CI says why.
    const where = await page.evaluate(() => {
      const el = document.activeElement;
      return `${el?.tagName ?? 'none'} ${el?.outerHTML.slice(0, 200) ?? ''} · said: ${document.querySelector('[data-inbox-live]')?.textContent ?? ''}`;
    });
    throw new Error(`${(error as Error).message}\nThe focus is on: ${where}`);
  }
  await expect(page.locator('[data-inbox-live]')).toHaveText(newTitle);
};
/** Annotate, click a part, optional words, Show me; the new board opens by itself. */
const showMeOnPart = async (page: Page, mark: string, newTitle: RegExp, words = '') => {
  await startAnnotating(page);
  await part(page, mark).click();
  if (words) await page.locator('textarea:visible').last().fill(words);
  await showMeButton(page).click();
  await expect(title(page)).toHaveText(newTitle, { timeout: 30_000 });
};

test.describe.configure({ mode: 'serial' });
test.use({ actionTimeout: 20_000 });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  mkdirSync(shotsDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-show-me-part-');
  const dataDir = join(root, 'data');
  markTourDecided(dataDir);
  const config = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) as Record<string, unknown>;
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ ...config, inboxCodeReview: true, inboxShape: false }));
  const trap = join(root, 'trap');
  mkdirSync(trap);
  for (const name of ['gh', 'glab', 'tailscale']) {
    writeFileSync(join(trap, name), `#!/bin/sh\necho "inbox-show-me-part: ${name} must not run" >&2\nexit 97\n`);
    chmodSync(join(trap, name), 0o755);
  }
  for (const dir of ['claude', 'codex', 'xdg', 'opencode']) mkdirSync(join(root, dir), { recursive: true });
  const env: Record<string, string> = {
    PATH: `${trap}:${process.env.PATH ?? ''}`,
    HOME: join(root, 'home'),
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_INBOX_TAILSCALE: '0',
    PLANNOTATOR_INBOX_PHONES: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_BROWSER,
    NO_ANON_PING: '1',
    PLANNOTATOR_INBOX_NOTES: '0',
    PLANNOTATOR_TEST_SANDBOX: '1',
    PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    CODEX_HOME: join(root, 'codex'),
    XDG_CONFIG_HOME: join(root, 'xdg'),
    OPENCODE_CONFIG_DIR: join(root, 'opencode'),
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  const url = started.stdout.trim();
  const registry = JSON.parse(readFileSync(join(dataDir, 'inbox', 'inbox.json'), 'utf8')) as { port: number; token: string };
  const { project, patch } = chargesProject(join(root, 'src'));
  const client = new Client({ name: 'inbox-show-me-part', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${registry.port}/mcp`)));

  const boardDir = join(root, 'board');
  mkdirSync(boardDir, { recursive: true });
  const shape = (args: string[]) => {
    const run = spawnSync(binary, ['shape', ...args], { env, cwd: project, encoding: 'utf8', timeout: 30_000 });
    return { status: run.status, stdout: run.stdout, stderr: run.stderr };
  };
  let files = 0;
  const storeBoard = (name: string, flags: string[]) => {
    const version = (flags.includes('--base') ? Number(flags[flags.indexOf('--base') + 1]) : 0) + 1;
    const file = join(boardDir, `board-${++files}.json`);
    writeFileSync(file, JSON.stringify(boardOf(name, version)));
    const run = shape(['update', '--file', file, ...flags]);
    if (run.status !== 0) throw new Error(run.stderr);
    return JSON.parse(run.stdout) as { id: string; v: number };
  };
  const requests: string[] = [];
  const agent = startScriptedAskAgent({
    port: registry.port,
    token: registry.token,
    session: 'ses-charges',
    project,
    reply: async (text) => {
      requests.push(text);
      if (world.hold) await world.hold.promise;
      const tied = /--thread (\S+?)( --through ([^`\s]+))?`/.exec(text);
      if (!tied) return 'That was a plain question.';
      const through = tied[3] ? ['--through', tied[3]] : [];
      const again = /Bring your Shape (shp_\S+) up to date/.exec(text)?.[1];
      if (again) {
        const read = JSON.parse(shape(['read', again]).stdout) as { version: { n: number }; shape?: { title?: string } };
        storeBoard(`${read.shape?.title ?? 'Again'}`, ['--id', again, '--base', String(read.version.n), ...through]);
        return 'Brought it up to date.';
      }
      const name = /pressed Show me on "([^"]*)"/.exec(text)?.[1];
      storeBoard(name ? `About ${name}` : 'First board', ['--thread', tied[1]!, ...through]);
      return 'Drew it.';
    },
  });

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light', reducedMotion: 'reduce' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const review = { thread_id: '', message_id: '' };
  world = { dataDir, env, url, project, patch, client, agent, requests, hold: null, shape, storeBoard, context, page, errors, review };
  const result = (await client.callTool({ name: 'submit_guide', arguments: { project_path: project, guide, patch, review: true, subject: 'Retry failed charges', body: 'Ready for review.', agent_session: 'ses-charges', agent_host: 'claude-code', agent_name: 'Claude Code' } })) as { isError?: boolean; content?: { text: string }[]; structuredContent?: { thread_id: string; message_id: string } };
  if (result.isError) throw new Error(result.content?.map((c) => c.text).join(' '));
  Object.assign(review, result.structuredContent);
});

test.afterAll(async () => {
  try {
    if (!world) return;
    world.agent.stop();
    await world.client.close().catch(() => {});
    await world.context.close();
  } finally {
    await removeInboxScratch();
  }
});

let first = '';
let second = '';
let third = '';

test('the review\'s Show me on selected lines still makes the first board, and a board alone has no list and no arrow', async () => {
  test.setTimeout(120_000);
  const { page } = world;
  await openReview(page);
  const shell = page.locator(`[data-guide-file-shell="${SCHEDULE}"]`).first();
  await page.locator('[data-review-message] [data-review-jump]').click();
  await page.locator('[data-review-jump-menu] [data-review-jump-row="0"]').click();
  const line = (n: number) => shell.locator(`[data-line-type="change-addition"][data-column-number="${n}"]`).first();
  await expect(line(3)).toBeVisible({ timeout: 30_000 });
  await shell.hover();
  await line(3).click();
  await line(5).click({ modifiers: ['Shift'] });
  await expect(page.locator('[data-selection-chooser]').getByRole('button')).toHaveText(['Comment', 'Ask', 'Show me']);
  await page.locator('[data-selection-chooser]').getByRole('button', { name: 'Show me' }).click();
  await page.locator('[data-show-me-send]').click();
  await expect(board(page)).toBeVisible({ timeout: 30_000 });
  await expect(title(page)).toHaveText('First board');
  first = listed()[0]!.id;
  expect(world.requests.at(-1)).toContain(`on lines 3–5 of ${SCHEDULE} in your review`);
  await expect(boardsButton(page)).toHaveCount(0);
  await expect(boardBack(page)).toHaveCount(0);
});

test('the box offers Ask, Change it, Show me; the wait is on the board; a new board opens, and the first is as it was', async () => {
  test.setTimeout(120_000);
  const { page } = world;
  const before = stored(first);
  await startAnnotating(page);
  await part(page, 'next').click();
  // In that order on the screen: the footer is reversed in the DOM.
  const footer = await Promise.all(['Ask', 'Change it', 'Show me'].map(async (name) => (await page.getByRole('button', { name, exact: true }).last().boundingBox())!.x));
  expect(footer[0]!).toBeLessThan(footer[1]!);
  expect(footer[1]!).toBeLessThan(footer[2]!);
  await shot(page, '01-box-three-buttons', ['light', 'dark']);

  world.hold = gate();
  await page.locator('textarea:visible').last().fill('how the delays add up');
  await showMeButton(page).click();
  const wait = waitBox(page);
  await expect(wait).toHaveAttribute('data-show-me-box', 'drawing');
  // The box it was pressed in has closed: the focus is on the board's title, not lost to the page.
  await expect(board(page).locator('h1')).toBeFocused();
  await expect(wait).toContainText('Claude Code is drawing it. It opens here when it’s ready.');
  await expect(wait).toContainText('The next attempt');
  await expect(wait).toContainText('how the delays add up');
  // On the board, not behind it: the top thing where it sits.
  const place = (await wait.boundingBox())!;
  const top = await page.evaluate(([x, y]) => !!document.elementFromPoint(x!, y!)?.closest('[data-show-me-box]'), [place.x + place.width / 2, place.y + place.height / 2]);
  expect(top).toBe(true);
  await shot(page, '02-drawing-wait', ['light', 'dark']);
  // The request says which part, its code, and to leave this board alone.
  const request = world.requests.at(-1)!;
  expect(request).toContain(`pressed Show me on "The next attempt" (${SCHEDULE}#L3-L6) in your Shape ${first}, from your review`);
  expect(request).toContain(`how the delays add up`);
  expect(request).toContain(`Make a new Shape of that part, so they can see it the way you see it, and leave ${first} as it is.`);
  expect(request).toContain(`--through ${world.review.message_id}`);
  world.hold.release();
  world.hold = null;

  await expect(title(page)).toHaveText('About The next attempt', { timeout: 30_000 });
  await expect(waitBox(page)).toHaveCount(0);
  await focusedAndSaid(page, /^About The next attempt$/);
  expect(stored(first)).toEqual(before);
  second = listed().find((s) => s.title === 'About The next attempt')!.id;
  await expect(boardBack(page)).toHaveAttribute('data-shape-board-back', first);
  await expect(boardsButton(page)).toContainText('2 of 2');
  await shot(page, '03-new-board-open', ['light', 'dark']);
});

test('a board from a board from a board; the arrow and browser Back come back up; each stays as it was', async () => {
  test.setTimeout(120_000);
  const { page } = world;
  const keptFirst = stored(first);
  const keptSecond = stored(second);
  // From How it works this time, a third level.
  await board(page).getByRole('button', { name: 'How it works' }).click();
  await expect(part(page, 'how-due')).toBeVisible();
  await showMeOnPart(page, 'how-due', /^About Each minute/);
  third = listed().find((s) => s.title.startsWith('About Each minute'))!.id;
  await expect(boardBack(page)).toHaveAttribute('data-shape-board-back', second);
  await expect(boardsButton(page)).toContainText('3 of 3');
  await boardsButton(page).click();
  await expect(boardsMenu(page).locator('[data-shape-boards-row]')).toHaveText(['First board', 'About The next attempt', /^About Each minute/]);
  await expect(boardsMenu(page).locator('[data-on]')).toHaveText(/^About Each minute/);
  await shot(page, '04-list-2-levels-down', ['light']);
  await page.keyboard.press('Escape');
  // Coming back up, a level at a time.
  await boardBack(page).click();
  await expect(title(page)).toHaveText('About The next attempt');
  await boardBack(page).click();
  await expect(title(page)).toHaveText('First board');
  await expect(boardBack(page)).toHaveCount(0);
  // Browser Back retraces the way the person went, down again here.
  await page.goBack();
  await expect(title(page)).toHaveText('About The next attempt');
  // A reload keeps the links: nothing is kept in the page.
  await page.reload();
  await expect(boardBack(page)).toHaveAttribute('data-shape-board-back', first, { timeout: 30_000 });
  expect(stored(first)).toEqual(keptFirst);
  expect(stored(second)).toEqual(keptSecond);
  expect(stored(third).n).toBe(1);
});

test('Show me again makes a new version of this board, not a new board, and it stays where it was in the list', async () => {
  test.setTimeout(90_000);
  const { page } = world;
  await expect(title(page)).toHaveText('About The next attempt');
  const count = listed().length;
  await board(page).getByRole('button', { name: 'Show me again' }).click();
  await page.locator('[data-show-me-send]').click();
  await expect(board(page).locator('.shp-claim')).toContainText('version 2', { timeout: 30_000 });
  expect(listed().length).toBe(count);
  expect(world.requests.at(-1)).toContain(`Bring your Shape ${second} up to date`);
  await expect(boardBack(page)).toHaveAttribute('data-shape-board-back', first);
});

test('What to know and the whole board have the same three, and each makes its own board', async () => {
  test.setTimeout(150_000);
  const { page } = world;
  await boardBack(page).click();
  await expect(title(page)).toHaveText('First board');
  // The whole board.
  await board(page).getByRole('button', { name: 'Global comment' }).click();
  await showMeButton(page).click();
  await expect(title(page)).toHaveText('About The whole board', { timeout: 30_000 });
  await expect(boardBack(page)).toHaveAttribute('data-shape-board-back', first);
  expect(world.requests.at(-1)).toContain(`pressed Show me on "The whole board" in your Shape ${first}`);
  await boardBack(page).click();

  // What to know: a part of the words.
  await board(page).getByRole('button', { name: 'What to know' }).click();
  await startAnnotating(page);
  const know = board(page).locator('[data-mark]').first();
  await expect(know).toBeVisible();
  await know.click();
  await expect(showMeButton(page)).toBeVisible();
  await shot(page, '05-box-on-what-to-know', ['light']);
  await showMeButton(page).click();
  // A paragraph is named by its words, not by a bold word in it.
  await expect(title(page)).toHaveText(/^About After the third failure/, { timeout: 30_000 });
  await expect(boardBack(page)).toHaveAttribute('data-shape-board-back', first);
});

test('the list with 6 boards and with 20: from any board, each under the board it came from', async () => {
  test.setTimeout(400_000);
  const { page } = world;
  await boardBack(page).click();
  await expect(title(page)).toHaveText('First board');
  await showMeOnPart(page, 'charge', /^About The worker charges/);
  await expect(boardsButton(page)).toContainText(/ of 6$/);
  await boardsButton(page).click();
  await expect(boardsMenu(page).locator('[data-shape-boards-row]')).toHaveCount(6);
  await shot(page, '06-list-6', ['light', 'dark']);
  await page.keyboard.press('Escape');

  // Fourteen more, from wherever the person is: deeper, then across.
  for (let i = 0; i < 14; i += 1) {
    const mark = ['next', 'charge', 'ledger'][i % 3]!;
    await startAnnotating(page);
    await part(page, mark).click();
    await page.locator('textarea:visible').last().fill(`look ${i + 7}`);
    const count = listed().length;
    await showMeButton(page).click();
    await expect.poll(() => listed().length, { timeout: 30_000 }).toBe(count + 1);
    await expect(waitBox(page)).toHaveCount(0, { timeout: 30_000 });
    // Back up one level now and then, so the tree has branches.
    if (i % 4 === 3) await boardBack(page).click();
  }
  await expect(boardsButton(page)).toContainText(/ of 20$/);
  await boardsButton(page).click();
  const rows = boardsMenu(page).locator('[data-shape-boards-row]');
  await expect(rows).toHaveCount(20);
  // Everything is reachable: the list scrolls, and it opens with this board in view.
  await expect(boardsMenu(page).locator('[data-on]')).toBeInViewport();
  await shot(page, '07-list-20', ['light', 'dark']);
  await rows.first().click();
  await expect(title(page)).toHaveText('First board');
  await boardsButton(page).click();
  await expect(boardsMenu(page).locator('[data-on]')).toHaveText('First board');
  await page.keyboard.press('Escape');
});

test('several in a row: each waits its turn, only the last opens, none is lost', async () => {
  test.setTimeout(120_000);
  const { page } = world;
  const before = new Set(listed().map((s) => s.id));
  const firstBefore = stored(first);
  await watchOpened(page);
  world.hold = gate();
  await startAnnotating(page);
  await part(page, 'next').click();
  await page.locator('textarea:visible').last().fill('queue one');
  await showMeButton(page).click();
  await expect(waitBox(page)).toHaveAttribute('data-show-me-box', 'drawing');
  await part(page, 'charge').click();
  await page.locator('textarea:visible').last().fill('queue two');
  await showMeButton(page).click();
  // The card stays on the one drawing; the press behind it says nothing and waits.
  await expect(waitBox(page).locator('[data-show-me-place]')).toHaveText('The next attempt');
  await shot(page, '08-second-press-waits', ['light']);
  world.hold.release();
  world.hold = null;
  await expect(title(page)).toHaveText(/^About The worker charges/, { timeout: 40_000 });
  const made = madeSince(before);
  expect(made).toHaveLength(2);
  // Only the last opened: the first never showed, not even for a moment.
  expect(await opened(page)).toEqual([made[1]]);
  await boardBack(page).click();
  await expect(title(page)).toHaveText('First board');
  expect(stored(first)).toEqual(firstBefore);
});

test('Stop stops only the one drawing: the next one waiting then goes, and nothing pressed is lost', async () => {
  test.setTimeout(120_000);
  const { page } = world;
  const before = new Set(listed().map((s) => s.id));
  const asked = world.requests.length;
  // The first waits on its own gate, so the second can be drawn while it holds.
  const held = gate();
  world.hold = held;
  await startAnnotating(page);
  await part(page, 'next').click();
  await page.locator('textarea:visible').last().fill('stop one');
  await showMeButton(page).click();
  await expect(waitBox(page)).toHaveAttribute('data-show-me-box', 'drawing');
  await expect.poll(() => world.requests.length, { timeout: 30_000 }).toBe(asked + 1);
  world.hold = null;
  await part(page, 'charge').click();
  await page.locator('textarea:visible').last().fill('stop two');
  await showMeButton(page).click();
  await waitBox(page).locator('[data-show-me-stop]').click();
  // The one behind it goes on its own: it reaches the agent, and its board opens.
  await expect.poll(() => world.requests.length, { timeout: 30_000 }).toBe(asked + 2);
  expect(world.requests.at(-1)).toContain('stop two');
  await expect(title(page)).toHaveText(/^About The worker charges/, { timeout: 40_000 });
  await expect(waitBox(page)).toHaveCount(0);
  // The scripted agent goes on with the stopped one when let go; wait for it, so no later Show me takes its board.
  held.release();
  await expect.poll(() => madeSince(before).length, { timeout: 30_000 }).toBe(2);
});

test('the board\'s × goes to the review, and the review\'s Shape button comes back to the newest board', async () => {
  const { page } = world;
  await boardsButton(page).click();
  await boardsMenu(page).locator('[data-shape-boards-row]').nth(2).click();
  await board(page).getByRole('button', { name: /close/i }).first().click();
  await expect(board(page)).toHaveCount(0);
  await expect(page.locator('[data-review-message]')).toBeVisible();
  await page.locator('[data-review-message] .ib-shapebtn').first().click();
  await expect(board(page)).toBeVisible();
  await shot(page, '09-way-back-from-review', ['light']);
});

test('800 wide and on a phone: the arrow, the list, and a tap on a part offers the same three', async () => {
  test.setTimeout(120_000);
  const { browser, page } = { browser: world.context.browser()!, page: world.page };
  await page.setViewportSize({ width: 800, height: 900 });
  await boardBack(page).or(boardsButton(page)).first().waitFor();
  await startAnnotating(page);
  await part(page, 'next').click();
  await expect(showMeButton(page)).toBeVisible();
  await shot(page, '10-800-box', ['light']);
  await page.keyboard.press('Escape');
  await boardsButton(page).click();
  await shot(page, '11-800-list', ['light']);
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1440, height: 900 });

  for (const width of [390, 320]) {
    const phone = await browser.newContext({ viewport: { width, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, colorScheme: 'light', reducedMotion: 'reduce', baseURL: world.url });
    const tab = await phone.newPage();
    try {
      await tab.goto(page.url());
      await expect(board(tab)).toBeVisible({ timeout: 30_000 });
      if (width === 390) await shot(tab, '12-phone-board', ['light']);
      await startAnnotating(tab);
      await part(tab, 'next').tap();
      await expect(showMeButton(tab)).toBeVisible();
      for (const name of ['Ask', 'Change it', 'Show me']) await expect(tab.getByRole('button', { name, exact: true }).last()).toBeInViewport();
      if (width === 390) await shot(tab, '13-phone-box', ['light', 'dark']);
      world.hold = gate();
      await showMeButton(tab).tap();
      await expect(waitBox(tab)).toBeVisible();
      await expect(waitBox(tab)).toBeInViewport();
      // The header's line is whole: it may wrap between words, never cut.
      const by = waitBox(tab).locator('.ib-sm-by');
      await expect(by).toHaveText('· Claude Code draws it');
      expect(await by.evaluate((el) => el.scrollWidth <= el.clientWidth && getComputedStyle(el).textOverflow !== 'ellipsis')).toBe(true);
      const close = (await waitBox(tab).locator('.ib-sm-x').boundingBox())!;
      const byBox = (await by.boundingBox())!;
      expect(byBox.x + byBox.width).toBeLessThanOrEqual(close.x + 1);
      await shot(tab, `14-phone-wait-${width}`, ['light', 'dark']);
      world.hold.release();
      world.hold = null;
      await expect(waitBox(tab)).toHaveCount(0, { timeout: 30_000 });
      // The way back, the list and the close share the top line; the title is under them, never behind them.
      await expect(boardBack(tab)).toBeVisible();
      const head = board(tab).locator('.shp-title-row');
      let heading = { x: 0, y: 0, width: 0, height: 0 };
      await expect(async () => {
        heading = (await head.locator('h1').boundingBox())!;
        for (const control of [boardBack(tab), boardsButton(tab), board(tab).locator('.shp-close')]) {
          const box = (await control.boundingBox())!;
          expect(box.y + box.height).toBeLessThanOrEqual(heading.y + 1);
        }
        expect(heading.height).toBeLessThan(2 * 27 * 1.1 + 4);
      }).toPass({ timeout: 10_000 });
      await shot(tab, `15-phone-new-board-${width}`, ['light', 'dark']);
      await boardsButton(tab).tap();
      await expect(boardsMenu(tab).locator('[data-on]')).toBeInViewport();
      // The open list is under the title, not over it.
      const menu = (await boardsMenu(tab).boundingBox())!;
      expect(menu.y).toBeGreaterThanOrEqual(heading.y + heading.height - 1);
      await shot(tab, `16-phone-list-${width}`, ['light', 'dark']);
      await tab.keyboard.press('Escape');
    } finally {
      await phone.close();
    }
  }
});

test('Shape on its own, Code review off: the same on a board over its thread; plain Ask is still off', async () => {
  test.setTimeout(150_000);
  const { page } = world;
  setSwitches({ inboxCodeReview: false, inboxShape: true });
  const thread = world.review.thread_id;
  const made = world.storeBoard('On its own', ['--thread', thread]);
  await page.goto(`${world.url}#thread=${thread}&shape=${made.id}`);
  await expect(title(page)).toHaveText('On its own', { timeout: 30_000 });
  const kept = stored(made.id);
  // The window's Ask stays off.
  const info = await page.evaluate(async (t) => {
    const plain = await fetch(`/api/inbox/threads/${t}/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ turn_id: 'ask_0', question: 'hello' }) });
    return { plain: plain.status };
  }, thread);
  expect(info.plain).toBe(404);
  // A board of another thread is refused, even with the exact request the window would send for it.
  const elsewhere = { review: null, file: null, lines: null, round: 1, part: { board: 'shp_01J8ZK3TQ4VW7Y9A2B5C6D8E0F', name: 'x' } };
  const otherQuestion = inboxShowMeRequest({ target: elsewhere, title: '', threadId: thread });
  const other = await page.evaluate(
    async ([t, question, showMe]) => {
      const res = await fetch(`/api/inbox/threads/${t}/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ turn_id: 'ask_01J8ZK3TQ4VW7Y9A2B5C6D8E0F', question, kind: 'show_me', show_me: JSON.parse(showMe!) }) });
      return { status: res.status, body: await res.text() };
    },
    [thread, otherQuestion, JSON.stringify(elsewhere)],
  );
  expect(other.status).toBe(422);
  expect(other.body).toContain('is not a board of this thread');
  await showMeOnPart(page, 'next', /^About The next attempt/);
  const request = world.requests.at(-1)!;
  expect(request).toContain(`The person pressed Show me on "The next attempt" (${SCHEDULE}#L3-L6) in your Shape ${made.id}.`);
  expect(request).toContain(`Store it with \`--thread ${thread}\`: it opens by itself`);
  expect(request).not.toContain('--through');
  await expect(boardBack(page)).toHaveAttribute('data-shape-board-back', made.id);
  expect(stored(made.id)).toEqual(kept);
  await shot(page, '17-shape-alone-new-board', ['light']);
  await boardBack(page).click();
  await expect(title(page)).toHaveText('On its own');

  // A part with code outside any diff (the Inbox's board has no Code view, so no whole file to box lines in): the
  // crosshair's box on the part has the same three, and the request names its code.
  await startAnnotating(page);
  await part(page, 'ledger').click();
  await expect(showMeButton(page)).toBeVisible();
  await shot(page, '18-box-on-a-part-outside-the-diff', ['light']);
  await showMeButton(page).click();
  await expect(title(page)).toHaveText(/^About The ledger, outside the review/, { timeout: 30_000 });
  expect(world.requests.at(-1)).toContain(`(${OUTSIDE}#L1-L3)`);
});

test('over a thread, × while one draws keeps the wait and the press behind it; the last opens when it lands', async () => {
  test.setTimeout(150_000);
  const { page } = world;
  const thread = world.review.thread_id;
  const made = world.storeBoard('Closed while drawing', ['--thread', thread]);
  await page.goto(`${world.url}#thread=${thread}&shape=${made.id}`);
  await expect(title(page)).toHaveText('Closed while drawing', { timeout: 30_000 });
  const before = new Set(listed().map((s) => s.id));
  await watchOpened(page);
  world.hold = gate();
  await startAnnotating(page);
  await part(page, 'next').click();
  await showMeButton(page).click();
  await expect(waitBox(page)).toHaveAttribute('data-show-me-box', 'drawing');
  await part(page, 'charge').click();
  await showMeButton(page).click();
  await board(page).locator('.shp-close').first().click();
  await expect(board(page)).toHaveCount(0);
  // The board is closed; the wait is not.
  await expect(waitBox(page)).toHaveAttribute('data-show-me-box', 'drawing');
  await shot(page, '19-thread-board-closed-wait-stays', ['light']);
  world.hold.release();
  world.hold = null;
  await expect(title(page)).toHaveText(/^About The worker charges/, { timeout: 40_000 });
  const two = madeSince(before);
  expect(two).toHaveLength(2);
  // Both pressed reached the agent, and only the last opened.
  expect(await opened(page)).toEqual([two[1]]);
  await focusedAndSaid(page, /^About The worker charges/);
});

test('over a thread, another thread opened while one draws: the new board opens in its own thread, not over the other', async () => {
  test.setTimeout(150_000);
  const { page } = world;
  const thread = world.review.thread_id;
  const sent = (await world.client.callTool({ name: 'send_message', arguments: { subject: 'Another thread', body: 'Something else.', project_path: world.project, agent_session: 'ses-other', agent_host: 'claude-code', agent_name: 'Claude Code' } })) as { structuredContent?: { thread_id: string } };
  const elsewhere = sent.structuredContent!.thread_id;
  const made = world.storeBoard('Moved away while drawing', ['--thread', thread]);
  await page.goto(`${world.url}#thread=${thread}&shape=${made.id}`);
  await expect(title(page)).toHaveText('Moved away while drawing', { timeout: 30_000 });
  world.hold = gate();
  await startAnnotating(page);
  await part(page, 'next').click();
  await showMeButton(page).click();
  await expect(waitBox(page)).toHaveAttribute('data-show-me-box', 'drawing');
  await page.goto(`${world.url}#thread=${elsewhere}`);
  await expect(page.getByRole('heading', { name: 'Another thread', level: 2 })).toBeVisible({ timeout: 30_000 });
  world.hold.release();
  world.hold = null;
  await expect(title(page)).toHaveText(/^About The next attempt/, { timeout: 40_000 });
  // Its own thread's board, with its own thread under it: never over the thread the person moved to.
  expect(new URL(page.url()).hash).toContain(`thread=${thread}`);
  expect(new URL(page.url()).hash).not.toContain(elsewhere);
});

test('both off: no board, and a Show me is refused', async () => {
  const { page } = world;
  setSwitches({ inboxCodeReview: false, inboxShape: false });
  const thread = world.review.thread_id;
  await page.goto(`${world.url}#thread=${thread}&shape=${first}`);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Retry failed charges', level: 2 })).toBeVisible({ timeout: 30_000 });
  await expect(board(page)).toHaveCount(0);
  await expect(page.locator('[data-comment-extra-action]')).toHaveCount(0);
  const refused = await page.evaluate(
    async ([t, b]) => (await fetch(`/api/inbox/threads/${t}/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ turn_id: 'ask_0', question: 'x', kind: 'show_me', show_me: { review: null, file: null, lines: null, part: { board: b, name: 'x' } } }) })).status,
    [thread, first],
  );
  expect(refused).toBe(404);
  setSwitches({ inboxCodeReview: true, inboxShape: false });
  expect(world.errors).toEqual([]);
});
