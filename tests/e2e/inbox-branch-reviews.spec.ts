/**
 * Branch reviews (config.json `inboxBranchReviews`, with Code review), in a real browser against the compiled binary.
 * Nothing is mocked: the binary runs `plannotator inbox --background` under a temp PLANNOTATOR_DATA_DIR, a simulated
 * agent writes through `plannotator inbox mcp` (scripts/inbox-sim.ts), and Chromium drives the window. HOME is the
 * scratch folder, and the sandbox env keeps the binary off the person's agents: its PATH is a fake `gh` (signed out)
 * and the system's own folders, so no agent CLI (and no stub of one) can be found, the risk dialog's included.
 *
 * What is proved, in order:
 *  1. Off: send_message refuses `branch`, and the branches route refuses.
 *  2. On: an agent's report is one review thread, listed in Reviews as a local branch, On you; the thread says what
 *     it is and offers the person's own "Ask for a guided review".
 *  3. The same head again sends nothing; a new head goes into the same thread.
 *  4. The ask is a reply in that thread carrying /review-curate.
 *  5. Reviews' "On this computer" leaves the reported branch to its row and lists the other; that branch's diff opens
 *     beside the list and its Review with an agent opens New review.
 *  6. The risk rules dialog shows the branch switch with what is sent where.
 *
 * Shots land in PLANNOTATOR_E2E_PROOF_DIR/branch-reviews, light and dark at 1440.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { E2E_GROUP_TIP_SEEN, inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'branch-reviews');

interface World {
  dataDir: string;
  url: string;
  project: string;
  git: (...args: string[]) => string;
  claude: SimAgent;
  /** A new agent connection: one made after the switch lists the tools as they are then, as a real agent would. */
  connect: () => Promise<SimAgent>;
  context: BrowserContext;
  page: Page;
}

let world: World;
let threadId = '';

function billingProject(parent: string) {
  const project = scratchProject(parent, 'billing');
  const git = (...args: string[]) => {
    const run = spawnSync('git', args, { cwd: project, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } });
    if (run.status !== 0) throw new Error(run.stderr);
    return run.stdout.trim();
  };
  const commit = (file: string, text: string) => {
    mkdirSync(join(project, file, '..'), { recursive: true });
    writeFileSync(join(project, file), text);
    git('add', '-A');
    git('commit', '-q', '-m', file);
  };
  commit('src/retry.ts', 'export const retries = 5;\n');
  git('branch', '-M', 'main');
  git('checkout', '-q', '-b', 'retry-jitter');
  commit('src/retry.ts', 'export const retries = 3;\nexport const jitterMs = 250;\n');
  git('checkout', '-q', 'main');
  git('checkout', '-q', '-b', 'old-idea');
  commit('src/idea.ts', 'export const idea = true;\n');
  git('checkout', '-q', 'retry-jitter');
  return { project, git, commit };
}

async function shot(page: Page, name: string): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(350);
    await page.screenshot({ path: join(proofDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

function setBranchReviews(on: boolean): void {
  const file = join(world.dataDir, 'config.json');
  const config = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  writeFileSync(file, JSON.stringify({ ...config, inboxBranchReviews: on }));
}

let commitMore: (file: string, text: string) => void = () => {};

test.describe.configure({ mode: 'serial' });
test.use({ actionTimeout: 20_000 });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-branch-reviews-e2e-');
  const dataDir = join(root, 'data');
  markTourDecided(dataDir);
  const configFile = join(dataDir, 'config.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, unknown>;
  writeFileSync(configFile, JSON.stringify({ ...config, inboxCodeReview: true, inboxReveals: { ...E2E_GROUP_TIP_SEEN, code_review: { shownAt: '2026-10-24T00:00:00.000Z' } } }));
  for (const dir of ['claude', 'codex', 'xdg', 'fakes']) mkdirSync(join(root, dir), { recursive: true });
  const fakes = join(root, 'fakes');
  // Signed out: no forge is ever asked, and Reviews lists no PRs.
  writeFileSync(join(fakes, 'gh'), '#!/bin/sh\necho "You are not logged into any GitHub hosts." >&2\nexit 1\n');
  chmodSync(join(fakes, 'gh'), 0o755);
  const env: Record<string, string> = {
    // A fake gh and the system's own folders only: no agent CLI can be found.
    PATH: `${fakes}:/usr/bin:/bin`,
    HOME: root,
    PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_ANON_PING: '1',
    PLANNOTATOR_INBOX_NOTES: '0',
    PLANNOTATOR_TEST_SANDBOX: '1',
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    CODEX_HOME: join(root, 'codex'),
    XDG_CONFIG_HOME: join(root, 'xdg'),
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  const { project, git, commit } = billingProject(join(root, 'src'));
  commitMore = commit;
  const connect = () => SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  world = { dataDir, url: started.stdout.trim(), project, git, claude: await connect(), connect, context, page };
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

const report = (body: string) => world.claude.send({ project_path: world.project, subject: 'retry-jitter', body, branch: { name: 'retry-jitter', summary: 'Jitter on payout retries' } } as never);

test('off: the field is refused and the branches route refuses', async () => {
  await expect(report('retry-jitter is ready for review.')).rejects.toThrow();
  const refused = await world.page.request.get(`${world.url}api/inbox/reviews/branches`);
  expect(refused.status()).toBe(409);
});

test('on: a report is one review thread, a local branch On you, with the person\'s own ask', async () => {
  setBranchReviews(true);
  // The agent connects after the switch (an agent host may keep the tool list it was first given).
  await world.claude.close().catch(() => {});
  world.claude = await world.connect();
  const sent = await report('retry-jitter is ready for review: retries back off with jitter.');
  threadId = String(sent.thread_id);
  const { page } = world;
  await page.goto(`${world.url}#reviews`);
  const row = page.locator(`[data-reviews-row="${threadId}"]`);
  await expect(row).toBeVisible();
  // Closed, the row is one line; open, its second line says where the branch is, its project and why it waits.
  await expect(row.locator('.ib-pr-l3')).toHaveCount(0);
  await expect(page.locator('[data-pulls-group="on_you"]')).toContainText('retry-jitter');
  await shot(page, '1-reported-row');
  await row.click();
  await expect(row.locator('.ib-pr-l3')).toHaveText(/^retry-jitter · .+ · (?:.+, )?Ready for review$/); // the agent's name, for a screen reader, before the status
  await expect(page.locator('.ib-rvctx')).toContainText('Local branch: retry-jitter, against main');
  await expect(page.locator('[data-review-branch-ask]')).toBeVisible();
  await shot(page, '2-reported-thread');
});

test('the same head sends nothing; a new head goes into the same thread', async () => {
  const again = await report('retry-jitter is ready for review.');
  expect(again).toMatchObject({ thread_id: threadId, reported: false });
  expect(((await world.claude.readThread(threadId)).messages as unknown[]).length).toBe(1);
  commitMore('src/retry.ts', 'export const retries = 3;\nexport const jitterMs = 400;\n');
  const update = await report('Raised the jitter after the load test.');
  expect(update.thread_id).toBe(threadId);
  expect(((await world.claude.readThread(threadId)).messages as unknown[]).length).toBe(2);
});

test('the ask is a reply in the same thread, asking for /review-curate', async () => {
  const { page } = world;
  await page.goto(`${world.url}#reviews`);
  await page.locator(`[data-reviews-row="${threadId}"]`).click();
  await page.locator('[data-review-branch-ask]').click();
  await expect(page.locator('[data-review-branch-asked]')).toBeVisible();
  const reply = await world.claude.nextReply(threadId);
  expect(String(reply.body)).toContain('Please send me a guided review of the whole branch');
  expect(String(reply.body)).toContain('/review-curate');
});

test('"On this computer" leaves the reported branch to its row; another branch\'s diff offers New review', async () => {
  const { page } = world;
  const projects = (await (await page.request.get(`${world.url}api/inbox/projects`)).json()) as { projects?: { id: string; root: string }[] };
  const id = projects.projects?.find((p) => p.root === world.project)?.id;
  expect(id).toBeTruthy();
  await page.goto(`${world.url}#reviews`);
  const group = page.locator('[data-pulls-group="local"]');
  await expect(group).toBeVisible();
  await group.locator('[data-reviews-fold="local"]').click();
  const idea = group.locator(`[data-local-row="${id}:old-idea"]`);
  await expect(idea).toBeVisible();
  // The reported branch is the report's row, never listed here.
  await expect(group.locator(`[data-local-row="${id}:retry-jitter"]`)).toHaveCount(0);
  await shot(page, '3-on-this-computer');
  await idea.click();
  await expect(page.locator('[data-local-diff="branch"]')).toBeVisible();
  await page.locator('[data-local-review]').click();
  await expect(page.locator('[data-review-box]')).toBeVisible();
  await page.keyboard.press('Escape');
});

test('the risk rules dialog shows the branch switch and says what is sent where', async () => {
  const { page } = world;
  await page.goto(`${world.url}#reviews`);
  await page.locator('[data-pulls-risk-chip]').click();
  await page.locator('[data-pulls-risk-rules]').click();
  const dialog = page.locator('[data-dialog="pull-risk-rules"]');
  await expect(dialog.locator('[data-pull-risk-branches] input')).not.toBeChecked();
  await expect(dialog.locator('[data-pull-risk-branches-words]')).toContainText('once per commit, and only when that commit is on this computer');
  await shot(page, '4-risk-switch');
});
