/**
 * A Mermaid diagram that fails in an Inbox message stays inside its message,
 * proved in WebKit (Safari, every iPad browser) on the compiled binary with
 * the real Mermaid. What regresses:
 *
 *  - Mermaid's own "Syntax error in text" graphic is left on `document.body`
 *    after a failed render: it shows at the bottom of the window, under the
 *    app, and one more piles up on every re-render (a theme change);
 *  - a diagram type whose chunk does not arrive (a dropped request, or a tab
 *    older than the Inbox's build, whose chunk names are gone) shows as a red
 *    "Mermaid Error" that blames the source, where it should show the source
 *    under the quiet Reload line; and leaves the same graphic on the body.
 *
 * The other diagram and the fences around it still render. Made-up diagrams.
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-mermaid-failure-webkit.spec.ts`.
 * PNGs land in <PLANNOTATOR_E2E_PROOF_DIR or .local/proof>/mermaid-failure/.
 */

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

/** The first diagram does not parse (the hexagon is never closed); the second is fine. */
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

/** What sits on the body besides the app's own root, and whether the window scrolls past the app. */
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

    // A theme change re-renders every diagram: still nothing outside the message.
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

/**
 * A flaky link (plane WiFi) breaks one download off. With a modulepreload link
 * in front of the import, WebKit kept that failure for the tab: the re-attempt,
 * Retry and even a reload of the tab failed with no request, and only a new tab
 * drew the diagram. What regresses: the Inbox build preloads its lazy chunks
 * again (`modulePreload` in apps/inbox/vite.config.ts).
 */
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
    // As a tab older than the Inbox's build asks for a chunk name that is gone.
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
