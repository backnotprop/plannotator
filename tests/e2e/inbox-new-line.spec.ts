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

async function restOnThirdRow(page: Page): Promise<{ x: number; y: number; id: string }> {
  const row = page.locator('.ib-listcol .ib-lbody [data-thread-id]').nth(2);
  await expect(row).toBeVisible();
  const box = (await row.boundingBox())!;
  const x = box.x + box.width * 0.5;
  const y = box.y + box.height * 0.25;
  await page.mouse.move(x, y);
  return { x, y, id: (await row.getAttribute('data-thread-id'))! };
}

function watchUnderPointer(page: Page, at: { x: number; y: number }) {
  return page.evaluate(
    ({ x, y }) =>
      new Promise<(string | null)[]>((done) => {
        const under = () => document.elementFromPoint(x, y)?.closest('[data-thread-id]')?.getAttribute('data-thread-id') ?? null;
        const seen: (string | null)[] = [];
        const watch = new MutationObserver(() => {
          if (!document.querySelector('[data-inbox-notice]')) return;
          watch.disconnect();
          const sample = () => {
            seen.push(under());
            if (seen.length < 12) requestAnimationFrame(sample);
            else setTimeout(() => done([...seen, under()]), 300);
          };
          sample();
        });
        watch.observe(document.body, { childList: true, subtree: true });
      }),
    at,
  );
}

for (const shape of [
  { name: '1280 px', options: { viewport: { width: 1280, height: 800 } } },
  { name: '390 px phone', options: { ...devices['iPhone 15'], viewport: { width: 390, height: 844 } } },
]) {
  test(`the "N new" line arrives over the list: the row under the pointer stays the same thread (${shape.name})`, async ({ browser }: { browser: Browser }) => {
    const context = await browser.newContext({ ...shape.options, colorScheme: 'light' });
    await context.grantPermissions(['notifications'], { origin: new URL(world.url).origin });
    try {
      const page = await context.newPage();
      await page.goto(world.url);
      const pointer = await restOnThirdRow(page);
      const seen = watchUnderPointer(page, pointer);
      await agentWrites();
      await expect(page.locator('[data-inbox-notice]')).toBeVisible();
      const got = await seen;
      expect(got).toEqual(new Array(13).fill(pointer.id));
      await page.mouse.click(pointer.x, pointer.y);
      await expect(page).toHaveURL(new RegExp(pointer.id));
    } finally {
      await context.close();
    }
  });
}

test('Settings → Motion → Reduced: the line fades in place and no row slides, in the slide variant too', async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'light', reducedMotion: 'no-preference' });
  await context.grantPermissions(['notifications'], { origin: new URL(world.url).origin });
  try {
    const page = await context.newPage();
    await page.goto(`${world.url}/?newline=slide#settings`);
    await page.locator('[data-settings-motion]').getByText('Reduced', { exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduced');
    await page.goto(`${world.url}/?newline=slide`);
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
