/**
 * The thread canvas (docs/agent-guides/inbox-canvas.md), with no switch in Settings: reached from the reply box's +,
 * proved in a real browser against the compiled binary. Nothing is mocked: the binary runs `plannotator inbox
 * --background` under a temp PLANNOTATOR_DATA_DIR, a simulated agent writes through `plannotator inbox mcp`
 * (scripts/inbox-sim.ts) and works the canvas with the binary's own `plannotator inbox canvas` (a command, not an
 * action of the agent tool), and Chromium drives the window. HOME is the scratch folder.
 *
 * What regresses if this fails:
 *  1. A Canvas row back in Settings; a header canvas button on a thread with no canvas; the reply box's + not holding
 *     Attach a file then Canvas; the agent's tool gaining a canvas action.
 *  2. + → Canvas on a thread with no canvas: the canvas not opening over the window, not keeping a shape drawn on
 *     it, or not showing the agent's change as it lands; the header button not there once the thread has a canvas.
 *  3. + → Canvas on a thread with a canvas: not a clear spot, or a Send that carries the whole board instead of only
 *     what was drawn on this visit; the reply not reaching the agent with its picture and the line that points at
 *     `plannotator inbox canvas --help`.
 *  4. A phone: the menu or the header button missing, or a canvas that does not open.
 *
 * Shots (the whole window each time) land in PLANNOTATOR_E2E_PROOF_DIR/canvas, light and dark.
 */

import { expect, test, type Browser, type BrowserContext, type Page, type Response } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { E2E_GROUP_TIP_SEEN, inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'canvas');

interface World {
  env: Record<string, string>;
  url: string;
  project: string;
  claude: SimAgent;
  context: BrowserContext;
  page: Page;
  errors: string[];
  scripts: Response[];
  threadId: string;
}

let world: World;

async function shot(page: Page, name: string): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(proofDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

/** The agent's session, as its shell would name it to `plannotator inbox canvas`. */
const AGENT_SESSION = 'claude-code:6f1d2c3b-4a5e-4f60-8b7c-9d0e1f2a3b4c';

/** An agent's `plannotator inbox canvas …`, run as its shell runs it: the answer's text, or the refusal on stderr. */
function canvasCommand(args: string[]): { status: number; out: string; err: string } {
  const run = spawnSync(binary, ['inbox', 'canvas', ...args], { env: world.env, encoding: 'utf8', timeout: 60_000 });
  return { status: run.status ?? -1, out: run.stdout, err: run.stderr };
}

async function replyBox(page: Page) {
  const box = page.getByRole('textbox', { name: /^Reply to / });
  if (!(await box.isVisible())) await page.locator('.ib-pfoot').getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(box).toBeVisible();
  return box;
}

async function storedShapes(): Promise<{ type: string; text?: string }[]> {
  const response = await world.page.request.get(`${world.url}api/inbox/threads/${world.threadId}/canvas`);
  if (response.status() !== 200) return [];
  const body = (await response.json()) as { scene?: { elements?: { type: string; text?: string; isDeleted?: boolean }[] } };
  return (body.scene?.elements ?? []).filter((element) => !element.isDeleted);
}

/** Opens the thread's canvas, from the header's button or the reply box's + → Canvas, and waits for the editor. */
async function openCanvas(page: Page, from: 'header' | 'plus') {
  if (from === 'header') await page.locator('[data-thread-sketch]').first().click();
  else {
    await replyBox(page);
    await page.locator('[data-reply-plus]').click();
    await page.locator('[data-reply-plus-item="canvas"]').click();
  }
  const layer = page.locator(`[data-canvas-layer="${world.threadId}"]`);
  await expect(layer).toBeVisible();
  await expect(layer.locator('.excalidraw-host:not([data-settling])')).toBeVisible({ timeout: 30_000 });
  return layer;
}

test.describe.configure({ mode: 'serial' });
test.use({ actionTimeout: 20_000 });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-canvas-e2e-');
  const dataDir = join(root, 'data');
  markTourDecided(dataDir);
  const configFile = join(dataDir, 'config.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, unknown>;
  writeFileSync(configFile, JSON.stringify({ ...config, inboxReveals: { ...E2E_GROUP_TIP_SEEN } }));
  for (const dir of ['claude', 'codex', 'xdg']) mkdirSync(join(root, dir), { recursive: true });
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  const errors: string[] = [];
  const scripts: Response[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => {
    if (new URL(response.url()).pathname.endsWith('.js')) scripts.push(response);
  });
  const project = scratchProject(join(root, 'src'), 'checkout');
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const sent = await claude.send({ project_path: project, subject: 'Checkout latency: where the fraud check goes', thread: 'checkout', body: 'Checkout takes 1.8 s at p95. Sketch where you want the fraud check and I will draw the flow beside it.' });
  world = { env, url, project, claude, context, page, errors, scripts, threadId: sent.thread_id as string };
});

test.afterAll(async () => {
  try {
    if (!world) return;
    await world.claude.close().catch(() => {});
    await world.context.close();
  } finally {
    await removeInboxScratch();
  }
});

test("on from the start, with no row in Settings: no header button yet, the reply box's + holds Attach a file then Canvas, the tool has no canvas", async () => {
  const { page } = world;
  await page.goto(`${world.url}#settings/capabilities`);
  await expect(page.locator('[data-settings-capabilities]')).toBeVisible();
  await expect(page.locator('[data-settings-canvas]')).toHaveCount(0);

  await page.goto(`${world.url}#thread=${world.threadId}`);
  await expect(page.locator('.ib-subject')).toBeVisible();
  await replyBox(page);
  await expect(page.locator('[data-reply-plus]')).toBeVisible();
  await page.waitForTimeout(1_000);
  await expect(page.locator('[data-thread-sketch]')).toHaveCount(0);
  await shot(page, '01-reply-plus');
  await page.locator('[data-reply-plus]').click();
  const menu = page.locator('[data-reply-plus-menu]');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem')).toHaveText(['Attach a file', 'Canvas']);
  await shot(page, '02-plus-menu');
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(page.locator('[data-reply-plus]')).toBeFocused();
  // A session that starts now has no canvas action: the canvas is the command.
  const fresh = await SimAgent.connect({ binary, env: world.env, name: 'Claude Code', host: 'claude-code' });
  try {
    expect((await fresh.listTools()).map((tool) => tool.name)).not.toContain('canvas');
  } finally {
    await fresh.close();
  }
});

test("the canvas opens over the window, keeps a shape drawn on it, and shows the agent's sketch as it lands", async () => {
  const { page } = world;
  const layer = await openCanvas(page, 'plus');
  // A thread with no canvas: its canvas opens as it is.
  await expect(layer.locator('[data-canvas-fresh]')).toHaveCount(0);
  await shot(page, '05-canvas-open');

  // Excalidraw's tool is a visually hidden radio inside its label: the person presses the label.
  await layer.locator('label:has([data-testid="toolbar-rectangle"])').click();
  const area = (await layer.locator('.excalidraw-host').boundingBox())!;
  const x = area.x + area.width * 0.25;
  const y = area.y + area.height * 0.3;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 240, y + 140, { steps: 10 });
  await page.mouse.up();
  await expect.poll(async () => (await storedShapes()).filter((element) => element.type === 'rectangle').length, { timeout: 15_000 }).toBe(1);
  await shot(page, '06-shape-drawn');
  // A click on empty canvas lets go of the new shape, so a later Send is the whole canvas.
  await page.mouse.click(area.x + area.width * 0.6, area.y + area.height * 0.75);

  // The agent reads the canvas as text, then adds a note beside the person's box and ties the box to it.
  const read = canvasCommand([world.threadId, '--session', AGENT_SESSION]);
  expect(read.status, read.err).toBe(0);
  const rev = Number(/^Canvas of thread \S+, rev (\d+)/m.exec(read.out)![1]);
  const box = /^box (\S+) /m.exec(read.out)![1]!;
  const changes = [
    { add: 'note', text: 'Fraud check: before the charge', at: [Math.round(area.width * 0.25) + 320, Math.round(area.height * 0.3)] },
    { connect: box, to: 'Fraud check: before the charge' },
  ];
  const changed = canvasCommand([world.threadId, '--session', AGENT_SESSION, '--base', String(rev), '--do', JSON.stringify(changes)]);
  expect(changed.status, changed.err).toBe(0);
  expect(changed.out).toMatch(/^Done: the canvas is now rev \d+/m);
  await expect(layer.locator('[data-canvas-note]')).toBeVisible({ timeout: 15_000 });
  // What the agent added comes into view by itself, though it landed by the edge: its washes (which mark where each
  // thing is on screen) all lie inside the board.
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
  await expect.poll(async () => (await storedShapes()).some((element) => element.type === 'arrow'), { timeout: 15_000 }).toBe(true);
  await expect(layer.locator('[data-canvas-undo]')).toBeVisible();
  await expect.poll(async () => (await storedShapes()).some((element) => element.text?.includes('Fraud check')), { timeout: 15_000 }).toBe(true);
  await shot(page, '07-agent-sketch');

  await layer.locator('[data-canvas-close]').click();
  await expect(layer).toHaveCount(0);
  // The thread has a canvas now: its header button shows.
  await expect(page.locator('[data-thread-sketch]')).toBeVisible();
});

test("+ → Canvas on a thread with a canvas: a clear spot, and Send carries only what was drawn on this visit", async () => {
  const { page } = world;
  const layer = await openCanvas(page, 'plus');
  await expect(layer.locator('[data-canvas-fresh]')).toHaveCount(1);
  await expect(layer.locator('[data-canvas-what]')).toHaveText('New drawing');
  // Nothing drawn yet on this visit: nothing to send.
  await expect(layer.locator('[data-canvas-send]')).toBeDisabled();
  await shot(page, '08-clear-spot');
  await layer.locator('label:has([data-testid="toolbar-ellipse"])').click();
  const area = (await layer.locator('.excalidraw-host').boundingBox())!;
  const x = area.x + area.width * 0.35;
  const y = area.y + area.height * 0.35;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 200, y + 120, { steps: 10 });
  await page.mouse.up();
  await expect.poll(async () => (await storedShapes()).filter((element) => element.type === 'ellipse').length, { timeout: 15_000 }).toBe(1);
  // Let go of it, so Send is this visit's drawing rather than a selection.
  await page.mouse.click(area.x + area.width * 0.8, area.y + area.height * 0.8);
  await layer.getByRole('textbox', { name: 'Note to send with the canvas' }).fill('Here is where I want it: before the charge.');
  await shot(page, '09-new-drawing');
  await layer.locator('[data-canvas-send]').click();

  const reply = await world.claude.nextReply(world.threadId, 30);
  const said = JSON.stringify(reply);
  expect(said).toContain('Here is where I want it: before the charge.');
  expect(said).toContain('canvas.png');
  // What the agent reads with it (read_thread as an agent reads it) is only the new ellipse: not the box drawn
  // earlier nor the agent's note, which stay on the board.
  const read = JSON.stringify(await world.claude.readThread(world.threadId));
  expect(read).toContain('Sent from this thread\'s canvas');
  expect(read).toMatch(/ellipse [0-9a-zA-Z_-]+/);
  expect(read).not.toContain('Fraud check: before the charge');
  expect(read).not.toMatch(/\\nbox [0-9a-zA-Z_-]+/);
  expect(read).toContain('plannotator inbox canvas --help');
  expect((await storedShapes()).some((element) => element.text?.includes('Fraud check'))).toBe(true);
  if (await layer.count()) await layer.locator('[data-canvas-close]').click();
  await expect(page.locator('.ib-pane').getByText('Here is where I want it: before the charge.').first()).toBeVisible();
  await shot(page, '10-reply-sent');
});

test('a phone at 390 px: the + menu rises from its button, and the header button opens the canvas over the whole screen', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: 'light', hasTouch: true, isMobile: true });
  try {
    const page = await context.newPage();
    await page.goto(`${world.url}#thread=${world.threadId}`);
    await expect(page.locator('[data-thread-sketch]')).toBeVisible();
    await replyBox(page);
    await page.locator('[data-reply-plus]').click();
    const menu = page.locator('[data-reply-plus-menu]');
    await expect(menu.getByRole('menuitem')).toHaveText(['Attach a file', 'Canvas']);
    // It rises from the button (not the phone's bottom sheet): its foot sits over the button.
    const plus = (await page.locator('[data-reply-plus]').boundingBox())!;
    const box = (await menu.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(plus.y + 1);
    await shot(page, '11-phone-plus-menu');
    await page.keyboard.press('Escape');
    await openCanvas(page, 'header');
    await shot(page, '12-phone-canvas');
  } finally {
    await context.close();
  }
  expect(world.errors).toEqual([]);
});
