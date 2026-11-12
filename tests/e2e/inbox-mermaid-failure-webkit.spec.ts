import { expect, test, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'mermaid-failure');

const fence = (lang: string, lines: string[]) => ['```' + lang, ...lines, '```'].join('\n');

const BROKEN = fence('mermaid', ['flowchart LR', '  A["Start<br/>here"] --> B{{"Check<br/>it"}', '  B --> C[("Store<br/>rows, cols")]']);
const SEQUENCE = fence('mermaid', ['sequenceDiagram', '  participant P as Person', '  participant Q as Queue', '  P->>Q: put (one, two)<br/>(NEW: three)', '  Note over Q: kept']);
const BODY = ['The intake as drawn today:', BROKEN, 'And the queue:', SEQUENCE, fence('diff', ['- old step', '+ new step']), 'Nothing needs you yet.'].join('\n\n');
const SEQUENCE_ONLY = ['Only the queue:', SEQUENCE, 'That is all.'].join('\n\n');

let root = '';
let url = '';
let claude: SimAgent;
let project = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  root = inboxScratch('plannotator-mermaid-failure-e2e-');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: join(root, 'data'), PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  url = started.stdout.trim();
  project = scratchProject(join(root, 'src'), 'intake');
  claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
});

test.afterAll(async () => {
  try {
    await claude?.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

const outside = (page: Page) =>
  page.evaluate(() => ({
    stray: Array.from(document.body.children)
      .filter((el) => /^[di]diagram-/.test(el.id) || /Syntax error in text/.test(el.textContent ?? ''))
      .map((el) => `${el.tagName.toLowerCase()}#${el.id}`),
    overflows: document.documentElement.scrollHeight > window.innerHeight + 1,
  }));

const openOnIpad = async (browser: import('@playwright/test').Browser) => {
  const context = await browser.newContext({ viewport: { width: 820, height: 1180 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  return { context, page: await context.newPage() };
};

test('a diagram that does not parse shows its source in the message, and nothing lands outside it, through re-renders', async ({ browser }) => {
  const sent = await claude.send({ project_path: project, subject: 'Intake', thread: 'intake', body: BODY });
  const { context, page } = await openOnIpad(browser);
  try {
    await page.goto(`${url}#thread=${sent.thread_id}`);
    const message = page.locator(`[data-message-id="${sent.message_id}"]`);
    const blocks = message.locator('[data-diagram-block="mermaid"]');
    await expect(blocks).toHaveCount(2);
    await expect(blocks.nth(1).locator('[data-diagram-svg] svg')).toBeVisible();
    await expect(blocks.nth(0)).toContainText('Mermaid Error');
    await expect(blocks.nth(0)).toContainText('B{{"Check<br/>it"}');
    expect(await outside(page)).toEqual({ stray: [], overflows: false });

    const toggle = page.locator('[data-theme-toggle]').first();
    for (let i = 0; i < 2; i++) {
      await toggle.click();
      await page.waitForTimeout(1_000);
    }
    await expect(blocks.nth(1).locator('[data-diagram-svg] svg')).toBeVisible();
    expect(await outside(page)).toEqual({ stray: [], overflows: false });
    await blocks.nth(0).scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(proofDir, '01-ipad-parse-error.png') });
  } finally {
    await context.close();
  }
});

test('a diagram chunk whose download breaks off once draws on the automatic re-attempt, with no reload', async ({ browser }) => {
  const sent = await claude.send({ project_path: project, subject: 'Flaky', thread: 'flaky', body: SEQUENCE_ONLY });
  const { context, page } = await openOnIpad(browser);
  try {
    let tries = 0;
    await page.route(/\/assets\/sequenceDiagram-[^/]+\.js$/, (route) => (++tries === 1 ? route.abort('connectionreset') : route.continue()));
    await page.goto(`${url}#thread=${sent.thread_id}`);
    const block = page.locator(`[data-message-id="${sent.message_id}"] [data-diagram-block="mermaid"]`);
    await expect(block.locator('[data-diagram-svg] svg')).toBeVisible();
    expect(tries).toBe(2);
    expect(await outside(page)).toEqual({ stray: [], overflows: false });
  } finally {
    await context.close();
  }
});

test('a diagram type whose chunk does not arrive shows the source under Reload, and nothing lands outside the message', async ({ browser }) => {
  const sent = await claude.send({ project_path: project, subject: 'Queue', thread: 'queue', body: SEQUENCE_ONLY });
  const { context, page } = await openOnIpad(browser);
  try {
    await page.route(/\/assets\/sequenceDiagram-[^/]+\.js$/, (route) => route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not found' }));
    await page.goto(`${url}#thread=${sent.thread_id}`);
    const block = page.locator(`[data-message-id="${sent.message_id}"] [data-diagram-block="mermaid"]`);
    await expect(block.locator('[data-lazy-load-failed]')).toBeVisible();
    await expect(block.getByRole('button', { name: 'Reload' })).toBeVisible();
    await expect(block).toContainText('participant P as Person');
    await expect(block).not.toContainText('Mermaid Error');
    expect(await outside(page)).toEqual({ stray: [], overflows: false });
    await page.screenshot({ path: join(proofDir, '02-ipad-chunk-missing.png') });
  } finally {
    await context.close();
  }
});
