/**
 * The Board page (approval "inbox-board", step 2) in a real browser against
 * the compiled binary, with agents writing through `plannotator inbox mcp`
 * (scripts/inbox-sim.ts) and a scripted `gh` first on PATH (fake-forge.ts:
 * no real GitHub, every call logged):
 *
 *  - the first visit shows "Your Board" once; Copy prompt copies the Board
 *    prompt; a reload does not show it again; the "?" opens it again;
 *  - an empty Board says "No cards yet";
 *  - cards an agent makes and moves through the `card` tool appear live, bold
 *    until opened; "You: …" in Your look and Your review;
 *  - an agent's drop shows above the lanes until "Got it";
 *  - the opened card: the panel beside the lanes, its links' live state read
 *    only when it opens, the column menu moving it;
 *  - dragging a card to another lane;
 *  - Ship, Icebox, Drop with a reason, and Restore, with the Shipped and
 *    Icebox pages;
 *  - New card into Backlog (with notes) and into Icebox;
 *  - 1280, and an iPhone in WebKit: the stacked list, an opened card full screen.
 *
 * Screenshots land in PLANNOTATOR_BOARD_SHOTS (default /tmp/board-step2-built).
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 */

import { devices, expect, test, webkit, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { fakeForge, type FakeForge } from './fake-forge';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shots = resolve(process.env.PLANNOTATOR_BOARD_SHOTS ?? '/tmp/board-step2-built');

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const person = (login: string) => ({ login, avatarUrl: null });
const githubItem = (item: Record<string, unknown>) => ({ data: { repository: { nameWithOwner: 'acme/widgets', issueOrPullRequest: item } } });
function pull(number: number, title: string, extra: Record<string, unknown>) {
  return githubItem({
    __typename: 'PullRequest',
    number,
    title,
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
    headRefName: 'feat/x',
    body: '',
    additions: 120,
    deletions: 14,
    changedFiles: 6,
    reviewDecision: null,
    closingIssuesReferences: { nodes: [] },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS', contexts: { totalCount: 2, nodes: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }, { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }] } } } }] },
    ...extra,
  });
}

interface World {
  url: string;
  forge: FakeForge;
  agents: SimAgent[];
  claude: SimAgent;
  codex: SimAgent;
  pi: SimAgent;
  projects: { plannotator: string; workspaces: string; machine: string };
  context: BrowserContext;
  page: Page;
  errors: string[];
  ids: Record<string, string>;
  dataDir: string;
}

let world: World;

test.describe.configure({ mode: 'serial' });

const card = (page: Page, id: string) => page.locator(`.ib-bcard[data-card-id="${id}"]`);
const lane = (page: Page, column: string) => page.locator(`.ib-blanes [data-lane="${column}"]`);

async function shot(page: Page, name: string) {
  await page.waitForTimeout(450);
  await page.screenshot({ path: join(shots, name) });
}

async function both(page: Page, name: string) {
  await page.emulateMedia({ colorScheme: 'light' });
  await shot(page, `${name}-light.png`);
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, `${name}-dark.png`);
  await page.emulateMedia({ colorScheme: 'light' });
}

/** Let go of focus (a tooltip on the "?" after Escape would sit in the shot). */
async function blur(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(700, 880);
}

/** With a card open, the lanes beside it are whole: none is cut at either edge of the lanes' box. */
async function expectWholeLanes(page: Page) {
  await page.waitForTimeout(300);
  const lanesBox = await page.locator('.ib-blanes').evaluate((el) => {
    const box = el.getBoundingClientRect();
    const rects = [...el.querySelectorAll<HTMLElement>('[data-lane]')].map((lane) => lane.getBoundingClientRect());
    const cut = rects.filter((r) => r.right > box.left + 1 && r.left < box.right - 1).some((r) => r.left < box.left - 1 || r.right > box.right + 1);
    return { cut, box: [box.left, box.right], lanes: rects.map((r) => [Math.round(r.left), Math.round(r.right)]), fit: el.getAttribute('data-fit') };
  });
  expect(lanesBox.cut, JSON.stringify(lanesBox)).toBe(false);
  expect(lanesBox.fit).not.toBeNull();
}

async function make(agent: SimAgent, project: string, title: string, fields: Record<string, unknown> = {}): Promise<string> {
  const made = await agent.card({ op: 'create', project_path: project, title, ...fields });
  return (made.card as { id: string }).id;
}

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(shots, { recursive: true, force: true });
  mkdirSync(shots, { recursive: true });
  const root = inboxScratch('plannotator-inbox-board-e2e-');
  const forge = fakeForge(join(root, 'bin'));
  forge.github(12, pull(12, 'vite 8 for the review app', { state: 'MERGED', mergedAt: hoursAgo(30) }));
  forge.github(14, pull(14, 'Delivery ticks on list rows', {}));
  forge.github(11, githubItem({ __typename: 'Issue', number: 11, title: 'Electron forge drops the icon', url: 'https://github.com/acme/widgets/issues/11', state: 'OPEN', stateReason: null, createdAt: hoursAgo(80), updatedAt: hoursAgo(3), closedAt: null, body: '', author: person('sam'), labels: { nodes: [] }, assignees: { nodes: [] }, comments: { totalCount: 0, nodes: [] }, closedByPullRequestsReferences: { nodes: [] } }));
  const env = { PATH: `${forge.dir}:${process.env.PATH ?? ''}`, HOME: root, PLANNOTATOR_DATA_DIR: join(root, 'data'), PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const src = join(root, 'src');
  const projects = { plannotator: scratchProject(src, 'plannotator'), workspaces: scratchProject(src, 'workspaces'), machine: scratchProject(src, 'machine') };
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const codex = await SimAgent.connect({ binary, env, name: 'Codex', host: 'codex' });
  const pi = await SimAgent.connect({ binary, env, name: 'Pi', host: 'pi' });
  // A card call never makes a project: a message does.
  const ticks = await claude.send({ project_path: projects.plannotator, subject: 'Delivery ticks: screenshots before merge', thread: 'ticks', body: 'Ticks are drawn on Sent rows; screenshots next.' });
  await codex.send({ project_path: projects.workspaces, subject: 'Design system notes', body: 'Notes on the design system are up.' });
  await pi.send({ project_path: projects.machine, subject: 'Session list store', body: 'Writing the store for the session list.' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  world = { url: started.stdout.trim(), forge, agents: [claude, codex, pi], claude, codex, pi, projects, context, page, errors, ids: { ticksThread: ticks.thread_id as string }, dataDir: env.PLANNOTATOR_DATA_DIR };
});

test.afterAll(async () => {
  try {
    if (!world) return;
    for (const agent of world.agents) await agent.close().catch(() => {});
    await world.context.close();
  } finally {
    await removeInboxScratch();
  }
});

test('off by default: no Board row, a #board link says it is off, an agent is refused; Settings turns it on', async () => {
  const { page, claude, projects } = world;
  // While it is off the window reads no cards: not at load, not on a #board link.
  const cardReads: string[] = [];
  const watch = (request: import('@playwright/test').Request) => {
    if (new URL(request.url()).pathname.startsWith('/api/inbox/cards')) cardReads.push(request.url());
  };
  page.on('request', watch);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(world.url);
  await expect(page.locator('[data-settings-nav], .ib-setrow').first()).toBeVisible();
  await expect(page.locator('[data-board-nav]')).toHaveCount(0);
  // An agent's card call while it is off: refused, nothing written.
  await expect(make(claude, projects.plannotator, 'Too early')).rejects.toThrow(/board_off: /);
  // A #board link while off: the page says so, with the way on. No first-visit dialog yet.
  await page.goto(`${world.url}#board`);
  const off = page.locator('[data-board-off]');
  await expect(off).toBeVisible();
  await expect(off.locator('h2')).toHaveText('The Board is off');
  await expect(page.locator('[data-dialog="board-intro"]')).toHaveCount(0);
  await blur(page);
  await both(page, 'board-off-1440');
  expect(cardReads).toEqual([]);
  page.off('request', watch);
  // Settings → Capabilities (moved out of General): the switch, saying agents get it from their next session.
  await page.goto(`${world.url}#settings/capabilities`);
  const group = page.locator('[data-settings-board]');
  await expect(group).toBeVisible();
  await expect(group).toContainText('next session');
  const toggle = group.locator('[role="switch"]');
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await group.scrollIntoViewIfNeeded();
  await blur(page);
  await both(page, 'settings-board-off-1440');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('[data-board-nav]').first()).toBeAttached();
  await blur(page);
  await both(page, 'settings-board-on-1440');
  // Nothing was written while it was off.
  expect(((await claude.card({ op: 'list', project_path: projects.plannotator })).cards as unknown[]).length).toBe(0);
});

test('the first visit shows "Your Board" once; Copy prompt copies the Board prompt; an empty Board says so', async () => {
  const { page } = world;
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(world.url);
  await page.locator('[data-board-nav]').click();
  const intro = page.locator('[data-dialog="board-intro"]');
  await expect(intro).toBeVisible();
  await expect(intro.locator('h2')).toHaveText('Your Board');
  await expect(intro).toContainText('Work in flight, by stage. Agents keep their cards current.');
  await both(page, 'intro-1440');
  await intro.locator('[data-board-intro-copy]').click();
  await expect(intro.locator('[data-board-intro-copy]')).toHaveText('Copied');
  await expect(intro.locator('[data-board-intro-close]')).toHaveText('Done');
  await expect(intro.locator('[data-board-intro-live]')).toHaveText('Board prompt copied.');
  const prompt = await page.evaluate(() => navigator.clipboard.readText());
  for (const words of ['card', 'backlog', 'your_look', 'your_review', 'ref', 'link']) expect(prompt).toContain(words);
  await shot(page, 'intro-copied-1440-light.png');
  await intro.locator('[data-board-intro-close]').click();
  await expect(intro).toHaveCount(0);
  // Empty: the Copy prompt line.
  await expect(page.locator('[data-board-empty]')).toContainText('No cards yet');
  await shot(page, 'empty-1440-light.png');
  // Once per machine: a reload does not show it; the "?" does.
  await page.reload();
  await expect(page.locator('[data-board-page]')).toBeVisible();
  await page.waitForTimeout(800);
  await expect(intro).toHaveCount(0);
  // The "?" sits left of Shipped and Icebox (the intro mock); the sidebar's Board row has no count.
  const order = await page.locator('.ib-bhead').evaluate((head) => [...head.querySelectorAll('[data-board-about], [data-board-link]')].map((el) => el.getAttribute('data-board-link') ?? 'about'));
  expect(order).toEqual(['about', 'shipped', 'icebox']);
  await expect(page.locator('[data-board-nav] .ib-n')).toHaveCount(0);
  await page.locator('[data-board-about]').click();
  await expect(intro).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(intro).toHaveCount(0);
});

test("an agent's cards appear live as it makes and moves them, bold until opened", async () => {
  const { page, claude, codex, pi, projects, ids } = world;
  await expect(page.locator('[data-board-empty]')).toBeVisible();
  // Agents fill the Board while it is open.
  ids.auto = await make(claude, projects.plannotator, 'Auto-update for users', { say: 'Pick it up: read the issue first' });
  await expect(card(page, ids.auto)).toBeVisible();
  await expect(lane(page, 'backlog').locator(`[data-card-id="${ids.auto}"]`)).toBeVisible();
  await expect(card(page, ids.auto)).toHaveAttribute('data-unread', '');
  ids.polylane = await make(pi, projects.machine, 'Polylane plan evaluation', { say: 'Not picked up yet' });
  ids.company = await make(claude, projects.plannotator, 'Company agents and approvals', { column: 'designing', say: 'Write up where it lands' });
  ids.hero = await make(claude, projects.plannotator, 'Hero scene timers, easing', { column: 'designing', say: 'Option 3 of 6 rendered' });
  ids.address = await make(claude, projects.plannotator, 'One fixed address for the Inbox', { column: 'your_look', you: 'Pick a dialog (two options)' });
  ids.design = await make(codex, projects.workspaces, 'A design system like Linear’s', { column: 'your_look', you: 'Answer 11 questions in the thread' });
  ids.pricing = await make(claude, projects.plannotator, 'Pricing page', { say: 'Copy drafted' });
  ids.herdr = await make(claude, projects.plannotator, 'Herdr: PR triage, diffs', { column: 'building', say: 'Triage the open PRs first' });
  await claude.card({ op: 'link', card_id: ids.herdr, ref: 'https://github.com/acme/widgets/issues/11', project_path: projects.plannotator });
  ids.vite = await make(codex, projects.workspaces, 'vite 8 and electron-forge', { column: 'building', say: 'vite 8 merged; forge next', pr: 'acme/widgets#12' });
  await codex.card({ op: 'link', card_id: ids.vite, ref: 'acme/widgets#11', project_path: projects.workspaces });
  ids.session = await make(pi, projects.machine, 'machine: session list', { column: 'building', say: 'Writing the store' });
  ids.ticks = await make(claude, projects.plannotator, 'Delivery ticks on list rows', { column: 'building', say: 'Ticks drawn on Sent rows; screenshots next', pr: 'acme/widgets#14', thread_id: ids.ticksThread });
  ids.caret = await make(claude, projects.plannotator, 'Caret anywhere in the reply box', { column: 'your_review', you: 'Merge #1960' });
  ids.tab = await make(claude, projects.plannotator, 'Unread count on the tab', { column: 'building', say: 'PR open' });
  await claude.card({ op: 'ship', card_id: ids.tab, say: 'merged', project_path: projects.plannotator });
  // A move by the agent shows live: Pricing goes to Your look with what the person owes.
  await claude.card({ op: 'move', card_id: ids.pricing, column: 'your_look', you: 'Read the copy, then say go', project_path: projects.plannotator });
  await expect(lane(page, 'your_look').locator(`[data-card-id="${ids.pricing}"]`)).toBeVisible();
  await expect(card(page, ids.pricing).locator('.ib-bc-line')).toHaveText('You: Read the copy, then say go');
  // The agent moves Delivery ticks to Your review.
  await claude.card({ op: 'move', card_id: ids.ticks, column: 'your_review', you: 'Look at the screenshots, then merge #14', project_path: projects.plannotator });
  await expect(lane(page, 'your_review').locator(`[data-card-id="${ids.ticks}"]`)).toBeVisible();
  // The agent's last word is not on the lane card (approval board-lane-card, r1): its title row alone.
  await expect(card(page, ids.herdr).locator('.ib-bc-line')).toHaveCount(0);
  await expect(card(page, ids.herdr)).not.toContainText('Triage the open PRs first');
  await expect(page.locator('[data-board-summary]')).toHaveText('12 in flight · 5 on you');
  await expect(page.locator('[data-board-link="shipped"]')).toHaveText('Shipped 1');
  // No "on you" pill on a lane, no counts on a card.
  await expect(page.locator('.ib-onyou')).toHaveCount(0);
  // Each lane card with a link carries its state as a mark, read for the cards on screen in
  // batched GitHub queries (one per repository, never the hover card's one-by-one read), each
  // link asked once (cached), nothing else fetched until a card is opened.
  await expect(card(page, ids.vite).locator('[data-card-mark]')).toHaveAttribute('data-card-mark', 'merged');
  await expect(card(page, ids.vite).locator('[data-card-mark]')).toHaveAttribute('data-card-mark-kind', 'pr');
  await expect(card(page, ids.ticks).locator('[data-card-mark]')).toHaveAttribute('data-card-mark', 'open');
  await expect(card(page, ids.herdr).locator('[data-card-mark]')).toHaveAttribute('data-card-mark', 'open');
  await expect(card(page, ids.herdr).locator('[data-card-mark]')).toHaveAttribute('data-card-mark-kind', 'issue');
  await expect(card(page, ids.auto).locator('[data-card-mark]')).toHaveCount(0);
  // The state is in the card's accessible name.
  await expect(card(page, ids.vite).locator('[data-card-open]')).toHaveAttribute('aria-label', /Pull request #12, merged$/);
  await expect(card(page, ids.ticks).locator('[data-card-open]')).toHaveAttribute('aria-label', /Pull request #14, open$/);
  await expect(card(page, ids.herdr).locator('[data-card-open]')).toHaveAttribute('aria-label', /Issue #11, open$/);
  const markCalls = world.forge.calls();
  expect(markCalls.every((line) => line.startsWith('gh marks ')), markCalls.join('\n')).toBe(true);
  expect(markCalls.flatMap((line) => line.slice('gh marks '.length).split(',')).sort()).toEqual(['11', '12', '14']);
  // A mark never moves a card: the merged PR's card stays in Building.
  await expect(lane(page, 'building').locator(`[data-card-id="${ids.vite}"]`)).toBeVisible();
  // The five lanes fit the window: nothing scrolls sideways.
  expect(await page.locator('.ib-blanes').evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await blur(page);
  await both(page, 'board-1440');
  // The mark's component tooltip: the link, its title and its state.
  await card(page, ids.vite).locator('[data-card-mark]').hover();
  await expect(page.locator('[data-side].bg-popover')).toHaveText('#12 vite 8 for the review app · Merged', { timeout: 2000 });
  await both(page, 'board-mark-tip-1440');
  await blur(page);
});

test("an agent's drop shows above the lanes until the person looks", async () => {
  const { page, codex, projects, ids } = world;
  ids.sqlite = await make(codex, projects.workspaces, 'Spike: SQLite for the store', { say: 'Measuring' });
  await expect(card(page, ids.sqlite)).toBeVisible();
  await codex.card({ op: 'drop', card_id: ids.sqlite, reason: 'Superseded by the JSONL store; nothing to keep', project_path: projects.workspaces });
  const notice = page.locator('[data-dropped-notice]');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('Spike: SQLite for the store');
  await expect(notice).toContainText('Superseded by the JSONL store');
  await expect(card(page, ids.sqlite)).toHaveCount(0);
  await blur(page);
  await both(page, 'dropped-notice-1440');
  await notice.locator('[data-dropped-seen]').click();
  await expect(notice).toHaveCount(0);
  await page.reload();
  await expect(card(page, ids.auto)).toBeVisible();
  await expect(page.locator('[data-dropped-notice]')).toHaveCount(0);
});

test('the opened card: the panel beside the lanes, its links read once it opens, the column menu', async () => {
  const { page, ids } = world;
  await card(page, ids.vite).locator('[data-card-open]').click();
  const panel = page.locator(`[data-card-panel="${ids.vite}"]`);
  await expect(panel).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`#board&card=${ids.vite}`));
  // Opened: no longer bold.
  await expect(card(page, ids.vite)).not.toHaveAttribute('data-unread', '');
  await expect(card(page, ids.vite)).toHaveAttribute('data-open', '');
  // The links' live state, from the scripted gh only now.
  await expect(panel.locator('[data-card-ref="acme/widgets#12"]')).toHaveAttribute('data-ref-state', 'merged');
  await expect(panel.locator('[data-card-ref="acme/widgets#12"]')).toContainText('vite 8 for the review app');
  await expect(panel.locator('[data-card-ref="acme/widgets#11"]')).toContainText('Electron forge drops the icon');
  expect(world.forge.calls().filter((line) => line.startsWith('gh number=')).sort()).toEqual(['gh number=11', 'gh number=12']);
  await expect(panel).toContainText('Codex');
  // History reads the mock's short ref.
  await expect(panel.locator('section[aria-label="History"]')).toContainText('Linked #11');
  // Whole lanes beside the panel: none is cut at either edge of the lanes' box.
  await expectWholeLanes(page);
  await both(page, 'open-1440');
  // The column menu: Your review.
  await panel.locator('[data-card-column]').click();
  await expect(page.locator(`[data-card-menu="${ids.vite}"]`)).toBeVisible();
  // One choice: radio items, the card's column checked.
  await expect(page.locator('[data-card-move-to="building"]')).toHaveAttribute('role', 'menuitemradio');
  await expect(page.locator('[data-card-move-to="building"]')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('[data-card-move-to="your_review"]')).toHaveAttribute('aria-checked', 'false');
  await both(page, 'open-move-1440');
  await page.locator('[data-card-move-to="your_review"]').click();
  await expect(lane(page, 'your_review').locator(`[data-card-id="${ids.vite}"]`)).toBeVisible();
  await expect(panel.locator('[data-card-column]')).toHaveAttribute('data-card-column', 'your_review');
  await expect(page.locator('[data-board-live]')).toContainText('Your review');
  // History names the person's move.
  await expect(panel.locator('section[aria-label="History"]')).toContainText('Your review');
  await panel.locator('[data-card-close]').click();
  await expect(panel).toHaveCount(0);
});

test("Start: an agent's Backlog card goes to its live session, once; the lane card says Sent to", async () => {
  const { page, ids, dataDir } = world;
  await page.keyboard.press('Escape');
  // The card's session connects (its connection polls the bridge, as the Claude Code mod does): it is live.
  const registry = JSON.parse(readFileSync(join(dataDir, 'inbox', 'inbox.json'), 'utf8')) as { port: number; token: string };
  const base = `http://127.0.0.1:${registry.port}`;
  const { card: auto } = (await (await fetch(`${base}/api/inbox/cards/${ids.auto}`)).json()) as { card: { agent: { host: string; session: string } } };
  const poll = async () =>
    (await (
      await fetch(`${base}/api/inbox/bridge/poll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${registry.token}` },
        body: JSON.stringify({ session: auto.agent.session, host: auto.agent.host, waitMs: 0 }),
      })
    ).json()) as { commands: { body?: string; text?: string }[] };
  await poll();
  await card(page, ids.auto).locator('[data-card-open]').click();
  const panel = page.locator(`[data-card-panel="${ids.auto}"]`);
  const start = panel.locator('[data-card-start]');
  await expect(start).toBeEnabled();
  await blur(page);
  await both(page, 'open-start-1440');
  await start.click();
  // The lane card says who it went to; nothing moved.
  await expect(card(page, ids.auto)).toHaveAttribute('data-sent', '');
  await expect(card(page, ids.auto).locator('.ib-bc-sent')).toContainText('Sent to Claude Code');
  await expect(lane(page, 'backlog').locator(`[data-card-id="${ids.auto}"]`)).toBeVisible();
  await both(page, 'open-sent-1440');
  await panel.locator('[data-card-close]').click();
  await expect(panel).toHaveCount(0);
  await blur(page);
  await both(page, 'board-sent-1440');
  // The session got one message naming the card.
  const { commands } = await poll();
  expect(commands.filter((c) => JSON.stringify(c).includes(ids.auto))).toHaveLength(1);
});

test('dragging a card to another lane moves it', async () => {
  const { page, ids } = world;
  await card(page, ids.herdr).dragTo(lane(page, 'your_look'));
  await expect(lane(page, 'your_look').locator(`[data-card-id="${ids.herdr}"]`)).toBeVisible();
  await expect(card(page, ids.herdr)).toHaveAttribute('data-column', 'your_look');
});

test('Ship, Icebox, Drop with a reason, and Restore; the Shipped and Icebox pages', async () => {
  const { page, ids } = world;
  // Ship.
  await card(page, ids.caret).locator('[data-card-open]').click();
  let panel = page.locator(`[data-card-panel="${ids.caret}"]`);
  await panel.locator('[data-card-ship]').click();
  await expect(card(page, ids.caret)).toHaveCount(0);
  await expect(page.locator('[data-board-link="shipped"]')).toHaveText('Shipped 2');
  // Icebox.
  await page.keyboard.press('Escape');
  await card(page, ids.polylane).locator('[data-card-open]').click();
  panel = page.locator(`[data-card-panel="${ids.polylane}"]`);
  await panel.locator('[data-card-icebox]').click();
  await expect(card(page, ids.polylane)).toHaveCount(0);
  await expect(page.locator('[data-board-link="icebox"]')).toHaveText('Icebox 1');
  // Drop with a reason.
  await card(page, ids.company).locator('[data-card-open]').click();
  panel = page.locator(`[data-card-panel="${ids.company}"]`);
  await panel.locator('[data-card-drop]').click();
  await panel.locator('[data-drop-reason]').fill('Folded into the Workspaces plan');
  await both(page, 'open-drop-1440');
  await panel.locator('[data-drop-confirm]').click();
  await expect(card(page, ids.company)).toHaveCount(0);
  // The Shipped page.
  await page.locator('[data-board-link="shipped"]').click();
  await expect(page.locator('[data-board-view="shipped"]')).toBeVisible();
  await expect(card(page, ids.caret)).toBeVisible();
  await expect(card(page, ids.tab)).toBeVisible();
  await both(page, 'shipped-1440');
  await page.locator('[data-board-back]').click();
  // The Icebox page: the iced card, and Dropped with date and reason.
  await page.locator('[data-board-link="icebox"]').click();
  await expect(page.locator('[data-board-view="icebox"]')).toBeVisible();
  await expect(card(page, ids.polylane)).toBeVisible();
  const dropped = page.locator('[data-dropped-list]');
  await expect(dropped.locator(`[data-dropped-row="${ids.company}"]`)).toContainText('Folded into the Workspaces plan');
  await expect(dropped.locator(`[data-dropped-row="${ids.sqlite}"]`)).toContainText('Superseded by the JSONL store');
  await both(page, 'icebox-1440');
  // Restore the drop: back to Designing.
  await dropped.locator(`[data-card-restore="${ids.company}"]`).click();
  await expect(dropped.locator(`[data-dropped-row="${ids.company}"]`)).toHaveCount(0);
  // Restore the iced card from its panel.
  await card(page, ids.polylane).locator('[data-card-open]').click();
  await page.locator(`[data-card-panel="${ids.polylane}"] [data-card-restore="${ids.polylane}"]`).click();
  await page.locator('[data-board-back]').click();
  await expect(lane(page, 'designing').locator(`[data-card-id="${ids.company}"]`)).toBeVisible();
  await expect(lane(page, 'backlog').locator(`[data-card-id="${ids.polylane}"]`)).toBeVisible();
});

test('New card: into Backlog with notes, and into Icebox', async () => {
  const { page } = world;
  await page.keyboard.press('Escape');
  await page.locator('[data-board-new]').click();
  const dialog = page.locator('.ib-ncd');
  await expect(dialog).toBeVisible();
  await dialog.locator('[data-new-card-title]').fill('A roadmap page for the site');
  await dialog.locator('[data-new-card-notes]').fill('Maybe one page that lists what is next, from the Board.');
  // Where it goes: one radio group, Backlog first.
  await expect(dialog.locator('[role="radiogroup"]')).toHaveAttribute('aria-label', 'Where it goes');
  await expect(dialog.locator('[data-new-card-mode="backlog"] input')).toBeChecked();
  await expect(dialog.locator('.ib-ncd-acts [data-new-card-add], [data-new-card-add]').last()).toHaveText('Add to Backlog');
  await both(page, 'new-card-1440');
  await dialog.locator('[data-new-card-add]').last().click();
  await expect(dialog).toHaveCount(0);
  const roadmap = page.locator('.ib-bcard', { hasText: 'A roadmap page for the site' });
  await expect(lane(page, 'backlog').locator('.ib-bcard', { hasText: 'A roadmap page for the site' })).toBeVisible();
  // The person's own card is not bold.
  await expect(roadmap).not.toHaveAttribute('data-unread', '');
  await roadmap.locator('[data-card-open]').click();
  await expect(page.locator('[data-card-notes]')).toContainText('Maybe one page that lists what is next');
  await expectWholeLanes(page);
  await both(page, 'open-backlog-1440');
  await page.keyboard.press('Escape');
  // Icebox.
  await page.locator('[data-board-new]').click();
  await dialog.locator('[data-new-card-title]').fill('Themes for the Board');
  await dialog.locator('[data-new-card-mode="icebox"]').click();
  await expect(dialog.locator('[data-new-card-add]').last()).toHaveText('Add to Icebox');
  await shot(page, 'new-card-icebox-1440-light.png');
  await dialog.locator('[data-new-card-add]').last().click();
  await expect(page.locator('[data-board-link="icebox"]')).toHaveText('Icebox 1');
  expect(world.errors).toEqual([]);
});

test('1280: the lanes fit, and an opened card keeps its lane in view', async () => {
  const { page, ids } = world;
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.keyboard.press('Escape');
  // The five lanes fit the window: nothing scrolls sideways.
  expect(await page.locator('.ib-blanes').evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await blur(page);
  await both(page, 'board-1280');
  await card(page, ids.ticks).locator('[data-card-open]').click();
  const panel = page.locator(`[data-card-panel="${ids.ticks}"]`);
  await expect(panel).toBeVisible();
  await expect(panel.locator('[data-card-you]')).toContainText('Look at the screenshots, then merge #14');
  await expect(panel.locator('[data-card-ref="acme/widgets#14"]')).toHaveAttribute('data-ref-state', 'open');
  const laneBox = await lane(page, 'your_review').boundingBox();
  const panelBox = await panel.boundingBox();
  expect(laneBox!.x + laneBox!.width).toBeLessThanOrEqual(panelBox!.x + 1);
  expect(laneBox!.x).toBeGreaterThanOrEqual(0);
  await expectWholeLanes(page);
  await both(page, 'open-1280');
  // A thread of the card opens in the Inbox view with a way back to the card.
  await panel.locator('[data-card-thread]').first().click();
  await expect(page.locator('[data-thread-card]')).toBeVisible();
  await shot(page, 'thread-from-card-1280-light.png');
  await page.locator('[data-thread-card]').click();
  await expect(page.locator(`[data-card-panel="${ids.ticks}"]`)).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
});

test('a thread opened from a card on the Shipped page goes back to the Shipped page', async () => {
  const { page, claude, projects, ids } = world;
  ids.old = await make(claude, projects.plannotator, 'Old ticks', { column: 'shipped', say: 'merged', thread_id: ids.ticksThread });
  await page.goto(`${world.url}#board=shipped`);
  await card(page, ids.old).locator('[data-card-open]').click();
  const panel = page.locator(`[data-card-panel="${ids.old}"]`);
  await expect(panel).toBeVisible();
  await panel.locator('[data-card-thread]').first().click();
  await expect(page.locator('[data-thread-card]')).toBeVisible();
  await expect(page).toHaveURL(/from=shipped/);
  await page.locator('[data-thread-card]').click();
  await expect(page.locator('[data-board-view="shipped"]')).toBeVisible();
  await expect(page.locator(`[data-card-panel="${ids.old}"]`)).toBeVisible();
  await page.goto(`${world.url}#board`);
});

test('turned off again: the row goes, an agent mid-session is refused and nothing written, every card kept; on again, as they were', async () => {
  const { page, claude, projects } = world;
  await page.goto(`${world.url}#board`);
  await expect(page.locator('.ib-bcard').first()).toBeVisible();
  const before = await page.locator('.ib-bcard').count();
  const listed = (await claude.card({ op: 'list', project_path: projects.plannotator })).cards as { id: string; said: string | null }[];
  expect(listed.length).toBeGreaterThan(0);
  const mine = listed[0]!;
  await page.goto(`${world.url}#settings/capabilities`);
  const toggle = page.locator('[data-settings-board] [role="switch"]');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('[data-board-nav]')).toHaveCount(0);
  // This agent's session read its tools while the Board was on: its call is refused, nothing written.
  await expect(claude.card({ op: 'say', card_id: mine.id, say: 'still going', project_path: projects.plannotator })).rejects.toThrow(/board_off: /);
  await page.goto(`${world.url}#board`);
  await expect(page.locator('[data-board-off]')).toBeVisible();
  await page.locator('[data-board-turn-on]').click();
  await expect(page.locator('[data-board-page][data-board-view="lanes"]')).toBeVisible();
  await expect(page.locator('[data-board-nav]').first()).toBeAttached();
  await expect(page.locator('.ib-bcard')).toHaveCount(before);
  const after = (await claude.card({ op: 'list', project_path: projects.plannotator })).cards as { id: string; said: string | null }[];
  expect(after.find((c) => c.id === mine.id)?.said).toBe(mine.said);
});

test.describe('iPhone 15 (WebKit)', () => {
  const { defaultBrowserType: _browser, ...device } = devices['iPhone 15'];
  let browser: Browser | null = null;
  test.beforeAll(async () => {
    browser = await webkit.launch({ args: [] });
  });
  test.afterAll(async () => {
    await browser?.close();
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`a stacked list with Shipped and Icebox folded; an opened card full screen (${scheme})`, async () => {
      const { ids } = world;
      const context = await browser!.newContext({ ...device, colorScheme: scheme });
      try {
        const page = await context.newPage();
        await page.goto(`${world.url}#board`);
        const board = page.locator('[data-board-view="phone"]');
        await expect(board).toBeVisible();
        await expect(page.locator('[data-board-fold="shipped"]')).toHaveAttribute('aria-expanded', 'false');
        await expect(page.locator('[data-board-fold="icebox"]')).toHaveAttribute('aria-expanded', 'false');
        // Nothing scrolls sideways.
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
        await page.waitForTimeout(400);
        await page.screenshot({ path: join(shots, `phone-board-${scheme}.png`) });
        // "You: …" is a tap target of its own (the review of #2240: it was 18.8 px, so a slightly missed tap
        // opened the card): at least 44 px tall, across the card's bottom row.
        const youLink = page.locator(`.ib-bcard[data-card-id="${ids.ticks}"] [data-card-you-link]`);
        const youBox = (await youLink.boundingBox())!;
        const cardBox = (await page.locator(`.ib-bcard[data-card-id="${ids.ticks}"]`).boundingBox())!;
        expect(Math.round(youBox.height)).toBeGreaterThanOrEqual(44);
        expect(youBox.width).toBeGreaterThan(cardBox.width * 0.6);
        // It stays inside the card (the row takes the card's padding, not its neighbour's space).
        expect(youBox.y + youBox.height).toBeLessThanOrEqual(cardBox.y + cardBox.height + 0.5);
        await page.locator(`.ib-bcard[data-card-id="${ids.ticks}"] [data-card-open]`).tap();
        await expect(page.locator('[data-board-view="card"]')).toBeVisible();
        const back = page.locator('[data-card-back]');
        await expect(back).toBeVisible();
        const box = await back.boundingBox();
        expect(Math.round(box!.height)).toBeGreaterThanOrEqual(44);
        await page.waitForTimeout(400);
        await page.screenshot({ path: join(shots, `phone-open-${scheme}.png`) });
        await back.tap();
        await expect(board).toBeVisible();
        await page.locator('[data-board-fold="shipped"]').tap();
        await expect(page.locator(`.ib-bcard[data-card-id="${ids.tab}"]`)).toBeVisible();
        await page.waitForTimeout(300);
        await page.screenshot({ path: join(shots, `phone-shipped-open-${scheme}.png`), fullPage: true });
      } finally {
        await context.close();
      }
    });
  }
});
