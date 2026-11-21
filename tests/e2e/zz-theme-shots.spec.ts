import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';
import { markTourDecided } from '../helpers/tour-decided';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const out = resolve(process.env.SHOTS_DIR ?? join(repo, '.local/shots'));
const logFile = join(out, 'log.txt');
mkdirSync(out, { recursive: true });
const log = (s: string) => appendFileSync(logFile, s + '\n');

test.use({ actionTimeout: 15_000 });
test.describe.configure({ mode: 'serial' });

type Shot = 'plan' | 'plandiff' | 'review' | 'warn' | 'inbox' | 'picker';
interface Variant {
  name: string;
  theme: string;
  mode: 'light' | 'dark';
  orig?: boolean;
  strong?: boolean;
  shots: Shot[];
}

const ALL: Shot[] = ['plan', 'plandiff', 'review', 'warn', 'inbox', 'picker'];
const VARIANTS: Variant[] = [
  { name: 'tritanopia-light', theme: 'tritanopia', mode: 'light', shots: ALL },
  { name: 'tritanopia-dark', theme: 'tritanopia', mode: 'dark', shots: ALL },
  { name: 'tritanopia-dark-strong', theme: 'tritanopia', mode: 'dark', strong: true, shots: ['review'] },
  { name: 'tritanopia-orig-light', theme: 'tritanopia', mode: 'light', orig: true, shots: ['review', 'warn'] },
  { name: 'tritanopia-orig-dark', theme: 'tritanopia', mode: 'dark', orig: true, shots: ['review', 'warn'] },
  { name: 'tritanopia-orig-dark-strong', theme: 'tritanopia', mode: 'dark', orig: true, strong: true, shots: ['review'] },
  { name: 'nightfox-dark', theme: 'nightfox', mode: 'dark', shots: ALL },
  { name: 'colorblind-light', theme: 'colorblind', mode: 'light', shots: ['review'] },
  { name: 'colorblind-dark', theme: 'colorblind', mode: 'dark', shots: ['review'] },
  { name: 'night-owl-dark', theme: 'night-owl', mode: 'dark', shots: ['review'] },
].filter((v) => !process.env.ONLY || process.env.ONLY.split(',').includes(v.name)) as Variant[];

const ORIG_CSS = `
html.theme-tritanopia:not(.light) {
  --destructive: #d94862 !important;
  --destructive-foreground: #ffffff !important;
  --success: #18a4b8 !important;
  --warning: #e86b82 !important;
  --diffs-addition-color-override: #18a4b8 !important;
  --diffs-deletion-color-override: #d94862 !important;
}
html.theme-tritanopia.light {
  --success: #0d8294 !important;
  --warning: #b82944 !important;
  --diffs-addition-color-override: #0d8294 !important;
}`;

const FIRST_RUN: Record<string, string> = {
  'plannotator-announce-agent-tool-seen': '1',
  'plannotator-announce-ask-session-seen': '1',
  'plannotator-announce-inbox-seen': '1',
  'plannotator-announce-tui-herdr-seen': '1',
  'plannotator-auto-viewed-notice-seen': '1',
  'plannotator-edit-mode-announcement-seen': '3',
  'plannotator-guide-hint-acked': 'true',
  'plannotator-guide-intro-seen': '2',
  'plannotator-plan-look-choice-resolved': 'true',
  'plannotator-review-dest-spotlight-seen': '1',
  'plannotator-token-hover-announcement-seen': '1',
  'plannotator-permission-mode-configured': 'true',
};

function themeCookies(v: Variant): Record<string, string> {
  const c: Record<string, string> = {
    ...FIRST_RUN,
    'plannotator-theme': v.mode,
    'plannotator-light-theme': v.mode === 'light' ? v.theme : 'plannotator',
    'plannotator-dark-theme': v.mode === 'dark' ? v.theme : 'plannotator',
    'plannotator-color-theme': v.theme,
    'plannotator-diff-line-bg-intensity': v.strong ? 'strong' : 'subtle',
  };
  return c;
}

function themeConfig(v: Variant) {
  return {
    theme: { mode: v.mode, light: v.mode === 'light' ? v.theme : 'plannotator', dark: v.mode === 'dark' ? v.theme : 'plannotator' },
    diffOptions: { lineBgIntensity: v.strong ? 'strong' : 'subtle' },
  };
}

async function newContext(browser: Browser, v: Variant, url: string): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: v.mode, reducedMotion: 'reduce' });
  await context.addCookies(Object.entries(themeCookies(v)).map(([name, value]) => ({ name, value, url })));
  if (v.orig) {
    await context.addInitScript((css: string) => {
      const add = () => {
        const s = document.createElement('style');
        s.id = 'orig-colours';
        s.textContent = css;
        (document.head ?? document.documentElement).appendChild(s);
      };
      if (document.documentElement) add();
      else document.addEventListener('DOMContentLoaded', add);
    }, ORIG_CSS);
  }
  return context;
}

async function snap(page: Page, v: Variant, screen: string): Promise<void> {
  await page.waitForTimeout(600);
  const cls = await page.evaluate(() => document.documentElement.className).catch(() => '?');
  const ok = cls.includes(`theme-${v.theme}`) && cls.split(/\s+/).includes('light') === (v.mode === 'light');
  log(`${v.name} ${screen}: html class "${cls}" ${ok ? 'OK' : 'WRONG THEME'}`);
  await page.screenshot({ path: join(out, `${v.name}-${screen}.png`) });
}

async function dump(page: Page, v: Variant, screen: string, err: unknown): Promise<void> {
  log(`${v.name} ${screen}: FAILED ${String(err).split('\n').slice(0, 4).join(' | ')}`);
  const info = await page
    .evaluate(() => {
      const shown = (el: Element) => (el as HTMLElement).getClientRects().length > 0;
      const buttons = [...document.querySelectorAll('button')].filter(shown).map((b) => (b.getAttribute('aria-label') || b.getAttribute('title') || b.textContent || '').trim().slice(0, 40));
      const areas = [...document.querySelectorAll('textarea')].filter(shown).map((t) => t.getAttribute('placeholder'));
      return JSON.stringify({ buttons: buttons.slice(0, 80), areas });
    })
    .catch(() => '');
  log(`  ${info}`);
  await page.screenshot({ path: join(out, `zz-fail-${v.name}-${screen}.png`) }).catch(() => {});
}

const env0 = (root: string, readyFile: string) => ({
  PATH: process.env.PATH ?? '',
  HOME: root,
  PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
  PLANNOTATOR_DATA_DIR: join(root, 'data'),
  PLANNOTATOR_READY_FILE: readyFile,
  PLANNOTATOR_BROWSER: NO_BROWSER,
  NO_BROWSER,
  PLANNOTATOR_SKIP_BROWSER_OPEN: '1',
  PLANNOTATOR_REMOTE: '0',
  PLANNOTATOR_INBOX_CONNECT: '0',
  PLANNOTATOR_AI: 'disabled',
  PLANNOTATOR_UPDATE_CHECK: '0',
  PLANNOTATOR_GIT_REMOTE_CHECK: '0',
});

async function readyUrl(readyFile: string): Promise<string> {
  await expect.poll(() => (existsSync(readyFile) ? readFileSync(readyFile, 'utf8') : ''), { timeout: 30_000 }).toContain('"url"');
  return (JSON.parse(readFileSync(readyFile, 'utf8').trim().split('\n')[0]!) as { url: string }).url;
}

async function stop(child: ChildProcess, url: string, path: string, body?: unknown) {
  if (child.exitCode !== null) return;
  await fetch(new URL(path, url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) }).catch(() => {});
  await new Promise((done) => {
    const timer = setTimeout(done, 5_000);
    child.once('exit', () => {
      clearTimeout(timer);
      done(undefined);
    });
  });
  // inbox-guard: own child (the CLI this spec spawned, never an Inbox)
  if (child.exitCode === null) child.kill('SIGTERM');
}

const PLAN_V1 = [
  '# Move the invoice cache to Redis',
  '',
  'The cache lives in process memory today, so every deploy starts cold. Read [the design note](https://example.com/design) before reviewing.',
  '',
  '## Context',
  '',
  'Invoices are read about forty times for each write, and a cold cache costs two seconds on the first page.',
  '',
  '## Steps',
  '',
  '1. Add the Redis client behind a feature flag.',
  '2. Move reads first, then writes.',
  '3. Drop the in-memory map once reads are stable.',
  '',
  '## Rollback',
  '',
  'Turn the flag off. The in-memory map is still there until step three.',
  '',
  '## Timeline',
  '',
  'One week for reads, one week for writes, then a week of watching.',
  '',
].join('\n');

const PLAN_V2 = [
  '# Move the invoice cache to Redis',
  '',
  'The cache lives in process memory today, so every deploy starts cold. Read [the design note](https://example.com/design) before reviewing.',
  '',
  '## Context',
  '',
  'Invoices are read about forty times for each write, and a cold cache costs two seconds on the first page and four on the dashboard.',
  '',
  '## Steps',
  '',
  '1. Add the Redis client behind a feature flag.',
  '2. Move reads first, then writes.',
  '3. Drop the in-memory map once reads are stable.',
  '',
  '```ts',
  'const client = createClient({ url: process.env.REDIS_URL });',
  'export async function readInvoice(id: string): Promise<Invoice | null> {',
  "  const hit = await client.get(`invoice:${id}`);",
  '  return hit ? (JSON.parse(hit) as Invoice) : null;',
  '}',
  '```',
  '',
  '## Budget',
  '',
  '| Item | Today | After |',
  '| --- | --- | --- |',
  '| First page, cold | 2.0 s | 0.2 s |',
  '| Memory per pod | 1.4 GB | 300 MB |',
  '| Monthly cost | $0 | $45 |',
  '',
  '## Timeline',
  '',
  'Two weeks for reads and writes together, then a week of watching.',
  '',
].join('\n');

interface Plan {
  url: string;
  close: () => Promise<void>;
}

async function startPlan(root: string, plan: string, n: number): Promise<{ url: string; child: ChildProcess }> {
  const readyFile = join(root, `ready-${n}.jsonl`);
  const child = spawn(binary, [], { env: env0(root, readyFile), cwd: join(root, 'proj'), stdio: ['pipe', 'ignore', 'ignore'] });
  child.stdin!.end(
    JSON.stringify({
      session_id: 'e2e-shots',
      transcript_path: join(root, 'transcript.jsonl'),
      cwd: join(root, 'proj'),
      permission_mode: 'plan',
      hook_event_name: 'PermissionRequest',
      tool_name: 'ExitPlanMode',
      tool_input: { plan },
    }),
  );
  return { url: await readyUrl(readyFile), child };
}

async function planReview(v: Variant): Promise<Plan> {
  const root = inboxScratch('pn-shots-plan-');
  mkdirSync(join(root, 'data'), { recursive: true });
  mkdirSync(join(root, 'proj'), { recursive: true });
  const first = await startPlan(root, PLAN_V1, 1);
  await stop(first.child, first.url, '/api/deny', { feedback: 'Please merge the reads and writes weeks and add a budget.', planSave: { enabled: false } });
  const second = await startPlan(root, PLAN_V2, 2);
  return {
    url: second.url,
    close: async () => {
      await stop(second.child, second.url, '/api/deny', { feedback: 'teardown', planSave: { enabled: false } });
      await removeInboxScratch(root);
    },
  };
}

async function selectText(page: Page, needle: string): Promise<void> {
  const box = await page.evaluate((text) => {
    const root = document.querySelector('[data-print-region="content"]') ?? document.body;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent?.indexOf(text) ?? -1;
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + text.length);
      (node.parentElement as HTMLElement).scrollIntoView({ block: 'center' });
      const rects = [...range.getClientRects()];
      const first = rects[0]!;
      const last = rects[rects.length - 1]!;
      return { x1: first.left + 1, y1: first.top + first.height / 2, x2: last.right - 1, y2: last.top + last.height / 2 };
    }
    return null;
  }, needle);
  if (!box) throw new Error(`text not found: ${needle}`);
  await page.mouse.move(box.x1, box.y1);
  await page.mouse.down();
  await page.mouse.move(box.x2, box.y2, { steps: 10 });
  await page.mouse.up();
  await expect(page.locator('.annotation-toolbar')).toBeVisible();
}

async function annotate(page: Page, v: Variant): Promise<void> {
  const steps: [string, () => Promise<void>][] = [
    [
      'comment',
      async () => {
        await selectText(page, 'a cold cache costs two seconds');
        await page.locator('.annotation-toolbar button[aria-label="Comment"]').click();
        await page.locator('[data-comment-popover] textarea').last().fill('Is that measured in production or on a laptop?');
        await page.locator('[data-comment-popover]').getByRole('button', { name: /^(Comment|Add)$/ }).last().click();
      },
    ],
    [
      'delete',
      async () => {
        await selectText(page, 'then a week of watching');
        await page.locator('.annotation-toolbar button[aria-label="Delete"]').click();
      },
    ],
    [
      'looks-good',
      async () => {
        await selectText(page, 'Move reads first, then writes.');
        await page.locator('.annotation-toolbar button[aria-label="Looks good"]').click();
      },
    ],
    [
      'global',
      async () => {
        await page.getByRole('button', { name: 'Global comment', exact: true }).click();
        const composer = page.locator('[data-comment-popover]');
        await composer.getByPlaceholder('Add a global comment...').fill('Good plan overall. Keep the flag for a release after step three.');
        await composer.getByRole('button', { name: 'Add', exact: true }).click();
      },
    ],
  ];
  for (const [label, run] of steps) {
    try {
      await run();
      await page.waitForTimeout(300);
    } catch (err) {
      await dump(page, v, `annotate-${label}`, err);
      await page.keyboard.press('Escape').catch(() => {});
    }
  }
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
}

async function planShots(browser: Browser, v: Variant): Promise<void> {
  const plan = await planReview(v);
  const context = await newContext(browser, v, plan.url);
  const page = await context.newPage();
  try {
    await page.goto(plan.url);
    await expect(page.getByRole('heading', { name: 'Move the invoice cache to Redis' }).first()).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(1200);
    if (v.shots.includes('plan')) {
      await annotate(page, v);
      await page.evaluate(() => window.scrollTo(0, 0));
      await snap(page, v, 'plan-review');
      await page.getByText('Budget', { exact: true }).first().scrollIntoViewIfNeeded().catch(() => {});
      await snap(page, v, 'plan-review-lower');
    }
    if (v.shots.includes('plandiff') || v.shots.includes('warn')) {
      try {
        await page.getByTitle('Show what changed from previous version').first().click();
        await expect(page.locator('.plan-diff-added, .plan-diff-removed, .plan-diff-modified').first()).toBeVisible();
        const counts = await page.evaluate(() => ['added', 'removed', 'modified'].map((k) => `${k}=${document.querySelectorAll(`.plan-diff-${k}`).length}`).join(' '));
        log(`${v.name} plan diff blocks: ${counts}`);
        await page.evaluate(() => window.scrollTo(0, 0));
        if (v.shots.includes('plandiff')) await snap(page, v, 'plan-diff');
        if (v.shots.includes('warn')) {
          const target = page.locator('.plan-diff-modified').last();
          await target.scrollIntoViewIfNeeded();
          await page.evaluate(() => {
            const el = [...document.querySelectorAll('.plan-diff-modified')].pop();
            el?.scrollIntoView({ block: 'center' });
          });
          await snap(page, v, 'warning-near-destructive');
        }
      } catch (err) {
        await dump(page, v, 'plan-diff', err);
      }
    }
    if (v.shots.includes('picker')) {
      try {
        await page.getByTitle('Settings', { exact: true }).first().click();
        await page.getByRole('button', { name: 'Theme', exact: true }).first().click();
        const half = v.mode === 'dark' ? 'Dark' : 'Light';
        await page.getByRole('button', { name: `${half} theme`, exact: true }).first().click().catch(() => {});
        const name = v.theme === 'nightfox' ? 'Nightfox' : 'Tritanopia';
        const tile = page.getByRole('button', { name: new RegExp(name) }).first();
        await tile.scrollIntoViewIfNeeded();
        await page.waitForTimeout(400);
        await snap(page, v, 'theme-picker');
      } catch (err) {
        await dump(page, v, 'theme-picker', err);
      }
    }
  } catch (err) {
    await dump(page, v, 'plan', err);
  } finally {
    await context.close();
    await plan.close();
  }
}

function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
}
function write(dir: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

const BASE: Record<string, string> = {
  'src/billing/retry.ts': [
    "import { sleep } from '../util/sleep';",
    '',
    'export interface RetryOptions {',
    '  attempts: number;',
    '  delayMs: number;',
    '}',
    '',
    'export async function withRetry<T>(run: () => Promise<T>, options: RetryOptions): Promise<T> {',
    '  let last: unknown;',
    '  for (let i = 0; i < options.attempts; i++) {',
    '    try {',
    '      return await run();',
    '    } catch (err) {',
    '      last = err;',
    '      await sleep(options.delayMs);',
    '    }',
    '  }',
    '  throw last;',
    '}',
    '',
  ].join('\n'),
  'src/billing/schedule.ts': ["export const NIGHTLY = '0 3 * * *';", "export const HOURLY = '0 * * * *';", "export const LEGACY_WEEKLY = '0 4 * * 0';", ''].join('\n'),
  'src/util/sleep.ts': 'export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));\n',
};
const HEAD: Record<string, string> = {
  'src/billing/retry.ts': [
    "import { sleep } from '../util/sleep';",
    '',
    'export interface RetryOptions {',
    '  attempts: number;',
    '  baseDelayMs: number;',
    '  maxDelayMs?: number;',
    '}',
    '',
    'export async function withRetry<T>(run: () => Promise<T>, options: RetryOptions): Promise<T> {',
    '  let last: unknown;',
    '  for (let i = 0; i < options.attempts; i++) {',
    '    try {',
    '      return await run();',
    '    } catch (err) {',
    '      last = err;',
    '      const wait = Math.min(options.baseDelayMs * 2 ** i, options.maxDelayMs ?? Infinity);',
    '      await sleep(wait);',
    '    }',
    '  }',
    '  throw last;',
    '}',
    '',
  ].join('\n'),
  'src/billing/schedule.ts': ["export const NIGHTLY = '0 3 * * *';", "export const HOURLY = '0 * * * *';", ''].join('\n'),
  'src/billing/jitter.ts': ['export function jitter(ms: number, spread = 0.2): number {', '  const delta = ms * spread;', '  return ms - delta + Math.random() * delta * 2;', '}', ''].join('\n'),
};

async function measureDiff(page: Page): Promise<string> {
  return page.evaluate(() => {
    const found: Record<string, string> = {};
    const walk = (root: Document | ShadowRoot) => {
      for (const type of ['change-addition', 'change-deletion']) {
        if (found[type]) continue;
        const line = root.querySelector(`[data-line-type="${type}"][data-line]`) as HTMLElement | null;
        if (line) {
          const span = line.querySelector('span') as HTMLElement | null;
          found[type] = `bg ${getComputedStyle(line).backgroundColor} text ${getComputedStyle(span ?? line).color}`;
        }
      }
      for (const el of root.querySelectorAll('*')) if ((el as HTMLElement).shadowRoot) walk((el as HTMLElement).shadowRoot!);
    };
    walk(document);
    const page = getComputedStyle(document.body).backgroundColor;
    return `page ${page}; add ${found['change-addition'] ?? '-'}; del ${found['change-deletion'] ?? '-'}`;
  });
}

async function reviewShots(browser: Browser, v: Variant): Promise<void> {
  const root = inboxScratch('pn-shots-review-');
  mkdirSync(join(root, 'data'), { recursive: true });
  const cwd = join(root, 'repo');
  mkdirSync(cwd, { recursive: true });
  git(cwd, 'init', '-q', '-b', 'main');
  git(cwd, 'config', 'user.email', 'e2e@example.com');
  git(cwd, 'config', 'user.name', 'e2e');
  write(cwd, BASE);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', 'base');
  write(cwd, HEAD);
  git(cwd, 'add', '-A');
  const readyFile = join(root, 'ready.jsonl');
  const child = spawn(binary, ['review'], { env: env0(root, readyFile), cwd, stdio: 'ignore' });
  const url = await readyUrl(readyFile);
  const context = await newContext(browser, v, url);
  const page = await context.newPage();
  try {
    await page.goto(url);
    await expect(page.locator('diffs-container [data-column-number]').first()).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(1500);
    try {
      const at = await page.evaluate(() => {
        let best: { x: number; y: number } | null = null;
        const walk = (root: Document | ShadowRoot) => {
          for (const el of root.querySelectorAll('[data-column-number]')) {
            if ((el.textContent ?? '').trim() !== '16') continue;
            const r = (el as HTMLElement).getBoundingClientRect();
            if (r.width > 0 && (!best || r.x > best.x)) best = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          }
          for (const el of root.querySelectorAll('*')) if ((el as HTMLElement).shadowRoot) walk((el as HTMLElement).shadowRoot!);
        };
        walk(document);
        return best;
      });
      if (!at) throw new Error('no line 16');
      await page.mouse.move(at.x, at.y);
      await page.waitForTimeout(400);
      const utility = page.locator('diffs-container [data-utility-button]').first();
      if (await utility.count()) await utility.click();
      else await page.mouse.click(at.x, at.y);
      await page.waitForTimeout(600);
      const area = page.locator('textarea:visible').last();
      await area.fill('Cap the wait: with ten attempts this sleeps for eight minutes.', { timeout: 5_000 });
      const add = page.getByRole('button', { name: /^(Comment|Add comment|Add|Save)$/ }).last();
      await add.click({ timeout: 5_000 });
      await page.waitForTimeout(600);
    } catch (err) {
      await dump(page, v, 'review-comment', err);
      await page.keyboard.press('Escape').catch(() => {});
    }
    log(`${v.name} diff colours: ${await measureDiff(page)}`);
    await snap(page, v, 'code-review');
  } catch (err) {
    await dump(page, v, 'review', err);
  } finally {
    await context.close();
    await stop(child, url, '/api/exit');
    await removeInboxScratch(root);
  }
}

async function inboxShots(browser: Browser, v: Variant): Promise<void> {
  const root = inboxScratch('pn-shots-inbox-');
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify(themeConfig(v)));
  markTourDecided(dataDir);
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9', PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_UPDATE_CHECK: '0', PLANNOTATOR_TEST_SANDBOX: '1' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  const url = started.stdout.trim();
  const project = scratchProject(join(root, 'src'), 'billing');
  mkdirSync(join(project, 'docs'), { recursive: true });
  writeFileSync(join(project, 'docs', 'retry-plan.md'), '# Retry plan\n\nExponential backoff, capped at thirty seconds, with jitter.\n');
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  let thread = '';
  try {
    const first = await claude.send({ project_path: project, subject: 'Payout retries: cap the backoff?', thread: 'retries', body: 'Retries now back off exponentially. Tests pass: **42 passed, 0 failed**.\n\n```ts\nconst wait = Math.min(base * 2 ** i, max);\n```' });
    thread = first.thread_id as string;
    await new Promise((r) => setTimeout(r, 30));
    await claude.send({ project_path: project, thread: 'retries', attachments: ['docs/retry-plan.md'], body: ['One decision before I merge.', '', ':::question', 'Where should the backoff cap sit?', '', '- [ ] 30 seconds', '- [ ] 2 minutes', '- [ ] No cap', ':::'].join('\n') });
    await claude.send({ project_path: project, subject: 'Nightly build failed on main', body: 'The nightly build failed: `schedule.test.ts` times out after 5 s. I am looking at it.' });
    await claude.send({ project_path: project, subject: 'Invoice list layout', body: 'Cards or a dense table for the invoice list?' });
  } catch (err) {
    log(`${v.name} inbox seed FAILED ${String(err)}`);
  }
  const context = await newContext(browser, v, url);
  const page = await context.newPage();
  try {
    await page.goto(`${url}#thread=${thread}`);
    await page.waitForTimeout(2500);
    if (await page.locator('[role="dialog"]:visible').count()) {
      log(`${v.name} inbox: a dialog was open, pressing Escape`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
    }
    await snap(page, v, 'inbox');
  } catch (err) {
    await dump(page, v, 'inbox', err);
  } finally {
    await context.close();
    await claude.close().catch(() => {});
    await removeInboxScratch(root);
  }
}

test.afterAll(async () => {
  await removeInboxScratch();
});

for (const v of VARIANTS) {
  test(`theme shots: ${v.name}`, async ({ browser }) => {
    test.setTimeout(240_000);
    expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
    if (v.shots.some((s) => s === 'plan' || s === 'plandiff' || s === 'warn' || s === 'picker')) await planShots(browser, v);
    if (v.shots.includes('review')) await reviewShots(browser, v);
    if (v.shots.includes('inbox')) await inboxShots(browser, v);
  });
}
