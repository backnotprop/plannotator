/**
 * Copy file in a code attachment (approval "inbox-copy-file", Strip), proved in
 * a real browser against the compiled binary. Nothing is mocked: `plannotator
 * inbox --background` runs under a temp PLANNOTATOR_DATA_DIR and HOME; one
 * agent sends a Slack app manifest (YAML, drawn as code), a TypeScript file and
 * a screenshot through `plannotator inbox mcp`; Chromium drives the window as a
 * desktop and as an iPhone.
 *
 * Proves: the code's top row leads with Copy file at the code's top left,
 * side by side (at 1440 and 1920 wide), in full screen and on a phone, never under full screen's
 * toolbar (top right on a desktop, bottom right on a phone); a press puts the
 * file's exact text on the clipboard (read back from the system clipboard),
 * says Copied and tells the live region, then goes back; a file changed since
 * it was sent shows the changed note in full screen and the row starts below
 * it on a desktop and a phone, so neither Copy file nor the hint is covered;
 * the sent version copies the sent text; a phone's button is a 44 px target;
 * an image gets no Copy file.
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-copy-file.spec.ts`.
 * PNGs land in PLANNOTATOR_E2E_SHOTS_DIR (default .local/proof/copy-file):
 * {side,wide,wide-changed,full,changed,phone,phone-changed}[-copied]-{light,dark}.
 */

import { devices, expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { forgetFileViewChoice } from './file-view';

const repo = resolve(__dirname, '../..');
const builtBinary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shotsDir = resolve(process.env.PLANNOTATOR_E2E_SHOTS_DIR ?? join(repo, '.local/proof/copy-file'));

const MANIFEST = [
  '# Slack app manifest for the Standup bot.',
  '# Paste into https://api.slack.com/apps → Create New App → From an app manifest.',
  'display_information:',
  '  name: Standup',
  '  description: Collects daily standups in a thread and posts a summary at 10:00.',
  '  background_color: "#1d2433"',
  'features:',
  '  app_home:',
  '    home_tab_enabled: true',
  '    messages_tab_enabled: true',
  '  bot_user:',
  '    display_name: standup',
  '    always_online: true',
  '  slash_commands:',
  '    - command: /standup',
  '      url: https://standup.acme.dev/slack/commands',
  '      description: Start, skip or configure the standup',
  '      usage_hint: "[start|skip|config]"',
  'oauth_config:',
  '  redirect_urls:',
  '    - https://standup.acme.dev/slack/oauth/callback',
  '  scopes:',
  '    bot:',
  '      - app_mentions:read',
  '      - channels:history',
  '      - chat:write',
  '      - commands',
  '      - im:history',
  '      - users:read',
  'settings:',
  '  event_subscriptions:',
  '    request_url: https://standup.acme.dev/slack/events',
  '    bot_events:',
  '      - app_home_opened',
  '      - app_mention',
  '  interactivity:',
  '    is_enabled: true',
  '    request_url: https://standup.acme.dev/slack/interactive',
  '  org_deploy_enabled: false',
  '  socket_mode_enabled: false',
  '  token_rotation_enabled: true',
  '',
].join('\n');
const CHANGED = MANIFEST.replace('token_rotation_enabled: true', 'token_rotation_enabled: false\n  # rotated by ops');

const SCHEDULE = [
  "import { DateTime } from 'luxon';",
  '',
  '/** Weekdays only: Saturday and Sunday never open a window. */',
  'const WORKDAYS = new Set([1, 2, 3, 4, 5]);',
  '',
  'export function opensToday(now: DateTime, tz: string): boolean {',
  '  return WORKDAYS.has(now.setZone(tz).weekday);',
  '}',
  '',
].join('\n');

interface World {
  url: string;
  project: string;
  claude: SimAgent;
  context: BrowserContext;
  page: Page;
  errors: string[];
  threadId: string;
  ids: Record<string, string>;
}

let world: World;

test.describe.configure({ mode: 'serial' });

/** Light and dark, with reduced motion so the shots hold still. */
async function shot(page: Page, name: string): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(shotsDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

const copyButton = (page: Page) => page.locator('[data-attachment-pane] [data-copy-file]');
const row = (page: Page) => page.locator('[data-attachment-pane] [data-code-row]');

async function open(page: Page, name: string, view: 'full' | 'side' | null) {
  await page.goto(`${world.url}#thread=${world.threadId}&file=${world.ids[name]}${view ? `&view=${view}` : ''}`);
  await expect(page.locator(`[data-attachment-pane="${world.ids[name]}"]`)).toBeVisible();
}

/** The changed note covers no part of the hint (it did before the row grew under it). */
async function expectHintClear(page: Page, note: Locator) {
  const hint = (await row(page).locator('.ib-codehint-t').boundingBox())!;
  expect(apart(hint, (await note.boundingBox())!), 'the changed note covers the hint').toBe(true);
}

/** Two boxes share no pixel. */
function apart(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean {
  return a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
}

/** Copy file sits at the code's top left and inside the top row, apart from what floats over the file. */
async function expectClear(page: Page, floating: Locator[]) {
  const code = (await page.locator('[data-attachment-pane] [data-code-view]').boundingBox())!;
  const button = (await copyButton(page).boundingBox())!;
  expect(button.x - code.x).toBeLessThan(24);
  expect(button.y).toBeGreaterThanOrEqual(code.y);
  for (const over of floating) {
    const box = await over.boundingBox();
    if (box) expect(apart(button, box), `Copy file is covered by ${await over.getAttribute('class')}`).toBe(true);
  }
}

/** Press Copy file: the system clipboard holds `text`; Copied shows and the live region says it; then it goes back. */
async function pressAndRead(page: Page, text: string, shotName?: string) {
  await copyButton(page).click();
  await expect(copyButton(page)).toHaveText('Copied');
  await expect(copyButton(page)).toHaveAttribute('data-copy-file', 'copied');
  await expect(page.locator('[data-attachment-pane] [data-step-live]')).toHaveText(/^Copied .+\.$/);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(text);
  if (shotName) {
    // Both schemes inside the 1.6 s "Copied" shows for.
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      // Let the scheme repaint first: shot at once, the dark one caught light colours under a wash.
      await page.waitForTimeout(150);
      await page.screenshot({ path: join(shotsDir, `${shotName}-copied-${scheme}.png`) });
    }
    await expect(copyButton(page)).toHaveText('Copied');
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
  }
  await expect(copyButton(page)).toHaveText('Copy file', { timeout: 4000 });
}

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(builtBinary), `build the binary first: ${builtBinary}`).toBe(true);
  rmSync(shotsDir, { recursive: true, force: true });
  mkdirSync(shotsDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-copy-file-');
  const dataDir = join(root, 'data');
  const home = join(root, 'home');
  mkdirSync(home);
  const env = { PATH: process.env.PATH ?? '', HOME: home, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9', PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_INBOX_TAILSCALE: '0', PLANNOTATOR_INBOX_PHONES: '0', PLANNOTATOR_UPDATE_CHECK: '0', PLANNOTATOR_INBOX_NOTES: '0' };
  const started = spawnSync(builtBinary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();

  const project = scratchProject(join(root, 'src'), 'standup');
  mkdirSync(join(project, 'slack'));
  mkdirSync(join(project, 'src'));
  mkdirSync(join(project, 'shots'));
  writeFileSync(join(project, 'slack', 'manifest.yaml'), MANIFEST);
  writeFileSync(join(project, 'src', 'schedule.ts'), SCHEDULE);
  const maker = await browser.newContext({ viewport: { width: 640, height: 400 }, deviceScaleFactor: 1 });
  const makerPage = await maker.newPage();
  await makerPage.setContent('<body style="margin:0;background:#1d2433;color:#fff;font:40px system-ui;display:grid;place-items:center;height:100vh">Standup</body>');
  writeFileSync(join(project, 'shots', 'home.png'), await makerPage.screenshot());
  await maker.close();

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(url).origin });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  world = { url, project, claude: await SimAgent.connect({ binary: builtBinary, env, name: 'Claude', host: 'claude-code' }), context, page, errors, threadId: '', ids: {} };
  const sent = await world.claude.send({
    project_path: project,
    subject: 'Slack app manifest for Standup',
    body: 'The manifest, ready to paste into Slack, the scheduler it calls, and the home tab.',
    attachments: ['slack/manifest.yaml', 'src/schedule.ts', 'shots/home.png'],
  });
  world.threadId = sent.thread_id;
  const model = (await (await fetch(new URL(`/api/inbox/threads/${sent.thread_id}/attachments`, url))).json()) as { attachments: { id: string; name: string }[] };
  for (const a of model.attachments) world.ids[a.name] = a.id;
});

test.afterEach(async () => forgetFileViewChoice(world?.page));

test.afterAll(async () => {
  try {
    if (!world) return;
    expect(world.errors).toEqual([]);
    await world.claude.close().catch(() => {});
    await world.context.close();
  } finally {
    await removeInboxScratch();
  }
});

test('side by side: the code row leads with Copy file; a press copies the exact text and says Copied', async () => {
  const page = world.page;
  await open(page, 'manifest.yaml', 'side');
  await expect(row(page)).toContainText('Click a line number');
  await expect(copyButton(page)).toHaveText('Copy file');
  await expectClear(page, []);
  await page.mouse.move(700, 700);
  await shot(page, 'side');
  await pressAndRead(page, MANIFEST, 'side');
  // A TypeScript file has it too, and copies its own text.
  await open(page, 'schedule.ts', 'side');
  await pressAndRead(page, SCHEDULE);
});

test('full screen: Copy file stays at the top left, clear of the toolbar at the top right', async () => {
  const page = world.page;
  await open(page, 'manifest.yaml', 'full');
  await expect(page.locator('[data-full-view-bar]')).toBeVisible();
  await expectClear(page, [page.locator('[data-full-view-bar]')]);
  await page.mouse.move(700, 700);
  await shot(page, 'full');
  await pressAndRead(page, MANIFEST, 'full');
});

test('a wide window: Copy file leads the row side by side and in full screen; a changed file keeps the hint clear', async () => {
  const page = world.page;
  await page.setViewportSize({ width: 1920, height: 1080 });
  try {
    await open(page, 'manifest.yaml', 'side');
    await expect(row(page)).toContainText('Click a line number');
    await expectClear(page, []);
    await page.mouse.move(900, 900);
    await shot(page, 'wide');
    await pressAndRead(page, MANIFEST, 'wide');
    writeFileSync(join(world.project, 'slack', 'manifest.yaml'), CHANGED);
    try {
      await open(page, 'manifest.yaml', 'full');
      // The same file was open a moment ago; a reload reads it again (a hash change alone does not).
      await page.reload();
      const note = page.locator('[data-full-view-changed]');
      await expect(note).toBeVisible();
      await expectClear(page, [note, page.locator('[data-full-view-bar]')]);
      await expectHintClear(page, note);
      await page.mouse.move(900, 900);
      await shot(page, 'wide-changed');
    } finally {
      writeFileSync(join(world.project, 'slack', 'manifest.yaml'), MANIFEST);
    }
  } finally {
    await page.setViewportSize({ width: 1440, height: 900 });
  }
});

test('an image gets no Copy file', async () => {
  const page = world.page;
  await open(page, 'home.png', 'side');
  await expect(page.locator('[data-attachment-pane] img').first()).toBeVisible();
  await expect(copyButton(page)).toHaveCount(0);
});

test('a changed file in full screen: the row starts below the changed note; the sent version copies the sent text', async () => {
  const page = world.page;
  writeFileSync(join(world.project, 'slack', 'manifest.yaml'), CHANGED);
  try {
    await open(page, 'manifest.yaml', 'full');
    const note = page.locator('[data-full-view-changed]');
    await expect(note).toBeVisible();
    await expectClear(page, [note, page.locator('[data-full-view-bar]')]);
    await expectHintClear(page, note);
    await page.mouse.move(700, 700);
    await shot(page, 'changed');
    await pressAndRead(page, CHANGED, 'changed');
    // The version it sent: the clipboard gets that text.
    await note.getByRole('button', { name: 'Open the version it sent' }).click();
    await expect(page.locator('[data-attachment-pane]')).toHaveAttribute('data-version', 'sent');
    await expect(copyButton(page)).toHaveText('Copy file');
    await pressAndRead(page, MANIFEST);
  } finally {
    writeFileSync(join(world.project, 'slack', 'manifest.yaml'), MANIFEST);
  }
});

test('on a phone: Copy file is a 44 px target at the top left, clear of the toolbar and of the changed note', async ({ browser }: { browser: Browser }) => {
  const { defaultBrowserType: _ignored, ...device } = devices['iPhone 15'];
  const context = await browser.newContext({ ...device });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(world.url).origin });
  try {
    const page = await context.newPage();
    await open(page, 'manifest.yaml', null);
    await expect(page.locator('[data-attachment-pane]')).toHaveAttribute('data-full-view', '');
    await expect(row(page)).toContainText('Tap a line to comment.');
    const box = (await copyButton(page).boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    await expectClear(page, [page.locator('[data-full-view-bar]')]);
    await shot(page, 'phone');
    await pressAndRead(page, MANIFEST, 'phone');

    writeFileSync(join(world.project, 'slack', 'manifest.yaml'), CHANGED);
    try {
      await page.reload();
      const note = page.locator('[data-full-view-changed]');
      await expect(note).toBeVisible();
      await expectClear(page, [note, page.locator('[data-full-view-bar]')]);
      await expectHintClear(page, note);
      await shot(page, 'phone-changed');
      await pressAndRead(page, CHANGED, 'phone-changed');
    } finally {
      writeFileSync(join(world.project, 'slack', 'manifest.yaml'), MANIFEST);
    }
  } finally {
    await context.close();
  }
});

