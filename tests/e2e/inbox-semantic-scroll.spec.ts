/**
 * In the Inbox's review, when the semantic notes land in the files above, the row under the person's eye keeps its
 * place on screen, whether or not they opened unchanged lines in their own file first. Real Chromium against the
 * compiled binary's Inbox (`plannotator inbox --background`, scratch HOME and data folder), a simulated agent
 * submitting a review of a scratch repository; the files above are read late, so their notes land after the person
 * opened lines.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));

test.describe.configure({ mode: 'serial' });

const fn = (name: string, lines: number) => [`export function ${name}(value: number): number {`, ...Array.from({ length: lines }, (_, i) => `  value = value * ${i + 2} + ${name.length};`), '  return value;', '}', ''];
const text = (...blocks: string[][]) => blocks.flat().join('\n');
const totals = (changed: boolean) =>
  Array.from({ length: 80 }, (_, i) => `export const total${i + 1} = ${changed && (i < 30 || i === 70) ? (i + 1) * 10 : i + 1};`).join('\n') + '\n';

const PATHS = ['src/money.ts', 'src/validators.ts', 'src/totals.ts'];
const BASE: Record<string, string> = {
  'src/money.ts': text(fn('cents', 8), fn('round', 8), fn('format', 8), fn('parse', 8)),
  'src/validators.ts': text(fn('isEmail', 6), fn('isPhone', 6), fn('isName', 6)),
  'src/totals.ts': totals(false),
};
const HEAD: Record<string, string> = {
  'src/money.ts': text(fn('round', 8), fn('format', 8), fn('parse', 8), fn('cents', 8)),
  'src/validators.ts': text(fn('isPhone', 6), fn('isName', 6), fn('isEmail', 6)),
  'src/totals.ts': totals(true),
};
const OPENED_ROW = 'export const total45 = 45;';
const SHOWN_ROW = 'export const total30 = 300;';

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

function commitAll(dir: string, files: Record<string, string>, message: string) {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.email=e2e@example.com', '-c', 'user.name=e2e', 'commit', '-q', '-m', message);
}

let world: { url: string; project: string; claude: SimAgent; context: BrowserContext; page: Page };

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-inbox-semantic-scroll-e2e-');
  const dataDir = join(root, 'data');
  markTourDecided(dataDir);
  for (const dir of ['claude', 'codex', 'xdg']) mkdirSync(join(root, dir), { recursive: true });
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: root,
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  expect((await page.request.post(`${url}api/inbox/settings`, { data: { code_review: { on: true } } })).ok()).toBe(true);
  const project = scratchProject(join(root, 'src'), 'shop');
  git(project, 'checkout', '-q', '-b', 'main');
  commitAll(project, BASE, 'base');
  git(project, 'checkout', '-q', '-b', 'change');
  commitAll(project, HEAD, 'change');
  world = { url, project, claude: await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' }), context, page };
});

test.afterAll(async () => {
  await world?.context.close().catch(() => {});
  await world?.claude.close().catch(() => {});
  await removeInboxScratch();
});

async function holdEngine(page: Page) {
  await page.unroute('**/guide/file?*').catch(() => {});
  await page.route('**/guide/file?*', async (route) => {
    if (/money|validators/.test(route.request().url())) await new Promise((done) => setTimeout(done, 3_000));
    await route.continue().catch(() => {});
  });
}

async function openReview(title: string) {
  const patch = git(world.project, 'diff', 'main...HEAD');
  const review = await world.claude.submitGuide({
    project_path: world.project,
    guide: {
      title,
      intent: 'Reading it.',
      sections: [{ title: 'All', overview: 'Every file.', diffs: PATHS.map((file) => ({ file, summary: 'A change.' })) }],
      review: { gitRef: 'main...HEAD', base: 'main' },
      generator: { engine: 'claude-code', model: 'claude-opus-5' },
    },
    patch,
    body: 'Reading it.',
    review: true,
  } as never);
  const { page } = world;
  await holdEngine(page);
  await page.goto(`${world.url}#thread=${review.thread_id}`);
  await page.reload();
  await page.locator('[data-review-card]').filter({ hasText: title }).first().getByRole('button', { name: 'Start review' }).click();
  const pane = page.locator('[data-review-message]');
  await expect(pane.locator('[data-guide-file-shell]')).toHaveCount(PATHS.length, { timeout: 60_000 });
  await pane.locator('[data-review-mode-choice="files"]').click();
  await expect(pane).toHaveAttribute('data-review-mode', 'files');
}

const rowTop = (page: Page, row: string) =>
  page.evaluate((wanted) => {
    for (const host of document.querySelectorAll('diffs-container')) {
      for (const line of host.shadowRoot?.querySelectorAll('[data-line]') ?? []) if (line.textContent?.includes(wanted)) return Math.round(line.getBoundingClientRect().top);
    }
    return null;
  }, row);

const totalsLabel = (page: Page) =>
  page.evaluate(() => {
    const shell = document.querySelector('[data-guide-file-shell="src/totals.ts"]');
    const label = shell?.querySelector('diffs-container')?.shadowRoot?.querySelector('[data-unmodified-lines]');
    if (!label) return null;
    const box = label.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  });

async function bringTotalsLabelTo(page: Page, y: number) {
  await expect.poll(() => totalsLabel(page), { timeout: 30_000 }).not.toBeNull();
  await page.evaluate((at) => {
    const body = document.querySelector('.ib-gbody') as HTMLElement;
    const label = document.querySelector('[data-guide-file-shell="src/totals.ts"] diffs-container')!.shadowRoot!.querySelector('[data-unmodified-lines]')!;
    body.scrollTop += label.getBoundingClientRect().top - at;
  }, y);
  await page.waitForTimeout(300);
}

const notesLanded = (page: Page) => expect(page.locator('[data-semantic-note="semantic"]')).toHaveCount(2, { timeout: 45_000 });

for (const at of [640, 820]) {
  test(`lines opened in a file stay where they are on screen when the notes land in the files above it (label at ${at})`, async () => {
    const { page } = world;
    await openReview(`Opened lines ${at}`);
    await bringTotalsLabelTo(page, at);
    const label = (await totalsLabel(page))!;
    await page.mouse.move(label.x, label.y);
    await page.mouse.click(label.x, label.y);
    await expect.poll(() => rowTop(page, OPENED_ROW), { timeout: 15_000 }).not.toBeNull();
    await expect(page.locator('[data-semantic-note="semantic"]')).toHaveCount(0);
    await page.waitForTimeout(300);
    const before = await rowTop(page, OPENED_ROW);
    await notesLanded(page);
    await page.waitForTimeout(800);
    const after = await rowTop(page, OPENED_ROW);
    expect(Math.abs(after! - before!)).toBeLessThanOrEqual(2);
  });

  test(`with nothing opened, a row on screen stays where it is when the notes land in the files above it (label at ${at})`, async () => {
    const { page } = world;
    await openReview(`Nothing opened ${at}`);
    await bringTotalsLabelTo(page, at);
    await expect(page.locator('[data-semantic-note="semantic"]')).toHaveCount(0);
    const before = await rowTop(page, SHOWN_ROW);
    await notesLanded(page);
    await page.waitForTimeout(800);
    const after = await rowTop(page, SHOWN_ROW);
    expect(Math.abs(after! - before!)).toBeLessThanOrEqual(2);
  });
}
