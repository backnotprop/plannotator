import { expect, test, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join, resolve } from 'node:path';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const PANELS = ['elsewhere', 'pairing', 'relay', 'limits', 'replies'];

let url = '';
let relay: Server | null = null;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  relay = createServer((_req, res) => {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found', code: 'not_found' }));
  });
  await new Promise<void>((done) => relay!.listen(0, '127.0.0.1', done));
  const address = relay.address();
  const relayUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  const root = inboxScratch('plannotator-cloud-how-e2e-');
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    PLANNOTATOR_DATA_DIR: join(root, 'data'),
    PLANNOTATOR_BROWSER: NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_RELAY_URL: relayUrl,
  };
  const started = spawnSync(binary, ['inbox', '--background'], {
    env,
    encoding: 'utf8',
    timeout: 60_000,
  });
  expect(started.status, started.stderr).toBe(0);
  url = started.stdout.trim();
});

test.afterAll(async () => {
  try {
    await new Promise((done) => (relay ? relay.close(done) : done(undefined)));
  } finally {
    await removeInboxScratch();
  }
});

async function stepThrough(page: Page) {
  await page.goto(`${url}#settings/cloud-agents`);
  const open = page.locator('[data-cloud-how]');
  await open.click();
  const dialog = page.locator('dialog[data-dialog="cloud-how"]');
  await expect(dialog).toBeVisible();
  for (let i = 0; i < PANELS.length; i++) {
    await expect(dialog.locator(`[data-cloud-how-panel="${PANELS[i]}"]`)).toBeVisible();
    await expect(dialog.locator('[data-cloud-how-step]')).toHaveText(`${i + 1} of ${PANELS.length}`);
    if (i < PANELS.length - 1) await dialog.locator('[data-cloud-how-next]').click();
  }
  await expect(dialog.locator('[data-cloud-how-end]')).toBeVisible();
  await expect(dialog.locator('[data-cloud-how-next]')).toHaveText('Done');
  await dialog.locator('[data-cloud-how-back]').click();
  await expect(dialog.locator('[data-cloud-how-panel="limits"]')).toBeVisible();
  return { open, dialog };
}

test('desktop: How does this work? opens the walk-through, steps through it, and Escape, outside click and Done close it', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  const { open, dialog } = await stepThrough(page);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(open).toBeFocused();

  await open.click();
  await expect(dialog).toBeVisible();
  await page.mouse.click(8, 8);
  await expect(dialog).toHaveCount(0);

  await open.click();
  for (let i = 1; i < PANELS.length; i++) await dialog.locator('[data-cloud-how-next]').click();
  await dialog.locator('[data-cloud-how-next]').click();
  await expect(dialog).toHaveCount(0);
});

test('phone: the walk-through is a sheet that fits the screen and closes with its Close button', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  try {
    const { dialog } = await stepThrough(page);
    const box = await dialog.boundingBox();
    expect(box && box.width).toBe(390);
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toHaveCount(0);
  } finally {
    await context.close();
  }
});
