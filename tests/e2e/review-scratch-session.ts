import { expect, type Browser } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));

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

/** The scratch repository a review is about to start in, and the environment it starts with. */
export interface ReviewScratchRepo {
  /** The scratch folder: the repository, the data dir and anything else a spec writes sit under it. */
  root: string;
  /** The repository, with the head files written over the base commit. */
  cwd: string;
  env: Record<string, string>;
  binary: string;
}

export interface ReviewScratchOptions {
  /** Runs once the head files are written, before `plannotator review` starts: a guide import, say (`importGuide`). */
  before?: (repo: ReviewScratchRepo) => void;
}

export async function reviewOf(name: string, base: Record<string, string>, head: Record<string, string>, options: ReviewScratchOptions = {}): Promise<{ url: string; close: () => Promise<void> }> {
  const root = inboxScratch(name);
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
  write(cwd, head);
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
  try {
    options.before?.({ root, cwd, env, binary });
  } catch (error) {
    await removeInboxScratch(root);
    throw error;
  }
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

export async function openReview(
  browser: Browser,
  url: string,
  prepare: (page: import('@playwright/test').Page) => Promise<void> = async () => {},
  options: import('@playwright/test').BrowserContextOptions = { viewport: { width: 1280, height: 900 } },
) {
  const context = await browser.newContext({ reducedMotion: 'reduce', ...options });
  const seen = [
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
  ];
  await context.addCookies(seen.map(([name, value]) => ({ name: name!, value: value!, url })));
  const page = await context.newPage();
  await prepare(page);
  await page.goto(url);
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(400);
    if ((await page.locator('.fixed.inset-0.z-\\[100\\]').count()) === 0) break;
    await page.keyboard.press('Escape');
  }
  return { context, page };
}

/**
 * `plannotator guide import` in the scratch repository, with the review's own environment (`reviewOf`'s `before`):
 * the review that starts next lists the guide under its saved guides. The guide and its patch (`git diff` of the head
 * files) are written beside the repository, never in it, so they are not part of the diff under review.
 */
export function importGuide({ root, cwd, env, binary }: ReviewScratchRepo, guide: object): void {
  const diff = spawnSync('git', ['diff'], { cwd, encoding: 'utf8' });
  if (diff.status !== 0 || !diff.stdout) throw new Error(`git diff: ${diff.stderr}`);
  const guideFile = join(root, 'guide.json');
  const patchFile = join(root, 'guide.patch');
  writeFileSync(guideFile, JSON.stringify(guide));
  writeFileSync(patchFile, diff.stdout);
  const run = spawnSync(binary, ['guide', 'import', '--guide', guideFile, '--patch', patchFile], { cwd, env, encoding: 'utf8', timeout: 30_000 });
  if (run.status !== 0) throw new Error(`plannotator guide import (${run.status}): ${run.stderr}`);
}

/**
 * Opens a saved guide in the review window, as a person does with AI features off (`reviewOf` turns them off): the
 * header's Guide, then the guide's row under "Saved guides". Resolves once the guide's first file card is on the page.
 */
export async function openSavedGuide(page: import('@playwright/test').Page, title: string): Promise<void> {
  const guide = page.locator('[data-guide-button]');
  await expect(guide, 'the header offers the Guide (a saved guide, with AI features off)').toBeVisible({ timeout: 30_000 });
  await guide.click();
  await expect(page.getByRole('heading', { name: 'Saved guides' })).toBeVisible();
  await page.locator('button', { hasText: title }).first().click();
  await expect(page.locator('[data-guide-file-shell]').first(), `the guide "${title}" opens on its first file`).toBeAttached({ timeout: 30_000 });
}
