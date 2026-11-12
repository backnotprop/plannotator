import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));

let url: string;
let threadId: string;
let agent: SimAgent;
let context: BrowserContext;
let page: Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-inbox-root-scroll-');
  const home = join(root, 'home');
  const dataDir = join(root, 'data');
  mkdirSync(home);
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_INBOX_NOTES: '0',
    PLANNOTATOR_TEST_SANDBOX: '1',
    NO_ANON_PING: '1',
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    CODEX_HOME: join(root, 'codex'),
    XDG_CONFIG_HOME: join(root, 'xdg'),
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  url = started.stdout.trim();
  const project = scratchProject(join(root, 'src'), 'notes');
  writeFileSync(join(project, 'release-notes.md'), '# Release notes\n\nA line.\n');
  agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const sent = await agent.send({ project_path: project, subject: 'Release notes', body: 'The notes.', attachments: ['release-notes.md'] });
  threadId = sent.thread_id as string;
  context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.route((target) => !['127.0.0.1', 'localhost'].includes(target.hostname), (route) => route.abort());
  page = await context.newPage();
});

test.afterAll(async () => {
  try {
    await context?.close();
    await agent?.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

const overflow = (on: Page) =>
  on.evaluate(() =>
    [document.documentElement, document.body, document.querySelector('#root')!, document.querySelector('.pn-inbox')!]
      .map((el) => el.scrollHeight - el.clientHeight)
      .filter((extra) => extra !== 0),
  );

test('the window has nothing to scroll, wide and at a phone width', async () => {
  for (const hash of ['', `#thread=${threadId}`, '#settings']) {
    await page.goto('about:blank');
    await page.goto(`${url}${hash}`);
    await page.locator('.pn-inbox .ib-shell').waitFor();
    await page.waitForTimeout(400);
    expect(await overflow(page), `wide ${hash}`).toEqual([]);
  }
  const phone = await context.browser()!.newContext({ viewport: { width: 390, height: 844 } });
  const small = await phone.newPage();
  await small.route((target) => !['127.0.0.1', 'localhost'].includes(target.hostname), (route) => route.abort());
  await small.goto(url);
  await small.locator('.pn-inbox .ib-lhead').waitFor();
  await small.waitForTimeout(400);
  expect(await overflow(small), 'phone').toEqual([]);
  await phone.close();
});

test('the live region still sits on the page, and still speaks', async () => {
  await page.goto(url);
  const live = page.locator('[data-inbox-live]');
  await expect(live).toHaveAttribute('aria-live', 'polite');
  const box = await live.evaluate((el) => {
    const { top, bottom } = el.getBoundingClientRect();
    return { top, bottom, clip: getComputedStyle(el).clip };
  });
  expect(box.bottom).toBeLessThanOrEqual(800);
  expect(box.top).toBeGreaterThanOrEqual(0);
  expect(box.clip).toBe('rect(0px, 0px, 0px, 0px)');
});

test('a click on a file while the panes still move after Escape leaves every pane where it was', async () => {
  await page.goto('about:blank');
  await page.goto(`${url}#thread=${threadId}`);
  const file = page.locator('section.ib-pane [data-attachment-name="release-notes.md"]').first();
  await file.waitFor();
  await page.waitForTimeout(600);
  const paneTop = () => page.locator('.ib-main').evaluate((el) => el.getBoundingClientRect().top);
  expect(await paneTop()).toBe(0);
  for (let round = 0; round < 3; round++) {
    await file.click();
    await page.locator('.ib-view').first().waitFor();
    await page.waitForTimeout(500);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    await file.click();
    await page.waitForTimeout(500);
    expect(await paneTop(), `round ${round + 1}`).toBe(0);
    expect(await page.locator('#root').evaluate((el) => el.scrollTop), `round ${round + 1}`).toBe(0);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);
  }
});
