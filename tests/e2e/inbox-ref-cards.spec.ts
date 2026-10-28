/**
 * Hover cards for issue, PR and MR links in an agent's message, proved in a
 * real browser against the compiled binary. `plannotator inbox --background`
 * runs under a temp data dir and HOME with a scripted `gh` and `glab` first
 * on PATH (fake-forge.ts: no real GitHub or GitLab, every call logged), and an
 * agent sends through `plannotator inbox mcp` a message whose bare `#12`
 * links to the project's GitHub origin, plus a pasted GitLab MR URL.
 *
 * Proves: opening the thread runs no forge CLI and asks nothing; a hover
 * opens the card after the delay with one CLI call per ref (a second hover
 * asks nothing); the states (merged with checks passed, open with checks
 * failing and changes requested, draft with checks running, an issue, not
 * found, a GitLab MR with its pipeline and approvals); a press pins the card,
 * it scrolls and stays when the pointer leaves; Escape closes it and leaves
 * the thread open; keyboard focus opens it, Tab moves in, Escape returns focus
 * to the link; a link inside the body asks before opening; on a phone a tap
 * shows a sheet and never follows the link.
 *
 * Screenshots go to PLANNOTATOR_REF_CARD_SHOTS when it is set. Build the
 * binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 */

import { devices, expect, test, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';
import { fakeForge, type FakeForge } from './fake-forge';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shotsDir = process.env.PLANNOTATOR_REF_CARD_SHOTS;

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const person = (login: string) => ({ login, avatarUrl: null });

function githubItem(item: Record<string, unknown>) {
  return { data: { repository: { nameWithOwner: 'acme/widgets', issueOrPullRequest: item } } };
}

function pull(number: number, extra: Record<string, unknown>) {
  return githubItem({
    __typename: 'PullRequest',
    number,
    url: `https://github.com/acme/widgets/pull/${number}`,
    state: 'OPEN',
    isDraft: false,
    createdAt: hoursAgo(26),
    updatedAt: hoursAgo(1),
    closedAt: null,
    mergedAt: null,
    author: person('ada'),
    labels: { nodes: [] },
    assignees: { nodes: [] },
    comments: { totalCount: 0, nodes: [] },
    baseRefName: 'main',
    additions: 120,
    deletions: 14,
    changedFiles: 6,
    reviewDecision: null,
    closingIssuesReferences: { nodes: [] },
    commits: { nodes: [] },
    ...extra,
  });
}

const checks = (state: string, runs: [string, string | null][]) => ({
  nodes: [{ commit: { statusCheckRollup: { state, contexts: { totalCount: runs.length, nodes: runs.map(([status, conclusion]) => ({ __typename: 'CheckRun', status, conclusion })) } } } }],
});

const LONG_BODY = [
  '## What',
  '',
  'Moves the widget cache to a single store so the list and the detail pane stop disagreeing.',
  '',
  '## Why',
  '',
  'Two caches drifted after a rename: [the report](https://evil.example/phish) shows the stale title for up to a minute.',
  '',
  '![before](https://example.com/before.png)',
  '',
  // Raw HTML lands after the card's own pass over its links (HtmlBlock writes it in a passive effect).
  '<p>Logs: <a href="https://evil.example/raw" target="_blank">the raw log</a></p>',
  '',
  '<details open><summary>Trace</summary><a href="https://evil.example/details">the trace</a></details>',
  '',
  ...Array.from({ length: 8 }, (_, i) => `- Step ${i + 1}: keep the reader's place while the store reloads.`),
  '',
  '## Testing',
  '',
  'Unit tests for the store, and an e2e that renames a widget with the detail pane open.',
].join('\n');

function seed(forge: FakeForge) {
  forge.github(12, pull(12, {
    title: 'Ship the widget picker',
    state: 'MERGED',
    mergedAt: hoursAgo(2),
    headRefName: 'feat/widget-picker',
    body: '## What\n\nA picker for widgets in the toolbar. Closes #11.',
    labels: { nodes: [{ name: 'feature', color: 'a2eeef' }] },
    closingIssuesReferences: { nodes: [{ number: 11, title: 'No way to pick a widget', url: 'https://github.com/acme/widgets/issues/11', state: 'CLOSED' }] },
    commits: checks('SUCCESS', [['COMPLETED', 'SUCCESS'], ['COMPLETED', 'SUCCESS'], ['COMPLETED', 'SKIPPED']]),
  }));
  forge.github(14, pull(14, {
    title: 'One store for the widget cache',
    headRefName: 'fix/one-cache',
    body: LONG_BODY,
    reviewDecision: 'CHANGES_REQUESTED',
    labels: { nodes: [{ name: 'bug', color: 'd73a4a' }, { name: 'needs work', color: 'e99695' }] },
    assignees: { nodes: [person('ada'), person('lin')] },
    comments: { totalCount: 5, nodes: [{ author: person('lin'), createdAt: hoursAgo(0.5), body: 'The rename test still fails on Linux, see the `e2e (ubuntu)` job.' }] },
    commits: checks('FAILURE', [['COMPLETED', 'FAILURE'], ['COMPLETED', 'FAILURE'], ['COMPLETED', 'SUCCESS'], ['COMPLETED', 'SUCCESS'], ['IN_PROGRESS', null]]),
  }));
  forge.github(15, pull(15, {
    title: 'Draft: widget sharing',
    isDraft: true,
    headRefName: 'spike/sharing',
    body: 'Early cut, not ready.',
    reviewDecision: 'REVIEW_REQUIRED',
    commits: checks('PENDING', [['COMPLETED', 'SUCCESS'], ['QUEUED', null], ['IN_PROGRESS', null]]),
  }));
  forge.github(11, githubItem({
    __typename: 'Issue',
    number: 11,
    title: 'No way to pick a widget',
    url: 'https://github.com/acme/widgets/issues/11',
    state: 'OPEN',
    stateReason: null,
    createdAt: hoursAgo(80),
    updatedAt: hoursAgo(3),
    closedAt: null,
    body: 'People open the settings page to change the widget. A picker in the toolbar would save the trip.',
    author: person('sam'),
    labels: { nodes: [{ name: 'enhancement', color: 'a2eeef' }, { name: 'good first issue', color: '7057ff' }] },
    assignees: { nodes: [person('ada')] },
    comments: { totalCount: 2, nodes: [{ author: person('ada'), createdAt: hoursAgo(3), body: "I'll take it, PR soon." }] },
    closedByPullRequestsReferences: { nodes: [] },
  }));
  forge.gitlab('mr', 7, {
    data: {
      project: {
        fullPath: 'acme/platform/tools',
        mergeRequest: {
          iid: '7',
          title: 'Cache the build layers',
          webUrl: 'https://gitlab.com/acme/platform/tools/-/merge_requests/7',
          state: 'opened',
          draft: false,
          createdAt: hoursAgo(30),
          updatedAt: hoursAgo(0.3),
          closedAt: null,
          mergedAt: null,
          description: '## What\n\nReuses the dependency layer between pipelines.\n\n- about 4 minutes faster per run',
          author: { username: 'lin', avatarUrl: null },
          labels: { nodes: [{ title: 'ci', color: '#6699CC' }] },
          assignees: { nodes: [] },
          userNotesCount: 1,
          notes: { nodes: [{ system: false, body: 'Looks right; one question on the cache key.', createdAt: hoursAgo(0.3), author: { username: 'sam', avatarUrl: null } }] },
          sourceBranch: 'ci/layer-cache',
          targetBranch: 'main',
          diffStatsSummary: { additions: 48, deletions: 9, fileCount: 3 },
          approved: false,
          detailedMergeStatus: 'NOT_APPROVED',
          headPipeline: { status: 'RUNNING', jobs: { nodes: [{ status: 'SUCCESS' }, { status: 'SUCCESS' }, { status: 'RUNNING' }, { status: 'PENDING' }] } },
        },
      },
    },
  });
}

const MR_URL = 'https://gitlab.com/acme/platform/tools/-/merge_requests/7';
const BODY = [
  'Status on the widget work:',
  '',
  '- #12 is merged (it closes #11).',
  '- #14 needs another pass: checks are failing.',
  '- #15 is a draft, no need to look yet.',
  `- The CI change on GitLab: ${MR_URL}`,
  '- And #404, which I think was a typo.',
].join('\n');

const card = (page: Page) => page.locator('[data-ref-card]');
const ref = (page: Page, href: string) => page.locator(`[data-message-id] a[href="${href}"]`).first();
const issueHref = (n: number) => `https://github.com/acme/widgets/issues/${n}`;

async function shot(page: Page, name: string) {
  if (!shotsDir) return;
  mkdirSync(shotsDir, { recursive: true });
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(shotsDir, `${name}.png`) });
}

async function hover(page: Page, href: string) {
  // A link Escape gave focus back to keeps its ring; the pointer path starts from no focus.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(2, 2);
  await expect(card(page)).toHaveCount(0);
  await ref(page, href).hover();
  await expect(card(page).locator('[data-ref-card-state], [data-ref-card-error]')).toBeVisible();
}

test.describe('ref hover cards', () => {
  let url = '';
  let threadId = '';
  let forge: FakeForge;
  let root = '';

  test.beforeAll(async () => {
    expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
    root = inboxScratch('plannotator-inbox-ref-cards-e2e-');
    forge = fakeForge(join(root, 'bin'));
    seed(forge);
    const env = { PATH: `${forge.dir}:${process.env.PATH ?? ''}`, HOME: root, PLANNOTATOR_DATA_DIR: join(root, 'data'), PLANNOTATOR_BROWSER: NO_BROWSER };
    const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
    expect(started.status, started.stderr).toBe(0);
    url = started.stdout.trim();
    const project = scratchProject(join(root, 'src'), 'widgets');
    spawnSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], { cwd: project });
    const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
    try {
      const sent = await agent.send({ project_path: project, subject: 'Widget work: where things stand', body: BODY });
      threadId = sent.thread_id as string;
    } finally {
      await agent.close().catch(() => {});
    }
    // `#12` links once the project's origin is read (in the background, inbox-repos.ts).
    await expect
      .poll(async () => ((await (await fetch(`${url}api/inbox/threads/${threadId}`)).json()) as { thread: { project: { repo: unknown } } }).thread.project.repo, { timeout: 20_000 })
      .toBeTruthy();
  });

  test.afterAll(async () => {
    await removeInboxScratch(root);
  });

  test('hover, states, pin, Escape, keyboard, inert body links; nothing asked on opening the thread', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light' });
    const popups: string[] = [];
    const page = await context.newPage();
    context.on('page', (p) => popups.push(p.url()));
    const refRequests: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/api/inbox/ref')) refRequests.push(r.url());
    });
    try {
      await page.goto(`${url}#thread=${threadId}`);
      await expect(ref(page, issueHref(12))).toBeVisible();
      await page.waitForTimeout(1_000);
      expect(refRequests).toEqual([]);
      expect(forge.calls()).toEqual([]);

      // A pass over a link shorter than the delay opens nothing and asks nothing.
      await ref(page, issueHref(15)).hover();
      await page.waitForTimeout(150);
      await page.mouse.move(2, 2);
      await page.waitForTimeout(500);
      await expect(card(page)).toHaveCount(0);
      expect(forge.calls()).toEqual([]);

      // Merged, checks passed, closes an issue. One call; a second hover asks nothing.
      await hover(page, issueHref(12));
      const c = card(page);
      await expect(c.locator('[data-ref-card-title]')).toContainText('Ship the widget picker');
      await expect(c.locator('[data-ref-card-state]')).toHaveText('Merged');
      await expect(c.locator('[data-ref-card-checks="success"]')).toHaveText(/All 3 checks passed/);
      await expect(c).toContainText('No way to pick a widget');
      await expect(c.locator('[data-ref-card-open]')).toHaveAttribute('href', 'https://github.com/acme/widgets/pull/12');
      expect(await c.getAttribute('aria-label')).toBe('Pull request #12: Ship the widget picker');
      await shot(page, 'light-pr-merged');
      await hover(page, issueHref(12));
      expect(forge.calls()).toEqual(['gh number=12']);

      // Open, checks failing, changes requested, the latest comment.
      await hover(page, issueHref(14));
      await expect(c.locator('[data-ref-card-checks="failure"]')).toHaveText(/2 failing, 1 running · 2 passed/);
      await expect(c.locator('[data-ref-card-review]')).toHaveText('Changes requested');
      await expect(c.locator('[data-ref-card-comment]')).toContainText('The rename test still fails on Linux');
      await shot(page, 'light-pr-checks-failing');

      // A press pins it: it scrolls, stays when the pointer leaves, and Close appears.
      await c.locator('[data-ref-card-title]').click();
      await expect(c).toHaveAttribute('data-ref-card-pinned', '');
      const scroll = c.locator('[data-ref-card-scroll]');
      expect(await scroll.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
      await scroll.hover();
      await page.mouse.wheel(0, 400);
      await expect.poll(() => scroll.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
      await page.mouse.move(1300, 880);
      await page.waitForTimeout(600);
      await expect(c).toBeVisible();
      await shot(page, 'light-pinned-scrolled');

      // A link in the body has no href at all, so nothing opens it: not a middle-click, a modified
      // click or the context menu. A click or Enter only asks; the confirm's Open is the one real link.
      await scroll.evaluate((el) => (el.scrollTop = 0));
      const report = c.getByRole('link', { name: 'the report' });
      expect(await scroll.locator('a[href]').count()).toBe(0);
      expect(await report.getAttribute('data-ref-card-href')).toBe('https://evil.example/phish');
      await report.click({ button: 'middle' });
      await report.click({ modifiers: ['ControlOrMeta'] });
      await page.waitForTimeout(300);
      expect(popups).toEqual([]);
      await report.focus();
      await page.keyboard.press('Enter');
      await expect(c.locator('[data-ref-card-confirm]')).toContainText('https://evil.example/phish');
      await c.locator('[data-ref-card-confirm]').getByRole('button', { name: 'Cancel' }).click();
      await expect(c.locator('[data-ref-card-confirm]')).toHaveCount(0);
      await report.click();
      await expect(c.locator('[data-ref-card-confirm] a')).toHaveAttribute('href', 'https://evil.example/phish');
      expect(popups).toEqual([]);
      await c.locator('[data-ref-card-confirm]').getByRole('button', { name: 'Cancel' }).click();
      // Raw-HTML links, and one inside <details>, are held the same way.
      for (const [name, url] of [
        ['the raw log', 'https://evil.example/raw'],
        ['the trace', 'https://evil.example/details'],
      ] as const) {
        const raw = c.getByRole('link', { name });
        expect(await raw.getAttribute('href')).toBeNull();
        expect(await raw.getAttribute('target')).toBeNull();
        expect(await raw.getAttribute('data-ref-card-href')).toBe(url);
        await raw.click({ button: 'middle' });
        await raw.click({ modifiers: ['ControlOrMeta'] });
        await page.waitForTimeout(300);
        expect(popups).toEqual([]);
        await raw.click();
        await expect(c.locator('[data-ref-card-confirm]')).toContainText(url);
        await c.locator('[data-ref-card-confirm]').getByRole('button', { name: 'Cancel' }).click();
        await raw.focus();
        await page.keyboard.press('Enter');
        await expect(c.locator('[data-ref-card-confirm]')).toContainText(url);
        await c.locator('[data-ref-card-confirm]').getByRole('button', { name: 'Cancel' }).click();
        expect(popups).toEqual([]);
      }
      expect(await scroll.locator('a[href]').count()).toBe(0);
      // The image is drawn as its alt text, never loaded; nothing in the card shows a native tooltip.
      await expect(c.locator('[data-image-unavailable]')).toHaveText('before');
      expect(await c.locator('img[src^="https://"]').count()).toBe(0);
      expect(await c.locator('[title]:not([title=""])').count()).toBe(0);

      // Escape closes it; the thread stays open.
      await page.keyboard.press('Escape');
      await expect(c).toHaveCount(0);
      await expect(page).toHaveURL(new RegExp(`#thread=${threadId}`));
      await expect(page.locator('[data-message-id]')).toBeVisible();

      // Draft, checks running, review required.
      await hover(page, issueHref(15));
      await expect(c.locator('[data-ref-card-state]')).toHaveText('Draft');
      await expect(c.locator('[data-ref-card-checks="pending"]')).toHaveText(/2 running · 1 passed/);
      await expect(c.locator('[data-ref-card-review]')).toHaveText('Review required');
      await shot(page, 'light-pr-draft');

      // An issue.
      await hover(page, issueHref(11));
      await expect(c.locator('[data-ref-card-state]')).toHaveText('Open');
      await expect(c).toContainText('good first issue');
      expect(await c.getAttribute('aria-label')).toBe('Issue #11: No way to pick a widget');
      await shot(page, 'light-issue');

      // Not found: quiet, and still a way to GitHub.
      await hover(page, issueHref(404));
      await expect(c.locator('[data-ref-card-error="not_found"]')).toBeVisible();
      await expect(c.locator('[data-ref-card-open]')).toHaveAttribute('href', issueHref(404));
      await shot(page, 'light-not-found');

      // A GitLab merge request, through glab.
      await hover(page, MR_URL);
      await expect(c.locator('[data-ref-card-title]')).toContainText('Cache the build layers !7');
      await expect(c.locator('[data-ref-card-checks="pending"]')).toHaveText(/Pipeline running · 2 of 4 jobs left/);
      await expect(c.locator('[data-ref-card-review]')).toHaveText('Review required');
      await expect(c.locator('[data-ref-card-branch]')).toHaveText('main ← ci/layer-cache');
      await expect(c.locator('[data-ref-card-open]')).toHaveText(/Open on GitLab/);
      expect(await c.getAttribute('aria-label')).toBe('Merge request !7: Cache the build layers');
      await shot(page, 'light-gitlab-mr');
      expect(forge.calls()).toContain('glab mr iid=7');

      // Keyboard: focus opens it, Tab moves in, Escape brings focus back to the link.
      await page.mouse.move(2, 2);
      await expect(c).toHaveCount(0);
      await page.keyboard.press('Shift');
      await ref(page, issueHref(12)).focus();
      await expect(c.locator('[data-ref-card-state]')).toBeVisible();
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => !!document.activeElement?.closest('[data-ref-card]'))).toBe(true);
      await page.keyboard.press('Escape');
      await expect(c).toHaveCount(0);
      expect(await ref(page, issueHref(12)).evaluate((el) => el === document.activeElement)).toBe(true);

      // One CLI call per ref over the whole run.
      expect([...forge.calls()].sort()).toEqual(['gh number=11', 'gh number=12', 'gh number=14', 'gh number=15', 'gh number=404', 'glab mr iid=7']);
      expect(popups).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test('dark', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'dark' });
    const page = await context.newPage();
    try {
      await page.goto(`${url}#thread=${threadId}`);
      await hover(page, issueHref(14));
      await shot(page, 'dark-pr-checks-failing');
      await hover(page, MR_URL);
      await shot(page, 'dark-gitlab-mr');
    } finally {
      await context.close();
    }
  });

  test('a phone: a tap shows the card as a sheet and never follows the link', async ({ browser }) => {
    const { defaultBrowserType: _ignored, ...iphone } = devices['iPhone 15'];
    const context = await browser.newContext({ ...iphone, colorScheme: 'light' });
    const popups: string[] = [];
    const page = await context.newPage();
    context.on('page', (p) => popups.push(p.url()));
    try {
      await page.goto(`${url}#thread=${threadId}`);
      const before = page.url();
      await ref(page, issueHref(12)).tap();
      const sheet = card(page);
      await expect(sheet.locator('[data-ref-card-state]')).toHaveText('Merged');
      await expect(sheet).toHaveAttribute('data-ref-card-sheet', '');
      expect(page.url()).toBe(before);
      expect(popups).toEqual([]);
      const open = await sheet.locator('[data-ref-card-open]').boundingBox();
      expect(open!.height).toBeGreaterThanOrEqual(44);
      await shot(page, 'phone-sheet-pr');
      // The scrim closes it, and the tap does not land on what is under it.
      await page.locator('[data-ref-card-scrim]').tap({ position: { x: 20, y: 40 } });
      await expect(sheet).toHaveCount(0);
      expect(page.url()).toBe(before);
      await ref(page, MR_URL).tap();
      await expect(sheet.locator('[data-ref-card-state]')).toHaveText('Open');
      await shot(page, 'phone-sheet-gitlab-mr');
    } finally {
      await context.close();
    }
  });
});
