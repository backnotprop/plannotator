import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FakeOpenClaw } from '../../apps/openclaw-plugin/fixtures/fake-openclaw';
import { registerPlannotator } from '../../apps/openclaw-plugin/plugin';
import type { OpenClawToolContext } from '../../apps/openclaw-plugin/openclaw';
import { scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shots = process.env.PLANNOTATOR_OPENCLAW_SHOTS ? resolve(process.env.PLANNOTATOR_OPENCLAW_SHOTS) : null;
const DM = 'agent:main:telegram:direct:4242';

interface World {
  dataDir: string;
  url: string;
  workspace: string;
  host: FakeOpenClaw;
  context: BrowserContext;
  page: Page;
  asked: { thread_id: string; message_id: string };
}

let world: World;

async function send(host: FakeOpenClaw, ctx: OpenClawToolContext, subject: string, body: string) {
  const tool = host.toolsFor(ctx).find((t) => t.name === 'plannotator_inbox');
  expect(tool, `plannotator_inbox offered to ${ctx.sessionKey}`).toBeTruthy();
  const result = await tool!.execute('call', { action: 'send_message', subject, body });
  const text = result.content[0]!.text;
  return { thread_id: /"thread_id":"([^"]+)"/.exec(text)![1]!, message_id: /"message_id":"([^"]+)"/.exec(text)![1]! };
}

async function shoot(page: Page, name: string): Promise<void> {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(350);
    await page.screenshot({ path: join(shots, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-inbox-openclaw-e2e-');
  const dataDir = join(root, 'data');
  const plugin = join(root, '.openclaw', 'npm', 'projects', 'plannotator-openclaw', 'node_modules', '@plannotator', 'openclaw');
  mkdirSync(plugin, { recursive: true });
  writeFileSync(join(plugin, 'package.json'), JSON.stringify({ name: '@plannotator/openclaw', version: '0.28.61' }));
  const config = join(dataDir, 'config.json');
  writeFileSync(config, JSON.stringify({ ...JSON.parse(readFileSync(config, 'utf8')), inboxTool: { openclaw: true } }));
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
  markTourDecided(dataDir);
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  const workspace = scratchProject(join(root, 'src'), 'release-notes');
  const host = new FakeOpenClaw();
  registerPlannotator(host, { env: { PLANNOTATOR_INBOX_TOOL: '1' }, dataDir, tickMs: 200 });
  await host.startServices();
  const asked = await send(
    host,
    { agentId: 'main', sessionKey: DM, senderIsOwner: true, workspaceDir: workspace, deliveryContext: { channel: 'telegram', to: '4242' } },
    'Ship the release notes',
    'The release notes for 0.29 are drafted. Ship them today, or hold for the changelog fix?',
  );
  await send(host, { agentId: 'main', sessionKey: 'agent:main:main', senderIsOwner: true, workspaceDir: workspace }, 'Nightly backup', 'The nightly backup moved to 02:00. Nothing to do unless you want a different hour.');
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: 'light' });
  world = { dataDir, url: started.stdout.trim(), workspace, host, context, page: await context.newPage(), asked };
});

test.afterAll(async () => {
  try {
    if (!world) return;
    await world.host.stopServices();
    await world.context.close();
  } finally {
    await removeInboxScratch();
  }
});

test('a reply typed in the Inbox goes into the OpenClaw chat that asked, once, and the thread says it was delivered', async () => {
  const { page, host, asked } = world;
  await page.goto(world.url);
  const row = page.locator('[data-thread-id]').filter({ hasText: 'Ship the release notes' }).first();
  await expect(row).toBeVisible();
  await shoot(page, '01-rows-1280');

  await page.goto(`${world.url}#thread=${asked.thread_id}`);
  const pane = page.locator('section.ib-pane');
  await pane.locator('.ib-pfoot').getByRole('button', { name: 'Reply', exact: true }).click();
  await pane.getByRole('textbox', { name: 'Reply to OpenClaw' }).fill('Ship them today. The changelog fix can follow in a patch.');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect.poll(() => host.turns.length, { timeout: 20_000 }).toBe(1);
  expect(host.turns[0]).toMatchObject({ agentId: 'main', sessionKey: DM, route: { channel: 'telegram', to: '4242' } });
  expect(host.turns[0]!.text).toContain('Ship them today.');
  await expect(pane.locator('.ib-delivered[data-delivery="delivered"]').last()).toContainText('Delivered to OpenClaw', { timeout: 20_000 });
  await shoot(page, '02-thread-delivered-1280');
  await page.waitForTimeout(1_500);
  expect(host.turns).toHaveLength(1);

  await page.goto(`${world.url}#settings/agents`);
  const agentRow = page.locator('[data-agent="openclaw"]');
  await expect(agentRow).toContainText('plannotator_inbox');
  await agentRow.scrollIntoViewIfNeeded();
  await shoot(page, '03-settings-agents-1280');
});

test('the same screens on a phone', async ({ browser }: { browser: Browser }) => {
  test.skip(!shots, 'pictures only: PLANNOTATOR_OPENCLAW_SHOTS');
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: 'light' });
  try {
    const page = await phone.newPage();
    await page.goto(world.url);
    await page.getByRole('button', { name: /^Quiet/ }).click();
    await expect(page.locator('[data-thread-id]').filter({ hasText: 'Ship the release notes' }).first()).toBeVisible();
    await shoot(page, '04-rows-390');
    await page.goto(`${world.url}#thread=${world.asked.thread_id}`);
    await expect(page.locator('.ib-delivered[data-delivery="delivered"]').last()).toContainText('Delivered to OpenClaw');
    await shoot(page, '05-thread-delivered-390');
    await page.goto(`${world.url}#settings/agents`);
    const agentRow = page.locator('[data-agent="openclaw"]');
    await expect(agentRow).toContainText('plannotator_inbox');
    await agentRow.scrollIntoViewIfNeeded();
    await shoot(page, '06-settings-agents-390');
  } finally {
    await phone.close();
  }
});
