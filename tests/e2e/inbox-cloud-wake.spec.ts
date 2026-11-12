import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shotsDir = process.env.CLOUD_WAKE_SHOTS_DIR ? resolve(process.env.CLOUD_WAKE_SHOTS_DIR) : null;
const KEY = 'sk-ant-oat01-e2e-key-0123456789';
const RUN_URL = 'https://claude.ai/code/session_01E2E';

interface Seen {
  authorization: string | undefined;
  body: { text?: string };
}

let url = '';
let agent: SimAgent | null = null;
let hook: Server | null = null;
let hookUrl = '';
let relay: Server | null = null;
const seen: Seen[] = [];

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  if (shotsDir) mkdirSync(shotsDir, { recursive: true });
  hook = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      seen.push({ authorization: req.headers.authorization, body: JSON.parse(raw || '{}') });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'routine_fire', claude_code_session_id: 'session_01E2E', claude_code_session_url: RUN_URL }));
    });
  });
  await new Promise<void>((done) => hook!.listen(0, '127.0.0.1', done));
  const address = hook.address();
  hookUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/v1/claude_code/routines/trig_e2e/fire`;

  const root = inboxScratch('plannotator-cloud-wake-e2e-');
  const dataDir = join(root, 'data');
  relay = createServer((_req, res) => {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found', code: 'not_found' }));
  });
  await new Promise<void>((done) => relay!.listen(0, '127.0.0.1', done));
  const relayAddress = relay.address();
  const relayUrl = `http://127.0.0.1:${typeof relayAddress === 'object' && relayAddress ? relayAddress.port : 0}`;
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_RELAY_URL: relayUrl };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  url = started.stdout.trim();
  agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  await agent.send({ project_path: scratchProject(join(root, 'src'), 'billing'), subject: 'Run finished', body: 'The export streams rows now.' });
});

test.afterAll(async () => {
  try {
    await agent?.close().catch(() => {});
    await new Promise((done) => (hook ? hook.close(done) : done(undefined)));
    await new Promise((done) => (relay ? relay.close(done) : done(undefined)));
  } finally {
    await removeInboxScratch();
  }
});

test('pair a routine, send a test, write to it from New message: the thread says it woke, with the run link', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(`${url}#settings/agents`);
  const section = page.locator('[data-settings-cloud]');
  await section.locator('[data-cloud-pair-start]').click();
  const form = section.locator('[data-cloud-pair-form]');
  await form.locator('[data-cloud-name]').fill('Nightly fixer');
  if (shotsDir) await page.screenshot({ path: join(shotsDir, 'e2e-01-pair-form.png') });
  await form.locator('[data-cloud-pair-submit]').click();

  const paired = section.locator('[data-cloud-agent]');
  await expect(paired.locator('[data-cloud-setup="no-relay"]')).toBeVisible();
  await paired.locator('[data-cloud-done]').click();
  await expect(paired.locator('[data-cloud-status]')).toHaveAttribute('data-cloud-status', 'no_relay');
  await paired.locator('[data-cloud-wake-open]').click();
  await paired.locator('[data-cloud-url]').fill(hookUrl);
  await paired.locator('[data-cloud-key]').fill(KEY);
  await paired.locator('[data-cloud-wake-save]').click();
  await paired.locator('[data-cloud-test]').click();
  const result = paired.locator('[data-cloud-test-result]');
  await expect(result).toHaveAttribute('data-cloud-test-result', 'started');
  await expect(result).toContainText('A run started.');
  await expect(result.getByRole('link', { name: 'Open the run' })).toHaveAttribute('href', RUN_URL);
  expect(seen).toHaveLength(1);
  expect(seen[0]!.authorization).toBe(`Bearer ${KEY}`);
  if (shotsDir) await page.screenshot({ path: join(shotsDir, 'e2e-02-paired.png') });
  expect(await page.content()).not.toContain(KEY);
  await expect(section.locator('[data-cloud-agent]')).toContainText('Nightly fixer');

  await page.goto(url);
  await page.locator('.ib-side [data-open-compose]').first().click();
  const dialog = page.locator('dialog[data-compose]');
  const to = dialog.locator('.ib-cp-tobtn');
  await expect(to).not.toHaveAttribute('data-loading', /.*/, { timeout: 20_000 });
  await to.click();
  const option = dialog.locator('[data-compose-session^="cloud."]');
  await expect(option).toContainText('Nightly fixer');
  await option.click();
  await dialog.getByRole('textbox', { name: 'Message' }).fill('Fix the flaky login test, please.');
  await dialog.locator('[data-compose-send]').click();
  await expect(dialog).toHaveCount(0);
  await page.locator('[data-inbox-toast] [data-toast-action]').click();

  const line = page.locator('section.ib-pane [data-cloud-wake]');
  await expect(line).toHaveAttribute('data-cloud-wake', 'started', { timeout: 15_000 });
  await expect(line).toContainText('Woke Nightly fixer · run started');
  await expect(line.getByRole('link', { name: 'Open the run' })).toHaveAttribute('href', RUN_URL);
  expect(seen).toHaveLength(2);
  expect(seen[1]!.body.text).toContain('Fix the flaky login test, please.');
  if (shotsDir) await page.screenshot({ path: join(shotsDir, 'e2e-03-woke.png') });
});
