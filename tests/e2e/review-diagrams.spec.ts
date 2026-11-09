/**
 * Code review draws Mermaid and Graphviz fences in a Markdown file's Read and
 * Changes views with the diagram engine the review server serves on demand
 * (owner approval "review-diagrams-on-demand", issue #2096), proved in a real
 * Chromium against the compiled binary: the review page carries no diagram
 * runtime, imports the engine by URL only when a preview holds a diagram
 * fence, and a review without one (or the Source view) never requests it.
 *
 * Each `plannotator review` runs in a scratch git repository under a temp
 * PLANNOTATOR_DATA_DIR and HOME and is closed with /api/exit.
 *
 * Screenshots go to PLANNOTATOR_REVIEW_DIAGRAMS_SHOTS when it is set.
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 */

import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shots = process.env.PLANNOTATOR_REVIEW_DIAGRAMS_SHOTS ?? '';

const ARCHITECTURE = `# Architecture

How the pieces fit together.

\`\`\`mermaid
flowchart LR
  A[Agent] --> B[Plannotator]
  B --> C{Reviewer}
  C -->|approve| D[Ship]
  C -->|feedback| A
\`\`\`

And the build graph:

\`\`\`dot
digraph G { review -> hook -> binary; review -> engine; }
\`\`\`

Done.
`;

const PLAIN = `# Notes

No diagrams here, just words.

\`\`\`ts
const answer = 42;
\`\`\`
`;

function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
}

/** A repository whose working tree changes `doc.md` to `after`. */
function makeRepo(root: string, after: string): string {
  const dir = join(root, 'repo');
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'e2e@example.com');
  git(dir, 'config', 'user.name', 'e2e');
  writeFileSync(join(dir, 'doc.md'), '# Doc\n\nHello.\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  writeFileSync(join(dir, 'doc.md'), after);
  return dir;
}

async function review(after: string) {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-review-diagrams-e2e-');
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  const cwd = makeRepo(root, after);
  const readyFile = join(root, 'ready.jsonl');
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_READY_FILE: readyFile,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_BROWSER,
    PLANNOTATOR_SKIP_BROWSER_OPEN: '1',
    PLANNOTATOR_REMOTE: '0',
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_AI: 'disabled',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_GIT_REMOTE_CHECK: '0',
  };
  const child: ChildProcess = spawn(binary, ['review'], { env, cwd, stdio: 'ignore' });
  await expect.poll(() => (existsSync(readyFile) ? readFileSync(readyFile, 'utf8') : ''), { timeout: 30_000 }).toContain('"url"');
  const url = (JSON.parse(readFileSync(readyFile, 'utf8').trim().split('\n')[0]!) as { url: string }).url;
  const close = async () => {
    await fetch(new URL('/api/exit', url), { method: 'POST' }).catch(() => {});
    if (child.exitCode === null) {
      await new Promise((done) => {
        const timer = setTimeout(done, 5_000);
        child.once('exit', () => {
          clearTimeout(timer);
          done(undefined);
        });
      });
      // inbox-guard: own child (the review CLI this test spawned, never an Inbox)
      if (child.exitCode === null) child.kill('SIGTERM');
    }
    await removeInboxScratch(root);
  };
  return { url, close };
}

/** Answers requests for the diagram engine file named `name` with a 404 while
 * `failing()` says so (by default only the first), then lets them through;
 * records each URL asked for (query included). */
async function failEngineFile(page: Page, name: 'engine' | 'mermaid', asked: string[], failing?: () => boolean) {
  await page.route(
    (u) => u.pathname.startsWith(`/assets/diagram-engine/${name}-`),
    async (route) => {
      const u = new URL(route.request().url());
      asked.push(u.pathname + u.search);
      if (failing ? failing() : asked.length === 1) {
        await route.fulfill({ status: 404, contentType: 'text/plain', body: 'gone' });
        return;
      }
      await route.continue();
    },
  );
}

/** Opens the review with the Markdown files' starting view set; records every request for the engine. */
async function open(
  browser: Browser,
  url: string,
  view: 'read' | 'changes' | 'source',
  before?: (page: Page) => Promise<void>,
) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const seen = [
    ['plannotator-plan-look-choice-resolved', 'true'],
    ['plannotator-edit-mode-announcement-seen', '3'],
    ['plannotator-announce-tui-herdr-seen', '1'],
    ['plannotator-announce-inbox-seen', '1'],
    ['plannotator-announce-ask-session-seen', '1'],
    ['plannotator-announce-agent-tool-seen', '1'],
    ['plannotator-guide-intro-seen', '1'],
    ['plannotator-review-dest-spotlight-seen', '1'],
    ['plannotator-auto-viewed-notice-seen', '1'],
    ['plannotator-markdown-view', view],
  ];
  await context.addCookies(seen.map(([name, value]) => ({ name: name!, value: value!, url })));
  const page = await context.newPage();
  const engineRequests: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/assets/diagram-engine/')) engineRequests.push(path);
  });
  await before?.(page);
  await page.goto(url);
  // Any first-run dialog left is dismissed the way a reviewer would.
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(400);
    if ((await page.locator('.fixed.inset-0').count()) === 0) break;
    await page.keyboard.press('Escape');
  }
  await page.getByText('doc.md', { exact: true }).first().click();
  return { context, page, engineRequests };
}

async function shot(page: Page, name: string) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(shots, `${name}.png`) });
}

let browser: Browser;
test.beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
test.afterAll(async () => {
  await browser?.close();
});

test('Read view draws both diagrams, loading the engine and each runtime once', async () => {
  const session = await review(ARCHITECTURE);
  try {
    const advert = ((await (await fetch(new URL('/api/diff', session.url))).json()) as { diagramEngine?: Record<string, string> }).diagramEngine;
    expect(Object.keys(advert ?? {}).sort()).toEqual(['engine', 'graphviz', 'mermaid']);
    // The page itself carries no diagram runtime.
    const html = await (await fetch(session.url)).text();
    expect({ mermaid: html.includes('flowchart-v2'), graphviz: html.includes('viz_set_y_invert') }).toEqual({ mermaid: false, graphviz: false });

    const { context, page, engineRequests } = await open(browser, session.url, 'read');
    const mermaid = page.locator('[data-diagram-block="mermaid"] [data-diagram-inline] svg').first();
    const graphviz = page.locator('[data-diagram-block="graphviz"] [data-diagram-inline] svg').first();
    await expect(mermaid).toBeVisible({ timeout: 30_000 });
    await expect(graphviz).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-diagram-block="mermaid"]').first()).toContainText('Reviewer');
    await expect(page.locator('[data-diagram-block="graphviz"]').first()).toContainText('engine');
    // The fences are no longer shown as code.
    await expect(page.locator('pre > code', { hasText: 'flowchart LR' })).toHaveCount(0);
    await shot(page, 'read-view');
    // Each file once, whatever the number of fences and views on the page.
    expect([...engineRequests].sort()).toEqual([advert!.engine, advert!.graphviz, advert!.mermaid].sort());
    await context.close();
  } finally {
    await session.close();
  }
});

test('Changes view draws the diagrams in the rendered diff', async () => {
  const session = await review(ARCHITECTURE);
  try {
    const { context, page } = await open(browser, session.url, 'changes');
    await expect(page.locator('[data-diagram-block="mermaid"] [data-diagram-inline] svg').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-diagram-block="graphviz"] [data-diagram-inline] svg').first()).toBeVisible({ timeout: 30_000 });
    await shot(page, 'changes-view');
    await context.close();
  } finally {
    await session.close();
  }
});

test('a review without diagrams, and the Source view, never request the engine', async () => {
  const plain = await review(PLAIN);
  try {
    const { context, page, engineRequests } = await open(browser, plain.url, 'read');
    await expect(page.getByText('No diagrams here, just words.').first()).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(1_500);
    expect(engineRequests).toEqual([]);
    await context.close();
  } finally {
    await plain.close();
  }

  const withDiagrams = await review(ARCHITECTURE);
  try {
    const { context, page, engineRequests } = await open(browser, withDiagrams.url, 'source');
    await expect(page.getByText('flowchart LR').first()).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(1_500);
    expect(engineRequests).toEqual([]);
    await expect(page.locator('[data-diagram-block]')).toHaveCount(0);
    await context.close();
  } finally {
    await withDiagrams.close();
  }
});

test('Retry after a failed engine load fetches the engine again and draws the diagrams', async () => {
  // Chromium keeps a failed import() per URL and never fetches it again, so
  // Retry has to import a new URL (the engine's path with a retry query).
  const session = await review(ARCHITECTURE);
  try {
    const asked: string[] = [];
    let offline = true;
    const { context, page } = await open(browser, session.url, 'read', (p) => failEngineFile(p, 'engine', asked, () => offline));
    const retry = page.locator('[data-review-diagram="failed"] [data-review-diagram-note] button').first();
    await expect(retry).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('pre > code', { hasText: 'flowchart LR' }).first()).toBeVisible();
    // Each failed try asked for a URL of its own (a repeat would never reach
    // the network in Chromium), the first one plain.
    const failedTries = asked.length;
    expect(failedTries).toBeGreaterThan(0);
    expect(asked[0]).toMatch(/^\/assets\/diagram-engine\/engine-[^?]+\.js$/);
    expect(asked).toEqual(asked.map((_, i) => (i === 0 ? asked[0] : `${asked[0]}?r=${i}`)));

    offline = false;
    await retry.click();
    await expect(page.locator('[data-diagram-block="mermaid"] [data-diagram-inline] svg').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-diagram-block="mermaid"]').first()).toContainText('Reviewer');
    expect(asked).toHaveLength(failedTries + 1);
    expect(asked.at(-1)).toBe(`${asked[0]}?r=${failedTries}`);
    await shot(page, 'engine-retry');
    await context.close();
  } finally {
    await session.close();
  }
});

test('a failed Mermaid runtime load is fetched again under a new URL and draws', async () => {
  // The engine's renderer re-attempts a failed runtime import once by itself;
  // the runtime URL it reads then carries a retry query.
  const session = await review(ARCHITECTURE);
  try {
    const asked: string[] = [];
    const { context, page } = await open(browser, session.url, 'read', (p) => failEngineFile(p, 'mermaid', asked));
    await expect(page.locator('[data-diagram-block="mermaid"] [data-diagram-inline] svg').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-diagram-block="graphviz"] [data-diagram-inline] svg').first()).toBeVisible({ timeout: 30_000 });
    expect(asked).toHaveLength(2);
    expect(asked[0]).toMatch(/^\/assets\/diagram-engine\/mermaid-[^?]+\.js$/);
    expect(asked[1]).toBe(`${asked[0]}?r=1`);
    await context.close();
  } finally {
    await session.close();
  }
});
