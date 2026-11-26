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
const swapping = /(money|names|dates|tail|f18)/;
const MANY: [string, [string, string]][] = Array.from({ length: 20 }, (_, i) => {
  const name = `f${String(i + 1).padStart(2, '0')}`;
  return [`src/${name}.ts`, i === 17 ? shrinks(name) : pair(plain(name, 40))];
});
const sides = (files: typeof FILES) => [Object.fromEntries(files.map(([path, [old]]) => [path, old])), Object.fromEntries(files.map(([path, [, now]]) => [path, now]))] as const;
const [base, head] = sides(FILES);

export type Host = 'review' | 'inbox';
interface View {
  page: Page;
  scroller: string;
  shell: (file: string) => string;
  reads: Set<string>;
  requested: Set<string>;
  release: (name: string) => void;
  close: () => Promise<void>;
}

function delay(page: Page, pattern: string, reads: Set<string>, requested: Set<string>, held: string[]) {
  const gates = new Map(held.map((name) => {
    let open = () => {};
    const gate = new Promise<void>((done) => (open = done));
    return [name, { gate, open }] as const;
  }));
  void page.route(pattern, async (route) => {
    const found = swapping.exec(decodeURIComponent(route.request().url()));
    if (found) requested.add(found[1]!);
    if (found) await (gates.get(found[1]!)?.gate ?? new Promise((done) => setTimeout(done, 1_500)));
    await route.continue().catch(() => {});
    if (found) reads.add(found[1]!);
  });
  void page.route('**/assets/sem-diff/**', async (route) => {
    await new Promise((done) => setTimeout(done, 800));
    await route.continue().catch(() => {});
  });
  return (name: string) => gates.get(name)?.open();
}

const markScroller = (page: Page) =>
  page.evaluate(() => {
    let scroller: HTMLElement | null = document.querySelector('diffs-container')!.parentElement;
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    scroller!.setAttribute('data-e2e-scroller', '');
  });

const firstRows = (page: Page) =>
  expect.poll(() => page.evaluate(() => [...document.querySelectorAll('diffs-container')].some((host) => host.shadowRoot?.querySelector('[data-line]'))), { timeout: 30_000 }).toBe(true);

const PHONE = (browser: Browser, width = 390) => ({ viewport: { width, height: 844 }, hasTouch: true, isMobile: browser.browserType().name() === 'chromium', colorScheme: 'light' as const });

async function reviewWindow(browser: Browser, held: string[], phone: boolean | number = false): Promise<View> {
  const session = await reviewOf(`sem-landing-${Math.random().toString(36).slice(2, 8)}`, base, head);
  const reads = new Set<string>();
  const requested = new Set<string>();
  let release = (_name: string) => {};
  const { context, page } = await openReviewWindow(browser, session.url, async (page) => void (release = delay(page, '**/api/file-content?*', reads, requested, held)), phone ? PHONE(browser, phone === true ? undefined : phone) : undefined);
  await firstRows(page);
  await markScroller(page);
  return {
    page,
    scroller: '[data-e2e-scroller]',
    shell: (file) => `diffs-container:has([data-file-header-path="src/${file}.ts"])`,
    reads,
    requested,
    release: (name) => release(name),
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

async function inboxReview(browser: Browser, world: Inbox, held: string[], phone: boolean | number = false, files = FILES): Promise<View> {
  const [base, head] = sides(files);
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
      sections: [{ title: 'All', overview: 'Every file.', diffs: files.map(([file]) => ({ file, summary: 'A change.' })) }],
      review: { gitRef: 'main...HEAD', base: 'main' },
      generator: { engine: 'claude-code', model: 'claude-opus-5' },
    },
    patch: git(project, 'diff', 'main...HEAD'),
    body: 'Reading it.',
    review: true,
  } as never);
  const context: BrowserContext = await browser.newContext(
    phone ? { ...PHONE(browser, phone === true ? undefined : phone), reducedMotion: 'reduce' } : { viewport: { width: 1280, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce' },
  );
  const page = await context.newPage();
  const reads = new Set<string>();
  const requested = new Set<string>();
  const release = delay(page, '**/guide/file?*', reads, requested, held);
  await page.goto(`${world.url}#thread=${review.thread_id}`);
  await page.locator('[data-review-card]').filter({ hasText: title }).first().getByRole('button', { name: 'Start review' }).click();
  const pane = page.locator('[data-review-message]');
  await expect(pane.locator('[data-guide-file-shell]')).toHaveCount(files.length, { timeout: 60_000 });
  if (!phone) {
    await pane.locator('[data-review-mode-choice="files"]').click();
    await expect(pane).toHaveAttribute('data-review-mode', 'files');
  }
  await firstRows(page);
  return { page, scroller: '.ib-gbody', shell: (file) => `[data-guide-file-shell="src/${file}.ts"]`, reads, requested, release, close: () => context.close() };
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

const noteOf = (view: View, file: string) => view.page.evaluate((selector) => document.querySelector(`${selector} [data-semantic-note]`)?.getAttribute('data-semantic-note') ?? null, view.shell(file));

const switchOf = (view: View) => view.page.locator('[data-semantic-file-popover]').last().getByRole('switch', { name: 'Show in the diff' });

async function tapAt(view: View, box: { x: number; y: number; width: number; height: number }, dy = box.height / 2) {
  await view.page.touchscreen.tap(box.x + box.width / 2, box.y + dy);
}

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

const scrollTopOf = (view: View) => view.page.evaluate((selector) => document.querySelector(selector)!.scrollTop, view.scroller);

async function atRest(view: View) {
  let last = await scrollTopOf(view);
  for (let calm = 0, i = 0; calm < 4 && i < 100; i++) {
    await view.page.waitForTimeout(100);
    const now = await scrollTopOf(view);
    calm = now === last ? calm + 1 : 0;
    last = now;
  }
}

async function scrollBy(view: View, by: number) {
  const box = (await view.page.evaluate((selector) => document.querySelector(selector)!.getBoundingClientRect().toJSON(), view.scroller)) as DOMRect;
  await view.page.mouse.move(box.x + box.width / 2, Math.max(box.y, 0) + 300);
  await view.page.mouse.wheel(0, by);
  await atRest(view);
}

async function bring(view: View, what: string, measure: () => Promise<number | null>, target: number, within: number) {
  for (let i = 0; i < 30; i++) {
    const now = await measure();
    if (now != null && Math.abs(now - target) <= within) return;
    await scrollBy(view, now == null ? 600 : now - target);
  }
  expect(await measure(), `precondition: ${what} within ${within} px of ${target}`).toBeGreaterThanOrEqual(target - within);
  expect(await measure(), `precondition: ${what} within ${within} px of ${target}`).toBeLessThanOrEqual(target + within);
}

const belowBy = async (view: View, file: string) => {
  const edge = await edgeOf(view, file);
  return edge == null ? null : -edge.bottom;
};

async function justBelow(view: View, file: string) {
  await bring(view, `${file}'s top below the bottom edge`, () => belowBy(view, file), 130, 50);
  return async () => ((await belowBy(view, file)) ?? 0) > 60;
}

async function heldUntilWatched(view: View, name: string, file: string, ends: 'off' | 'semantic') {
  await expect.poll(() => view.requested.has(name), { timeout: 30_000, message: `precondition: ${name} was asked for` }).toBe(true);
  expect(view.reads.has(name), `precondition: the read of ${name} is still held`).toBe(false);
  await watch(view);
  view.release(name);
  await settles(view, file, ends);
}

async function settles(view: View, file: string, ends: 'off' | 'semantic') {
  await expect.poll(() => noteOf(view, file), { timeout: 45_000, message: `${file}'s note ends ${ends}` }).toBe(ends);
  await view.page.waitForTimeout(2_000);
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
  const open = (host: Host, held: string[] = []) => (host === 'review' ? reviewWindow(browser, held) : inboxReview(browser, inbox(), held));

  const onPhone = async (host: Host, held: string[], file: string, width?: number) => {
    const view = host === 'review' ? await reviewWindow(browser, held, width ?? true) : await inboxReview(browser, inbox(), held, width ?? true);
    if (host === 'review') {
      await view.page.locator(`[data-changes-tree] [data-type="item"][data-item-path$="${file}.ts"]`).first().tap({ timeout: 10_000 });
      await view.page.getByText('All changes', { exact: true }).first().tap({ timeout: 10_000 });
      await expect.poll(() => view.page.locator('diffs-container').count(), { timeout: 10_000 }).toBeGreaterThan(0);
      await markScroller(view.page);
      await expect.poll(async () => (await edgeOf(view, file))?.top ?? null, { timeout: 10_000, message: 'precondition: the diff shows after picking the file' }).not.toBeNull();
    }
    return view;
  };

  for (const host of ['review', 'inbox'] as const) {
  test(`${host} on a phone: a touch scroll before the notes land moves nothing, the header offers the note, a tap shows it`, async () => {
    const view = await onPhone(host, ['money'], 'a-money');
    try {
      const shell = view.shell('a-money');
      await view.page.locator(shell).scrollIntoViewIfNeeded();
      await atRest(view);
      await bring(view, "a-money's header clear of the app's top bar", async () => (await edgeOf(view, 'a-money'))?.top ?? null, host === 'review' ? 0 : 200, host === 'review' ? 40 : 80);
      await view.page.evaluate((selector) => {
        const page = document.querySelector(selector) as HTMLElement;
        page.dispatchEvent(new Event('touchstart', { bubbles: true }));
        page.scrollTop += 40;
      }, view.scroller);
      await atRest(view);
      const note = view.page.locator(`${shell} [data-semantic-note]`).first();
      const header = view.page.locator(`${shell} [data-file-header]`).first();
      try {
        await heldUntilWatched(view, 'money', 'a-money', 'off');
      } finally {
        if (process.env.SEM_LANDING_SHOT) await header.screenshot({ path: `${process.env.SEM_LANDING_SHOT}-${host}-${type.name()}.png` });
      }
      await still(view);
      await expect(note).toHaveAttribute('data-semantic-note', 'off');
      await expect(note).toBeVisible();
      const box = (await note.boundingBox())!;
      const edge = (await header.boundingBox())!;
      expect(box.x >= edge.x && box.x + box.width <= edge.x + edge.width, 'the note sits inside the header').toBe(true);
      expect(box.width, 'the chip is full size').toBeGreaterThan(30);
      await tapAt(view, box);
      await tapAt(view, (await switchOf(view).boundingBox())!);
      await expect(note).toHaveAttribute('data-semantic-note', 'semantic');
    } finally {
      await view.close();
    }
  });

  test(`${host} on a 320 px phone: the file name keeps its room beside the chip, and a tap just above or below the chip opens its switch`, async () => {
    const view = await onPhone(host, [], 'a-money', 320);
    try {
      const shell = view.shell('a-money');
      await expect.poll(() => noteOf(view, 'a-money'), { timeout: 45_000 }).toMatch(/^(off|semantic)$/);
      await view.page.locator(shell).scrollIntoViewIfNeeded();
      await atRest(view);
      const note = view.page.locator(`${shell} [data-semantic-note]`).first();
      const name = view.page.locator(`${shell} [data-file-header] span[title]`).first();
      if (process.env.SEM_LANDING_SHOT) await view.page.locator(`${shell} [data-file-header]`).first().screenshot({ path: `${process.env.SEM_LANDING_SHOT}-320-${host}-${type.name()}.png` });
      expect((await name.boundingBox())!.width, 'the file name keeps room to read').toBeGreaterThanOrEqual(64);
      for (const offset of [-7, 5]) {
        const box = (await note.boundingBox())!;
        const row = (await view.page.locator(`${shell} [data-file-header]`).first().boundingBox())!;
        await view.page.waitForTimeout(600);
        const at = { x: box.x + box.width / 2, y: offset < 0 ? Math.max(row.y + 1, box.y + offset) : Math.min(row.y + row.height - 1, box.y + box.height + offset) };
        await expect.poll(() => view.page.evaluate(({ x, y }) => {
          const hit = document.elementFromPoint(x, y);
          return hit?.closest('[data-semantic-note]') ? 'chip' : (hit?.outerHTML.slice(0, 160) ?? 'nothing');
        }, at), { timeout: 2_000, message: `the point ${offset} px off the chip belongs to it` }).toBe('chip');
        await view.page.touchscreen.tap(at.x, at.y);
        await expect(switchOf(view), `a tap ${offset} px off the chip opens it`).toBeVisible({ timeout: 5_000 });
        await view.page.keyboard.press('Escape');
        await expect(switchOf(view)).toHaveCount(0);
      }
    } finally {
      await view.close();
    }
  });

  test(`${host} on a phone: at the very end of the page, flipping the last file's offered result in its chip leaves its header where it is`, async () => {
    const view = await onPhone(host, ['tail'], 'a-money');
    try {
      const shell = view.shell('f-tail');
      const header = view.page.locator(`${shell} [data-file-header]`).first();
      const atEnd = () =>
        view.page.evaluate((selector) => {
          const page = document.querySelector(selector) as HTMLElement;
          return page.scrollHeight - page.scrollTop - page.clientHeight;
        }, view.scroller);
      for (let i = 0; i < 10 && (await atEnd()) > 1; i++) {
        await view.page.evaluate((selector) => {
          const page = document.querySelector(selector) as HTMLElement;
          page.dispatchEvent(new Event('touchstart', { bubbles: true }));
          page.scrollTop = page.scrollHeight;
        }, view.scroller);
        await atRest(view);
      }
      expect(await atEnd(), 'precondition: at the very end of the page').toBeLessThanOrEqual(1);
      await heldUntilWatched(view, 'tail', 'f-tail', 'off');
      await moved(view);
      await expect(header, "precondition: f-tail's header on screen").toBeInViewport();
      const note = view.page.locator(`${shell} [data-semantic-note]`).first();
      const box = (await note.boundingBox())!;
      await view.page.evaluate((selector) => {
        const w = window as unknown as { __noteTops: number[]; __noteOn: boolean };
        w.__noteTops = [];
        w.__noteOn = true;
        const painted = new MessageChannel();
        painted.port1.onmessage = () => {
          const top = document.querySelector(selector)?.getBoundingClientRect().top;
          if (top != null) w.__noteTops.push(top);
        };
        const step = () => {
          if (!w.__noteOn) return;
          painted.port2.postMessage(0);
          requestAnimationFrame(step);
        };
        step();
      }, `${shell} [data-semantic-note]`);
      await tapAt(view, box);
      await tapAt(view, (await switchOf(view).boundingBox())!);
      await expect(note).toHaveAttribute('data-semantic-note', 'semantic');
      await view.page.waitForTimeout(1_000);
      await tapAt(view, (await switchOf(view).boundingBox())!);
      await expect(note).toHaveAttribute('data-semantic-note', 'off');
      await view.page.waitForTimeout(1_000);
      const tops = await view.page.evaluate(() => {
        const w = window as unknown as { __noteTops: number[]; __noteOn: boolean };
        w.__noteOn = false;
        return w.__noteTops;
      });
      expect(tops.length).toBeGreaterThan(30);
      expect(Math.max(...tops.map((top) => Math.abs(top - box.y))), "f-tail's header stays put in every frame").toBeLessThanOrEqual(1);
    } finally {
      await view.close();
    }
  });
  }

  test('inbox, 20 files: a jump to file 18 from the menu of files, hands off, moves nothing as its note lands, and the note is offered', async () => {
    const view = await inboxReview(browser, inbox(), ['f18'], false, MANY);
    try {
      const shell = view.shell('f18');
      expect(await view.page.locator(`${shell} diffs-container`).count(), 'precondition: file 18 is not drawn before the jump').toBe(0);
      if (process.env.SEM_LANDING_SHOT) await view.page.screenshot({ path: process.env.SEM_LANDING_SHOT });
      await view.page.locator('[data-review-message] [data-review-jump]').click({ timeout: 10_000 });
      await view.page.locator('[data-review-files] [data-review-jump-row="src/f18.ts"]').click({ timeout: 10_000 });
      await expect.poll(async () => (await edgeOf(view, 'f18'))?.top ?? null, { timeout: 30_000 }).not.toBeNull();
      await expect.poll(() => view.page.locator(`${shell} diffs-container`).count(), { timeout: 30_000 }).toBe(1);
      await atRest(view);
      const edge = (await edgeOf(view, 'f18'))!;
      expect(edge.top >= -1 && edge.bottom > 0, `precondition: file 18's top on screen after the jump (${JSON.stringify(edge)})`).toBe(true);
      await heldUntilWatched(view, 'f18', 'f18', 'off');
      await still(view);
    } finally {
      await view.close();
    }
  });

  for (const host of ['review', 'inbox'] as const) {
    test.describe(host, () => {
      test('a little scroll before the notes land: nothing on screen moves, its files are offered the note, a file below takes it', async () => {
        const view = await open(host, ['money']);
        try {
          await scrollBy(view, 200);
          await heldUntilWatched(view, 'money', 'a-money', 'off');
          await still(view);
          await view.page.locator(`${view.shell('a-money')} [data-semantic-note="off"]`).click();
          await switchOf(view).click();
          await expect.poll(() => noteOf(view, 'a-money')).toBe('semantic');
        } finally {
          await view.close();
        }
      });

      test('a file just below the bottom edge when its note lands takes it by itself, and nothing on screen moves', async () => {
        const view = await open(host, ['dates']);
        try {
          const below = await justBelow(view, 'e-dates');
          await heldUntilWatched(view, 'dates', 'e-dates', 'semantic');
          await still(view);
          expect(await below()).toBe(true);
          await bring(view, "e-dates's top on screen", async () => (await edgeOf(view, 'e-dates'))?.top ?? null, 200, 150);
          expect(await noteOf(view, 'e-dates')).toBe('semantic');
        } finally {
          await view.close();
        }
      });

      test('a file below when its read began and on screen when its note lands is offered the note, and nothing moves', async () => {
        const view = await open(host, ['names']);
        try {
          const start = await edgeOf(view, 'c-names');
          expect(start == null || start.bottom < 0, 'precondition: c-names wholly below the view when its read began').toBe(true);
          await bring(view, "c-names's top on screen", async () => (await edgeOf(view, 'c-names'))?.top ?? null, 250, 120);
          await heldUntilWatched(view, 'names', 'c-names', 'off');
          await still(view);
          expect(await noteOf(view, 'c-names')).toBe('off');
        } finally {
          await view.close();
        }
      });

      test('within a screen of the end of the page, a file below is offered its note, and nothing moves', async () => {
        const view = await open(host, ['tail']);
        try {
          const below = await justBelow(view, 'f-tail');
          expect(
            await view.page.evaluate((selector) => {
              const page = document.querySelector(selector) as HTMLElement;
              return page.scrollHeight - page.scrollTop - page.clientHeight <= page.clientHeight;
            }, view.scroller),
            'precondition: within one screen of the end of the page',
          ).toBe(true);
          await heldUntilWatched(view, 'tail', 'f-tail', 'off');
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
