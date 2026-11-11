/**
 * A thread's PR marker over a forge that never answers, in a real browser
 * against the compiled binary (a reporter on 0.28.60, a self-hosted Inbox
 * reached over plain HTTP, threads linked to GitLab merge requests).
 *
 * The fake `glab` first on PATH catches TERM and never ends, the way a
 * `glab api graphql` stuck on an unreachable host ran for over an hour; `gh`
 * is a fake that is signed out. Nothing reaches a forge.
 *
 * What it proves:
 *  - Hovering the row marker again and again never leaves the card on
 *    "Loading…": it shows what the Inbox knows at once.
 *  - After those hovers every ordinary thread still opens. Before the fix each
 *    hover left a request the server never answered and the window never
 *    aborted; with the event stream that filled Chromium's six connections to
 *    the Inbox, and the next thread's read queued in the browser for good.
 *  - A thread with a linked MR opens too, with the forge still unreachable.
 *  - The stuck glab is ended at its deadline: none is left running.
 *
 * Build the binary first (see inbox.spec.ts). PLANNOTATOR_E2E_BINARY names
 * another binary (an older release, to see the bug). What each step saw lands
 * in PLANNOTATOR_E2E_PROOF_DIR/pull-marker-hang (default .local/proof).
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'pull-marker-hang');

const MR_A = 'https://gitlab.com/acme/widgets/-/merge_requests/7';
const MR_B = 'https://gitlab.com/acme/widgets/-/merge_requests/8';

interface World {
  root: string;
  url: string;
  glabLog: string;
  mrThreads: string[];
  plainThreads: string[];
  claude: SimAgent;
}

let world: World;

/** The pids the fake glab wrote, still running (by the process table, never a guess). */
function liveGlabs(log: string): number[] {
  if (!existsSync(log)) return [];
  const pids = readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => Number(line.split(' ')[0]));
  return pids.filter((pid) => {
    const ps = spawnSync('/bin/ps', ['-o', 'stat=,command=', '-p', String(pid)], { encoding: 'utf8' });
    const line = ps.stdout.trim();
    return line !== '' && !line.startsWith('Z') && line.includes('sleep 600');
  });
}

test.beforeAll(async () => {
  test.setTimeout(180_000);
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-pull-marker-hang-');
  const dataDir = join(root, 'data');
  markTourDecided(dataDir);
  for (const dir of ['claude', 'codex', 'xdg']) mkdirSync(join(root, dir), { recursive: true });
  const stubs = join(root, 'stubs');
  mkdirSync(stubs, { recursive: true });
  const glabLog = join(root, 'glab.log');
  // glab: catches TERM and never ends (current glab turns TERM into a cancel its request may not heed).
  writeFileSync(join(stubs, 'glab'), `#!/bin/sh\necho "$$ $*" >> '${glabLog}'\ntrap '' TERM\nexec /bin/sleep 600\n`);
  writeFileSync(join(stubs, 'gh'), `#!/bin/sh\necho 'You are not logged into any GitHub hosts.' >&2\nexit 1\n`);
  for (const name of ['glab', 'gh', 'open', 'xdg-open']) {
    if (!existsSync(join(stubs, name))) writeFileSync(join(stubs, name), '#!/bin/sh\nexit 0\n');
    chmodSync(join(stubs, name), 0o755);
  }
  const env: Record<string, string> = {
    PATH: `${stubs}:${process.env.PATH ?? ''}`,
    HOME: root,
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
  const url = started.stdout.trim();
  // Never the person's own Inbox.
  expect(url).not.toContain(':49606');
  expect(url).not.toContain(':59812');
  const project = scratchProject(join(root, 'src'), 'widgets');
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const plainThreads: string[] = [];
  for (let i = 1; i <= 6; i++) {
    const sent = await claude.send({ project_path: project, thread: `plain ${i}`, subject: `Plain thread ${i}`, body: `Ordinary thread number ${i}.` });
    plainThreads.push(sent.thread_id as string);
  }
  const mrThreads: string[] = [];
  for (const [i, mr] of [MR_A, MR_B].entries()) {
    const sent = await claude.send({ project_path: project, thread: `mr ${i}`, subject: `Merge request thread ${i + 1}`, body: 'The MR is up.', pulls: [mr] } as never);
    mrThreads.push(sent.thread_id as string);
  }
  world = { root, url, glabLog, mrThreads, plainThreads, claude };
});

test.afterAll(async () => {
  try {
    await world?.claude.close();
  } finally {
    // A stuck glab from an Inbox before the fix ignores TERM: only the ones our fake wrote, and only while still that fake.
    // inbox-guard: own child (the fake glab this test wrote, never an Inbox)
    if (world) for (const pid of liveGlabs(world.glabLog)) process.kill(pid, 'SIGKILL');
    await removeInboxScratch();
  }
});

/** Requests the page started and that have not finished, by path. */
function watchRequests(page: Page) {
  const open = new Map<object, { path: string; at: number }>();
  page.on('request', (req) => open.set(req, { path: new URL(req.url()).pathname, at: Date.now() }));
  page.on('requestfinished', (req) => open.delete(req));
  page.on('requestfailed', (req) => open.delete(req));
  return () => [...open.values()].map((r) => `${r.path} (${Math.round((Date.now() - r.at) / 1000)} s)`).filter((p) => !p.endsWith('/events (0 s)'));
}

async function hoverMark(page: Page, threadId: string) {
  try {
    await page.locator(`.ib-lbody [data-thread-id="${threadId}"] [data-pr-mark]`).first().hover({ timeout: 10_000 });
  } catch {
    return '(no marker to hover)';
  }
  await page.waitForTimeout(700);
  const card = page.locator('[data-pr-popover]');
  const shown = (await card.count()) > 0 ? ((await card.first().textContent({ timeout: 2_000 }).catch(() => '')) ?? '') : '';
  await page.mouse.move(5, 5);
  await page.waitForTimeout(400);
  return shown;
}

/** Open a thread from its row; how long until its subject shows, or null past `capMs`. */
async function openThread(page: Page, threadId: string, subject: string, capMs: number): Promise<number | null> {
  const started = Date.now();
  try {
    await page.locator(`.ib-lbody [data-thread-id="${threadId}"]`).first().click({ timeout: capMs });
    await expect(page.locator('section.ib-pane').getByRole('heading', { name: subject })).toBeVisible({ timeout: capMs });
    return Date.now() - started;
  } catch {
    return null;
  }
}

test('hovering PR markers over a stuck forge never stalls the window, and the stuck glab is ended', async ({ browser }: { browser: Browser }) => {
  test.setTimeout(300_000);
  const page = await (await browser.newContext()).newPage();
  const pending = watchRequests(page);
  const seen: Record<string, unknown> = { binary };
  const name = binary.split('/').at(-1);
  // Written after every step, so a run that stalls still says how far it got.
  const save = () => writeFileSync(join(proofDir, `seen-${name}.json`), `${JSON.stringify(seen, null, 2)}\n`);
  await page.goto(world.url);
  await expect(page.locator(`.ib-lbody [data-thread-id="${world.mrThreads[0]}"] [data-pr-mark]`).first()).toBeVisible();

  // Hover the markers again and again (no click), as the reporter did.
  const cards: string[] = [];
  for (let round = 0; round < 3; round++) for (const id of world.mrThreads) cards.push(await hoverMark(page, id));
  seen.cards = cards;
  seen.pendingAfterHovers = pending();
  save();

  // Then open ordinary threads: each must open.
  const opens: (number | null)[] = [];
  for (const [i, id] of world.plainThreads.slice(0, 4).entries()) {
    opens.push(await openThread(page, id, `Plain thread ${i + 1}`, 10_000));
    seen.openMs = opens;
    save();
  }
  seen.pendingAfterOpens = pending();
  // A thread with a linked MR opens too, the forge still unreachable.
  seen.mrOpenMs = await openThread(page, world.mrThreads[0]!, 'Merge request thread 1', 10_000);
  save();
  // A reload (onto that MR thread), two more hovers, and another ordinary thread.
  await page.reload({ timeout: 20_000 }).catch(() => (seen.reload = 'did not finish in 20 s'));
  seen.listAfterReload = await page
    .locator(`.ib-lbody [data-thread-id="${world.mrThreads[1]}"] [data-pr-mark]`)
    .first()
    .waitFor({ timeout: 15_000 })
    .then(() => 'shown', () => 'not shown in 15 s');
  seen.pendingAfterReload = pending();
  save();
  for (const id of world.mrThreads) cards.push(await hoverMark(page, id));
  seen.afterReloadOpenMs = await openThread(page, world.plainThreads[4]!, 'Plain thread 5', 10_000);
  seen.pendingAfterReloadOpen = pending();
  save();
  // Past the CLI deadline (8 s) and its kill grace: no stuck glab is left.
  await page.waitForTimeout(10_000);
  seen.glabStarted = existsSync(world.glabLog) ? readFileSync(world.glabLog, 'utf8').trim().split('\n').length : 0;
  seen.glabStillRunning = liveGlabs(world.glabLog).length;
  seen.pendingAtEnd = pending();
  save();
  await page.screenshot({ path: join(proofDir, `end-${name}.png`) });

  for (const text of cards) expect(text).not.toContain('Loading');
  expect(opens.every((ms) => ms !== null)).toBe(true);
  expect(seen.mrOpenMs).not.toBeNull();
  expect(seen.afterReloadOpenMs).not.toBeNull();
  expect(seen.glabStarted as number).toBeGreaterThan(0);
  expect(seen.glabStillRunning).toBe(0);
  await page.context().close();
});
