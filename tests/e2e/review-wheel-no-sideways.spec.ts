import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));

const FILLERS = 4;
const FILLER_LINES = 80;
const WHEEL_STEP_PX = 1_200;
const ROUTES = Array.from({ length: 160 }, (_, i) => `'route${i}'`).join(', ');

const filler = (n: number, bump: number) =>
  Array.from({ length: FILLER_LINES }, (_, i) => `export const value${n}_${i} = ${i + bump};`).join('\n') + '\n';

const routes = (last: string) => `export const header = 'routes';

export const routes = [${ROUTES}, '${last}'];

export function count() {
  return routes.length;
}
`;

function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
}

function makeRepo(root: string): string {
  const dir = join(root, 'repo');
  mkdirSync(join(dir, 'src'), { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'e2e@example.com');
  git(dir, 'config', 'user.name', 'e2e');
  for (let n = 1; n <= FILLERS; n++) writeFileSync(join(dir, `src/a${n}.ts`), filler(n, 0));
  writeFileSync(join(dir, 'src/z-routes.ts'), routes('legacy'));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  for (let n = 1; n <= FILLERS; n++) writeFileSync(join(dir, `src/a${n}.ts`), filler(n, 1));
  writeFileSync(join(dir, 'src/z-routes.ts'), routes('current'));
  return dir;
}

async function review(): Promise<{ url: string; close: () => Promise<void> }> {
  const root = inboxScratch('review-wheel-sideways');
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  const cwd = makeRepo(root);
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

async function open(browser: Browser, url: string) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const cookies = [
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
    ['plannotator-diff-style', 'split'],
  ];
  await context.addCookies(cookies.map(([name, value]) => ({ name: name!, value: value!, url })));
  const page = await context.newPage();
  await page.goto(url);
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(400);
    if ((await page.locator('.fixed.inset-0.z-\\[100\\]').count()) === 0) break;
    await page.keyboard.press('Escape');
  }
  return { context, page };
}

type Scrollers = { long: number; shifted: string[]; old: { x: number; y: number } | null; new: { x: number; y: number } | null };

function scrollers(page: Page): Promise<Scrollers> {
  return page.evaluate(() => {
    const out: Scrollers = { long: 0, shifted: [], old: null, new: null };
    const middle = (el: Element) => {
      const box = el.getBoundingClientRect();
      const top = Math.max(box.top, 0);
      const bottom = Math.min(box.bottom, innerHeight);
      return bottom - top > 40 ? { x: box.left + box.width / 2, y: (top + bottom) / 2 } : null;
    };
    document.querySelectorAll('diffs-container').forEach((host) => {
      host.shadowRoot?.querySelectorAll<HTMLElement>('code[data-deletions], code[data-additions]').forEach((code) => {
        const side = code.hasAttribute('data-deletions') ? 'old' : 'new';
        if (code.scrollWidth > code.clientWidth + 400) out.long++;
        if (code.scrollLeft !== 0) out.shifted.push(`${side}=${code.scrollLeft}`);
        out[side] ??= middle(code);
      });
    });
    return out;
  });
}

type Column = { side: 'old' | 'new'; left: number; long: boolean };

function shownColumns(page: Page): Promise<Column[]> {
  return page.evaluate(() => {
    const out: Column[] = [];
    document.querySelectorAll('diffs-container').forEach((host) => {
      const box = host.getBoundingClientRect();
      if (box.width === 0 || box.bottom <= 0 || box.top >= innerHeight) return;
      host.shadowRoot?.querySelectorAll<HTMLElement>('code[data-deletions], code[data-additions]').forEach((code) => {
        out.push({ side: code.hasAttribute('data-deletions') ? 'old' : 'new', left: code.scrollLeft, long: code.scrollWidth > code.clientWidth + 400 });
      });
    });
    return out;
  });
}

async function scrollOnce(page: Page) {
  await expect.poll(async () => (await scrollers(page)).old, { timeout: 30_000 }).not.toBeNull();
  await page.waitForTimeout(3_000);
  const atLoad = await scrollers(page);
  await page.mouse.move(atLoad.old!.x, atLoad.old!.y);
  await page.mouse.wheel(0, 300);
  await page.waitForTimeout(500);
  expect((await scrollers(page)).shifted).toEqual([]);
}

let browser: Browser;
test.beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
test.afterAll(async () => {
  await browser?.close();
});

for (const side of ['old', 'new'] as const) {
  test(`wheel steps down with the pointer over the ${side} side leave a long line's file at the left edge on both sides`, async () => {
    const session = await review();
    try {
      const { context, page } = await open(browser, session.url);
      await expect.poll(async () => (await scrollers(page))[side], { timeout: 30_000 }).not.toBeNull();
      await page.waitForTimeout(3_000);
      const atLoad = await scrollers(page);
      expect(atLoad.long, 'the long-line file is drawn only once scrolling brings it near').toBe(0);
      expect(atLoad.shifted).toEqual([]);
      await page.mouse.move(atLoad[side]!.x, atLoad[side]!.y);

      let state = atLoad;
      for (let step = 1; step <= 20 && state.long === 0; step++) {
        await page.mouse.wheel(0, WHEEL_STEP_PX);
        await page.waitForTimeout(250);
        state = await scrollers(page);
        expect(state.shifted, `after wheel step ${step}`).toEqual([]);
      }
      expect(state.long, 'wheel steps reached the long-line file').toBeGreaterThan(0);
      for (let frame = 0; frame < 4; frame++) {
        await page.waitForTimeout(250);
        expect((await scrollers(page)).shifted, 'once the long-line file has settled').toEqual([]);
      }
      await context.close();
    } finally {
      await session.close();
    }
  });
}

test('after scrolling, a tree click opens the far-right file with its change in view, and All changes stays at the left edge', async () => {
  const session = await review();
  try {
    const { context, page } = await open(browser, session.url);
    await scrollOnce(page);
    await page.locator('[data-changes-tree] [data-type="item"][data-item-path$="z-routes.ts"]').first().click();
    await expect.poll(async () => (await shownColumns(page)).filter((c) => c.long && c.left > 0).map((c) => c.side).sort(), { timeout: 15_000 }).toEqual(['new', 'old']);
    await page.getByRole('tab', { name: 'All changes' }).click();
    await page.waitForTimeout(1_000);
    const columns = await shownColumns(page);
    expect(columns.length).toBeGreaterThan(0);
    expect(columns.filter((c) => c.left !== 0)).toEqual([]);
    await context.close();
  } finally {
    await session.close();
  }
});

test('after scrolling, next file (]) to the far-right file shows its change in All changes, and the other files stay at the left edge', async () => {
  const session = await review();
  try {
    const { context, page } = await open(browser, session.url);
    await scrollOnce(page);
    let arrived: Column[] = [];
    for (let press = 0; press < FILLERS + 2 && arrived.length === 0; press++) {
      await page.keyboard.press(']');
      await page.waitForTimeout(600);
      arrived = (await shownColumns(page)).filter((c) => c.long);
    }
    expect(arrived.length, 'next file reached the far-right file').toBeGreaterThan(0);
    await expect.poll(async () => (await shownColumns(page)).filter((c) => c.long && c.left > 0).map((c) => c.side).sort(), { timeout: 5_000 }).toEqual(['new', 'old']);
    expect((await shownColumns(page)).filter((c) => !c.long && c.left !== 0)).toEqual([]);
    await context.close();
  } finally {
    await session.close();
  }
});
