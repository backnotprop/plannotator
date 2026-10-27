/**
 * Pi, Oh My Pi and OpenCode 2 sessions that need a reload after an update
 * (owner approval "reload-hosts", 2026-10-26), proved in a real browser
 * against the compiled binary.
 *
 * Nothing is mocked: the binary runs `plannotator inbox --background` under a
 * temp PLANNOTATOR_DATA_DIR and HOME. Agents write through
 * `plannotator inbox mcp` with the wake meta; their connections are the
 * bridge's real poll, driven as the Pi extension and the OpenCode 2 plugin
 * drive it, saying what they loaded and what is on disk now
 * (`plugin: { version, on_disk, host? }`). The person replies in the window.
 * What is proved: under the reply, Pi's `/reload`, Oh My Pi's `/restart` and
 * OpenCode 2's `opencode2 reload` lead with a Copy for exactly that command
 * (never `/reload-plugins`); the sidebar's "Reload agents N"; Settings →
 * Agents' "Open sessions" leading with each runtime's command; a phone at
 * 390 px, where nothing overflows; and the row going away by itself once the
 * sessions reload onto the version on disk.
 *
 * PNGs (desktop and phone, light and dark) land in .local/proof/reload-hosts/,
 * or in PLANNOTATOR_RELOAD_SHOTS when it names a folder.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { INBOX_BRIDGE_POLL_PATH } from '../../packages/shared/inbox/connection';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = resolve(process.env.PLANNOTATOR_RELOAD_SHOTS ?? join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'reload-hosts'));

const PI_SESSION = '019a2f4c-7d1e-7b3a-9c55-2e8f0a6d4b17';
const OMP_SESSION = '019a2f4c-91b0-7e42-8a6d-5c3f1e7b9a02';
const OC_SESSION = 'ses_6f1a2b3c4d5eXk9Lm2Np4Qr7St';

type Plugin = { version: string; on_disk: string | null; host?: 'pi' | 'oh-my-pi' };

interface World {
  dataDir: string;
  env: Record<string, string>;
  url: string;
  code: string;
  pi: SimAgent;
  opencode: SimAgent;
  context: BrowserContext;
  page: Page;
  errors: string[];
  connections: Connection[];
  threads: Record<'pi' | 'omp' | 'opencode', string>;
}

let world: World;

function registry(): { port: number; token: string } {
  return JSON.parse(readFileSync(join(world.dataDir, 'inbox', 'inbox.json'), 'utf8'));
}

/** One session's connection, as the Pi extension or the OpenCode 2 plugin runs it. */
class Connection {
  private stopped = false;
  private loop: Promise<void>;
  constructor(
    readonly session: string,
    private readonly host: 'pi' | 'opencode',
    private readonly project: string,
    public busy: boolean,
    public plugin: Plugin,
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
          host: this.host,
          waitMs: 1_000,
          project_path: this.project,
          started_at: this.startedAt,
          busy: this.busy,
          idle_since: Date.now() - 60_000,
          plugin: this.plugin,
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
    for (const el of document.querySelectorAll<HTMLElement>('[data-restart-note], [data-restart-steps], .ib-rw-cmd, [data-restart-sidebar], [data-agent-sessions], [data-reload-sessions]')) {
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
  const root = inboxScratch('plannotator-inbox-reload-hosts-e2e-');
  const dataDir = join(root, 'data');
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
  const pi = await SimAgent.connect({ binary, env, name: 'Pi', host: 'pi' });
  const opencode = await SimAgent.connect({ binary, env, name: 'OpenCode', host: 'opencode' });
  world = { dataDir, env, url, code, pi, opencode, context, page, errors, connections: [], threads: { pi: '', omp: '', opencode: '' } };
});

test.afterAll(async () => {
  try {
    if (!world) return;
    await Promise.all(world.connections.map((c) => c.stop()));
    await world.pi.close().catch(() => {});
    await world.opencode.close().catch(() => {});
    await world.context.close();
  } finally {
    await removeInboxScratch();
  }
});

/** A plugin from before Send now, the newer one on disk since an update. */
const PI_STALE: Plugin = { version: '0.28.23', on_disk: '0.28.26', host: 'pi' };
const OMP_STALE: Plugin = { version: '0.28.23', on_disk: '0.28.26', host: 'oh-my-pi' };
/** OpenCode 2 after the install script deleted the plugin's generation folder. */
const OC_STALE: Plugin = { version: '0.28.23', on_disk: null };

async function ask(agent: SimAgent, session: string, project: string, subject: string, body: string): Promise<string> {
  const sent = await agent.send({ project_path: project, subject, body, agent_session: session } as Parameters<SimAgent['send']>[0], { wakes: true });
  return sent.thread_id;
}

async function reply(page: Page, thread: string, to: string, words: string): Promise<void> {
  await page.goto(`${world.url}#thread=${thread}`);
  const pane = page.locator('section.ib-pane');
  await pane.locator('.ib-pfoot').getByRole('button', { name: 'Reply', exact: true }).click();
  await pane.getByRole('textbox', { name: `Reply to ${to}` }).fill(words);
  await page.keyboard.press('ControlOrMeta+Enter');
}

test('under the reply: Pi leads with /reload, Oh My Pi with /restart, OpenCode 2 with opencode2 reload, each with its Copy', async () => {
  const { page } = world;
  const ledger = scratchProject(world.code, 'ledger-export');
  const web = scratchProject(world.code, 'web-app');
  const billing = scratchProject(world.code, 'billing-api');
  const started = Date.now() - 3 * 3600_000;
  world.threads.pi = await ask(world.pi, PI_SESSION, ledger, 'Ledger export: nightly or hourly?', 'The export job runs nightly now. Should it run hourly once the backfill lands?');
  world.threads.omp = await ask(world.pi, OMP_SESSION, web, 'Checkout drawer copy', 'Drawer copy is in. Keep "Pay now" or switch to "Place order"?');
  world.threads.opencode = await ask(world.opencode, OC_SESSION, billing, 'Stripe 409 retries', 'The webhook acks fast now. Cap retries at 5?');
  world.connections.push(new Connection(PI_SESSION, 'pi', ledger, true, PI_STALE, started));
  world.connections.push(new Connection(OMP_SESSION, 'pi', web, true, OMP_STALE, started));
  world.connections.push(new Connection(OC_SESSION, 'opencode', billing, true, OC_STALE, started));

  const cases = [
    { key: 'pi' as const, to: 'Pi', command: '/reload', runtime: 'pi', fold: true },
    { key: 'omp' as const, to: 'Pi', command: '/restart', runtime: 'oh-my-pi', fold: false },
    { key: 'opencode' as const, to: 'OpenCode', command: 'opencode2 reload', runtime: 'opencode', fold: true },
  ];
  for (const c of cases) {
    await reply(page, world.threads[c.key], c.to, 'Hourly, after the backfill. Keep the nightly run as a fallback for a week.');
    const note = page.locator(`[data-restart-note][data-restart-runtime="${c.runtime}"]`);
    await expect(note).toBeVisible({ timeout: 20_000 });
    const lead = note.locator('[data-reload-lead="restart"]');
    await expect(lead.locator('code')).toHaveText(c.command);
    await expect(note).not.toContainText('/reload-plugins');
    await lead.getByRole('button', { name: `Copy ${c.command}` }).click();
    await expect(lead.locator('[data-restart-live]')).toHaveText(`${c.command} copied.`);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(c.command);
    await expect(note.locator('[data-restart-toggle]')).toHaveCount(c.fold ? 1 : 0);
    await page.waitForTimeout(2_100);
    await shot(page, `1-reply-line-${c.runtime}-desktop`);
    if (c.fold) {
      await note.locator('[data-restart-toggle]').click();
      await expect(note.locator('[data-restart-steps]')).toBeVisible();
      if (c.runtime === 'opencode') await expect(note.locator('[data-restart-fallback] .ib-rw-cmd code')).toHaveText('opencode2 service restart');
      else await expect(note.locator('[data-restart-fallback]')).toContainText('pi --continue');
      await shot(page, `1-reply-line-${c.runtime}-open-desktop`);
    }
  }
});

test('the sidebar: "Reload agents 3" opens Settings → Agents, each runtime leading with its own command', async () => {
  const { page } = world;
  await page.goto(world.url);
  const row = page.locator('[data-restart-sidebar]');
  await expect(row).toHaveAttribute('data-restart-sidebar', '3', { timeout: 20_000 });
  await expect(row).toHaveAccessibleName(/^Reload agents 3/);
  await shot(page, '2-sidebar-desktop');
  await row.click();
  await expect(page).toHaveURL(/#settings\/agents/);
  const pi = page.locator('[data-agent-sessions="pi"]');
  await expect(pi.locator('[data-reload-sessions="pi"] [data-reload-lead="restart"] code')).toHaveText('/reload');
  await expect(pi.locator('[data-reload-sessions="oh-my-pi"] [data-reload-lead="restart"] code')).toHaveText('/restart');
  const oc = page.locator('[data-agent-sessions="opencode"]');
  await expect(oc.locator('[data-reload-sessions="opencode"] [data-reload-lead="restart"] code')).toHaveText('opencode2 reload');
  // One quiet line under each OpenCode command; nothing about quitting.
  await expect(oc.locator('[data-reload-sessions="opencode"] [data-opencode-quiet]')).toHaveCount(1);
  await expect(oc.locator('[data-opencode-quit-note]')).toHaveCount(0);
  await oc.locator('[data-reload-sessions="opencode"] [data-reload-lead="restart"]').getByRole('button', { name: 'Copy opencode2 reload' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('opencode2 reload');
  await expect(page.locator('body')).not.toContainText('/reload-plugins');
  await pi.scrollIntoViewIfNeeded();
  await page.waitForTimeout(2_100);
  await shot(page, '3-agents-pi-desktop');
  await oc.scrollIntoViewIfNeeded();
  await shot(page, '3-agents-opencode-desktop');
});

test('a phone at 390 px: the line under the reply and Settings → Agents; nothing overflows', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'light' });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const page = await context.newPage();
  try {
    await page.goto(`${world.url}#thread=${world.threads.opencode}`);
    const note = page.locator('[data-restart-note]');
    await expect(note).toBeVisible();
    await note.scrollIntoViewIfNeeded();
    await noOverflow(page);
    await shot(page, '4-reply-line-opencode-phone');
    await page.goto(`${world.url}#thread=${world.threads.pi}`);
    await expect(page.locator('[data-restart-note]')).toBeVisible();
    await page.locator('[data-restart-note]').scrollIntoViewIfNeeded();
    await noOverflow(page);
    await shot(page, '4-reply-line-pi-phone');
    await page.goto(`${world.url}#settings/agents`);
    const sessions = page.locator('[data-agent-sessions="pi"]');
    await expect(sessions.locator('[data-reload-sessions="pi"]')).toBeVisible();
    await sessions.scrollIntoViewIfNeeded();
    await noOverflow(page);
    await shot(page, '5-agents-pi-phone');
    await page.locator('[data-agent-sessions="opencode"]').scrollIntoViewIfNeeded();
    await noOverflow(page);
    await shot(page, '5-agents-opencode-phone');
    await page.setViewportSize({ width: 320, height: 640 });
    await noOverflow(page);
  } finally {
    await context.close();
  }
});

test('the row goes away by itself once the sessions reload onto the version on disk', async () => {
  const { page } = world;
  await page.goto(world.url);
  await expect(page.locator('[data-restart-sidebar]')).toBeVisible();
  for (const connection of world.connections) {
    connection.plugin = connection.plugin.host ? { version: '0.28.26', on_disk: '0.28.26', host: connection.plugin.host } : { version: '0.28.26', on_disk: '0.28.26' };
  }
  await expect(page.locator('[data-restart-sidebar]')).toHaveCount(0, { timeout: 20_000 });
  expect(world.errors).toEqual([]);
});
