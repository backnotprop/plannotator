/**
 * A click on a `#12` in an Inbox message opens the same card the hover shows, pinned, instead of going to GitHub
 * (the owner, 2026-11-22), and with Code review on the card of a PR Reviews lists has "Open in Reviews" beside "Open
 * on GitHub". Proved in a real browser against the compiled binary: `plannotator inbox --background` under a temp
 * PLANNOTATOR_DATA_DIR and HOME, `gh` and `glab` sh fakes first on PATH (the PR list and the cards; nothing reaches
 * GitHub, the real CLIs never run), an agent's message through `plannotator inbox mcp`.
 *
 * What is proved: a click pins the card (it stays when the pointer leaves), opens no tab, and shows both links in one
 * row; a second click and Escape close it, Escape giving the focus back to the link; Cmd/Ctrl-click still opens
 * GitHub in a new tab; Open in Reviews opens the PR's page in Reviews in the same window; an issue's card has only
 * GitHub's link; dark; on a phone a tap shows the sheet with both links in one row, which still fits with a long forge
 * name and at 320 px, no button and no comment count cut short (on the sheet the count is a line of its own above the row; beside the desktop row it drops to its icon and number first); with Code review off the card has only GitHub's link.
 * While a card is pinned, a hover on another ref opens nothing and a click there moves the pin; a link to a comment
 * on the PR follows the link with no card; a ref the forge does not know, once its hover card said so, follows the
 * link on a click (never a second click).
 *
 * Proof (PLANNOTATOR_E2E_PROOF_DIR/ref-card-click, `.local/proof` in CI): 01-inbox-pinned-reviews-on.png,
 * 02-inbox-pinned-reviews-off.png, 03-inbox-pinned-dark.png, 04-inbox-issue.png, 06-phone-tap.png (390 px), 07-phone-320.png, 08-phone-320-long-forge-name.png, 09-pinned-ignores-hover-light.png (05 is plan
 * review's, from ref-cards-review.spec.ts). Made-up people and repositories.
 */
import { devices, expect, test, type Browser, type BrowserContext, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'ref-card-click');

/** The real person's Inbox port: a spec's Inbox never takes it. */
const OWNER_INBOX_PORT = '59812';
const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
const REPO = 'acme/widgets';
const TITLE = 'Ship the widget picker';
/** A link to a comment on #12: it goes to that comment, never to #12's card. */
const PERMALINK = `https://github.com/${REPO}/pull/12#discussion_r7`;

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

function project(parent: string, name: string, origin: string): string {
  const dir = scratchProject(parent, name);
  const git = (...args: string[]) => {
    const run = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
    if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`);
  };
  git('checkout', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), `${name}\n`);
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('remote', 'add', 'origin', origin);
  return dir;
}

/** A fake gh: the signed-in account, the PR lists (the person's, Others), and a card per `-F number=N` (`card-N.json`). */
function writeForge(dir: string) {
  mkdirSync(dir, { recursive: true });
  const gh = [
    '#!/bin/sh',
    `dir='${dir}'`,
    'if [ "$1" = auth ] && [ "$2" = status ]; then',
    '  echo \'{"hosts":{"github.com":[{"login":"ada-novak","active":true,"state":"success","tokenSource":"keyring"}]}}\'',
    '  exit 0',
    'fi',
    'if [ "$1" = api ] && [ "$2" = graphql ]; then',
    '  case "$*" in *"query InboxPullsOthers"*) cat "$dir/gh-others.json"; exit 0;; esac',
    '  case "$*" in *"requested: search"*) cat "$dir/gh-pulls.json"; exit 0;; esac',
    '  n=""',
    '  for a; do case "$a" in number=*) n="${a#number=}";; esac; done',
    '  if [ -n "$n" ] && [ -f "$dir/card-$n.json" ]; then cat "$dir/card-$n.json"; exit 0; fi',
    '  echo "GraphQL: Could not resolve to an issue or pull request with the number of $n. (repository.issueOrPullRequest)" >&2',
    '  exit 1',
    'fi',
    'exit 1',
    '',
  ].join('\n');
  const glab = ['#!/bin/sh', 'if [ "$1" = auth ] && [ "$2" = status ]; then echo "not logged in" >&2; exit 1; fi', 'exit 1', ''].join('\n');
  for (const [file, body] of [['gh', gh], ['glab', glab]] as const) {
    writeFileSync(join(dir, file), body);
    chmodSync(join(dir, file), 0o755);
  }
}

/** PR #12 as the list reads it (the person's own, open). */
const LISTED = {
  number: 12,
  title: TITLE,
  url: `https://github.com/${REPO}/pull/12`,
  state: 'OPEN',
  isDraft: false,
  updatedAt: ago(30),
  mergedAt: null,
  baseRefName: 'main',
  headRefName: 'feat/widget-picker',
  headRefOid: '12'.padStart(40, '0'),
  additions: 120,
  deletions: 14,
  changedFiles: 6,
  reviewDecision: 'REVIEW_REQUIRED',
  repository: { nameWithOwner: REPO },
  headRepository: { nameWithOwner: REPO },
  author: { login: 'ada-novak' },
  reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', login: 'bob-tully' } }] },
  latestReviews: { nodes: [] },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
};
const GH_PULLS = {
  data: {
    viewer: { login: 'ada-novak' },
    rateLimit: { cost: 9, remaining: 4980, resetAt: ago(-40) },
    requested: { issueCount: 0, nodes: [] },
    assigned: { issueCount: 0, nodes: [] },
    authored: { issueCount: 1, nodes: [LISTED] },
    merged: { nodes: [] },
  },
};
const GH_OTHERS = { data: { viewer: { login: 'ada-novak' }, rateLimit: { cost: 3, remaining: 4977, resetAt: ago(-40) }, others0: { issueCount: 1, nodes: [LISTED] } } };

const person = (login: string) => ({ login, avatarUrl: null });
const CARD_12 = {
  data: {
    repository: {
      nameWithOwner: REPO,
      issueOrPullRequest: {
        __typename: 'PullRequest',
        number: 12,
        title: TITLE,
        url: `https://github.com/${REPO}/pull/12`,
        state: 'OPEN',
        isDraft: false,
        createdAt: ago(26 * 60),
        updatedAt: ago(60),
        closedAt: null,
        mergedAt: null,
        body: '## What\n\nA picker for widgets in the toolbar, so nobody opens the settings page to change one.',
        author: person('ada-novak'),
        labels: { nodes: [{ name: 'feature', color: 'a2eeef' }] },
        assignees: { nodes: [] },
        comments: { totalCount: 2, nodes: [{ author: person('charlie-dunn'), createdAt: ago(45), body: 'Looks right; one question on the keyboard order.' }] },
        baseRefName: 'main',
        headRefName: 'feat/widget-picker',
        additions: 120,
        deletions: 14,
        changedFiles: 6,
        reviewDecision: 'REVIEW_REQUIRED',
        closingIssuesReferences: { nodes: [{ number: 11, title: 'No way to pick a widget', url: `https://github.com/${REPO}/issues/11`, state: 'OPEN' }] },
        commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS', contexts: { totalCount: 2, nodes: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }, { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }] } } } }] },
      },
    },
  },
};
const CARD_11 = {
  data: {
    repository: {
      nameWithOwner: REPO,
      issueOrPullRequest: {
        __typename: 'Issue',
        number: 11,
        title: 'No way to pick a widget',
        url: `https://github.com/${REPO}/issues/11`,
        state: 'OPEN',
        stateReason: null,
        createdAt: ago(80 * 60),
        updatedAt: ago(3 * 60),
        closedAt: null,
        body: 'People open the settings page to change the widget. A picker in the toolbar would save the trip.',
        author: person('bob-tully'),
        labels: { nodes: [{ name: 'enhancement', color: 'a2eeef' }] },
        assignees: { nodes: [person('ada-novak')] },
        comments: { totalCount: 1, nodes: [{ author: person('ada-novak'), createdAt: ago(3 * 60), body: "I'll take it, PR soon." }] },
        closedByPullRequestsReferences: { nodes: [] },
      },
    },
  },
};

interface World {
  url: string;
  threadId: string;
}
let world: World;

test.describe.configure({ mode: 'serial' });
test.use({ actionTimeout: 20_000 });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-ref-card-click-e2e-');
  const dataDir = join(root, 'data');
  markTourDecided(dataDir);
  const configFile = join(dataDir, 'config.json');
  writeFileSync(configFile, JSON.stringify({ ...JSON.parse(readFileSync(configFile, 'utf8')), inboxBoard: false }));
  for (const dir of ['claude', 'codex', 'xdg']) mkdirSync(join(root, dir), { recursive: true });
  const forge = join(root, 'forge');
  writeForge(forge);
  writeFileSync(join(forge, 'gh-pulls.json'), JSON.stringify(GH_PULLS));
  writeFileSync(join(forge, 'gh-others.json'), JSON.stringify(GH_OTHERS));
  writeFileSync(join(forge, 'card-12.json'), JSON.stringify(CARD_12));
  writeFileSync(join(forge, 'card-11.json'), JSON.stringify(CARD_11));
  const widgets = project(join(root, 'src'), 'widgets', `https://github.com/${REPO}.git`);
  const env: Record<string, string> = {
    PATH: `${forge}:${process.env.PATH ?? ''}`,
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
  const url = started.stdout.trim();
  expect(new URL(url).port).not.toBe(OWNER_INBOX_PORT);
  const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  let threadId = '';
  try {
    const sent = await agent.send({ project_path: widgets, subject: 'The widget picker', body: `The widget picker is up for review as #12 (it closes #11; #13 is gone). Charlie asked about the keyboard order: ${PERMALINK}` });
    threadId = sent.thread_id as string;
  } finally {
    await agent.close().catch(() => {});
  }
  // `#12` links once the project's origin is read (in the background, inbox-repos.ts).
  await expect
    .poll(async () => ((await (await fetch(`${url}api/inbox/threads/${threadId}`)).json()) as { thread: { project: { repo: unknown } } }).thread.project.repo, { timeout: 20_000 })
    .toBeTruthy();
  const context = await browser.newContext();
  const on = await context.request.post(`${url}api/inbox/settings`, { data: { code_review: { on: true } } });
  expect(on.status()).toBe(200);
  await context.close();
  world = { url, threadId };
});

test.afterAll(async () => {
  await removeInboxScratch();
});

const card = (page: Page) => page.locator('[data-ref-card]');
const ref = (page: Page, n: number) => page.locator(`[data-message-id] a[href="https://github.com/${REPO}/issues/${n}"]`).first();

async function proof(page: Page, name: string) {
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(proofDir, `${name}.png`) });
}

/** The thread, once the Reviews list (the read Code review keeps for its count) has landed in the window. */
async function openThread(page: Page, listed = true): Promise<void> {
  const rows = listed ? page.waitForResponse((r) => /\/api\/inbox\/reviews$/.test(new URL(r.url()).pathname) && !new URL(r.url()).search.includes('cached')) : null;
  // A fresh load (a hash change alone would read nothing).
  await page.goto('about:blank');
  await page.goto(`${world.url}#thread=${world.threadId}`);
  await rows;
  await expect(ref(page, 12)).toBeVisible();
  await page.waitForTimeout(300);
}

/** A context whose pages never reach GitHub (a tab a click opens gets a stub), with every page it opens noted. */
async function newContext(browser: Browser, options: Parameters<Browser['newContext']>[0]): Promise<{ context: BrowserContext; page: Page; popups: string[] }> {
  const context = await browser.newContext(options);
  await context.route('https://github.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>stub</title>' }));
  const page = await context.newPage();
  const popups: string[] = [];
  context.on('page', (p) => {
    if (p !== page) popups.push(p.url());
  });
  return { context, page, popups };
}

/**
 * The footer holds its buttons in one row, inside the card: nothing past its edge, no second row, no button cut
 * short of its words, and the comment count's words whole (not clipped). On the phone's sheet the count is a line of
 * its own above the row. Returns the count's form (FootWords).
 */
async function footFits(page: Page, at: string): Promise<string | null> {
  const foot = card(page).locator('[data-ref-card-foot]');
  let form: string | null = null;
  let seen = '';
  // The count picks its form once the room is known (a ResizeObserver): settled within a frame or two.
  await expect(async () => {
    const fit = await foot.evaluate((el) => {
      // The sheet's buttons stay inside its row (the footer's padding is no room for them).
      const box = (el.querySelector('[data-ref-card-row]') ?? el).getBoundingClientRect();
      const controls = [...el.querySelectorAll<HTMLElement>('button, a')];
      const buttons = controls.map((b) => b.getBoundingClientRect());
      const count = el.querySelector<HTMLElement>('[data-ref-card-count]');
      return {
        inside: buttons.every((b) => b.left >= box.left - 0.5 && b.right <= box.right + 0.5),
        oneRow: buttons.every((b) => Math.abs(b.top - buttons[0]!.top) < 1),
        overflow: el.scrollWidth - el.clientWidth,
        buttonsWhole: controls.every((b) => b.scrollWidth <= b.clientWidth),
        countWhole: !count || count.scrollWidth <= count.clientWidth,
      // The sheet: the count's line above the buttons (none of them beside it); elsewhere beside them.
      countAbove: !count || !el.closest('[data-ref-card-sheet]') || buttons.every((b) => count.getBoundingClientRect().bottom <= b.top + 0.5),
        form: count?.getAttribute('data-ref-card-count-form') ?? null,
        // Named in a failure: the room and what took it.
        sizes: `${el.querySelector('[data-ref-card-close-icon]') ? 'Close as ×; ' : ''}foot ${Math.round(el.clientWidth)}; count ${count ? `${count.clientWidth}/${count.scrollWidth}` : 'none'}; ${controls.map((b) => `${b.textContent?.trim()} ${b.clientWidth}/${b.scrollWidth}`).join('; ')}`,
      };
    });
    const { form: shown, sizes, ...rest } = fit;
    expect(rest, `${at}: ${sizes}`).toEqual({ inside: true, oneRow: true, overflow: 0, buttonsWhole: true, countWhole: true, countAbove: true });
    form = shown;
    seen = sizes;
  }).toPass({ timeout: 3_000 });
  console.log(`ref card footer at ${at}: the count's form is ${form} (${seen})`);
  return form;
}

test('a click pins the card with Open in Reviews beside Open on GitHub; Escape, a second click, Cmd/Ctrl-click; Open in Reviews opens the PR in Reviews', async ({ browser }) => {
  const { context, page, popups } = await newContext(browser, { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light' });
  try {
    await openThread(page);
    const pr = ref(page, 12);
    await pr.click();
    const c = card(page);
    await expect(c).toHaveAttribute('data-ref-card-pinned', '');
    await expect(c.locator('[data-ref-card-title]')).toContainText(TITLE);
    const action = c.locator('[data-ref-card-action]');
    const forge = c.locator('[data-ref-card-open]');
    await expect(action).toHaveText('Open in Reviews');
    await expect(forge).toHaveText(/Open on GitHub/);
    // One row, the Inbox's link left of GitHub's.
    const a = (await action.boundingBox())!;
    const f = (await forge.boundingBox())!;
    expect(Math.abs(a.y + a.height / 2 - (f.y + f.height / 2))).toBeLessThan(1);
    expect(a.x + a.width).toBeLessThanOrEqual(f.x);
    await footFits(page, 'desktop, pinned');
    // Pinned: the pointer leaving does not close it, and nothing opened.
    await page.mouse.move(2, 2);
    await page.waitForTimeout(600);
    await expect(c).toBeVisible();
    expect(popups).toEqual([]);
    await expect(page).toHaveURL(new RegExp(`#thread=${world.threadId}`));
    await proof(page, '01-inbox-pinned-reviews-on');

    // A second click on the link closes it.
    await pr.click();
    await expect(c).toHaveCount(0);
    // Escape closes it, gives the focus back to the link, and leaves the thread open.
    await pr.click();
    await expect(c).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(c).toHaveCount(0);
    expect(await pr.evaluate((el) => el === document.activeElement)).toBe(true);
    await expect(page.locator('[data-message-id]')).toBeVisible();
    expect(popups).toEqual([]);

    // Cmd/Ctrl-click is the browser's: the page lets it through (nothing cancels it, no card pinned), and GitHub
    // opens in a new tab, as a link does. Headless Chromium opens no tab for the first Ctrl-click on this link (seen
    // in CI: the page had let the click through), and does for the next one: the first proves the page leaves the
    // click alone, the next one the tab.
    await page.mouse.move(2, 2);
    await pr.evaluate((el) => {
      const w = window as unknown as { __refClicks: { modified: boolean; prevented: boolean }[] };
      w.__refClicks = [];
      // The window's last listener, bubbling: what every handler in the page left of the click.
      window.addEventListener('click', (e) => {
        if (e.target instanceof Node && el.contains(e.target)) w.__refClicks.push({ modified: e.ctrlKey || e.metaKey, prevented: e.defaultPrevented });
      });
    });
    const clicks = () => page.evaluate(() => (window as unknown as { __refClicks: unknown[] }).__refClicks);
    await pr.click({ modifiers: ['ControlOrMeta'] });
    expect(await clicks()).toEqual([{ modified: true, prevented: false }]);
    // The pointer resting on the link may bring its hover card; the click pinned none.
    await expect(page.locator('[data-ref-card-pinned]')).toHaveCount(0);
    await page.waitForTimeout(1_000);
    for (const p of context.pages()) if (p !== page) await p.close();
    const [tab] = await Promise.all([context.waitForEvent('page'), pr.click({ modifiers: ['ControlOrMeta'] })]);
    await tab.waitForLoadState();
    expect(tab.url()).toBe(`https://github.com/${REPO}/issues/12`);
    expect(await clicks()).toEqual([
      { modified: true, prevented: false },
      { modified: true, prevented: false },
    ]);
    await expect(page.locator('[data-ref-card-pinned]')).toHaveCount(0);
    await tab.close();
    await page.mouse.move(2, 2);

    // Open in Reviews: the PR's page in Reviews, in this window.
    await pr.click();
    await c.locator('[data-ref-card-action]').click();
    await expect(c).toHaveCount(0);
    await expect(page).toHaveURL(/#reviews.*stack=/);
    await expect(page.locator('[data-launchpad]')).toContainText(TITLE);
    // Only the Cmd/Ctrl-clicks' tabs (the first one's, should a browser open it).
    expect(popups.length).toBeGreaterThanOrEqual(1);
    expect(popups.every((u) => u === `https://github.com/${REPO}/issues/12`)).toBe(true);

    // An issue: the card, GitHub's link alone.
    await openThread(page);
    await ref(page, 11).click();
    await expect(c.locator('[data-ref-card-title]')).toContainText('No way to pick a widget');
    await expect(c.locator('[data-ref-card-state]')).toHaveText('Open');
    await expect(c.locator('[data-ref-card-action]')).toHaveCount(0);
    await expect(c.locator('[data-ref-card-open]')).toHaveText(/Open on GitHub/);
    await page.mouse.move(2, 2);
    await proof(page, '04-inbox-issue');
  } finally {
    await context.close();
  }
});

test('pinned: a hover on another ref opens nothing, a click there moves the pin; a comment link and a ref with no card follow the link', async ({ browser }) => {
  const { context, page, popups } = await newContext(browser, { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light' });
  try {
    await openThread(page);
    await ref(page, 12).click();
    const c = card(page);
    await expect(c.locator('[data-ref-card-title]')).toContainText(TITLE);
    // The pointer rests on #11 well past the hover delay: still one card, #12's, pinned.
    await ref(page, 11).hover();
    await page.waitForTimeout(900);
    await expect(c).toHaveCount(1);
    await expect(c).toHaveAttribute('data-ref-card-pinned', '');
    await expect(c.locator('[data-ref-card-title]')).toContainText(TITLE);
    await proof(page, '09-pinned-ignores-hover-light');
    // A click on #11 moves the pin there.
    await ref(page, 11).click();
    await expect(c.locator('[data-ref-card-title]')).toContainText('No way to pick a widget');
    await expect(c).toHaveAttribute('data-ref-card-pinned', '');
    await page.keyboard.press('Escape');
    await expect(c).toHaveCount(0);
    expect(popups).toEqual([]);

    // A link to a comment on #12 goes to that comment: a new tab, no card pinned.
    const toComment = context.waitForEvent('page');
    await page.locator(`[data-message-id] a[href="${PERMALINK}"]`).first().click();
    const commentTab = await toComment;
    await commentTab.waitForLoadState();
    expect(commentTab.url()).toBe(PERMALINK);
    await expect(page.locator('[data-ref-card-pinned]')).toHaveCount(0);
    await commentTab.close();

    // #13: the forge does not know it. Its hover card says so; then a click opens it on GitHub, the first time.
    await page.mouse.move(2, 2);
    await ref(page, 13).hover();
    await expect(c.locator('[data-ref-card-error]')).toBeVisible();
    const toForge = context.waitForEvent('page');
    await ref(page, 13).click();
    const forgeTab = await toForge;
    await forgeTab.waitForLoadState();
    expect(forgeTab.url()).toBe(`https://github.com/${REPO}/issues/13`);
    await expect(page.locator('[data-ref-card-pinned]')).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('dark', async ({ browser }) => {
  const { context, page } = await newContext(browser, { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'dark' });
  try {
    await openThread(page);
    await ref(page, 12).click();
    await expect(card(page).locator('[data-ref-card-action]')).toHaveText('Open in Reviews');
    await page.mouse.move(2, 2);
    await proof(page, '03-inbox-pinned-dark');
  } finally {
    await context.close();
  }
});

test('a phone: a tap shows the sheet with both links in one row, which fits with a long forge name and at 320 px', async ({ browser }) => {
  const { defaultBrowserType: _ignored, ...iphone } = devices['iPhone 15'];
  const { context, page, popups } = await newContext(browser, { ...iphone, colorScheme: 'light' });
  try {
    await openThread(page);
    const before = page.url();
    await ref(page, 12).tap();
    const sheet = card(page);
    await expect(sheet).toHaveAttribute('data-ref-card-sheet', '');
    await expect(sheet.locator('[data-ref-card-action]')).toHaveText('Open in Reviews');
    expect(page.url()).toBe(before);
    expect(popups).toEqual([]);
    expect((await sheet.locator('[data-ref-card-action]').boundingBox())!.height).toBeGreaterThanOrEqual(44);
    // On its own line the count has the sheet's width: its words in full.
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await footFits(page, '390 px')).toBe('full');
    await proof(page, '06-phone-tap');
    await page.setViewportSize({ width: 320, height: 640 });
    expect(await footFits(page, '320 px')).toBe('full');
    // GitHub's three buttons fit at 320 with the narrow padding: Close keeps its word.
    await expect(sheet.locator('[data-ref-card-close-icon]')).toHaveCount(0);
    await expect(sheet.locator('[data-ref-card-close]')).toHaveText('Close');
    await proof(page, '07-phone-320');
    await page.setViewportSize({ width: 390, height: 844 });
    // The longest forge name ("Open on Bitbucket"), then the narrowest phone: still one row, inside the sheet.
    await sheet.locator('[data-ref-card-open]').evaluate((el) => {
      const arrow = el.querySelector('span');
      el.textContent = 'Open on Bitbucket ';
      if (arrow) el.appendChild(arrow);
    });
    await footFits(page, '390 px, Bitbucket');
    await expect(sheet.locator('[data-ref-card-close-icon]')).toHaveCount(0);
    // At 320 the longest forge name leaves no room for the word: Close is its ×, still named Close.
    await page.setViewportSize({ width: 320, height: 640 });
    await footFits(page, '320 px, Bitbucket');
    await expect(sheet.locator('[data-ref-card-close-icon]')).toHaveCount(1);
    await expect(sheet.locator('[data-ref-card-close]')).toHaveAccessibleName('Close');
    await proof(page, '08-phone-320-long-forge-name');
    // Room again: the word comes back.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(sheet.locator('[data-ref-card-close]')).toHaveText('Close');
    await expect(sheet.locator('[data-ref-card-open]')).toHaveText(/Open on Bitbucket/);
  } finally {
    await context.close();
  }
});

test('Code review off: the card has GitHub’s link alone', async ({ browser }) => {
  const { context, page } = await newContext(browser, { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light' });
  try {
    const off = await page.request.post(`${world.url}api/inbox/settings`, { data: { code_review: { on: false } } });
    expect(off.status()).toBe(200);
    await openThread(page, false);
    await ref(page, 12).click();
    const c = card(page);
    await expect(c).toHaveAttribute('data-ref-card-pinned', '');
    await expect(c.locator('[data-ref-card-title]')).toContainText(TITLE);
    await expect(c.locator('[data-ref-card-action]')).toHaveCount(0);
    await expect(c.locator('[data-ref-card-open]')).toHaveText(/Open on GitHub/);
    await page.mouse.move(2, 2);
    await proof(page, '02-inbox-pinned-reviews-off');
  } finally {
    await context.close();
  }
});
