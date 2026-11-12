import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { INBOX_BRIDGE_POLL_PATH } from '../../packages/shared/inbox/connection';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = resolve(process.env.PLANNOTATOR_RESTART_SHOTS ?? join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'restart'));

const BILLING_SESSION = '6f2c9e14-8b0d-4c5a-9e27-1d3b7a0c4f81';
const PLAN_SESSION = 'a41d7e02-55c3-4b8e-8f10-6e9b2c7d3a55';
const BILLING_SESSION_2 = '0c9b5a37-2e41-4f6d-9a08-7b3e1c5d9f20';
const MORE_SESSIONS: [string, string, number, boolean][] = [
  ['d3e8f1a2-7c64-4b19-8e5d-2a9f0b6c1e47', 'web-app', 7, false],
  ['9a1f6c3b-0e2d-4d7a-b5c8-3f4e2a1b9c06', 'ledger-export', 10, true],
  ['5b7c2e9f-1a3d-4e8b-9c0f-6d2a8b4e1f73', 'docs', 11, false],
];

interface World {
  root: string;
  dataDir: string;
  env: Record<string, string>;
  url: string;
  code: string;
  billing: string;
  plannotator: string;
  pluginFolder: (version: string) => string;
  agent: SimAgent;
  context: BrowserContext;
  page: Page;
  errors: string[];
  connections: Connection[];
}

let world: World;

function writePluginRegistry(root: string, folder: string, version: string): void {
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(root, '.claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({
      version: 2,
      plugins: {
        'plannotator@plannotator': [{ scope: 'user', installPath: folder, version, installedAt: '2026-10-04T22:07:24.658Z', lastUpdated: '2026-10-17T05:27:07.299Z' }],
      },
    }),
  );
}

function registry(): { port: number; token: string } {
  return JSON.parse(readFileSync(join(world.dataDir, 'inbox', 'inbox.json'), 'utf8'));
}

class Connection {
  private stopped = false;
  private loop: Promise<void>;
  constructor(
    readonly session: string,
    private readonly project: string,
    public busy: boolean,
    public plugin: { version: string; root: string; loaded_at: number },
    private readonly startedAt: number,
  ) {
    this.loop = this.run();
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      const { port, token } = registry();
      await fetch(`http://127.0.0.1:${port}${INBOX_BRIDGE_POLL_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          session: this.session,
          host: 'claude-code',
          waitMs: 1_000,
          project_path: this.project,
          session_folder: this.project,
          started_at: this.startedAt,
          busy: this.busy,
          idle_since: Date.now() - 60_000,
          plugin: this.plugin,
          engine: '2.1.305',
        }),
      }).catch(() => null);
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.loop;
  }
}

async function shot(page: Page, name: string): Promise<void> {
  await page.mouse.move(1, 1);
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(proofDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

async function noOverflow(page: Page): Promise<void> {
  const wide = await page.evaluate(() => {
    const out: string[] = [];
    const width = document.documentElement.clientWidth;
    for (const el of document.querySelectorAll<HTMLElement>('[data-restart-note], [data-restart-steps], .ib-rw-cmd, [data-restart-sidebar], [data-agent-sessions]')) {
      const box = el.getBoundingClientRect();
      if (box.width > 0 && box.right > width + 1) out.push(`${el.className} ${Math.round(box.right)} > ${width}`);
    }
    return out;
  });
  expect(wide).toEqual([]);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-restart-e2e-');
  const dataDir = join(root, 'data');
  const pluginFolder = (version: string) => join(root, '.claude', 'plugins', 'cache', 'plannotator', 'plannotator', version);
  writePluginRegistry(root, pluginFolder('0.28.25'), '0.28.25');
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_INBOX_TAILSCALE: '0',
    PLANNOTATOR_INBOX_PHONES: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_INBOX_NOTES: '0',
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const code = join(root, 'code');
  const billing = scratchProject(code, 'billing-api');
  const plannotator = scratchProject(code, 'plannotator');
  const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  world = { root, dataDir, env, url, code, billing, plannotator, pluginFolder, agent, context, page, errors, connections: [] };
});

test.afterAll(async () => {
  try {
    if (!world) return;
    await Promise.all(world.connections.map((c) => c.stop()));
    await world.agent.close().catch(() => {});
    await world.context.close();
  } finally {
    await removeInboxScratch();
  }
});

const OLD = () => ({ version: '0.28.23', root: world.pluginFolder('0.28.23'), loaded_at: Date.parse('2026-10-16T09:14:00Z') });
const CURRENT = () => ({ version: '0.28.25', root: world.pluginFolder('0.28.25'), loaded_at: Date.now() });

test('a working Claude Code on an older plugin: the line under the reply leads with /reload-plugins and Copy; /exit and the resume command stay folded', async () => {
  const { page } = world;
  const sent = await world.agent.send(
    {
      project_path: world.billing,
      subject: 'Retry policy for the Stripe webhook',
      body: 'The webhook handler acks fast now and the queue owns retries. Anything else before I move on to the ledger export?',
      agent_session: BILLING_SESSION,
    } as Parameters<SimAgent['send']>[0],
    { wakes: true },
  );
  const at = (hour: number, minute = 0, daysAgo = 0) => {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    d.setHours(hour, minute, 0, 0);
    return d.getTime();
  };
  world.connections.push(new Connection(BILLING_SESSION, world.billing, true, OLD(), at(9, 14)));
  world.connections.push(new Connection(BILLING_SESSION_2, world.billing, false, OLD(), at(8, 2)));
  world.connections.push(new Connection(PLAN_SESSION, world.plannotator, false, OLD(), at(18, 2, 1)));
  for (const [session, name, hour, busy] of MORE_SESSIONS) {
    world.connections.push(new Connection(session, scratchProject(world.code, name), busy, OLD(), at(hour, 30)));
  }

  await page.goto(`${world.url}#thread=${sent.thread_id}`);
  const pane = page.locator('section.ib-pane');
  await expect(pane.getByRole('heading', { name: 'Retry policy for the Stripe webhook' })).toBeVisible();
  await pane.locator('.ib-pfoot').getByRole('button', { name: 'Reply', exact: true }).click();
  await pane.getByRole('textbox', { name: 'Reply to Claude Code' }).fill('Queue it. The handler should ack fast and let the queue own retries; cap it at 5 and dead-letter after.');
  await page.keyboard.press('ControlOrMeta+Enter');

  const line = pane.locator('[data-delivery]');
  await expect(line).toContainText(/Undelivered(?: \d+ min)? · Claude Code is working · it gets this when its turn ends/);
  const note = line.locator('[data-restart-note]');
  const lead = note.locator('[data-reload-lead="restart"]');
  await expect(lead.locator('code')).toHaveText('/reload-plugins');
  await expect(lead.locator('code')).toHaveCSS('white-space', 'nowrap');
  await expect(pane.locator('[data-send-now]')).toHaveCount(0);
  await lead.getByRole('button', { name: 'Copy /reload-plugins' }).click();
  await expect(lead.locator('[data-restart-live]')).toHaveText('/reload-plugins copied.');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('/reload-plugins');
  const toggle = note.locator('[data-restart-toggle]');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  const steps = line.locator('[data-restart-steps]');
  await expect(steps).toBeHidden();
  await page.waitForTimeout(2_100);
  await shot(page, '4-reply-line-desktop');

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(steps).toBeVisible();
  await expect(steps.locator('[data-restart-fallback] .ib-rw-cmd code')).toHaveText(`cd ~/code/billing-api && claude --resume ${BILLING_SESSION}`);
  await expect(steps).not.toContainText('/restart');
  await shot(page, '4-reply-line-open-desktop');

  await steps.getByRole('button', { name: 'Copy the command that restarts this Claude Code session' }).click();
  await expect(steps.locator('[data-restart-copy]')).toHaveText('Copied');
  await expect(steps.locator('[data-restart-live]')).toHaveText('Restart command copied.');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`cd ~/code/billing-api && claude --resume ${BILLING_SESSION}`);
});

test('the sidebar: "Reload Claude Code 6" opens Settings → Agents: the lead, six sessions as a list, Copy restart only behind the fold', async () => {
  const { page } = world;
  await page.goto(world.url);
  const row = page.locator('[data-restart-sidebar]');
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute('data-restart-sidebar', '6');
  await expect(row).toHaveAccessibleName(/^Reload Claude Code 6/);
  await row.click();
  await expect(page).toHaveURL(/#settings\/agents/);
  const sessions = page.locator('[data-agent-sessions="claude-code"]');
  await expect(sessions).toContainText('6 running · 6 on plugin 0.28.23');
  await expect(page.locator('[data-agent="claude-code"] .ib-agstate')).toHaveText('Connected · 6 need a reload');
  const lead = sessions.locator('[data-reload-lead="restart"]');
  await expect(lead.locator('code')).toHaveText('/reload-plugins');
  await lead.getByRole('button', { name: 'Copy /reload-plugins' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('/reload-plugins');
  await expect(sessions.locator('[data-session-row]')).toHaveCount(6);
  await expect(sessions.locator(`[data-session-row="${BILLING_SESSION}"]`)).toContainText('working');
  await expect(sessions.locator('[data-session-row] button')).toHaveCount(0);
  const restartButtons = sessions.getByRole('button', { name: /^Copy restart: / });
  await expect(restartButtons.first()).toBeHidden();
  await sessions.scrollIntoViewIfNeeded();
  await page.waitForTimeout(2_100);
  await shot(page, '1-agents-desktop');

  await sessions.getByRole('button', { name: 'Still listed after reloading?' }).click();
  await expect(restartButtons).toHaveCount(6);
  await expect(sessions.getByRole('button', { name: 'Copy restart: the command that restarts the billing-api session started 9:14 AM' })).toBeVisible();
  await sessions.getByRole('button', { name: 'Copy restart: the command that restarts the billing-api session started 9:14 AM' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`cd ~/code/billing-api && claude --resume ${BILLING_SESSION}`);
  await page.waitForTimeout(2_100);
  await sessions.locator('[data-restart-steps]').scrollIntoViewIfNeeded();
  await shot(page, '2-agents-open-desktop');
});

test('a phone at 390 px: the line, its fold, and Settings → Agents; nothing overflows', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'light' });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const page = await context.newPage();
  try {
    const threads = (await (await fetch(`${world.url}api/inbox/threads?archived=exclude`)).json()) as { sections: { threads: { thread_id: string; subject: string }[] }[] };
    const thread = threads.sections.flatMap((s) => s.threads).find((t) => t.subject === 'Retry policy for the Stripe webhook')!;
    await page.goto(`${world.url}#thread=${thread.thread_id}`);
    const note = page.locator('[data-restart-note]');
    await expect(note).toBeVisible();
    await note.scrollIntoViewIfNeeded();
    await noOverflow(page);
    await page.evaluate(() => navigator.clipboard.writeText(''));
    const copyBox = (await note.locator('[data-reload-lead] [data-restart-copy]').boundingBox())!;
    await page.touchscreen.tap(copyBox.x + copyBox.width / 2, copyBox.y + copyBox.height - 1);
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('/reload-plugins');
    await expect(note.locator('[data-restart-toggle]')).toHaveAttribute('aria-expanded', 'false');
    await page.waitForTimeout(2_100);
    await shot(page, '4-reply-line-phone');
    await note.getByRole('button', { name: 'Still no Send now after reloading?' }).click();
    await expect(page.locator('[data-restart-steps]')).toBeVisible();
    await page.locator('[data-restart-steps]').scrollIntoViewIfNeeded();
    await noOverflow(page);
    const target = await page.locator('[data-restart-copy]').first().evaluate((el) => {
      const after = getComputedStyle(el, '::after');
      return { height: el.getBoundingClientRect().height, top: parseFloat(after.top), bottom: parseFloat(after.bottom) };
    });
    expect(target.height - target.top - target.bottom).toBeGreaterThanOrEqual(44);
    await page.goto(`${world.url}#settings/agents`);
    const sessions = page.locator('[data-agent-sessions="claude-code"]');
    await expect(sessions.locator('[data-reload-lead="restart"]')).toBeVisible();
    await sessions.scrollIntoViewIfNeeded();
    await noOverflow(page);
    await shot(page, '1-agents-phone');
    await sessions.getByRole('button', { name: 'Still listed after reloading?' }).click();
    await sessions.locator('[data-restart-steps]').scrollIntoViewIfNeeded();
    await noOverflow(page);
    await shot(page, '2-agents-open-phone');
    await page.setViewportSize({ width: 320, height: 640 });
    await noOverflow(page);
  } finally {
    await context.close();
  }
});

test('the installed plugin behind this Inbox: the update command leads, then /reload-plugins', async () => {
  const version = spawnSync(binary, ['--version'], { env: { ...process.env, HOME: world.root }, encoding: 'utf8' }).stdout.trim().split(' ').pop() ?? '';
  test.skip(!/^\d+\.\d+\.\d+$/.test(version), `the binary is ${version || 'unknown'}, not a release`);
  const { page } = world;
  writePluginRegistry(world.root, world.pluginFolder('0.28.24'), '0.28.24');
  await page.goto(`${world.url}#settings/agents`);
  const sessions = page.locator('[data-agent-sessions="claude-code"]');
  const lead = sessions.locator('[data-reload-lead="update_plugin"]');
  await expect(lead).toBeVisible({ timeout: 20_000 });
  await expect(lead.locator('li').first().locator('.ib-rw-cmd code')).toContainText('claude plugin');
  await expect(lead.locator('li').nth(1).locator('code').first()).toHaveText('/reload-plugins');
  await lead.getByRole('button', { name: "Copy the command that updates Plannotator's Claude Code plugin" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('claude plugin');
  await sessions.scrollIntoViewIfNeeded();
  await page.waitForTimeout(2_100);
  await shot(page, '3-agents-update-desktop');
  const phone = await world.context.browser()!.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'light' });
  try {
    const p = await phone.newPage();
    await p.goto(`${world.url}#settings/agents`);
    const s = p.locator('[data-agent-sessions="claude-code"]');
    await expect(s.locator('[data-reload-lead="update_plugin"]')).toBeVisible();
    await s.scrollIntoViewIfNeeded();
    await noOverflow(p);
    await shot(p, '3-agents-update-phone');
  } finally {
    await phone.close();
  }
  writePluginRegistry(world.root, world.pluginFolder('0.28.25'), '0.28.25');
});

test('the row goes away by itself once the sessions run the installed plugin', async () => {
  const { page } = world;
  await page.goto(world.url);
  await expect(page.locator('[data-restart-sidebar]')).toBeVisible();
  for (const connection of world.connections) connection.plugin = CURRENT();
  await expect(page.locator('[data-restart-sidebar]')).toHaveCount(0, { timeout: 20_000 });
  expect(world.errors).toEqual([]);
});
