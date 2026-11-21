import { expect, test, type Browser, type Page } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const out = process.env.SHOTS_DIR ?? join(repo, '.local/shots');
const mode = process.env.SHOTS_MODE ?? 'after';

function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
}

function write(dir: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

const body = (name: string, n: number) => Array.from({ length: 12 }, (_, i) => `export const ${name}${i} = ${i * n};`).join('\n') + '\n';

const base: Record<string, string> = {
  'src/app.ts': body('app', 1),
  'src/router.ts': body('route', 2),
  'src/store.ts': body('store', 3),
  'src/util/format.ts': body('fmt', 4),
  'src/util/parse.ts': body('parse', 5),
  'src/legacy-name.ts': body('legacy', 6),
  'docs/guide.md': '# Guide\n\nIntro.\n\n## Setup\n\nSteps.\n',
  'docs/api.md': '# API\n\nCalls.\n',
  'README.md': '# Demo\n\nA demo repository.\n',
  'test/app.test.ts': body('tapp', 7),
  'test/router.test.ts': body('trouter', 8),
  '.eslintrc.json': '{ "root": true }\n',
  'package.json': '{ "name": "demo", "version": "1.0.0" }\n',
};

const head: Record<string, string> = {
  'src/app.ts': body('app', 11),
  'src/router.ts': body('route', 12),
  'src/store.ts': body('store', 13),
  'src/util/format.ts': body('fmt', 14),
  'src/util/parse.ts': body('parse', 15),
  'src/new-name.ts': body('legacy', 6).replace('legacy0 = 0', 'legacy0 = 100'),
  'src/feature/flags.ts': body('flag', 16),
  'docs/guide.md': '# Guide\n\nIntro, updated.\n\n## Setup\n\nNew steps.\n',
  'docs/api.md': '# API\n\nCalls and events.\n',
  'docs/changelog.mdx': '# Changelog\n\n- Filters.\n',
  'README.md': '# Demo\n\nA demo repository with filters.\n',
  'test/app.test.ts': body('tapp', 17),
  'test/router.test.ts': body('trouter', 18),
  'test/store.test.ts': body('tstore', 19),
  '.eslintrc.json': '{ "root": true, "rules": {} }\n',
  '.github/workflows/ci.yml': 'name: ci\non: push\n',
  'package.json': '{ "name": "demo", "version": "1.1.0" }\n',
  'scripts/build.sh': 'echo build\n',
};

async function startReview(): Promise<{ url: string; close: () => Promise<void> }> {
  const root = inboxScratch('pn-filter-shots-');
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  const cwd = join(root, 'repo');
  mkdirSync(cwd, { recursive: true });
  git(cwd, 'init', '-q', '-b', 'main');
  git(cwd, 'config', 'user.email', 'e2e@example.com');
  git(cwd, 'config', 'user.name', 'e2e');
  write(cwd, base);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', 'base');
  git(cwd, 'mv', 'src/legacy-name.ts', 'src/new-name.ts');
  write(cwd, head);
  git(cwd, 'add', '-A');
  const readyFile = join(root, 'ready.jsonl');
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
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
  return {
    url,
    close: async () => {
      await fetch(new URL('/api/exit', url), { method: 'POST' }).catch(() => {});
      await new Promise((done) => setTimeout(done, 1500));
      // inbox-guard: own child (the review CLI this test spawned, never an Inbox)
      if (child.exitCode === null) child.kill('SIGTERM');
      await removeInboxScratch(root);
    },
  };
}

const SEEN = [
  ['plannotator-plan-look-choice-resolved', 'true'],
  ['plannotator-edit-mode-announcement-seen', '3'],
  ['plannotator-announce-tui-herdr-seen', '1'],
  ['plannotator-announce-inbox-seen', '1'],
  ['plannotator-announce-ask-session-seen', '1'],
  ['plannotator-announce-agent-tool-seen', '1'],
  ['plannotator-guide-intro-seen', '2'],
  ['plannotator-guide-hint-acked', 'true'],
  ['plannotator-review-dest-spotlight-seen', '1'],
  ['plannotator-auto-viewed-notice-seen', '1'],
  ['plannotator-token-hover-announcement-seen', '1'],
];

async function open(browser: Browser, url: string, scheme: 'light' | 'dark', phone: boolean) {
  const context = await browser.newContext({
    reducedMotion: 'reduce',
    colorScheme: scheme,
    deviceScaleFactor: 2,
    viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 800 },
    ...(phone ? { isMobile: true, hasTouch: true } : {}),
  });
  await context.addCookies([...SEEN, ['plannotator-theme', scheme]].map(([name, value]) => ({ name: name!, value: value!, url })));
  const page = await context.newPage();
  await page.goto(url);
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(400);
    if ((await page.locator('.fixed.inset-0.z-\\[100\\]').count()) === 0) break;
    await page.keyboard.press('Escape');
  }
  await expect(page.locator('[data-changes-tree]').first()).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(800);
  return { context, page };
}

async function describe(page: Page, label: string) {
  const rows = await page.locator('[data-changes-tree]').first().evaluate((el) =>
    [...(el.shadowRoot?.querySelectorAll('[data-type="item"][data-item-type="file"]') ?? [])].map((row) => row.getAttribute('data-item-path')),
  ).catch(() => []);
  const caption = await page.locator('[data-review-progress-caption]').first().textContent().catch(() => null);
  const status = await page.locator('[role="status"]').allTextContents().catch(() => []);
  console.log(`STATE ${label}: rows=${JSON.stringify(rows)} caption=${JSON.stringify(caption)} status=${JSON.stringify(status)}`);
}

async function shot(page: Page, name: string) {
  mkdirSync(out, { recursive: true });
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(out, `${name}.png`) });
  await describe(page, name);
}

async function setField(page: Page, name: 'include' | 'exclude', value: string) {
  const field = page.locator(`input[name="${name}"]`).first();
  await field.fill(value);
  await page.waitForTimeout(500);
}

async function openFilter(page: Page) {
  const toggle = page.locator('button[aria-label^="Filter files"]').first();
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(page.locator('input[name="include"]').first()).toBeVisible();
}

async function allChanges(page: Page) {
  const row = page.getByText('All changes', { exact: true }).first();
  if (await row.isVisible().catch(() => false)) await row.click();
  await page.waitForTimeout(800);
}

test.setTimeout(240_000);

test('file filter screenshots', async ({ browser }) => {
  test.skip(!existsSync(binary), `compile the binary first: ${binary}`);
  const session = await startReview();
  try {
    if (mode === 'before') {
      for (const scheme of ['light', 'dark'] as const) {
        const { context, page } = await open(browser, session.url, scheme, false);
        await shot(page, `08-main-before-1280-${scheme}`);
        await context.close();
      }
      const { context, page } = await open(browser, session.url, 'light', true);
      await shot(page, `08-main-before-390-light`);
      await context.close();
      return;
    }
    for (const scheme of ['light', 'dark'] as const) {
      const { context, page } = await open(browser, session.url, scheme, false);
      await shot(page, `01-no-filter-1280-${scheme}`);
      await openFilter(page);
      await shot(page, `02-open-empty-1280-${scheme}`);
      await context.close();
    }
    {
      const { context, page } = await open(browser, session.url, 'light', false);
      await openFilter(page);
      await setField(page, 'include', 'src/**');
      await allChanges(page);
      await shot(page, '03-include-src-1280-light');
      await setField(page, 'include', '');
      await setField(page, 'exclude', '**/*.{md,mdx}');
      await shot(page, '04-exclude-md-1280-light');
      await setField(page, 'include', 'src/**, test/**');
      await setField(page, 'exclude', '**/*.test.ts');
      await shot(page, '05-both-1280-light');
      await setField(page, 'exclude', '');
      await setField(page, 'include', 'src');
      await shot(page, '06a-bare-src-no-match-1280-light');
      await setField(page, 'include', '*.md');
      await shot(page, '06b-star-md-root-only-1280-light');
      await setField(page, 'include', 'src/{a,');
      await shot(page, '06c-invalid-brace-1280-light');
      await setField(page, 'include', 'src/**');
      await page.locator('button[aria-label^="Filter files"]').first().click();
      await page.waitForTimeout(400);
      await shot(page, '06d-active-filter-closed-1280-light');
      await context.close();
    }
    for (const scheme of ['light', 'dark'] as const) {
      const { context, page } = await open(browser, session.url, scheme, true);
      await shot(page, `07a-phone-no-filter-390-${scheme}`);
      await openFilter(page);
      await setField(page, 'include', 'src/**');
      await shot(page, `07b-phone-include-src-390-${scheme}`);
      await setField(page, 'include', 'nothing/**');
      await shot(page, `07c-phone-no-match-390-${scheme}`);
      await context.close();
    }
  } finally {
    await session.close();
  }
});
