/**
 * "Animate it" (agent icon dialog, "Your own…"), the critical path in a real browser against the compiled binary
 * (temp data dir and HOME, the test sandbox with a fake Claude Code on its launch PATH, a live session from the
 * bridge's real long-poll, no browser opened, nothing real asked):
 *
 *  click Animate it → New message opens filled in (the words with a request id, the picture attached, To open on the
 *  running agents and "New Claude Code session") → Send → the agent's command hands an animated SVG back while the
 *  window is offline and the dialog closed → back online, the agent's icon is the new picture with no reload →
 *  "Use the original" puts the old one back.
 *
 * PLANNOTATOR_ANIMATE_SHOTS: a folder for screenshots (light, dark, a phone). PLANNOTATOR_ANIMATE_PICTURE and
 * PLANNOTATOR_ANIMATE_RESULT: a picture and an animated result from outside the repo for those screenshots; the test
 * draws its own otherwise. PLANNOTATOR_ANIMATE_POOR_LINK=1: the window on a poor link (300 ms, 1 Mbit/s each way) and
 * the step's time printed. Build the binary first (see inbox.spec.ts).
 */
import { expect, test, type Browser, type BrowserContext, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { INBOX_BRIDGE_POLL_PATH } from '../../packages/shared/inbox/connection';
import { installFakeClaude, type FakeClaude } from '../helpers/fake-claude';
import { markTourDecided } from '../helpers/tour-decided';
import { NO_BROWSER } from '../helpers/no-browser';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shots = process.env.PLANNOTATOR_ANIMATE_SHOTS ? resolve(process.env.PLANNOTATOR_ANIMATE_SHOTS) : null;

const svg = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${body}</svg>`;
const STILL = svg('<path d="M14 26 L20 6 L30 20 Z M50 26 L44 6 L34 20 Z" fill="#f97316"/><circle cx="32" cy="36" r="22" fill="#f97316"/><ellipse cx="32" cy="46" rx="14" ry="10" fill="#fff"/><circle cx="25" cy="33" r="3"/><circle cx="39" cy="33" r="3"/>');
const MOVING = STILL.replace('<path', '<style>@keyframes b{50%{transform:translateY(-3px)}}g{animation:b 1.6s ease-in-out infinite}</style><g><path').replace('</svg>', '</g></svg>');

interface World {
  root: string;
  env: Record<string, string>;
  url: string;
  agent: SimAgent;
  fake: FakeClaude;
  context: BrowserContext;
  page: Page;
  picture: string;
  result: string;
  stopPoll: () => Promise<void>;
}
let world: World;

/** A session that keeps polling the bridge, as a running agent's mod does: compose's To lists it. */
function keepLive(dataDir: string, session: string, project: string): () => Promise<void> {
  let stopped = false;
  const started = Date.now();
  const loop = (async () => {
    while (!stopped) {
      const { port, token } = JSON.parse(readFileSync(join(dataDir, 'inbox', 'inbox.json'), 'utf8')) as { port: number; token: string };
      const response = await fetch(`http://127.0.0.1:${port}${INBOX_BRIDGE_POLL_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ session, host: 'claude-code', waitMs: 1_000, project_path: project, started_at: started, busy: false, idle_since: started }),
      }).catch(() => null);
      await response?.text().catch(() => '');
    }
  })();
  return async () => {
    stopped = true;
    await loop;
  };
}

async function shot(page: Page, name: string, modes: ('light' | 'dark')[] = ['light', 'dark']): Promise<void> {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  for (const mode of modes) {
    await page.emulateMedia({ colorScheme: mode });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(shots, `${name}-${mode}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

const mark = (page: Page, agentId: string) => page.locator(`[data-agent-icon="${agentId}"] [data-agent-mark]`);
const dialog = (page: Page) => page.locator('dialog[data-dialog="agent-icon"][open]');

async function openYourOwn(page: Page, agentId: string): Promise<void> {
  await page.locator(`[data-agent-icon="${agentId}"]`).focus();
  await page.keyboard.press('Enter');
  await page.locator('.am-fan[data-open] [data-face-choice="own"]').click();
  await expect(dialog(page)).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-inbox-icon-animate-e2e-');
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  const data = join(root, 'data');
  for (const dir of [home, bin, data]) mkdirSync(dir, { recursive: true });
  // Plannotator's Claude Code plugin is on in the sandbox's own agent home, and a fake `claude` on its launch PATH:
  // New message offers "New Claude Code session". The sandbox finds no other agent CLI.
  mkdirSync(join(data, 'agents-home', '.claude'), { recursive: true });
  writeFileSync(join(data, 'agents-home', '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'plannotator@plannotator': true } }));
  const fake = installFakeClaude({ bin, state: join(root, 'fake-claude') });
  markTourDecided(data);
  writeFileSync(join(data, 'config.json'), JSON.stringify({ inboxLaunch: { enabled: true }, inboxThemeChooser: { notNeededAt: '2026-10-01T10:00:00.000Z' }, inboxMarkReadWarning: false }));
  const env: Record<string, string> = {
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: home,
    SHELL: fake.shell,
    PLANNOTATOR_DATA_DIR: data,
    PLANNOTATOR_TEST_SANDBOX: root,
    PLANNOTATOR_TEST_LAUNCH_PATH: `${bin}:/usr/bin:/bin`,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_INBOX_TAILSCALE: '0',
    PLANNOTATOR_INBOX_PHONES: '0',
    PLANNOTATOR_INBOX_NOTES: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const project = scratchProject(join(root, 'src'), 'fox-site');
  const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  await agent.send({ project_path: project, subject: 'Landing page hero', body: 'The hero is in. Want the darker variant?' });
  const stopPoll = keepLive(data, 'ses-helper', project);
  const pictures = join(root, 'pictures');
  mkdirSync(pictures, { recursive: true });
  const picture = join(pictures, process.env.PLANNOTATOR_ANIMATE_PICTURE?.endsWith('.png') ? 'fox.png' : 'fox.svg');
  writeFileSync(picture, process.env.PLANNOTATOR_ANIMATE_PICTURE ? readFileSync(process.env.PLANNOTATOR_ANIMATE_PICTURE) : STILL);
  const result = join(pictures, 'animated.svg');
  writeFileSync(result, process.env.PLANNOTATOR_ANIMATE_RESULT ? readFileSync(process.env.PLANNOTATOR_ANIMATE_RESULT) : MOVING);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  world = { root, env, url: started.stdout.trim(), agent, fake, context, page, picture, result, stopPoll };
});

test.afterAll(async () => {
  try {
    if (!world) return;
    await world.stopPoll();
    await world.agent.close().catch(() => {});
    world.fake.stopAll?.();
    await world.context.close();
  } finally {
    await removeInboxScratch();
  }
});

test('Animate it: a filled-in New message, the hand-back changes the icon by itself (also after a drop), and Use the original undoes it', async () => {
  test.setTimeout(180_000);
  const { page } = world;
  if (process.env.PLANNOTATOR_ANIMATE_POOR_LINK) {
    const cdp = await world.context.newCDPSession(page);
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 300, downloadThroughput: 125_000, uploadThroughput: 125_000 });
  }
  await page.goto(world.url);
  await expect(page.getByText('Landing page hero').first()).toBeVisible({ timeout: 30_000 });
  const agentsButton = page.getByRole('button', { name: 'Agents', exact: true });
  if ((await agentsButton.getAttribute('aria-expanded')) === 'false') await agentsButton.click();
  await expect(page.locator('.ib-sbagent [data-agent-icon]').first()).toBeVisible({ timeout: 30_000 });
  const agentId = (await page.locator('.ib-sbagent [data-agent-icon]').first().getAttribute('data-agent-icon'))!;

  // The person's own picture on the agent.
  await openYourOwn(page, agentId);
  const chooser = page.waitForEvent('filechooser');
  await dialog(page).locator('.am-own-up').click();
  await (await chooser).setFiles(world.picture);
  await expect(mark(page, agentId)).toHaveAttribute('data-face', /^own:[0-9a-f]{64}$/);
  const original = (await mark(page, agentId).getAttribute('data-face'))!;

  // Under it: the button and its one line.
  await openYourOwn(page, agentId);
  const row = dialog(page).locator('[data-animate-it]');
  await expect(row.getByRole('button', { name: 'Animate it' })).toBeVisible();
  await expect(row).toContainText('Asks an agent, in a new thread, to animate this picture.');
  await shot(page, '1-animate-it');

  // One press: New message, filled in, To open on the agents.
  const pressed = Date.now();
  await row.getByRole('button', { name: 'Animate it' }).click();
  await expect(dialog(page)).toHaveCount(0, { timeout: 30_000 });
  const compose = page.locator('[data-compose]').first();
  await expect(compose).toBeVisible();
  const text = page.locator('[data-compose-text] textarea').first();
  await expect(text).toHaveValue(/^Please animate the picture attached/);
  if (process.env.PLANNOTATOR_ANIMATE_POOR_LINK) console.log(`Animate it → filled-in message: ${Date.now() - pressed} ms`);
  const body = await text.inputValue();
  const request = /--request (ia_[0-9a-f]{24})/.exec(body)?.[1];
  expect(request, body.slice(-400)).toBeTruthy();
  await expect(page.getByText(/agent-icon\.(svg|png)/).first()).toBeVisible();
  const picker = page.locator('[data-compose-picker]');
  await expect(picker).toBeVisible();
  await expect(picker.locator('[data-compose-start]').first()).toBeVisible({ timeout: 20_000 });
  await shot(page, '2-choose-agent');

  // The running agent, then Send: the only step left.
  await picker.locator('[data-compose-session="ses-helper"]').click();
  await shot(page, '3-filled-in');
  await page.locator('[data-compose-send]').click();
  await expect(compose).toBeHidden({ timeout: 20_000 });

  // The agent hands it back while the window is offline (dialog closed): nothing lost, no reload needed.
  await world.context.setOffline(true);
  const handed = spawnSync(binary, ['inbox', 'icon', 'set', world.result, '--request', request!], { env: world.env, encoding: 'utf8', timeout: 30_000 });
  expect([handed.status, handed.stdout.trim()], handed.stderr).toEqual([0, "Done: the agent's icon is now your picture, in every Inbox window."]);
  await page.waitForTimeout(1500);
  await world.context.setOffline(false);
  await expect(mark(page, agentId)).not.toHaveAttribute('data-face', original, { timeout: 60_000 });
  await expect(mark(page, agentId)).toHaveAttribute('data-face', /^own:[0-9a-f]{64}$/);
  await shot(page, '4-after-hand-back');

  // One click back.
  await openYourOwn(page, agentId);
  await expect(dialog(page).locator('[data-animate-it]')).toContainText('An agent animated this picture.');
  await shot(page, '5-use-the-original');
  await dialog(page).getByRole('button', { name: 'Use the original' }).click();
  await expect(mark(page, agentId)).toHaveAttribute('data-face', original);

  // A phone's width: the same row and the filled-in message (screenshots only; nothing is sent).
  if (shots) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(world.url);
    const nav = page.getByRole('button', { name: /sidebar|navigation|menu/i }).first();
    if (!(await page.locator(`[data-agent-icon="${agentId}"]`).isVisible())) await nav.click();
    await openYourOwn(page, agentId);
    await shot(page, 'phone-1-animate-it', ['light']);
    await dialog(page).getByRole('button', { name: 'Animate it' }).click();
    await expect(page.locator('[data-compose]').first()).toBeVisible();
    await page.waitForTimeout(800);
    await shot(page, 'phone-2-choose-agent', ['light']);
  }
});
