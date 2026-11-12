import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { inboxScratch, rememberInboxOf, removeInboxScratch, stopScratchInbox } from './inbox-scratch';

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
};
const BIG_LINES = 400_000;
const REFUSAL = 'prompt is too long: 900000 tokens > 200000 maximum';
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

function writeGh(dir: string) {
  const gh = [
    '#!/bin/sh',
    `dir='${dir}'`,
    'if [ "$1" = auth ] && [ "$2" = status ]; then',
    '  echo \'{"hosts":{"github.com":[{"login":"dana","active":true,"state":"success","tokenSource":"keyring"}]}}\'; exit 0',
    'fi',
    'if [ "$1" = api ] && [ "$2" = graphql ]; then cat "$dir/gh-pulls.json"; exit 0; fi',
    'if [ "$1" = api ] && [ "$2" = --hostname ] && [ "$5" = --jq ]; then case "$6" in *tojson*) printf \'{"sha":"%040d","body":null}\\n\' "${4##*/}";; *) printf "%040d\\n" "${4##*/}";; esac; exit 0; fi',
    'if [ "$1" = api ] && [ "$2" = --hostname ] && [ "${4##*/}" = 507 ]; then cat "$dir/big.patch"; exit 0; fi',
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
}

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

const VIEWPORTS = { 1440: { width: 1440, height: 900 }, 390: { width: 390, height: 844 }, 320: { width: 320, height: 568 } } as const;

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
  for (const cli of ['claude', 'codex']) {
    writeFileSync(join(fakes, cli), '#!/bin/sh\nexit 1\n');
    chmodSync(join(fakes, cli), 0o755);
  }
  writeFileSync(
    join(fakes, 'gh-pulls.json'),
    JSON.stringify({
      data: {
        viewer: { login: 'dana' },
        requested: {
          nodes: [
            ghPull(501, 'Retry failed charges on a new schedule'),
            ghPull(502, 'Send a receipt after checkout'),
            ghPull(503, 'Fix a typo in the README'),
            ghPull(504, 'Upgrade the linter'),
            ghPull(505, 'Split the settings page'),
            ghPull(506, 'Change who can open settings', { baseRefName: 'b505' }),
            ghPull(507, 'Regenerate the API client'),
            ghPull(508, STILL_RANKING),
          ],
        },
        authored: { nodes: [] },
        merged: { nodes: [] },
      },
    }),
  );
  const project = scratchProject(join(root, 'src'), 'billing-svc');
  const git = (...args: string[]) => spawnSync('git', args, { cwd: project, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  git('remote', 'add', 'origin', `https://github.com/${REPO}.git`);
  for (const dir of ['claude', 'codex', 'xdg', 'home']) mkdirSync(join(root, dir), { recursive: true });
  env = {
    PATH: `${fakes}:/usr/bin:/bin`,
    HOME: join(root, 'home'),
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
  await expect(dialog.getByRole('heading', { name: 'No slop zone rules' })).toBeVisible();
  await expect(dialog.locator('[data-pull-risk-rules-text]')).toBeFocused();
  await expect(agentList).toHaveAttribute('data-pull-risk-agent', 'claude-agent-sdk');
  await expect(modelList).toHaveAttribute('data-pull-risk-model', 'sonnet');
  await expect(modelList.getByRole('button').first()).toContainText('Sonnet');
  await dialog.locator('[data-pull-risk-rules-text]').fill(RULES);
  await shots('dialog', [1440, 390, 320]);
  for (const width of [390, 320] as const) {
    await page.setViewportSize(VIEWPORTS[width]);
    const box = await dialog.boundingBox();
    expect(box!.width).toBe(width);
    expect((await dialog.locator('[data-pull-risk-rules-text]').boundingBox())!.x).toBeLessThanOrEqual(17);
    expect((await modelList.getByRole('button').first().boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect((await dialog.locator('[data-pull-risk-save]').boundingBox())!.height).toBeGreaterThanOrEqual(44);
    const cancel = await dialog.getByRole('button', { name: 'Cancel', exact: true }).boundingBox();
    expect(cancel!.y + cancel!.height).toBeLessThanOrEqual(VIEWPORTS[width].height);
  }
  await page.setViewportSize(VIEWPORTS[1440]);
  await modelList.getByRole('button').first().click();
  await expect(modelList.getByRole('button', { name: 'Haiku (latest)' })).toBeVisible();
  await shots('dialog-dropdown', [1440, 390, 320]);

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
  await expect(modelList.getByPlaceholder('Type to filter…')).toBeVisible();
  await expect(modelList.getByRole('button', { name: 'Default', exact: true })).toBeVisible();
  await expect(modelList.getByText('anthropic', { exact: true })).toHaveCSS('text-transform', 'none');
  await shots('dialog-dropdown-pi', [1440, 390, 320]);
  await page.setViewportSize(VIEWPORTS[320]);
  const openList = await modelList.locator('.absolute').boundingBox();
  expect(openList!.y).toBeGreaterThanOrEqual(0);
  expect(openList!.y + openList!.height).toBeLessThanOrEqual(VIEWPORTS[320].height);
  expect(openList!.x + openList!.width).toBeLessThanOrEqual(VIEWPORTS[320].width);
  await page.setViewportSize(VIEWPORTS[1440]);
  await modelList.getByPlaceholder('Type to filter…').press('Escape');
  await expect(modelList.getByPlaceholder('Type to filter…')).toHaveCount(0);
  await expect(dialog.locator('[data-pull-risk-rules-text]')).toHaveValue(RULES);
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

  expect(prompts()).toEqual([]);
  await dialog.locator('[data-pull-risk-save]').click();
  await expect(dialog).toHaveCount(0);
});

test('the rows: all three levels; an answer that makes no sense and a refused diff say so, with no level; how the agent ran', async () => {
  await expect(row(501).locator('[data-pull-risk="high"]')).toBeVisible({ timeout: 30_000 });
  await expect(row(502).locator('[data-pull-risk="medium"]')).toBeVisible({ timeout: 30_000 });
  await expect(row(503).locator('[data-pull-risk="low"]')).toBeVisible({ timeout: 30_000 });
  await expect(row(506).locator('[data-pull-risk="high"]')).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => prompts().length).toBe(8);
  await expect(row(504).locator('[data-pull-risk="failed"]')).toBeVisible({ timeout: 30_000 });
  await expect(row(504).locator('[data-pull-risk="failed"]')).toContainText('I would say this looks fine to me.');

  const paged = prompts().find((l) => l.prompt!.includes('Title: Fix a typo in the README'))!.prompt!;
  expect(paged).toContain('+the paged page one');
  expect(paged).toContain('+the paged page two');

  const big = prompts().find((l) => l.prompt!.includes('Title: Regenerate the API client'))!.prompt!;
  expect(big.match(/export const line = 1;/g)).toHaveLength(BIG_LINES);
  const refused = row(507).locator('[data-pull-risk]');
  await expect(refused).toHaveAttribute('data-pull-risk', 'failed', { timeout: 30_000 });
  await expect(refused).toContainText('Couldn\u2019t rank');
  await refused.hover();
  await expect(page.locator('[data-pn-tooltip]')).toContainText(REFUSAL);
  await page.mouse.move(0, 0);
  await shots('rows-refused');

  const judged = piLog().filter((l) => l.argv?.includes('--no-tools'));
  expect(judged).toHaveLength(8);
  expect(judged.every((l) => l.argv!.join(' ').length < 2_000)).toBe(true);
  expect(judged[0]!.argv!.join(' ')).toContain('--no-tools --no-session --no-extensions --no-skills --no-context-files --provider anthropic --model claude-sonnet-5 --thinking low');
  const asked = prompts().find((l) => l.prompt!.includes('Title: Retry failed charges'))!.prompt!;
  expect(asked).toContain('Anything in billing or charges.');
  expect(asked).toContain('+new');
  await row(501).locator('[data-pull-risk]').hover();
  await expect(page.locator('[data-pn-tooltip]')).toContainText('It changes the charge retry schedule');
  await page.mouse.move(0, 0);
  await shots('rows');
  expect(readFileSync(join(dataDir, 'config.json'), 'utf8')).toContain('Anything in billing');
  expect(readFileSync(join(dataDir, 'inbox', 'pull-risk.json'), 'utf8')).not.toContain('Anything in billing');
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
  await page.keyboard.press('Escape');
  await pick('high');
  await expect(page.locator('[data-pulls-risk-menu]')).toHaveCount(0);
  expect(await page.locator('[data-pulls-risk-chip]').evaluate((el) => el.matches(':focus-visible'))).toBe(false);
  await expect(row(501)).toBeVisible();
  await expect(row(506)).toBeVisible();
  await expect(row(502)).toHaveCount(0);
  await expect(row(503)).toHaveCount(0);
  for (const n of [504, 507, 508]) await expect(row(n)).toHaveCount(0);
  const notRanked = page.locator('[data-pulls-risk-not-ranked-toggle]');
  await expect(notRanked).toHaveText('3 not ranked');
  await expect(page.locator('[data-pulls-risk-not-judged]')).toHaveCount(0);
  await page.mouse.move(0, 0);
  await shots('filter-high');
  await notRanked.click();
  for (const n of [504, 507, 508]) await expect(page.locator(`[data-pulls-risk-not-ranked] [data-pulls-row="${keyOf(n)}"]`)).toBeVisible();
  await expect(row(504).locator('[data-pull-risk="failed"]')).toBeVisible();
  await expect(row(508).locator('[data-pull-risk]')).toHaveCount(0);
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
  const failed = (l: { prompt?: string }) => ['Upgrade the linter', 'Regenerate the API client', STILL_RANKING].some((title) => l.prompt!.includes(`Title: ${title}`));
  const before = prompts().filter((l) => !failed(l)).length;
  await start();
  context = await page.context().browser()!.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  page = await context.newPage();
  await openPulls();
  await expect(row(501).locator('[data-pull-risk="high"]')).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1_000);
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
