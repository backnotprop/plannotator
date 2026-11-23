/**
 * The world of inbox-review-images.spec.ts: a scratch Inbox from the compiled
 * binary (its own HOME, data folder and fake `gh` and `glab` first on PATH,
 * every name invented), a teammate's pull request that changes three pictures
 * (one modified, one added, one deleted), and an agent's guided review of the
 * same real `git diff`; then a second guided review, of the next commit, that
 * only renames a picture (`similarity index 100%`, so its patch names no blob).
 *
 * The pull request's head and base are the scratch repository's own commits,
 * and the repository is the project the review was sent from, so the Inbox
 * reads each picture from that clone, as it does on a person's computer; the
 * fake forge serves only the list, the diff and the commits.
 */
import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';
import { clearSidebarPeek } from './sidebar-peek';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));

export const MODIFIED = 'assets/chart.png';
export const ADDED = 'assets/badge.png';
export const DELETED = 'assets/old-banner.png';
export const PULL_KEY = 'github.com/northwind/web-app#815';
/** A picture the second guide only moves: its contents unchanged. */
export const RENAMED_FROM = 'assets/logo.png';
export const RENAMED = 'brand/logo.png';

export interface ImagesWorld {
  url: string;
  thread: string;
  message: string;
  /** The guided review of the rename alone (the images world's; the Markdown world has none). */
  renameThread?: string;
  agent: SimAgent;
}

// --- Pictures: real PNGs, drawn here ---------------------------------------------------------

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes: Buffer) => {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Buffer) => {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, tail]);
};

export type Rgb = [number, number, number];
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  color: Rgb;
}

/** A `width` × `height` picture: `background`, then each box over it. */
export function picture(width: number, height: number, background: Rgb, boxes: Box[]): Buffer {
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    rows[row] = 0;
    for (let x = 0; x < width; x++) {
      const box = [...boxes].reverse().find((b) => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h);
      const [r, g, b] = box ? box.color : background;
      rows[row + 1 + x * 3] = r;
      rows[row + 2 + x * 3] = g;
      rows[row + 3 + x * 3] = b;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

const PAPER: Rgb = [246, 244, 238];
const INK: Rgb = [52, 64, 84];
const BLUE: Rgb = [59, 110, 214];
const ORANGE: Rgb = [232, 128, 52];
const GREEN: Rgb = [56, 158, 104];
const bars = (heights: number[], color: Rgb): Box[] => heights.map((h, i) => ({ x: 40 + i * 56, y: 200 - h, w: 36, h, color }));
const axis: Box[] = [
  { x: 28, y: 20, w: 3, h: 184, color: INK },
  { x: 28, y: 201, w: 300, h: 3, color: INK },
];

const CHART_BEFORE = picture(360, 230, PAPER, [...axis, ...bars([60, 90, 120, 80, 140], BLUE)]);
const CHART_AFTER = picture(360, 230, PAPER, [...axis, ...bars([60, 110, 150, 80, 170], BLUE), { x: 264, y: 22, w: 76, h: 18, color: ORANGE }]);
const BADGE = picture(160, 160, [255, 255, 255], [{ x: 16, y: 16, w: 128, h: 128, color: GREEN }, { x: 52, y: 52, w: 56, h: 56, color: [255, 255, 255] }]);
const BANNER = picture(420, 120, [36, 40, 56], [{ x: 24, y: 40, w: 220, h: 18, color: [220, 220, 230] }, { x: 24, y: 70, w: 140, h: 12, color: ORANGE }]);
const LOGO = picture(120, 120, PAPER, [{ x: 20, y: 20, w: 80, h: 80, color: BLUE }, { x: 44, y: 44, w: 32, h: 32, color: ORANGE }]);

// --- The repository, the forge, the Inbox ------------------------------------------------------

export function git(project: string, ...args: string[]): string {
  const run = spawnSync('git', args, {
    cwd: project,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Bob Tully', GIT_AUTHOR_EMAIL: 'bob@example.com', GIT_COMMITTER_NAME: 'Bob Tully', GIT_COMMITTER_EMAIL: 'bob@example.com' },
  });
  if (run.status !== 0) throw new Error(run.stderr);
  return run.stdout;
}

/** A scratch repository holding the change, its real diff, and its two commits. */
function change(parent: string): { project: string; patch: string; head: string; base: string } {
  const project = scratchProject(parent, 'web-app');
  mkdirSync(join(project, 'assets'), { recursive: true });
  writeFileSync(join(project, 'README.md'), 'A scratch project.\n');
  writeFileSync(join(project, MODIFIED), CHART_BEFORE);
  writeFileSync(join(project, DELETED), BANNER);
  // In the base and untouched by the pull request: only the second guide's commit moves it.
  writeFileSync(join(project, RENAMED_FROM), LOGO);
  git(project, 'add', '-A');
  git(project, 'commit', '-q', '-m', 'base');
  writeFileSync(join(project, MODIFIED), CHART_AFTER);
  writeFileSync(join(project, ADDED), BADGE);
  unlinkSync(join(project, DELETED));
  git(project, 'add', '-A');
  git(project, 'commit', '-q', '-m', 'the change');
  git(project, 'remote', 'add', 'origin', 'https://github.com/northwind/web-app.git');
  return { project, patch: git(project, 'diff', '--no-renames', 'HEAD~1', 'HEAD'), head: git(project, 'rev-parse', 'HEAD').trim(), base: git(project, 'rev-parse', 'HEAD~1').trim() };
}

/** The fake forge: signed in, one pull request asked of the person, its diff, its head and where it left main. */
function writeForge(dir: string, patch: string, head: string, base: string, title: string): void {
  mkdirSync(dir, { recursive: true });
  const pull = {
    number: 815,
    title,
    url: 'https://github.com/northwind/web-app/pull/815',
    state: 'OPEN',
    isDraft: false,
    updatedAt: new Date(Date.now() - 600_000).toISOString(),
    mergedAt: null,
    baseRefName: 'main',
    headRefName: 'charlie/pictures',
    headRefOid: head,
    additions: 0,
    deletions: 0,
    changedFiles: 3,
    reviewDecision: 'REVIEW_REQUIRED',
    repository: { nameWithOwner: 'northwind/web-app' },
    headRepository: { nameWithOwner: 'northwind/web-app' },
    author: { login: 'charlie', avatarUrl: 'http://127.0.0.1:9/charlie.png' },
    reviewRequests: { nodes: [{ requestedReviewer: { login: 'ada' } }] },
    latestReviews: { nodes: [] },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
  };
  writeFileSync(join(dir, 'pulls.json'), JSON.stringify({ data: { viewer: { login: 'ada' }, requested: { nodes: [pull] }, authored: { nodes: [] }, merged: { nodes: [] } } }));
  writeFileSync(join(dir, 'pull.patch'), patch);
  const gh = [
    '#!/bin/sh',
    `dir='${dir}'`,
    'if [ "$1" = auth ] && [ "$2" = status ]; then',
    '  echo \'{"hosts":{"github.com":[{"login":"ada","active":true,"state":"success","tokenSource":"keyring"}]}}\'',
    '  exit 0',
    'fi',
    'if [ "$1" = api ] && [ "$2" = graphql ]; then',
    '  case "$*" in *"query InboxPullsOthers"*) echo \'{"data":{"viewer":{"login":"ada"},"others0":{"issueCount":0,"nodes":[]}}}\'; exit 0;; esac',
    '  case "$*" in *"requested: search"*) cat "$dir/pulls.json"; exit 0;; esac',
    '  echo \'{"data":null}\'; exit 1',
    'fi',
    // A file's bytes are read from the clone; the forge is never asked for one here.
    'case "$*" in *"/contents/"*) echo "gh: Not Found (HTTP 404)" >&2; exit 1;; esac',
    `case "$*" in *merge_base_commit*) echo ${base}; exit 0;; esac`,
    // The PR read around its patch asks for its head and description as one JSON line (inbox-pulls.ts `pullNow`).
    `if [ "$1" = api ] && [ "$2" = --hostname ] && [ "$5" = --jq ]; then case "$6" in *tojson*) echo '{"sha":"${head}","body":null}';; *) echo ${head};; esac; exit 0; fi`,
    'if [ "$1" = api ] && [ "$2" = --hostname ]; then cat "$dir/pull.patch"; exit 0; fi',
    'exit 1',
    '',
  ].join('\n');
  writeFileSync(join(dir, 'gh'), gh);
  writeFileSync(join(dir, 'glab'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(dir, 'gh'), 0o755);
  chmodSync(join(dir, 'glab'), 0o755);
}

const GUIDE = {
  title: 'Refresh the dashboard pictures',
  intent: 'The chart shows the new quarter, the badge is new, and the old banner goes.',
  sections: [
    { title: 'The chart', overview: 'Two bars grow and a legend joins.', diffs: [{ file: MODIFIED, summary: 'The new quarter.' }] },
    { title: 'Badge and banner', overview: 'One picture in, one out.', diffs: [{ file: ADDED, summary: 'The badge.' }, { file: DELETED, summary: 'The banner goes.' }] },
  ],
};

export async function startWorld(browser: Browser): Promise<ImagesWorld> {
  return startPullWorld(browser, 'plannotator-review-images-e2e-', change, GUIDE, 'Three pictures to look at.', sendRenameGuide);
}

/**
 * A scratch Inbox whose one pull request (#815, its title the guide's) is `made`'s change, with an agent's guided
 * review of the same diff (shared by inbox-review-markdown-world.ts).
 */
export async function startPullWorld(
  browser: Browser,
  prefix: string,
  made: (parent: string) => { project: string; patch: string; head: string; base: string },
  guide: { title: string; intent: string; sections: unknown[] },
  body: string,
  next?: (agent: SimAgent, project: string) => Promise<Partial<ImagesWorld>>,
): Promise<ImagesWorld> {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch(prefix);
  const home = join(root, 'home');
  const dataDir = join(root, 'data');
  mkdirSync(home, { recursive: true });
  markTourDecided(dataDir);
  const { project, patch, head, base } = made(join(root, 'src'));
  const forge = join(root, 'forge');
  writeForge(forge, patch, head, base, guide.title);
  for (const dir of ['claude', 'codex', 'xdg']) mkdirSync(join(root, dir), { recursive: true });
  const env: Record<string, string> = {
    PATH: `${forge}:${process.env.PATH ?? ''}`,
    HOME: home,
    PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
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
  const context = await browser.newContext();
  const on = await context.request.post(`${url}api/inbox/settings`, { data: { code_review: { on: true } } });
  expect(on.status()).toBe(200);
  await context.close();
  const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const review = await agent.submitGuide({ project_path: project, subject: guide.title, guide, patch, body, review: true } as never);
  return { url, thread: String(review.thread_id), message: String(review.message_id), agent, ...(next ? await next(agent, project) : {}) };
}

/** The images world's second guided review: the next commit only moves the logo, and its guide records that commit as the one it was written at. */
async function sendRenameGuide(agent: SimAgent, project: string): Promise<Partial<ImagesWorld>> {
  mkdirSync(join(project, 'brand'), { recursive: true });
  git(project, 'mv', RENAMED_FROM, RENAMED);
  git(project, 'commit', '-q', '-m', 'move the logo');
  const renamePatch = git(project, 'diff', '-M', 'HEAD~1', 'HEAD');
  expect(renamePatch).toContain('similarity index 100%');
  const renameGuide = { title: 'Move the logo', intent: 'The logo moves to the brand folder.', sections: [{ title: 'The logo', overview: 'Same picture, new folder.', diffs: [{ file: RENAMED, summary: 'Moved.' }] }] };
  const rename = await agent.submitGuide({ project_path: project, subject: 'Move the logo', guide: renameGuide, patch: renamePatch, body: 'One picture moves.', review: true } as never);
  return { renameThread: String(rename.thread_id) };
}

export async function stopWorld(world: ImagesWorld | undefined): Promise<void> {
  try {
    await world?.agent.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
}

/** A window at this size, with a phone's touch when it is one. */
export async function windowAt(browser: Browser, width: number, height: number, phone: boolean, colorScheme: 'light' | 'dark' = 'light'): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme, reducedMotion: 'reduce', ...(phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
  return { context, page: await context.newPage() };
}

export async function openPull(world: ImagesWorld, page: Page, shown = MODIFIED): Promise<void> {
  const key = encodeURIComponent(PULL_KEY);
  await page.goto(`${world.url}#pulls&stack=${key}&layer=${key}&scope=layer`);
  await clearSidebarPeek(page);
  await expect(page.locator(`[data-guide-file-shell="${shown}"]`)).toBeVisible({ timeout: 30_000 });
}

export async function openReview(world: ImagesWorld, page: Page, thread = world.thread, file = MODIFIED): Promise<void> {
  await page.goto(`${world.url}#thread=${thread}`);
  await clearSidebarPeek(page);
  await page.locator('[data-review-card]').getByRole('button', { name: /review/i }).first().click();
  await expect(page.locator('[data-review-message]')).toBeVisible();
  await expect(page.locator(`[data-guide-file-shell="${file}"]`)).toBeVisible({ timeout: 30_000 });
}
