/**
 * Pinned artifacts across linked machines (approval "inbox-artifact-stars"; the owner, 2026-11-24: "Whatever I can do
 * on one computer, I should be able to do across computers"), proved in a real browser against compiled Inboxes on
 * loopback, linked through the real CLI pairing. Studio is the window's; MacBook owns the thread. A pin lives on its
 * thread's machine, as a star does.
 *
 *  1. MacBook's thread's Artifacts in Studio's window: the card has its pin; pressing it puts the pin on MacBook's
 *     disk (not Studio's), the card moves into "Pinned 1", and MacBook's own window shows it pinned too.
 *  2. Studio's Artifacts wall, Pinned: MacBook's pinned picture beside Studio's own, with both counted.
 *  3. Unpin from the Wall's tile: gone from MacBook's disk and from the Wall.
 *  4. MacBook asleep: the pin still shows what it last knew; a press says it waits (the clock toast) and applies
 *     when MacBook is back, with no reload.
 *  5. An older peer, when PLANNOTATOR_E2E_OLDER_BINARY names a real release from before linked artifact pins: its
 *     thread's Artifacts show no pin, and the grid is otherwise as before.
 *
 * Pictures land in PLANNOTATOR_ARTIFACT_PINS_MACHINES_SHOTS, else .local/proof/artifact-pins-machines.
 * Build the binary first (see inbox.spec.ts).
 */

import { expect, test, type Browser, type BrowserContext, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, rememberInboxOf, removeInboxScratch, stopScratchInbox } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const older = process.env.PLANNOTATOR_E2E_OLDER_BINARY ? resolve(process.env.PLANNOTATOR_E2E_OLDER_BINARY) : null;
const shots = resolve(process.env.PLANNOTATOR_ARTIFACT_PINS_MACHINES_SHOTS ?? join(repo, '.local/proof/artifact-pins-machines'));
const CLOSED = 'http://127.0.0.1:9';

interface Machine {
  name: string;
  dataDir: string;
  root: string;
  env: Record<string, string>;
  binary: string;
  id: string;
  url: string;
}

let studio: Machine;
let macbook: Machine;
let context: BrowserContext;
let page: Page;
const errors: string[] = [];
const agents: SimAgent[] = [];
let stillOlder: Machine | null = null;

function machine(name: string, bin = binary): Machine {
  const root = inboxScratch(`plannotator-artifact-pins-machines-${name.toLowerCase()}-`);
  const path = join(root, 'bin');
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(path, 'tailscale'), 0o755);
  const dataDir = join(root, 'data');
  return {
    name,
    root,
    dataDir,
    binary: bin,
    id: '',
    url: '',
    env: {
      PATH: `${path}:/usr/bin:/bin`,
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
      PLANNOTATOR_UPDATE_API_URL: `${CLOSED}/releases/latest`,
      PLANNOTATOR_INSTALL_SCRIPT_URL: `${CLOSED}/install.sh`,
      PLANNOTATOR_RELEASE_DOWNLOAD_URL: `${CLOSED}/download`,
      PLANNOTATOR_FEEDBACK_URL: `${CLOSED}/feedback`,
    },
  };
}

const cli = (m: Machine, ...args: string[]) => {
  const run = spawnSync(m.binary, ['inbox', ...args], { env: m.env, cwd: m.root, encoding: 'utf8', timeout: 60_000 });
  return { status: run.status ?? -1, out: run.stdout ?? '', err: run.stderr ?? '' };
};
const base = (m: Machine) => `http://127.0.0.1:${(JSON.parse(readFileSync(join(m.dataDir, 'inbox', 'inbox.json'), 'utf8')) as { port: number }).port}`;
const read = async <T>(m: Machine, path: string): Promise<T> => (await (await fetch(`${base(m)}${path}`)).json()) as T;

async function start(m: Machine): Promise<void> {
  const run = cli(m, '--background');
  rememberInboxOf(m.dataDir);
  expect(run.status, run.err).toBe(0);
  m.url = run.out.trim();
  await expect.poll(async () => (m.id = (await read<{ inbox_id: string }>(m, '/api/inbox/health').catch(() => ({ inbox_id: '' }))).inbox_id), { timeout: 15_000 }).not.toBe('');
}

function link(from: Machine, to: Machine): void {
  const offered = cli(to, 'link', '--offer');
  expect(offered.status, offered.err).toBe(0);
  const linked = cli(from, 'link', offered.out.trim(), '--address', base(to), '--back', base(from));
  expect(linked.status, linked.err).toBe(0);
}

/** A screen drawn by the browser into a real PNG, so a tile shows a picture. */
async function picture(path: string, title: string, accent: string): Promise<void> {
  const drawer = await context.newPage();
  await drawer.setViewportSize({ width: 640, height: 420 });
  await drawer.setContent(`<!doctype html><style>body{margin:0;font:600 28px system-ui;background:${accent};color:#fff;display:grid;place-items:center;height:100vh}</style><body>${title}</body>`);
  await drawer.screenshot({ path });
  await drawer.close();
}

/** A thread on `m` with two pictures attached; answers the thread and the pictures' keys (their attachment ids). */
async function threadWithPictures(m: Machine, subject: string, accent: string): Promise<{ thread: string; keys: string[] }> {
  const project = scratchProject(join(m.root, 'code'), 'checkout');
  await picture(join(project, 'before.png'), `${m.name} · before`, accent);
  await picture(join(project, 'after.png'), `${m.name} · after`, accent);
  const agent = await SimAgent.connect({ binary: m.binary, env: m.env, name: 'Claude Code', host: 'claude-code', cwd: m.root });
  agents.push(agent);
  const sent = await agent.send({ project_path: project, subject, body: 'Before and after, attached.', attachments: ['before.png', 'after.png'] });
  const thread = sent.thread_id as string;
  const model = await read<{ thread: { messages: { attachments?: { id: string }[] }[] } }>(m, `/api/inbox/threads/${thread}`);
  return { thread, keys: model.thread.messages.flatMap((message) => (message.attachments ?? []).map((a) => a.id)) };
}

const pinsOn = (m: Machine): string[] => {
  const path = join(m.dataDir, 'inbox', 'artifact-pins.json');
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as { pins: { key: string }[] }).pins.map((pin) => pin.key) : [];
};
const stateOf = async (viewer: Machine, other: Machine) => (await read<{ machines: { id: string; state: string }[] }>(viewer, '/api/inbox/machines')).machines.find((x) => x.id === other.id)?.state;
const card = (on: Page, key: string) => on.locator(`[data-artifacts-view] [data-artifact-tile="${key}"]`);
const cardPin = (on: Page, key: string) => on.locator(`[data-artifacts-view] [data-artifact-pin="${key}"]`);
const settled = (on: Page) => on.evaluate(() => Promise.all(document.getAnimations().filter((motion) => motion.effect?.getTiming().iterations !== Infinity).map((motion) => motion.finished.catch(() => {}))));

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  mkdirSync(shots, { recursive: true });
  studio = machine('Studio');
  macbook = machine('MacBook');
  await start(studio);
  await start(macbook);
  link(studio, macbook);
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
});

test.afterAll(async () => {
  try {
    for (const agent of agents) await agent.close().catch(() => {});
    await context?.close();
    if (stillOlder) cli(stillOlder, 'stop');
  } finally {
    await removeInboxScratch();
  }
});

let far: { thread: string; keys: string[] };
let own: { thread: string; keys: string[] };

test("1. MacBook's artifact pinned from Studio's window: on MacBook's disk, in the thread's Pinned group, and pinned in MacBook's own window", async () => {
  own = await threadWithPictures(studio, 'Studio checkout pictures', '#2f6f4e');
  far = await threadWithPictures(macbook, 'MacBook checkout pictures', '#4338ca');
  await expect.poll(async () => JSON.stringify(await read(studio, '/api/inbox/threads?machines=1')).includes(far.thread), { timeout: 15_000 }).toBe(true);
  await page.goto(`${studio.url}#thread=${far.thread}&artifacts`);
  const [first] = far.keys as [string];
  await expect(card(page, first)).toBeVisible({ timeout: 15_000 });
  await card(page, first).hover();
  await expect(cardPin(page, first)).toHaveAttribute('aria-label', 'Pin before.png');
  await cardPin(page, first).click();
  await expect(page.locator('[data-artifacts-group="pinned"]')).toBeVisible();
  await expect(page.locator(`[data-artifacts-group="pinned"] [data-artifact-tile="${first}"]`)).toBeVisible();
  await expect.poll(() => pinsOn(macbook), { timeout: 15_000 }).toEqual([first]);
  expect(pinsOn(studio)).toEqual([]);
  await page.mouse.move(0, 0);
  await settled(page);
  await page.screenshot({ path: join(shots, 'linked-thread-pinned-from-studio.png') });

  // The same pin from MacBook's own window.
  const there = await context.newPage();
  there.on('pageerror', (error) => errors.push(error.message));
  await there.goto(`${macbook.url}#thread=${far.thread}&artifacts`);
  await expect(there.locator(`[data-artifacts-group="pinned"] [data-artifact-pin="${first}"]`)).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 });
  await settled(there);
  await there.screenshot({ path: join(shots, 'linked-thread-pinned-seen-on-macbook.png') });
  await there.close();
});

test("2. Studio's Wall, Pinned: MacBook's pinned picture beside Studio's own, both counted", async () => {
  const [mine] = own.keys as [string];
  // Studio's own pin, from its own thread's Artifacts.
  await page.goto(`${studio.url}#thread=${own.thread}&artifacts`);
  await card(page, mine).hover();
  await cardPin(page, mine).click();
  await expect.poll(() => pinsOn(studio), { timeout: 15_000 }).toEqual([mine]);

  await page.goto(`${studio.url}#artifacts=pinned`);
  const wall = page.locator('[data-artifacts-wall]');
  await expect(wall.locator(`[data-wall-artifact="${far.keys[0]}"]`)).toBeVisible({ timeout: 15_000 });
  await expect(wall.locator(`[data-wall-artifact="${mine}"]`)).toBeVisible();
  await expect(wall.locator('[data-wall-artifact]')).toHaveCount(2);
  await expect(wall.locator('[data-wall-show="pinned"]')).toContainText('2');
  await expect(wall.locator('[data-wall-show="all"]')).toContainText('4');
  await settled(page);
  await page.screenshot({ path: join(shots, 'wall-pinned-both-computers.png') });
});

test("3. Unpin from the Wall's tile: gone from MacBook's disk and from the Wall", async () => {
  const [first] = far.keys as [string];
  const wall = page.locator('[data-artifacts-wall]');
  const tile = wall.locator(`[data-wall-artifact="${first}"]`);
  await tile.hover();
  await tile.locator('[data-artifact-pin]').click();
  await expect.poll(() => pinsOn(macbook), { timeout: 15_000 }).toEqual([]);
  await expect(tile).toHaveCount(0, { timeout: 15_000 });
  await expect(wall.locator('[data-wall-show="pinned"]')).toContainText('1');
});

test('4. MacBook asleep: the pin shows what it last knew; a press waits, says so, and applies when MacBook is back', async () => {
  const [first, second] = far.keys as [string, string];
  // One pinned while MacBook is up, so there is something it last knew.
  await page.goto(`${studio.url}#thread=${far.thread}&artifacts`);
  await card(page, first).hover();
  await cardPin(page, first).click();
  await expect.poll(() => pinsOn(macbook), { timeout: 15_000 }).toEqual([first]);
  // The Wall read while MacBook is up: what Studio last knew of it.
  const wall = page.locator('[data-artifacts-wall]');
  await page.goto(`${studio.url}#artifacts=pinned`);
  await expect(wall.locator(`[data-wall-artifact="${first}"]`)).toBeVisible({ timeout: 15_000 });
  await page.goto(`${studio.url}#artifacts`);
  await expect(wall.locator(`[data-wall-artifact="${second}"]`)).toBeVisible({ timeout: 15_000 });

  await stopScratchInbox(macbook.dataDir);
  await expect.poll(() => stateOf(studio, macbook), { timeout: 30_000 }).toBe('offline');
  await page.goto(`${studio.url}#artifacts=pinned`);
  await page.reload();
  await expect(wall.locator(`[data-wall-artifact="${first}"] [data-artifact-pin]`)).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 });

  await page.goto(`${studio.url}#artifacts`);
  await page.reload();
  const tile = wall.locator(`[data-wall-artifact="${second}"]`);
  await expect(tile).toBeVisible({ timeout: 15_000 });
  await tile.hover();
  await tile.locator('[data-artifact-pin]').click();
  await expect(page.locator('.ib-tlead').filter({ hasText: 'Waiting for MacBook: this applies when MacBook is back.' })).toBeVisible();
  await page.screenshot({ path: join(shots, 'pin-held-macbook-asleep.png') });

  await start(macbook);
  await expect.poll(() => pinsOn(macbook).includes(second), { timeout: 45_000 }).toBe(true);
  // No reload: MacBook's own event brings it to Studio's window.
  await expect(tile.locator('[data-artifact-pin]')).toHaveAttribute('aria-pressed', 'true', { timeout: 20_000 });
  await page.mouse.move(0, 0);
  await settled(page);
  await page.screenshot({ path: join(shots, 'pin-held-applied-when-back.png') });
  expect(errors).toEqual([]);
});

test('5. An older peer: its threads show no pin, and its Artifacts are otherwise as before', async () => {
  test.skip(older === null, 'needs PLANNOTATOR_E2E_OLDER_BINARY, a real release from before linked artifact pins');
  const mini = machine('Mini', older!);
  stillOlder = mini;
  await start(mini);
  link(studio, mini);
  const old = await threadWithPictures(mini, 'Pictures on the older Mini', '#9a3412');
  await expect.poll(async () => JSON.stringify(await read(studio, '/api/inbox/threads?machines=1')).includes(old.thread), { timeout: 15_000 }).toBe(true);
  await page.goto(`${studio.url}#thread=${old.thread}&artifacts`);
  await expect(card(page, old.keys[0]!)).toBeVisible({ timeout: 15_000 });
  await card(page, old.keys[0]!).hover();
  await expect(page.locator('[data-artifacts-view] [data-artifact-pin]')).toHaveCount(0);
  await expect(page.locator('[data-artifacts-view] [data-artifact-tile]')).toHaveCount(2);
  await page.screenshot({ path: join(shots, 'older-peer-no-pin.png') });
  expect(errors).toEqual([]);
});
