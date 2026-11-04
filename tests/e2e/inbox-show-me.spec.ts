/**
 * Show me in the Inbox's code review (approval "shape-in-code-review", mock
 * ac2), proved in a real browser against the compiled binary. The agent is
 * scripted (tests/helpers/inbox-ask-agent.ts: a real connection and the real
 * pull client, never a real agent CLI); it answers a Show me as the request
 * tells an agent to: it writes the drawing to a scratch file and sends it with
 * the real `plannotator review draw`, then answers in a sentence.
 *
 * Proves, in order:
 *  1. Selecting lines offers Comment · Ask · Show me; Show me opens the box
 *     naming the lines; the agent gets the request (lines, review, turn) and
 *     the box says it is drawing; the picture opens over the diff with the
 *     agent's answer under it.
 *  2. A click on a part opens its code (its chapter, the lines painted) and
 *     the picture shrinks to the corner card naming the part; the card grows
 *     it back. Plain Ask opens the Ask window with the lines named.
 *  3. The Overview draws the agent's picture sent with the guide; a part opens
 *     its code. A review with no Overview picture offers one Show me.
 *  4. Round 2: the redrawn Overview tags its changed parts; Show me on lines
 *     asked in round 1 opens that picture as asked, its rewritten parts tagged
 *     "changed since asked", with Show me again.
 *  5. The same popover and picture at 390 px; "Tell your agents" never shows.
 *
 * Code review is on in the scratch config; HOME is never changed: the sandbox
 * env keeps the binary off the person's agents. gh and glab are traps.
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-show-me.spec.ts`.
 * 2x PNGs land in PLANNOTATOR_E2E_SHOTS_DIR (default .local/proof/show-me),
 * named as the mock's shots.
 */

import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { scratchProject } from '../../scripts/inbox-sim';
import { startScriptedAskAgent, type ScriptedAskAgent } from '../helpers/inbox-ask-agent';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shotsDir = resolve(process.env.PLANNOTATOR_E2E_SHOTS_DIR ?? join(repo, '.local/proof/show-me'));

const WORKER = 'src/jobs/retry-worker.ts';
const SCHEDULE = 'src/billing/schedule.ts';
const DUNNING = 'src/email/dunning.ts';

const FILES_R1: Record<string, string[]> = {
  'src/billing/errors.ts': [
    "const TEMPORARY = new Set(['card_declined_temporarily', 'processing_error', 'rate_limited']);",
    '',
    'export function isTemporary(code: string): boolean {',
    '  return TEMPORARY.has(code);',
    '}',
  ],
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
    "import { isTemporary } from '../billing/errors';",
    "import { sendDunningEmail } from '../email/dunning';",
    '',
    'export async function runRetryWorker(now: Date) {',
    '  const due = await db.failedCharges.due(now);',
    '  for (const row of due) {',
    '    const result = await charge(row.invoice);',
    '    if (result.ok) { await db.failedCharges.remove(row.id); continue; }',
    '    if (!isTemporary(result.code)) { await sendDunningEmail(row.invoice, result.code); continue; }',
    '    const next = nextAttemptAt(row.failedAt, row.attempt + 1);',
    '    if (next) {',
    '      await db.failedCharges.update(row.id, { attempt: row.attempt + 1, next_at: next });',
    '    } else {',
    '      await sendDunningEmail(row.invoice, result.code);',
    '    }',
    '  }',
    '}',
  ],
  [DUNNING]: [
    "import { mail } from './mail';",
    "import { cardUrl } from '../billing/cards';",
    '',
    'export async function sendDunningEmail(inv: Invoice, code: string) {',
    '  await mail.send({',
    '    to: inv.customerEmail,',
    "    template: 'dunning',",
    '    data: { amount: inv.amount, updateCardUrl: cardUrl(inv) },',
    '  });',
    '}',
  ],
  'src/billing/schedule.test.ts': [
    "import { expect, test } from 'bun:test';",
    "import { nextAttemptAt } from './schedule';",
    '',
    "test('three attempts, then none', () => {",
    "  const at = new Date('2026-11-01T00:00:00Z');",
    '  expect(nextAttemptAt(at, 4)).toBeNull();',
    '});',
  ],
};

/** Round 2: a log line above the worker, the else branch removes the row, the email is sent once, the schedule jitters. */
const FILES_R2: Record<string, string[]> = {
  ...FILES_R1,
  [WORKER]: [
    ...FILES_R1[WORKER]!.slice(0, 5),
    "import { log } from '../log';",
    ...FILES_R1[WORKER]!.slice(5, 15),
    '    } else {',
    '      await db.failedCharges.remove(row.id);',
    '      await sendDunningEmail(row.invoice, result.code);',
    '    }',
    '  }',
    "  log.info('retry worker ran', { due: due.length });",
    '}',
  ],
  [DUNNING]: [...FILES_R1[DUNNING]!.slice(0, 4), "  if (await mail.sentFor(inv.id, 'dunning')) return; // never twice", ...FILES_R1[DUNNING]!.slice(4)],
  [SCHEDULE]: [...FILES_R1[SCHEDULE]!.slice(0, 5), '  const jitter = 1 + (Math.random() * 0.2 - 0.1);', '  return new Date(failedAt.getTime() + hours * jitter * 3_600_000);', '}'],
};

function chargesProject(parent: string) {
  const project = scratchProject(parent, 'charges');
  const git = (...args: string[]) => {
    const run = spawnSync('git', args, { cwd: project, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } });
    if (run.status !== 0) throw new Error(run.stderr);
    return run.stdout;
  };
  writeFileSync(join(project, 'README.md'), '# charges\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const write = (files: Record<string, string[]>) => {
    for (const [path, lines] of Object.entries(files)) {
      mkdirSync(join(project, path, '..'), { recursive: true });
      writeFileSync(join(project, path), `${lines.join('\n')}\n`);
    }
    git('add', '-A');
    return git('diff', '--cached');
  };
  const round1 = write(FILES_R1);
  const round2 = write(FILES_R2);
  return { project, round1, round2 };
}

const BOX_CSS = [
  '.flow { display: grid; grid-template-columns: 1fr 70px 1fr 70px 1fr; grid-template-rows: auto 90px auto; align-items: center; padding: 24px 10px; }',
  '.eyebrow { grid-column: 1 / -1; font: 600 13px/1 var(--font-mono, ui-monospace, monospace); letter-spacing: .12em; color: var(--ink2); margin: 0 0 26px; }',
  '.box { border: 2px solid var(--ink); border-radius: 10px; padding: 14px 16px; text-align: center; background: var(--surface); }',
  '.box b { display: block; font-size: 17px; color: var(--ink); }',
  '.box span { display: block; font-size: 14px; color: var(--ink2); margin-top: 4px; }',
  '.box.catch { border-color: var(--mark); background: var(--mark-soft); text-align: left; }',
  '.box.catch i { display: block; font-style: normal; color: var(--mark); font-size: 13px; }',
  '.arrow { text-align: center; color: var(--grey); font-size: 13px; }',
  '.down { grid-column: 5; text-align: center; color: var(--grey); font-size: 13px; }',
  '.back { color: var(--mark); font-size: 13px; text-align: center; }',
].join('\n');

/** The Show me picture of the worker's lines 16–18, as the scripted agent draws it. */
const SHOW_ME_DRAWING = {
  kind: 'html',
  title: 'After the third failure',
  source: [
    '<div class="flow">',
    '<p class="eyebrow">AFTER THE THIRD FAILURE</p>',
    `<div class="box" data-step="1" data-mark="fail" data-code="${WORKER}#L12-L13"><b>3rd retry fails</b><span>the worker’s charge, attempt 3</span></div>`,
    '<div class="arrow">asks →</div>',
    `<div class="box" data-step="2" data-mark="next" data-code="${SCHEDULE}#L3-L5"><b>No next attempt</b><span>nextAttemptAt(…, 3) → null</span></div>`,
    '<div class="arrow">so →</div>',
    `<div class="box" data-step="3" data-mark="cmail" data-code="${DUNNING}#L4-L6"><b>One dunning email</b><span>amount and update-card link</span></div>`,
    '<div class="back" style="grid-column: 1 / 4">↑ charged and emailed again · Due again: the worker picks the row up ← next minute</div>',
    '<div></div><div class="down">↓ then</div>',
    '<div style="grid-column: 1 / 5"></div>',
    `<div class="box catch" data-step="4" data-mark="cstay" data-code="${WORKER}#L16-L18"><i>The catch</i><b>The row stays</b><span>nothing removes it, and its next_at is already past</span></div>`,
    '</div>',
  ].join(''),
  css: BOX_CSS,
  width: 1000,
  height: 440,
  // A phone draws the same parts stacked.
  tall: {
    source: [
      '<div class="stack">',
      '<p class="eyebrow">AFTER THE THIRD FAILURE</p>',
      `<div class="box" data-mark="fail" data-code="${WORKER}#L12-L13"><b>3rd retry fails</b><span>the worker’s charge, attempt 3</span></div>`,
      '<div class="arrow">↓ asks</div>',
      `<div class="box" data-mark="next" data-code="${SCHEDULE}#L3-L5"><b>No next attempt</b><span>nextAttemptAt(…, 3) → null</span></div>`,
      '<div class="arrow">↓ so</div>',
      `<div class="box" data-mark="cmail" data-code="${DUNNING}#L4-L6"><b>One dunning email</b><span>amount and update-card link</span></div>`,
      '<div class="arrow">↓ then</div>',
      `<div class="box catch" data-mark="cstay" data-code="${WORKER}#L16-L18"><i>The catch</i><b>The row stays</b><span>nothing removes it, and its next_at is already past</span></div>`,
      '<div class="back">↓ next minute: charged and emailed again</div>',
      '</div>',
    ].join(''),
    css: `${BOX_CSS}\n.stack { display: flex; flex-direction: column; gap: 10px; padding: 16px 18px; }\n.stack .eyebrow { margin: 0 0 6px; }`,
  },
};
const SHOW_ME_ANSWER = 'After the third failure nothing deletes the row, so a minute later the worker charges it again and emails again, every minute. Lines 16–18 need a remove in the else branch.';

const overview = (round: 1 | 2) => ({
  text: 'A failed charge now retries on a schedule when the failure is temporary, and ends in one dunning email.',
  diagram: {
    kind: 'html',
    source: [
      '<div class="flow" style="grid-template-rows: auto auto">',
      '<p class="eyebrow">A FAILED CHARGE</p>',
      `<div class="box" data-step="1" data-mark="temp" data-code="src/billing/errors.ts#L3-L5"><b>Temporary?</b><span>isTemporary(code)</span></div>`,
      '<div class="arrow">yes →</div>',
      `<div class="box" data-step="2" data-mark="next" data-code="${SCHEDULE}#L3-L${round === 1 ? 6 : 7}"><b>Next attempt</b><span>${round === 1 ? '1 h, 6 h, 24 h after the failure' : '1 h, 6 h, 24 h, each ±10%'}</span></div>`,
      '<div class="arrow">then →</div>',
      `<div class="box" data-step="3" data-mark="email" data-code="${DUNNING}#L4-L${round === 1 ? 9 : 10}"><b>One dunning email</b><span>${round === 1 ? 'the amount and an update-card link' : 'amount, update-card link; never twice'}</span></div>`,
      '</div>',
    ].join(''),
    css: BOX_CSS,
    width: 1000,
    height: 220,
  },
});

const guide = (round: 1 | 2, withOverview = true) => ({
  title: 'Retry failed charges on a schedule',
  intent: 'Retry only temporary failures, on a schedule, and end in one dunning email.',
  ...(withOverview ? { overview: overview(round) } : {}),
  sections: [
    { title: 'Only temporary failures retry', overview: 'A decline that will never pass stops at once.', diffs: [{ file: 'src/billing/errors.ts', summary: 'The temporary codes.' }] },
    { title: 'When the next attempt runs', overview: 'Three attempts: 1 h, 6 h and 24 h after the failure.', diffs: [{ file: SCHEDULE, summary: 'The schedule.' }] },
    { title: 'The worker, and the email at the end', overview: 'The worker charges each due row; after the third failure it sends the dunning email.', diffs: [{ file: WORKER, summary: 'The worker.' }, { file: DUNNING, summary: 'The email.' }] },
    { title: 'Tests for the schedule', overview: 'Three attempts, then none.', diffs: [{ file: 'src/billing/schedule.test.ts', summary: 'One test.' }] },
  ],
  review: { gitRef: 'main...HEAD', base: 'main' },
  generator: { engine: 'claude-code', model: 'claude-opus-5' },
});

interface World {
  root: string;
  dataDir: string;
  env: Record<string, string>;
  url: string;
  project: string;
  round1: string;
  round2: string;
  client: Client;
  agent: ScriptedAskAgent;
  /** Holds the agent's drawing until the waiting shot is taken. */
  hold: { release: () => void; promise: Promise<void> } | null;
  draws: { status: number | null; stdout: string; stderr: string }[];
  context: BrowserContext;
  page: Page;
  errors: string[];
}

let world: World;

function gate() {
  let release = () => {};
  const promise = new Promise<void>((done) => (release = done));
  return { release, promise };
}

async function noAgentsDialog(page: Page): Promise<void> {
  await expect(page.getByText('Tell your agents', { exact: false })).toHaveCount(0);
}

async function shot(page: Page, name: string, schemes: readonly ('light' | 'dark')[] = ['light']): Promise<void> {
  await noAgentsDialog(page);
  for (const scheme of schemes) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(450);
    await page.screenshot({ path: join(shotsDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
}

const call = async (name: string, args: Record<string, unknown>) => {
  const result = (await world.client.callTool({ name, arguments: { ...args, agent_session: 'ses-charges', agent_host: 'claude-code', agent_name: 'Claude Code' } })) as { isError?: boolean; content?: { text?: string }[]; structuredContent?: Record<string, unknown> };
  if (result.isError) throw new Error(`${name}: ${result.content?.map((c) => c.text).join(' ')}`);
  return result.structuredContent as { thread_id: string; message_id: string };
};

/** Select lines in a file's diff: a click on the first line's number, a shift-click on the last. */
async function selectLines(page: Page, file: string, from: number, to: number): Promise<void> {
  const shell = page.locator(`[data-guide-file-shell="${file}"]`).first();
  const line = (n: number) => shell.locator(`[data-line-type="change-addition"][data-column-number="${n}"]`).first();
  // The diff draws its lines after its card comes into view (and may draw them again): wait for them, then aim.
  await shell.scrollIntoViewIfNeeded();
  await expect(line(from)).toBeVisible({ timeout: 30_000 });
  await expect(async () => line(from).scrollIntoViewIfNeeded({ timeout: 2_000 })).toPass({ timeout: 15_000 });
  await shell.hover();
  await line(from).click();
  if (to !== from) await line(to).click({ modifiers: ['Shift'] });
}

const chooser = (page: Page) => page.locator('[data-selection-chooser]');
const sheet = (page: Page) => page.locator('[data-show-me-sheet]');
const corner = (page: Page) => page.locator('[data-show-me-corner]');
const part = (scope: Locator, mark: string) => scope.locator('.shp-drawn-host').first().locator(`[data-mark="${mark}"]`);

test.describe.configure({ mode: 'serial' });
test.use({ actionTimeout: 20_000 });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  mkdirSync(shotsDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-show-me-');
  const dataDir = join(root, 'data');
  markTourDecided(dataDir);
  const config = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) as Record<string, unknown>;
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ ...config, inboxCodeReview: true }));
  // Nothing here may reach the real gh, glab or tailscale.
  const trap = join(root, 'trap');
  mkdirSync(trap);
  for (const name of ['gh', 'glab', 'tailscale']) {
    writeFileSync(join(trap, name), `#!/bin/sh\necho "inbox-show-me: ${name} must not run" >&2\nexit 97\n`);
    chmodSync(join(trap, name), 0o755);
  }
  for (const dir of ['claude', 'codex', 'xdg', 'opencode']) mkdirSync(join(root, dir), { recursive: true });
  const env: Record<string, string> = {
    PATH: `${trap}:${process.env.PATH ?? ''}`,
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
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
  const { project, round1, round2 } = chargesProject(join(root, 'src'));
  const client = new Client({ name: 'inbox-show-me', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${registry.port}/mcp`)));

  const draws: World['draws'] = [];
  // The agent: what the request says to do, with the real CLI.
  const agent = startScriptedAskAgent({
    port: registry.port,
    token: registry.token,
    session: 'ses-charges',
    project,
    reply: async (text) => {
      const review = /--review (\S+)/.exec(text)?.[1];
      const turn = /--turn (\S+)/.exec(text)?.[1];
      if (!review || !turn) return 'That was a plain question.';
      if (world.hold) await world.hold.promise;
      const file = join(root, `show-me-${turn}.json`);
      writeFileSync(file, JSON.stringify(SHOW_ME_DRAWING));
      const run = spawnSync(binary, ['review', 'draw', '--file', file, '--review', review, '--turn', turn], { env, encoding: 'utf8', timeout: 30_000 });
      draws.push({ status: run.status, stdout: run.stdout, stderr: run.stderr });
      return SHOW_ME_ANSWER;
    },
  });

  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: 'light', reducedMotion: 'reduce' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  world = { root, dataDir, env, url, project, round1, round2, client, agent, hold: null, draws, context, page, errors };
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

let round1: { thread_id: string; message_id: string };
let round2: { thread_id: string; message_id: string };

test('Show me on selected lines: the popover, the box, the agent draws, the picture opens over the diff', async () => {
  const { page } = world;
  round1 = await call('submit_guide', { project_path: world.project, guide: guide(1), patch: world.round1, review: true, subject: 'Retry failed charges', body: 'Ready for review.' });
  await page.goto(`${world.url}#thread=${round1.thread_id}`);
  await page.locator('[data-review-card]').getByRole('button', { name: 'Start review' }).click();
  const pane = page.locator('[data-review-message]');
  await expect(pane).toBeVisible();
  await pane.locator('[data-review-chapters] li').nth(3).click();

  await selectLines(page, WORKER, 16, 18);
  await expect(chooser(page)).toBeVisible();
  await expect(chooser(page).getByRole('button')).toHaveText(['Comment', 'Ask', 'Show me']);
  await shot(page, '01-pop', ['light', 'dark']);

  await chooser(page).getByRole('button', { name: 'Show me' }).click();
  const box = page.locator('[data-show-me-box]');
  await expect(box).toHaveAttribute('data-show-me-box', 'compose');
  await expect(box.locator('[data-show-me-place]')).toHaveText('retry-worker.ts · lines 16–18');
  await expect(box).toContainText('Claude Code draws it');
  await shot(page, '02-box');

  world.hold = gate();
  await box.getByLabel('What the picture should show').fill('What happens after the third failure?');
  await box.locator('[data-show-me-send]').click();
  await expect(box).toHaveAttribute('data-show-me-box', 'drawing');
  await expect(box).toContainText('Claude Code is drawing it.');
  await expect(box.getByRole('button', { name: 'Stop' })).toBeVisible();
  await shot(page, '03-wait');
  // The request the agent got: the lines, the review, the turn and the CLI line.
  await expect.poll(() => world.agent.asked.length).toBe(1);
  const asked = world.agent.asked[0]!;
  expect(asked).toContain(`The reviewer pressed Show me on lines 16–18 of ${WORKER}`);
  expect(asked).toContain(`(${round1.message_id}): "What happens after the third failure?"`);
  expect(asked).toMatch(new RegExp(`plannotator review draw --file /tmp/show-me.json --review ${round1.message_id} --turn \\S+`));
  world.hold.release();
  world.hold = null;

  await expect(sheet(page)).toBeVisible({ timeout: 30_000 });
  expect(world.draws.at(-1)).toMatchObject({ status: 0 });
  expect(world.draws.at(-1)!.stdout).toContain('Sent. It opens over the review, beside your answer.');
  await expect(box).toHaveCount(0);
  await expect(sheet(page)).toContainText('After the third failure');
  await expect(sheet(page)).toContainText('Claude Code · Show me on retry-worker.ts lines 16–18 · round 1');
  await expect(sheet(page).locator('[data-show-me-answer]')).toContainText('nothing deletes the row', { timeout: 15_000 });
  await expect(part(sheet(page), 'cstay')).toBeVisible();
  await shot(page, '04-drawn', ['light', 'dark']);
});

test('a part opens its code and the picture shrinks to the corner card; plain Ask opens the Ask window', async () => {
  const { page } = world;
  const pane = page.locator('[data-review-message]');
  // From another chapter: the part's chapter opens.
  await page.locator('[data-show-me-sheet]').getByRole('button', { name: 'Shrink the picture' }).click();
  await pane.locator('[data-review-chapters] li').nth(1).click();
  await corner(page).getByRole('button', { name: 'Grow the picture' }).click();
  await part(sheet(page), 'cmail').click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(corner(page)).toBeVisible();
  await expect(corner(page).locator('.ib-sm-pip-f')).toHaveText('One dunning email · dunning.ts lines 4–6');
  const dunning = page.locator(`[data-guide-file-shell="${DUNNING}"]`).first();
  await expect(dunning).toBeInViewport();
  await shot(page, '05-clicked');
  await corner(page).getByRole('button', { name: 'Grow the picture' }).click();
  await expect(sheet(page)).toBeVisible();
  await sheet(page).getByRole('button', { name: 'Close the picture' }).click();
  await expect(sheet(page)).toHaveCount(0);

  // Plain Ask stays words: the Ask window opens with the lines named, and nothing is sent.
  const asked = world.agent.asked.length;
  await selectLines(page, WORKER, 13, 13);
  await chooser(page).getByRole('button', { name: 'Ask' }).click();
  const askBox = page.locator('[data-chat-window] textarea');
  await expect(askBox).toBeVisible();
  await expect(askBox).toHaveValue('retry-worker.ts line 13: ');
  expect(world.agent.asked.length).toBe(asked);
  // The Show me turn reads as the person asked it, never as the agent's request to draw.
  const transcript = page.locator('[data-chat-window] [data-message-role="user"]').first();
  await expect(transcript).toContainText('Show me on retry-worker.ts lines 16–18: What happens after the third failure?');
  await expect(page.locator('[data-chat-window]')).not.toContainText('plannotator review draw');
  await askBox.fill('');
  await page.locator('[data-chat-window]').getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.locator('[data-chat-window]')).toHaveCount(0);
});

test("the Overview draws the agent's picture, a part opens its code; with no picture, the Overview offers Show me", async () => {
  const { page } = world;
  await page.goto(`${world.url}#thread=${round1.thread_id}`);
  await page.locator('[data-review-card]').getByRole('button', { name: /review/ }).click();
  const pane = page.locator('[data-review-message]');
  await pane.locator('[data-review-chapters] li').first().click();
  const fig = page.locator('[data-overview-figure]');
  await expect(fig).toBeVisible();
  await expect(fig).toContainText('How it works');
  await expect(fig).toContainText('drawn by Claude Code with the guide');
  await expect(fig).toContainText('Click a part to open its code');
  await fig.scrollIntoViewIfNeeded();
  await shot(page, '06-overview');
  await part(fig, 'next').click();
  await expect(page.locator(`[data-guide-file-shell="${SCHEDULE}"]`).first()).toBeInViewport();

  const bare = await call('submit_guide', { project_path: world.project, guide: guide(1, false), patch: world.round1, review: true, thread: 'no-picture', subject: 'Retry failed charges (no picture)', body: 'Ready.' });
  await page.goto(`${world.url}#thread=${bare.thread_id}`);
  await page.locator('[data-review-card]').getByRole('button', { name: 'Start review' }).click();
  const ask = page.locator('[data-overview-show-me]');
  await expect(ask).toBeVisible();
  await ask.getByRole('button', { name: 'Show me' }).click();
  await expect(page.locator('[data-show-me-place]')).toHaveText('The whole review');
  await page.locator('[data-show-me-box]').getByRole('button', { name: 'Close Show me' }).click();
});

test('round 2: the redrawn Overview tags its changed parts; a Show me picture stays as asked', async () => {
  const { page } = world;
  round2 = await call('submit_guide', { project_path: world.project, guide: guide(2), patch: world.round2, review: true, reply_to: round1.message_id, body: 'Round 2: the row is removed, one email, jitter.' });
  expect(round2.thread_id).toBe(round1.thread_id);
  await page.goto(`${world.url}#thread=${round2.thread_id}`);
  await page.locator('[data-review-card]').last().getByRole('button', { name: /review/ }).click();
  const pane = page.locator(`[data-review-message="${round2.message_id}"]`);
  await expect(pane).toBeVisible();
  const fig = page.locator('[data-overview-figure]');
  await expect(fig).toContainText('redrawn by Claude Code for round 2 · 2 parts changed');
  await expect(part(fig, 'next')).toHaveAttribute('data-shp-tag', 'changed');
  await expect(part(fig, 'email')).toHaveAttribute('data-shp-tag', 'changed');
  await expect(part(fig, 'temp')).not.toHaveAttribute('data-shp-tag', /./);
  await fig.scrollIntoViewIfNeeded();
  await shot(page, '08-r2-ov');

  // Lines asked in round 1 (now 17–20 after the new import): the round-1 picture, as asked.
  await pane.locator('[data-review-chapters] li').nth(3).click();
  await selectLines(page, WORKER, 17, 18);
  await chooser(page).getByRole('button', { name: 'Show me' }).click();
  await expect(sheet(page)).toBeVisible();
  await expect(sheet(page)).toContainText('As asked in round 1. Its parts still open the right lines; 2 of them changed since.');
  await expect(part(sheet(page), 'cstay')).toHaveAttribute('data-shp-tag', 'changed since asked');
  await expect(part(sheet(page), 'cmail')).toHaveAttribute('data-shp-tag', 'changed since asked');
  await expect(part(sheet(page), 'fail')).not.toHaveAttribute('data-shp-tag', /./);
  await shot(page, '07-r2');
  // A part whose lines moved opens them where they are now (12–13 → 13–14).
  await part(sheet(page), 'fail').click();
  await expect(corner(page).locator('.ib-sm-pip-f')).toHaveText('3rd retry fails · retry-worker.ts lines 13–14');
  await corner(page).getByRole('button', { name: 'Grow the picture' }).click();
  await sheet(page).getByRole('button', { name: 'Show me again' }).click();
  await expect(page.locator('[data-show-me-box]')).toHaveAttribute('data-show-me-box', 'compose');
  await page.locator('[data-show-me-box]').getByRole('button', { name: 'Close Show me' }).click();
  expect(world.errors).toEqual([]);
});

test('the picture moves by its header like the window, stays in the pane, keeps its place, and a double-click puts it back', async ({ browser }) => {
  // Its own recorded context: the walkthrough lands in PLANNOTATOR_E2E_VIDEO_DIR (default the shots folder's parent).
  const videoDir = resolve(process.env.PLANNOTATOR_E2E_VIDEO_DIR ?? join(shotsDir, '..', 'video'));
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: 'light', reducedMotion: 'reduce', recordVideo: { dir: videoDir, size: { width: 1280, height: 800 } } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(`${world.url}#thread=${round2.thread_id}`);
    await page.locator('[data-review-card]').last().getByRole('button', { name: /review/ }).click();
    const pane = page.locator(`[data-review-message="${round2.message_id}"]`);
    await expect(pane).toBeVisible();
    await pane.locator('[data-review-chapters] li').nth(3).click();
    await selectLines(page, WORKER, 17, 18);
    await chooser(page).getByRole('button', { name: 'Show me' }).click();
    const picture = sheet(page);
    await expect(picture).toBeVisible();
    await page.waitForTimeout(600);
    const header = picture.locator('.ib-sm-sheet-h');
    await expect(header).toHaveCSS('cursor', 'grab');
    const home = (await picture.boundingBox())!;
    const inside = async () => {
      const box = (await picture.boundingBox())!;
      const frame = (await pane.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(frame.x - 0.5);
      expect(box.y).toBeGreaterThanOrEqual(frame.y - 0.5);
      expect(box.x + box.width).toBeLessThanOrEqual(frame.x + frame.width + 0.5);
      expect(box.y + box.height).toBeLessThanOrEqual(frame.y + frame.height + 0.5);
      return box;
    };
    const grab = { x: home.x + 300, y: home.y + 30 };
    await page.mouse.move(grab.x, grab.y);
    await page.mouse.down();
    await expect(header).toHaveAttribute('data-show-me-drag', '');
    await page.mouse.move(grab.x - 90, grab.y + 30, { steps: 12 });
    await expect(header).toHaveAttribute('data-show-me-drag', 'dragging');
    await page.mouse.move(grab.x - 240, grab.y + 70, { steps: 18 });
    await page.mouse.up();
    let box = await inside();
    expect(Math.round(box.x - home.x)).toBe(-240);
    expect(Math.round(box.y - home.y)).toBe(70);
    await page.waitForTimeout(500);
    await shot(page, '09-dragged');

    // Past the pane's edge: it stops at the edge.
    await page.mouse.move(box.x + 300, box.y + 30);
    await page.mouse.down();
    await page.mouse.move(box.x + 300 + 2000, box.y + 30 + 2000, { steps: 20 });
    await page.mouse.up();
    box = await inside();
    await page.waitForTimeout(500);

    // It keeps its place through the corner card and back.
    await picture.getByRole('button', { name: 'Shrink the picture' }).click();
    await expect(corner(page)).toBeVisible();
    await page.waitForTimeout(500);
    await corner(page).getByRole('button', { name: 'Grow the picture' }).click();
    await expect(picture).toBeVisible();
    const back = (await picture.boundingBox())!;
    expect(Math.round(back.x)).toBe(Math.round(box.x));
    expect(Math.round(back.y)).toBe(Math.round(box.y));
    await page.waitForTimeout(500);

    // A narrower window clamps it again.
    await page.setViewportSize({ width: 1100, height: 760 });
    await page.waitForTimeout(400);
    await inside();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(400);

    // A double-click on the header puts it back where it started.
    await header.dblclick({ position: { x: 300, y: 30 } });
    await expect(picture).not.toHaveAttribute('data-moved', '');
    const reset = (await picture.boundingBox())!;
    expect(Math.round(reset.x)).toBe(Math.round(home.x));
    expect(Math.round(reset.y)).toBe(Math.round(home.y));
    await page.waitForTimeout(800);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('a phone at 390 px: the popover and the picture', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: 'light', reducedMotion: 'reduce', hasTouch: true });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    // Its own thread: one review, so Show me asks (no earlier round's picture to open as asked).
    const review = await call('submit_guide', { project_path: world.project, guide: guide(1), patch: world.round1, review: true, thread: 'phone', subject: 'Retry failed charges (phone)', body: 'Ready for review.' });
    await page.goto(`${world.url}#thread=${review.thread_id}`);
    await page.locator('[data-review-card]').getByRole('button', { name: 'Start review' }).click();
    await expect(page.locator(`[data-review-message="${review.message_id}"]`)).toBeVisible();
    await selectLines(page, WORKER, 16, 18);
    await expect(chooser(page)).toBeVisible();
    await shot(page, 'phone-01-pop', ['light', 'dark']);
    await chooser(page).getByRole('button', { name: 'Show me' }).click();
    await page.locator('[data-show-me-box] [data-show-me-send]').click();
    await expect(sheet(page)).toBeVisible({ timeout: 30_000 });
    await expect(sheet(page).locator('[data-show-me-answer]')).toContainText('nothing deletes the row', { timeout: 15_000 });
    await shot(page, 'phone-04-drawn', ['light', 'dark']);
    // A phone's picture is a sheet: it does not move.
    await expect(sheet(page).locator('.ib-sm-sheet-h')).not.toHaveAttribute('data-show-me-drag', /.*/);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
