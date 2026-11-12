/**
 * Highlighting by touch on an iPad and an iPhone, in WebKit, against the
 * compiled binary: a selection made with a finger is highlighted once it is
 * finished, and stays selected.
 *
 * The highlighter used to paint the selection 400 ms after its last change
 * with the finger still dragging. The marks it wrapped around the words took
 * the live selection away under the finger, and a later highlight replacing
 * the first moved the selection's ends onto other words. Here the selection is
 * driven as iOS drives it (it grows in steps through `selectionchange`, with
 * pauses, while touch events say a finger is down), and at every step the
 * spec reads what is highlighted, whether the toolbar is up, and what is
 * selected. Playwright cannot draw iOS's handles or its magnifier: those need
 * a real device.
 *
 * Runs in the playwright config's `webkit` project. Build the binary first (see
 * inbox.spec.ts), then `bun run test:e2e:inbox`.
 */
import { expect, test, type Browser, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(resolve(__dirname, '../..'), '.local/plannotator'));

const FIRST = 'The cache keeps a copy of every thread so the window never has to ask the server twice for the same page, and it throws a part away the moment the server says that part changed.';
const SECOND = 'A test does thousands of random steps in a random order and then compares the copy with a fresh read; when the two differ, it prints the steps that made them differ.';
const BODY = `${FIRST}\n\n${SECOND}`;

let url = '';
let thread = '';
let agent: SimAgent | null = null;

test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-inbox-touch-highlight-');
  const dataDir = join(root, 'data');
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    CODEX_HOME: join(root, 'codex'),
    OPENCODE_CONFIG_DIR: join(root, 'opencode'),
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  url = started.stdout.trim();
  const project = scratchProject(join(root, 'src'), 'cache-svc');
  agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const sent = await agent.send({ project_path: project, subject: 'Thread cache', thread: 'thread-cache', body: BODY });
  thread = sent.thread_id as string;
});
test.afterAll(async () => {
  try {
    await agent?.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

const SCREENS = [
  { name: 'iPad', viewport: { width: 820, height: 1180 } },
  { name: 'iPhone', viewport: { width: 390, height: 844 } },
] as const;

async function open(browser: Browser, viewport: { width: number; height: number }): Promise<Page> {
  const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const page = await context.newPage();
  await page.goto(`${url}#thread=${thread}`);
  await expect(page.locator('.ib-body[data-text-comments] p').first()).toContainText('The cache keeps');
  expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), 'a finger is the main pointer').toBe(true);
  // The driver: the first paragraph's characters, a finger's touch events, and what the page shows.
  await page.evaluate(() => {
    const body = document.querySelector('.ib-body[data-text-comments]')!;
    const p = body.querySelector('p')!;
    const at = (offset: number): [Text, number] => {
      const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
      let left = offset;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node as Text;
        if (left <= text.data.length) return [text, left];
        left -= text.data.length;
      }
      throw new Error(`no text at ${offset}`);
    };
    const fire = (type: string, fingers: number) => {
      const r = p.getBoundingClientRect();
      const point = { identifier: 1, clientX: r.left + 40, clientY: r.top + 10, pageX: r.left + 40, pageY: r.top + 10, target: p };
      const event = new Event(type, { bubbles: true, cancelable: true, composed: true });
      Object.defineProperty(event, 'touches', { value: fingers ? [point] : [] });
      Object.defineProperty(event, 'changedTouches', { value: [point] });
      p.dispatchEvent(event);
    };
    (window as unknown as { __touch: unknown }).__touch = {
      select: (from: number, to: number) => {
        const [a, x] = at(from);
        const [b, y] = at(to);
        getSelection()!.setBaseAndExtent(a, x, b, y);
      },
      extend: (to: number) => {
        const [b, y] = at(to);
        getSelection()!.extend(b, y);
      },
      fire,
      state: () => ({
        selected: getSelection()!.toString(),
        highlights: [...new Set([...body.querySelectorAll('[data-highlight-id]')].map((m) => m.getAttribute('data-highlight-id')))],
        highlighted: [...body.querySelectorAll('[data-highlight-id]')].map((m) => m.textContent).join(''),
        toolbar: !!document.querySelector('.annotation-toolbar'),
      }),
    };
  });
  return page;
}

type Touch = {
  select(from: number, to: number): void;
  extend(to: number): void;
  fire(type: string, fingers: number): void;
  state(): { selected: string; highlights: string[]; highlighted: string; toolbar: boolean };
};
const state = (page: Page) => page.evaluate(() => (window as unknown as { __touch: Touch }).__touch.state());
const select = (page: Page, from: number, to: number) => page.evaluate(([a, b]) => (window as unknown as { __touch: Touch }).__touch.select(a!, b!), [from, to]);
const extend = (page: Page, to: number) => page.evaluate((b) => (window as unknown as { __touch: Touch }).__touch.extend(b), to);
const fire = (page: Page, type: string, fingers: number) => page.evaluate(([t, n]) => (window as unknown as { __touch: Touch }).__touch.fire(t as string, n as number), [type, fingers]);

for (const screen of SCREENS) {
  test(`${screen.name}: a long press dragged on in steps, with pauses, is highlighted once, when the finger lifts, and stays selected`, async ({ browser }) => {
    const page = await open(browser, screen.viewport);
    // The long press: a finger down, a word selected.
    await fire(page, 'touchstart', 1);
    await select(page, 4, 9);
    for (let to = 12; to <= 24; to += 3) {
      await page.waitForTimeout(90);
      await extend(page, to);
      await fire(page, 'touchmove', 1);
    }
    // The finger rests mid-drag, far longer than the old 400 ms: nothing is painted, the selection is whole.
    await page.waitForTimeout(1200);
    expect(await state(page)).toEqual({ selected: FIRST.slice(4, 24), highlights: [], highlighted: '', toolbar: false });
    for (let to = 27; to <= 60; to += 3) {
      await page.waitForTimeout(90);
      await extend(page, to);
      await fire(page, 'touchmove', 1);
    }
    expect((await state(page)).highlights).toEqual([]);
    await fire(page, 'touchend', 0);
    await expect.poll(async () => (await state(page)).highlights.length).toBe(1);
    const done = await state(page);
    expect(done.highlighted).toBe(FIRST.slice(4, 60));
    expect(done.toolbar).toBe(true);
    // Still the person's selection, over the same words, to adjust.
    expect(done.selected).toBe(FIRST.slice(4, 60));
    await page.waitForTimeout(1500);
    expect(await state(page)).toEqual(done);
    await page.context().close();
  });

  test(`${screen.name}: a handle dragged on after the highlight replaces it with one highlight, and the selection never jumps`, async ({ browser }) => {
    const page = await open(browser, screen.viewport);
    // No touch events at all (a selection changed by the system alone): highlighted after it rests.
    await select(page, 4, 30);
    await expect.poll(async () => (await state(page)).highlights.length).toBe(1);
    const first = await state(page);
    expect(first.highlighted).toBe(FIRST.slice(4, 30));
    expect(first.selected).toBe(FIRST.slice(4, 30));

    // The end handle, dragged on in steps with a pause: the first highlight stays until the drag is done.
    await fire(page, 'touchstart', 1);
    for (let to = 33; to <= 54; to += 3) {
      await page.waitForTimeout(90);
      await extend(page, to);
      await fire(page, 'touchmove', 1);
      // Never a jump: the selection is exactly what the finger made, at every step.
      expect((await state(page)).selected).toBe(FIRST.slice(4, to));
      if (to === 42) await page.waitForTimeout(700);
    }
    expect((await state(page)).highlights).toEqual(first.highlights);
    await fire(page, 'touchend', 0);
    await expect.poll(async () => (await state(page)).highlighted).toBe(FIRST.slice(4, 54));
    const after = await state(page);
    expect(after.highlights.length).toBe(1);
    expect(after.highlights).not.toEqual(first.highlights);
    expect(after.selected).toBe(FIRST.slice(4, 54));
    // No third highlight follows.
    await page.waitForTimeout(1500);
    expect(await state(page)).toEqual(after);
    await page.context().close();
  });
}
