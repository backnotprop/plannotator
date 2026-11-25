/**
 * The thread canvas as a capability (Settings → Capabilities → Canvas, config.json `inboxCanvas`, off by default;
 * docs/agent-guides/inbox-canvas.md), proved in a real browser against the compiled binary. Nothing is mocked: the
 * binary runs `plannotator inbox --background` under a temp PLANNOTATOR_DATA_DIR, a simulated agent writes through
 * `plannotator inbox mcp` (scripts/inbox-sim.ts), and Chromium drives the window. HOME is the scratch folder.
 *
 * What regresses if this fails:
 *  1. Off (the default): a pen in a thread's header or reply box, or any of the canvas's code fetched, for a person
 *     who never turned it on; the agent's canvas action not refused.
 *  2. On: the Settings row not turning the pens on; the canvas not opening over the window, not keeping a shape drawn
 *     on it, or not showing the agent's change as it lands.
 *  3. The reply box's pen: a sketch sent from it not reaching the agent as the person's reply with the picture.
 *  4. A phone: no pen, or a canvas that does not open.
 *  5. Off again: the pens staying.
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
  /** The agent's session after the canvas is on: a session's tools are listed once, at its start. */
  drawer: SimAgent | null;
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

/** Whether any script the page fetched so far carries this text (each script is read once it has arrived). */
async function fetchedScriptHas(marker: string): Promise<boolean> {
  for (const response of world.scripts) {
    const code = await response.text().catch(() => '');
    if (code.includes(marker)) return true;
  }
  return false;
}

/** The canvas's own code: its pens and layer (canvas/CanvasParts.tsx) and the editor (canvas/CanvasBoard.tsx). */
const CANVAS_CODE = 'data-canvas-layer';

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

/** Opens the thread's canvas from a pen and waits for the editor. */
async function openCanvas(page: Page, pen: string) {
  await page.locator(pen).first().click();
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
  world = { env, url, project, claude, drawer: null, context, page, errors, scripts, threadId: sent.thread_id as string };
});

test.afterAll(async () => {
  try {
    if (!world) return;
    await world.claude.close().catch(() => {});
    await world.drawer?.close().catch(() => {});
    await world.context.close();
  } finally {
    await removeInboxScratch();
  }
});

test('off by default: the switch is off, a thread has no pen, none of the canvas is fetched, and the agent is refused', async () => {
  const { page, claude } = world;
  await page.goto(`${world.url}#settings/capabilities`);
  const row = page.locator('[data-settings-canvas]');
  await expect(row).toBeVisible();
  await expect(row.locator('.ib-l')).toHaveText('Canvas');
  await expect(row.locator('.ib-desc')).toHaveText('An Excalidraw board in every thread that you and your agents can both sketch on.');
  await expect(row.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  await shot(page, '01-settings-off');

  await page.goto(`${world.url}#thread=${world.threadId}`);
  await expect(page.locator('.ib-subject')).toBeVisible();
  await replyBox(page);
  await page.waitForTimeout(1_000);
  await expect(page.locator('[data-thread-sketch]')).toHaveCount(0);
  await expect(page.locator('[data-reply-sketch]')).toHaveCount(0);
  expect(await fetchedScriptHas(CANVAS_CODE)).toBe(false);
  await shot(page, '02-thread-off');

  await expect(claude.canvas({ thread_id: world.threadId })).rejects.toThrow(/canvas_off/);
});

test('on: the Settings row turns it on, and the thread has its pen in the header and in the reply box', async () => {
  const { page } = world;
  await page.goto(`${world.url}#settings/capabilities`);
  const toggle = page.locator('[data-settings-canvas]').getByRole('switch');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await shot(page, '03-settings-on');
  world.drawer = await SimAgent.connect({ binary, env: world.env, name: 'Claude Code', host: 'claude-code' });

  await page.goto(`${world.url}#thread=${world.threadId}`);
  await expect(page.locator('[data-thread-sketch]')).toBeVisible();
  await replyBox(page);
  await expect(page.locator('[data-reply-sketch]')).toBeVisible();
  // The control: the pens' code arrives now, so the check while off was not empty.
  expect(await fetchedScriptHas(CANVAS_CODE)).toBe(true);
  await shot(page, '04-thread-pens');
});

test("the canvas opens over the window, keeps a shape drawn on it, and shows the agent's sketch as it lands", async () => {
  const { page } = world;
  const layer = await openCanvas(page, '[data-thread-sketch]');
  await shot(page, '05-canvas-open');

  await layer.locator('[data-testid="toolbar-rectangle"]').click();
  const area = (await layer.locator('.excalidraw-host').boundingBox())!;
  const x = area.x + area.width * 0.25;
  const y = area.y + area.height * 0.3;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 240, y + 140, { steps: 10 });
  await page.mouse.up();
  await expect.poll(async () => (await storedShapes()).filter((element) => element.type === 'rectangle').length, { timeout: 15_000 }).toBe(1);
  await shot(page, '06-shape-drawn');

  const drawer = world.drawer!;
  const read = await drawer.canvas({ thread_id: world.threadId });
  await drawer.canvas({ thread_id: world.threadId, base: read.rev as number, do: [{ add: 'note', text: 'Fraud check: before the charge', at: [Math.round(area.width * 0.25) + 320, Math.round(area.height * 0.3)] }] });
  await expect(layer.locator('[data-canvas-note]')).toBeVisible({ timeout: 15_000 });
  await expect(layer.locator('[data-canvas-undo]')).toBeVisible();
  await expect.poll(async () => (await storedShapes()).some((element) => element.text?.includes('Fraud check')), { timeout: 15_000 }).toBe(true);
  await shot(page, '07-agent-sketch');

  await layer.locator('[data-canvas-close]').click();
  await expect(layer).toHaveCount(0);
});

test("the reply box's pen: a sketch sent from the canvas reaches the agent as the person's reply, with its picture", async () => {
  const { page } = world;
  await replyBox(page);
  await expect(page.locator('[data-reply-sketch]')).toBeVisible();
  await shot(page, '08-reply-pen');

  const layer = await openCanvas(page, '[data-reply-sketch]');
  await layer.getByRole('textbox', { name: 'Note to send with the canvas' }).fill('Here is where I want it: before the charge.');
  await shot(page, '09-reply-with-sketch');
  await layer.locator('[data-canvas-send]').click();

  const reply = await world.drawer!.nextReply(world.threadId, 30);
  const said = JSON.stringify(reply);
  expect(said).toContain('Here is where I want it: before the charge.');
  expect(said).toContain('canvas.png');
  if (await layer.count()) await layer.locator('[data-canvas-close]').click();
  await expect(page.locator('.ib-pane').getByText('Here is where I want it: before the charge.')).toBeVisible();
  await shot(page, '10-reply-sent');
});

test('a phone at 390 px: the pen opens the canvas over the whole screen', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: 'light', hasTouch: true, isMobile: true });
  try {
    const page = await context.newPage();
    await page.goto(`${world.url}#thread=${world.threadId}`);
    await expect(page.locator('[data-thread-sketch]')).toBeVisible();
    await shot(page, '11-phone-thread');
    await openCanvas(page, '[data-thread-sketch]');
    await shot(page, '12-phone-canvas');
  } finally {
    await context.close();
  }
});

test('off again: the pens are gone', async () => {
  const { page } = world;
  await page.goto(`${world.url}#settings/capabilities`);
  const toggle = page.locator('[data-settings-canvas]').getByRole('switch');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await shot(page, '13-settings-off-again');
  await page.goto(`${world.url}#thread=${world.threadId}`);
  await expect(page.locator('.ib-subject')).toBeVisible();
  await replyBox(page);
  await expect(page.locator('[data-thread-sketch]')).toHaveCount(0);
  await expect(page.locator('[data-reply-sketch]')).toHaveCount(0);
  await shot(page, '14-thread-off-again');
  expect(world.errors).toEqual([]);
});
