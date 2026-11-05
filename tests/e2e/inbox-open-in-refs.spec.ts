/**
 * "Open in" on what the Inbox references (approval "code-review-launch-build",
 * item 7), in a real browser against the compiled binary. `open`, `xdg-open`,
 * `code`, `gh` and `glab` are sh fakes first on PATH, so nothing launches and
 * nothing reaches a forge; each launch is one line in a log. The world: a git
 * repository with an origin, a shape on it (file and diff references, a Code
 * view), an agent's review, a message linking files, and a PR on that origin.
 *
 * What is proved:
 *  - Each place offers the window's split button for a file on disk, and picking
 *    from it launches with that file's real path (and its line, on an editor that
 *    takes one). A referenced file that is not on disk has no control at all.
 *  - At 390 px (a phone) no place offers one.
 *  - Code review off: no place offers one, and nothing else changes.
 *  - "Tell your agents" never appears.
 *
 * Build the binary first (see inbox.spec.ts). Shots land in
 * PLANNOTATOR_E2E_PROOF_DIR/open-in-refs (default .local/proof).
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'open-in-refs');

const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };

const RETRY_BASE = ['export async function retryPayout(payout) {', '  for (let attempt = 0; attempt < 5; attempt++) {', '    const result = await charge(payout);', '    if (result.ok) return result;', '  }', '}', ''].join('\n');
const RETRY_HEAD = ['const BACKOFF_MS = [500, 2_000, 8_000];', '', 'export async function retryPayout(payout) {', '  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {', '    const result = await charge(payout);', '    if (result.ok) return result;', '    await sleep(BACKOFF_MS[attempt]);', '  }', '}', ''].join('\n');

interface World {
  root: string;
  dataDir: string;
  env: Record<string, string>;
  url: string;
  project: string;
  launches: string;
  shape: string;
  shapeThread: string;
  reviewThread: string;
  messageThread: string;
  claude: SimAgent;
}

let world: World;

/** The repository: `main` checked out, and the PR's branch with one changed file and one the checkout does not have. */
function payouts(parent: string) {
  const dir = scratchProject(parent, 'payouts');
  const git = (...args: string[]) => {
    const run = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
    if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`);
    return run.stdout;
  };
  const write = (path: string, text: string) => {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  git('checkout', '-q', '-b', 'main');
  write('src/retry.ts', RETRY_BASE);
  write('src/ledger.ts', 'export const ledger = [];\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'backoff');
  write('src/retry.ts', RETRY_HEAD);
  write('src/only-on-the-pr.ts', 'export const onlyHere = true;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'backoff');
  const patch = git('diff', 'main...backoff');
  git('checkout', '-q', 'main');
  git('remote', 'add', 'origin', 'https://github.com/acme/payouts.git');
  return { dir, patch };
}

/** The fakes first on PATH: the launchers log and exit; `gh` answers the one PR. */
function fakes(dir: string, launches: string, patch: string) {
  mkdirSync(dir, { recursive: true });
  for (const name of ['open', 'xdg-open', 'code', 'cursor', 'zed', 'subl']) {
    writeFileSync(join(dir, name), `#!/bin/sh\necho "${name} $*" >> '${launches}'\nexit 0\n`);
    chmodSync(join(dir, name), 0o755);
  }
  writeFileSync(join(dir, 'pr.patch'), patch);
  const pull = {
    number: 88,
    title: 'Back off between retries',
    url: 'https://github.com/acme/payouts/pull/88',
    state: 'OPEN',
    isDraft: false,
    updatedAt: new Date().toISOString(),
    mergedAt: null,
    baseRefName: 'main',
    headRefName: 'backoff',
    headRefOid: '8'.repeat(40),
    additions: 5,
    deletions: 2,
    changedFiles: 2,
    reviewDecision: 'REVIEW_REQUIRED',
    repository: { nameWithOwner: 'acme/payouts' },
    headRepository: { nameWithOwner: 'acme/payouts' },
    author: { login: 'tomas', avatarUrl: '' },
    reviewRequests: { nodes: [] },
    latestReviews: { nodes: [] },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
  };
  writeFileSync(join(dir, 'pulls.json'), JSON.stringify({ data: { viewer: { login: 'dana' }, requested: { nodes: [pull] }, authored: { nodes: [] }, merged: { nodes: [] } } }));
  writeFileSync(
    join(dir, 'gh'),
    [
      '#!/bin/sh',
      'if [ "$1" = auth ]; then echo \'{"hosts":{"github.com":[{"login":"dana","active":true,"state":"success","tokenSource":"keyring"}]}}\'; exit 0; fi',
      `if [ "$1" = api ] && [ "$2" = graphql ]; then cat '${join(dir, 'pulls.json')}'; exit 0; fi`,
      'if [ "$1" = api ] && [ "$2" = --hostname ] && [ "$5" = --jq ]; then echo "' + '8'.repeat(40) + '"; exit 0; fi',
      `if [ "$1" = api ] && [ "$2" = --hostname ]; then cat '${join(dir, 'pr.patch')}'; exit 0; fi`,
      'exit 1',
      '',
    ].join('\n'),
  );
  chmodSync(join(dir, 'gh'), 0o755);
  writeFileSync(join(dir, 'glab'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(dir, 'glab'), 0o755);
}

const REVIEW_GUIDE = {
  title: 'Back off between retries',
  intent: 'Wait before retrying.',
  sections: [{ title: 'The retry loop', overview: 'Waits between attempts.', diffs: [{ file: 'src/retry.ts', summary: 'The backoff.' }, { file: 'src/only-on-the-pr.ts', summary: 'A new file.' }] }],
};

function board(patch: string) {
  return {
    title: 'Back off between retries',
    claim: 'Built. The loop now waits [^1].',
    views: {
      picture: { html: '<svg viewBox="0 0 700 240" width="700" height="240"><g data-step="1" data-mark="loop" data-code="src/ledger.ts#L1" data-ref="1"><rect class="ink" x="40" y="70" width="260" height="90" rx="12"/><text x="170" y="120" text-anchor="middle">The retry loop</text></g><g data-step="2" data-mark="gone" data-ref="3"><rect class="acc-fill" x="400" y="70" width="260" height="90" rx="12"/><text x="530" y="120" text-anchor="middle" class="t-acc">A file that is gone</text></g></svg>', width: 700, height: 240 },
      know: 'The loop waits 0.5 s, 2 s, then 8 s [^1].',
      code: {
        stage: 'after',
        guide: { title: 'Back off between retries', intent: 'Wait before retrying.', sections: [{ title: 'The retry loop', overview: 'Waits between attempts.', diffs: [{ file: 'src/retry.ts', summary: 'The backoff.' }] }] },
        patch,
        files: [{ path: 'src/retry.ts', line: 3 }],
      },
    },
    refs: [
      { n: 1, kind: 'file', title: 'The retry loop', sub: 'Where it waits.', target: 'src/retry.ts', line: 3 },
      { n: 2, kind: 'diff', title: 'The change', target: 'src/retry.ts' },
      { n: 3, kind: 'file', title: 'A file that is gone', target: 'src/gone.ts' },
    ],
  };
}

test.use({ actionTimeout: 20_000 });

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-open-in-refs-');
  const dataDir = join(root, 'data');
  markTourDecided(dataDir);
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ ...(JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) as object), inboxCodeReview: true, inboxShape: true }));
  for (const dir of ['claude', 'codex', 'xdg']) mkdirSync(join(root, dir), { recursive: true });
  const { dir: project, patch } = payouts(join(root, 'src'));
  const launches = join(root, 'launches.log');
  const stubs = join(root, 'stubs');
  fakes(stubs, launches, patch);
  const env: Record<string, string> = {
    PATH: `${stubs}:${process.env.PATH ?? ''}`,
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
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
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const shapeSent = await claude.send({ project_path: project, thread: 'shape', subject: 'Retries: the board', body: 'The board is up.' });
  const messageSent = await claude.send({ project_path: project, thread: 'links', subject: 'Retries: where to look', body: 'The wait is in [the retry loop](src/retry.ts#L3), and the rows in [the ledger](src/ledger.ts). I also meant [a file that is gone](src/gone.ts).' });
  const reviewSent = await claude.submitGuide({ project_path: project, thread: 'review', subject: 'Retries: review', guide: REVIEW_GUIDE, patch, review: true } as never);
  mkdirSync(join(root, 'boards'), { recursive: true });
  writeFileSync(join(root, 'boards', 'board.json'), JSON.stringify(board(patch)));
  const updated = spawnSync(binary, ['shape', 'update', '--file', join(root, 'boards', 'board.json'), '--project', project, '--thread', shapeSent.thread_id as string], { env, cwd: project, encoding: 'utf8', timeout: 30_000 });
  expect(updated.status, updated.stderr).toBe(0);
  world = {
    root,
    dataDir,
    env,
    url,
    project,
    launches,
    shape: (JSON.parse(updated.stdout) as { id: string }).id,
    shapeThread: shapeSent.thread_id as string,
    reviewThread: reviewSent.thread_id as string,
    messageThread: messageSent.thread_id as string,
    claude,
  };
});

test.afterAll(async () => {
  try {
    await world?.claude.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

async function windowAt(browser: Browser, width: number, height: number, colorScheme: 'light' | 'dark'): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme, deviceScaleFactor: 2, ...(width < 500 ? { hasTouch: true, isMobile: true } : {}) });
  const page = await context.newPage();
  page.on('pageerror', (error) => {
    throw error;
  });
  return { context, page };
}

const launched = (): string[] => (existsSync(world.launches) ? readFileSync(world.launches, 'utf8').trim().split('\n').filter(Boolean) : []);
const shot = (page: Page, name: string) => page.screenshot({ path: join(proofDir, `${name}.png`) });
const realPath = (file: string) => join(world.project, file);

/** The board's References panel, open. */
async function openRefs(page: Page) {
  await page.goto(`${world.url}#thread=${world.shapeThread}&shape=${world.shape}`);
  const panelTab = page.getByRole('button', { name: /References/ }).first();
  await panelTab.waitFor();
  await panelTab.click();
  await expect(page.locator('.shp-ref-list li')).toHaveCount(3);
}

/** The agent's review, on All files. */
async function openReviewFiles(page: Page) {
  await page.goto(`${world.url}#thread=${world.reviewThread}`);
  await page.getByRole('button', { name: 'Start review' }).first().click();
  await page.locator('[data-review-mode-choice="files"]').click();
}

/** The PR's own diff, from its page. */
async function openPullDiff(page: Page) {
  await page.goto(`${world.url}#pulls`);
  await page.locator('[data-pulls-row]').first().click();
  await page.locator('[data-pulls-open-diff]').click();
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`on this computer, ${colorScheme}: each place offers Open in for a file on disk, and only then`, async ({ browser }) => {
    const { context, page } = await windowAt(browser, 1440, 900, colorScheme);
    try {
      // Shape: the References list. The two rows on src/retry.ts have it; the file that is gone has none.
      await openRefs(page);
      const rows = page.locator('.shp-ref-list li');
      await expect(rows.nth(0).locator('[data-open-in-caret]')).toBeVisible();
      await expect(rows.nth(1).locator('[data-open-in-caret]')).toBeVisible();
      await expect(rows.nth(2).locator('.shp-ref-row')).toBeVisible();
      await expect(rows.nth(2).locator('[data-open-in-caret]')).toHaveCount(0);
      await rows.nth(0).locator('[data-open-in-caret]').click();
      const menu = page.locator('[data-open-in-menu="src/retry.ts"]');
      await expect(menu.locator('[data-open-in-item="reveal"]')).toBeVisible();
      await expect(menu.locator('[data-open-in-item="browser"]')).toHaveCount(0);
      await shot(page, `01-shape-references-menu-${colorScheme}`);
      const before = launched().length;
      await menu.locator('[data-open-in-item="reveal"]').click();
      await expect.poll(() => launched().length).toBe(before + 1);
      expect(launched().at(-1)).toContain(realPath('src/retry.ts'));
      // An editor this computer has (a bundle on macOS, a fake on PATH elsewhere): at its line when its launcher takes one.
      await rows.nth(0).locator('[data-open-in-caret]').click();
      await expect(menu.locator('[data-open-in-item="reveal"]')).toBeVisible();
      const code = menu.locator('[data-open-in-item="vscode"]');
      if (await code.count()) {
        const count = launched().length;
        await code.click();
        await expect.poll(() => launched().length).toBe(count + 1);
        expect(launched().at(-1)).toMatch(/(vscode:\/\/file.*src\/retry\.ts:3|--goto .*src\/retry\.ts:3)/);
      } else {
        await page.keyboard.press('Escape');
      }

      // A bubble's preview, on the board. Its menu opens without closing the preview.
      await page.reload();
      const bubble = page.locator('[data-ref="1"]').first();
      await bubble.hover();
      const peek = page.locator('.shp-peek');
      await expect(peek.locator('[data-open-in-caret]')).toBeVisible();
      await shot(page, `02-shape-bubble-${colorScheme}`);
      await peek.locator('[data-open-in-caret]').click();
      await expect(page.locator('[data-open-in-menu="src/retry.ts"]')).toBeVisible();
      await expect(peek).toBeVisible();
      await page.keyboard.press('Escape');
      await page.mouse.move(2, 2);

      // The board's Code view: the guide's file card, then the whole file.
      await page.locator('.shp-tbtn', { hasText: 'Code' }).first().click();
      const card = page.locator('.shp-guide [data-guide-file-shell="src/retry.ts"]');
      await expect(card.locator('[data-open-in-caret]').first()).toBeVisible();
      await shot(page, `03-shape-code-guide-${colorScheme}`);
      await card.locator('.shp-g-open').click();
      await expect(page.locator('.shp-code-head [data-open-in-caret]')).toBeVisible();
      await shot(page, `04-shape-whole-file-${colorScheme}`);

      // A part with a reference opens the file in the popout: its header, and a pick leaves it open.
      await page.reload();
      await page.locator('[data-mark="loop"]').first().click();
      const popout = page.locator('[data-popout]');
      await expect(popout.locator('[data-open-in-caret]')).toBeVisible();
      await popout.locator('[data-open-in-caret]').click();
      await expect(page.locator('[data-open-in-menu="src/retry.ts"]')).toBeVisible();
      await shot(page, `04b-shape-popout-${colorScheme}`);
      const popoutCount = launched().length;
      await page.locator('[data-open-in-menu="src/retry.ts"] [data-open-in-item="reveal"]').click();
      await expect.poll(() => launched().length).toBe(popoutCount + 1);
      expect(launched().at(-1)).toContain(realPath('src/retry.ts'));
      await expect(popout).toBeVisible();

      // The review's diff header: a file on disk has it, one only the change has does not.
      await openReviewFiles(page);
      const onDisk = page.locator('[data-guide-file-shell="src/retry.ts"]');
      await expect(onDisk.locator('[data-open-in-caret]')).toBeVisible();
      const notOnDisk = page.locator('[data-guide-file-shell="src/only-on-the-pr.ts"]');
      await notOnDisk.scrollIntoViewIfNeeded();
      await expect(notOnDisk.locator('[data-guide-code-view-mounted="true"]')).toBeVisible();
      await expect(notOnDisk.locator('[data-open-in-caret]')).toHaveCount(0);
      await onDisk.scrollIntoViewIfNeeded();
      await onDisk.locator('[data-open-in-caret]').click();
      await expect(page.locator('[data-open-in-menu="src/retry.ts"] [data-open-in-item="reveal"]')).toBeVisible();
      await shot(page, `05-review-all-files-menu-${colorScheme}`);
      const reviewCount = launched().length;
      await page.locator('[data-open-in-menu="src/retry.ts"] [data-open-in-item="reveal"]').click();
      await expect.poll(() => launched().length).toBe(reviewCount + 1);
      expect(launched().at(-1)).toContain(realPath('src/retry.ts'));

      // The PR page's diff, "Open the diff": what is on disk in the clone; nothing for a file the clone has not got.
      await openPullDiff(page);
      const prFile = page.locator('[data-guide-file-shell="src/retry.ts"]');
      await expect(prFile.locator('[data-open-in-caret]')).toBeVisible();
      const prNew = page.locator('[data-guide-file-shell="src/only-on-the-pr.ts"]');
      await prNew.scrollIntoViewIfNeeded();
      await expect(prNew.locator('[data-guide-code-view-mounted="true"]')).toBeVisible();
      await expect(prNew.locator('[data-open-in-caret]')).toHaveCount(0);
      await prFile.scrollIntoViewIfNeeded();
      await shot(page, `06-pr-diff-${colorScheme}`);

      // A message's links that name no attachment: a file on disk has it, with its line; the gone one has none.
      await page.goto(`${world.url}#thread=${world.messageThread}`);
      const body = page.locator('.ib-body').first();
      await expect(body.locator('[data-local-link="unavailable"]')).toHaveCount(3);
      await expect(body.locator('[data-open-in-caret]')).toHaveCount(2);
      await shot(page, `07-message-links-${colorScheme}`);

      await expect(page.getByText('Tell your agents')).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test(`on a phone, ${colorScheme}: no place offers an app`, async ({ browser }) => {
    const { context, page } = await windowAt(browser, 390, 844, colorScheme);
    try {
      await page.goto(`${world.url}#thread=${world.messageThread}`);
      await expect(page.locator('.ib-body [data-local-link="unavailable"]').first()).toBeVisible();
      await expect(page.locator('[data-open-in-caret]')).toHaveCount(0);
      await shot(page, `08-phone-message-${colorScheme}`);

      await page.goto(`${world.url}#thread=${world.shapeThread}&shape=${world.shape}`);
      // The phone's dock has the count, not the word.
      await page.locator('.shp-tbtn', { hasText: '3' }).click();
      await expect(page.locator('.shp-ref-list li')).toHaveCount(3);
      await expect(page.locator('[data-open-in-caret]')).toHaveCount(0);
      await page.waitForTimeout(600); // the sheet has finished rising, for the picture
      await shot(page, `09-phone-shape-${colorScheme}`);

      await page.goto(`${world.url}#thread=${world.reviewThread}`);
      await page.getByRole('button', { name: 'Start review' }).first().click();
      await expect(page.locator('[data-guide-file-shell="src/retry.ts"]')).toBeVisible();
      await expect(page.locator('[data-open-in-caret]')).toHaveCount(0);
      await shot(page, `10-phone-review-${colorScheme}`);
    } finally {
      await context.close();
    }
  });
}

test('Code review off: no place offers one', async ({ browser }) => {
  const config = join(world.dataDir, 'config.json');
  const was = readFileSync(config, 'utf8');
  writeFileSync(config, JSON.stringify({ ...(JSON.parse(was) as object), inboxCodeReview: false }));
  const { context, page } = await windowAt(browser, 1440, 900, 'light');
  try {
    await page.goto(`${world.url}#thread=${world.messageThread}`);
    await expect(page.locator('.ib-body [data-local-link="unavailable"]').first()).toBeVisible();
    await expect(page.locator('[data-open-in-caret]')).toHaveCount(0);
    await page.goto(`${world.url}#thread=${world.shapeThread}&shape=${world.shape}`);
    await page.getByRole('button', { name: /References/ }).first().click();
    await expect(page.locator('.shp-ref-list li')).toHaveCount(3);
    await expect(page.locator('[data-open-in-caret]')).toHaveCount(0);
  } finally {
    await context.close();
    writeFileSync(config, was);
  }
});
