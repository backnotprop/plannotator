import { devices, expect, test, type Browser, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, rememberInboxOf, removeInboxScratch, scratchEnv } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));

type Send = Parameters<SimAgent['send']>[0];
let world: { url: string; agent: SimAgent; project: string };
let sent = 0;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-inbox-newline-e2e-');
  const stubs = join(root, 'bin');
  mkdirSync(stubs, { recursive: true });
  for (const name of ['claude', 'codex', 'opencode', 'pi', 'gemini', 'cursor-agent', 'amp']) writeFileSync(join(stubs, name), '#!/bin/sh\necho "this stub never runs" >&2\nexit 1\n', { mode: 0o755 });
  const scratch = scratchEnv(root, { home: root });
  const env = {
    ...scratch,
    PATH: `${stubs}:${process.env.PATH ?? ''}`,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_TEST_SANDBOX: root,
    CLAUDE_CONFIG_DIR: join(root, 'claude-config'),
  };
  const project = scratchProject(join(root, 'src'), 'billing-svc');
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(scratch.PLANNOTATOR_DATA_DIR);
  const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  for (let n = 0; n < 6; n++) await agent.send({ project_path: project, subject: `Question ${n}`, body: ':::question\nShip it?\n- Yes\n- No\n:::', agent_session: `ses_q_${n}` } as Send);
  world = { url: started.stdout.trim().replace(/\/$/, ''), agent, project };
});

test.afterAll(async () => {
  try {
    await world?.agent.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

async function agentWrites(): Promise<void> {
  sent += 1;
  await world.agent.send({ project_path: world.project, subject: `Fresh update ${sent}`, body: 'Finished. Nothing to answer.', agent_session: `ses_fresh_${sent}` } as Send);
}

function watchArrival(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as { __arrival: { slid: number; down: boolean; line: string } | null };
    w.__arrival = null;
    const watch = new MutationObserver(() => {
      const line = document.querySelector('[data-inbox-notice]');
      if (!line) return;
      watch.disconnect();
      const slides = document.getAnimations().filter((animation) => animation.id === 'ib-settle');
      const down = slides.some((animation) => {
        const first = (animation.effect as KeyframeEffect).getKeyframes()[0]?.transform;
        return typeof first === 'string' && /translate\([^,]+, -\d/.test(first);
      });
      w.__arrival = { slid: slides.length, down, line: getComputedStyle(line).animationName };
    });
    watch.observe(document.body, { childList: true, subtree: true });
  });
}

const arrival = (page: Page) => page.evaluate(() => (window as unknown as { __arrival: { slid: number; down: boolean; line: string } | null }).__arrival);

for (const shape of [
  { name: '1280 px', options: { viewport: { width: 1280, height: 800 } } },
  { name: '390 px phone', options: { ...devices['iPhone 15'], viewport: { width: 390, height: 844 } } },
]) {
  test(`the "N new" line arrives: the rows slide down from where they were and the line fades in (${shape.name})`, async ({ browser }: { browser: Browser }) => {
    const context = await browser.newContext({ ...shape.options, colorScheme: 'light', reducedMotion: 'no-preference' });
    await context.grantPermissions(['notifications'], { origin: new URL(world.url).origin });
    try {
      const page = await context.newPage();
      await page.goto(world.url);
      await expect(page.locator('.ib-listcol .ib-lbody [data-thread-id]').first()).toBeVisible();
      await watchArrival(page);
      await agentWrites();
      await expect(page.locator('[data-inbox-notice]')).toBeVisible();
      const got = await arrival(page);
      expect(got?.slid).toBeGreaterThan(0);
      expect(got?.down).toBe(true);
      expect(got?.line).toBe('ib-notice-in');
    } finally {
      await context.close();
    }
  });
}

test('Settings → Motion → Reduced: the line fades in place and no row slides', async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'light', reducedMotion: 'no-preference' });
  await context.grantPermissions(['notifications'], { origin: new URL(world.url).origin });
  try {
    const page = await context.newPage();
    await page.goto(`${world.url}/#settings`);
    await page.locator('[data-settings-motion]').getByText('Reduced', { exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduced');
    await page.goto(world.url);
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduced');
    await expect(page.locator('.ib-listcol .ib-lbody [data-thread-id]').first()).toBeVisible();
    await page.evaluate(() => {
      const w = window as unknown as { __slid: number };
      w.__slid = 0;
      const watch = new MutationObserver(() => {
        if (!document.querySelector('[data-inbox-notice]')) return;
        watch.disconnect();
        w.__slid = document.getAnimations().filter((animation) => animation.id === 'ib-settle').length;
      });
      watch.observe(document.body, { childList: true, subtree: true });
    });
    await agentWrites();
    const line = page.locator('[data-inbox-notice]');
    await expect(line).toBeVisible();
    expect(await line.evaluate((el) => getComputedStyle(el).animationName)).toBe('ib-notice-fade');
    expect(await page.evaluate(() => (window as unknown as { __slid: number }).__slid)).toBe(0);
  } finally {
    await context.close();
  }
});
