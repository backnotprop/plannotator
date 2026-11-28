import { chromium, expect, test, type Browser } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const FILES = 24;

function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
}

function source(file: number, order: number[]): string {
  return order.map((fn) => `export function f${file}x${fn}(rows: number[], limit = ${fn + 3}) {\n  const kept = rows.filter((row) => row > ${fn});\n  return kept.slice(0, limit).map((row) => row * ${file + 2});\n}\n`).join('\n');
}

function makeRepo(root: string): string {
  const dir = join(root, 'repo');
  mkdirSync(join(dir, 'src'), { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'e2e@example.com');
  git(dir, 'config', 'user.name', 'e2e');
  const before = [0, 1, 2, 3, 4, 5, 6, 7];
  for (let i = 0; i < FILES; i++) writeFileSync(join(dir, `src/m${i}.ts`), source(i, before));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  for (let i = 0; i < FILES; i++) writeFileSync(join(dir, `src/m${i}.ts`), source(i, [4, 5, 6, 0, 1, 2, 7, 3]));
  return dir;
}

async function review(root: string, cwd: string, name: string) {
  const home = join(root, name);
  const dataDir = join(home, 'data');
  mkdirSync(dataDir, { recursive: true });
  const readyFile = join(home, 'ready.jsonl');
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: home,
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
  };
  return { url, close };
}

async function semanticCount(browser: Browser, url: string, cores: number): Promise<{ count: number; workers: number }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  const seen = ['plannotator-plan-look-choice-resolved=true', 'plannotator-edit-mode-announcement-seen=3', 'plannotator-announce-tui-herdr-seen=1', 'plannotator-announce-inbox-seen=1', 'plannotator-announce-ask-session-seen=1', 'plannotator-announce-agent-tool-seen=1', 'plannotator-guide-intro-seen=2', 'plannotator-guide-hint-acked=true', 'plannotator-review-dest-spotlight-seen=1', 'plannotator-auto-viewed-notice-seen=1'];
  await context.addCookies(seen.map((pair) => ({ name: pair.split('=')[0]!, value: pair.split('=')[1]!, url })));
  await context.addInitScript((n) => Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => n }), cores);
  const page = await context.newPage();
  let workers = 0;
  page.on('worker', () => workers++);
  await page.goto(url);
  const row = page.locator('[data-semantic-diff-count]');
  await expect(row).toBeVisible({ timeout: 60_000 });
  const count = Number((await row.textContent())?.match(/\d+/)?.[0] ?? -1);
  await context.close();
  return { count, workers };
}

let browser: Browser;
test.beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
test.afterAll(async () => {
  await browser?.close();
});

test('three semantic workers find exactly what one finds, on a 24-file review', async () => {
  test.setTimeout(180_000);
  const root = inboxScratch('review-semantic-pool');
  try {
    const cwd = makeRepo(root);
    const runs: Record<number, { count: number; workers: number }> = {};
    for (const cores of [4, 8]) {
      const session = await review(root, cwd, `home-${cores}`);
      try {
        runs[cores] = await semanticCount(browser, session.url, cores);
      } finally {
        await session.close();
      }
    }
    expect(runs[4]!.count).toBeGreaterThanOrEqual(FILES);
    expect(runs[8]!.count).toBe(runs[4]!.count);
    expect(runs[8]!.workers - runs[4]!.workers).toBe(2);
  } finally {
    await removeInboxScratch(root);
  }
});
