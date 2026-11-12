/**
 * "Back from snooze" in the open thread (approval `snooze-back-line`,
 * 2026-11-05), in real browsers against the compiled binary, with an agent
 * writing through `plannotator inbox mcp` (scripts/inbox-sim.ts) and short
 * snoozes through the window's own route:
 *
 *  - thread closed at the return: with news, the existing divider says it; with
 *    nothing new (the agent last, the person last, one message), the line sits
 *    above the last message; on screen on opening, a very long last message too;
 *  - gone on leaving; the first window to open gets it, a later one does not;
 *  - thread open at the return, in front: it appears at once, the row settles;
 *  - thread open at the return, in a background tab (focus really lost; hidden as a stand-in): it appears, but nothing
 *    counts as looked at until the tab comes to the front;
 *  - thread closed at the return, in a background tab;
 *  - re-snoozed: gone, and an Unsnooze does not bring it back; never for an
 *    Unsnooze; a phone in WebKit;
 *  - an agent archives a snoozed thread and the time passes: no stale
 *    "Snoozed until" line.
 *
 * HOME and the data dir are temp folders, as in inbox-snooze.spec.ts. PNGs land
 * in PLANNOTATOR_SNOOZE_BACK_SHOTS (default .local/proof/snooze-back). Build
 * the binary first (see inbox.spec.ts).
 */

import { chromium, devices, expect, test, webkit, type Browser, type BrowserContext, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shots = resolve(process.env.PLANNOTATOR_SNOOZE_BACK_SHOTS ?? join(repo, '.local/proof/snooze-back'));

/** Pinned on purpose: the approval names these exact words. */
const WORDS = /^Back from snooze · \d{1,2}:\d{2} [AP]M$/;
const LONG = ['The rollout, step by step.', ...Array.from({ length: 60 }, (_, i) => `Step ${i + 1}: the worker reads the event, checks the idempotency key, and writes the ledger row.`)].join('\n\n');

/** How long a short snooze runs: long enough to do what a test does before it ends. */
const SNOOZE_MS = 2500;

interface World {
  url: string;
  serverSession: string;
  agent: SimAgent;
  src: string;
  page: Page;
  context: BrowserContext;
}

let world: World;
let count = 0;

test.describe.configure({ mode: 'serial' });

const row = (page: Page, id: string) => page.locator(`.ib-listcol .ib-lbody [data-thread-id="${id}"]`);
const line = (page: Page) => page.locator('[data-snooze-back-line]');
const backMark = (page: Page, id: string) => row(page, id).locator('[data-snooze-back-mark]');

async function post(path: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${world.url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serverSession: world.serverSession, ...body }) });
}

/** What the store says now, read without a look. */
async function storeRow(id: string): Promise<{ snoozed: unknown; snooze_back: string | null; unread: boolean }> {
  const answer = (await (await fetch(`${world.url}/api/inbox/threads/${id}`)).json()) as { row: { snoozed: unknown; snooze_back: string | null; unread: boolean } };
  return answer.row;
}

async function look(id: string): Promise<void> {
  expect((await post(`/api/inbox/threads/${id}/seen`, {})).status).toBe(200);
}

async function snooze(id: string, ms: number | null = SNOOZE_MS): Promise<string | null> {
  const until = ms === null ? null : new Date(Date.now() + ms).toISOString();
  const res = await post(`/api/inbox/threads/${id}/snooze`, { until });
  expect(res.status, await res.clone().text()).toBe(200);
  return until;
}

/** A thread the person has read, from the agent's messages. */
async function thread(bodies: string[]): Promise<{ id: string; root: string; project: string; last: string }> {
  const key = `case-${++count}`;
  const project = scratchProject(world.src, key);
  const first = await world.agent.send({ project_path: project, subject: `Rollout ${key}`, thread: key, body: bodies[0]! });
  let last = String(first.message_id);
  for (const body of bodies.slice(1)) last = String((await world.agent.send({ project_path: project, reply_to: String(first.message_id), body })).message_id);
  await look(String(first.thread_id));
  return { id: String(first.thread_id), root: String(first.message_id), project, last };
}

/** The return reached the store, and the row is on the list with its clock (a settled list holds it behind "N new", pressed here). */
async function waitBack(page: Page, id: string): Promise<void> {
  await expect.poll(async () => Boolean((await storeRow(id)).snooze_back), { timeout: 20_000 }).toBe(true);
  await expect
    .poll(
      async () => {
        const notice = page.locator('[data-inbox-notice]');
        if (await notice.count()) await notice.first().click({ timeout: 1000 }).catch(() => {});
        return backMark(page, id).count();
      },
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0);
}

/** The line's next message, as the person reads it. */
const messageBelow = (page: Page) => line(page).evaluate((el) => el.nextElementSibling?.getAttribute('data-message-article') ?? null);

async function open(page: Page, id: string): Promise<void> {
  await row(page, id).click();
  await expect(page.locator('section.ib-pane')).toBeVisible();
}

async function close(page: Page): Promise<void> {
  await page.goto(`${world.url}/#`);
}

/** The page in light and in dark. */
async function shot(page: Page, name: string): Promise<void> {
  // Headless Chrome's "blocks notifications" card sits in the list; it says nothing about this line.
  const hide = page.locator('.ib-listcol').getByRole('button', { name: 'Hide', exact: true });
  if (await hide.count()) await hide.click();
  if (page.viewportSize()!.width > 600) await page.mouse.move(1000, 700);
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(shots, `${name}-${colorScheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

async function quietBand(page: Page): Promise<void> {
  const quiet = page.locator('[data-section-id="quiet"] .ib-band');
  if ((await quiet.count()) && (await quiet.getAttribute('aria-expanded')) === 'false') await quiet.click();
}

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  mkdirSync(shots, { recursive: true });
  const root = inboxScratch('plannotator-inbox-snooze-back-e2e-');
  const dataDir = join(root, 'data');
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_INBOX_NOTES: '0',
    PLANNOTATOR_TEST_SANDBOX: '1',
    NO_ANON_PING: '1',
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  const url = started.stdout.trim().replace(/\/$/, '');
  const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const list = (await (await fetch(`${url}/api/inbox/threads?archived=exclude`)).json()) as { serverSession: string };
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  world = { url, serverSession: list.serverSession, agent, src: join(root, 'src'), page, context };
  await page.goto(`${url}/`);
});

test.afterEach(async () => {
  await expect(world.page.getByText('Tell your agents', { exact: false })).toHaveCount(0);
});

test.afterAll(async () => {
  try {
    await world?.context.close().catch(() => {});
    await world?.agent.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

test('closed at the return, with news: the divider says it, above the first new message', async () => {
  const { page } = world;
  const t = await thread(['The rollout plan is ready.', 'Staging is green.']);
  await snooze(t.id);
  const first = await world.agent.send({ project_path: t.project, reply_to: t.root, body: 'Production is at 10%.' });
  await world.agent.send({ project_path: t.project, reply_to: t.root, body: 'Production is at 50%.' });
  await waitBack(page, t.id);
  await open(page, t.id);
  await expect(line(page)).toHaveText(WORDS);
  await expect(line(page)).toHaveAttribute('data-new-divider', '');
  await expect(page.locator('[data-new-divider]')).toHaveCount(1);
  expect(await messageBelow(page)).toBe(String(first.message_id));
  await expect(line(page)).toBeInViewport();
  await expect(page.getByText('New since you looked', { exact: true })).toHaveCount(0);
  await expect(backMark(page, t.id)).toHaveCount(0);
  await shot(page, 'closed-news');
  // Gone on leaving: the next visit is an ordinary one.
  await close(page);
  await quietBand(page);
  await open(page, t.id);
  await expect(page.locator('section.ib-pane [data-message-article]').first()).toBeVisible();
  await expect(line(page)).toHaveCount(0);
  await close(page);
});

test('closed at the return, nothing new, the agent last: above the last message', async () => {
  const { page } = world;
  const t = await thread(['The rollout plan is ready.', 'Staging is green. Nothing else to do here.']);
  await snooze(t.id);
  await waitBack(page, t.id);
  await open(page, t.id);
  await expect(line(page)).toHaveText(WORDS);
  await expect(line(page)).not.toHaveAttribute('data-new-divider', '');
  expect(await messageBelow(page)).toBe(t.last);
  await expect(line(page)).toBeInViewport();
  await shot(page, 'closed-agent-last');
  await close(page);
});

test('closed at the return, nothing new, the person last: above the last message', async () => {
  const { page } = world;
  const t = await thread(['The rollout plan is ready.']);
  const reply = await post(`/api/inbox/messages/${t.root}/reply`, { idempotency_key: `reply-${t.id}`, words: 'Looks fine, go ahead on Monday.' });
  expect(reply.status).toBe(200);
  const mine = ((await reply.json()) as { reply: { id: string } }).reply.id;
  await snooze(t.id);
  await waitBack(page, t.id);
  await open(page, t.id);
  await expect(line(page)).toHaveText(WORDS);
  expect(await messageBelow(page)).toBe(mine);
  await expect(line(page)).toBeInViewport();
  await shot(page, 'closed-person-last');
  await close(page);
});

test('closed at the return, one message: above it', async () => {
  const { page } = world;
  const t = await thread(['The rollout plan is ready.']);
  await snooze(t.id);
  await waitBack(page, t.id);
  await open(page, t.id);
  await expect(line(page)).toHaveText(WORDS);
  expect(await messageBelow(page)).toBe(t.root);
  await expect(line(page)).toBeInViewport();
  await shot(page, 'closed-one-message');
  await close(page);
});

test('closed at the return, a very long last message: the line is on screen when the thread opens', async () => {
  const { page } = world;
  const t = await thread(['The rollout plan is ready.', 'Staging is green.', LONG]);
  await snooze(t.id);
  await waitBack(page, t.id);
  await open(page, t.id);
  await expect(line(page)).toHaveText(WORDS);
  expect(await messageBelow(page)).toBe(t.last);
  await expect(line(page)).toBeInViewport();
  await shot(page, 'closed-long-last');
  await close(page);
});

test('the first window to open gets it; a window opening after does not', async () => {
  const { page, context } = world;
  const t = await thread(['The rollout plan is ready.', 'Staging is green.']);
  await snooze(t.id);
  await waitBack(page, t.id);
  await open(page, t.id);
  await expect(line(page)).toHaveText(WORDS);
  const second = await context.newPage();
  await second.goto(`${world.url}/#thread=${t.id}`);
  await expect(second.locator('section.ib-pane')).toBeVisible();
  await expect(line(second)).toHaveCount(0);
  await second.close();
  await close(page);
});

test('open at the return, in front: it appears at once, the row settles, and the next visit has none', async () => {
  const { page } = world;
  const t = await thread(['The rollout plan is ready.', 'Staging is green.']);
  await page.goto(`${world.url}/#thread=${t.id}`);
  await expect(page.locator('section.ib-pane')).toBeVisible();
  await snooze(t.id, 3000);
  await expect(page.locator('[data-snooze-line]')).toBeVisible();
  await expect(line(page)).toHaveCount(0);
  await expect(line(page)).toHaveText(WORDS, { timeout: 20_000 });
  expect(await messageBelow(page)).toBe(t.last);
  await expect(page.locator('[data-snooze-line]')).toHaveCount(0);
  // Taken as a look: the store's entry ends and the row loses its clock.
  await expect.poll(async () => (await storeRow(t.id)).snooze_back).toBeFalsy();
  await expect(backMark(page, t.id)).toHaveCount(0);
  await expect(line(page)).toHaveText(WORDS);
  await shot(page, 'open-front');
  await close(page);
  await quietBand(page);
  await open(page, t.id);
  await expect(page.locator('section.ib-pane [data-message-article]').first()).toBeVisible();
  await expect(line(page)).toHaveCount(0);
  await close(page);
});

test('open at the return while reading further down: the line draws above and the words under the eye do not move', async () => {
  const { page } = world;
  const t = await thread(['The rollout plan is ready.', LONG]);
  await page.goto(`${world.url}/#thread=${t.id}`);
  await expect(page.locator('section.ib-pane')).toBeVisible();
  await snooze(t.id, 3000);
  const body = page.locator('section.ib-pane .ib-pbody');
  await body.evaluate((b) => (b.scrollTop = b.scrollHeight));
  const last = page.locator(`[data-message-article="${t.last}"]`);
  const before = await last.evaluate((m) => m.getBoundingClientRect().bottom);
  await expect(line(page)).toHaveText(WORDS, { timeout: 20_000 });
  const after = await last.evaluate((m) => m.getBoundingClientRect().bottom);
  expect(Math.abs(after - before)).toBeLessThanOrEqual(2);
  await close(page);
});

/**
 * A tab that really lost the focus to another tab. Playwright's headless shell
 * keeps every page "visible and focused"; full Chromium in new headless mode,
 * with the focus emulation off, gives a real `document.hasFocus() === false` and
 * real focus events. It stays `visibilityState: 'visible'` (nothing hides a
 * headless tab), so the hidden tab below is a stand-in.
 */
async function backgroundTab(): Promise<{ page: Page; toBack: () => Promise<void>; toFront: () => Promise<void>; done: () => Promise<void> }> {
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  let other: Page | null = null;
  return {
    page,
    toBack: async () => {
      await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
      other = await context.newPage();
      await other.goto('about:blank');
      await other.bringToFront();
      await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false);
    },
    toFront: async () => {
      await other?.close();
      await page.bringToFront();
      await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
    },
    done: () => browser.close(),
  };
}

test('open at the return, the tab in the background: the line is there, nothing counts as looked at until the tab comes to the front', async () => {
  const tab = await backgroundTab();
  try {
    const { page } = tab;
    const t = await thread(['The rollout plan is ready.', 'Staging is green.']);
    await page.goto(`${world.url}/#thread=${t.id}`);
    await expect(page.locator('section.ib-pane')).toBeVisible();
    await page.bringToFront();
    await snooze(t.id, 3000);
    await tab.toBack();
    await expect(line(page)).toHaveText(WORDS, { timeout: 20_000 });
    // Not looked at: the return's clock stays on the row, after a good wait.
    await page.waitForTimeout(2000);
    expect((await storeRow(t.id)).snooze_back).toBeTruthy();
    await tab.toFront();
    await expect.poll(async () => (await storeRow(t.id)).snooze_back).toBeFalsy();
    await expect(line(page)).toHaveText(WORDS);
    await expect(page.getByText('Tell your agents', { exact: false })).toHaveCount(0);
    await shot(page, 'open-background-then-front');
  } finally {
    await tab.done();
  }
});

test('closed at the return, the tab in the background: the row comes back and the line waits for the opening', async () => {
  const tab = await backgroundTab();
  try {
    const { page } = tab;
    const t = await thread(['The rollout plan is ready.', 'Staging is green.']);
    await page.goto(`${world.url}/`);
    await expect(page.locator('.ib-listcol')).toBeVisible();
    await snooze(t.id, 3000);
    await tab.toBack();
    await expect.poll(async () => Boolean((await storeRow(t.id)).snooze_back), { timeout: 20_000 }).toBe(true);
    await page.waitForTimeout(1000);
    expect((await storeRow(t.id)).snooze_back).toBeTruthy();
    await tab.toFront();
    await waitBack(page, t.id);
    await open(page, t.id);
    await expect(line(page)).toHaveText(WORDS);
    expect(await messageBelow(page)).toBe(t.last);
    await expect(line(page)).toBeInViewport();
  } finally {
    await tab.done();
  }
});

test('open at the return, the tab hidden (a stand-in: visibilityState and hasFocus overridden): same rule', async () => {
  const { context } = world;
  const page = await context.newPage();
  try {
    await page.addInitScript(() => {
      const w = window as unknown as { __front: boolean };
      w.__front = true;
      Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get: () => (w.__front ? 'visible' : 'hidden') });
      Document.prototype.hasFocus = () => w.__front;
    });
    const t = await thread(['The rollout plan is ready.', 'Staging is green.']);
    await page.goto(`${world.url}/#thread=${t.id}`);
    await expect(page.locator('section.ib-pane')).toBeVisible();
    await page.evaluate(() => {
      (window as unknown as { __front: boolean }).__front = false;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await snooze(t.id, 2000);
    await expect(line(page)).toHaveText(WORDS, { timeout: 20_000 });
    await page.waitForTimeout(1500);
    expect((await storeRow(t.id)).snooze_back).toBeTruthy();
    await page.evaluate(() => {
      (window as unknown as { __front: boolean }).__front = true;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(async () => (await storeRow(t.id)).snooze_back).toBeFalsy();
    await expect(line(page)).toHaveText(WORDS);
  } finally {
    await page.close();
  }
});

test('survives a reply; snoozing again takes it away and an Unsnooze does not bring it back; a second return brings it again', async () => {
  const { page } = world;
  const t = await thread(['The rollout plan is ready.', 'Staging is green.']);
  await snooze(t.id);
  await waitBack(page, t.id);
  await open(page, t.id);
  await expect(line(page)).toHaveText(WORDS);
  const reply = await post(`/api/inbox/messages/${t.root}/reply`, { idempotency_key: `reply-${t.id}`, words: 'Thanks, carry on.' });
  expect(reply.status).toBe(200);
  await expect(page.locator(`[data-message-article="${((await reply.json()) as { reply: { id: string } }).reply.id}"]`)).toBeVisible();
  await expect(line(page)).toHaveText(WORDS);
  await snooze(t.id, 3_600_000);
  await expect(page.locator('[data-snooze-line]')).toBeVisible();
  await expect(line(page)).toHaveCount(0);
  await page.locator('[data-unsnooze]').click();
  await expect(page.locator('[data-snooze-line]')).toHaveCount(0);
  await expect(line(page)).toHaveCount(0);
  await snooze(t.id, 2000);
  await expect(page.locator('[data-snooze-line]')).toBeVisible();
  await expect(line(page)).toHaveText(WORDS, { timeout: 20_000 });
  await close(page);
});

test('an Unsnooze before its time is no return: no line', async () => {
  const { page } = world;
  const t = await thread(['The rollout plan is ready.', 'Staging is green.']);
  await snooze(t.id, 3_600_000);
  await snooze(t.id, null);
  await page.goto(`${world.url}/#thread=${t.id}`);
  await expect(page.locator('section.ib-pane [data-message-article]').first()).toBeVisible();
  await expect(line(page)).toHaveCount(0);
  await close(page);
});

/** A first message with a question, its pick saved and not sent: it stays open however long it is. */
function asking(steps: number): string {
  return [...LONG.split('\n\n').slice(0, steps + 1), ':::question\nShip it on Monday?\n\n- [ ] Yes\n- [ ] No\n:::'].join('\n\n');
}

async function pickUnsent(t: { id: string; root: string }): Promise<void> {
  const read = (await (await fetch(`${world.url}/api/inbox/threads/${t.id}`)).json()) as { thread: { messages: { questions?: { key: string; kind: string; prompt: string; revision: number }[] }[] } };
  const question = read.thread.messages[0]!.questions![0]!;
  const picked = await post(`/api/inbox/messages/${t.root}/picks`, { questions: [{ key: question.key, revision: question.revision, answer: { v: 1, key: question.key, kind: question.kind, prompt: question.prompt, selected: ['Yes'] } }] });
  expect(picked.status, await picked.clone().text()).toBe(200);
}

async function openBack(page: Page, t: { id: string }): Promise<void> {
  await snooze(t.id);
  await expect.poll(async () => Boolean((await storeRow(t.id)).snooze_back), { timeout: 20_000 }).toBe(true);
  await page.goto(`${world.url}/#thread=${t.id}`);
  await expect(line(page)).toHaveText(WORDS);
}

test('a held message too tall for the back line to fit below it: the thread opens at the line', async () => {
  const { page } = world;
  const t = await thread([asking(60), 'Staging is green.']);
  await pickUnsent(t);
  await openBack(page, t);
  expect(await messageBelow(page)).toBe(t.last);
  await expect(line(page)).toBeInViewport();
  await close(page);
});

test('a held message with room for the back line below it: the whole message and the line both show', async () => {
  const { page } = world;
  const t = await thread([asking(6), LONG]);
  await pickUnsent(t);
  await openBack(page, t);
  await expect(line(page)).toBeInViewport();
  await expect(page.locator(`[data-message-article="${t.root}"]`)).toBeInViewport({ ratio: 1 });
  await shot(page, 'held-pick-with-room');
  await close(page);
});

test('no snooze: "New since you looked" still opens at the top of the message above it, however tall', async () => {
  const { page } = world;
  for (const steps of [6, 60]) {
    const t = await thread([asking(steps)]);
    await pickUnsent(t);
    await world.agent.send({ project_path: t.project, reply_to: t.root, body: LONG });
    await page.goto(`${world.url}/#thread=${t.id}`);
    const divider = page.locator('[data-new-divider]');
    await expect(divider).toHaveText('New since you looked');
    const { scrollTop, wanted } = await divider.evaluate((el) => ({ scrollTop: el.closest('.ib-pbody')!.scrollTop, wanted: (el.previousElementSibling as HTMLElement).offsetTop - 6 }));
    expect(Math.abs(scrollTop - wanted)).toBeLessThanOrEqual(1);
    await close(page);
  }
});

test('New message open over the thread at the return: the look waits until it closes', async () => {
  const { page } = world;
  const t = await thread(['The rollout plan is ready.', 'Staging is green.']);
  await page.goto(`${world.url}/#thread=${t.id}`);
  await expect(page.locator('section.ib-pane')).toBeVisible();
  await snooze(t.id, 3000);
  await page.getByRole('button', { name: 'New message' }).click();
  await expect(page.locator('[data-snooze-line]')).toBeVisible();
  await expect.poll(async () => Boolean((await storeRow(t.id)).snooze_back), { timeout: 20_000 }).toBe(true);
  await expect(line(page)).toHaveCount(1, { timeout: 20_000 });
  await page.waitForTimeout(1500);
  expect((await storeRow(t.id)).snooze_back).toBeTruthy();
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await storeRow(t.id)).snooze_back).toBeFalsy();
  await expect(line(page)).toHaveText(WORDS);
  await close(page);
});

test('a message waiting below the view at the return stays unread after the look', async () => {
  const { page } = world;
  const t = await thread(['The rollout plan is ready.', LONG]);
  await page.goto(`${world.url}/#thread=${t.id}`);
  await expect(page.locator('section.ib-pane')).toBeVisible();
  await snooze(t.id, 3000);
  const arrived = await world.agent.send({ project_path: t.project, reply_to: t.root, body: 'Production is at 10%.' });
  await expect(page.locator(`[data-message-article="${arrived.message_id}"]`)).toBeAttached();
  await expect(line(page)).toHaveText(WORDS, { timeout: 20_000 });
  await expect.poll(async () => (await storeRow(t.id)).snooze_back).toBeFalsy();
  await page.waitForTimeout(500);
  expect((await storeRow(t.id)).unread).toBe(true);
  await close(page);
});

test('a phone in WebKit: a held message taller than the view gives way to the back line', async () => {
  test.setTimeout(120_000);
  const browser = await webkit.launch({ args: [] });
  const context = await browser.newContext({ ...devices['iPhone 15'], colorScheme: 'light' });
  const phone = await context.newPage();
  try {
    const t = await thread([asking(6), LONG]);
    await pickUnsent(t);
    await openBack(phone, t);
    await expect(line(phone)).toBeInViewport();
    await shot(phone, 'phone-held-pick');
  } finally {
    await browser.close();
  }
});

test('a phone in WebKit: on screen when the thread opens, with news, the agent last, the person last, a very long last message and one message', async () => {
  test.setTimeout(120_000);
  const browser = await webkit.launch({ args: [] });
  const context = await browser.newContext({ ...devices['iPhone 15'], colorScheme: 'light' });
  const phone = await context.newPage();
  try {
    const news = await thread(['The rollout plan is ready.', 'Staging is green.']);
    const agentLast = await thread(['The rollout plan is ready.', 'Staging is green. Nothing else to do here.']);
    const personLast = await thread(['The rollout plan is ready.']);
    const reply = await post(`/api/inbox/messages/${personLast.root}/reply`, { idempotency_key: `reply-${personLast.id}`, words: 'Looks fine, go ahead on Monday.' });
    expect(reply.status).toBe(200);
    const long = await thread(['The rollout plan is ready.', 'Staging is green.', LONG]);
    const one = await thread(['The rollout plan is ready.']);
    const cases = { news, 'agent-last': agentLast, 'person-last': personLast, 'long-last': long, 'one-message': one };
    for (const t of Object.values(cases)) await snooze(t.id, 4000);
    await world.agent.send({ project_path: news.project, reply_to: news.root, body: 'Production is at 10%.' });
    await expect.poll(async () => Boolean((await storeRow(one.id)).snooze_back), { timeout: 20_000 }).toBe(true);
    for (const [name, t] of Object.entries(cases)) {
      await phone.goto(`${world.url}/#thread=${t.id}`);
      await expect(line(phone)).toHaveText(WORDS);
      await expect(line(phone)).toBeInViewport();
      if (name === 'long-last') expect(await messageBelow(phone)).toBe(long.last);
      await shot(phone, `phone-${name}`);
    }
  } finally {
    await browser.close();
  }
});

test('open at the return on a phone in WebKit, reading further down: the words under the eye do not move', async () => {
  test.setTimeout(120_000);
  const browser = await webkit.launch({ args: [] });
  const context = await browser.newContext({ ...devices['iPhone 15'], colorScheme: 'light' });
  const phone = await context.newPage();
  try {
    const t = await thread(['The rollout plan is ready.', LONG]);
    await phone.goto(`${world.url}/#thread=${t.id}`);
    await expect(phone.locator('section.ib-pane')).toBeVisible();
    await snooze(t.id, 3000);
    const body = phone.locator('section.ib-pane .ib-pbody');
    await body.evaluate((b) => (b.scrollTop = b.scrollHeight));
    const last = phone.locator(`[data-message-article="${t.last}"]`);
    const before = await last.evaluate((m) => m.getBoundingClientRect().bottom);
    await expect(line(phone)).toHaveText(WORDS, { timeout: 20_000 });
    const after = await last.evaluate((m) => m.getBoundingClientRect().bottom);
    test.info().annotations.push({ type: 'webkit shift', description: String(after - before) });
    expect(Math.abs(after - before)).toBeLessThanOrEqual(2);
  } finally {
    await browser.close();
  }
});

test('an agent archives a snoozed thread and the time passes: no stale "Snoozed until" line', async () => {
  const { page } = world;
  const t = await thread(['The rollout plan is ready.', 'Staging is green.']);
  await snooze(t.id, 1500);
  await world.agent.resolve(t.root);
  await page.waitForTimeout(2500);
  await page.goto(`${world.url}/#thread=${t.id}`);
  await expect(page.locator('section.ib-pane [data-message-article]').first()).toBeVisible();
  await shot(page, 'agent-archived-after-lapse');
  await expect(page.locator('[data-snooze-line]')).toHaveCount(0);
  await expect(line(page)).toHaveCount(0);
  const row2 = await storeRow(t.id);
  expect(row2.snoozed).toBeFalsy();
  expect(row2.snooze_back).toBeFalsy();
  await close(page);
});

test('an agent archives a snoozed thread, the time passes, the person unarchives: no clock and no line', async () => {
  const { page } = world;
  const t = await thread(['The rollout plan is ready.', 'Staging is green.']);
  await snooze(t.id, 1500);
  await world.agent.resolve(t.root);
  await page.waitForTimeout(2500);
  expect((await post(`/api/inbox/messages/${t.root}/resolve`, { resolved: false })).status).toBe(200);
  expect((await storeRow(t.id)).snooze_back).toBeFalsy();
  await page.goto(`${world.url}/#thread=${t.id}`);
  await expect(page.locator('section.ib-pane [data-message-article]').first()).toBeVisible();
  await expect(line(page)).toHaveCount(0);
  await close(page);
});
