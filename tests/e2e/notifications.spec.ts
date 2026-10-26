/**
 * Plannotator Inbox notifications from the open page (record 6.x, 7.2),
 * proved in a real Chromium against the compiled binary. Agents write through
 * `plannotator inbox mcp` with the MCP SDK's stdio client (scripts/inbox-sim.ts).
 *
 * The browser's own pieces stay real: the permission is Chromium's, granted
 * per origin through the context (`context.grantPermissions`), and every
 * `new Notification(...)` is the real constructor, which an init script
 * subclasses only to record its calls. Two things a headless browser cannot
 * do are set by that script: the person's Allow in the browser's own prompt
 * (the real `requestPermission` runs; the context's grant answers it), whether the tab is in front
 * (`document.visibilityState` and `document.hasFocus()`, which Playwright
 * otherwise reports as always focused), and the banner itself, which the test
 * reads as the recorded title, body and tag.
 *
 * The rules (approval "inbox-notify-every-thread"): every new thread an agent
 * starts notifies, the tab in front or not; a new question notifies unless it
 * is in the thread open on screen; plain news in a thread never does.
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 * PNGs of the proved states land in .local/proof/notifications/.
 */

import { markTourDecided } from '../helpers/tour-decided';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { join, resolve } from 'node:path';
import { DEMO_MESSAGES, SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, rememberInboxOf, removeInboxScratch, stopScratchInbox } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'notifications');

interface Recorded {
  title: string;
  body: string;
  tag: string;
}

declare global {
  interface Window {
    __notifications: { calls: Recorded[]; instances: Notification[]; prompts: string[] };
    __front: { visible: boolean; focused: boolean };
  }
}

/** Runs in the page before its own code. */
function recordNotifications(): void {
  const Real = window.Notification;
  const calls: Recorded[] = [];
  const instances: Notification[] = [];
  class RecordedNotification extends Real {
    constructor(title: string, options: NotificationOptions = {}) {
      super(title, options);
      calls.push({ title, body: options.body ?? '', tag: options.tag ?? '' });
      instances.push(this);
    }
  }
  // The browser's prompt is its own chrome, which a test cannot click: the real
  // request runs, and the context's grant stands in for the person's Allow.
  const prompts: string[] = [];
  const realRequest = Real.requestPermission.bind(Real);
  RecordedNotification.requestPermission = () =>
    new Promise<NotificationPermission>((answer) => {
      prompts.push(location.origin);
      void realRequest().then(answer);
      void navigator.permissions.query({ name: 'notifications' }).then((status) =>
        status.addEventListener('change', () => {
          if (status.state !== 'prompt') answer(status.state === 'granted' ? 'granted' : 'denied');
        }),
      );
    });
  window.Notification = RecordedNotification as typeof Notification;
  window.__notifications = { calls, instances, prompts };
  const front = { visible: true, focused: true };
  window.__front = front;
  Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get: () => (front.visible ? 'visible' : 'hidden') });
  Document.prototype.hasFocus = () => front.focused;
}

interface World {
  root: string;
  dataDir: string;
  env: Record<string, string>;
  url: string;
  billing: string;
  docs: string;
  agents: SimAgent[];
  context: BrowserContext;
  page: Page;
  errors: string[];
  blockers: Server[];
}

let world: World;

function registry(): { pid: number; port: number; serverSession: string; url: string } {
  return JSON.parse(readFileSync(join(world.dataDir, 'inbox', 'inbox.json'), 'utf8'));
}

function config(): { inboxNotifications?: Record<string, unknown> } {
  // Not written yet: an expect.poll on it waits instead of failing on ENOENT.
  const file = join(world.dataDir, 'config.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
}

function startInbox(): string {
  const started = spawnSync(binary, ['inbox', '--background'], { env: world.env, encoding: 'utf8', timeout: 60_000 });
  // Each start's pid, for the teardown (inbox-scratch.ts): the registry names only the latest.
  rememberInboxOf(world.dataDir);
  expect(started.status, started.stderr).toBe(0);
  return started.stdout.trim();
}

/** Stop the Inbox, hold its port with something else, start it again: it comes up on another port (another origin). */
async function moveInbox(): Promise<string> {
  const before = registry();
  await stopScratchInbox(world.dataDir);
  await expect
    .poll(async () => {
      try {
        await fetch(`http://127.0.0.1:${before.port}/api/inbox/health`);
        return 'up';
      } catch {
        return 'down';
      }
    })
    .toBe('down');
  // Something else on the port: it drops every connection (the old page's stream retrying, among them).
  const blocker = createServer((socket) => {
    socket.on('error', () => {});
    socket.destroy();
  });
  await new Promise<void>((done) => blocker.listen(before.port, '127.0.0.1', done));
  world.blockers.push(blocker);
  const url = startInbox();
  expect(new URL(url).port).not.toBe(String(before.port));
  world.url = url;
  return url;
}

async function shot(name: string): Promise<void> {
  const page = world.page;
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(proofDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

async function agent(name: string, host: string): Promise<SimAgent> {
  const sim = await SimAgent.connect({ binary, env: world.env, name, host });
  world.agents.push(sim);
  return sim;
}

const calls = (): Promise<Recorded[]> => world.page.evaluate(() => window.__notifications.calls);

/** Put the tab in front or away, with the events a browser fires when that happens. */
async function setFront(visible: boolean, focused: boolean): Promise<void> {
  await world.page.evaluate(
    ([v, f]) => {
      Object.assign(window.__front, { visible: v, focused: f });
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event(f ? 'focus' : 'blur'));
    },
    [visible, focused] as const,
  );
}

/** Every Inbox notification carries this one tag, so the browser shows one at a time. */
const TAG = 'plannotator-inbox';
let stoppedThread = '';
/** The Pi agent whose thread is Stopped on you. */
let piAgent: SimAgent;

/** The page has read the list the agent's write produced: the held list shows it behind "N new" (or on screen). */
async function pageSaw(threadId: string): Promise<void> {
  await expect
    .poll(async () => {
      const onScreen = await world.page.locator(`[data-thread-id="${threadId}"]`).count();
      const notice = await world.page.locator('[data-inbox-notice]').count();
      return onScreen > 0 || notice > 0;
    })
    .toBe(true);
  // The notification step runs right after that list read; give it a beat to have run.
  await world.page.waitForTimeout(400);
}

/** A message with one question; `line` adds a `Stopped:` or `Holds up:` line. */
const question = (prompt: string, line?: string) =>
  ['A short note before I go on.', '', ':::question', prompt, ...(line ? [line] : []), '', '- [ ] Yes', '- [ ] No', ':::'].join('\n');

test.describe.configure({ mode: 'serial' });
// Chromium's new headless mode, the browser itself: the headless shell answers
// every notification permission with "denied", so the ask could never show.
test.use({ channel: 'chromium' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-notify-');
  const dataDir = join(root, 'data');
  const home = join(root, 'home');
  mkdirSync(home);
  // The first-run screen's notifications ask, not the tour's entry screen (inbox-tour.spec.ts proves that one).
  markTourDecided(dataDir);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  await context.addInitScript(recordNotifications);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  world = {
    root,
    dataDir,
    env: { PATH: process.env.PATH ?? '', HOME: home, PLANNOTATOR_DATA_DIR: dataDir },
    url: '',
    billing: scratchProject(join(root, 'src'), 'billing-svc'),
    docs: scratchProject(join(root, 'src'), 'docs-site'),
    agents: [],
    context,
    page,
    errors,
    blockers: [],
  };
  world.url = startInbox();
});

test.afterAll(async () => {
  try {
    if (!world) return;
    await Promise.all(world.agents.map((a) => a.close().catch(() => {})));
    await world.context.close();
    for (const blocker of world.blockers) blocker.close();
  } finally {
    // Every Inbox this spec started, then its folders (inbox-scratch.ts).
    await removeInboxScratch();
  }
});

test('the first-run screen asks before the first question; once the first thread arrives the ask is above the list, and stays until answered', async () => {
  const { page } = world;
  await page.goto(world.url);
  await expect(page.getByRole('heading', { name: 'No agent has written yet', exact: true })).toBeVisible();
  expect(await page.evaluate(() => Notification.permission)).toBe('default');
  // The moment before the first question (the onboarding audit, finding 3): under Try it, in its own words.
  const firstRun = page.locator('[data-first-run-ask] [data-notification-ask="ask"]');
  await expect(firstRun).toBeVisible();
  await expect(firstRun).toContainText('Get a desktop notice when the first question arrives.');
  await expect(firstRun.getByRole('button', { name: 'Turn on' })).toBeVisible();
  await expect(page.locator('[data-notification-ask]')).toHaveCount(1);
  expect(await calls()).toEqual([]);
  await shot('6.0-ask-first-run');

  const claude = await agent('Claude Code', 'claude-code');
  const sent = await claude.send({ project_path: world.billing, body: DEMO_MESSAGES.stopped });
  await expect(page.locator(`[data-thread-id="${sent.thread_id}"]`)).toBeVisible();
  const ask = page.locator('[data-notification-ask="ask"]');
  await expect(ask).toBeVisible();
  await expect(ask).toContainText('Get a desktop notice when an agent needs you.');
  await expect(ask.getByRole('button', { name: 'Turn on' })).toBeVisible();
  // Nothing was raised: the browser has not been asked.
  expect(await calls()).toEqual([]);
  await shot('6.1-ask');

  // A reload keeps it: a missing permission fails silently, so the line stays until it is answered.
  await page.reload();
  await expect(page.locator(`[data-thread-id="${sent.thread_id}"]`)).toBeVisible();
  await expect(page.locator('[data-notification-ask="ask"]')).toBeVisible();

  // Beside an open thread the list is a 380 px column. The words keep the line's width and the buttons go on
  // a row under them, never squeezing the words into a narrow column between the icon and the buttons.
  await page.locator(`[data-thread-id="${sent.thread_id}"]`).click();
  await expect(page.locator('.ib-listcol.ib-narrow')).toBeVisible();
  const line = page.locator('[data-notification-ask="ask"]');
  await expect(line).toBeVisible();
  await expect.poll(async () => (await line.boundingBox())?.width ?? Infinity).toBeLessThan(420);
  const [lineBox, textBox, actsBox] = await Promise.all([
    line.boundingBox(),
    line.locator('.ib-ask-text').boundingBox(),
    line.locator('.ib-ask-acts').boundingBox(),
  ]);
  expect(lineBox!.width).toBeLessThan(420);
  expect(textBox!.width).toBeGreaterThan(lineBox!.width * 0.7);
  expect(actsBox!.y).toBeGreaterThanOrEqual(textBox!.y + textBox!.height);
  await shot('6.1-ask-beside-thread');
  await page.goto(world.url);
});

test('one origin: the Inbox opened at 127.0.0.1 lands on localhost, its #thread link kept', async () => {
  const { page } = world;
  const at = new URL(world.url);
  const loopback = `http://127.0.0.1:${at.port}/#thread=msg_not_a_real_thread`;
  await page.goto(loopback);
  await expect.poll(() => new URL(page.url()).hostname).toBe('localhost');
  expect(new URL(page.url()).port).toBe(at.port);
  expect(new URL(page.url()).hash).toBe('#thread=msg_not_a_real_thread');
  // The API at 127.0.0.1 answers where it is asked (agents and scripts use it).
  const health = await page.request.get(`http://127.0.0.1:${at.port}/api/inbox/health`);
  expect(health.status()).toBe(200);
  await page.goto(world.url);
});

test('"Not now" is kept by the Inbox: it holds across a reload and a port change', async () => {
  const { page } = world;
  const opencode = await agent('OpenCode', 'opencode');
  const first = await opencode.send({ project_path: world.docs, body: DEMO_MESSAGES.holding });
  await pageSaw(first.thread_id);
  await page.locator('[data-notification-ask="ask"]').getByRole('button', { name: 'Not now' }).click();
  await expect(page.locator('[data-notification-ask]')).toHaveCount(0);
  await expect.poll(() => config().inboxNotifications?.dismissed).toBe(true);

  await page.reload();
  await expect(page.locator(`[data-thread-id="${first.thread_id}"]`)).toBeVisible();
  const again = await opencode.send({ project_path: world.docs, body: question('Publish the install page today?') });
  await pageSaw(again.thread_id);
  await expect(page.locator('[data-notification-ask]')).toHaveCount(0);

  // Another port is another origin: nothing the page kept for itself would follow it.
  const before = new URL(page.url()).origin;
  const url = await moveInbox();
  await page.goto(url);
  expect(new URL(page.url()).origin).not.toBe(before);
  await expect(page.locator(`[data-thread-id="${first.thread_id}"]`)).toBeVisible();
  const moved = await agent('Codex', 'codex');
  const third = await moved.send({ project_path: world.billing, body: question('Rename the retry flag?') });
  await pageSaw(third.thread_id);
  await expect(page.locator('[data-notification-ask]')).toHaveCount(0);
});

test('Settings shows the status, a test and the reach; after a port change "moved" shows at once, and Allow asks the browser', async () => {
  const { page, context } = world;
  await context.grantPermissions(['notifications'], { origin: new URL(world.url).origin });
  await page.getByRole('button', { name: 'Settings' }).click();
  const block = page.locator('[data-settings-notifications]');
  // The status is read live: the grant above shows without a reload.
  await expect(block).toContainText('On for this address');
  // This tab is open and allowed: the server counts it.
  await expect(block.locator('[data-notify-reach="yes"]')).toContainText('Yes, through this tab');
  // The test notice: raised on its own tag, with the hint for a system that hides it.
  const tested = (await calls()).length;
  await block.getByRole('button', { name: 'Send a test notification' }).click();
  await expect.poll(async () => (await calls()).length).toBe(tested + 1);
  expect((await calls()).at(-1)).toMatchObject({ title: 'Plannotator Inbox: test notification', tag: 'plannotator-inbox-test' });
  await expect(block.locator('[data-notify-test]')).toContainText("Didn't see it?");
  const main = block.getByRole('switch', { name: 'Desktop notifications' });
  // On by default, and allowed by the browser: the one notifications switch reads on (the other is the question sound's).
  await expect(main).toHaveAttribute('aria-checked', 'true');
  await expect(block.getByRole('switch', { name: 'Desktop notifications' })).toHaveCount(1);
  await expect(block.getByRole('switch')).toHaveCount(2);
  await main.click();
  await expect(main).toHaveAttribute('aria-checked', 'false');
  await expect.poll(() => config().inboxNotifications?.enabled).toBe(false);
  await main.click();
  await expect(main).toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => config().inboxNotifications).toEqual({ dismissed: false, enabled: true, allowedOrigin: new URL(world.url).origin });
  await page.locator('.ib-spage').evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await shot('7.2-settings-notifications');

  // The Inbox moves: this origin has no permission yet, so the line shows at once, worded for the move
  // (no question has to arrive first: notifications are silently off until it is answered).
  const url = await moveInbox();
  await page.goto(url);
  expect(await page.evaluate(() => Notification.permission)).toBe('default');
  const ask = page.locator('[data-notification-ask="moved"]');
  await expect(ask).toContainText('Notifications are off at this address.');
  await expect(ask).toContainText(new URL(url).host);
  await shot('6.1-moved');
  // Settings says the same, with Allow.
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.locator('[data-settings-notifications] [data-notify-status="not-allowed"]')).toBeVisible();
  await expect(page.locator('[data-settings-notifications] [data-notify-reach="no"]')).toBeVisible();
  await page.goto(url);
  const claude = world.agents[0]!;
  const sent = await claude.send({ project_path: world.billing, body: question('Keep the old retry window?') });
  await pageSaw(sent.thread_id);
  await expect(ask).toBeVisible();

  // Allow raises the browser's own prompt; the context answers Allow for this origin.
  await ask.getByRole('button', { name: 'Allow' }).click();
  await expect.poll(() => page.evaluate(() => window.__notifications.prompts)).toEqual([new URL(url).origin]);
  await context.grantPermissions(['notifications'], { origin: new URL(url).origin });
  await expect(page.locator('[data-notification-ask]')).toHaveCount(0);
  await expect.poll(() => config().inboxNotifications?.allowedOrigin).toBe(new URL(url).origin);
});

test('an Inbox restart forgets the windows; the open tab reconnects and reports its permission as it is now', async () => {
  const { page } = world;
  // This tab's stream was opened before Allow, so its URL still says permission=default.
  const health = async () =>
    ((await (await fetch(`${world.url}api/inbox/health`)).json()) as { notify_reach: { windows: number; allowed: number } }).notify_reach;
  await expect.poll(async () => (await health()).allowed).toBe(1);
  const before = registry();
  await stopScratchInbox(world.dataDir);
  const url = startInbox();
  expect(new URL(url).port).toBe(String(before.port));
  // EventSource retries every 2 s; on its hello the page reports again.
  await expect.poll(async () => health(), { timeout: 20_000 }).toMatchObject({ windows: 1, allowed: 1 });
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.locator('[data-settings-notifications] [data-notify-reach="yes"]')).toBeVisible();
  await page.goto(url);
});

test('with permission, a Stopped thread raises exactly one notification with the subject', async () => {
  const { page } = world;
  await page.goto(world.url);
  await expect(page.locator('.ib-lbody [data-thread-id]').first()).toBeVisible();
  await setFront(false, false);
  const before = (await calls()).length;
  const pi = await agent('Pi', 'pi');
  piAgent = pi;
  // Two items in one message (a Stopped line and a Holds up line): one notification for the thread.
  const sent = await pi.send({ project_path: world.billing, body: DEMO_MESSAGES.stopped });
  await pageSaw(sent.thread_id);
  const raised = (await calls()).slice(before);
  expect(raised).toEqual([
    {
      title: 'billing-svc: Pi stopped on you',
      body: 'Which way should the worker go on a Stripe 409?',
      tag: TAG,
    },
  ]);
  stoppedThread = sent.thread_id;
  writeFileSync(join(proofDir, '6.2-notification.json'), `${JSON.stringify(raised[0], null, 2)}\n`);
});

test('a second item in the same thread replaces the first, and the title follows the thread\'s section', async () => {
  const pi = world.agents.at(-1)!;
  const before = await calls();
  const next = await pi.send({ project_path: world.billing, body: question('Also cap the retries at the worker?') });
  expect(next.thread_id).toBe(stoppedThread);
  await expect.poll(async () => (await calls()).length).toBe(before.length + 1);
  await world.page.waitForTimeout(400);
  // The new question is a plain one, but the thread is still Stopped on you.
  expect((await calls()).slice(before.length)).toEqual([
    { title: 'billing-svc: Pi stopped on you', body: 'Which way should the worker go on a Stripe 409?', tag: TAG },
  ]);
});

test('in front: every new thread notifies, a question in the thread open on screen does not, one in another thread does', async () => {
  const { page } = world;
  await setFront(true, true);
  const before = (await calls()).length;
  // A new thread that asks nothing notifies, the tab in front.
  const amp = await agent('Amp', 'amp');
  const news = await amp.send({ project_path: world.docs, body: 'Deployed the docs preview to staging. Nothing needed from you yet.' });
  await expect.poll(async () => (await calls()).length).toBe(before + 1);
  const first = (await calls()).at(-1)!;
  expect(first.title.startsWith('docs-site: Amp')).toBe(true);
  expect(first.title).not.toContain('waiting');
  expect(first.tag).toBe(TAG);
  // A second new thread within the burst window: one notice for both, on the one tag.
  const codex = await agent('Codex', 'codex');
  const sent = await codex.send({ project_path: world.docs, body: question('Ship the install page?', 'Stopped: the docs deploy waits on this.') });
  await expect.poll(async () => (await calls()).length).toBe(before + 2);
  expect((await calls()).at(-1)).toMatchObject({ body: 'docs-site', tag: TAG });
  expect((await calls()).at(-1)!.title.startsWith('2 ')).toBe(true);
  await pageSaw(news.thread_id);
  await shot('6.3-focused-new-thread');

  // Open Codex's thread: a new question in it, on screen, raises nothing.
  await page.evaluate((id) => {
    location.hash = `thread=${id}`;
  }, sent.thread_id);
  await expect(page.locator('section.ib-pane')).toContainText('Ship the install page?');
  const opened = (await calls()).length;
  const again = await codex.send({ project_path: world.docs, body: question('And publish the changelog with it?') });
  expect(again.thread_id).toBe(sent.thread_id);
  await expect(page.locator('section.ib-pane')).toContainText('And publish the changelog with it?');
  await page.waitForTimeout(600);
  expect((await calls()).length).toBe(opened);

  // Plain news in an existing thread never notifies.
  await piAgent.send({ project_path: world.billing, body: 'Retried the 409 once more; same answer.' });
  await page.waitForTimeout(800);
  expect((await calls()).length).toBe(opened);

  // A question in another thread, with this one open: it notifies.
  await piAgent.send({ project_path: world.billing, body: question('Should the worker give up after three tries?') });
  await expect.poll(async () => (await calls()).length).toBe(opened + 1);
  expect((await calls()).at(-1)!.tag).toBe(TAG);
});

test('a click on the notification focuses the tab and opens the thread', async () => {
  const { page } = world;
  await setFront(false, false);
  const codex = world.agents.at(-1)!;
  const sent = await codex.send({ project_path: world.docs, body: question('Move the changelog under docs/?') });
  await expect.poll(async () => (await calls()).at(-1)?.title).toBe('docs-site: Codex stopped on you');
  await page.evaluate(() => window.__notifications.instances.at(-1)!.dispatchEvent(new Event('click')));
  await expect(page).toHaveURL(new RegExp(`#thread=${sent.thread_id}$`));
  // The thread this agent opened a moment ago (its session's thread), with the new question in it.
  await expect(page.locator('section.ib-pane')).toContainText('Move the changelog under docs/?');
  await shot('6.2-click-opened-thread');
});

test('a tab the browser froze in the background raises what arrived meanwhile as it wakes, once', async () => {
  const { page, context } = world;
  await setFront(true, true);
  await setFront(false, false);
  const before = (await calls()).length;
  // Chrome's own freeze (Energy Saver, intensive background policies): nothing in the page runs.
  const cdp = await context.newCDPSession(page);
  await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
  const codex = world.agents.find((a) => a.name === 'Codex') ?? (await agent('Codex', 'codex'));
  const sent = await codex.send({ project_path: world.billing, body: question('Archive the 2025 invoices?', 'Stopped: the cleanup waits on this.') });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await cdp.send('Page.setWebLifecycleState', { state: 'active' });
  await expect.poll(async () => (await calls()).length).toBe(before + 1);
  const woke = (await calls()).at(-1)!;
  expect(woke.tag).toBe(TAG);
  expect(woke.title).toContain('Codex');
  await page.waitForTimeout(800);
  expect((await calls()).length).toBe(before + 1);
  await expect(page.locator(`[data-thread-id="${sent.thread_id}"], [data-inbox-notice]`).first()).toBeVisible();
  await cdp.detach();
});

test('a burst becomes one notice, "3 waiting in 2 projects", and its click opens the list', async () => {
  const { page } = world;
  // In front and away again: a new burst starts.
  await setFront(true, true);
  await setFront(false, false);
  const before = (await calls()).length;
  const claude = await agent('Claude Code', 'claude-code');
  const first = await claude.send({ project_path: world.docs, body: DEMO_MESSAGES.holding });
  // One thread so far: its own banner. A Holds up thread reads "is waiting on you".
  await expect.poll(async () => (await calls()).length).toBe(before + 1);
  expect((await calls()).at(-1)).toEqual({
    title: 'docs-site: Claude Code is waiting on you',
    body: 'Detect the installed agents, or ask the reader to pick?',
    tag: TAG,
  });
  const second = await (await agent('OpenCode', 'opencode')).send({ project_path: world.billing, body: question('Drop the old refunds table?') });
  await expect.poll(async () => (await calls()).length).toBe(before + 2);
  const third = await (await agent('Pi', 'pi')).send({ project_path: world.billing, body: question('Rotate the webhook secret now?') });
  await expect.poll(async () => (await calls()).length).toBe(before + 3);
  const raised = (await calls()).slice(before);
  // Each replaces the last on the one tag: the browser shows only the summary.
  expect(raised.map((c) => c.tag)).toEqual([TAG, TAG, TAG]);
  expect(raised.slice(1)).toEqual([
    { title: '2 waiting in 2 projects', body: 'docs-site, billing-svc', tag: TAG },
    { title: '3 waiting in 2 projects', body: 'docs-site, billing-svc', tag: TAG },
  ]);
  writeFileSync(join(proofDir, '6.2-burst.json'), `${JSON.stringify(raised, null, 2)}\n`);

  await page.evaluate(() => window.__notifications.instances.at(-1)!.dispatchEvent(new Event('click')));
  // The list at rest, as it now is: no thread open, nothing held behind "N new".
  await expect(page).not.toHaveURL(/#thread=/);
  await expect(page.locator('section.ib-pane')).toHaveCount(0);
  await expect(page.locator('[data-inbox-notice]')).toHaveCount(0);
  for (const sent of [first, second, third]) await expect(page.locator(`.ib-lbody [data-thread-id="${sent.thread_id}"]`)).toBeVisible();
  await shot('6.2-burst-opened-list');
});

test('the Settings switch off raises nothing', async () => {
  const { page } = world;
  await setFront(true, true);
  await setFront(false, false);
  await page.getByRole('button', { name: 'Settings' }).click();
  const block = page.locator('[data-settings-notifications]');
  const main = block.getByRole('switch', { name: 'Desktop notifications' });
  await main.click();
  await expect(main).toHaveAttribute('aria-checked', 'false');
  await expect.poll(() => config().inboxNotifications?.enabled).toBe(false);
  const before = (await calls()).length;
  const codex = await agent('Codex', 'codex');
  const off = await codex.send({ project_path: world.billing, body: question('Pause the nightly import?', 'Stopped: the import job waits on this.') });
  await expect.poll(async () => (await page.request.get(`${world.url}api/inbox/threads/${off.thread_id}`)).status()).toBe(200);
  await page.waitForTimeout(800);
  expect((await calls()).length).toBe(before);

  // Back on, the next item in that thread notifies: the switch was the only thing holding it.
  await main.click();
  await expect(main).toHaveAttribute('aria-checked', 'true');
  await codex.send({ project_path: world.billing, body: question('And keep the weekly one?') });
  await expect.poll(async () => (await calls()).length).toBe(before + 1);
  expect((await calls()).at(-1)).toMatchObject({ title: 'billing-svc: Codex stopped on you', tag: TAG });
});

test('no page errors along the way', () => {
  expect(world.errors).toEqual([]);
});
