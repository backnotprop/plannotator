/**
 * The Inbox sidebar is Workspaces' sidebar primitive (packages/inbox/shell),
 * proved in a real Chromium against the compiled binary under a temp
 * PLANNOTATOR_DATA_DIR: the toggle closes and opens it on the shell spring
 * (the width sampled every frame), ⌘B / Ctrl+B toggles it (not while typing), the choice
 * survives a reload, the hover peek shows the navigation while it is closed,
 * the edge collapses on a click and resizes on a drag (and closes past half
 * the minimum, reopening when the held pointer comes back), reduced motion
 * lands without travel, and a phone width gets the sheet.
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 * The PNGs, the video and the sampled curves land in .local/proof/sidebar/.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DEMO_MESSAGES, SimAgent, scratchProject } from '../../scripts/inbox-sim';

const repo = resolve(__dirname, '../..');
const builtBinary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'sidebar');
const WIDTH = 232;

interface World {
  root: string;
  dataDir: string;
  url: string;
  agent: SimAgent;
  context: BrowserContext;
  page: Page;
  errors: string[];
}

let world: World;
const curves: Record<string, Array<[number, number]>> = {};

function registry(): { pid: number } {
  return JSON.parse(readFileSync(join(world.dataDir, 'inbox', 'inbox.json'), 'utf8'));
}

function side(page: Page) {
  return page.getByRole('complementary', { name: 'Inbox navigation' });
}

/** The in-flow spacer's width every animation frame for `ms`, while `act` runs. */
async function sampleWidth(page: Page, act: () => Promise<void>, ms = 900): Promise<Array<[number, number]>> {
  const sampling = page.evaluate(
    (ms) =>
      new Promise<Array<[number, number]>>((done) => {
        const out: Array<[number, number]> = [];
        const t0 = performance.now();
        const tick = () => {
          const gap = document.querySelector('.ib-sb-gap');
          const t = performance.now() - t0;
          out.push([Math.round(t), gap ? parseFloat(getComputedStyle(gap).width) : -1]);
          if (t < ms) requestAnimationFrame(tick);
          else done(out);
        };
        requestAnimationFrame(tick);
      }),
    ms,
  );
  await page.waitForTimeout(32);
  await act();
  return sampling;
}

/** The widths strictly between the ends: the frames the spring drew. */
function travel(samples: Array<[number, number]>, end: number): number[] {
  return samples.map(([, w]) => w).filter((w) => w > 0.5 && w < end - 0.5);
}

async function shot(name: string): Promise<void> {
  const page = world.page;
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(proofDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

async function cookie(page: Page, name: string): Promise<string | undefined> {
  return (await page.context().cookies()).find((c) => c.name === name)?.value;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(builtBinary), `build the binary first: ${builtBinary}`).toBe(true);
  mkdirSync(proofDir, { recursive: true });
  for (const file of readdirSync(proofDir)) rmSync(join(proofDir, file), { recursive: true, force: true });
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-sidebar-e2e-')));
  const dataDir = join(root, 'data');
  const home = join(root, 'home');
  mkdirSync(home);
  const env = { PATH: process.env.PATH ?? '', HOME: home, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: 'none' };
  // The data dir this run hands the binary is its own temp folder, never the person's.
  expect(env.PLANNOTATOR_DATA_DIR.startsWith(root)).toBe(true);
  const started = spawnSync(builtBinary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const agent = await SimAgent.connect({ binary: builtBinary, env, name: 'Claude Code', host: 'claude-code' });
  await agent.send({ project_path: scratchProject(join(root, 'src'), 'billing-svc'), subject: 'Stripe 409', body: DEMO_MESSAGES.stopped });
  await agent.send({ project_path: scratchProject(join(root, 'src'), 'docs-site'), subject: 'Install page', body: DEMO_MESSAGES.holding });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: 'light',
    recordVideo: { dir: proofDir, size: { width: 1440, height: 900 } },
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  world = { root, dataDir, url, agent, context, page, errors };
});

test.afterAll(async () => {
  if (!world) return;
  await world.agent.close().catch(() => {});
  const video = world.page.video();
  await world.context.close();
  if (video) await video.saveAs(join(proofDir, 'sidebar.webm')).catch(() => {});
  if (video) await video.delete().catch(() => {});
  try {
    process.kill(registry().pid, 'SIGTERM');
  } catch {
    // Already gone.
  }
  rmSync(world.root, { recursive: true, force: true });
  writeFileSync(join(proofDir, 'curves.json'), JSON.stringify(curves, null, 1));
});

test('the toggle closes and opens the sidebar on the spring, and the list takes the width', async () => {
  const { page, url } = world;
  await page.goto(url);
  await expect(side(page)).toBeVisible();
  await expect(side(page).getByRole('button', { name: 'billing-svc' })).toBeVisible();
  const list = page.locator('.ib-listcol');
  await expect.poll(() => list.evaluate((el) => el.getBoundingClientRect().left)).toBe(WIDTH);
  await shot('open');

  const trigger = page.locator('.ib-lhead').getByRole('button', { name: 'Toggle Sidebar' });
  const closing = await sampleWidth(page, () => trigger.click());
  curves.close = closing;
  expect(closing[0]?.[1]).toBe(WIDTH);
  expect(closing.at(-1)?.[1]).toBe(0);
  // A spring, not a jump: many frames between the ends, never growing on the way down.
  expect(travel(closing, WIDTH).length).toBeGreaterThanOrEqual(10);
  for (let i = 1; i < closing.length; i++) expect(closing[i]![1]).toBeLessThanOrEqual(closing[i - 1]![1]);
  await expect(side(page)).toBeHidden();
  await expect(page.locator('.ib-sb-panel')).toHaveAttribute('inert', '');
  expect(await list.evaluate((el) => el.getBoundingClientRect().left)).toBe(0);
  expect(await cookie(page, 'plannotator-inbox-sidebar-open')).toBe('false');
  await shot('closed');

  const opening = await sampleWidth(page, () => trigger.click());
  curves.open = opening;
  expect(opening.at(-1)?.[1]).toBe(WIDTH);
  expect(travel(opening, WIDTH).length).toBeGreaterThanOrEqual(10);
  // The bounce never draws the sidebar wider than its width.
  expect(Math.max(...opening.map(([, w]) => w))).toBe(WIDTH);
  await expect(side(page)).toBeVisible();
  expect(await cookie(page, 'plannotator-inbox-sidebar-open')).toBe('true');
});

test('⌘B and Ctrl+B toggle it, and the choice survives a reload', async () => {
  const { page } = world;
  const closing = await sampleWidth(page, () => page.keyboard.press('Meta+b'));
  expect(closing.at(-1)?.[1]).toBe(0);
  await expect(side(page)).toBeHidden();
  await page.reload();
  await expect(page.locator('.ib-lhead h1')).toBeVisible();
  // Closed from the first frame: a reload restores, it does not animate.
  expect(await page.locator('.ib-sb-gap').evaluate((el) => getComputedStyle(el).width)).toBe('0px');
  await expect(side(page)).toBeHidden();
  const opening = await sampleWidth(page, () => page.keyboard.press('Control+b'));
  expect(opening.at(-1)?.[1]).toBe(WIDTH);
  await expect(side(page)).toBeVisible();
  await page.reload();
  await expect(side(page)).toBeVisible();
});

test('⌘B in the reply box is typing: the sidebar stays', async () => {
  const { page, url } = world;
  await page.locator('.ib-lbody [data-thread-id]').first().click();
  await page.locator('.ib-pfoot').getByRole('button', { name: 'Reply', exact: true }).click();
  const reply = page.locator('textarea.ib-rtext');
  await reply.fill('Retry with the same key');
  await reply.focus();
  await page.keyboard.press('ControlOrMeta+b');
  await page.waitForTimeout(700);
  await expect(side(page)).toBeVisible();
  await expect(page.locator('.ib-sb')).toHaveAttribute('data-state', 'expanded');
  await expect(reply).toBeFocused();
  await expect(reply).toHaveValue('Retry with the same key');
  expect(await cookie(page, 'plannotator-inbox-sidebar-open')).toBe('true');
  await page.goto(url);
  await expect(side(page)).toBeVisible();
});

test('closed, the left edge peeks the navigation after a rest, and it works', async () => {
  const { page } = world;
  await page.keyboard.press('ControlOrMeta+b');
  await expect(side(page)).toBeHidden();
  await page.mouse.move(700, 450);
  await page.mouse.move(6, 450, { steps: 8 });
  // Hover intent: nothing in the first beat, the panel after 600 ms.
  await page.waitForTimeout(250);
  await expect(side(page)).toBeHidden();
  const peek = page.locator('[data-sidebar-peek]');
  await expect(peek).toHaveAttribute('data-visible', '');
  await expect(side(page)).toBeVisible();
  await page.mouse.move(120, 450, { steps: 4 });
  await page.waitForTimeout(350);
  await shot('peek');
  await side(page).getByRole('button', { name: 'docs-site' }).click();
  await expect(page.locator('.ib-lhead h1')).toHaveText('docs-site');
  await page.mouse.move(900, 450, { steps: 6 });
  await expect(peek).not.toHaveAttribute('data-visible', '');
  await expect(side(page)).toBeHidden();
  // The real sidebar stayed closed: the peek is an overlay, not a toggle.
  expect(await cookie(page, 'plannotator-inbox-sidebar-open')).toBe('false');
  await page.keyboard.press('ControlOrMeta+b');
  await expect(side(page)).toBeVisible();
  await expect(peek).toHaveCount(0);
});

test('the edge: a click collapses, a drag resizes, past half the minimum it closes and the held pointer reopens it', async () => {
  const { page } = world;
  const edge = page.getByRole('separator', { name: 'Sidebar width' });
  await expect(edge).toHaveAttribute('aria-valuenow', String(WIDTH));
  await page.mouse.move(WIDTH, 500);
  await page.mouse.down();
  await page.mouse.move(WIDTH + 68, 500, { steps: 6 });
  await page.mouse.up();
  await expect(edge).toHaveAttribute('aria-valuenow', '300');
  await expect.poll(() => page.locator('.ib-listcol').evaluate((el) => el.getBoundingClientRect().left)).toBe(300);
  expect(await cookie(page, 'plannotator-inbox-sidebar-width')).toBe('300');

  // Below 100 px (half the 200 minimum) it closes mid-drag; back above, it reopens.
  await page.mouse.move(300, 500);
  await page.mouse.down();
  await page.mouse.move(60, 500, { steps: 8 });
  await expect(page.locator('.ib-sb')).toHaveAttribute('data-state', 'collapsed');
  await page.mouse.move(260, 500, { steps: 8 });
  await expect(page.locator('.ib-sb')).toHaveAttribute('data-state', 'expanded');
  await page.mouse.up();
  await expect(edge).toHaveAttribute('aria-valuenow', '260');

  // The keyboard: arrows in 10 px steps, Home to the minimum.
  await edge.focus();
  await page.keyboard.press('ArrowRight');
  await expect(edge).toHaveAttribute('aria-valuenow', '270');
  await page.keyboard.press('Home');
  await expect(edge).toHaveAttribute('aria-valuenow', '200');
  await edge.evaluate((el) => (el as HTMLElement).blur());

  // A click on the edge collapses.
  await page.mouse.click(200, 500);
  await expect(page.locator('.ib-sb')).toHaveAttribute('data-state', 'collapsed');
  await expect(side(page)).toBeHidden();
  await page.keyboard.press('ControlOrMeta+b');
  await expect(side(page)).toBeVisible();
  // Back to the record's width for the frames that follow.
  await page.mouse.move(200, 500);
  await page.mouse.down();
  await page.mouse.move(WIDTH, 500, { steps: 4 });
  await page.mouse.up();
  await expect(edge).toHaveAttribute('aria-valuenow', String(WIDTH));
});

test('reduced motion: the toggle lands without travel', async () => {
  const { page } = world;
  const trigger = page.locator('.ib-lhead').getByRole('button', { name: 'Toggle Sidebar' });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const closing = await sampleWidth(page, () => trigger.click(), 400);
  expect(closing.at(-1)?.[1]).toBe(0);
  expect(travel(closing, WIDTH)).toEqual([]);
  const opening = await sampleWidth(page, () => trigger.click(), 400);
  expect(opening.at(-1)?.[1]).toBe(WIDTH);
  expect(travel(opening, WIDTH)).toEqual([]);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
});

test('a phone width: the sidebar is a sheet the toggle opens, a pick and Escape close it', async () => {
  const { page } = world;
  await page.setViewportSize({ width: 600, height: 900 });
  await expect(page.locator('.ib-sb')).toHaveCount(0);
  await expect(side(page)).toHaveCount(0);
  expect(await page.locator('.ib-listcol').evaluate((el) => el.getBoundingClientRect().left)).toBe(0);
  await page.locator('.ib-lhead').getByRole('button', { name: 'Toggle Sidebar' }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('complementary', { name: 'Inbox navigation' })).toBeVisible();
  await page.waitForTimeout(700);
  await shot('narrow-sheet');
  await sheet.getByRole('button', { name: 'Settings' }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page.locator('.ib-spage h1')).toHaveText('Settings');
  await page.keyboard.press('ControlOrMeta+b');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(side(page)).toBeVisible();
  expect(world.errors).toEqual([]);
});
