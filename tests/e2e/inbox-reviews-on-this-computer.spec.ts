/**
 * Reviews' "On this computer" (approval "inbox-reviews-compact-list", part 2), in a real browser against the compiled
 * binary: this computer's work in no pull request sits in a folded group at the foot of the Reviews list, for every
 * project, and a click opens its diff beside the list with no agent involved.
 *
 * What regresses if these fail:
 *  1. The group missing at the foot of the list, open at first, or its count wrong (01).
 *  2. Open, a row missing or wrong: each branch with work of its own and its project and age, the folder's
 *     "Uncommitted on main"; the default branch or a branch with nothing of its own listed (02).
 *  3. A branch row's click not opening that branch's whole diff, read by ref (the folder stays on main, its changes
 *     untouched), or sending anything anywhere (03).
 *  4. The Uncommitted row not opening the folder's own changes, new files too (04); Close not returning to the list
 *     with the group still open.
 *  5. The diff cramped: drawn as a guided review's chapter card (its "Every changed file" column beside a narrow
 *     diff) instead of the files across the pane's width, as the PR page draws them; a code line cut off (03, 04).
 *  6. On a phone (390 wide), the group open, and a row's diff in the list's place at the screen's width (05, 06).
 *  6b. On a phone, a row shorter than 44px, at 390 and 320 (05b); a branch row's name not drawn (no width), its icon
 *     off the rows' left edge, or a screen reader not hearing the whole branch (05, 05b).
 *  6c. On a phone, a 60-letter branch in a long-named project: the name under 120px, or the project not giving way
 *     first (05c).
 *  6d. What Branch reviews' "Branches nobody reported" said, lost: a branch's commits not on main (on the row where
 *     the list has room beside a readable name, always to a screen reader, and in its diff's facts; 09, 11), the
 *     rows past the fifth with no way to see them ("N more", the Agents view's fold; 10), or "nothing here" for a list
 *     filtered to one project (its words; 12).
 *  7. On a phone, a long branch name in a long-named project cut to a few letters by the bar's buttons, or anything
 *     in the bar or the facts under it overlapping, at 390 and 320; Review with an agent a bare "+" (07, 08).
 *
 * Shots land in PLANNOTATOR_E2E_PROOF_DIR/reviews-on-this-computer, light and dark at 1440, and at 390 on a phone. HOME is a scratch folder,
 * and the sandbox env keeps the binary off the person's agents. Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-reviews-on-this-computer.spec.ts`.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { E2E_GROUP_TIP_SEEN, inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'reviews-on-this-computer');

const MINUTE = 60;
const BRANCH = 'fix/guide-global-comment-keep-words';

/** A project folder with main, and git run in it at a given time (seconds before now). */
function gitProject(parent: string, name: string) {
  const path = scratchProject(parent, name);
  const git = (args: string[], secondsAgo = 3 * 86_400) => {
    const date = `@${Math.floor(Date.now() / 1000) - secondsAgo} +0000`;
    const run = spawnSync('git', args, { cwd: path, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Charlie Dunn', GIT_AUTHOR_EMAIL: 'charlie@example.com', GIT_COMMITTER_NAME: 'Charlie Dunn', GIT_COMMITTER_EMAIL: 'charlie@example.com', GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
    if (run.status !== 0) throw new Error(run.stderr);
    return run.stdout.trim();
  };
  const commit = (file: string, text: string, secondsAgo?: number) => {
    mkdirSync(join(path, file, '..'), { recursive: true });
    writeFileSync(join(path, file), text);
    git(['add', '-A'], secondsAgo);
    git(['commit', '-q', '-m', file], secondsAgo);
  };
  commit('src/comments.ts', 'export const keep = false;\n', 20 * 86_400);
  git(['branch', '-M', 'main']);
  return { path, git, commit };
}

interface World {
  browser: Browser;
  url: string;
  /** The Inbox's MCP door, and the folder the projects are made in. */
  mcp: string;
  src: string;
  plannotator: string;
  plannotatorId: string;
  git: (args: string[]) => string;
  context: BrowserContext;
  page: Page;
}

let world: World;

test.use({ actionTimeout: 20_000 });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  // Never emptied here: after a failure the next test's worker starts a new world, and the shots already taken stay.
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-reviews-local-');
  const dataDir = join(root, 'data');
  markTourDecided(dataDir);
  const configFile = join(dataDir, 'config.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, unknown>;
  writeFileSync(configFile, JSON.stringify({ ...config, inboxCodeReview: true, inboxReveals: { ...E2E_GROUP_TIP_SEEN, code_review: { shownAt: '2026-10-24T00:00:00.000Z' } } }));
  // Signed out: no forge is asked and Reviews lists no PRs. Nothing else here may reach glab or tailscale.
  const fakes = join(root, 'fakes');
  mkdirSync(fakes);
  writeFileSync(join(fakes, 'gh'), '#!/bin/sh\necho "You are not logged into any GitHub hosts." >&2\nexit 1\n');
  for (const name of ['glab', 'tailscale']) writeFileSync(join(fakes, name), `#!/bin/sh\necho "reviews-local: ${name} must not run" >&2\nexit 97\n`);
  for (const name of ['gh', 'glab', 'tailscale']) chmodSync(join(fakes, name), 0o755);
  for (const dir of ['claude', 'codex', 'xdg', 'opencode', 'home']) mkdirSync(join(root, dir), { recursive: true });
  const env: Record<string, string> = {
    PATH: `${fakes}:/usr/bin:/bin`,
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

  // plannotator: Ada's branch with work of its own (not checked out), a branch with nothing of its own, and changes
  // on main in the folder, one of them a new file. spaces-site: Bob's branch.
  const src = join(root, 'src');
  const plannotator = gitProject(src, 'plannotator');
  plannotator.git(['checkout', '-q', '-b', BRANCH]);
  plannotator.commit('src/comments.ts', 'export const keep = true;\nexport const words = "kept";\n', 12 * MINUTE);
  plannotator.git(['checkout', '-q', 'main']);
  plannotator.git(['branch', 'same-as-main']);
  writeFileSync(join(plannotator.path, 'src/comments.ts'), 'export const keep = false;\nexport const draft = "Ada Novak";\n');
  writeFileSync(join(plannotator.path, 'NOTES.md'), '# Notes\n\nBob Tully asked for this.\n');
  const spaces = gitProject(src, 'spaces-site');
  spaces.git(['checkout', '-q', '-b', 'feat/spaces-share-link']);
  spaces.commit('share.ts', 'export const share = true;\n', 2 * 3600);
  spaces.git(['checkout', '-q', 'main']);

  // Both folders are Inbox projects: an agent wrote from each. One review thread, so the list has a row above the group.
  const registry = JSON.parse(readFileSync(join(dataDir, 'inbox', 'inbox.json'), 'utf8')) as { port: number };
  const client = new Client({ name: 'reviews-local', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${registry.port}/mcp`)));
  const patch = 'diff --git a/src/comments.ts b/src/comments.ts\n--- a/src/comments.ts\n+++ b/src/comments.ts\n@@ -1 +1 @@\n-export const keep = false;\n+export const keep = true;\n';
  const guide = { title: 'Keep a global comment', intent: 'A failed add keeps the words.', sections: [{ title: 'The keep', overview: 'One line.', diffs: [{ file: 'src/comments.ts', summary: 'Keep.' }] }], review: { gitRef: 'main...HEAD', base: 'main' }, generator: { engine: 'claude-code', model: 'claude-opus-5' } };
  const sent = (await client.callTool({ name: 'submit_guide', arguments: { project_path: plannotator.path, guide, patch, review: true, subject: 'Keep a global comment', body: 'Ready for review.', agent_session: 'ses-local', agent_host: 'claude-code', agent_name: 'Claude Code' } })) as { isError?: boolean; content?: { text: string }[] };
  if (sent.isError) throw new Error(sent.content?.map((c) => c.text).join(' '));
  const note = (await client.callTool({ name: 'send_message', arguments: { project_path: spaces.path, subject: 'Share links', body: 'Started on share links.', agent_host: 'claude-code', agent_name: 'Claude Code' } })) as { isError?: boolean; content?: { text: string }[] };
  if (note.isError) throw new Error(note.content?.map((c) => c.text).join(' '));
  await client.close().catch(() => {});

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: 'light', reducedMotion: 'reduce' });
  const page = await context.newPage();
  const projects = (await (await page.request.get(`${url}api/inbox/projects`)).json()) as { projects?: { id: string; root: string }[] };
  const plannotatorId = projects.projects?.find((p) => p.root === plannotator.path)?.id ?? '';
  expect(plannotatorId).toBeTruthy();
  world = { browser, url, mcp: `http://127.0.0.1:${registry.port}/mcp`, src, plannotator: plannotator.path, plannotatorId, git: (args) => plannotator.git(args), context, page };
});

test.afterAll(async () => {
  try {
    if (!world) return;
    await world.context.close();
  } finally {
    await removeInboxScratch();
  }
});

async function shot(page: Page, name: string): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(proofDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
}

/**
 * The diff is readable, measured by boxes (the viewer draws its lines in a shadow root, `diffs-container`): its file
 * takes most of the pane's width (no chapter column beside it), the changed line's row lies inside the file, and the
 * code's scroller (`[data-code]`; a split diff's side, or `[data-content]` where `[data-code]` is `display: contents`)
 * is not a cramped column. A split diff's side is about half the file, so the floor is `minCode` and 40% of the file.
 */
async function readableDiff(pane: ReturnType<Page['locator']>, file: string, line: string, minCode: number): Promise<void> {
  const paneBox = (await pane.boundingBox())!;
  const shellBox = (await pane.locator(`[data-guide-file-shell="${file}"]`).boundingBox())!;
  expect(shellBox.width).toBeGreaterThan(paneBox.width * 0.85);
  await expect(pane.locator('[data-guide-section-narrative]')).toBeHidden();
  const changed = changedRow(pane, file, line);
  await expect(changed).toBeVisible();
  const box = await changed.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    let code = el.closest('[data-code]');
    if (code && getComputedStyle(code).display === 'contents') code = el.closest('[data-content]');
    return { left: rect.left, right: rect.right, width: rect.width, code: code?.clientWidth ?? 0 };
  });
  expect(box.width).toBeGreaterThan(0);
  expect(box.left).toBeGreaterThanOrEqual(shellBox.x - 1);
  expect(box.right).toBeLessThanOrEqual(shellBox.x + shellBox.width + 1);
  expect(box.code).toBeGreaterThanOrEqual(Math.max(minCode, shellBox.width * 0.4));
}

/** The file's second line, added (the viewer's own row, `data-line="2"`), holding `line`. */
const changedRow = (pane: ReturnType<Page['locator']>, file: string, line: string) =>
  pane.locator(`[data-guide-file-shell="${file}"] [data-line="2"][data-line-type="change-addition"]`).filter({ hasText: line }).first();

const group = (page: Page) => page.locator('[data-pulls-group="local"]');
const row = (page: Page, key: string) => group(page).locator(`[data-local-row="${key}"]`);

/**
 * A phone's group reads from the row's edge: every row's icon on one left edge (the screen's padding, as the rows
 * above), and each branch row's name drawn with its text, at least 120px wide, after its icon. A screen reader hears
 * the whole branch. Once a column centred each line and a cut name had no width at all (only the icon, project and
 * age showed, in the middle of the row).
 */
async function phoneRowsReadable(page: Page, branches: readonly string[], width: number): Promise<void> {
  const rows = await group(page).evaluate((root) =>
    [...root.querySelectorAll<HTMLElement>('[data-local-row]')].map((el) => {
      const mark = el.querySelector('.ib-rvr-mark')!.getBoundingClientRect();
      const name = el.querySelector<HTMLElement>('.ib-rvr-t')!;
      const shown = name.querySelector<HTMLElement>('.ib-rvr-tin') ?? name;
      const box = name.getBoundingClientRect();
      const parts = [...shown.querySelectorAll<HTMLElement>('.ib-rvr-th, .ib-rvr-tt')].map((part) => part.getBoundingClientRect().width);
      return { kind: el.dataset.localKind, row: el.getBoundingClientRect().left, markLeft: mark.left, markRight: mark.right, nameLeft: box.left, nameWidth: box.width, shownWidth: shown.getBoundingClientRect().width, text: shown.textContent ?? '', parts };
    }),
  );
  const lefts = rows.map((r) => r.markLeft);
  expect(Math.max(...lefts) - Math.min(...lefts), `icons' left edges at ${width}: ${lefts.join(', ')}`).toBeLessThanOrEqual(2);
  // On the row's left, inside its padding (not floated to its middle).
  for (const r of rows) expect(r.markLeft - r.row, `icon at ${width}`).toBeLessThanOrEqual(20);
  const branchRows = rows.filter((r) => r.kind === 'branch');
  expect(branchRows.length).toBe(branches.length);
  for (const r of branchRows) {
    expect(r.text.trim().length, `name text at ${width}`).toBeGreaterThan(0);
    expect(r.nameWidth, `name "${r.text}" at ${width}`).toBeGreaterThanOrEqual(120);
    expect(r.shownWidth, `drawn name "${r.text}" at ${width}`).toBeGreaterThanOrEqual(120);
    for (const part of r.parts) expect(part, `a cut name's parts at ${width}`).toBeGreaterThan(0);
    expect(r.nameLeft, `name after its icon at ${width}`).toBeGreaterThanOrEqual(r.markRight);
  }
  for (const branch of branches) {
    const escaped = branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    await expect(group(page).locator(`[data-local-row$=":${branch}"]`)).toHaveAccessibleName(new RegExp(escaped));
  }
}

// Desktop and phone are apart: a failure in one never skips the other's shots. Each shot is taken before its checks.
test.describe('desktop at 1440', () => {
  test.describe.configure({ mode: 'serial' });

  test('the group sits folded at the foot of the list, with its count', async () => {
    const { page } = world;
    await page.goto(`${world.url}#reviews`);
    await expect(page.locator('[data-reviews-row]').first()).toBeVisible();
    const toggle = group(page).locator('[data-reviews-fold="local"]');
    await expect(toggle).toBeVisible();
    await shot(page, '01-group-folded');
    await expect(toggle).toHaveText('On this computer 3');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(group(page).locator('[data-local-row]')).toHaveCount(0);
    // The last group of the list.
    expect(await page.locator('.ib-lbody [role="group"]').last().getAttribute('data-pulls-group')).toBe('local');
  });

  test('open, each row is one line: its work, its project, its age', async () => {
    const { page } = world;
    await group(page).locator('[data-reviews-fold="local"]').click();
    const rows = group(page).locator('[data-local-row]');
    await expect(rows).toHaveCount(3);
    await shot(page, '02-group-open');
    await expect(rows.nth(0)).toContainText('Uncommitted on main');
    await expect(rows.nth(0)).toContainText('plannotator');
    await expect(rows.nth(1)).toContainText(BRANCH);
    await expect(rows.nth(1)).toContainText('12m');
    await expect(rows.nth(2)).toContainText('feat/spaces-share-link');
    await expect(rows.nth(2)).toContainText('spaces-site');
    await expect(rows.nth(2)).toContainText('2h');
    await expect(group(page).locator('[data-local-row$=":same-as-main"], [data-local-row$=":main"]')).toHaveCount(0);
    // One line each.
    for (let i = 0; i < 3; i++) expect((await rows.nth(i).boundingBox())!.height).toBeLessThan(46);
  });

  test("a branch row opens that branch's whole diff beside the list; nothing is sent, the folder is untouched", async () => {
    const { page } = world;
    const writes: string[] = [];
    const watch = (request: { method: () => string; url: () => string }) => {
      if (request.method() !== 'GET') writes.push(`${request.method()} ${request.url()}`);
    };
    page.on('request', watch);
    const status = world.git(['status', '--porcelain']);
    await row(page, `${world.plannotatorId}:${BRANCH}`).click();
    const pane = page.locator('[data-local-diff="branch"]');
    await expect(pane.locator('[data-guide-file-shell="src/comments.ts"]')).toBeVisible({ timeout: 30_000 });
    await expect(changedRow(pane, 'src/comments.ts', 'export const words = "kept";')).toBeVisible();
    await shot(page, '03-branch-diff');
    await expect(pane.locator('[data-local-title]')).toHaveText(BRANCH);
    // Its facts: its commits not on main, in Branch reviews' words.
    await expect(pane.locator('[data-local-facts]')).toContainText('1 commit not on main');
    // The branch's work only: the folder's own changes are not in it.
    await expect(pane.locator('[data-guide-file-shell="NOTES.md"]')).toHaveCount(0);
    await expect(row(page, `${world.plannotatorId}:${BRANCH}`)).toHaveAttribute('aria-current', 'true');
    await readableDiff(pane, 'src/comments.ts', 'export const words = "kept";', 300);
    page.off('request', watch);
    expect(writes).toEqual([]);
    // Read by ref: still on main, its own changes as they were.
    expect(world.git(['symbolic-ref', '--short', 'HEAD'])).toBe('main');
    expect(world.git(['status', '--porcelain'])).toBe(status);
  });

  test("the Uncommitted row opens the folder's own changes; Close returns to the list with the group open", async () => {
    const { page } = world;
    const fold = group(page).locator('[data-reviews-fold="local"]');
    await row(page, `${world.plannotatorId}:`).click();
    const pane = page.locator('[data-local-diff="uncommitted"]');
    await expect(pane.locator('[data-guide-file-shell="NOTES.md"]')).toBeVisible({ timeout: 30_000 });
    await expect(changedRow(pane, 'src/comments.ts', 'export const draft = "Ada Novak";')).toBeVisible();
    await shot(page, '04-uncommitted-diff');
    await expect(pane.locator('[data-local-title]')).toHaveText('Uncommitted on main');
    await readableDiff(pane, 'src/comments.ts', 'export const draft = "Ada Novak";', 300);
    await pane.locator('[data-local-close]').click();
    await expect(page.locator('[data-local-diff]')).toHaveCount(0);
    await expect(fold).toHaveAttribute('aria-expanded', 'true');
    await expect(group(page).locator('[data-local-row]')).toHaveCount(3);
  });

  test("a branch row says its commits not on main where the list has room for them beside the name; always to a screen reader", async () => {
    const { page } = world;
    const branchRow = row(page, `${world.plannotatorId}:${BRANCH}`);
    const count = branchRow.locator('[data-local-ahead]');
    const edge = page.getByRole('separator', { name: 'List width' });
    // The list at its widest: the count on the row, the name still readable.
    await edge.focus();
    await page.keyboard.press('End');
    await page.waitForTimeout(300);
    await expect(count).toBeVisible();
    await shot(page, '09-commit-count');
    await expect(count).toHaveText('1 commit not on main');
    const name = (await branchRow.locator('.ib-rvr-t').boundingBox())!;
    expect(name.width).toBeGreaterThanOrEqual(120);
    const countBox = (await count.boundingBox())!;
    expect(countBox.x).toBeGreaterThanOrEqual(name.x + name.width);
    await expect(branchRow).toHaveAccessibleName(/1 commit not on main/);
    // At its narrowest the count gives way to the name; a screen reader still hears it.
    await page.keyboard.press('Home');
    await page.waitForTimeout(300);
    await expect(count).toBeHidden();
    await expect(branchRow).toHaveAccessibleName(/1 commit not on main/);
    // The rows without a count of their own say none.
    await expect(row(page, `${world.plannotatorId}:`).locator('[data-local-ahead]')).toHaveCount(0);
  });
});

test.describe('phone at 390', () => {
  test("the group open, and a branch row's diff in the list's place at the screen's width", async () => {
    const context = await world.browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, colorScheme: 'light', reducedMotion: 'reduce' });
    try {
      const page = await context.newPage();
      await page.goto(`${world.url}#reviews`);
      const toggle = group(page).locator('[data-reviews-fold="local"]');
      await toggle.click();
      await expect(group(page).locator('[data-local-row]')).toHaveCount(3);
      await group(page).scrollIntoViewIfNeeded();
      await shot(page, '05-phone-group-open');
      await page.setViewportSize({ width: 320, height: 700 });
      await group(page).scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await shot(page, '05b-phone-320-group-open');
      // A phone keeps 44px rows, at 390 and at 320.
      for (const width of [320, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await page.waitForTimeout(200);
        const rows = group(page).locator('[data-local-row]');
        for (let i = 0; i < 3; i++) {
          const height = (await rows.nth(i).boundingBox())!.height;
          expect(height, `row ${i} at ${width}`).toBeGreaterThanOrEqual(43.5);
          expect(height, `row ${i} at ${width}`).toBeLessThanOrEqual(45);
        }
        await phoneRowsReadable(page, [BRANCH, 'feat/spaces-share-link'], width);
        // No room on a phone's row for the commits beside a readable name: heard, not drawn.
        await expect(row(page, `${world.plannotatorId}:${BRANCH}`).locator('[data-local-ahead]')).toBeHidden();
        await expect(row(page, `${world.plannotatorId}:${BRANCH}`)).toHaveAccessibleName(/1 commit not on main/);
      }
      await expect(toggle).toHaveText('On this computer 3');
      await row(page, `${world.plannotatorId}:${BRANCH}`).click();
      const pane = page.locator('[data-local-diff="branch"]');
      await expect(pane.locator('[data-guide-file-shell="src/comments.ts"]')).toBeVisible({ timeout: 30_000 });
      await expect(changedRow(pane, 'src/comments.ts', 'export const words = "kept";')).toBeVisible();
      await shot(page, '06-phone-branch-diff');
      // A phone's row has no room for the commits beside a readable name: its diff's facts say them.
      await expect(pane.locator('[data-local-facts] [data-local-ahead]')).toHaveText('1 commit not on main');
      await shot(page, '11-phone-commit-count');
      // In the list's place: the pane is the screen's width.
      expect((await pane.boundingBox())!.width).toBeGreaterThan(380);
      await readableDiff(pane, 'src/comments.ts', 'export const words = "kept";', 300);
    } finally {
      await context.close();
    }
  });

  test("a long branch name in a long-named project: the bar gives the name its room, at 390 and 320", async () => {
    // A project an agent wrote from, with a branch of its own; opened by its address (the group's kept answer may be older).
    const name = 'charlie-dunn-spaces-site-share-links-and-previews';
    const branch = 'feat/share-links-open-in-spaces-with-one-click-and-keep-the-preview-cards';
    const project = gitProject(world.src, name);
    project.git(['checkout', '-q', '-b', branch]);
    project.commit('share.ts', 'export const share = "one click";\n', 5 * MINUTE);
    project.git(['checkout', '-q', 'main']);
    const client = new Client({ name: 'reviews-local-long', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(world.mcp)));
    const note = (await client.callTool({ name: 'send_message', arguments: { project_path: project.path, subject: 'Previews', body: 'Started on previews.', agent_host: 'claude-code', agent_name: 'Claude Code' } })) as { isError?: boolean; content?: { text: string }[] };
    await client.close().catch(() => {});
    if (note.isError) throw new Error(note.content?.map((c) => c.text).join(' '));
    const context = await world.browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, colorScheme: 'light', reducedMotion: 'reduce' });
    try {
      const page = await context.newPage();
      const projects = (await (await page.request.get(`${world.url}api/inbox/projects`)).json()) as { projects?: { id: string; root: string }[] };
      const id = projects.projects?.find((p) => p.root === project.path)?.id ?? '';
      expect(id).toBeTruthy();
      await page.goto(`${world.url}#reviews&local=${encodeURIComponent(id)}&branch=${encodeURIComponent(branch)}`);
      const pane = page.locator('[data-local-diff="branch"]');
      await expect(pane.locator('[data-guide-file-shell="share.ts"]')).toBeVisible({ timeout: 30_000 });
      await shot(page, '07-phone-long-branch');
      await page.setViewportSize({ width: 320, height: 700 });
      await page.waitForTimeout(300);
      await shot(page, '08-phone-long-branch-320');
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 760 });
        await page.waitForTimeout(300);
        const title = pane.locator('[data-local-title]');
        // The whole name is there: its text, and its title where it wraps past two lines.
        await expect(title).toHaveText(branch);
        await expect(title).toHaveAttribute('title', branch);
        const boxes = await pane.evaluate((root) => {
          const box = (selector: string) => {
            const el = root.querySelector(selector);
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
          };
          const facts = [...root.querySelectorAll('[data-local-facts] > *')].map((el) => el.getBoundingClientRect().right);
          const own = root.getBoundingClientRect();
          return { bar: box('.ib-pr-bar'), back: box('[data-phone-back]'), name: box('[data-local-title]'), review: box('[data-local-review]'), pane: { right: own.right }, facts };
        });
        const { bar, back, name: title2, review, pane: paneBox, facts } = boxes;
        // The name has room to be read (two lines at most, more than a few letters wide), and nothing overlaps.
        expect(title2!.width, `${width}`).toBeGreaterThan(120);
        expect(title2!.height).toBeLessThan(44);
        expect(back!.right).toBeLessThanOrEqual(title2!.left + 0.5);
        expect(title2!.right).toBeLessThanOrEqual(review!.left + 0.5);
        expect(review!.right).toBeLessThanOrEqual(bar!.right + 0.5);
        expect(title2!.top).toBeGreaterThanOrEqual(bar!.top - 0.5);
        expect(title2!.bottom).toBeLessThanOrEqual(bar!.bottom + 0.5);
        // Review with an agent: its words shown (not a bare "+", New review's own glyph in the list's bar), a 44 px
        // target, the same name for a screen reader.
        expect(review!.width).toBeGreaterThanOrEqual(44);
        expect(review!.height).toBeGreaterThanOrEqual(44);
        const reviewButton = pane.locator('[data-local-review]');
        await expect(reviewButton).toHaveAccessibleName('Review with an agent');
        expect((await reviewButton.evaluate((el) => (el as HTMLElement).innerText)).replace(/\s+/g, ' ').trim()).toBe('Review with an agent');
        await expect(reviewButton.locator('svg')).toHaveCount(0);
        // The facts under it (the long project's name first) stay inside the pane.
        await expect(pane.locator('[data-local-facts]')).toContainText(name);
        for (const right of facts) expect(right).toBeLessThanOrEqual(paneBox!.right + 0.5);
      }
    } finally {
      await context.close();
    }
  });

  test('the group with a 60-letter branch in a long-named project: the name keeps its room, the project gives way, at 390 and 320', async () => {
    const name = 'bob-tully-plannotator-inbox-reviews-on-this-computer-group';
    const branch = 'fix/reviews-group-keeps-the-whole-branch-name-on-every-phone';
    expect(branch).toHaveLength(60);
    const project = gitProject(world.src, name);
    project.git(['checkout', '-q', '-b', branch]);
    project.commit('group.ts', 'export const group = "kept";\n', 7 * MINUTE);
    project.git(['checkout', '-q', 'main']);
    const client = new Client({ name: 'reviews-local-group-long', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(world.mcp)));
    const note = (await client.callTool({ name: 'send_message', arguments: { project_path: project.path, subject: 'Group', body: 'Started on the group.', agent_host: 'claude-code', agent_name: 'Claude Code' } })) as { isError?: boolean; content?: { text: string }[] };
    await client.close().catch(() => {});
    if (note.isError) throw new Error(note.content?.map((c) => c.text).join(' '));
    const context = await world.browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, colorScheme: 'light', reducedMotion: 'reduce' });
    try {
      const page = await context.newPage();
      const projects = (await (await page.request.get(`${world.url}api/inbox/projects`)).json()) as { projects?: { id: string; root: string }[] };
      const id = projects.projects?.find((p) => p.root === project.path)?.id ?? '';
      expect(id).toBeTruthy();
      // The server keeps one answer 20 s: load the page again until the new branch is in the group (a goto to the
      // same address only moves its hash and reads nothing).
      const longRow = row(page, `${id}:${branch}`);
      await page.goto(`${world.url}#reviews`);
      await expect(async () => {
        await page.reload();
        const toggle = group(page).locator('[data-reviews-fold="local"]');
        await expect(toggle).toBeVisible();
        if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
        await expect(longRow).toBeVisible({ timeout: 3_000 });
      }).toPass({ timeout: 60_000, intervals: [2_000, 4_000, 5_000] });
      await longRow.scrollIntoViewIfNeeded();
      await shot(page, '05c-phone-390-long-names');
      const branches = await group(page).locator('[data-local-row][data-local-kind="branch"]').evaluateAll((els) => els.map((el) => el.getAttribute('data-local-row')!.split(':').slice(1).join(':')));
      expect(branches).toContain(branch);
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        await page.waitForTimeout(300);
        await phoneRowsReadable(page, branches, width);
        // The project gives way before the name: cut with "…", still inside the row.
        const box = await longRow.evaluate((el) => {
          const project = el.querySelector<HTMLElement>('[data-local-project]')!;
          return { right: project.getBoundingClientRect().right, row: el.getBoundingClientRect().right, cut: project.scrollWidth > project.clientWidth };
        });
        expect(box.right, `project inside the row at ${width}`).toBeLessThanOrEqual(box.row);
        expect(box.cut, `project cut at ${width}`).toBe(true);
        expect((await longRow.boundingBox())!.height).toBeLessThanOrEqual(45);
      }
    } finally {
      await context.close();
    }
  });
});

/** An agent writes from `path` (a guide makes a review row, which the list's project filter offers), and its project's id. */
async function agentWrote(page: Page, path: string, guide: boolean): Promise<string> {
  const client = new Client({ name: 'reviews-local-more', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(world.mcp)));
  try {
    const patch = 'diff --git a/notes.md b/notes.md\n--- a/notes.md\n+++ b/notes.md\n@@ -1 +1 @@\n-old\n+new\n';
    const call = guide
      ? { name: 'submit_guide', arguments: { project_path: path, guide: { title: 'Quiet notes', intent: 'One line.', sections: [{ title: 'The line', overview: 'One line.', diffs: [{ file: 'notes.md', summary: 'New.' }] }], review: { gitRef: 'main...HEAD', base: 'main' }, generator: { engine: 'claude-code', model: 'claude-opus-5' } }, patch, review: true, subject: 'Quiet notes', body: 'Ready for review.', agent_session: 'ses-quiet', agent_host: 'claude-code', agent_name: 'Claude Code' } }
      : { name: 'send_message', arguments: { project_path: path, subject: 'Spikes', body: 'Started on the spikes.', agent_host: 'claude-code', agent_name: 'Claude Code' } };
    const sent = (await client.callTool(call)) as { isError?: boolean; content?: { text: string }[] };
    if (sent.isError) throw new Error(sent.content?.map((c) => c.text).join(' '));
  } finally {
    await client.close().catch(() => {});
  }
  const projects = (await (await page.request.get(`${world.url}api/inbox/projects`)).json()) as { projects?: { id: string; root: string }[] };
  const id = projects.projects?.find((p) => p.root === path)?.id ?? '';
  expect(id).toBeTruthy();
  return id;
}

/** Loads the list again until `ready` holds (the server keeps one answer 20 s; a goto to the same address reads nothing). */
async function readUntil(page: Page, address: string, ready: () => Promise<void>): Promise<void> {
  await page.goto(address);
  await expect(async () => {
    await page.reload();
    const toggle = group(page).locator('[data-reviews-fold="local"]');
    await expect(toggle).toBeVisible({ timeout: 3_000 });
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
    await ready();
  }).toPass({ timeout: 60_000, intervals: [2_000, 4_000, 5_000] });
}

// After the phone's: the projects these make join the group.
test.describe('past five rows, and one project with nothing here, at 1440', () => {
  test('"N more" (the Agents view\'s fold) shows the rest of the group, focus on the first it shows', async () => {
    const spikes = gitProject(world.src, 'spikes');
    for (let i = 0; i < 7; i++) {
      spikes.git(['checkout', '-q', '-b', `bob/spike-${i}`, 'main']);
      spikes.commit(`spike-${i}.ts`, `export const spike = ${i};\n`, (20 + i) * MINUTE);
      spikes.git(['checkout', '-q', 'main']);
    }
    const context = await world.browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: 'light', reducedMotion: 'reduce' });
    try {
      const page = await context.newPage();
      const id = await agentWrote(page, spikes.path, false);
      await readUntil(page, `${world.url}#reviews`, async () => {
        const total = Number((await group(page).locator('[data-reviews-fold="local"] .ib-n').textContent({ timeout: 3_000 }))?.trim());
        expect(total).toBeGreaterThanOrEqual(10);
      });
      const total = Number((await group(page).locator('[data-reviews-fold="local"] .ib-n').textContent())!.trim());
      const rows = group(page).locator('[data-local-row]');
      const more = group(page).locator('[data-local-more]');
      await expect(rows).toHaveCount(5);
      await expect(more).toHaveText(`${total - 5} more`);
      await shot(page, '10-fold-more');
      await more.click();
      await expect(rows).toHaveCount(total);
      await expect(more).toHaveCount(0);
      await expect(rows.nth(5)).toBeFocused();
      // Every spike is there, each with its one commit not on main.
      for (let i = 0; i < 7; i++) await expect(row(page, `${id}:bob/spike-${i}`)).toHaveAccessibleName(/1 commit not on main/);
    } finally {
      await context.close();
    }
  });

  test("a list filtered to a project with nothing here says so, in Branch reviews' words", async () => {
    const quiet = gitProject(world.src, 'quiet-notes');
    const context = await world.browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: 'light', reducedMotion: 'reduce' });
    try {
      const page = await context.newPage();
      const id = await agentWrote(page, quiet.path, true);
      const none = group(page).locator('[data-local-none]');
      await readUntil(page, `${world.url}#reviews&project=${encodeURIComponent(id)}`, async () => {
        await expect(none).toBeVisible({ timeout: 3_000 });
      });
      await shot(page, '12-one-project-empty');
      await expect(none).toHaveText('No other branch had a commit in the last 14 days.');
      await expect(group(page).locator('[data-local-row]')).toHaveCount(0);
      // The whole list: other projects' rows, no such words.
      await page.goto(`${world.url}#reviews`);
      await page.reload();
      await expect(group(page).locator('[data-local-row]').first()).toBeVisible();
      await expect(group(page).locator('[data-local-none]')).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("a project whose default branch is its own (a local-only trunk, no main) lists its branch against it", async () => {
    const trunk = gitProject(world.src, 'trunk-notes');
    const context = await world.browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: 'light', reducedMotion: 'reduce' });
    try {
      const page = await context.newPage();
      const id = await agentWrote(page, trunk.path, true);
      // No main and no origin: the repository's default is trunk.
      trunk.git(['branch', '-M', 'main', 'trunk']);
      trunk.git(['checkout', '-q', '-b', 'ada/on-trunk']);
      trunk.commit('src/trunk.ts', 'export const onTrunk = true;\n', 30 * MINUTE);
      trunk.git(['checkout', '-q', 'trunk']);
      const branchRow = row(page, `${id}:ada/on-trunk`);
      await readUntil(page, `${world.url}#reviews&project=${encodeURIComponent(id)}`, async () => {
        await expect(branchRow).toBeVisible({ timeout: 3_000 });
      });
      await expect(branchRow).toHaveAccessibleName(/1 commit not on trunk/);
      await expect(group(page).locator('[data-local-unread], [data-local-none]')).toHaveCount(0);
      await branchRow.click();
      await expect(page.locator('[data-local-facts]')).toContainText('1 commit not on trunk');
    } finally {
      await context.close();
    }
  });
});
