/**
 * Show me makes a Shape in the Inbox's code review (approval
 * "code-review-launch-build", item 1), proved in a real browser against the
 * compiled binary. The agent is scripted (tests/helpers/inbox-ask-agent.ts: a real
 * connection and the real pull client, never a real agent CLI); it does what the
 * request says, with the real `plannotator shape` and a seeded whiteboard board.
 * Code review and Shape are both on (Show me rides Shape's own switch too, approval
 * "code-review-029-shape-off"), but for one test that turns Shape off and finds no Show me.
 *
 * Proves, in order:
 *  1. Selecting lines offers Comment · Ask · Show me; Show me opens the box naming
 *     the lines; the agent gets the short request and the box says it is drawing;
 *     a reload finds the same request; the real board opens over the review.
 *  2. A click on a part lands on its line (its chapter, the lines painted) and the
 *     board shrinks to the corner card naming the part; the card grows it back as
 *     it was. Show me on the same lines opens it again, from any window, and asks
 *     nothing. Plain Ask opens the Ask window with the lines named.
 *  3. The thread works with the board as Shape does on its own: the Chat's Ask
 *     reaches the session and its answer shows; the crosshair's (Comment, in
 *     Annotate's place on the Inbox's board) and Global comment's Change it wake it and a new version draws in; the thread's own header has
 *     the Pebble; the board's Thread tab reads the thread.
 *  4. Show me again is a new turn and a new version of the same board.
 *  5. A busy agent gets the Ask window's choice, never "drawing".
 *  6. The Overview's picture sent with the guide still opens its code; with no
 *     picture, the Overview's Show me makes a board of the whole review.
 *  7. A phone at 390 px.
 *  8. An older `plannotator review draw` is refused and pointed at Shape; Shape's
 *     own places (the row, the grid) stay on Shape's switch.
 *  9. The agent failing or gone: the box goes back to its words with the Ask
 *     window's note.
 * 10. A board drawn on an earlier review lands where its code is now, says so when
 *     it cannot, and never paints its old numbers, stored through a reply too; nothing
 *     saying which review: the note, nothing painted; lines the diff can't show open in
 *     the board's own viewer; a deleted file and a rename's old name: the file and the
 *     note, never a dead click; leaving the review closes the board.
 *
 * 11. A drawn part's place in code on a board over the thread (`data-code`) shows the code:
 *     the review at that line, painted, with the board as the corner card naming no
 *     part (the owner, approval "review-show-me", addendum 2026-11-07); the card brings
 *     the board back over the review, its links land the same way, and Esc closes it.
 * 12. A Change it while the session answers another thread: quiet, then through, once.
 *
 * HOME is a scratch folder and the sandbox env keeps the binary off the person's agents.
 * gh and glab are traps. Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-show-me.spec.ts`.
 * 2x PNGs land in PLANNOTATOR_E2E_SHOTS_DIR (default .local/proof/show-me).
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

/**
 * The whiteboard the scripted agent stores: real crops of the review's own diff (the
 * way the Shape help says to draw), and a few words. `crops` are files beside it.
 */
function seededBoard(version: number) {
  const bubble = (n: number, x: number, y: number) => `<g data-ref="${n}"><circle cx="${x}" cy="${y}" r="15" class="acc-fill acc"/><text x="${x}" y="${y + 6}" text-anchor="middle" class="small t-acc">${n}</text></g>`;
  const label = (x: number, y: number, words: string, cls = '') => `<text x="${x}" y="${y}" class="big ${cls}">${words}</text>`;
  const small = (x: number, y: number, words: string, cls = 't-grey') => `<text x="${x}" y="${y}" class="small ${cls}">${words}</text>`;
  return {
    title: 'After the third failure',
    claim: version === 1 ? 'The last failure emails the customer, and the row stays due.' : `Version ${version}: the row is removed before the email goes.`,
    ...(version > 1 ? { note: `v${version}: what you asked for.` } : {}),
    views: {
      picture: {
        width: 1200,
        height: 620,
        css: '.big { font: 600 24px/1 var(--font-sans, system-ui); fill: var(--ink); } .small { font: 400 17px/1 var(--font-sans, system-ui); } .frame { fill: none; stroke: var(--rule); } .crop { stroke: var(--rule); fill: var(--surface); } .mail { fill: var(--surface); stroke: var(--ink); stroke-width: 1.5; }',
        html: `<svg viewBox="0 0 1200 620" xmlns="http://www.w3.org/2000/svg">
<g data-step="1" data-mark="worker" data-code="${WORKER}#L10-L13">
${label(40, 50, 'The worker charges a due row')}
<rect class="crop" x="40" y="70" width="520" height="200" rx="8"/>
<image href="crop-worker.png" x="44" y="74" width="512" height="192" preserveAspectRatio="xMinYMin slice"/>
</g>
<g data-step="2" data-mark="schedule" data-code="${SCHEDULE}#L3-L5">
${label(40, 340, 'No fourth attempt')}
<rect class="crop" x="40" y="360" width="520" height="180" rx="8"/>
<image href="crop-schedule.png" x="44" y="364" width="512" height="172" preserveAspectRatio="xMinYMin slice"/>
${small(40, 572, 'nextAttemptAt(…, 4) → null')}
</g>
${bubble(1, 560, 70)}${bubble(2, 560, 360)}${bubble(3, 1150, 70)}${bubble(4, 1150, 340)}
<path class="line" d="M580 170 C 660 170, 690 210, 740 230" fill="none"/><path class="line" d="M580 450 C 660 450, 690 350, 740 320" fill="none"/>
<g data-step="3" data-mark="email" data-code="${DUNNING}#L4-L9">
<rect class="mail" x="750" y="70" width="400" height="230" rx="10"/>
<text x="774" y="110" class="big">Your payment failed</text>
${small(774, 148, 'We could not charge $48.00.', 't-grey')}
<rect x="774" y="176" width="190" height="44" rx="8" class="acc-fill"/><text x="800" y="205" class="small t-acc">Update your card</text>
${small(774, 268, 'One dunning email, to the customer')}
</g>
<g data-step="4" data-mark="stays" data-code="${WORKER}#L16-L18">
<rect class="acc-fill acc" x="750" y="340" width="400" height="180" rx="10" stroke-dasharray="6 5"/>
<text x="774" y="384" class="big t-acc">${version === 1 ? 'The row stays' : 'The row is removed'}</text>
${small(774, 422, version === 1 ? 'Nothing removes it; next_at is already past,' : 'failedCharges.remove(row.id), then the email.', 't-acc')}
${small(774, 450, version === 1 ? 'so a minute later it charges and emails again.' : 'One email, and it stops.', 't-acc')}
</g>
</svg>`,
      },
      how: {
        width: 1000,
        height: 260,
        html: `<svg viewBox="0 0 1000 260" xmlns="http://www.w3.org/2000/svg"><g data-step="1" data-mark="how-due" data-code="${WORKER}#L8"><rect class="line" fill="none" x="20" y="90" width="220" height="80" rx="8"/><text x="130" y="136" text-anchor="middle">Row is due</text></g><path class="line" d="M240 130 H380" fill="none"/><text x="310" y="118" text-anchor="middle" class="t-grey">charges</text><g data-step="2" data-mark="how-fail" data-code="${WORKER}#L10-L13"><rect class="line" fill="none" x="380" y="90" width="220" height="80" rx="8"/><text x="490" y="136" text-anchor="middle">Temporary failure</text></g><path class="line" d="M600 130 H740" fill="none"/><text x="670" y="118" text-anchor="middle" class="t-grey">asks</text><g data-step="3" data-mark="how-email" data-code="${DUNNING}#L4-L9"><rect class="acc" fill="none" x="740" y="90" width="240" height="80" rx="8"/><text x="860" y="136" text-anchor="middle" class="t-acc">Dunning email</text></g></svg>`,
      },
      know: 'After the third failure the worker sends **one** dunning email. It does not remove the row, so the row is due again at once [^4].',
    },
    refs: [
      { n: 1, kind: 'file', title: 'The worker', sub: 'Charges each due row', target: WORKER, line: 10 },
      { n: 2, kind: 'file', title: 'The schedule', sub: '1 h, 6 h, 24 h, then none', target: SCHEDULE, line: 3 },
      { n: 3, kind: 'file', title: 'The email', sub: 'Amount and update-card link', target: DUNNING, line: 4 },
      { n: 4, kind: 'file', title: 'The catch', sub: 'Nothing removes the row', target: WORKER, line: 16 },
    ],
  };
}
const SHOW_ME_ANSWER = 'After the third failure nothing deletes the row, so a minute later the worker charges it again and emails again. Lines 16–18 need a remove in the else branch.';

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
  /** The next Show me ends with no words: the agent fails before it answers (nothing is kept). */
  fail: boolean;
  /** The folder the scripted agent's board and crops are in. */
  boardDir: string;
  shape: (args: string[]) => { status: number | null; stdout: string; stderr: string };
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
  const result = (await world.client.callTool({ name, arguments: { ...args, agent_session: 'ses-charges', agent_host: 'claude-code', agent_name: 'Claude Code' } })) as { isError?: boolean; content?: { text: string }[]; structuredContent: unknown };
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

/** The review's chapter menu in its top bar: go to a chapter, or to the Overview. */
async function pickChapter(page: Page, row: number | 'overview'): Promise<void> {
  await page.locator('[data-review-message] [data-review-jump]').click();
  await page.locator(`[data-review-jump-menu] [data-review-jump-row="${row}"]`).click();
  await expect(page.locator('[data-review-jump-menu]')).toHaveCount(0);
}

/** A real crop of a diff's lines, from the first added line down, for the scripted agent's board. */
async function cropLines(page: Page, shell: Locator, path: string): Promise<void> {
  await shell.scrollIntoViewIfNeeded();
  const line = (await shell.locator('[data-line-type="change-addition"]').first().boundingBox())!;
  const box = (await shell.boundingBox())!;
  await page.screenshot({ path, clip: { x: box.x + 6, y: line.y, width: box.width - 12, height: Math.min(200, box.y + box.height - line.y) } });
}

const chooser = (page: Page) => page.locator('[data-selection-chooser]');
const board = (page: Page) => page.locator('[data-shape-layer]');
const corner = (page: Page) => page.locator('[data-show-me-corner]');
const part = (scope: Locator, mark: string) => scope.locator('.shp-drawn-host').first().locator(`[data-mark="${mark}"]`);
const openReview = async (page: Page, thread: string) => {
  await page.goto(`${world.url}#thread=${thread}`);
  await page.locator('[data-review-card]').last().getByRole('button', { name: /review/ }).click();
  await expect(page.locator('[data-review-message]')).toBeVisible();
};

test.describe.configure({ mode: 'serial' });
test.use({ actionTimeout: 20_000 });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  mkdirSync(shotsDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-show-me-');
  const dataDir = join(root, 'data');
  markTourDecided(dataDir);
  const config = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) as Record<string, unknown>;
  // Code review and Shape on: Show me needs both.
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ ...config, inboxCodeReview: true, inboxShape: true }));
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
    // A scratch home: the skills route reads folders under it (`~/.agents/skills`).
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
  const { project, round1, round2 } = chargesProject(join(root, 'src'));
  const client = new Client({ name: 'inbox-show-me', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${registry.port}/mcp`)));

  const boardDir = join(root, 'board');
  mkdirSync(boardDir, { recursive: true });
  const shape = (args: string[]) => {
    const run = spawnSync(binary, ['shape', ...args], { env, cwd: project, encoding: 'utf8', timeout: 30_000 });
    return { status: run.status, stdout: run.stdout, stderr: run.stderr };
  };
  /** Store a version of the seeded board, with the real CLI. */
  const store = (version: number, flags: string[]) => {
    const file = join(boardDir, `board-${version}.json`);
    writeFileSync(file, JSON.stringify(seededBoard(version)));
    const run = shape(['update', '--file', file, ...flags]);
    if (run.status !== 0) throw new Error(run.stderr);
    return JSON.parse(run.stdout) as { id: string; v: number };
  };
  // The agent: what each request says to do, with the real CLI.
  const agent = startScriptedAskAgent({
    port: registry.port,
    token: registry.token,
    session: 'ses-charges',
    project,
    reply: async (text) => {
      const changes = /plannotator shape read (shp_\S+) --notes/.exec(text)?.[1];
      if (changes) {
        const read = JSON.parse(shape(['read', changes, '--notes']).stdout) as { version: { n: number } };
        store(read.version.n + 1, ['--id', changes, '--base', String(read.version.n)]);
        return 'Drew your change as a new version.';
      }
      if (text.includes('About the Shape board')) return 'The row stays because nothing in the else branch removes it.';
      const tied = /--thread (\S+) --through ([^`\s]+)/.exec(text);
      if (!tied) return 'That was a plain question.';
      if (world.hold) await world.hold.promise;
      if (world.fail) {
        world.fail = false;
        throw new Error('The session ended.');
      }
      const again = /Bring your Shape (shp_\S+) up to date/.exec(text)?.[1];
      if (again) {
        const n = (JSON.parse(shape(['read', again]).stdout) as { version: { n: number } }).version.n;
        store(n + 1, ['--id', again, '--base', String(n), '--through', tied[2]!]);
      } else {
        store(1, ['--thread', tied[1]!, '--through', tied[2]!]);
      }
      return SHOW_ME_ANSWER;
    },
  });

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light', reducedMotion: 'reduce' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  world = { root, dataDir, env, url, project, round1, round2, client, agent, hold: null, fail: false, boardDir, shape, context, page, errors };
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
let shapeId = '';

test('Show me on selected lines: the popover, the box, the agent makes a Shape, the board opens over the review', async () => {
  const { page } = world;
  round1 = await call('submit_guide', { project_path: world.project, guide: guide(1), patch: world.round1, review: true, subject: 'Retry failed charges', body: 'Ready for review.' });
  await openReview(page, round1.thread_id);
  const pane = page.locator('[data-review-message]');
  await pickChapter(page, 2);

  // Real crops of this review's diff, for the scripted agent's board.
  const workerShell = page.locator(`[data-guide-file-shell="${WORKER}"]`).first();
  await expect(workerShell.locator('[data-line-type="change-addition"]').first()).toBeVisible({ timeout: 30_000 });
  await cropLines(page, workerShell, join(world.boardDir, 'crop-worker.png'));
  await pickChapter(page, 1);
  const scheduleShell = page.locator(`[data-guide-file-shell="${SCHEDULE}"]`).first();
  await expect(scheduleShell.locator('[data-line-type="change-addition"]').first()).toBeVisible({ timeout: 30_000 });
  await cropLines(page, scheduleShell, join(world.boardDir, 'crop-schedule.png'));
  await pickChapter(page, 2);

  await selectLines(page, WORKER, 16, 18);
  await expect(chooser(page)).toBeVisible();
  await expect(chooser(page).getByRole('button')).toHaveText(['Comment', 'Ask', 'Show me']);
  await shot(page, '01-pop', ['light', 'dark']);

  await chooser(page).getByRole('button', { name: 'Show me' }).click();
  const box = page.locator('[data-show-me-box]');
  await expect(box).toHaveAttribute('data-show-me-box', 'compose');
  await expect(box.locator('[data-show-me-place]')).toHaveText('retry-worker.ts · lines 16–18');
  await shot(page, '02-box');

  world.hold = gate();
  await box.getByLabel('What the picture should show').fill('What happens after the third failure?');
  await box.locator('[data-show-me-send]').click();
  await expect(box).toHaveAttribute('data-show-me-box', 'drawing');
  await expect(box).toContainText('Claude Code is drawing it.');
  await expect(box.getByRole('button', { name: 'Stop' })).toBeVisible();
  await shot(page, '03-wait', ['light', 'dark']);
  // The request the agent got: the place, its words, how to tie the board to the review, and where the how lives.
  await expect.poll(() => world.agent.asked.length).toBe(1);
  const asked = world.agent.asked[0]!;
  expect(asked).toContain(`The reviewer pressed Show me on lines 16–18 of ${WORKER}`);
  expect(asked).toContain(`(${round1.message_id}): "What happens after the third failure?"`);
  expect(asked).toContain('`plannotator shape --help`');
  expect(asked).toContain(`--thread ${round1.thread_id} --through ${round1.message_id}`);
  // The request says how a part lands on its code; Shape's own help, which people with Code review off read too, does not.
  expect(asked).toContain('data-code="path#L42"');
  const help = world.shape(['--help']);
  expect(help.status, help.stderr).toBe(0);
  expect(help.stdout).not.toContain('data-code');

  // Reloaded while the agent draws: Show me on the same lines finds that request waiting, never a second one.
  await page.reload();
  const reopened = page.locator('[data-review-message]');
  await expect(page.locator('[data-review-card]').getByRole('button', { name: /review/ }).or(reopened).first()).toBeVisible();
  if (!(await reopened.isVisible())) await page.locator('[data-review-card]').getByRole('button', { name: /review/ }).click();
  await expect(reopened).toBeVisible();
  await pickChapter(page, 2);
  await selectLines(page, WORKER, 17, 17);
  await chooser(page).getByRole('button', { name: 'Show me' }).click();
  await expect(box).toHaveAttribute('data-show-me-box', 'drawing');
  await expect(box.locator('[data-show-me-place]')).toHaveText('retry-worker.ts · lines 16–18');
  expect(world.agent.asked.length).toBe(1);
  world.hold.release();
  world.hold = null;

  // The real board, over the review: its title, its claim, its views and its dock.
  await expect(board(page)).toBeVisible({ timeout: 30_000 });
  await expect(box).toHaveCount(0);
  shapeId = (await board(page).getAttribute('data-shape-layer'))!;
  expect(shapeId).toMatch(/^shp_/);
  await expect(page).toHaveURL(new RegExp(`guide=${round1.message_id}.*shape=${shapeId}`));
  await expect(board(page).getByRole('heading', { name: 'After the third failure' })).toBeVisible();
  await expect(part(board(page), 'stays')).toBeVisible();
  for (const name of ['Shape', 'How it works', 'Comment', 'References', 'Chat']) {
    await expect(board(page).getByRole('toolbar').getByRole('button', { name, exact: false }).first()).toBeVisible();
  }
  // What to know is gone (approval shape-know-removed).
  await expect(board(page).getByRole('toolbar').getByRole('button', { name: 'What to know' })).toHaveCount(0);
  await expect(board(page).getByRole('button', { name: 'Global comment' })).toBeVisible();
  await shot(page, '04-board', ['light', 'dark']);
  await board(page).getByRole('toolbar').getByRole('button', { name: 'How it works' }).click();
  await shot(page, '04b-how', ['light']);
  await board(page).getByRole('toolbar').getByRole('button', { name: 'Shape', exact: true }).click();
  // The board's own "Requirements" never shows.
  await expect(board(page).getByRole('toolbar')).not.toContainText('Requirements');
});

test('a part lands on its line and the board shrinks to the corner card; it grows back; the same lines open it again; plain Ask opens the Ask window', async () => {
  const { page } = world;
  const pane = page.locator('[data-review-message]');
  // Into its panel first: the board comes back as it was.
  await board(page).getByRole('toolbar').getByRole('button', { name: 'References' }).click();
  await expect(board(page).locator('.shp-sidep.open')).toBeVisible();
  await board(page).getByRole('toolbar').getByRole('button', { name: 'References' }).click();
  await part(board(page), 'email').click();
  await expect(corner(page)).toBeVisible();
  await expect(board(page)).toBeHidden();
  await expect(corner(page).locator('.ib-sm-pip-f')).toHaveText(/dunning\.ts lines 4–9/);
  // The board's crops show small too: their files, not a broken picture.
  await expect.poll(() => corner(page).locator('image').first().evaluate((el) => new Promise<boolean>((done) => {
    const probe = new Image();
    probe.onload = () => done(probe.naturalWidth > 0);
    probe.onerror = () => done(false);
    probe.src = (el as SVGImageElement).href.baseVal;
  }))).toBe(true);
  const dunning = page.locator(`[data-guide-file-shell="${DUNNING}"]`).first();
  await expect(dunning).toBeInViewport();
  await expect(dunning.locator('[data-line][data-selected-line]')).toHaveCount(6);
  await shot(page, '05-landed', ['light', 'dark']);
  await corner(page).getByRole('button', { name: 'Grow the board' }).click();
  await expect(board(page)).toBeVisible();
  await expect(corner(page)).toHaveCount(0);

  // Closed, the board is one Show me away on the same lines: it opens again, nothing is asked.
  await board(page).getByRole('button', { name: 'Close Shape' }).click();
  await expect(board(page)).toHaveCount(0);
  const askedBefore = world.agent.asked.length;
  await selectLines(page, WORKER, 18, 18);
  await chooser(page).getByRole('button', { name: 'Show me' }).click();
  await expect(board(page)).toBeVisible();
  await expect(page.locator('[data-show-me-box]')).toHaveCount(0);
  // Esc closes it, back to the review.
  await page.keyboard.press('Escape');
  await expect(board(page)).toHaveCount(0);
  await expect(pane).toBeVisible();
  // The review's header has the board's Pebble too.
  await pane.locator(`[data-shape-pebble="${shapeId}"]`).click();
  await expect(board(page)).toBeVisible();
  await board(page).getByRole('button', { name: 'Close Shape' }).click();
  // Another window on the same review reaches it the same way.
  const other = await world.context.newPage();
  try {
    await openReview(other, round1.thread_id);
    await pickChapter(other, 2);
    await selectLines(other, WORKER, 16, 16);
    await chooser(other).getByRole('button', { name: 'Show me' }).click();
    await expect(board(other)).toBeVisible();
    await expect(other.locator('[data-show-me-box]')).toHaveCount(0);
  } finally {
    await other.close();
  }
  expect(world.agent.asked.length).toBe(askedBefore);

  // Plain Ask stays words: the Ask window opens with the lines named, and nothing is sent.
  await selectLines(page, WORKER, 13, 13);
  await chooser(page).getByRole('button', { name: 'Ask' }).click();
  const askBox = page.locator('[data-chat-window] textarea');
  await expect(askBox).toBeVisible();
  await expect(askBox).toHaveValue('retry-worker.ts line 13: ');
  expect(world.agent.asked.length).toBe(askedBefore);
  // The Show me turn reads as the person asked it, never as the agent's request.
  const transcript = page.locator('[data-chat-window] [data-message-role="user"]').first();
  await expect(transcript).toContainText('Show me on retry-worker.ts lines 16–18: What happens after the third failure?');
  await expect(page.locator('[data-chat-window]')).not.toContainText('plannotator shape');
  await askBox.fill('');
  await page.locator('[data-chat-window]').getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.locator('[data-chat-window]')).toHaveCount(0);
});

test("the thread works with the board as Shape does on its own: Chat's Ask, Annotate and Global comment, a redraw, the thread's Pebble and Thread tab", async () => {
  test.setTimeout(120_000);
  const { page } = world;
  await page.locator(`[data-review-message] [data-shape-pebble="${shapeId}"]`).click();
  await expect(board(page)).toBeVisible();
  const toolbar = board(page).getByRole('toolbar');

  // Chat: a question reaches the session that drew it, and its answer shows on the board.
  await toolbar.getByRole('button', { name: 'Chat' }).click();
  const chat = board(page).locator('.shp-sidep textarea').first();
  await chat.fill('Why does the row stay?');
  await chat.press('ControlOrMeta+Enter');
  await expect.poll(() => world.agent.asked.some((text) => text.includes('About the Shape board') && text.includes('Why does the row stay?'))).toBe(true);
  await expect(board(page).locator('.shp-sidep')).toContainText('nothing in the else branch removes it', { timeout: 20_000 });
  await shot(page, '06-chat', ['light', 'dark']);
  await board(page).getByRole('button', { name: 'Close panel' }).click();

  // The crosshair (Annotate's place on the Inbox's board): point at a part, Change it: the session is woken, reads
  // the note and draws v2.
  await toolbar.getByRole('button', { name: 'Comment', exact: true }).click();
  await part(board(page), 'stays').click();
  const popover = page.getByRole('dialog').filter({ hasText: 'Change it' }).or(page.locator('[data-comment-popover]')).first();
  const words = page.locator('textarea:visible').last();
  await words.fill('Remove the row before the email.');
  await shot(page, '07-annotate', ['light', 'dark']);
  await page.getByRole('button', { name: 'Change it' }).click();
  await expect(popover).toHaveCount(0);
  await expect(board(page).locator('.shp-claim')).toContainText('Version 2', { timeout: 30_000 });
  await expect(part(board(page), 'stays')).toContainText('The row is removed');
  // It stays on the board, not in the review's own comments: no second comment system.
  await expect(page.locator('.ib-gpanel')).not.toContainText('Remove the row before the email.');
  await toolbar.getByRole('button', { name: 'Comment', exact: true }).click();
  await shot(page, '08-redrawn', ['light', 'dark']);

  // Global comment: the same path, for the whole board.
  await board(page).getByRole('button', { name: 'Global comment' }).click();
  await page.locator('textarea:visible').last().fill('Say what the customer sees.');
  await page.getByRole('button', { name: 'Change it' }).click();
  await expect(board(page).locator('.shp-claim')).toContainText('Version 3', { timeout: 30_000 });

  // The thread itself: the Pebble in its header opens the same board, and the Thread tab reads the thread.
  await board(page).getByRole('button', { name: 'Close Shape' }).click();
  await page.locator('[data-review-message] .ib-back').click();
  await expect(page.locator('[data-review-message]')).toHaveCount(0);
  await expect(page.locator(`.ib-thread [data-shape-pebble="${shapeId}"], [data-shape-pebble="${shapeId}"]`).first()).toBeVisible();
  await shot(page, '09-thread-pebble', ['light', 'dark']);
  await page.locator(`[data-shape-pebble="${shapeId}"]`).first().click();
  await expect(board(page)).toBeVisible();
  await board(page).getByRole('toolbar').getByRole('button', { name: 'Chat' }).click();
  await board(page).getByRole('tab', { name: 'Thread' }).click();
  await expect(board(page).locator('[data-shape-message]').first()).toContainText('Ready for review');
  await board(page).getByRole('button', { name: 'Close panel' }).click();
  await board(page).getByRole('button', { name: 'Close Shape' }).click();
});

test('Show me again: a new turn, a new version of the same board', async () => {
  const { page } = world;
  await openReview(page, round1.thread_id);
  await page.locator(`[data-review-message] [data-shape-pebble="${shapeId}"]`).click();
  await board(page).getByRole('button', { name: 'Show me again' }).click();
  await expect(board(page)).toHaveCount(0);
  const box = page.locator('[data-show-me-box]');
  await expect(box.locator('[data-show-me-place]')).toHaveText('retry-worker.ts · lines 16–18');
  await expect(box.getByLabel('What the picture should show')).toHaveValue('What happens after the third failure?');
  const asked = world.agent.asked.length;
  await box.locator('[data-show-me-send]').click();
  await expect(board(page)).toBeVisible({ timeout: 30_000 });
  expect(world.agent.asked.length).toBe(asked + 1);
  expect(world.agent.asked.at(-1)!).toContain(`Bring your Shape ${shapeId} up to date`);
  expect(await board(page).getAttribute('data-shape-layer')).toBe(shapeId);
  await expect(board(page).locator('.shp-claim')).toContainText('Version 4', { timeout: 20_000 });
  await board(page).getByRole('button', { name: 'Close Shape' }).click();
});

test("a busy agent: the box offers the Ask window's choice, never says it draws", async () => {
  const { page } = world;
  // The last Show me's short answer finishes first (the board opened before it did).
  await expect
    .poll(() => page.evaluate(async (thread) => ((await (await fetch(`/api/inbox/threads/${thread}/ask`)).json()) as { running: string | null }).running, round1.thread_id))
    .toBeNull();
  world.agent.setBusy(true);
  await pickChapter(page, 2);
  await selectLines(page, WORKER, 8, 9);
  await chooser(page).getByRole('button', { name: 'Show me' }).click();
  const box = page.locator('[data-show-me-box]');
  await box.locator('[data-show-me-send]').click();
  await expect(box).toHaveAttribute('data-show-me-box', 'busy', { timeout: 20_000 });
  await expect(box).toContainText('Claude Code is working on something else.');
  await expect(box).not.toContainText('is drawing it');
  await shot(page, '10-busy');
  await box.getByRole('button', { name: 'Interrupt and ask now' }).click();
  await expect.poll(() => world.agent.interrupts()).toBe(1);
  await expect(board(page)).toBeVisible({ timeout: 30_000 });
  await board(page).getByRole('button', { name: 'Close Shape' }).click();
});

let noPictureThread = '';

test("the Overview's picture opens its code; with no picture, the Overview's Show me makes a board of the whole review", async () => {
  const { page } = world;
  await openReview(page, round1.thread_id);
  const pane = page.locator('[data-review-message]');
  await pickChapter(page, 'overview');
  const fig = page.locator('[data-overview-figure]');
  await expect(fig).toBeVisible();
  await shot(page, '11a-overview-figure', ['light', 'dark']);
  await part(fig, 'next').click();
  await expect(page.locator(`[data-guide-file-shell="${SCHEDULE}"]`).first()).toBeInViewport();

  const bare = await call('submit_guide', { project_path: world.project, guide: guide(1, false), patch: world.round1, review: true, thread: 'no-picture', subject: 'Retry failed charges, no picture', body: 'Ready for review.' });
  noPictureThread = bare.thread_id;
  await openReview(page, bare.thread_id);
  const ask = page.locator('[data-overview-show-me]');
  await expect(ask).toBeVisible();
  await shot(page, '11-overview-show-me', ['light', 'dark']);
  // Beside Global comment, on the heading's line (approval "review-deslop").
  await expect(page.locator('[data-guide-heading] .gv-tools button')).toHaveText(['Show me', 'Global comment']);
  await ask.click();
  await expect(page.locator('[data-show-me-place]')).toHaveText('The whole review');
  await page.locator('[data-show-me-send]').click();
  await expect(board(page)).toBeVisible({ timeout: 30_000 });
  expect(world.agent.asked.at(-1)!).toContain('on the Overview of your review');
  expect(world.agent.asked.at(-1)!).toContain(`--thread ${bare.thread_id}`);
  await shot(page, '12-overview-board');
  await board(page).getByRole('button', { name: 'Close Shape' }).click();
});

test('a phone at 390 px: the popover, the board, a part lands on its line', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, colorScheme: 'light', reducedMotion: 'reduce' });
  const page = await context.newPage();
  try {
    await openReview(page, round1.thread_id);
    await pickChapter(page, 'overview');
    await expect(page.locator('[data-overview-figure]')).toBeVisible();
    await shot(page, 'phone-overview-figure', ['light', 'dark']);
    await openReview(page, noPictureThread);
    await expect(page.locator('[data-overview-show-me]')).toBeVisible();
    await shot(page, 'phone-overview-show-me', ['light', 'dark']);
    await openReview(page, round1.thread_id);
    // The thread's newest board (the busy test's Show me made another).
    await page.locator('[data-review-message] [data-shape-pebble]').click();
    await expect(board(page)).toBeVisible();
    await shot(page, 'phone-board', ['light', 'dark']);
    await part(board(page), 'email').click();
    await expect(corner(page)).toBeVisible();
    await shot(page, 'phone-landed', ['light', 'dark']);
    await expect(page.locator(`[data-guide-file-shell="${DUNNING}"]`).first()).toBeVisible();
    await noAgentsDialog(page);
  } finally {
    await context.close();
  }
});

test("Shape off with Code review on: no Show me, no Overview picture, no Shape place, and an older agent's `review draw` is the review parse's", async () => {
  test.setTimeout(150_000);
  const { page } = world;
  const drawArgs = [['review', 'draw', '--file', 'x.json', '--review', round1.message_id, '--turn', 'turn_x'], ['review', 'drawings', round1.message_id], ['review', 'draw', '--help']];
  // Both on: refused and pointed at Shape.
  for (const args of drawArgs) {
    const run = spawnSync(binary, args, { env: world.env, cwd: world.project, encoding: 'utf8', timeout: 30_000 });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('`plannotator shape --help`');
    expect(run.stdout).toBe('');
  }
  const configPath = join(world.dataDir, 'config.json');
  const setShape = (on: boolean) => writeFileSync(configPath, JSON.stringify({ ...(JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>), inboxShape: on }));
  setShape(false);
  try {
    // In a folder that is no repository: the review parse answers at once, nothing is reviewed.
    for (const args of drawArgs) {
      const run = spawnSync(binary, args, { env: world.env, cwd: world.root, encoding: 'utf8', timeout: 30_000 });
      expect(run.status, run.stderr).not.toBeNull();
      expect(run.stderr).not.toContain('review_draw_gone');
      expect(run.stderr).not.toContain('plannotator shape');
    }
    const help = world.shape(['--help']);
    expect([help.status, help.stdout]).toEqual([1, '']);
    expect(help.stderr).toContain('shape_off');

    // The review: Comment and Ask on selected lines, no Overview picture and no Show me in its heading, no board.
    await page.goto(`${world.url}#thread=${round1.thread_id}`);
    await page.reload();
    await openReview(page, round1.thread_id);
    await pickChapter(page, 2);
    await selectLines(page, WORKER, 16, 18);
    await expect(chooser(page)).toBeVisible();
    await expect(chooser(page).getByRole('button')).toHaveText(['Comment', 'Ask']);
    await page.mouse.click(4, 4);
    await expect(chooser(page)).toHaveCount(0);
    await pickChapter(page, 'overview');
    await expect(page.locator('[data-guide-overview]')).toBeVisible();
    await expect(page.locator('[data-overview-figure]')).toHaveCount(0);
    await expect(page.locator('[data-guide-overview-diagram]')).toHaveCount(0);
    await expect(page.locator('[data-overview-show-me]')).toHaveCount(0);
    await expect(board(page)).toHaveCount(0);
    await expect(page.locator('[data-shape-pebble]')).toHaveCount(0);

    // Shape's own places: the row, the grid, `/shape` and ⌘K's Shape group.
    await page.goto(`${world.url}#shapes`);
    await expect(page).not.toHaveURL(/#shapes/);
    await expect(page.locator('[data-shape-nav]')).toHaveCount(0);
    const skills = await page.evaluate(async () => ((await (await fetch('/api/inbox/skills')).json()) as { skills: { name: string }[] }).skills.map((skill) => skill.name));
    expect(skills).toContain('review-curate');
    expect(skills).not.toContain('shape');
    expect((await page.request.get(`${world.url}api/shapes`)).status()).toBe(404);
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
    const palette = page.locator('dialog[data-search-palette]');
    await expect(palette).toBeVisible();
    await palette.getByRole('combobox').or(palette.locator('input')).first().fill('After the third failure');
    await page.waitForTimeout(800);
    await expect(palette.getByText('Shape', { exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');
  } finally {
    setShape(true);
  }
  await page.reload();
});

test('a board drawn on an earlier review lands where its code is now, or says it changed; never on its old numbers', async () => {
  test.setTimeout(200_000);
  const { page } = world;
  const painted = (file: string) => page.locator(`[data-guide-file-shell="${file}"]`).first().locator('[data-line][data-selected-line]');
  const first = await call('submit_guide', { project_path: world.project, guide: guide(1, false), patch: world.round1, review: true, thread: 'two-reviews', subject: 'Two reviews', body: 'Ready for review.' });
  await openReview(page, first.thread_id);
  const pane = page.locator('[data-review-message]');
  await pickChapter(page, 2);

  // A real Show me here, for the same-lines check below.
  await selectLines(page, WORKER, 16, 18);
  await chooser(page).getByRole('button', { name: 'Show me' }).click();
  await page.locator('[data-show-me-box]').getByLabel('What the picture should show').fill('The else branch?');
  await page.locator('[data-show-me-send]').click();
  await expect(board(page)).toBeVisible({ timeout: 30_000 });
  await board(page).getByRole('button', { name: 'Close Shape' }).click();

  // A board with one part of each kind, stored through this review.
  const file = join(world.boardDir, 'two-reviews.json');
  const box = (mark: string, code: string) => `<div data-mark="${mark}" data-code="${code}" style="padding:16px">${mark}</div>`;
  writeFileSync(file, JSON.stringify({ title: 'Two reviews', claim: 'One part of each kind.', views: { picture: { width: 800, height: 300, html: `<div>${box('moved', `${WORKER}#L16-L18`)}${box('rewritten', `${SCHEDULE}#L6`)}${box('beyond', `${WORKER}#L9999`)}${box('elsewhere', 'README.md#L1')}</div>` } } }));
  const stored = world.shape(['update', '--file', file, '--thread', first.thread_id, '--through', first.message_id]);
  expect(stored.status, stored.stderr).toBe(0);
  const boardId = (JSON.parse(stored.stdout) as { id: string }).id;
  const open = async () => {
    await page.evaluate((id) => { location.hash = `${location.hash}&shape=${encodeURIComponent(id)}`; }, boardId);
    await expect(board(page)).toContainText('One part of each kind.');
  };

  // Lines this diff can't show, and a file not in this review: the board stays, and its viewer opens the code.
  await open();
  await part(board(page), 'beyond').click();
  await expect(page.getByRole('dialog').filter({ hasText: 'retry-worker.ts' })).toBeVisible();
  await expect(corner(page)).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await part(board(page), 'elsewhere').click();
  await expect(page.getByRole('dialog').filter({ hasText: 'README.md' })).toBeVisible();
  await expect(corner(page)).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Leaving the review from the corner card closes the board with it.
  await part(board(page), 'moved').click();
  await expect(corner(page).locator('.ib-sm-pip-f')).toHaveText(/retry-worker\.ts lines 16–18/);
  await pane.getByRole('button', { name: 'Thread' }).click();
  await expect(pane).toHaveCount(0);
  await expect(page).not.toHaveURL(/shape=/);
  await expect(board(page)).toHaveCount(0);
  await expect(corner(page)).toHaveCount(0);

  // A reply in the thread, read before the later review: a board stored through it counts in this review's lines.
  const between = await call('send_message', { project_path: world.project, body: 'Noted, one more pass.', reply_to: first.message_id });
  // The agent sends a later review: a line added above, the else branch rewritten.
  const second = await call('submit_guide', { project_path: world.project, guide: guide(2, false), patch: world.round2, review: true, reply_to: first.message_id, body: 'The row is removed, one email, jitter.' });
  expect(second.thread_id).toBe(first.thread_id);
  await page.goto(`${world.url}#thread=${first.thread_id}&guide=${second.message_id}`);
  await page.reload();
  await expect(pane).toBeVisible();
  await pickChapter(page, 2);
  await open();
  await part(board(page), 'moved').click();
  await expect(corner(page).locator('.ib-sm-pip-f')).toHaveText(/retry-worker\.ts lines 17–20/);
  await expect(painted(WORKER)).toHaveCount(4);
  await expect(painted(WORKER).first()).toContainText('} else {');
  await expect(corner(page).locator('[data-show-me-changed]')).toHaveCount(0);
  await corner(page).getByRole('button', { name: 'Grow the board' }).click();

  // Stored through a reply that came after the first review: that review's numbers, so where the code is now, not 16–18.
  const openBoard = async (id: string, title: string) => {
    await page.evaluate((shape) => { location.hash = `${location.hash.replace(/&shape=[^&]*/, '')}&shape=${encodeURIComponent(shape)}`; }, id);
    await expect(board(page)).toContainText(title);
  };
  const storeBoard = (name: string, code: string, flags: string[]) => {
    const path = join(world.boardDir, `${name}.json`);
    writeFileSync(path, JSON.stringify({ title: name, claim: `The board ${name}.`, views: { picture: { width: 800, height: 300, html: `<div data-mark="it" data-code="${code}" style="padding:16px">it</div>`, css: '' } } }));
    const run = world.shape(['update', '--file', path, '--thread', first.thread_id, ...flags]);
    expect(run.status, run.stderr).toBe(0);
    return (JSON.parse(run.stdout) as { id: string }).id;
  };
  const closeBoard = async () => {
    await corner(page).getByRole('button', { name: 'Grow the board' }).click();
    await board(page).getByRole('button', { name: 'Close Shape' }).click();
  };
  await board(page).getByRole('button', { name: 'Close Shape' }).click();
  await openBoard(storeBoard('through-reply', `${WORKER}#L16-L18`, ['--through', between.message_id]), 'The board through-reply.');
  await part(board(page), 'it').click();
  await expect(corner(page).locator('.ib-sm-pip-f')).toHaveText(/retry-worker\.ts lines 17–20/);
  await expect(painted(WORKER).first()).toContainText('} else {');
  await closeBoard();

  // Stored through nothing, and no Show me made it: the newest review when it was stored, this one, so these lines.
  await openBoard(storeBoard('through-nothing', `${WORKER}#L16-L18`, []), 'The board through-nothing.');
  await part(board(page), 'it').click();
  await expect(corner(page).locator('.ib-sm-pip-f')).toHaveText(/retry-worker\.ts lines 16–18/);
  await expect(corner(page).locator('[data-show-me-changed]')).toHaveCount(0);
  await expect(painted(WORKER)).toHaveCount(3);
  await closeBoard();

  // Back on the first board.
  await open();

  // Code that changed: its file, nothing painted there, and the corner says so.
  await part(board(page), 'rewritten').click();
  await expect(corner(page).locator('[data-show-me-changed]')).toContainText('This code changed after the picture was drawn.');
  await expect(corner(page).locator('.ib-sm-pip-f')).not.toContainText('lines');
  await expect(page.locator(`[data-guide-file-shell="${SCHEDULE}"]`).first()).toBeVisible();
  await expect(painted(SCHEDULE)).toHaveCount(0);
  await shot(page, '14-changed', ['light', 'dark']);
  await corner(page).locator('[data-show-me-again]').click();
  const again = page.locator('[data-show-me-box]');
  await expect(again).toHaveAttribute('data-show-me-box', 'compose');
  await expect(again.locator('[data-show-me-place]')).toHaveText('The whole review');
  await page.getByRole('button', { name: 'Close Show me' }).click();
  await expect(again).toHaveCount(0);

  // Show me here: the earlier review's lines where they are now reopen its board; its old numbers are other code, so they ask.
  await pickChapter(page, 2);
  const asked = world.agent.asked.length;
  await selectLines(page, WORKER, 17, 20);
  await chooser(page).getByRole('button', { name: 'Show me' }).click();
  await expect(board(page)).toBeVisible();
  await expect(page.locator('[data-show-me-box]')).toHaveCount(0);
  await board(page).getByRole('button', { name: 'Close Shape' }).click();
  await selectLines(page, WORKER, 16, 17);
  await chooser(page).getByRole('button', { name: 'Show me' }).click();
  await expect(page.locator('[data-show-me-box]')).toHaveAttribute('data-show-me-box', 'compose');
  await expect(page.locator('[data-show-me-place]')).toHaveText('retry-worker.ts · lines 16–17');
  await page.getByRole('button', { name: 'Close Show me' }).click();
  expect(world.agent.asked.length).toBe(asked);
  expect(world.errors).toEqual([]);
});

test("a plain board on its only review: stored after it, through nothing or an earlier message, its lines; stored before it, the board's own viewer", async () => {
  test.setTimeout(120_000);
  const { page } = world;
  const painted = page.locator(`[data-guide-file-shell="${WORKER}"]`).first().locator('[data-line][data-selected-line]');
  const asked = await call('send_message', { project_path: world.project, body: 'Which way does the retry go?', thread: 'plain-boards', subject: 'Plain boards' });
  const storeBoard = (name: string, flags: string[]) => {
    const path = join(world.boardDir, `${name}.json`);
    writeFileSync(path, JSON.stringify({ title: name, claim: `The board ${name}.`, views: { picture: { width: 800, height: 300, html: `<div data-mark="it" data-code="${WORKER}#L16-L18" style="padding:16px">it</div>` } } }));
    const run = world.shape(['update', '--file', path, '--thread', asked.thread_id, ...flags]);
    expect(run.status, run.stderr).toBe(0);
    return (JSON.parse(run.stdout) as { id: string }).id;
  };
  const before = storeBoard('plain-before', []);
  await new Promise((done) => setTimeout(done, 20));
  const review = await call('submit_guide', { project_path: world.project, guide: guide(1, false), patch: world.round1, review: true, reply_to: asked.message_id, body: 'The review.' });
  expect(review.thread_id).toBe(asked.thread_id);
  await new Promise((done) => setTimeout(done, 20));
  const after = storeBoard('plain-after', []);
  const earlier = storeBoard('plain-through-earlier', ['--through', asked.message_id]);
  await page.goto(`${world.url}#thread=${asked.thread_id}&guide=${review.message_id}`);
  await page.reload();
  const pane = page.locator('[data-review-message]');
  await expect(pane).toBeVisible();
  await pickChapter(page, 2);
  const openBoard = async (id: string, name: string) => {
    await page.evaluate((shape) => { location.hash = `${location.hash.replace(/&shape=[^&]*/, '')}&shape=${encodeURIComponent(shape)}`; }, id);
    await expect(board(page)).toContainText(`The board ${name}.`);
  };
  for (const [id, name] of [[after, 'plain-after'], [earlier, 'plain-through-earlier']] as const) {
    await openBoard(id, name);
    await part(board(page), 'it').click();
    await expect(corner(page).locator('.ib-sm-pip-f')).toHaveText(/retry-worker\.ts lines 16–18/);
    await expect(corner(page).locator('[data-show-me-changed]')).toHaveCount(0);
    await expect(painted).toHaveCount(3);
    await corner(page).getByRole('button', { name: 'Grow the board' }).click();
    await board(page).getByRole('button', { name: 'Close Shape' }).click();
    await expect(board(page)).toHaveCount(0);
  }
  await openBoard(before, 'plain-before');
  await part(board(page), 'it').click();
  await expect(page.getByRole('dialog').filter({ hasText: 'retry-worker.ts' })).toBeVisible();
  await expect(corner(page)).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await board(page).getByRole('button', { name: 'Close Shape' }).click();
});

test("a part on a deleted file or a rename's old name: the file and the note, never a dead click", async () => {
  const { page } = world;
  const GONE = 'src/gone.ts';
  const patch = [
    `diff --git a/${GONE} b/${GONE}`, 'deleted file mode 100644', 'index 1111111..0000000', `--- a/${GONE}`, '+++ /dev/null', '@@ -1,2 +0,0 @@', '-one', '-two',
    'diff --git a/src/old-name.ts b/src/new-name.ts', 'similarity index 60%', 'rename from src/old-name.ts', 'rename to src/new-name.ts', 'index 2222222..3333333 100644', '--- a/src/old-name.ts', '+++ b/src/new-name.ts', '@@ -1,2 +1,2 @@', ' keep', '-old', '+new', '',
  ].join('\n');
  const sent = await call('submit_guide', {
    project_path: world.project,
    guide: { ...guide(1, false), sections: [{ title: 'Gone and moved', overview: 'One deleted, one renamed.', diffs: [{ file: GONE, summary: 'Deleted.' }, { file: 'src/new-name.ts', summary: 'Renamed.' }] }] },
    patch, review: true, thread: 'odd-files', subject: 'Odd files', body: 'Ready for review.',
  });
  const path = join(world.boardDir, 'odd-files.json');
  const box = (mark: string, code: string) => `<div data-mark="${mark}" data-code="${code}" style="padding:16px">${mark}</div>`;
  writeFileSync(path, JSON.stringify({ title: 'Odd files', claim: 'Odd files.', views: { picture: { width: 800, height: 300, html: `<div>${box('gone', `${GONE}#L2`)}${box('renamed', 'src/old-name.ts#L1')}</div>`, css: '' } } }));
  const stored = world.shape(['update', '--file', path, '--thread', sent.thread_id, '--through', sent.message_id]);
  expect(stored.status, stored.stderr).toBe(0);
  const id = (JSON.parse(stored.stdout) as { id: string }).id;
  await page.goto(`${world.url}#thread=${sent.thread_id}&guide=${sent.message_id}&shape=${encodeURIComponent(id)}`);
  await page.reload();
  await expect(board(page)).toContainText('Odd files.');
  await part(board(page), 'gone').click();
  await expect(corner(page).locator('.ib-sm-pip-f')).toContainText('gone.ts');
  await expect(corner(page).locator('[data-show-me-changed]')).toContainText('This code changed after the picture was drawn.');
  await expect(page.locator(`[data-guide-file-shell="${GONE}"]`).first()).toBeVisible();
  await corner(page).getByRole('button', { name: 'Grow the board' }).click();
  await part(board(page), 'renamed').click();
  await expect(corner(page).locator('.ib-sm-pip-f')).toContainText('new-name.ts');
  await expect(corner(page).locator('[data-show-me-changed]')).toContainText('This code changed after the picture was drawn.');
  await expect(page.locator('[data-guide-file-shell="src/new-name.ts"]').first()).toBeVisible();
  await corner(page).getByRole('button', { name: 'Grow the board' }).click();
  await board(page).getByRole('button', { name: 'Close Shape' }).click();
});

test("a drawn part's place in code on a board over the thread: the code shows and the board shrinks to the corner card; the card brings it back", async () => {
  test.setTimeout(120_000);
  const { page } = world;
  const asked = await call('send_message', { project_path: world.project, body: 'What changed in the retry?', thread: 'board-links', subject: 'Board links' });
  const review = await call('submit_guide', { project_path: world.project, guide: guide(1, false), patch: world.round1, review: true, reply_to: asked.message_id, body: 'The review.' });
  expect(review.thread_id).toBe(asked.thread_id);
  const path = join(world.boardDir, 'board-links.json');
  writeFileSync(
    path,
    JSON.stringify({
      title: 'Board links',
      claim: 'The retry stops after the third failure.',
      views: {
        picture: { width: 800, height: 300, html: `<div data-mark="it" data-code="${WORKER}#L17" style="padding:16px">it</div>` },
      },
    }),
  );
  const run = world.shape(['update', '--file', path, '--thread', asked.thread_id]);
  expect(run.status, run.stderr).toBe(0);
  const id = (JSON.parse(run.stdout) as { id: string }).id;
  const link = (scope: Locator) => part(scope, 'it');
  const pane = page.locator(`[data-review-message="${review.message_id}"]`);
  const shell = page.locator(`[data-guide-file-shell="${WORKER}"]`).first();

  // The board over the thread, no review open: a part with its place in code.
  await page.goto(`${world.url}#thread=${asked.thread_id}&shape=${encodeURIComponent(id)}`);
  await page.reload();
  await expect(board(page)).toContainText('The retry stops after the third failure.');
  await expect(pane).toHaveCount(0);
  await link(board(page)).click();

  // The code shows: the review at that line, painted and scrolled into view clear of the card; the board is the
  // corner card, naming no part.
  await expect(pane).toBeVisible();
  await expect(shell).toBeInViewport();
  const painted = shell.locator('[data-line][data-selected-line]');
  await expect(painted).toHaveCount(1);
  await expect(painted).toBeInViewport();
  const clearOfCard = async () => {
    // Either may be between renders (the line repainted, the corner card not drawn yet): ask again, never throw.
    const line = await painted.boundingBox();
    const card = await corner(page).boundingBox();
    if (!line || !card) return false;
    return line.y + line.height <= card.y;
  };
  await expect.poll(clearOfCard).toBe(true);
  await expect(corner(page)).toHaveAttribute('data-show-me-corner', id);
  await expect(corner(page).locator('.ib-sm-pip-f')).toHaveCount(0);
  await expect(board(page)).toBeHidden();
  await shot(page, '13-board-link', ['light', 'dark']);

  // The card brings the board back, over the review, on the view the person left; its part lands the same way.
  await corner(page).getByRole('button', { name: 'Grow the board' }).click();
  await expect(corner(page)).toHaveCount(0);
  await expect(board(page)).toBeVisible();
  await expect(board(page).getByRole('toolbar').getByRole('button', { name: 'Shape', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await link(board(page)).click();
  await expect(corner(page)).toBeVisible();
  await expect(board(page)).toBeHidden();
  await expect(painted).toBeInViewport();
  await expect.poll(clearOfCard).toBe(true);

  // Esc closes the board, as after a part lands on its line; the review stays.
  await page.keyboard.press('Escape');
  await expect(corner(page)).toHaveCount(0);
  await expect(board(page)).toHaveCount(0);
  await expect(pane).toBeVisible();
});

test('a Change it while the session answers another thread: no storm of requests, and it goes through once that turn ends, once', async () => {
  test.setTimeout(120_000);
  const { page } = world;
  // Thread one: a Show me, the agent held on it.
  await expect
    .poll(() => page.evaluate(async (thread) => ((await (await fetch(`/api/inbox/threads/${thread}/ask`)).json()) as { running: string | null }).running, round1.thread_id))
    .toBeNull();
  await openReview(page, round1.thread_id);
  await pickChapter(page, 2);
  world.hold = gate();
  const hold = world.hold;
  await selectLines(page, DUNNING, 2, 3);
  await chooser(page).getByRole('button', { name: 'Show me' }).click();
  await page.locator('[data-show-me-send]').click();
  await expect.poll(() => page.evaluate(async (thread) => ((await (await fetch(`/api/inbox/threads/${thread}/ask`)).json()) as { running: string | null }).running, round1.thread_id)).not.toBeNull();

  // Thread two, the same session, in a second window: its own board.
  const other = await call('submit_guide', { project_path: world.project, guide: guide(1, false), patch: world.round1, review: true, thread: 'second-thread', subject: 'A second thread', body: 'Ready for review.' });
  const path = join(world.boardDir, 'second-thread.json');
  writeFileSync(path, JSON.stringify({ title: 'Second thread', claim: 'The second thread.', views: { picture: { width: 800, height: 300, html: '<div data-mark="it" style="padding:16px">it</div>', css: '' } } }));
  const stored = world.shape(['update', '--file', path, '--thread', other.thread_id, '--through', other.message_id]);
  expect(stored.status, stored.stderr).toBe(0);
  const id = (JSON.parse(stored.stdout) as { id: string }).id;
  const second = await world.context.newPage();
  try {
    const posts: string[] = [];
    const reads: string[] = [];
    second.on('request', (request) => {
      if (!request.url().endsWith(`/api/inbox/threads/${other.thread_id}/ask`)) return;
      (request.method() === 'POST' ? posts : reads).push(request.url());
    });
    await second.goto(`${world.url}#thread=${other.thread_id}&guide=${other.message_id}&shape=${encodeURIComponent(id)}`);
    await expect(board(second)).toContainText('The second thread.');
    const wakes = () => world.agent.asked.filter((text) => text.includes(`plannotator shape read ${id} --notes`)).length;
    await board(second).getByRole('button', { name: 'Global comment' }).click();
    await second.locator('textarea:visible').last().fill('Say what the customer sees.');
    await second.getByRole('button', { name: 'Change it' }).click();
    await expect.poll(() => posts.length).toBeGreaterThanOrEqual(1);

    // Refused while the other turn holds the session: seven seconds, and at most a try a pause (the loop was 1,600 a second).
    const readsBefore = reads.length;
    await second.waitForTimeout(7_000);
    expect(posts.length).toBeLessThanOrEqual(3);
    // The window's readers share one read of the thread's Ask (ask/askReads.ts): each try is one read (its look,
    // whose answer the wake reuses), and the three posts allow two tries here; two more for news that comes while
    // a read is on its way (one more read after it). CI measures 2.
    expect(reads.length - readsBefore).toBeLessThanOrEqual(4);
    expect(wakes()).toBe(0);

    // That turn ends: the person's Change it goes through, once.
    hold.release();
    world.hold = null;
    await expect.poll(wakes, { timeout: 30_000 }).toBe(1);
    await expect(board(second).locator('.shp-claim')).toContainText('Version 2', { timeout: 30_000 });
    await second.waitForTimeout(6_000);
    expect(wakes()).toBe(1);
  } finally {
    await second.close();
  }
  await expect(board(page)).toBeVisible({ timeout: 30_000 });
  await board(page).getByRole('button', { name: 'Close Shape' }).click();
});

test("reloaded while it draws, and the agent ends with no words: the box goes back to its words with the Ask window's note", async () => {
  const { page } = world;
  await openReview(page, round1.thread_id);
  const pane = page.locator('[data-review-message]');
  await pickChapter(page, 2);
  await selectLines(page, WORKER, 2, 3);
  await chooser(page).getByRole('button', { name: 'Show me' }).click();
  const box = page.locator('[data-show-me-box]');
  world.hold = gate();
  world.fail = true;
  await box.getByLabel('What the picture should show').fill('Is the log line counted?');
  await box.locator('[data-show-me-send]').click();
  await expect(box).toHaveAttribute('data-show-me-box', 'drawing');

  // Another load of the window: it reopens the waiting box, with no chat of its own for the turn.
  await page.reload();
  const start = page.locator('[data-review-card]').last().getByRole('button', { name: /review/ });
  await expect(start.or(pane).first()).toBeVisible();
  if (!(await pane.isVisible())) await start.click();
  await expect(pane).toBeVisible();
  await pickChapter(page, 2);
  await selectLines(page, WORKER, 2, 2);
  await chooser(page).getByRole('button', { name: 'Show me' }).click();
  await expect(box).toHaveAttribute('data-show-me-box', 'drawing');
  world.hold.release();
  world.hold = null;
  // Nothing is kept for an answer with no words: the box comes back with its words, ready to send again.
  await expect(box.getByRole('alert')).toHaveText('No answer arrived.', { timeout: 30_000 });
  await expect(box).toHaveAttribute('data-show-me-box', 'compose');
  await expect(box.getByLabel('What the picture should show')).toHaveValue('Is the log line counted?');
  await box.getByRole('button', { name: 'Close Show me' }).click();
  expect(world.errors).toEqual([]);
});

test("the agent gone: a Show me it never answers goes back to the box with the Ask window's problem, never says it draws", async () => {
  // The Inbox holds the turn until the bridge calls the agent gone (30 s).
  test.setTimeout(150_000);
  const { page } = world;
  await openReview(page, round1.thread_id);
  await pickChapter(page, 2);
  await selectLines(page, WORKER, 5, 5);
  await chooser(page).getByRole('button', { name: 'Show me' }).click();
  const box = page.locator('[data-show-me-box]');
  await expect(box).toHaveAttribute('data-show-me-box', 'compose');
  const asked = world.agent.asked.length;
  // Its connection goes after the window showed Show me (the last test: nothing answers after this).
  world.agent.stop();
  await box.getByLabel('What the picture should show').fill('Where does the log go?');
  await box.locator('[data-show-me-send]').click();
  await expect(box.getByRole('alert')).toHaveText(/This session is no longer available|Claude Code went away before it finished\./, { timeout: 60_000 });
  await expect(box).toHaveAttribute('data-show-me-box', 'compose');
  await expect(box.getByRole('status')).toHaveCount(0);
  await expect(box.getByLabel('What the picture should show')).toHaveValue('Where does the log go?');
  await shot(page, '13-gone');
  expect(world.agent.asked.length).toBe(asked);
  expect(world.errors).toEqual([]);
});
