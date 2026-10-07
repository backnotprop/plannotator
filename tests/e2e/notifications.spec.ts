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
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 * PNGs of the proved states land in .local/proof/notifications/.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DEMO_MESSAGES, SimAgent, scratchProject } from '../../scripts/inbox-sim';

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
  return JSON.parse(readFileSync(join(world.dataDir, 'config.json'), 'utf8'));
}

function startInbox(): string {
  const started = spawnSync(binary, ['inbox', '--background'], { env: world.env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  return started.stdout.trim();
}

/** Stop the Inbox, hold its port with something else, start it again: it comes up on another port (another origin). */
async function moveInbox(): Promise<string> {
  const before = registry();
  process.kill(before.pid, 'SIGTERM');
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

async function setFront(visible: boolean, focused: boolean): Promise<void> {
  await world.page.evaluate(([v, f]) => Object.assign(window.__front, { visible: v, focused: f }), [visible, focused] as const);
}

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
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-notify-')));
  const dataDir = join(root, 'data');
  const home = join(root, 'home');
  mkdirSync(home);
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
  if (!world) return;
  await Promise.all(world.agents.map((a) => a.close().catch(() => {})));
  await world.context.close();
  try {
    process.kill(registry().pid, 'SIGTERM');
  } catch {
    // Already gone.
  }
  for (const blocker of world.blockers) blocker.close();
  rmSync(world.root, { recursive: true, force: true });
});

test('the ask appears when the first thread arrives, never on first paint', async () => {
  const { page } = world;
  await page.goto(world.url);
  await expect(page.getByRole('heading', { name: 'No agent has written yet.' })).toBeVisible();
  expect(await page.evaluate(() => Notification.permission)).toBe('default');
  await page.waitForTimeout(500);
  await expect(page.locator('[data-notification-ask]')).toHaveCount(0);

  const claude = await agent('Claude Code', 'claude-code');
  const sent = await claude.send({ project_path: world.billing, body: DEMO_MESSAGES.stopped });
  await expect(page.locator(`[data-thread-id="${sent.thread_id}"]`)).toBeVisible();
  const ask = page.locator('[data-notification-ask="ask"]');
  await expect(ask).toBeVisible();
  await expect(ask).toContainText('Get a desktop notice when an agent stops on you.');
  await expect(ask.getByRole('button', { name: 'Turn on' })).toBeVisible();
  // Nothing was raised: the browser has not been asked.
  expect(await calls()).toEqual([]);
  await shot('6.1-ask');

  // A reload paints the list without the ask: it comes back only when something new arrives.
  await page.reload();
  await expect(page.locator(`[data-thread-id="${sent.thread_id}"]`)).toBeVisible();
  await page.waitForTimeout(500);
  await expect(page.locator('[data-notification-ask]')).toHaveCount(0);
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

test('Settings turns them on; after a port change the line returns once as "moved", and Turn on asks the browser', async () => {
  const { page, context } = world;
  await context.grantPermissions(['notifications'], { origin: new URL(world.url).origin });
  await page.getByRole('button', { name: 'Settings' }).click();
  const block = page.locator('[data-settings-notifications]');
  await expect(block).toContainText('Allowed in this browser');
  const main = block.getByRole('switch', { name: 'Desktop notifications' });
  // On by default, and allowed by the browser: the switch reads on, all three sections notify.
  await expect(main).toHaveAttribute('aria-checked', 'true');
  for (const label of ['Stopped on you', 'Holding up work', 'Waiting on you']) {
    await expect(block.getByRole('switch', { name: `Notify for ${label}` })).toHaveAttribute('aria-checked', 'true');
  }
  await main.click();
  await expect(main).toHaveAttribute('aria-checked', 'false');
  await expect.poll(() => config().inboxNotifications?.enabled).toBe(false);
  await main.click();
  await expect(main).toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => config().inboxNotifications).toEqual({ dismissed: false, enabled: true, allowedOrigin: new URL(world.url).origin });
  await page.locator('.ib-spage').evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await shot('7.2-settings-notifications');

  // The Inbox moves: this origin has no permission yet, so the line returns, worded for the move.
  const url = await moveInbox();
  await page.goto(url);
  expect(await page.evaluate(() => Notification.permission)).toBe('default');
  const claude = world.agents[0]!;
  const sent = await claude.send({ project_path: world.billing, body: question('Keep the old retry window?') });
  await pageSaw(sent.thread_id);
  const ask = page.locator('[data-notification-ask="moved"]');
  await expect(ask).toContainText('The Inbox moved to a new address.');
  await shot('6.1-moved');

  // Turn on raises the browser's own prompt; the context answers Allow for this origin.
  await ask.getByRole('button', { name: 'Turn on' }).click();
  await expect.poll(() => page.evaluate(() => window.__notifications.prompts)).toEqual([new URL(url).origin]);
  await context.grantPermissions(['notifications'], { origin: new URL(url).origin });
  await expect(page.locator('[data-notification-ask]')).toHaveCount(0);
  await expect.poll(() => config().inboxNotifications?.allowedOrigin).toBe(new URL(url).origin);
});

test('with permission, a Stopped thread raises exactly one notification with the subject, tagged by the thread', async () => {
  const { page } = world;
  await page.goto(world.url);
  await expect(page.locator('.ib-lbody [data-thread-id]').first()).toBeVisible();
  await setFront(false, false);
  const before = (await calls()).length;
  const pi = await agent('Pi', 'pi');
  // Two items in one message (a Stopped line and a Holds up line): one notification for the thread.
  const sent = await pi.send({ project_path: world.billing, body: DEMO_MESSAGES.stopped });
  await pageSaw(sent.thread_id);
  const raised = (await calls()).slice(before);
  expect(raised).toEqual([
    {
      title: 'billing-svc: Pi stopped on you',
      body: 'Which way should the worker go on a Stripe 409?',
      tag: sent.thread_id,
    },
  ]);
  writeFileSync(join(proofDir, '6.2-notification.json'), `${JSON.stringify(raised[0], null, 2)}\n`);
});

test('a second item in the same thread replaces the first: the same tag, so the browser shows one', async () => {
  const pi = world.agents.at(-1)!;
  const before = await calls();
  const first = before.at(-1)!;
  const next = await pi.send({ project_path: world.billing, body: question('Also cap the retries at the worker?') });
  expect(next.thread_id).toBe(first.tag);
  await expect.poll(async () => (await calls()).length).toBe(before.length + 1);
  await world.page.waitForTimeout(400);
  const raised = (await calls()).slice(before.length);
  expect(raised.map((c) => c.tag)).toEqual([first.tag]);
  expect(raised[0]!.title).toBe('billing-svc: Pi is waiting on you');
});

test('a focused, visible Inbox raises nothing', async () => {
  const { page } = world;
  await setFront(true, true);
  const before = (await calls()).length;
  const codex = await agent('Codex', 'codex');
  const sent = await codex.send({ project_path: world.docs, body: question('Ship the install page?', 'Stopped: the docs deploy waits on this.') });
  await pageSaw(sent.thread_id);
  expect((await calls()).length).toBe(before);
  await expect(page.locator('[data-inbox-notice]')).toBeVisible();
  await shot('6.3-focused-silent');
});

test('a click on the notification focuses the tab and opens the thread', async () => {
  const { page } = world;
  await setFront(false, false);
  const codex = world.agents.at(-1)!;
  const sent = await codex.send({ project_path: world.docs, body: question('Move the changelog under docs/?') });
  await expect.poll(async () => (await calls()).at(-1)?.tag).toBe(sent.thread_id);
  await page.evaluate(() => window.__notifications.instances.at(-1)!.dispatchEvent(new Event('click')));
  await expect(page).toHaveURL(new RegExp(`#thread=${sent.thread_id}$`));
  // The thread this agent opened a moment ago (its session's thread), with the new question in it.
  await expect(page.locator('section.ib-pane')).toContainText('Move the changelog under docs/?');
  await shot('6.2-click-opened-thread');
});

test('the Settings switch off raises nothing; a section switched off raises nothing for that section', async () => {
  const { page } = world;
  await setFront(false, false);
  await page.getByRole('button', { name: 'Settings' }).click();
  const block = page.locator('[data-settings-notifications]');
  const main = block.getByRole('switch', { name: 'Desktop notifications' });
  await main.click();
  await expect(main).toHaveAttribute('aria-checked', 'false');
  await expect.poll(() => config().inboxNotifications?.enabled).toBe(false);
  const opencode = world.agents[1]!;
  let before = (await calls()).length;
  const off = await opencode.send({ project_path: world.docs, body: question('Drop the beta banner?', 'Stopped: the release notes wait on this.') });
  await expect.poll(async () => (await (await page.request.get(`${world.url}api/inbox/threads/${off.thread_id}`)).json()).thread?.thread_id).toBe(off.thread_id);
  await page.waitForTimeout(800);
  expect((await calls()).length).toBe(before);

  await main.click();
  await expect(main).toHaveAttribute('aria-checked', 'true');
  const stopped = block.getByRole('switch', { name: 'Notify for Stopped on you' });
  await stopped.click();
  await expect(stopped).toHaveAttribute('aria-checked', 'false');
  await expect.poll(() => config().inboxNotifications?.sections).toEqual(['holding', 'waiting']);
  before = (await calls()).length;
  const codex = await agent('Codex', 'codex');
  const stop = await codex.send({ project_path: world.billing, body: question('Pause the nightly import?', 'Stopped: the import job waits on this.') });
  await expect.poll(async () => (await page.request.get(`${world.url}api/inbox/threads/${stop.thread_id}`)).status()).toBe(200);
  await page.waitForTimeout(800);
  expect((await calls()).length).toBe(before);
  // A plain question in the same thread is Waiting on you, which still notifies.
  await codex.send({ project_path: world.billing, body: question('And keep the weekly one?') });
  await expect.poll(async () => (await calls()).length).toBe(before + 1);
  expect((await calls()).at(-1)).toMatchObject({ title: 'billing-svc: Codex is waiting on you', tag: stop.thread_id });
});

test('no page errors along the way', () => {
  expect(world.errors).toEqual([]);
});
