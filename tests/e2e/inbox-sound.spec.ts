/**
 * The Inbox's question sound ("Ding-dong") and its one-time dialog, proved in
 * a real Chromium against a compiled binary. The spec compiles its own binary
 * with a release version (0.29.0; the shared e2e binary is 0.0.0-dev, and a
 * dev build never reports an update), into a temp dir, from the built apps
 * (apps/hook/dist). Agents write through `plannotator inbox mcp`
 * (scripts/inbox-sim.ts).
 *
 * Never audible: an init script replaces AudioContext with a stub that only
 * counts oscillators (the sound is four, so four oscillators are one ring).
 * Whether the tab is in front is set the way notifications.spec.ts sets it
 * (document.visibilityState and document.hasFocus()). A fake `tailscale`
 * that always fails is first on PATH, so the real one never runs; the update
 * check is off and points at a dead port, so nothing asks GitHub.
 *
 * Proves: a question while the tab is hidden rings once; a burst of three
 * rings once; a visible tab rings nothing; a plain message rings nothing; the
 * sound off rings nothing (and notifications stop being silent); two tabs
 * ring once; a fresh install never shows the dialog; after an update the
 * dialog shows once, in one of two tabs, and not again on reload.
 * Screenshots (light and dark) land in PLANNOTATOR_SOUND_SHOTS (default
 * .local/proof/sound/).
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const shots = resolve(process.env.PLANNOTATOR_SOUND_SHOTS ?? join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'sound'));
const VERSION = '0.29.0';

declare global {
  interface Window {
    __sound: { oscillators: number; contexts: number };
    __front: { visible: boolean; focused: boolean };
    __notified: { title: string; silent: boolean }[];
  }
}

/** Runs in every page before its own code. */
function stubPage(): void {
  const sound = { oscillators: 0, contexts: 0 };
  window.__sound = sound;
  const param = () => ({ value: 1, setValueAtTime() {}, exponentialRampToValueAtTime() {} });
  class CountingAudioContext {
    state = 'running';
    currentTime = 0;
    destination = {};
    constructor() {
      sound.contexts++;
    }
    resume() {
      return Promise.resolve();
    }
    close() {
      return Promise.resolve();
    }
    createGain() {
      return { gain: param(), connect: (to: unknown) => to };
    }
    createOscillator() {
      sound.oscillators++;
      return { type: 'sine', frequency: param(), connect: (to: unknown) => to, start() {}, stop() {} };
    }
  }
  (window as unknown as { AudioContext: unknown }).AudioContext = CountingAudioContext;
  const notified: { title: string; silent: boolean }[] = [];
  window.__notified = notified;
  const Real = window.Notification;
  class RecordedNotification extends Real {
    constructor(title: string, options: NotificationOptions = {}) {
      super(title, options);
      notified.push({ title, silent: options.silent === true });
    }
  }
  window.Notification = RecordedNotification as typeof Notification;
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
  project: string;
  agents: SimAgent[];
  context: BrowserContext;
  errors: string[];
}

let binary = '';
let trapDir = '';
let scratch = '';
const worlds: World[] = [];

function compileReleaseBinary(): string {
  const out = join(scratch, 'bin', 'plannotator');
  const built = spawnSync(
    'bun',
    ['build', 'apps/hook/server/index.ts', '--compile', '--no-compile-autoload-bunfig', '--define', `__CLI_VERSION__="${VERSION}"`, '--outfile', out],
    { cwd: repo, encoding: 'utf8', timeout: 180_000 },
  );
  expect(built.status, built.stderr).toBe(0);
  return out;
}

async function newWorld(browser: Browser, options: { updatedFrom?: string } = {}): Promise<World> {
  const root = realpathSync(mkdtempSync(join(scratch, 'world-')));
  const dataDir = join(root, 'data');
  const home = join(root, 'home');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(home);
  // An Inbox that ran before on an older version: this run is an update.
  if (options.updatedFrom) writeFileSync(join(dataDir, 'update-state.json'), JSON.stringify({ inboxVersion: options.updatedFrom }));
  const env = {
    PATH: `${trapDir}:${process.env.PATH ?? ''}`,
    HOME: home,
    TMPDIR: tmpdir(),
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_UPDATE_API_URL: 'http://127.0.0.1:9/releases/latest',
    PLANNOTATOR_FEEDBACK_URL: 'http://127.0.0.1:9/feedback',
    PLANNOTATOR_INBOX_PHONES: '0',
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 }, colorScheme: 'light' });
  await context.addInitScript(stubPage);
  const world: World = {
    root,
    dataDir,
    env,
    url: started.stdout.trim(),
    project: scratchProject(join(root, 'src'), 'billing-svc'),
    agents: [],
    context,
    errors: [],
  };
  worlds.push(world);
  return world;
}

async function openPage(world: World): Promise<Page> {
  const page = await world.context.newPage();
  page.on('pageerror', (error) => world.errors.push(error.message));
  await page.goto(world.url);
  return page;
}

async function agent(world: World, name = 'Claude Code', host = 'claude-code'): Promise<SimAgent> {
  const sim = await SimAgent.connect({ binary, env: world.env, name, host });
  world.agents.push(sim);
  return sim;
}

function config(world: World): { inboxSound?: Record<string, unknown> } {
  const path = join(world.dataDir, 'config.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
}

const rings = (page: Page) => page.evaluate(() => window.__sound.oscillators / 4);

/** Put the tab in front or away, with the events a browser fires when that happens. */
async function setFront(page: Page, visible: boolean, focused: boolean): Promise<void> {
  await page.evaluate(
    ([v, f]) => {
      Object.assign(window.__front, { visible: v, focused: f });
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event(f ? 'focus' : 'blur'));
    },
    [visible, focused] as const,
  );
}

/** A fresh burst: the tab comes to the front (the burst ends), then goes away. */
async function awayAgain(page: Page): Promise<void> {
  await setFront(page, true, true);
  await setFront(page, false, false);
}

/** The page has read the list after the agent's write (the notify step, and so the ring, runs right after). */
async function settled(page: Page, threadId: string): Promise<void> {
  await expect
    .poll(async () => (await page.locator(`[data-thread-id="${threadId}"]`).count()) + (await page.locator('[data-inbox-notice]').count()))
    .toBeGreaterThan(0);
  await page.waitForTimeout(600);
}

const question = (prompt: string) => ['One call before I go on.', '', ':::question', prompt, '', '- [ ] Yes', '- [ ] No', ':::'].join('\n');

async function shot(page: Page, name: string): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(shots, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

test.describe.configure({ mode: 'serial' });
// Chromium itself (the headless shell answers every notification permission with "denied").
test.use({ channel: 'chromium' });

test.beforeAll(() => {
  expect(existsSync(join(repo, 'apps/hook/dist/inbox.html')), 'build the apps first (bun run build:review && bun run build:hook)').toBe(true);
  rmSync(shots, { recursive: true, force: true });
  mkdirSync(shots, { recursive: true });
  scratch = inboxScratch('plannotator-inbox-sound-');
  // A `tailscale` that always fails, first on PATH: the real one never runs.
  trapDir = join(scratch, 'trap');
  mkdirSync(trapDir);
  writeFileSync(join(trapDir, 'tailscale'), '#!/bin/sh\necho "tailscale is trapped in this test" >&2\nexit 1\n');
  chmodSync(join(trapDir, 'tailscale'), 0o755);
  binary = compileReleaseBinary();
});

test.afterAll(async () => {
  try {
    for (const world of worlds) {
      await Promise.all(world.agents.map((a) => a.close().catch(() => {})));
      await world.context.close().catch(() => {});
    }
  } finally {
    // Every Inbox this spec started, then its folders (inbox-scratch.ts).
    await removeInboxScratch();
  }
});

let fresh: World;
let page: Page;

test('a fresh install: no dialog, the mark set so none ever shows, and no sidebar row asks for a click', async ({ browser }) => {
  fresh = await newWorld(browser);
  await fresh.context.grantPermissions(['notifications'], { origin: new URL(fresh.url).origin });
  const claude = await agent(fresh);
  const first = await claude.send({ project_path: fresh.project, body: question('Retry the 409 with the same key?') });
  page = await openPage(fresh);
  await expect(page.locator(`[data-thread-id="${first.thread_id}"]`)).toBeVisible();
  await page.waitForTimeout(2500);
  await expect(page.locator('dialog[data-dialog="sound-intro"]')).toHaveCount(0);
  expect(config(fresh).inboxSound).toEqual({ dialogShownFor: VERSION });
  // Approval "inbox-notify-every-thread": the sidebar says nothing about sound before the first click.
  await expect(page.locator('.ib-side-foot')).not.toContainText(/sound/i);
  await shot(page, 'sidebar-no-sound-row');
  // Any click in the tab arms the sound, silently (the next tests ring only because it did).
  await page.locator('.ib-main h1').first().click();
});

test('a question while the tab is hidden rings once, and its notification is silent', async () => {
  await setFront(page, false, false);
  const before = await rings(page);
  const pi = await agent(fresh, 'Pi', 'pi');
  const sent = await pi.send({ project_path: fresh.project, body: question('Ship the worker behind a flag?') });
  await settled(page, sent.thread_id);
  await expect.poll(() => rings(page)).toBe(before + 1);
  await expect.poll(() => page.evaluate(() => window.__notified.at(-1))).toMatchObject({ silent: true });
});

test('a burst of three questions rings once', async () => {
  await awayAgain(page);
  const before = await rings(page);
  const codex = await agent(fresh, 'Codex', 'codex');
  const opencode = await agent(fresh, 'OpenCode', 'opencode');
  const a = await codex.send({ project_path: fresh.project, body: question('Drop the refunds table?') });
  const b = await opencode.send({ project_path: fresh.project, body: question('Rotate the webhook secret?') });
  const c = await codex.send({ project_path: fresh.project, body: question('And cap the retries?') });
  for (const sent of [a, b, c]) await settled(page, sent.thread_id);
  await page.waitForTimeout(800);
  expect(await rings(page)).toBe(before + 1);
});

test('with the tab visible and focused nothing rings', async () => {
  await setFront(page, true, true);
  const before = await rings(page);
  const sent = await fresh.agents[0]!.send({ project_path: fresh.project, body: question('Keep the old retry window?') });
  await settled(page, sent.thread_id);
  expect(await rings(page)).toBe(before);
});

test('a plain message rings nothing; the next question in that burst-free moment does', async () => {
  await awayAgain(page);
  const before = await rings(page);
  const plain = await fresh.agents[0]!.send({ project_path: fresh.project, body: 'The migration finished. Nothing needed from you.' });
  await settled(page, plain.thread_id);
  expect(await rings(page)).toBe(before);
  const asked = await fresh.agents[0]!.send({ project_path: fresh.project, body: question('Delete the backup now?') });
  await settled(page, asked.thread_id);
  await expect.poll(() => rings(page)).toBe(before + 1);
});

test('two Inbox tabs ring once between them; any tab in front keeps both quiet', async () => {
  const second = await openPage(fresh);
  await expect(second.locator('.ib-lbody [data-thread-id]').first()).toBeVisible();
  await second.locator('.ib-main h1').first().click();
  await setFront(page, true, true);
  await setFront(second, true, true);
  await setFront(page, false, false);
  await setFront(second, false, false);
  const before = (await rings(page)) + (await rings(second));
  const sent = await fresh.agents[1]!.send({ project_path: fresh.project, body: question('Pause the nightly import?') });
  await settled(page, sent.thread_id);
  await settled(second, sent.thread_id);
  await page.waitForTimeout(800);
  expect((await rings(page)) + (await rings(second))).toBe(before + 1);

  // The second tab comes to the front: the first, hidden, stays quiet too.
  await setFront(second, true, true);
  await page.waitForTimeout(300);
  const quiet = (await rings(page)) + (await rings(second));
  const more = await fresh.agents[1]!.send({ project_path: fresh.project, body: question('Then resume it at noon?') });
  await settled(page, more.thread_id);
  await page.waitForTimeout(800);
  expect((await rings(page)) + (await rings(second))).toBe(quiet);
  // It goes to the back before it closes, as a tab does when the person moves on: a tab still
  // "in front" (the page's last word, if its goodbye is lost in a headless close) keeps the other
  // tab's notifications for itself for up to 15 s.
  await setFront(second, false, false);
  await second.close();
});

test('Settings: the row, Play always plays, and the switch off silences the next question (notifications ring the system again)', async () => {
  await setFront(page, true, true);
  await page.getByRole('button', { name: 'Settings' }).click();
  const block = page.locator('[data-settings-notifications]');
  const row = block.locator('[data-settings-sound]');
  await expect(row).toContainText('Play a sound');
  await expect(row).toContainText('When an agent asks you');
  await expect(row.getByRole('slider', { name: 'Volume' })).toHaveValue('60');
  await page.locator('.ib-spage').evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await shot(page, 'settings-sound-row');

  const before = await rings(page);
  await row.getByRole('button', { name: 'Play the sound' }).click();
  await expect.poll(() => rings(page)).toBe(before + 1);

  const sw = row.getByRole('switch', { name: 'Play a sound' });
  await sw.click();
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  await expect(row.getByRole('slider', { name: 'Volume' })).toBeDisabled();
  await expect.poll(() => config(fresh).inboxSound?.enabled).toBe(false);
  await shot(page, 'settings-sound-off');

  await awayAgain(page);
  const off = await rings(page);
  const sent = await fresh.agents[2]!.send({ project_path: fresh.project, body: question('Archive last year’s invoices?') });
  await expect.poll(async () => (await page.request.get(`${fresh.url}api/inbox/threads/${sent.thread_id}`)).status()).toBe(200);
  await page.waitForTimeout(1200);
  expect(await rings(page)).toBe(off);
  await expect.poll(() => page.evaluate(() => window.__notified.at(-1)?.title)).toContain('Codex');
  expect(await page.evaluate(() => window.__notified.at(-1)?.silent)).toBe(false);
});

test('after an update the dialog shows once: in one of two tabs opened together, and never again on reload', async ({ browser }) => {
  const updated = await newWorld(browser, { updatedFrom: '0.28.15' });
  const claude = await agent(updated);
  const sent = await claude.send({ project_path: updated.project, body: question('Which currency rounding should invoices use?') });
  const [a, b] = await Promise.all([openPage(updated), openPage(updated)]);
  for (const p of [a, b]) await expect(p.locator(`[data-thread-id="${sent.thread_id}"]`)).toBeVisible();
  const dialogs = () => Promise.all([a, b].map((p) => p.locator('dialog[data-dialog="sound-intro"]').count()));
  await expect.poll(async () => (await dialogs()).reduce((n, c) => n + c, 0)).toBe(1);
  await a.waitForTimeout(1500);
  expect((await dialogs()).reduce((n, c) => n + c, 0)).toBe(1);
  expect(config(updated).inboxSound).toEqual({ dialogShownFor: VERSION });
  const shown = (await dialogs())[0] === 1 ? a : b;
  const other = shown === a ? b : a;
  await other.close();
  const dialog = shown.locator('dialog[data-dialog="sound-intro"]');
  await expect(dialog.getByRole('heading', { name: 'The Inbox can ring now' })).toBeVisible();
  await expect(dialog).toContainText('A soft doorbell when an agent asks you something and this tab is hidden.');
  // This browser has not decided about notifications: the one line says so.
  await expect(dialog.locator('[data-sound-nline="not-allowed"]')).toHaveText("Notifications aren't allowed yet.Allow");
  await expect(dialog.getByRole('button', { name: 'Keep it on' })).toBeFocused();
  // The ask line waits for another load.
  await expect(shown.locator('[data-notification-ask]')).toHaveCount(0);
  await shot(shown, 'dialog-not-allowed');

  // Play previews; Turn it off saves it off and says so.
  const before = await rings(shown);
  await dialog.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(() => rings(shown)).toBe(before + 1);
  await dialog.getByRole('button', { name: 'Turn it off' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(shown.locator('[data-inbox-toast]')).toHaveText('Sound off');
  await expect.poll(() => config(updated).inboxSound).toEqual({ dialogShownFor: VERSION, enabled: false });
  await shot(shown, 'dialog-turned-off-toast');

  await shown.reload();
  await expect(shown.locator(`[data-thread-id="${sent.thread_id}"]`)).toBeVisible();
  await shown.waitForTimeout(2500);
  await expect(shown.locator('dialog[data-dialog="sound-intro"]')).toHaveCount(0);
});

test('the dialog with notifications on has no notification line; Escape keeps the sound on', async ({ browser }) => {
  const updated = await newWorld(browser, { updatedFrom: '0.28.15' });
  await updated.context.grantPermissions(['notifications'], { origin: new URL(updated.url).origin });
  const claude = await agent(updated);
  const sent = await claude.send({ project_path: updated.project, body: question('Bill annually by default?') });
  const shown = await openPage(updated);
  await expect(shown.locator(`[data-thread-id="${sent.thread_id}"]`)).toBeVisible();
  const dialog = shown.locator('dialog[data-dialog="sound-intro"]');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-sound-nline]')).toHaveCount(0);
  await shot(shown, 'dialog-on');
  await shown.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(config(updated).inboxSound).toEqual({ dialogShownFor: VERSION });
});

test('no page errors along the way', () => {
  expect(worlds.flatMap((w) => w.errors)).toEqual([]);
});
