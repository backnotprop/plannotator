/**
 * The order of the sidebar's Tags (packages/inbox/tagSort.ts), proved in a real
 * Chromium against the compiled binary under a temp HOME and data dir: with one
 * tag there is no toggle; the default is today's order (oldest tag first); the
 * icon hides until the header is hovered; the first press goes A to Z, then the
 * icon goes between most recent and A to Z, never back to today's order; each
 * choice survives a real reload, in its own cookie apart from Projects'; most
 * recent puts a tag with no thread last and a new message moves its tag up; a
 * closed section has no toggle; a phone's sheet always shows it as a 44 px
 * target beside the heading and New tag, and a tap keeps the sheet open; and a
 * linked machine's thread counts under the merged tag of its name.
 *
 * Build the binary first (see inbox.spec.ts). The PNGs land in
 * .local/proof/tags-sort/ (PLANNOTATOR_E2E_PROOF_DIR names another parent).
 */

import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'tags-sort');
const CLOSED = 'http://127.0.0.1:9';

/** The order the tags are made in: today's order, oldest first. Backlog holds no thread. */
const ADDED = ['Release', 'Backlog', 'billing', 'Zephyr', 'édition', 'infra', 'app2', 'app10'];
const AZ = ['app2', 'app10', 'Backlog', 'billing', 'édition', 'infra', 'Release', 'Zephyr'];
/** The order their threads last wrote in, newest first; a tag with no thread goes last. */
const WROTE = ['app10', 'Zephyr', 'Release', 'édition', 'app2', 'billing', 'infra'];
const RECENT = [...WROTE].reverse().concat('Backlog');

interface Machine {
  name: string;
  root: string;
  dataDir: string;
  env: Record<string, string>;
  url: string;
}

interface World {
  studio: Machine;
  agent: SimAgent;
  /** Studio's one project. */
  project: string;
  agents: SimAgent[];
  /** Each tag's thread on Studio: its first message's id, which names the thread. */
  threads: Map<string, string>;
  context: BrowserContext;
  page: Page;
  errors: string[];
}
let world: World;

const side = (page: Page) => page.getByRole('complementary', { name: 'Inbox navigation' });
const header = (scope: Locator) => scope.locator('[data-sidebar-section="tags"]');
const toggle = (scope: Locator) => scope.locator('[data-tags-sort]');
const names = (scope: Locator) => scope.locator('[data-tag-row] .ib-name');
const SORT_COOKIE = 'plannotator-inbox-tags-sort';
const PROJECTS_COOKIE = 'plannotator-inbox-projects-sort';
const cookie = async (page: Page, name = SORT_COOKIE) => (await page.context().cookies()).find((c) => c.name === name)?.value;

function machine(name: string): Machine {
  const root = inboxScratch(`plannotator-inbox-tags-sort-${name.toLowerCase()}-`);
  // No tailnet: a stand-in tailscale that always fails, as the machines specs do.
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(bin, 'tailscale'), 0o755);
  const dataDir = join(root, 'data');
  return {
    name,
    root,
    dataDir,
    url: '',
    env: {
      PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      HOME: root,
      PLANNOTATOR_DATA_DIR: dataDir,
      PLANNOTATOR_TEST_SANDBOX: root,
      PLANNOTATOR_BROWSER: NO_BROWSER,
      PLANNOTATOR_MACHINE_NAME: name,
      PLANNOTATOR_INBOX_CONNECT: '0',
      PLANNOTATOR_INBOX_PHONES: '0',
      PLANNOTATOR_INBOX_NOTES: '0',
      PLANNOTATOR_UPDATE_CHECK: '0',
      NO_ANON_PING: '1',
      PLANNOTATOR_RELAY_URL: CLOSED,
    },
  };
}

const cli = (m: Machine, ...args: string[]) => {
  const run = spawnSync(binary, ['inbox', ...args], { env: m.env, cwd: m.root, encoding: 'utf8', timeout: 60_000 });
  return { status: run.status ?? -1, out: run.stdout ?? '', err: run.stderr ?? '' };
};
const base = (m: Machine) => `http://127.0.0.1:${(JSON.parse(readFileSync(join(m.dataDir, 'inbox', 'inbox.json'), 'utf8')) as { port: number }).port}`;

function start(m: Machine): void {
  const run = cli(m, '--background');
  rememberInboxOf(m.dataDir);
  expect(run.status, run.err).toBe(0);
  m.url = run.out.trim();
}

/** Studio reads `to` as a linked machine, through the real CLI pairing. */
function link(from: Machine, to: Machine): void {
  const offered = cli(to, 'link', '--offer');
  expect(offered.status, offered.err).toBe(0);
  const linked = cli(from, 'link', offered.out.trim(), '--address', base(to), '--back', base(from));
  expect(linked.status, linked.err).toBe(0);
}

/** The window's own write, on the page's Inbox: the thread goes in the live tag of that name, made when none is. */
const tagThread = (page: Page, threadId: string, name: string) =>
  page.evaluate(
    async ([id, tag]) => {
      const res = await fetch(`/api/inbox/threads/${id}/tags`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: tag, on: true }) });
      if (!res.ok) throw new Error(`tag ${res.status} ${await res.text()}`);
    },
    [threadId, name] as const,
  );

const makeTag = (page: Page, name: string) =>
  page.evaluate(async (tag) => {
    const res = await fetch('/api/inbox/initiatives', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: tag }) });
    if (!res.ok) throw new Error(`initiative ${res.status} ${await res.text()}`);
  }, name);

async function shot(page: Page, name: string, clip?: { x: number; y: number; width: number; height: number }): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(proofDir, `${name}-${scheme}.png`), ...(clip ? { clip } : {}) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

const pause = () => new Promise((done) => setTimeout(done, 5));

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  mkdirSync(proofDir, { recursive: true });
  const studio = machine('Studio');
  start(studio);
  const agent = await SimAgent.connect({ binary, env: studio.env, name: 'Claude Code', host: 'claude-code', cwd: studio.root });
  const project = scratchProject(join(studio.root, 'src'), 'plannotator');
  const threads = new Map<string, string>();
  for (const name of WROTE) {
    const sent = await agent.send({ project_path: project, subject: `Status of ${name}`, body: 'The build passed and the change is ready to read.' });
    threads.set(name, sent.thread_id as string);
    await pause();
  }
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: 'light' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  world = { studio, agent, project, agents: [agent], threads, context, page, errors };
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

test('one tag: the section has no toggle', async () => {
  const { page, studio, threads } = world;
  await page.goto(studio.url);
  await tagThread(page, threads.get('Release')!, 'Release');
  const nav = side(page);
  await expect(names(nav)).toHaveText(['Release']);
  await header(nav).hover();
  await expect(toggle(nav)).toHaveCount(0);

  // The rest, in today's order: Backlog made with no thread.
  for (const name of ADDED.slice(1)) {
    if (name === 'Backlog') await makeTag(page, name);
    else await tagThread(page, threads.get(name)!, name);
    await pause();
  }
  await expect(names(nav)).toHaveText(ADDED);
  await expect(toggle(nav)).toHaveCount(1);
  expect(world.errors).toEqual([]);
});

test('desktop: the default is today’s order, and the icon goes A to Z, most recent and A to Z again, across reloads', async () => {
  const { page, studio } = world;
  await page.goto(studio.url);
  const nav = side(page);
  const clip = { x: 0, y: 0, width: 640, height: 800 };
  await expect(names(nav)).toHaveText(ADDED);
  expect(await cookie(page)).toBeUndefined();

  // At rest it is not there to see; the header's hover shows it.
  await page.mouse.move(900, 450);
  await expect(toggle(nav)).toHaveCSS('opacity', '0');
  await shot(page, 'desktop-1-default-at-rest', clip);
  await header(nav).hover();
  await expect(toggle(nav)).toHaveCSS('opacity', '1');
  await shot(page, 'desktop-1-default-hover', clip);

  // Beside New tag, never over it.
  const [sortBox, addBox] = [(await toggle(nav).boundingBox())!, (await nav.locator('[data-tags-add]').boundingBox())!];
  expect(sortBox.x + sortBox.width).toBeLessThanOrEqual(addBox.x);

  await toggle(nav).click();
  await expect(names(nav)).toHaveText(AZ);
  await expect(header(nav)).toHaveAttribute('aria-expanded', 'true');
  expect(await cookie(page)).toBe('name');
  // Tags' own choice: Projects keep theirs.
  expect(await cookie(page, PROJECTS_COOKIE)).toBeUndefined();
  await page.reload();
  await expect(names(nav)).toHaveText(AZ);
  await toggle(nav).hover();
  await expect(page.getByText('Sorted A to Z. Sort by most recent')).toBeVisible();
  await shot(page, 'desktop-2-az-tooltip', clip);

  await toggle(nav).click();
  await expect(names(nav)).toHaveText(RECENT);
  expect(await cookie(page)).toBe('recent');
  await page.reload();
  await expect(names(nav)).toHaveText(RECENT);
  await header(nav).hover();
  await shot(page, 'desktop-3-recent-hover', clip);

  // The keyboard reaches it: focus shows it where the mouse is away.
  await page.mouse.move(900, 450);
  await header(nav).focus();
  await page.keyboard.press('Tab');
  await expect(toggle(nav)).toBeFocused();
  await expect(toggle(nav)).toHaveCSS('opacity', '1');

  // Most recent is live: a new message in a tag's thread moves the tag to the top.
  await world.agent.send({ project_path: world.project, reply_to: world.threads.get('app10')!, body: 'A later change.' });
  await expect(names(nav).first()).toHaveText('app10');
  await expect(names(nav).last()).toHaveText('Backlog');

  // From most recent a press goes back to A to Z, never to today's order.
  await toggle(nav).click();
  await expect(names(nav)).toHaveText(AZ);
  expect(await cookie(page)).toBe('name');
  await page.reload();
  await expect(names(nav)).toHaveText(AZ);

  // A closed section has no toggle.
  await header(nav).click();
  await expect(header(nav)).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle(nav)).toHaveCount(0);
  await header(nav).click();
  await expect(toggle(nav)).toHaveCount(1);
  expect(world.errors).toEqual([]);
});

test("a phone: the sheet always shows it, a 44 px target between the heading's fold area and New tag, and a tap keeps the sheet open", async () => {
  const { page, studio } = world;
  // A browser that has not chosen, as a phone decides on its own.
  await page.context().clearCookies({ name: SORT_COOKIE });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(studio.url);
  await page.locator('.ib-lhead').getByRole('button', { name: 'Toggle Sidebar' }).click();
  const sheet = page.getByRole('dialog');
  // Away from the row, as a finger is: nothing hovers on a phone.
  const away = () => page.mouse.move(100, 800);
  await expect(toggle(sheet)).toBeVisible();
  await expect(names(sheet)).toHaveText(ADDED);
  await toggle(sheet).scrollIntoViewIfNeeded();
  await away();
  await expect(toggle(sheet)).toHaveCSS('opacity', '1');
  // The sheet slides in on a spring: read the boxes once it rests, all at once.
  await expect.poll(async () => (await sheet.boundingBox())?.x).toBe(0);
  const [box, fold, add] = await sheet.evaluate((node) => {
    const rect = (selector: string) => {
      const r = node.querySelector(selector)!.getBoundingClientRect();
      return { x: r.x, width: r.width, height: r.height };
    };
    return [rect('[data-tags-sort]'), rect('[data-sidebar-section="tags"]'), rect('[data-tags-add]')];
  });
  expect([box.width, box.height]).toEqual([44, 44]);
  expect(box.x).toBeGreaterThanOrEqual(fold.x + fold.width);
  expect(box.x + box.width).toBeLessThanOrEqual(add.x);
  await shot(page, 'phone-1-default');

  await toggle(sheet).click();
  await expect(sheet).toBeVisible();
  await expect(names(sheet)).toHaveText(AZ);
  await away();
  await shot(page, 'phone-2-az');

  await toggle(sheet).click();
  await expect(sheet).toBeVisible();
  await expect(names(sheet).first()).toHaveText('app10');
  await away();
  await shot(page, 'phone-3-recent');

  await toggle(sheet).click();
  await expect(sheet).toBeVisible();
  await expect(names(sheet)).toHaveText(AZ);
  expect(world.errors).toEqual([]);
});

test('most recent: a linked machine’s thread counts under the merged tag of its name', async () => {
  const { context, page, studio } = world;
  const macbook = machine('MacBook');
  start(macbook);
  link(studio, macbook);
  const far = await SimAgent.connect({ binary, env: macbook.env, name: 'Claude Code', host: 'claude-code', cwd: macbook.root });
  world.agents.push(far);
  const sent = await far.send({ project_path: scratchProject(join(macbook.root, 'src'), 'billing-svc'), subject: 'Invoices on MacBook', body: 'The newest change of all.' });
  const farThread = sent.thread_id as string;
  // MacBook's own window tags it: the tag is MacBook's, of the same name as Studio's Release.
  const there = await context.newPage();
  await there.goto(macbook.url);
  await tagThread(there, farThread, 'Release');
  await there.close();

  await context.addCookies([{ name: SORT_COOKIE, value: 'recent', url: studio.url }]);
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect.poll(async () => JSON.stringify(await (await fetch(`${base(studio)}/api/inbox/threads?machines=1`)).json()).includes(farThread), { timeout: 15_000 }).toBe(true);
  await page.goto(studio.url);
  const nav = side(page);
  await expect(page.locator(`.ib-lbody [data-thread-id="${farThread}"]`)).toBeVisible();
  // One Release, first: MacBook's thread is the newest in the list.
  await expect(names(nav).first()).toHaveText('Release');
  await expect(names(nav)).toHaveCount(ADDED.length);
  await header(nav).hover();
  await shot(page, 'desktop-4-recent-linked', { x: 0, y: 0, width: 640, height: 800 });
  expect(world.errors).toEqual([]);
});
