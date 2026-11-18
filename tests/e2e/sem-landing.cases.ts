/**
 * Once the person has started reading, a semantic note landing late never moves a row they can see: the files on
 * screen (or above it, or near the end of the page) are offered the note in their header, and one click shows it;
 * files wholly below take it by themselves. Run in both hosts (the review window and the Inbox's review) by
 * `sem-landing.spec.ts` (Chromium) and `sem-landing-webkit.spec.ts` (WebKit) against the compiled binary. The watcher
 * finds rows by their file, line number and text only, apart from any rule of the product's.
 */

import { expect, test, type Browser, type BrowserContext, type BrowserType, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';
import { openReview as openReviewWindow, reviewOf } from './review-scratch-session';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));

const text = (...blocks: string[][]) => blocks.flat().join('\n');
const body = (name: string, lines: string[]) => [`export function ${name}(value: number): number {`, ...lines.map((line) => `  ${line}`), '  return value;', '}', ''];
const steps = (name: string, count: number, edit = -1) => Array.from({ length: count }, (_, i) => `value += ${i === edit ? 50 : i}; // ${name}`);
const shrinks = (name: string): [string, string] => [
  text(body(`${name}Big`, steps(name, 12)), body(`${name}Tiny`, ['value -= 1;'])),
  text(body(`${name}Tiny`, ['value -= 1;']), body(`${name}Big`, steps(name, 12, 5))),
];
const plain = (name: string, count: number) => (changed: boolean) =>
  Array.from({ length: count }, (_, i) => `export const ${name}${i + 1} = ${changed && (i < 30 || i % 25 === 0) ? (i + 1) * 10 : i + 1};`).join('\n') + '\n';
const pair = (make: (changed: boolean) => string): [string, string] => [make(false), make(true)];

const FILES: [string, [string, string]][] = [
  ['src/a-money.ts', shrinks('money')],
  ['src/b-totals.ts', pair(plain('total', 80))],
  ['src/c-names.ts', shrinks('names')],
  ['src/d-list.ts', pair(plain('item', 160))],
  ['src/e-dates.ts', shrinks('dates')],
  ['src/f-tail.ts', shrinks('tail')],
];
const swapping = /(money|names|dates|tail)/;
const base = Object.fromEntries(FILES.map(([path, [old]]) => [path, old]));
const head = Object.fromEntries(FILES.map(([path, [, now]]) => [path, now]));

export type Host = 'review' | 'inbox';
interface View {
  page: Page;
  scroller: string;
  shell: (file: string) => string;
  reads: Set<string>;
  close: () => Promise<void>;
}

function delay(page: Page, pattern: string, reads: Set<string>) {
  void page.route(pattern, async (route) => {
    const found = swapping.exec(decodeURIComponent(route.request().url()));
    if (found) await new Promise((done) => setTimeout(done, 1_500));
    await route.continue().catch(() => {});
    if (found) reads.add(found[1]!);
  });
  void page.route('**/assets/sem-diff/**', async (route) => {
    await new Promise((done) => setTimeout(done, 800));
    await route.continue().catch(() => {});
  });
}

const firstRows = (page: Page) =>
  expect.poll(() => page.evaluate(() => [...document.querySelectorAll('diffs-container')].some((host) => host.shadowRoot?.querySelector('[data-line]'))), { timeout: 30_000 }).toBe(true);

async function reviewWindow(browser: Browser): Promise<View> {
  const session = await reviewOf(`sem-landing-${Math.random().toString(36).slice(2, 8)}`, base, head);
  const reads = new Set<string>();
  const { context, page } = await openReviewWindow(browser, session.url, async (page) => delay(page, '**/api/file-content?*', reads));
  await firstRows(page);
  await page.evaluate(() => {
    let scroller: HTMLElement | null = document.querySelector('diffs-container')!.parentElement;
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    scroller!.setAttribute('data-e2e-scroller', '');
  });
  return {
    page,
    scroller: '[data-e2e-scroller]',
    shell: (file) => `diffs-container:has([data-file-header-path="src/${file}.ts"])`,
    reads,
    close: async () => {
      await context.close();
      await session.close();
    },
  };
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

function commitAll(dir: string, files: Record<string, string>, message: string) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.email=e2e@example.com', '-c', 'user.name=e2e', 'commit', '-q', '-m', message);
}

interface Inbox {
  url: string;
  root: string;
  claude: SimAgent;
}

function inboxWorld(browser: () => Browser): () => Inbox {
  let world: Inbox;
  test.beforeAll(async () => {
    expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
    const root = inboxScratch('plannotator-sem-landing-e2e-');
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
    const settings = await (await browser().newContext()).request.post(`${url}api/inbox/settings`, { data: { code_review: { on: true } } });
    expect(settings.ok()).toBe(true);
    world = { url, root, claude: await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' }) };
  });
  test.afterAll(async () => {
    await world?.claude.close().catch(() => {});
    await removeInboxScratch();
  });
  return () => world;
}

let projects = 0;

async function inboxReview(browser: Browser, world: Inbox): Promise<View> {
  const project = scratchProject(join(world.root, 'src'), `shop${++projects}`);
  git(project, 'checkout', '-q', '-b', 'main');
  commitAll(project, base, 'base');
  git(project, 'checkout', '-q', '-b', 'change');
  commitAll(project, head, 'change');
  const title = `Landing ${projects}`;
  const review = await world.claude.submitGuide({
    project_path: project,
    guide: {
      title,
      intent: 'Reading it.',
      sections: [{ title: 'All', overview: 'Every file.', diffs: FILES.map(([file]) => ({ file, summary: 'A change.' })) }],
      review: { gitRef: 'main...HEAD', base: 'main' },
      generator: { engine: 'claude-code', model: 'claude-opus-5' },
    },
    patch: git(project, 'diff', 'main...HEAD'),
    body: 'Reading it.',
    review: true,
  } as never);
  const context: BrowserContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce' });
  const page = await context.newPage();
  const reads = new Set<string>();
  delay(page, '**/guide/file?*', reads);
  await page.goto(`${world.url}#thread=${review.thread_id}`);
  await page.locator('[data-review-card]').filter({ hasText: title }).first().getByRole('button', { name: 'Start review' }).click();
  const pane = page.locator('[data-review-message]');
  await expect(pane.locator('[data-guide-file-shell]')).toHaveCount(FILES.length, { timeout: 60_000 });
  await pane.locator('[data-review-mode-choice="files"]').click();
  await expect(pane).toHaveAttribute('data-review-mode', 'files');
  await firstRows(page);
  return { page, scroller: '.ib-gbody', shell: (file) => `[data-guide-file-shell="src/${file}.ts"]`, reads, close: () => context.close() };
}

const watch = (view: View) =>
  view.page.evaluate((selector) => {
    const scroller = document.querySelector(selector) as HTMLElement;
    const w = window as unknown as { __moves: { worst: number; frames: number; scrolls: Set<number>; on: boolean } };
    w.__moves = { worst: 0, frames: 0, scrolls: new Set(), on: true };
    const snapshot = () => {
      const view = scroller.getBoundingClientRect();
      const top = Math.max(0, view.top);
      const bottom = Math.min(innerHeight, view.bottom);
      const rows = new Map<string, number[]>();
      for (const host of document.querySelectorAll('diffs-container')) {
        const file = host.closest('[data-guide-file-shell]')?.getAttribute('data-guide-file-shell') ?? host.querySelector('[data-file-header-path]')?.getAttribute('data-file-header-path') ?? '';
        for (const row of host.shadowRoot?.querySelectorAll('[data-code] [data-line]') ?? []) {
          const box = row.getBoundingClientRect();
          if (box.height === 0 || box.bottom <= top || box.top >= bottom) continue;
          const column = row.closest('[data-deletions]') ? 'd' : row.closest('[data-additions]') ? 'a' : 'u';
          const key = `${file}|${column}|${row.getAttribute('data-line')}|${(row.textContent ?? '').trim()}`;
          rows.set(key, [...(rows.get(key) ?? []), box.top].sort((a, b) => a - b));
        }
      }
      return rows;
    };
    let last = snapshot();
    const painted = new MessageChannel();
    painted.port1.onmessage = () => {
      const now = snapshot();
      w.__moves.frames++;
      w.__moves.scrolls.add(Math.round(scroller.scrollTop));
      for (const [key, tops] of now) {
        const before = last.get(key);
        if (!before || before.length !== tops.length) continue;
        for (const [i, top] of tops.entries()) w.__moves.worst = Math.max(w.__moves.worst, Math.abs(top - before[i]!));
      }
      last = now;
    };
    const step = () => {
      if (!w.__moves.on) return;
      painted.port2.postMessage(0);
      requestAnimationFrame(step);
    };
    step();
  }, view.scroller);

const moved = (view: View) =>
  view.page.evaluate(() => {
    const w = window as unknown as { __moves: { worst: number; frames: number; scrolls: Set<number>; on: boolean } };
    w.__moves.on = false;
    return { worst: w.__moves.worst, frames: w.__moves.frames, scrolls: [...w.__moves.scrolls] };
  });

const landed = async (view: View, count: number) => {
  await expect.poll(() => view.reads.size, { timeout: 45_000 }).toBeGreaterThanOrEqual(count);
  await view.page.waitForTimeout(2_000);
};

const noteOf = (view: View, file: string) => view.page.evaluate((selector) => document.querySelector(`${selector} [data-semantic-note]`)?.getAttribute('data-semantic-note') ?? null, view.shell(file));

const edgeOf = (view: View, file: string) =>
  view.page.evaluate(
    ({ selector, scroller }) => {
      const shell = document.querySelector(selector);
      const view = document.querySelector(scroller)!.getBoundingClientRect();
      const box = shell?.getBoundingClientRect();
      return box ? { top: box.top - Math.max(0, view.top), bottom: Math.min(innerHeight, view.bottom) - box.top } : null;
    },
    { selector: view.shell(file), scroller: view.scroller },
  );

async function wheelUntil(view: View, done: () => Promise<boolean>, by = 120) {
  const box = (await view.page.evaluate((selector) => document.querySelector(selector)!.getBoundingClientRect().toJSON(), view.scroller)) as DOMRect;
  await view.page.mouse.move(box.x + box.width / 2, Math.max(box.y, 0) + 300);
  for (let i = 0; i < 200 && !(await done()); i++) {
    await view.page.mouse.wheel(0, by);
    await view.page.waitForTimeout(40);
  }
  expect(await done()).toBe(true);
}

async function justBelow(view: View, file: string) {
  const below = async () => {
    const edge = await edgeOf(view, file);
    return edge != null && -edge.bottom > 80 && -edge.bottom < 180;
  };
  await wheelUntil(view, async () => ((await edgeOf(view, file))?.bottom ?? -1000) > -400, 300);
  for (let i = 0; i < 40 && !(await below()); i++) {
    await view.page.mouse.wheel(0, -(await edgeOf(view, file))!.bottom > 130 ? 20 : -20);
    await view.page.waitForTimeout(40);
  }
  expect(await below()).toBe(true);
  return below;
}

const still = async (view: View) => {
  const seen = await moved(view);
  console.log(`[sem-landing] ${JSON.stringify(seen)}`);
  expect(seen.frames).toBeGreaterThan(60);
  expect(seen.worst).toBeLessThanOrEqual(0.5);
  expect(seen.scrolls).toHaveLength(1);
};

export function landingCases(type: BrowserType) {
  let browser: Browser;
  test.beforeAll(async () => {
    browser = await type.launch({ headless: true });
  });
  test.afterAll(async () => {
    await browser?.close();
  });
  const inbox = inboxWorld(() => browser);
  const open = (host: Host) => (host === 'review' ? reviewWindow(browser) : inboxReview(browser, inbox()));

  for (const host of ['review', 'inbox'] as const) {
    test.describe(host, () => {
      test('a little scroll before the notes land: nothing on screen moves, its files are offered the note, a file below takes it', async () => {
        const view = await open(host);
        try {
          await view.page.mouse.move(640, 500);
          await view.page.mouse.wheel(0, 200);
          await view.page.waitForTimeout(300);
          await watch(view);
          await landed(view, 1);
          await still(view);
          expect(await noteOf(view, 'a-money')).toBe('off');
          await view.page.locator(`${view.shell('a-money')} [data-semantic-note="off"]`).click();
          await expect.poll(() => noteOf(view, 'a-money')).toBe('semantic');
        } finally {
          await view.close();
        }
      });

      test('a file just below the bottom edge when its note lands takes it by itself, and nothing on screen moves', async () => {
        const view = await open(host);
        try {
          const below = await justBelow(view, 'e-dates');
          expect(view.reads.has('dates')).toBe(false);
          await watch(view);
          await expect.poll(() => view.reads.has('dates'), { timeout: 45_000 }).toBe(true);
          await view.page.waitForTimeout(2_000);
          await still(view);
          expect(await below()).toBe(true);
          await wheelUntil(view, async () => ((await edgeOf(view, 'e-dates'))?.bottom ?? -1) > 200);
          expect(await noteOf(view, 'e-dates')).toBe('semantic');
        } finally {
          await view.close();
        }
      });

      test('a file below when its read began and on screen when its note lands is offered the note, and nothing moves', async () => {
        const view = await open(host);
        try {
          await wheelUntil(view, async () => {
            const edge = await edgeOf(view, 'c-names');
            return edge != null && edge.top < 400 && edge.top > 100 && view.reads.size === 0;
          }, 60);
          await watch(view);
          await landed(view, 2);
          await still(view);
          expect(await noteOf(view, 'c-names')).toBe('off');
        } finally {
          await view.close();
        }
      });

      test('within a screen of the end of the page, a file below is offered its note, and nothing moves', async () => {
        const view = await open(host);
        try {
          const below = await justBelow(view, 'f-tail');
          expect(view.reads.has('tail')).toBe(false);
          await watch(view);
          await expect.poll(() => view.reads.has('tail'), { timeout: 45_000 }).toBe(true);
          await view.page.waitForTimeout(2_000);
          await still(view);
          expect(await below()).toBe(true);
          expect(await noteOf(view, 'f-tail')).toBe('off');
        } finally {
          await view.close();
        }
      });

      test('an arrow in a file whose note lands while it is held down still opens its lines', async () => {
        const view = await open(host);
        try {
          const arrow = () =>
            view.page.evaluate((selector) => {
              const host = document.querySelector(selector)?.matches('diffs-container') ? document.querySelector(selector) : document.querySelector(`${selector} diffs-container`);
              const found = [...(host?.shadowRoot?.querySelectorAll('[data-expand-button]') ?? [])].find((each) => {
                const box = each.getBoundingClientRect();
                return box.height > 0 && box.top > 120 && box.bottom < 860;
              });
              const box = found?.getBoundingClientRect();
              return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2, rows: host!.shadowRoot!.querySelectorAll('[data-line]').length } : null;
            }, view.shell('a-money'));
          await expect.poll(arrow, { timeout: 30_000 }).not.toBeNull();
          const at = (await arrow())!;
          await view.page.mouse.move(at.x, at.y);
          await view.page.mouse.down();
          await expect.poll(() => view.reads.has('money'), { timeout: 45_000 }).toBe(true);
          await view.page.waitForTimeout(900);
          await view.page.mouse.up();
          await expect
            .poll(() => view.page.evaluate((selector) => {
              const host = document.querySelector(selector)?.matches('diffs-container') ? document.querySelector(selector) : document.querySelector(`${selector} diffs-container`);
              return host?.shadowRoot?.querySelectorAll('[data-line]').length ?? 0;
            }, view.shell('a-money')))
            .toBeGreaterThan(at.rows);
        } finally {
          await view.close();
        }
      });
    });
  }
}
