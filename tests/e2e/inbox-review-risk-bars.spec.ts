/**
 * The risk bars (approval "review-risk-bars"), proved in a real browser against the compiled binary, with a temp
 * PLANNOTATOR_DATA_DIR. `gh` and `pi` are fakes first on a PATH with no agents on it: nothing reaches a forge, no real
 * agent runs. The fake `pi` answers each PR's judgment with its places, through the whole road (the strict parse, the
 * file, the window).
 *
 * Proved: a High PR's review marks each named file once in the tree, before its icon, without moving the row, and each
 * named range once in the diff, on its first line at the column's right edge; a Medium PR the same with two filled bars;
 * a Low PR nothing. Made-up people and code only.
 *
 * Shots land in PLANNOTATOR_E2E_PROOF_DIR/review-risk-bars:
 *   01-high-tree-and-diff-dark.png, 02-medium-tree-and-diff-dark.png, 03-closeup-tree-light.png,
 *   03-closeup-diff-light.png, 04-low-no-marks-dark.png.
 */
import { expect, test, type BrowserContext, type Locator, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'review-risk-bars');

const REPO = 'tully-labs/billing-svc';
const keyOf = (n: number) => `github.com/${REPO}#${n}`;
const RULES = 'Anything in billing or charges.\nAnything that changes permissions.';

const fileDiff = (path: string, hunk: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${hunk}`;
const PATCHES: Record<number, string> = {
  601: [
    fileDiff(
      'src/charges/retry.ts',
      [
        '@@ -18,7 +18,9 @@ export async function retryCharge(charge: Charge) {',
        '   const attempts = [1, 5, 30];',
        '   for (const wait of attempts) {',
        '     await sleep(wait * MINUTE);',
        '-    const result = await client.charge(charge);',
        '+    const first = await client.charge(charge);',
        '+    const second = await client.charge({ ...charge, retry: true });',
        '+    const result = second.ok ? second : first;',
        '     if (result.ok) return result;',
        '   }',
        "   log.warn('charge failed', charge.id);",
        '',
      ].join('\n'),
    ),
    fileDiff(
      'src/charges/client.ts',
      ['@@ -6,5 +6,5 @@ export const client = {', "   base: 'https://pay.example.test',", '   timeoutMs: 10_000,', '-  idempotent: true,', '+  idempotent: false,', '   retries: 0,', ' };', ''].join('\n'),
    ),
    fileDiff('docs/retries.md', ['@@ -1,3 +1,4 @@', ' # Retries', ' ', '-A failed charge is tried three more times.', '+A failed charge is tried three more times,', '+twice each time.', ''].join('\n')),
  ].join(''),
  602: [
    fileDiff(
      'src/receipts/send.ts',
      [
        '@@ -1,4 +1,7 @@',
        " import { mailer } from '../mail';",
        "+import { client } from '../charges/client';",
        ' ',
        ' export async function sendReceipt(order: Order) {',
        '+  const charge = await client.lookup(order.chargeId);',
        '+  if (!charge.ok) return;',
        '   await mailer.send(order.email, receiptFor(order));',
        '',
      ].join('\n'),
    ),
    fileDiff('src/checkout/done.ts', ['@@ -12,3 +12,4 @@ export function finishCheckout(order: Order) {', '   saveOrder(order);', '+  void sendReceipt(order);', '   return order.id;', ' }', ''].join('\n')),
  ].join(''),
  603: fileDiff('README.md', ['@@ -1,2 +1,2 @@', ' # Billing service', '-Teh service that charges cards.', '+The service that charges cards.', ''].join('\n')),
};

const VERDICTS: Record<string, unknown> = {
  'Retry failed charges twice': {
    risk: 'high',
    why: 'It charges a card a second time on every retry.',
    where: [
      { file: 'src/charges/retry.ts', side: 'new', lines: [21, 23], rule: 'Anything in billing or charges.', why: 'Each retry charges the card twice.' },
      { file: 'src/charges/client.ts', side: 'old', lines: [8, 8], why: 'Charges stop being idempotent.' },
    ],
  },
  'Send a receipt after checkout': {
    risk: 'medium',
    why: 'The receipt now reads the charge client.',
    where: [{ file: 'src/receipts/send.ts', side: 'new', lines: [5, 6], why: 'It looks the charge up before sending.' }],
  },
  'Fix a typo in the README': { risk: 'low', why: 'Only the README wording changes.' },
};

const AUTHORS: Record<number, string> = { 601: 'charlie-dunn', 602: 'bob-tully', 603: 'charlie-dunn' };
const TITLES: Record<number, string> = { 601: 'Retry failed charges twice', 602: 'Send a receipt after checkout', 603: 'Fix a typo in the README' };

function ghPull(number: number) {
  return {
    number,
    title: TITLES[number],
    url: `https://github.com/${REPO}/pull/${number}`,
    state: 'OPEN',
    isDraft: false,
    updatedAt: new Date(Date.now() - (number - 600) * 7 * 60_000).toISOString(),
    mergedAt: null,
    baseRefName: 'main',
    headRefName: `b${number}`,
    headRefOid: String(number).padStart(40, '0'),
    additions: 6,
    deletions: 2,
    changedFiles: 2,
    reviewDecision: 'REVIEW_REQUIRED',
    repository: { nameWithOwner: REPO },
    headRepository: { nameWithOwner: REPO },
    author: { login: AUTHORS[number] },
    reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', login: 'ada-novak' } }] },
    latestReviews: { nodes: [] },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
  };
}

/** A fake gh: the list, each PR's patch (`pr-<n>.patch`), its head. */
function writeGh(dir: string) {
  const gh = [
    '#!/bin/sh',
    `dir='${dir}'`,
    'if [ "$1" = auth ] && [ "$2" = status ]; then',
    '  echo \'{"hosts":{"github.com":[{"login":"ada-novak","active":true,"state":"success","tokenSource":"keyring"}]}}\'; exit 0',
    'fi',
    'if [ "$1" = api ] && [ "$2" = graphql ]; then cat "$dir/gh-pulls.json"; exit 0; fi',
    'if [ "$1" = api ] && [ "$2" = --hostname ] && [ "$5" = --jq ]; then case "$6" in *tojson*) printf \'{"sha":"%040d","body":null}\\n\' "${4##*/}";; *) printf "%040d\\n" "${4##*/}";; esac; exit 0; fi',
    'if [ "$1" = api ] && [ "$2" = --hostname ] && [ -f "$dir/pr-${4##*/}.patch" ]; then cat "$dir/pr-${4##*/}.patch"; exit 0; fi',
    'exit 1',
    '',
  ].join('\n');
  writeFileSync(join(dir, 'gh'), gh);
  chmodSync(join(dir, 'gh'), 0o755);
  for (const [n, patch] of Object.entries(PATCHES)) writeFileSync(join(dir, `pr-${n}.patch`), patch);
  writeFileSync(join(dir, 'gh-pulls.json'), JSON.stringify({ data: { viewer: { login: 'ada-novak' }, requested: { nodes: [601, 602, 603].map(ghPull) }, authored: { nodes: [] }, merged: { nodes: [] } } }));
}

/** A fake pi speaking Pi's RPC: the answer comes from the prompt's title. */
function writePi(dir: string) {
  const script = `
const verdicts = ${JSON.stringify(VERDICTS)};
if (process.argv.includes('--version')) { console.log('0.90.0'); process.exit(0); }
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.type === 'get_available_models') {
    send({ type: 'response', id: m.id, command: m.type, success: true, data: { models: [{ provider: 'anthropic', id: 'claude-sonnet-5', name: 'Sonnet 5' }] } });
    return;
  }
  send({ type: 'response', id: m.id, command: m.type, success: true, data: {} });
  if (m.type === 'prompt') {
    const title = /^Title: (.*)$/m.exec(m.message)?.[1] ?? '';
    const verdict = verdicts[title];
    send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: verdict ? JSON.stringify(verdict) : 'no idea' }] } });
    send({ type: 'agent_end' });
  }
});
`;
  writeFileSync(join(dir, 'pi.cjs'), script);
  writeFileSync(join(dir, 'pi'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(dir, 'pi.cjs'))} "$@"\n`);
  chmodSync(join(dir, 'pi'), 0o755);
}

let context: BrowserContext;
let page: Page;
let url = '';
let agent: SimAgent;

const row = (n: number) => page.locator(`[data-pulls-row="${keyOf(n)}"]`);
const treeMarks = () => page.locator('[data-review-files] [data-item-part-id="risk"]');
const diffMarks = () => page.locator('.ib-riskbars-row');

async function openReview(n: number): Promise<Locator> {
  await page.goto(url);
  await page.locator('[data-pulls-nav]').click();
  await expect(row(n).locator('[data-pull-risk]')).toBeVisible({ timeout: 30_000 });
  await row(n).click();
  await page.locator('[data-pulls-open-diff]').click();
  const review = page.locator(`[data-pull-review="${keyOf(n)}"]`);
  await expect(review).toBeVisible();
  await expect(review.locator('[data-review-files] [data-type="item"]').first()).toBeVisible({ timeout: 20_000 });
  return review;
}

async function scheme(value: 'light' | 'dark') {
  await page.emulateMedia({ colorScheme: value, reducedMotion: 'reduce' });
  await page.waitForTimeout(350);
}

/** The tree row of a file (its path as the tree names it ends with its name). */
const treeRow = (name: string) => page.locator(`[data-review-files] [data-type="item"][data-item-path$="${name}"]`);

/** The mark lies over the indent just left of the icon, and the icon is where an unmarked row's is. */
async function expectBeforeIcon(marked: string, unmarked: string) {
  const mark = (await treeRow(marked).locator('[data-item-part-id="risk"]').boundingBox())!;
  const icon = (await treeRow(marked).locator('[data-item-section="icon"]').boundingBox())!;
  const otherIcon = (await treeRow(unmarked).locator('[data-item-section="icon"]').boundingBox())!;
  const name = (await treeRow(marked).locator('[data-item-section="content"]').boundingBox())!;
  const otherName = (await treeRow(unmarked).locator('[data-item-section="content"]').boundingBox())!;
  expect(mark.x + mark.width).toBeLessThanOrEqual(icon.x + 1);
  expect(mark.x).toBeGreaterThanOrEqual(0);
  // No row moves: icon and name start where an unmarked row's do (same depth).
  expect(Math.abs(icon.x - otherIcon.x)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(name.x - otherName.x)).toBeLessThanOrEqual(0.5);
}

/** The diff's mark sits on the named range's first line, at the right of the code. */
async function expectOnLine(review: Locator, file: string, side: 'old' | 'new', line: number) {
  const mark = review.locator(`[data-risk-bars-line="${file}#${side}${line}"] .ib-riskbars`);
  await mark.scrollIntoViewIfNeeded();
  await expect(mark).toBeVisible();
  await expect(mark).toHaveAttribute('aria-label', /risk$/);
  const box = (await mark.boundingBox())!;
  const lines = await review.locator(`[data-guide-file-shell="${file}"] [data-line="${line}"]`).all();
  const boxes = (await Promise.all(lines.map((l) => l.boundingBox()))).filter((b): b is NonNullable<typeof b> => !!b);
  const middle = box.y + box.height / 2;
  expect(boxes.some((b) => middle >= b.y && middle <= b.y + b.height)).toBe(true);
  // At the right: past the middle of the code it marks.
  const code = (await review.locator(`[data-guide-file-shell="${file}"]`).boundingBox())!;
  expect(box.x).toBeGreaterThan(code.x + code.width / 3);
}

test.describe.configure({ mode: 'serial' });
test.use({ actionTimeout: 20_000 });

test.beforeAll(async ({ browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-risk-bars-e2e-');
  const dataDir = join(root, 'data');
  markTourDecided(dataDir);
  const fakes = join(root, 'fakes');
  mkdirSync(fakes, { recursive: true });
  writeGh(fakes);
  writePi(fakes);
  const project = scratchProject(join(root, 'src'), 'billing-svc');
  spawnSync('git', ['remote', 'add', 'origin', `https://github.com/${REPO}.git`], { cwd: project, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  for (const dir of ['claude', 'codex', 'xdg', 'home']) mkdirSync(join(root, dir), { recursive: true });
  const env = {
    PATH: `${fakes}:/usr/bin:/bin`,
    PLANNOTATOR_TEST_LAUNCH_PATH: `${fakes}:/usr/bin:/bin`,
    HOME: join(root, 'home'),
    PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_ANON_PING: '1',
    PLANNOTATOR_INBOX_NOTES: '0',
    PLANNOTATOR_TEST_SANDBOX: '1',
    TMPDIR: tmpdir(),
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    CODEX_HOME: join(root, 'codex'),
    XDG_CONFIG_HOME: join(root, 'xdg'),
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  url = started.stdout.trim();
  expect(new URL(url).port).not.toBe('59812');
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', deviceScaleFactor: 2 });
  page = await context.newPage();
  agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  await agent.send({ project_path: project, thread: 'charges', subject: 'Retry failed charges', body: 'Opened the retries.' });
  const on = await page.request.post(`${url}api/inbox/settings`, { data: { code_review: { on: true } } });
  expect(on.status()).toBe(200);
  const saved = await page.request.post(`${url}api/inbox/pulls/risk`, { data: { rules: RULES, provider: 'pi-sdk', model: null } });
  expect(saved.status()).toBe(200);
});

test.afterAll(async () => {
  try {
    await agent?.close().catch(() => {});
    await context?.close();
  } finally {
    await removeInboxScratch();
  }
});

test('a High PR: once on each named file in the tree, once on each named range in the diff', async () => {
  const review = await openReview(601);
  await expect(review.locator('[data-pull-risk="high"]')).toBeVisible();
  // The judgments came back with High's and Medium's places through the strict parse and the file; Low's with none.
  const places = async () => {
    const answer = (await (await page.request.get(`${url}api/inbox/pulls/risk`)).json()) as { judgments: Record<string, { level: string; where?: unknown[] }> };
    return [601, 602, 603].map((n) => `${answer.judgments[keyOf(n)]?.level ?? '-'} ${answer.judgments[keyOf(n)]?.where?.length ?? 0}`);
  };
  await expect.poll(places, { timeout: 30_000 }).toEqual(['high 2', 'medium 1', 'low 0']);

  await expect(treeMarks()).toHaveCount(2);
  await expect(treeRow('retry.ts').locator('[data-item-part-id="risk"]')).toHaveAttribute('title', 'High risk');
  await expect(treeRow('client.ts').locator('[data-item-part-id="risk"]')).toHaveCount(1);
  await expect(treeRow('retries.md').locator('[data-item-part-id="risk"]')).toHaveCount(0);
  await expectBeforeIcon('retry.ts', 'retries.md');
  await expect(diffMarks()).toHaveCount(2);
  await expectOnLine(review, 'src/charges/retry.ts', 'new', 21);
  await expectOnLine(review, 'src/charges/client.ts', 'old', 8);
  // Nothing beside the counts, in a header, or a third time.
  await expect(review.locator('[data-risk-bars]')).toHaveCount(2);

  await review.locator('[data-guide-file-shell="src/charges/retry.ts"]').scrollIntoViewIfNeeded();
  await scheme('dark');
  await page.screenshot({ path: join(proofDir, '01-high-tree-and-diff-dark.png') });
});

test('a Medium PR: two filled bars, on its one named file and its one range', async () => {
  const review = await openReview(602);
  await expect(treeMarks()).toHaveCount(1);
  await expect(treeRow('send.ts').locator('[data-item-part-id="risk"]')).toHaveAttribute('title', 'Medium risk');
  await expect(treeRow('done.ts').locator('[data-item-part-id="risk"]')).toHaveCount(0);
  await expect(diffMarks()).toHaveCount(1);
  await expectOnLine(review, 'src/receipts/send.ts', 'new', 5);
  await expect(review.locator('[data-risk-bars="medium"]')).toHaveCount(1);
  await scheme('dark');
  await page.screenshot({ path: join(proofDir, '02-medium-tree-and-diff-dark.png') });
});

test('light theme close-ups of both marks', async () => {
  const review = await openReview(601);
  await scheme('light');
  const tree = await treeRow('retry.ts').boundingBox();
  await page.screenshot({ path: join(proofDir, '03-closeup-tree-light.png'), clip: { x: Math.max(0, tree!.x - 8), y: Math.max(0, tree!.y - 34), width: Math.min(420, tree!.width + 16), height: tree!.height + 68 } });
  const mark = review.locator('[data-risk-bars-line="src/charges/retry.ts#new21"] .ib-riskbars');
  await mark.scrollIntoViewIfNeeded();
  const box = (await mark.boundingBox())!;
  const x = Math.max(0, box.x + box.width + 16 - 520);
  await page.screenshot({ path: join(proofDir, '03-closeup-diff-light.png'), clip: { x, y: Math.max(0, box.y - 60), width: box.x + box.width + 16 - x, height: 130 } });
});

test('a Low PR: no marks anywhere', async () => {
  const review = await openReview(603);
  await expect(review.locator('[data-pull-risk="low"]')).toBeVisible();
  await expect(review.locator('[data-guide-file-shell="README.md"]')).toBeVisible();
  await expect(treeMarks()).toHaveCount(0);
  await expect(diffMarks()).toHaveCount(0);
  await scheme('dark');
  await page.screenshot({ path: join(proofDir, '04-low-no-marks-dark.png') });
});
