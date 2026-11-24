/**
 * PR risk ranking (approval "code-review-launch-build", item 4), proved in a real browser against the compiled binary,
 * with a temp PLANNOTATOR_DATA_DIR. `gh` and `pi` are fakes first on a PATH with no agents on it: nothing reaches a forge,
 * no real agent runs. The fake `pi` speaks Pi's RPC, so the whole road runs: dialog, config, list read, diff read, the
 * Ask AI provider, the strict parse, the file, the window.
 *
 * Proved, in order:
 *  1. Code review off: the route refuses and nothing shows.
 *  2. On with no rules: the Risk chip holds only the way to the dialog; no agent run.
 *  3. The dialog: Pi is the installed agent, its models come from Pi, the cheap one is picked; saving starts the judgments.
 *  4. The rows' marks, all three levels; an answer that makes no sense shows no mark; the agent ran with no tools, no
 *     saved session, its model by flag, and got the rules and the diff.
 *  5. The filter: High, Medium and up, remembered across a reload; what isn't judged is counted, not hidden in silence.
 *  6. The PR's page and its review show the mark and the sentence; a stack takes its highest layer.
 *  7. A restart redoes nothing.
 *  8. A phone: tapping a mark shows the sentence and doesn't open the row.
 *  9. Empty rules turn it all off again.
 *
 * Shots land in PLANNOTATOR_E2E_PROOF_DIR/pull-risk: 1440 and 390, light and dark.
 */
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { E2E_GROUP_TIP_SEEN, inboxScratch, rememberInboxOf, removeInboxScratch, stopScratchInbox } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'pull-risk');

const REPO = 'northwind/billing-svc';
const keyOf = (n: number) => `github.com/${REPO}#${n}`;
const VERDICTS: Record<string, string> = {
  'Retry failed charges on a new schedule': '{"risk":"high","why":"It changes the charge retry schedule in src/charges/retry.ts."}',
  'Send a receipt after checkout': '{"risk":"medium","why":"The new receipt path may reach the charge client, which the diff does not show."}',
  'Fix a typo in the README': '{"risk":"low","why":"Only the README wording changes."}',
  'Upgrade the linter': 'I would say this looks fine to me.',
  'Split the settings page': '{"risk":"low","why":"It only moves settings components."}',
  'Change who can open settings': '{"risk":"high","why":"It changes the permission check on the settings route."}',
  'Charge the late fee twice': '{"risk":"high","why":"It charges the late fee in src/charges/fees.ts."}',
  'Refund to the card on file': '{"risk":"high","why":"It changes where refunds are charged back."}',
  'Waive the card fee for teams': '{"risk":"high","why":"It changes the card fee for team plans."}',
  'Move the invoice job': '{"risk":"high","why":"It moves the job that charges invoices."}',
  'Retry the payouts': '{"risk":"high","why":"It retries payouts to cards."}',
};
/** About 9 MB: past the review page's 8 MB, and more than an argument can carry. The fake model refuses anything past 1 MB, with a model's words. */
const BIG_LINES = 400_000;
const REFUSAL = 'prompt is too long: 900000 tokens > 200000 maximum';
/** #508: its run never answers, so it stays "being ranked" for the whole file. */
const STILL_RANKING = 'Rename the ledger tables';
const RULES = 'Anything in billing or charges.\nAnything that changes permissions.';

function ghPull(number: number, title: string, fields: Record<string, unknown> = {}) {
  return {
    number,
    title,
    url: `https://github.com/${REPO}/pull/${number}`,
    state: 'OPEN',
    isDraft: false,
    updatedAt: new Date(Date.now() - (number - 480) * 7 * 60_000).toISOString(),
    mergedAt: null,
    baseRefName: 'main',
    headRefName: `b${number}`,
    headRefOid: String(number).padStart(40, '0'),
    additions: 12,
    deletions: 3,
    changedFiles: 2,
    reviewDecision: 'REVIEW_REQUIRED',
    repository: { nameWithOwner: REPO },
    headRepository: { nameWithOwner: REPO },
    author: { login: 'tomas' },
    reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', login: 'dana' } }] },
    latestReviews: { nodes: [] },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
    ...fields,
  };
}

const LISTED = () => [
  ghPull(501, 'Retry failed charges on a new schedule'),
  ghPull(502, 'Send a receipt after checkout'),
  ghPull(503, 'Fix a typo in the README'),
  ghPull(504, 'Upgrade the linter'),
  ghPull(505, 'Split the settings page'),
  ghPull(506, 'Change who can open settings', { baseRefName: 'b505' }),
  ghPull(507, 'Regenerate the API client'),
  ghPull(508, STILL_RANKING),
  ghPull(509, 'Charge the late fee twice', { authorAssociation: 'MEMBER' }),
  ghPull(510, 'Refund to the card on file', { authorAssociation: 'MEMBER' }),
  ghPull(511, 'Waive the card fee for teams', { authorAssociation: 'MEMBER' }),
];
const member = { authorAssociation: 'MEMBER' };
const LINE = (base: number) => [ghPull(base + 1, 'Refund to the card on file', member), ghPull(base + 2, 'Waive the card fee for teams', member)];
const LINE_LATER = (base: number) => [ghPull(base - 2, 'Move the invoice job', member), ghPull(base - 1, 'Retry the payouts', member)];
let lineRound = 0;

function writeGhPulls(extra: ReturnType<typeof ghPull>[] = [], listed = LISTED()) {
  writeFileSync(join(fakes, 'gh-pulls.json'), JSON.stringify({ data: { viewer: { login: 'dana' }, requested: { nodes: [...listed, ...extra] }, authored: { nodes: [] }, merged: { nodes: [] } } }));
}

/** A fake gh: the list, each PR's patch, its head. */
function writeGh(dir: string) {
  const gh = [
    '#!/bin/sh',
    `dir='${dir}'`,
    'if [ "$1" = auth ] && [ "$2" = status ]; then',
    '  echo \'{"hosts":{"github.com":[{"login":"dana","active":true,"state":"success","tokenSource":"keyring"}]}}\'; exit 0',
    'fi',
    'if [ "$1" = api ] && [ "$2" = graphql ]; then cat "$dir/gh-pulls.json"; exit 0; fi',
    // The PR read around its patch: head and description as one JSON line (`| tojson`); a plain `.head.sha`, raw.
    'if [ "$1" = api ] && [ "$2" = --hostname ] && [ "$5" = --jq ]; then case "$6" in *tojson*) printf \'{"sha":"%040d","body":null}\\n\' "${4##*/}";; *) printf "%040d\\n" "${4##*/}";; esac; exit 0; fi',
    'if [ "$1" = api ] && [ "$2" = --hostname ] && [ "${4##*/}" = 507 ]; then cat "$dir/big.patch"; exit 0; fi',
    // #503: the forge won't serve it as one document, only file by file.
    'case "$4" in */pulls/503/files*) cat "$dir/files-503.json"; exit 0;; esac',
    'if [ "$1" = api ] && [ "$2" = --hostname ] && [ "${4##*/}" = 503 ]; then echo "gh: Sorry, the diff exceeded the maximum number of lines (20000). (HTTP 406)" >&2; exit 1; fi',
    'if [ "$1" = api ] && [ "$2" = --hostname ]; then',
    '  printf "diff --git a/src/pr%s.ts b/src/pr%s.ts\\n--- a/src/pr%s.ts\\n+++ b/src/pr%s.ts\\n@@ -1 +1 @@\\n-old\\n+new\\n" "${4##*/}" "${4##*/}" "${4##*/}" "${4##*/}"; exit 0',
    'fi',
    'exit 1',
    '',
  ].join('\n');
  writeFileSync(join(dir, 'gh'), gh);
  chmodSync(join(dir, 'gh'), 0o755);
  // No glab: a CLI that isn't installed.
}

/** A fake pi speaking Pi's RPC: every start and every prompt goes in `<dir>/pi.log`; the answer comes from the prompt's title. */
function writePi(dir: string) {
  const script = `
const fs = require('fs');
const log = ${JSON.stringify(join(dir, 'pi.log'))};
const verdicts = ${JSON.stringify(VERDICTS)};
const refusal = ${JSON.stringify(REFUSAL)};
const stillRanking = ${JSON.stringify(STILL_RANKING)};
if (process.argv.includes('--version')) { console.log('0.90.0'); process.exit(0); }
fs.appendFileSync(log, JSON.stringify({ argv: process.argv.slice(2) }) + '\\n');
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.type === 'get_available_models') {
    send({ type: 'response', id: m.id, command: m.type, success: true, data: { models: [
      { provider: 'anthropic', id: 'claude-opus-5-5', name: 'Opus 5.5' },
      { provider: 'anthropic', id: 'claude-sonnet-5', name: 'Sonnet 5' },
      { provider: 'openai', id: 'gpt-5.6-terra', name: 'GPT-5.6-Terra' },
      ...Array.from({ length: 12 }, (_, i) => ({ provider: 'openrouter', id: 'model-' + i, name: 'Model ' + i })),
    ] } });
    return;
  }
  send({ type: 'response', id: m.id, command: m.type, success: true, data: {} });
  if (m.type === 'prompt') {
    fs.appendFileSync(log, JSON.stringify({ prompt: m.message }) + '\\n');
    if (m.message.length > 1_000_000) {
      send({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: refusal } });
      send({ type: 'agent_end' });
      return;
    }
    const title = /^Title: (.*)$/m.exec(m.message)?.[1] ?? '';
    if (title === stillRanking) return;
    send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: verdicts[title] ?? 'no idea' }] } });
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
let dataDir = '';
let fakes = '';
let env: Record<string, string> = {};
let agent: SimAgent;

const piLog = () =>
  existsSync(join(fakes, 'pi.log'))
    ? readFileSync(join(fakes, 'pi.log'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { argv?: string[]; prompt?: string })
    : [];
const prompts = () => piLog().filter((l) => l.prompt);

const VIEWPORTS = { 1440: { width: 1440, height: 900 }, 1280: { width: 1280, height: 900 }, 390: { width: 390, height: 844 }, 320: { width: 320, height: 568 } } as const;

async function shots(name: string, widths: readonly (keyof typeof VIEWPORTS)[] = [1440, 390]): Promise<void> {
  await expect(page.getByText('Tell your agents', { exact: false })).toHaveCount(0);
  for (const width of widths) {
    await page.setViewportSize(VIEWPORTS[width]);
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await page.waitForTimeout(350);
      await page.screenshot({ path: join(proofDir, `${name}-${width}-${scheme}.png`) });
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

async function start(browser?: Browser): Promise<void> {
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  url = started.stdout.trim();
  expect(new URL(url).port).not.toBe('59812');
  if (browser) {
    context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
    page = await context.newPage();
  }
}

const row = (n: number) => page.locator(`[data-pulls-row="${keyOf(n)}"]`);
const openPulls = async () => {
  await page.goto(url);
  await page.locator('[data-pulls-nav]').click();
  await expect(page.locator('[data-pulls-list]')).toBeVisible();
};

test.describe.configure({ mode: 'serial' });
test.use({ actionTimeout: 20_000 });

test.beforeAll(async ({ browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-pull-risk-e2e-');
  dataDir = join(root, 'data');
  markTourDecided(dataDir);
  fakes = join(root, 'fakes');
  mkdirSync(fakes, { recursive: true });
  writeGh(fakes);
  writeFileSync(
    join(fakes, 'files-503.json'),
    `${JSON.stringify([{ filename: 'README.md', status: 'modified', patch: '@@ -1 +1 @@\n-teh\n+the paged page one\n' }])}${JSON.stringify([{ filename: 'README-2.md', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+the paged page two\n' }])}`,
  );
  writePi(fakes);
  writeFileSync(join(fakes, 'big.patch'), `diff --git a/api.ts b/api.ts\n--- a/api.ts\n+++ b/api.ts\n@@ -1 +1,${BIG_LINES} @@\n${'+export const line = 1;\n'.repeat(BIG_LINES)}`);
  // Installed, with no model list to give: they stay on the built-in catalog. They never run a judgment here.
  for (const cli of ['claude', 'codex']) {
    writeFileSync(join(fakes, cli), '#!/bin/sh\nexit 1\n');
    chmodSync(join(fakes, cli), 0o755);
  }
  writeGhPulls();
  const project = scratchProject(join(root, 'src'), 'billing-svc');
  const git = (...args: string[]) => spawnSync('git', args, { cwd: project, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  git('remote', 'add', 'origin', `https://github.com/${REPO}.git`);
  for (const dir of ['claude', 'codex', 'xdg', 'home']) mkdirSync(join(root, dir), { recursive: true });
  env = {
    // Fakes and the system's own folders only: no real agent can be found.
    PATH: `${fakes}:/usr/bin:/bin`,
    PLANNOTATOR_TEST_LAUNCH_PATH: `${fakes}:/usr/bin:/bin`,
    // This Inbox's own: it never reads a person's real home.
    HOME: join(root, 'home'),
    PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_ANON_PING: '1',
    PLANNOTATOR_INBOX_NOTES: '0',
    PLANNOTATOR_TEST_SANDBOX: '1',
    // The sandbox finds an agent only in a temp folder, and this one is where the fake `pi` is.
    TMPDIR: tmpdir(),
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    CODEX_HOME: join(root, 'codex'),
    XDG_CONFIG_HOME: join(root, 'xdg'),
  };
  await start(browser);
  agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  await agent.send({ project_path: project, thread: 'charges', subject: 'Retry failed charges', body: 'Opened the retries.' });
});

test.afterAll(async () => {
  try {
    await agent?.close().catch(() => {});
    await context?.close();
  } finally {
    await removeInboxScratch();
  }
});

test('Code review off: the route refuses, and no chip or agent run shows', async () => {
  await page.goto(url);
  const refused = await page.request.get(`${url}api/inbox/pulls/risk`);
  expect(refused.status()).toBe(409);
  await expect(page.locator('[data-pulls-risk-chip]')).toHaveCount(0);
  expect(piLog()).toEqual([]);
});

test('on with no rules: the chip holds only the way to the rules; no agent run', async () => {
  const on = await page.request.post(`${url}api/inbox/settings`, { data: { code_review: { on: true } } });
  expect(on.status()).toBe(200);
  await openPulls();
  await expect(page.locator('[data-pulls-risk-chip]')).toHaveText(/Risk/);
  await expect(row(501).locator('[data-pull-risk]')).toHaveCount(0);
  expect(prompts()).toEqual([]);
  await shots('no-rules');
  await page.locator('[data-pulls-risk-chip]').click();
  await expect(page.locator('[data-pulls-risk-rules]')).toBeVisible();
  await expect(page.locator('[data-pulls-risk-option]')).toHaveCount(0);
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.screenshot({ path: join(proofDir, 'no-rules-menu-1440-light.png') });
  await page.keyboard.press('Escape');
});

test('the dialog: the guided review\'s list; Sonnet on Claude, the newest Luna on Codex, Default on Pi; saving starts the judgments', async () => {
  await page.locator('[data-pulls-risk-chip]').click();
  await page.locator('[data-pulls-risk-rules]').click();
  const dialog = page.locator('[data-dialog="pull-risk-rules"]');
  const agentList = dialog.locator('[data-pull-risk-agent]');
  const modelList = dialog.locator('[data-pull-risk-model]');
  const pickAgent = async (name: string) => {
    await agentList.getByRole('button').first().click();
    await agentList.getByRole('button', { name, exact: true }).click();
  };
  await expect(dialog.getByRole('heading', { name: 'Risk rules' })).toBeVisible();
  await expect(dialog.locator('[data-pull-risk-rules-text]')).toBeFocused();
  await expect(agentList).toHaveAttribute('data-pull-risk-agent', 'claude-agent-sdk');
  await expect(modelList).toHaveAttribute('data-pull-risk-model', 'sonnet');
  await expect(modelList.getByRole('button').first()).toContainText('Sonnet');
  await dialog.locator('[data-pull-risk-rules-text]').fill(RULES);
  await expect(dialog.locator('[data-pull-risk-auto]')).toContainText('On High, make');
  await shots('dialog', [1440, 1280, 390, 320]);
  // A phone: the sheet takes the screen's width, the words only its inset, and every control a thumb's height.
  for (const width of [390, 320] as const) {
    await page.setViewportSize(VIEWPORTS[width]);
    const box = await dialog.boundingBox();
    expect(box!.width).toBe(width);
    // 16 and the sheet's 1 px border. The padding drawn twice was 45.
    expect((await dialog.locator('[data-pull-risk-rules-text]').boundingBox())!.x).toBeLessThanOrEqual(17);
    expect((await modelList.getByRole('button').first().boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect((await dialog.locator('[data-pull-risk-save]').boundingBox())!.height).toBeGreaterThanOrEqual(44);
    // Nothing to scroll for: Cancel, the last thing in the sheet, is on the screen.
    const cancel = await dialog.getByRole('button', { name: 'Cancel', exact: true }).boundingBox();
    expect(cancel!.y + cancel!.height).toBeLessThanOrEqual(VIEWPORTS[width].height);
  }
  await page.setViewportSize(VIEWPORTS[1440]);
  await modelList.getByRole('button').first().click();
  await expect(modelList.getByRole('button', { name: 'Haiku (latest)' })).toBeVisible();
  await shots('dialog-dropdown', [1440, 390, 320]);

  // Escape closes the list and keeps the dialog and its words.
  await page.keyboard.press('Escape');
  await expect(modelList.getByRole('button', { name: 'Haiku (latest)' })).toHaveCount(0);
  await expect(dialog.locator('[data-pull-risk-rules-text]')).toHaveValue(RULES);

  await pickAgent('Codex');
  await expect(modelList).toHaveAttribute('data-pull-risk-model', 'gpt-6-luna');
  await expect(modelList.getByRole('button').first()).toContainText('GPT-6-Luna');
  await shots('dialog-codex', [1440, 390, 320]);

  await pickAgent('Pi');
  await expect(modelList.getByRole('button').first()).toContainText('Default');
  await expect(modelList).toHaveAttribute('data-pull-risk-model', '');
  await modelList.getByRole('button').first().click();
  // A long list gets the guided review's filter box and its groups.
  await expect(modelList.getByPlaceholder('Type to filter…')).toBeVisible();
  await expect(modelList.getByRole('button', { name: 'Default', exact: true })).toBeVisible();
  // Its group headings in plain case, not capitals.
  await expect(modelList.getByText('anthropic', { exact: true })).toHaveCSS('text-transform', 'none');
  await shots('dialog-dropdown-pi', [1440, 390, 320]);
  // On the smallest phone the open list, its filter box included, stays on the screen.
  await page.setViewportSize(VIEWPORTS[320]);
  const openList = await modelList.locator('.absolute').boundingBox();
  expect(openList!.y).toBeGreaterThanOrEqual(0);
  expect(openList!.y + openList!.height).toBeLessThanOrEqual(VIEWPORTS[320].height);
  expect(openList!.x + openList!.width).toBeLessThanOrEqual(VIEWPORTS[320].width);
  await page.setViewportSize(VIEWPORTS[1440]);
  // Escape in the filter box closes the list, and the dialog stays with its words.
  await modelList.getByPlaceholder('Type to filter…').press('Escape');
  await expect(modelList.getByPlaceholder('Type to filter…')).toHaveCount(0);
  await expect(dialog.locator('[data-pull-risk-rules-text]')).toHaveValue(RULES);
  // Enter in the filter box stays in the list: half-written rules aren't saved, and nothing runs. No match, then a match.
  await dialog.locator('[data-pull-risk-rules-text]').fill('half-written ru');
  await modelList.getByRole('button').first().click();
  await modelList.getByPlaceholder('Type to filter…').fill('zzzzz');
  await modelList.getByPlaceholder('Type to filter…').press('Enter');
  await expect(dialog).toBeVisible();
  await expect(modelList.getByPlaceholder('Type to filter…')).toBeVisible();
  await modelList.getByPlaceholder('Type to filter…').fill('Opus');
  await modelList.getByPlaceholder('Type to filter…').press('Enter');
  await expect(modelList.getByPlaceholder('Type to filter…')).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-pull-risk-rules-text]')).toHaveValue('half-written ru');
  expect(((await (await page.request.get(`${url}api/inbox/pulls/risk`)).json()) as { rules: string }).rules).not.toContain('half-written');
  await dialog.locator('[data-pull-risk-rules-text]').fill(RULES);
  await modelList.getByRole('button').first().click();
  await modelList.getByPlaceholder('Type to filter…').fill('Sonnet');
  await modelList.getByRole('button', { name: /Sonnet 5/ }).click();
  await expect(modelList).toHaveAttribute('data-pull-risk-model', 'anthropic/claude-sonnet-5');

  // Reading the models ran the agents, but no judgment ran before the save.
  expect(prompts()).toEqual([]);
  await dialog.locator('[data-pull-risk-save]').click();
  await expect(dialog).toHaveCount(0);
});

test('the rows: all three levels; an answer that makes no sense and a refused diff say so, with no level; how the agent ran', async () => {
  await expect(row(501).locator('[data-pull-risk="high"]')).toBeVisible({ timeout: 30_000 });
  // Medium, Low and a failure: the row's level, its mark drawn on the open row's second line only.
  await expect(row(502)).toHaveAttribute('data-pulls-risk', 'medium', { timeout: 30_000 });
  await expect(row(503)).toHaveAttribute('data-pulls-risk', 'low', { timeout: 30_000 });
  await expect(row(502).locator('[data-pull-risk]')).toHaveCount(0);
  // A stack is one row, at its highest layer.
  await expect(row(506).locator('[data-pull-risk="high"]')).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => prompts().length).toBe(11);
  await expect(row(504)).toHaveAttribute('data-pulls-risk', 'failed', { timeout: 30_000 });
  for (const [n, level] of [[502, 'medium'], [503, 'low']] as const) {
    await row(n).click();
    await expect(row(n).locator(`[data-reviews-line2] [data-pull-risk="${level}"]`)).toBeVisible();
  }
  await row(504).click();
  await expect(row(504).locator('[data-reviews-line2] [data-pull-risk="failed"]')).toBeVisible();
  await expect(row(504).locator('[data-pull-risk="failed"]')).toContainText('I would say this looks fine to me.');

  // The forge refused #503 as one document: the agent read its per-file pages, and ranked it.
  const paged = prompts().find((l) => l.prompt!.includes('Title: Fix a typo in the README'))!.prompt!;
  expect(paged).toContain('+the paged page one');
  expect(paged).toContain('+the paged page two');

  // The whole 9 MB reached the agent, and it refused: failed to rank, with its words. Not Low.
  const big = prompts().find((l) => l.prompt!.includes('Title: Regenerate the API client'))!.prompt!;
  expect(big.match(/export const line = 1;/g)).toHaveLength(BIG_LINES);
  await expect(row(507)).toHaveAttribute('data-pulls-risk', 'failed', { timeout: 30_000 });
  await row(507).click();
  const refused = row(507).locator('[data-pull-risk]');
  await expect(refused).toHaveAttribute('data-pull-risk', 'failed');
  await expect(refused).toContainText('Couldn\u2019t rank');
  await refused.hover();
  await expect(page.locator('[data-pn-tooltip]')).toContainText(REFUSAL);
  await page.mouse.move(0, 0);
  // Open beside the list: a phone would show the PR's page in its place.
  await shots('rows-refused', [1440]);
  await page.locator('[data-launchpad] .ib-pr-bar [aria-label="Close"]').click();
  await expect(page.locator('[data-pulls-list] [aria-current="true"]')).toHaveCount(0);

  const judged = piLog().filter((l) => l.argv?.includes('--no-tools'));
  expect(judged).toHaveLength(11);
  // Nothing of a diff is ever in an agent's argv.
  expect(judged.every((l) => l.argv!.join(' ').length < 2_000)).toBe(true);
  expect(judged[0]!.argv!.join(' ')).toContain('--no-tools --no-session --no-extensions --no-skills --no-context-files --provider anthropic --model claude-sonnet-5 --thinking low');
  const asked = prompts().find((l) => l.prompt!.includes('Title: Retry failed charges'))!.prompt!;
  expect(asked).toContain('Anything in billing or charges.');
  expect(asked).toContain('+new');
  await row(501).locator('[data-pull-risk]').hover();
  await expect(page.locator('[data-pn-tooltip]')).toContainText('It changes the charge retry schedule');
  await page.mouse.move(0, 0);
  await shots('rows');
  // The rules are in the config, never in the judgments' file.
  expect(readFileSync(join(dataDir, 'config.json'), 'utf8')).toContain('Anything in billing');
  expect(readFileSync(join(dataDir, 'inbox', 'pull-risk.json'), 'utf8')).not.toContain('Anything in billing');
});

const SHEETS = [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
  { width: 320, height: 568 },
] as const;

async function sheetFits(dialog: Locator, width: number, extra: Locator[] = []): Promise<void> {
  const phone = width < 768;
  for (const control of [...(await dialog.locator('button:visible, textarea:visible').all()), ...extra]) {
    await expect(control).toBeInViewport({ ratio: 1 });
    await control.click({ trial: true });
    if (phone && (await control.evaluate((el) => el.tagName === 'BUTTON' && !el.closest('.absolute')))) expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  const cut = await dialog.evaluate((el) =>
    [el, ...el.querySelectorAll('*')]
      .filter((node) => !node.closest('.ib-sr') && node.scrollWidth > node.clientWidth + 1 && getComputedStyle(node).overflowX !== 'visible')
      .map((node) => `${node.tagName}.${node.className}: ${node.textContent}`),
  );
  expect(cut).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  const box = (await dialog.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(width);
}

async function eachSheet(name: string, check: (width: number) => Promise<void>): Promise<void> {
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  for (const size of SHEETS) {
    await page.setViewportSize(size);
    await page.waitForTimeout(350);
    await check(size.width);
    await page.screenshot({ path: join(proofDir, `${name}-${size.width}.png`) });
  }
  await page.setViewportSize(VIEWPORTS[1440]);
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

const autoRuns = async () => ((await (await page.request.get(`${url}api/inbox/pulls/risk`)).json()) as { auto_runs?: Record<string, { state: string; reason?: string }> }).auto_runs ?? {};

test('the automatic line: a pick names the agent it would start; Save starts nothing for PRs ranked before it, and asks; Not now keeps it so, Make them now runs the pass', async () => {
  mkdirSync(join(dataDir, 'agents-home', '.pi', 'agent'), { recursive: true });
  writeFileSync(join(dataDir, 'agents-home', '.pi', 'agent', 'settings.json'), JSON.stringify({ packages: ['npm:@plannotator/pi-extension'] }));
  const reads: string[] = [];
  const onRequest = (request: { url(): string }) => {
    if (request.url().includes('/api/inbox/pulls/risk?auto_agent=1')) reads.push(request.url());
  };
  const dialog = page.locator('[data-dialog="pull-risk-rules"]');
  const auto = dialog.locator('[data-pull-risk-auto]');
  const withAgent = dialog.locator('[data-pull-risk-auto-agent]');
  const openRules = async () => {
    await page.locator('[data-pulls-risk-chip]').click();
    await page.locator('[data-pulls-risk-rules]').click();
    await expect(dialog).toBeVisible();
  };
  const pickMake = async (name: string) => {
    await auto.getByRole('button').first().click();
    await auto.getByRole('button', { name, exact: true }).click();
  };
  try {
    expect((await page.request.post(`${url}api/inbox/launch/settings`, { data: { enabled: true } })).status()).toBe(200);
    await expect
      .poll(async () => JSON.stringify(((await (await page.request.get(`${url}api/inbox/sessions`)).json()) as { launch?: unknown }).launch ?? null), { timeout: 15_000 })
      .toContain('"agent":"pi"');
    page.on('request', onRequest);
    await openRules();
    await expect(auto).toHaveAttribute('data-pull-risk-auto', '');
    await expect(withAgent).toHaveCount(0);
    expect(reads).toEqual([]);
    await pickMake('a Picture page');
    await expect(withAgent).toHaveAttribute('data-pull-risk-auto-agent', 'pi');
    await expect(withAgent).toHaveText(/^with\s+Pi$/);
    await pickMake('a guided review');
    await expect(auto).toHaveAttribute('data-pull-risk-auto', 'guide');
    await expect(withAgent).toHaveText(/^with\s+Pi$/);
    expect(reads).toHaveLength(1);
    page.off('request', onRequest);

    await eachSheet('risk-dialog-filled', async (width) => {
      await expect(withAgent).toBeInViewport({ ratio: 1 });
      await sheetFits(dialog, width);
      if (width === 320) expect((await dialog.locator('[data-pull-risk-rules-text]').boundingBox())!.height).toBeGreaterThanOrEqual(88);
    });

    const tip = page.locator('[data-pn-tooltip][data-open]');
    await eachSheet('risk-dialog-info', async (width) => {
      const info = dialog.locator('[data-pull-risk-info="auto"]');
      if ((await info.getAttribute('data-open')) === null) await info.click();
      await expect(info).toHaveAttribute('data-open', '');
      await expect(tip).toHaveText('New pull requests and pushes from your team that rank High get one, once. The rest wait until you ask.');
      await expect(tip).toBeInViewport({ ratio: 1 });
      await sheetFits(dialog, width, [info]);
    });
    await page.keyboard.press('Escape');
    await expect(tip).toHaveCount(0);
    await expect(dialog).toBeVisible();

    await dialog.locator('[data-pull-risk-save]').click();
    const ranked = dialog.locator('[data-pull-risk-ranked]');
    await expect(ranked).toHaveAttribute('data-pull-risk-ranked', '3');
    await expect(ranked.getByRole('heading')).toHaveText('3 already rank High.');
    await eachSheet('risk-dialog-ranked', async (width) => {
      await sheetFits(dialog, width);
    });
    expect(await autoRuns()).toEqual({});
    await dialog.getByRole('button', { name: 'Not now', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    for (let i = 0; i < 3; i++) {
      await openPulls();
      await expect(row(501).locator('[data-pull-risk="high"]')).toBeVisible({ timeout: 30_000 });
    }
    await page.waitForTimeout(1_500);
    expect(await autoRuns()).toEqual({});

    const launched = () => piLog().filter((l) => l.argv?.includes('--mode') && l.argv.includes('rpc') && l.argv.includes('--session-id'));
    expect(launched()).toEqual([]);
    await openRules();
    await dialog.locator('[data-pull-risk-save]').click();
    await expect(ranked).toHaveAttribute('data-pull-risk-ranked', '3');
    await dialog.getByRole('button', { name: 'Make them now', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await autoRuns())[keyOf(509)]?.state, { timeout: 30_000 }).toBe('started');
    const runs = await autoRuns();
    expect(Object.keys(runs).sort()).toEqual([keyOf(509), keyOf(510), keyOf(511)]);
    expect([runs[keyOf(510)]!.state, runs[keyOf(511)]!.state]).toEqual(['queued', 'queued']);
    await expect.poll(() => launched().length, { timeout: 30_000 }).toBe(1);
    const argv = launched()[0]!.argv!;
    expect(argv[argv.indexOf('--name') + 1]).toBe('Review #509: Charge the late fee twice');
    expect(argv.join(' ')).not.toMatch(/#51[01]/);

    const saved = (await (await page.request.get(`${url}api/inbox/pulls/risk`)).json()) as { rules: string; provider: string | null; model: string | null };
    expect((await page.request.post(`${url}api/inbox/pulls/risk`, { data: { rules: saved.rules, provider: saved.provider, model: saved.model, auto: null } })).status()).toBe(200);
    expect(Object.keys(await autoRuns())).toEqual([keyOf(509)]);
    expect((await page.request.post(`${url}api/inbox/launch/settings`, { data: { enabled: false } })).status()).toBe(200);
    await openPulls();
    for (const n of [504, 507]) await expect(row(n)).toHaveAttribute('data-pulls-risk', 'failed', { timeout: 60_000 });
  } finally {
    page.off('request', onRequest);
    await page.setViewportSize(VIEWPORTS[1440]);
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
    const left = (await page.request.get(`${url}api/inbox/pulls/risk`).then((r) => r.json()).catch(() => null)) as { rules: string; provider: string | null; model: string | null } | null;
    if (left) await page.request.post(`${url}api/inbox/pulls/risk`, { data: { rules: left.rules, provider: left.provider, model: left.model, auto: null } }).catch(() => {});
    await page.request.post(`${url}api/inbox/launch/settings`, { data: { enabled: false } }).catch(() => {});
  }
});

test('the filter: High, Medium and up, remembered; under High what it could not place is one quiet count that shows it', async () => {
  const pick = async (option: string) => {
    await page.locator('[data-pulls-risk-chip]').click();
    await page.locator(`[data-pulls-risk-option="${option}"]`).click();
  };
  await page.locator('[data-pulls-risk-chip]').click();
  await expect(page.locator('[data-pulls-risk-menu]')).toBeVisible();
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.screenshot({ path: join(proofDir, 'filter-menu-1440-light.png') });
  // A key pressed first is the hard case: the browser then draws a ring on whatever gets the focus next.
  await page.keyboard.press('Escape');
  await pick('high');
  await expect(page.locator('[data-pulls-risk-menu]')).toHaveCount(0);
  // After a click, no ring stays on the chip.
  expect(await page.locator('[data-pulls-risk-chip]').evaluate((el) => el.matches(':focus-visible'))).toBe(false);
  await expect(row(501)).toBeVisible();
  await expect(row(506)).toBeVisible();
  await expect(row(502)).toHaveCount(0);
  await expect(row(503)).toHaveCount(0);
  // Two failed (#504, #507) and one still being ranked (#508): one line, no rows.
  for (const n of [504, 507, 508]) await expect(row(n)).toHaveCount(0);
  const notRanked = page.locator('[data-pulls-risk-not-ranked-toggle]');
  await expect(notRanked).toHaveText('3 not ranked');
  await expect(page.locator('[data-pulls-risk-not-judged]')).toHaveCount(0);
  await page.mouse.move(0, 0);
  await shots('filter-high');
  await notRanked.click();
  for (const n of [504, 507, 508]) await expect(page.locator(`[data-pulls-risk-not-ranked] [data-pulls-row="${keyOf(n)}"]`)).toBeVisible();
  await expect(row(504)).toHaveAttribute('data-pulls-risk', 'failed');
  await expect(row(508)).not.toHaveAttribute('data-pulls-risk');
  await page.mouse.move(0, 0);
  await shots('filter-high-open');
  await notRanked.click();
  await expect(row(504)).toHaveCount(0);
  await page.reload();
  await expect(row(501)).toBeVisible();
  await expect(row(503)).toHaveCount(0);
  await pick('medium');
  await expect(row(502)).toBeVisible();
  await expect(row(503)).toHaveCount(0);
  // Medium and up as before: a failed row stays in the list, and no count of High's.
  await expect(row(504)).toBeVisible();
  await expect(page.locator('[data-pulls-risk-not-ranked]')).toHaveCount(0);
  await pick('all');
  await expect(row(503)).toBeVisible();
  await expect(row(504)).toBeVisible();
  await expect(page.locator('[data-pulls-risk-not-judged]')).toHaveCount(0);
});

test("the PR's page and its review carry the mark and the sentence; a stack shows its highest layer", async () => {
  await row(501).click();
  const line = page.locator('[data-pulls-risk-line="high"]');
  await expect(line).toContainText('High risk');
  await expect(line).toContainText('It changes the charge retry schedule in src/charges/retry.ts.');
  await shots('pr-page');
  await row(506).click();
  await expect(line).toContainText('It changes the permission check');
  await expect(page.locator(`[data-pulls-layer="${keyOf(505)}"] [data-pull-risk="low"]`)).toBeVisible();
  await expect(page.locator(`[data-pulls-layer="${keyOf(506)}"] [data-pull-risk="high"]`)).toBeVisible();
  await shots('pr-page-stack');
  await row(501).click();
  await page.locator('[data-pulls-open-diff]').click();
  const review = page.locator(`[data-pull-review="${keyOf(501)}"]`);
  await expect(review.locator('[data-pull-risk="high"]')).toBeVisible();
  await shots('pr-review');
});

test('a restart redoes nothing', async () => {
  await context.close();
  await stopScratchInbox(dataDir);
  const failed = (l: { prompt?: string }) => l.prompt!.includes('The Inbox sent this on its own') || ['Upgrade the linter', 'Regenerate the API client', STILL_RANKING].some((title) => l.prompt!.includes(`Title: ${title}`));
  const before = prompts().filter((l) => !failed(l)).length;
  await start();
  context = await page.context().browser()!.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  page = await context.newPage();
  await openPulls();
  await expect(row(501).locator('[data-pull-risk="high"]')).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1_000);
  // Only the ones with no judgment are tried again.
  expect(prompts().filter((l) => !failed(l)).length).toBe(before);
});

test("a phone: tapping a mark shows the sentence and doesn't open the row", async ({ browser }) => {
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'light', hasTouch: true, isMobile: true });
  const tab = await phone.newPage();
  await tab.goto(`${url}#pulls`);
  const mark = tab.locator(`[data-pulls-row="${keyOf(501)}"] [data-pull-risk="high"]`);
  await expect(mark).toBeVisible({ timeout: 30_000 });
  await mark.tap();
  await expect(tab.locator('[data-pn-tooltip]')).toContainText('It changes the charge retry schedule');
  await expect(tab.locator('[data-pulls-risk-line]')).toHaveCount(0);
  // Past its fade: the picture has to show the sentence.
  await expect.poll(() => tab.locator('[data-pn-tooltip]').evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
  await tab.screenshot({ path: join(proofDir, 'tap-390-light.png') });
  await phone.close();
});

test('empty rules turn it off again: the marks and the filter choices go, the chip stays', async () => {
  await page.locator('[data-pulls-risk-chip]').click();
  await page.locator('[data-pulls-risk-rules]').click();
  const dialog = page.locator('[data-dialog="pull-risk-rules"]');
  await expect(dialog.locator('[data-pull-risk-rules-text]')).toHaveValue(RULES);
  await dialog.locator('[data-pull-risk-rules-text]').fill('');
  await dialog.locator('[data-pull-risk-save]').click();
  await expect(row(501).locator('[data-pull-risk]')).toHaveCount(0);
  await page.locator('[data-pulls-risk-chip]').click();
  await expect(page.locator('[data-pulls-risk-option]')).toHaveCount(0);
});

test('set up with nothing ranked: no agent starts; once ranking lands a dialog on Reviews asks; Not now keeps it away; Make them now starts what it counted', async () => {
  await context.close();
  await stopScratchInbox(dataDir);
  const config = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) as Record<string, unknown>;
  const was = (config.inboxPullRisk ?? {}) as Record<string, unknown>;
  config.inboxCodeReview = true;
  config.inboxPullRisk = { ...was, rules: RULES, provider: 'pi-sdk', auto: { level: 'high', make: 'guide' } };
  config.inboxReveals = { ...E2E_GROUP_TIP_SEEN, ...((config.inboxReveals as Record<string, unknown> | undefined) ?? {}) };
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify(config));
  for (const name of ['pull-risk.json', 'pull-risk-auto.json']) rmSync(join(dataDir, 'inbox', name), { force: true });
  const base = 600 + 10 * lineRound++;
  mkdirSync(join(dataDir, 'agents-home', '.pi', 'agent'), { recursive: true });
  writeFileSync(join(dataDir, 'agents-home', '.pi', 'agent', 'settings.json'), JSON.stringify({ packages: ['npm:@plannotator/pi-extension'] }));
  writeGhPulls([], LINE(base));
  const launches = () => piLog().filter((l) => l.argv?.includes('--mode') && l.argv.includes('rpc') && l.argv.includes('--session-id')).length;
  const launchedBefore = launches();
  await start();
  context = await page.context().browser()!.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  page = await context.newPage();
  try {
    expect((await page.request.post(`${url}api/inbox/launch/settings`, { data: { enabled: true } })).status()).toBe(200);
    await expect
      .poll(async () => ((await (await page.request.get(`${url}api/inbox/pulls/risk?auto_agent=1`)).json()) as { auto_agent?: { agent: string } | null }).auto_agent?.agent ?? null, { timeout: 15_000 })
      .toBe('pi');
    await page.setViewportSize(VIEWPORTS[390]);
    await page.goto(`${url}#pulls`);
    await expect(page.locator('[data-pulls-list]')).toBeVisible();
    const asking = page.getByRole('dialog', { name: /already ranks? High$/ });
    const waitingLine = asking.locator('[data-pull-risk-waiting]');
    await expect(waitingLine)
      .toHaveAttribute('data-pull-risk-waiting', '2', { timeout: 60_000 })
      .catch(async (cause: Error) => {
        const risk = (await (await page.request.get(`${url}api/inbox/pulls/risk`)).json()) as Record<string, unknown>;
        const { pending, judgments, auto, auto_waiting, auto_dismissed, auto_agent, auto_agent_unavailable, auto_runs } = risk;
        throw new Error(`${cause.message}\nrisk answer now: ${JSON.stringify({ pending, judgments: Object.keys((judgments ?? {}) as object), auto, auto_waiting, auto_dismissed, auto_agent, auto_agent_unavailable, auto_runs })}`);
      });
    await expect(asking.getByRole('heading')).toHaveText('2 already rank High');
    await expect(asking.locator('p').first()).toHaveText('You turned on guided reviews for High. Make one for each now?');
    await expect(asking.locator('li')).toHaveCount(2);
    for (const [n, title] of [[base + 1, 'Refund to the card on file'], [base + 2, 'Waive the card fee for teams']] as const) await expect(asking.locator('li', { hasText: title })).toContainText(`#${n}`);
    expect(await autoRuns()).toEqual({});
    expect(launches()).toBe(launchedBefore);
    for (const scheme of ['dark', 'light'] as const) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      for (const size of SHEETS) {
        await page.setViewportSize(size);
        await page.waitForTimeout(350);
        await sheetFits(asking, size.width);
        await page.screenshot({ path: join(proofDir, `risk-ask-${size.width}-${scheme}.png`) });
      }
    }
    await page.setViewportSize(VIEWPORTS[1440]);
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });

    await expect(asking.locator('[data-pull-risk-waiting-armed]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(asking).toHaveCount(0);
    await expect.poll(async () => ((await (await page.request.get(`${url}api/inbox/pulls/risk`)).json()) as { auto_dismissed?: string[] }).auto_dismissed?.sort()).toEqual([keyOf(base + 1), keyOf(base + 2)].sort());
    await openPulls();
    await expect(row(base + 2).locator('[data-pull-risk="high"]')).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(1_500);
    await expect(asking).toHaveCount(0);
    expect(await autoRuns()).toEqual({});

    writeGhPulls(LINE_LATER(base), LINE(base));
    await expect.poll(async () => (await (await page.request.get(`${url}api/inbox/pulls?refresh=1`)).text()).includes('Move the invoice job'), { timeout: 60_000, intervals: [2_000] }).toBe(true);
    await openPulls();
    await expect(waitingLine).toHaveAttribute('data-pull-risk-waiting', '2', { timeout: 60_000 });
    expect(await autoRuns()).toEqual({});
    await expect(asking.locator('[data-pull-risk-waiting-armed]')).toBeVisible();
    await asking.getByRole('button', { name: 'Make them now', exact: true }).click();
    await expect(asking).toHaveCount(0);
    await expect.poll(async () => (await autoRuns())[keyOf(base - 2)]?.state, { timeout: 30_000 }).toBe('started');
    const runs = await autoRuns();
    expect(Object.keys(runs).sort()).toEqual([keyOf(base - 2), keyOf(base - 1)]);
    expect(['queued', 'started']).toContain(runs[keyOf(base - 1)]!.state);
    await expect.poll(launches, { timeout: 30_000 }).toBeGreaterThan(launchedBefore);
    const argv = piLog().filter((l) => l.argv?.includes('--mode') && l.argv.includes('rpc') && l.argv.includes('--session-id'))[launchedBefore]!.argv!;
    expect(argv[argv.indexOf('--name') + 1]).toBe(`Review #${base - 2}: Move the invoice job`);
  } finally {
    await page.setViewportSize(VIEWPORTS[1440]).catch(() => {});
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' }).catch(() => {});
    const left = (await page.request.get(`${url}api/inbox/pulls/risk`).then((r) => r.json()).catch(() => null)) as { rules: string; provider: string | null; model: string | null } | null;
    if (left) await page.request.post(`${url}api/inbox/pulls/risk`, { data: { rules: left.rules, provider: left.provider, model: left.model, auto: null } }).catch(() => {});
    await page.request.post(`${url}api/inbox/launch/settings`, { data: { enabled: false } }).catch(() => {});
  }
});
