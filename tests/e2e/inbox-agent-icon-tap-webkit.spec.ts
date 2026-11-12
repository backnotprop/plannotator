import { expect, test, type Locator } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { E2E_LAUNCH_OFF, inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(resolve(__dirname, '../..'), '.local/plannotator'));
let url = '';
let agent: SimAgent | null = null;

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('inbox-agent-icon-tap-webkit-');
  const data = join(root, 'data');
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, 'config.json'), JSON.stringify(E2E_LAUNCH_OFF));
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: data, PLANNOTATOR_TEST_SANDBOX: root, PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_INBOX_TAILSCALE: '0', PLANNOTATOR_INBOX_PHONES: '0', PLANNOTATOR_INBOX_NOTES: '0', PLANNOTATOR_UPDATE_CHECK: '0', PLANNOTATOR_ICON_SETS_URL: 'off' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(data);
  url = started.stdout.trim();
  agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  await agent.send({ project_path: scratchProject(join(root, 'src'), 'fox-site'), subject: 'Landing page hero', body: ['The hero is in.', '', ':::question', 'Ship it?', '', '- [ ] Yes', '- [ ] No', ':::'].join('\n') });
});
test.afterAll(async () => {
  try {
    await agent?.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

test.use({ hasTouch: true, deviceScaleFactor: 2, viewport: { width: 810, height: 1080 } });

async function longPress(target: Locator): Promise<void> {
  const box = (await target.boundingBox())!;
  const at = { pointerType: 'touch', pointerId: 7, isPrimary: true, bubbles: true, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 };
  await target.dispatchEvent('pointerdown', at);
  await target.page().waitForTimeout(650);
  await target.dispatchEvent('pointerup', at);
}

test('a tap on the face picker’s "Sets" opens the icon dialog, and a tap on an icon applies it', async ({ page }) => {
  test.setTimeout(120_000);
  await page.route('**/api/inbox/**', async (route) => {
    await new Promise((done) => setTimeout(done, 400));
    await route.continue().catch(() => {});
  });
  await page.goto(url);
  await expect(page.getByText('Landing page hero').first()).toBeVisible({ timeout: 60_000 });
  const agents = page.getByRole('button', { name: 'Agents', exact: true });
  if ((await agents.getAttribute('aria-expanded')) === 'false') await agents.tap();
  const mark = page.locator('.ib-sbagent [data-agent-icon]').first();
  await expect(mark).toBeVisible({ timeout: 30_000 });

  await longPress(mark);
  const sets = page.locator('.am-fan[data-open] [data-face-choice="sets"]');
  await expect(sets).toBeVisible();
  await sets.tap();
  const dialog = page.locator('dialog[data-dialog="agent-icon"][open]');
  await expect(dialog).toBeVisible();

  const icon = dialog.locator('.am-sets-i:not(:disabled)').first();
  await expect(icon).toBeVisible({ timeout: 30_000 });
  await icon.tap();
  await expect(dialog).toHaveCount(0);
  await expect(mark.locator('[data-agent-mark]')).toHaveAttribute('data-face', /^set:/, { timeout: 30_000 });
});
