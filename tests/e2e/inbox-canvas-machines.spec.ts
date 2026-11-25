/**
 * A thread's canvas across linked computers (mark `canvas`; the owner, 2026-11-24: "Whatever I can do on one
 * computer, I should be able to do across computers"), proved in a real browser against two compiled Inboxes on
 * loopback, linked through the real CLI pairing. Studio is the window's; MacBook owns the thread, so its canvas lives
 * on MacBook's disk.
 *
 *  1. MacBook's thread in Studio's window has the pen; the board opens and a box drawn there is saved on MacBook.
 *  2. MacBook's agent changes the canvas with `plannotator inbox canvas`: Studio's open board shows it at once, in view.
 *  3. MacBook's agent asks for a picture: Studio's open board draws it, and the agent gets the file there.
 *  4. MacBook asleep: a box drawn in Studio's board says it waits, and lands on MacBook once it is back.
 *
 * Whole-window pictures in light and dark land in PLANNOTATOR_E2E_PROOF_DIR/canvas-machines (else
 * .local/proof/canvas-machines). Build the binary first (see inbox.spec.ts).
 */

import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { E2E_GROUP_TIP_SEEN, inboxScratch, rememberInboxOf, removeInboxScratch, stopScratchInbox } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'canvas-machines');
const CLOSED = 'http://127.0.0.1:9';
const AGENT_SESSION = 'claude-code:7a2e3d4c-5b6f-4071-8c9d-0e1f2a3b4c5d';

interface Machine {
  name: string;
  dataDir: string;
  root: string;
  env: Record<string, string>;
  id: string;
  url: string;
}

let studio: Machine;
let macbook: Machine;
let context: BrowserContext;
let page: Page;
let layer: Locator;
let far: string;
const errors: string[] = [];
const agents: SimAgent[] = [];

function machine(name: string): Machine {
  const root = inboxScratch(`plannotator-canvas-machines-${name.toLowerCase()}-`);
  const path = join(root, 'bin');
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(path, 'tailscale'), 0o755);
  const dataDir = join(root, 'data');
  // The canvas is on (one set of switches on linked computers), and the tour and first tips are out of the way.
  markTourDecided(dataDir);
  const configFile = join(dataDir, 'config.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, unknown>;
  writeFileSync(configFile, JSON.stringify({ ...config, inboxCanvas: true, inboxReveals: { ...E2E_GROUP_TIP_SEEN } }));
  return {
    name,
    root,
    dataDir,
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
  const run = spawnSync(binary, ['inbox', ...args], { env: m.env, cwd: m.root, encoding: 'utf8', timeout: 60_000 });
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

async function shot(name: string): Promise<void> {
  await page.mouse.move(0, 0);
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(proofDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

/** What MacBook's disk holds for the thread's canvas (not deleted). */
async function onMacbook(): Promise<{ type: string; text?: string }[]> {
  const body = await read<{ scene?: { elements?: { type: string; text?: string; isDeleted?: boolean }[] } }>(macbook, `/api/inbox/threads/${far}/canvas`).catch(() => ({ scene: { elements: [] } }));
  return (body.scene?.elements ?? []).filter((element) => !element.isDeleted);
}

/** MacBook's agent: `plannotator inbox canvas` on MacBook, as an agent there runs it. */
const canvasThere = (...args: string[]) => {
  const run = spawnSync(binary, ['inbox', 'canvas', far, '--session', AGENT_SESSION, ...args], { env: macbook.env, cwd: macbook.root, encoding: 'utf8', timeout: 60_000 });
  return { status: run.status ?? -1, out: run.stdout ?? '', err: run.stderr ?? '' };
};

async function drawBox(fromX: number, fromY: number): Promise<void> {
  await layer.locator('label:has([data-testid="toolbar-rectangle"])').click();
  const area = (await layer.locator('.excalidraw-host').boundingBox())!;
  const x = area.x + area.width * fromX;
  const y = area.y + area.height * fromY;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 200, y + 110, { steps: 10 });
  await page.mouse.up();
  // Let go of it, so nothing stays selected in the pictures.
  await page.mouse.click(area.x + area.width * 0.9, area.y + area.height * 0.85);
}

test.describe.configure({ mode: 'serial' });
test.use({ actionTimeout: 20_000 });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  mkdirSync(proofDir, { recursive: true });
  studio = machine('Studio');
  macbook = machine('MacBook');
  await start(studio);
  await start(macbook);
  link(studio, macbook);
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  const project = scratchProject(join(macbook.root, 'code'), 'ledger');
  const agent = await SimAgent.connect({ binary, env: macbook.env, name: 'Claude Code', host: 'claude-code', cwd: macbook.root });
  agents.push(agent);
  const sent = await agent.send({ project_path: project, subject: 'Ledger sync: where the retry queue goes', thread: 'ledger', body: 'Sketch where the retry queue sits and I will draw the rest beside it.' });
  far = sent.thread_id as string;
});

test.afterAll(async () => {
  try {
    for (const agent of agents) await agent.close().catch(() => {});
    await context?.close();
  } finally {
    await removeInboxScratch();
  }
});

test("1. MacBook's thread in Studio's window: the pen, the board, and a box drawn there saved on MacBook", async () => {
  await expect.poll(async () => JSON.stringify(await read(studio, '/api/inbox/threads?machines=1')).includes(far), { timeout: 20_000 }).toBe(true);
  await expect.poll(async () => (await read<{ machines: { id: string; marks?: string[] }[] }>(studio, '/api/inbox/machines')).machines.find((m) => m.id === macbook.id)?.marks?.includes('canvas') ?? false, { timeout: 20_000 }).toBe(true);
  await page.goto(`${studio.url}#thread=${far}`);
  await expect(page.locator('[data-thread-sketch]')).toBeVisible({ timeout: 20_000 });
  await shot('01-far-thread-pen');

  await page.locator('[data-thread-sketch]').first().click();
  layer = page.locator(`[data-canvas-layer="${far}"]`);
  await expect(layer).toBeVisible();
  await expect(layer.locator('.excalidraw-host:not([data-settling])')).toBeVisible({ timeout: 30_000 });
  await shot('02-far-board-open');

  await drawBox(0.2, 0.3);
  await expect.poll(async () => (await onMacbook()).filter((element) => element.type === 'rectangle').length, { timeout: 15_000 }).toBe(1);
  // It lives with the thread: Studio's own disk has no canvas for it.
  expect((await fetch(`${base(studio)}/api/inbox/threads/${far}/canvas`)).status).toBe(404);
  await shot('03-far-box-saved-on-macbook');
});

test("2. MacBook's agent changes the canvas: Studio's open board shows it at once, in view", async () => {
  const before = canvasThere();
  expect(before.status, before.err).toBe(0);
  const rev = Number(/^Canvas of thread \S+, rev (\d+)/m.exec(before.out)![1]);
  const box = /^box (\S+) /m.exec(before.out)![1]!;
  const changed = canvasThere('--base', String(rev), '--do', JSON.stringify([{ add: 'note', text: 'Retry queue: after the ledger write', rightOf: box }, { connect: box, to: 'Retry queue: after the ledger write' }]));
  expect(changed.status, changed.err).toBe(0);
  await expect(layer.locator('[data-canvas-note]')).toBeVisible({ timeout: 20_000 });
  const board = (await layer.locator('.excalidraw-host').boundingBox())!;
  await expect
    .poll(
      async () => {
        const washes = await layer.locator('.ibc-flash').evaluateAll((spans) => spans.map((span) => span.getBoundingClientRect()).map((r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom })));
        return washes.length > 0 && washes.every((w) => w.left >= board.x - 8 && w.top >= board.y - 8 && w.right <= board.x + board.width + 8 && w.bottom <= board.y + board.height + 8);
      },
      { timeout: 5_000, intervals: [50] },
    )
    .toBe(true);
  await shot('04-far-agent-change');
});

test("3. MacBook's agent asks for a picture: Studio's open board draws it, and the file is on MacBook", async () => {
  const pictured = canvasThere('--picture');
  expect(pictured.status, pictured.err).toBe(0);
  const path = /^Picture of the whole canvas: (\S+\.png)/m.exec(pictured.out)?.[1];
  expect(path, pictured.out).toBeTruthy();
  expect(path!.startsWith(macbook.dataDir)).toBe(true);
  expect(readFileSync(path!).subarray(1, 4).toString()).toBe('PNG');
});

test('4. MacBook asleep: a box drawn in Studio says it waits, and lands on MacBook once it is back', async () => {
  await stopScratchInbox(macbook.dataDir);
  await expect.poll(async () => (await read<{ machines: { id: string; state: string }[] }>(studio, '/api/inbox/machines')).machines.find((m) => m.id === macbook.id)?.state, { timeout: 30_000 }).toBe('offline');
  await drawBox(0.2, 0.62);
  await expect(layer.getByText('Waiting for MacBook: this applies when MacBook is back.')).toBeVisible({ timeout: 15_000 });
  await shot('05-far-save-waits');

  await start(macbook);
  await expect.poll(async () => (await onMacbook()).filter((element) => element.type === 'rectangle').length, { timeout: 45_000 }).toBe(2);
  // MacBook's own frame for the save that waited reaches Studio: the board stops saying it waits.
  await expect(layer.getByText('Waiting for MacBook: this applies when MacBook is back.')).toHaveCount(0, { timeout: 20_000 });
  await shot('06-far-landed');
  await layer.locator('[data-canvas-close]').click();
  await expect(layer).toHaveCount(0);
  expect(errors).toEqual([]);
});
