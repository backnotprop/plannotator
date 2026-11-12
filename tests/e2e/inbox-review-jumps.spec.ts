import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';
import { blankOnScreen } from './on-screen-files';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const PLACE = 16;

test.describe.configure({ mode: 'serial' });
test.use({ actionTimeout: 20_000 });

function changed(path: string, rows: number): string {
  const body: string[] = [];
  for (let n = 0; n < rows; n++) body.push(`-export const v${n} = 0;`, `+export const v${n} = 1;`);
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,${rows + 1} +1,${rows + 1} @@\n export const a = 1;\n${body.join('\n')}\n`;
}

interface Fixture {
  paths: string[];
  patch: string;
}

function manyFiles(): Fixture {
  const paths: string[] = [];
  let patch = '';
  for (let i = 0; i < 300; i++) {
    const id = String(i).padStart(3, '0');
    if (i % 10 === 8) {
      const path = `src/moved/r${id}.ts`;
      paths.push(path);
      patch += `diff --git a/src/old/r${id}.ts b/${path}\nsimilarity index 100%\nrename from src/old/r${id}.ts\nrename to ${path}\n`;
    } else if (i % 10 === 9) {
      const path = `assets/b${id}.bin`;
      paths.push(path);
      patch += `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\nBinary files a/${path} and b/${path} differ\n`;
    } else {
      const path = `src/mixed/m${id}.ts`;
      paths.push(path);
      patch += changed(path, i % 10 === 7 ? 40 : 1 + (i % 12));
    }
  }
  return { paths, patch };
}

function oneHugeFile(): Fixture {
  const paths: string[] = [];
  let patch = '';
  for (let i = 0; i < 40; i++) {
    const path = `src/big/b${String(i).padStart(2, '0')}.ts`;
    paths.push(path);
    patch += changed(path, i === 20 ? 15_000 : 3);
  }
  return { paths, patch };
}

let world: { root: string; url: string; project: string; claude: SimAgent; context: BrowserContext; page: Page; errors: string[] };

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-inbox-review-jumps-e2e-');
  const dataDir = join(root, 'data');
  markTourDecided(dataDir);
  for (const dir of ['claude', 'codex', 'xdg']) mkdirSync(join(root, dir), { recursive: true });
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_ANON_PING: '1',
    PLANNOTATOR_INBOX_NOTES: '0',
    PLANNOTATOR_TEST_SANDBOX: '1',
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    CODEX_HOME: join(root, 'codex'),
    XDG_CONFIG_HOME: join(root, 'xdg'),
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  const url = started.stdout.trim();
  const context = await browser.newContext({ viewport: { width: 1920, height: 1200 }, colorScheme: 'light' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const on = await page.request.post(`${url}api/inbox/settings`, { data: { code_review: { on: true } } });
  expect(on.ok()).toBe(true);
  world = {
    root,
    url,
    project: scratchProject(join(root, 'src'), 'jumps'),
    claude: await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' }),
    context,
    page,
    errors,
  };
});

test.afterAll(async () => {
  await world?.context.close().catch(() => {});
  await world?.claude.close().catch(() => {});
  await removeInboxScratch();
});

async function openFiles({ paths, patch }: Fixture): Promise<Locator> {
  const review = await world.claude.submitGuide({
    project_path: world.project,
    guide: {
      title: `A review of ${paths.length} files`,
      intent: 'Moving around it.',
      sections: [{ title: 'All', overview: 'Every file.', diffs: paths.map((file) => ({ file, summary: 'A change.' })) }],
      review: { gitRef: 'main...HEAD', base: 'main' },
      generator: { engine: 'claude-code', model: 'claude-opus-5' },
    },
    patch,
    body: 'Moving around it.',
    review: true,
  } as never);
  const { page } = world;
  await page.goto(`${world.url}#thread=${review.thread_id}`);
  await page.locator('[data-review-card]').filter({ hasText: `A review of ${paths.length} files` }).first().getByRole('button', { name: 'Start review' }).click();
  const pane = page.locator('[data-review-message]');
  await expect(pane.locator('[data-guide-file-shell]')).toHaveCount(paths.length, { timeout: 60_000 });
  await pane.locator('[data-review-mode-choice="files"]').click();
  await expect(pane).toHaveAttribute('data-review-mode', 'files');
  const body = pane.locator('.ib-gbody');
  await body.evaluate((el) => {
    const w = window as unknown as { __mountedEver: Set<string>; __longest: number };
    w.__mountedEver = new Set();
    w.__longest = 0;
    new MutationObserver((records) => {
      for (const record of records) {
        const box = record.target as HTMLElement;
        if (box.dataset.guideCodeViewMounted === 'true') w.__mountedEver.add(box.closest<HTMLElement>('[data-guide-file-shell]')?.dataset.guideFileShell ?? '');
      }
    }).observe(el, { subtree: true, attributes: true, attributeFilter: ['data-guide-code-view-mounted'] });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) w.__longest = Math.max(w.__longest, entry.duration);
    }).observe({ entryTypes: ['longtask'] });
  });
  return body;
}

const forget = (page: Page) => page.evaluate(() => {
  const w = window as unknown as { __mountedEver: Set<string>; __longest: number };
  w.__mountedEver.clear();
  w.__longest = 0;
});
const mountedEver = (page: Page) => page.evaluate(() => [...(window as unknown as { __mountedEver: Set<string> }).__mountedEver]);
const longestTask = (page: Page) => page.evaluate(() => (window as unknown as { __longest: number }).__longest);

const placeOf = (body: Locator, path: string) => body.evaluate((el, p) => {
  const shell = el.querySelector(`[data-guide-file-shell="${p}"]`) as HTMLElement;
  return Math.round(shell.getBoundingClientRect().top - el.getBoundingClientRect().top);
}, path);

async function settledPlace(page: Page, body: Locator, path: string): Promise<number> {
  let last = Number.NaN;
  let stillSince = Date.now();
  const started = Date.now();
  while (Date.now() - stillSince < 500 && Date.now() - started < 8_000) {
    const place = await placeOf(body, path);
    if (place !== last) stillSince = Date.now();
    last = place;
    await page.waitForTimeout(40);
  }
  return last;
}

const blankCode = async (body: Locator) => (await blankOnScreen(body)).filter((path) => !path.includes('/moved/') && !path.startsWith('assets/'));

async function jumpToFile(page: Page, path: string) {
  await page.locator('[data-review-message] [data-review-jump]').click();
  await page.locator(`[data-review-files] [data-review-jump-row="${path}"]`).click();
}

test('a jump far down a review of 300 files lands exactly, and mounts nothing it passes', async () => {
  const { page } = world;
  const fixture = manyFiles();
  const body = await openFiles(fixture);
  for (const [index, passedFrom, passedTo] of [[150, 20, 140], [40, 50, 140], [280, 50, 270]] as const) {
    await forget(page);
    await jumpToFile(page, fixture.paths[index]);
    expect(await settledPlace(page, body, fixture.paths[index]), `file ${index}`).toBe(PLACE);
    await expect.poll(() => blankCode(body)).toEqual([]);
    const ever = await mountedEver(page);
    const passed = ever.filter((path) => {
      const at = fixture.paths.indexOf(path);
      return at >= passedFrom && at <= passedTo;
    });
    expect(passed, `files mounted on the way to file ${index}`).toEqual([]);
    expect(ever).toContain(fixture.paths[index]);
  }
  expect(world.errors).toEqual([]);
});

test('a jump to a file nearby lands exactly', async () => {
  const { page } = world;
  const fixture = manyFiles();
  const body = await openFiles(fixture);
  await jumpToFile(page, fixture.paths[100]);
  expect(await settledPlace(page, body, fixture.paths[100])).toBe(PLACE);
  await jumpToFile(page, fixture.paths[103]);
  expect(await settledPlace(page, body, fixture.paths[103])).toBe(PLACE);
});

test('End goes to the bottom without mounting the files on the way; a file just off screen is ready', async () => {
  const { page } = world;
  const fixture = manyFiles();
  const body = await openFiles(fixture);
  await page.waitForTimeout(800);

  const aheadMounted = await body.evaluate((el) => {
    const bottom = el.getBoundingClientRect().bottom;
    const shell = [...el.querySelectorAll<HTMLElement>('[data-guide-file-shell]')].find((candidate) => {
      const top = candidate.getBoundingClientRect().top;
      return top > bottom + 200 && top < bottom + 1_000;
    });
    return shell?.querySelector<HTMLElement>('[data-guide-code-view-mounted]')?.dataset.guideCodeViewMounted;
  });
  expect(aheadMounted).toBe('true');

  await forget(page);
  await body.evaluate((el) => {
    el.tabIndex = -1;
    el.focus({ preventScroll: true });
  });
  await page.keyboard.press('End');
  await expect.poll(() => body.evaluate((el) => Math.round(el.scrollHeight - el.clientHeight - el.scrollTop)), { timeout: 5_000 }).toBeLessThan(2);
  await expect.poll(() => blankCode(body)).toEqual([]);
  const middle = (await mountedEver(page)).filter((path) => {
    const at = fixture.paths.indexOf(path);
    return at >= 30 && at <= 270;
  });
  expect(middle).toEqual([]);
});

test('a 30,000-line diff: jumping to it draws it with no freeze, and End and Home pass it unmounted', async () => {
  const { page } = world;
  const fixture = oneHugeFile();
  const huge = fixture.paths[20];
  const body = await openFiles(fixture);
  await page.waitForTimeout(500);

  await forget(page);
  await body.evaluate((el) => {
    el.tabIndex = -1;
    el.focus({ preventScroll: true });
  });
  await page.keyboard.press('End');
  await page.waitForTimeout(1_000);
  await page.keyboard.press('Home');
  await page.waitForTimeout(1_000);
  expect(await mountedEver(page)).not.toContain(huge);

  await forget(page);
  await jumpToFile(page, fixture.paths[20]);
  expect(await settledPlace(page, body, huge)).toBe(PLACE);
  await expect.poll(() => blankOnScreen(body), { timeout: 10_000 }).toEqual([]);
  await page.waitForTimeout(3_000);
  expect(await longestTask(page)).toBeLessThan(1_200);
  expect(world.errors).toEqual([]);
});
