/**
 * Hover cards for issue, PR and MR links in plan review, annotate and code review,
 * proved in a real Chromium against the compiled binary. Each session runs in
 * a scratch git repository whose `origin` is github.com/acme/widgets, under a
 * temp PLANNOTATOR_DATA_DIR and HOME, with a scripted `gh` and `glab` first on
 * PATH (fake-forge.ts: no real GitHub or GitLab, every call logged).
 *
 * Proves, in plan review: the plan's bare `#12` links into the repo and shows
 * its card after the pointer rests on it, read through `gh` once; nothing is
 * asked before a hover; a ref the forge does not know shows no card at all and
 * stays the plain link it was. In annotate: the same `#12` in a Markdown file
 * shows its card. In code review: a pasted PR link in a changed Markdown
 * file's Read view shows its card. The keyboard (plan review): Tab to `#12`
 * opens its card, Tab moves into it, Escape closes it, returns the focus to
 * the link and stops there. A touch screen (plan review): a tap follows the
 * link (the opened tab is stubbed), with no card and no CLI run. The card's
 * height (code review): a long description shows about eight lines (a 216 px
 * box) before it scrolls; in a window too short for the card (1440 by 480),
 * the header scrolls with the description and Open on GitHub stays in view.
 *
 * Screenshots (light and dark) go to PLANNOTATOR_REF_CARD_REVIEW_SHOTS when it
 * is set. Build the binary first (see inbox.spec.ts), then
 * `bun run test:e2e:inbox`.
 */

import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';
import { fakeForge, type FakeForge } from './fake-forge';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shots = process.env.PLANNOTATOR_REF_CARD_REVIEW_SHOTS ?? '';

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const person = (login: string) => ({ login, avatarUrl: null });

const LONG_BODY = Array.from(
  { length: 6 },
  (_, i) => `Paragraph ${i + 1}. On a cold load the widget list renders, then jumps by one row height, then settles. It takes about a second and happens on every reload after the browser was closed.`,
).join('\n\n');

function seed(forge: FakeForge) {
  forge.github(21, {
    data: {
      repository: {
        nameWithOwner: 'acme/widgets',
        issueOrPullRequest: {
          __typename: 'Issue',
          number: 21,
          title: 'Widget list jitters after a cold load',
          url: 'https://github.com/acme/widgets/issues/21',
          state: 'OPEN',
          stateReason: null,
          createdAt: hoursAgo(80),
          updatedAt: hoursAgo(3),
          closedAt: null,
          body: LONG_BODY,
          author: person('sam'),
          labels: { nodes: [{ name: 'bug', color: 'd73a4a' }] },
          assignees: { nodes: [] },
          comments: { totalCount: 0, nodes: [] },
          closedByPullRequestsReferences: { nodes: [] },
        },
      },
    },
  });
  forge.github(12, {
    data: {
      repository: {
        nameWithOwner: 'acme/widgets',
        issueOrPullRequest: {
          __typename: 'Issue',
          number: 12,
          title: 'Widgets wobble on Tuesdays',
          url: 'https://github.com/acme/widgets/issues/12',
          state: 'OPEN',
          stateReason: null,
          createdAt: hoursAgo(50),
          updatedAt: hoursAgo(2),
          closedAt: null,
          body: 'Every Tuesday the widget list jitters for a second after load. Seen on Chrome and Safari.',
          author: person('sam'),
          labels: { nodes: [{ name: 'bug', color: 'd73a4a' }, { name: 'ui', color: '1d76db' }] },
          assignees: { nodes: [person('ada')] },
          comments: { totalCount: 3, nodes: [{ author: person('ada'), createdAt: hoursAgo(2), body: 'The cache reload is the cause; fix in #14.' }] },
          closedByPullRequestsReferences: { nodes: [] },
        },
      },
    },
  });
  forge.github(14, {
    data: {
      repository: {
        nameWithOwner: 'acme/widgets',
        issueOrPullRequest: {
          __typename: 'PullRequest',
          number: 14,
          title: 'One store for the widget cache',
          url: 'https://github.com/acme/widgets/pull/14',
          state: 'OPEN',
          isDraft: false,
          createdAt: hoursAgo(20),
          updatedAt: hoursAgo(1),
          closedAt: null,
          mergedAt: null,
          body: '## What\n\nMoves the widget cache to one store so the list stops jittering.',
          author: person('ada'),
          labels: { nodes: [{ name: 'fix', color: '0e8a16' }] },
          assignees: { nodes: [] },
          comments: { totalCount: 1, nodes: [{ author: person('lin'), createdAt: hoursAgo(1), body: 'Looks right to me.' }] },
          baseRefName: 'main',
          headRefName: 'fix/one-cache',
          additions: 120,
          deletions: 14,
          changedFiles: 6,
          reviewDecision: 'APPROVED',
          closingIssuesReferences: { nodes: [{ number: 12, title: 'Widgets wobble on Tuesdays', url: 'https://github.com/acme/widgets/issues/12', state: 'OPEN' }] },
          commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS', contexts: { totalCount: 2, nodes: [
            { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
            { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
          ] } } } }] },
        },
      },
    },
  });
}

function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
}

const PLAN = `# Stop the widget jitter

The list jitters after load (#12). The fix is already open as https://github.com/acme/widgets/pull/14.

## Steps

1. Merge the two caches into one store.
2. Keep #99 in mind for the follow-up.
`;

const DOC_AFTER = `# Doc

Hello.

Tracking: https://github.com/acme/widgets/pull/14

Root cause: https://github.com/acme/widgets/issues/21
`;

interface Session {
  url: string;
  forge: FakeForge;
  close: () => Promise<void>;
}

/** Plan review (`plannotator` reading a PermissionRequest on stdin), `plannotator annotate plan.md` or `plannotator review`, in a repo whose origin is GitHub. */
async function start(kind: 'plan' | 'annotate' | 'review'): Promise<Session> {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-ref-cards-review-e2e-');
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  const forge = fakeForge(join(root, 'forge'));
  seed(forge);
  const cwd = join(root, 'repo');
  mkdirSync(cwd, { recursive: true });
  git(cwd, 'init', '-q', '-b', 'main');
  git(cwd, 'config', 'user.email', 'e2e@example.com');
  git(cwd, 'config', 'user.name', 'e2e');
  git(cwd, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git');
  writeFileSync(join(cwd, 'doc.md'), '# Doc\n\nHello.\n');
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-qm', 'init');
  if (kind === 'review') writeFileSync(join(cwd, 'doc.md'), DOC_AFTER);
  if (kind === 'annotate') writeFileSync(join(cwd, 'plan.md'), PLAN);
  const readyFile = join(root, 'ready.jsonl');
  const env = {
    PATH: `${forge.dir}:${process.env.PATH ?? ''}`,
    HOME: root,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_READY_FILE: readyFile,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_BROWSER,
    PLANNOTATOR_SKIP_BROWSER_OPEN: '1',
    PLANNOTATOR_REMOTE: '0',
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_AI: 'disabled',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_GIT_REMOTE_CHECK: '0',
  };
  let child: ChildProcess;
  if (kind === 'review') {
    child = spawn(binary, ['review'], { env, cwd, stdio: 'ignore' });
  } else if (kind === 'annotate') {
    child = spawn(binary, ['annotate', 'plan.md'], { env, cwd, stdio: 'ignore' });
  } else {
    child = spawn(binary, [], { env, cwd, stdio: ['pipe', 'ignore', 'ignore'] });
    child.stdin!.end(
      JSON.stringify({
        session_id: 'e2e',
        transcript_path: join(root, 'transcript.jsonl'),
        cwd,
        permission_mode: 'plan',
        hook_event_name: 'PermissionRequest',
        tool_name: 'ExitPlanMode',
        tool_input: { plan: PLAN },
      }),
    );
  }
  await expect.poll(() => (existsSync(readyFile) ? readFileSync(readyFile, 'utf8') : ''), { timeout: 30_000 }).toContain('"url"');
  const url = (JSON.parse(readFileSync(readyFile, 'utf8').trim().split('\n')[0]!) as { url: string }).url;
  const close = async () => {
    await fetch(new URL('/api/exit', url), { method: 'POST' }).catch(() => {});
    if (child.exitCode === null) {
      await new Promise((done) => {
        const timer = setTimeout(done, 5_000);
        child.once('exit', () => {
          clearTimeout(timer);
          done(undefined);
        });
      });
      // inbox-guard: own child (the CLI this test spawned, never an Inbox)
      if (child.exitCode === null) child.kill('SIGTERM');
    }
    await removeInboxScratch(root);
  };
  return { url, forge, close };
}

async function open(browser: Browser, url: string, scheme: 'light' | 'dark', extra: [string, string][] = [], height = 900): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height }, colorScheme: scheme });
  const seen: [string, string][] = [
    ['plannotator-theme', scheme],
    ['plannotator-plan-look-choice-resolved', 'true'],
    ['plannotator-look-feel-announcement-seen', '2'],
    ['plannotator-edit-mode-announcement-seen', '3'],
    ['plannotator-announce-tui-herdr-seen', '1'],
    ['plannotator-announce-inbox-seen', '1'],
    ['plannotator-announce-ask-session-seen', '1'],
    ['plannotator-announce-agent-tool-seen', '1'],
    ['plannotator-permission-mode-configured', 'true'],
    ['plannotator-guide-intro-seen', '1'],
    ['plannotator-review-dest-spotlight-seen', '1'],
    ['plannotator-auto-viewed-notice-seen', '1'],
    ...extra,
  ];
  await context.addCookies(seen.map(([name, value]) => ({ name, value, url })));
  const page = await context.newPage();
  await page.goto(url);
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(400);
    if ((await page.locator('.fixed.inset-0').count()) === 0) break;
    await page.keyboard.press('Escape');
  }
  return page;
}

async function shot(page: Page, name: string) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(shots, `${name}.png`) });
}

let browser: Browser;
test.beforeAll(async () => {
  browser = await chromium.launch({ args: ['--use-mock-keychain', '--password-store=basic'] });
});
test.afterAll(async () => {
  await browser?.close();
});

test('plan review: a #12 in the plan shows its card; an unknown ref shows none', async () => {
  for (const scheme of ['light', 'dark'] as const) {
    const session = await start('plan');
    try {
      const page = await open(browser, session.url, scheme);
      const issue = page.locator('a[href="https://github.com/acme/widgets/issues/12"]').first();
      await expect(issue).toBeVisible();
      // Drawing the plan runs no forge CLI.
      await page.waitForTimeout(600);
      expect(session.forge.calls()).toEqual([]);

      await issue.hover();
      const card = page.locator('[data-ref-card]');
      await expect(card).toContainText('Widgets wobble on Tuesdays');
      await expect(card).toContainText('acme/widgets');
      expect(session.forge.calls()).toEqual(['gh number=12']);
      await shot(page, `plan-review-issue-${scheme}`);

      // The pasted PR link gets its card too.
      await page.mouse.move(5, 5);
      await expect(card).toHaveCount(0);
      await page.locator('a[href="https://github.com/acme/widgets/pull/14"]').first().hover();
      await expect(card).toContainText('One store for the widget cache');
      await shot(page, `plan-review-pull-${scheme}`);

      if (scheme === 'light') {
        // A ref the forge does not know: asked once, no card, the link unchanged.
        await page.mouse.move(5, 5);
        await expect(card).toHaveCount(0);
        const unknown = page.locator('a[href="https://github.com/acme/widgets/issues/99"]').first();
        await unknown.hover();
        await expect.poll(() => session.forge.calls()).toContain('gh number=99');
        await page.waitForTimeout(500);
        await expect(card).toHaveCount(0);
        await expect(unknown).toHaveAttribute('target', '_blank');
      }
      await page.context().close();
    } finally {
      await session.close();
    }
  }
});

test('annotate: a #12 in the Markdown file shows its card', async () => {
  for (const scheme of ['light', 'dark'] as const) {
    const session = await start('annotate');
    try {
      const page = await open(browser, session.url, scheme);
      const issue = page.locator('a[href="https://github.com/acme/widgets/issues/12"]').first();
      await expect(issue).toBeVisible();
      await page.waitForTimeout(600);
      expect(session.forge.calls()).toEqual([]);
      await issue.hover();
      const card = page.locator('[data-ref-card]');
      await expect(card).toContainText('Widgets wobble on Tuesdays');
      expect(session.forge.calls()).toEqual(['gh number=12']);
      await shot(page, `annotate-issue-${scheme}`);
      await page.context().close();
    } finally {
      await session.close();
    }
  }
});

test('code review: a PR link in a changed Markdown file shows its card', async () => {
  for (const scheme of ['light', 'dark'] as const) {
    const session = await start('review');
    try {
      const page = await open(browser, session.url, scheme, [['plannotator-markdown-view', 'read']]);
      await page.getByText('doc.md', { exact: true }).first().click();
      const link = page.locator('a[href="https://github.com/acme/widgets/pull/14"]').first();
      await expect(link).toBeVisible();
      await page.waitForTimeout(600);
      expect(session.forge.calls()).toEqual([]);
      await link.hover();
      const card = page.locator('[data-ref-card]');
      await expect(card).toContainText('One store for the widget cache');
      await expect(card).toContainText('fix/one-cache');
      expect(session.forge.calls()).toEqual(['gh number=14']);
      await shot(page, `code-review-pull-${scheme}`);
      await page.context().close();
    } finally {
      await session.close();
    }
  }
});

const ISSUE_12 = 'https://github.com/acme/widgets/issues/12';
const focusedHref = (page: Page) => page.evaluate(() => (document.activeElement as HTMLAnchorElement | null)?.href ?? null);

test('plan review: the keyboard opens the card on focus, Tab moves into it, Escape closes it and returns to the link', async () => {
  const session = await start('plan');
  try {
    const page = await open(browser, session.url, 'light');
    await expect(page.locator(`a[href="${ISSUE_12}"]`).first()).toBeVisible();
    // Tab until the link has the focus (the keyboard's own focus, so :focus-visible).
    let reached = false;
    for (let i = 0; i < 80 && !reached; i++) {
      await page.keyboard.press('Tab');
      reached = (await focusedHref(page)) === ISSUE_12;
    }
    expect(reached, 'Tab reaches the #12 link').toBe(true);
    const card = page.locator('[data-ref-card]');
    await expect(card).toContainText('Widgets wobble on Tuesdays');
    expect(session.forge.calls()).toEqual(['gh number=12']);

    // Tab goes into the card, not past it.
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('[data-ref-card]'))).toBe(true);

    // Escape closes the card, gives the focus back to the link, and the app's own Escape does not also run.
    await page.evaluate(() => {
      const w = window as unknown as { escapes: number };
      w.escapes = 0;
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') w.escapes++;
      });
    });
    await page.keyboard.press('Escape');
    await expect(card).toHaveCount(0);
    expect(await focusedHref(page)).toBe(ISSUE_12);
    expect(await page.evaluate(() => (window as unknown as { escapes: number }).escapes)).toBe(0);
    await page.context().close();
  } finally {
    await session.close();
  }
});

test('plan review on a touch screen: a tap follows the link, shows no card and runs no CLI', async () => {
  const session = await start('plan');
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, colorScheme: 'light' });
    // The tab the tap opens never reaches the real GitHub.
    await context.route('https://github.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>stub</title>' }));
    const seen: [string, string][] = [
      ['plannotator-theme', 'light'],
      ['plannotator-plan-look-choice-resolved', 'true'],
      ['plannotator-look-feel-announcement-seen', '2'],
      ['plannotator-edit-mode-announcement-seen', '3'],
      ['plannotator-announce-tui-herdr-seen', '1'],
      ['plannotator-announce-inbox-seen', '1'],
      ['plannotator-announce-ask-session-seen', '1'],
      ['plannotator-announce-agent-tool-seen', '1'],
      ['plannotator-permission-mode-configured', 'true'],
    ];
    await context.addCookies(seen.map(([name, value]) => ({ name, value, url: session.url })));
    const page = await context.newPage();
    await page.goto(session.url);
    for (let i = 0; i < 6; i++) {
      await page.waitForTimeout(400);
      if ((await page.locator('.fixed.inset-0').count()) === 0) break;
      await page.keyboard.press('Escape');
    }
    const issue = page.locator(`a[href="${ISSUE_12}"]`).first();
    await issue.scrollIntoViewIfNeeded();
    await expect(issue).toBeVisible();
    const opened = context.waitForEvent('page');
    await issue.tap();
    const tab = await opened;
    await tab.waitForLoadState();
    expect(tab.url()).toBe(ISSUE_12);
    await page.waitForTimeout(800);
    await expect(page.locator('[data-ref-card]')).toHaveCount(0);
    expect(session.forge.calls()).toEqual([]);
    await context.close();
  } finally {
    await session.close();
  }
});

test('code review: a long description shows about eight lines before it scrolls', async () => {
  const session = await start('review');
  try {
    const page = await open(browser, session.url, 'light', [['plannotator-markdown-view', 'read']]);
    await page.getByText('doc.md', { exact: true }).first().click();
    await page.locator('a[href="https://github.com/acme/widgets/issues/21"]').first().hover();
    const card = page.locator('[data-ref-card]');
    await expect(card).toContainText('Widget list jitters after a cold load');
    // Room enough below the link: the description is the one scroller.
    const body = card.locator('[data-ref-card-scroll]');
    const box = await body.evaluate((el) => ({ height: el.getBoundingClientRect().height, scrolls: el.scrollHeight > el.clientHeight }));
    // Capped (it scrolls), at 216 px: 132 px (about five lines) before.
    expect(box.scrolls).toBe(true);
    expect(box.height).toBeGreaterThanOrEqual(212);
    expect(box.height).toBeLessThanOrEqual(216);
    await shot(page, 'code-review-long-issue-light');
    await page.context().close();
  } finally {
    await session.close();
  }
});

test('code review in a short window: the header scrolls with the description and Open on GitHub stays in view', async () => {
  const session = await start('review');
  try {
    // 480: the card kept its footer but squeezed the description to a line. 400: the footer was cut off.
    for (const height of [480, 400]) {
      const page = await open(browser, session.url, 'light', [['plannotator-markdown-view', 'read']], height);
      await page.getByText('doc.md', { exact: true }).first().click();
      const link = page.locator('a[href="https://github.com/acme/widgets/pull/14"]').first();
      await link.evaluate((el) => el.scrollIntoView({ block: 'center' }));
      await page.waitForTimeout(300);
      await link.hover();
      const card = page.locator('[data-ref-card]');
      await expect(card).toContainText('One store for the widget cache');

      const c = (await card.boundingBox())!;
      expect(c.y).toBeGreaterThanOrEqual(0);
      expect(c.y + c.height).toBeLessThanOrEqual(height);
      // The footer's Open on GitHub sits whole inside the card (the card clips what does not fit).
      const openBox = (await card.locator('[data-ref-card-open]').boundingBox())!;
      expect(openBox.y).toBeGreaterThanOrEqual(c.y);
      expect(openBox.y + openBox.height).toBeLessThanOrEqual(c.y + c.height);

      // One scroller holds the title and the description, with all the room the footer leaves (not a line of it).
      const scroller = card.locator('[data-ref-card-scroll]');
      await expect(scroller.locator('[data-ref-card-title]')).toHaveCount(1);
      const room = await scroller.evaluate((el) => ({ height: el.clientHeight, scrolls: el.scrollHeight > el.clientHeight }));
      expect(room.scrolls).toBe(true);
      expect(room.height).toBeGreaterThanOrEqual(c.height - (openBox.height + 24));
      // Scrolling it brings the description's end and the comment into view, above the footer.
      await scroller.hover();
      await page.mouse.wheel(0, 600);
      await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
      await expect(card).toBeVisible();
      const comment = (await card.locator('[data-ref-card-comment]').boundingBox())!;
      expect(comment.y + comment.height).toBeLessThanOrEqual(openBox.y);
      await shot(page, `code-review-short-window-${height}-light`);
      await page.context().close();
    }
  } finally {
    await session.close();
  }
});
