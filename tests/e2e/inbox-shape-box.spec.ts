/**
 * The crosshair on a Shape board, on the compiled binary in a sandboxed Inbox: one button on the bar, a click that
 * marks a part, a lazy drag that boxes what it crosses, the comment, the kept box, and what
 * `plannotator shape read --notes` hands the agent, and Add to reply into the thread's reply. The board is a whiteboard
 * of a real-looking feature (fixtures/shape-search-board, or PLANNOTATOR_SHAPE_BOX_BOARD). Pictures go to
 * PLANNOTATOR_SHAPE_BOX_SHOTS (default .local/test-results/shape-box); the video only with
 * PLANNOTATOR_SHAPE_BOX_VIDEO=1 (it needs ffmpeg), Firefox only with PLANNOTATOR_SHAPE_BOX_FIREFOX (its path).
 *
 * A headless screenshot has no system cursor, so `showCursor` draws a cross where the mouse is, for the pictures
 * only. What proves the cursor itself is the computed `cursor` these tests read.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type Browser, devices, expect, firefox, type Page, test, webkit } from '@playwright/test';
import { removeInboxScratch } from './inbox-scratch';
import { seedShapeWorld, type ShapeWorld } from './inbox-shape-seed';
import { SimAgent } from '../../scripts/inbox-sim';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
// The pictures go under the run's results unless a folder is named (PLANNOTATOR_SHAPE_BOX_SHOTS).
const shots = process.env.PLANNOTATOR_SHAPE_BOX_SHOTS ?? join(repo, '.local/test-results/shape-box');
const boardDir = process.env.PLANNOTATOR_SHAPE_BOX_BOARD ?? join(repo, 'tests/e2e/fixtures/shape-search-board');
const { defaultBrowserType: _phoneBrowser, ...phone } = devices['iPhone 15'];
let w: ShapeWorld;

function store(key: string, thread = 'snooze'): string {
  const dir = join(w.root, 'boards', key);
  mkdirSync(dir, { recursive: true });
  cpSync(boardDir, dir, { recursive: true });
  const r = w.shape(['update', '--file', join(dir, 'board.json'), '--project', w.projects.plannotator!, '--thread', w.threads[thread]!]);
  expect(r.status, r.stderr).toBe(0);
  return (JSON.parse(r.stdout) as { id: string }).id;
}

async function openBoard(browser: Browser, id: string, options: Parameters<Browser['newContext']>[0] = {}, thread = 'snooze') {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light', ...options });
  await context.route((url) => !['127.0.0.1', 'localhost'].includes(url.hostname), (route) => route.abort());
  const page = await context.newPage();
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(e.message));
  page.on('dialog', (d) => {
    problems.push(`dialog: ${d.message()}`);
    void d.dismiss();
  });
  page.on('console', (m) => {
    if (/content security|csp|tainted/i.test(m.text())) problems.push(m.text());
  });
  await page.goto(`${w.url}#thread=${w.threads[thread]}&shape=${id}`);
  await expect(page.locator('.shp-dock')).toBeVisible();
  await page.waitForTimeout(3600); // drawn in
  return { context, page, problems };
}

const crosshair = (page: Page) => page.locator('.shp-dock').getByRole('button', { name: 'Comment', exact: true });
const view = async (page: Page, name: string) => {
  await page.locator('.shp-dock').getByRole('button', { name, exact: true }).click();
  await page.waitForTimeout(3600);
};
const part = (page: Page, id: string) => page.locator(`.shp-view:not(.leaving) [data-mark="${id}"]`);
const composer = (page: Page) => page.locator('[data-comment-popover]');
const box = (page: Page) => page.locator('.shp-view:not(.leaving) [data-shp-box]');
const kept = (page: Page) => page.locator('.shp-view:not(.leaving) [data-shp-kept]');
const cursorOf = (page: Page, selector: string) =>
  page.evaluate((s) => {
    const root = document.querySelector('.shp-view:not(.leaving) .shp-drawn-host')?.shadowRoot;
    const el = root?.querySelector(s) ?? document.querySelector(s);
    return el ? getComputedStyle(el).cursor : null;
  }, selector);

/** For the pictures: where the mouse is, as the Mac's cross. A screenshot has no system cursor. */
async function showCursor(page: Page) {
  await page.evaluate(() => {
    const c = document.createElement('div');
    c.id = 'proof-cursor';
    c.style.cssText = 'position:fixed;left:0;top:0;width:21px;height:21px;margin:-10px 0 0 -10px;pointer-events:none;z-index:99999';
    c.innerHTML = '<svg width="21" height="21" viewBox="0 0 21 21"><path d="M10.5 0v21M0 10.5h21" stroke="#fff" stroke-width="3"/><path d="M10.5 1v19M1 10.5h19" stroke="#000" stroke-width="1"/></svg>';
    document.documentElement.appendChild(c);
    window.addEventListener('pointermove', (e) => {
      c.style.transform = `translate(${e.clientX}px,${e.clientY}px)`;
    }, true);
  });
}
const hideCursor = (page: Page) => page.evaluate(() => document.getElementById('proof-cursor')?.remove());

type Pt = { x: number; y: number };
/** A point on a part, as fractions of its box (below 0 or above 1: outside it). */
async function at(page: Page, id: string, fx: number, fy: number): Promise<Pt> {
  const b = (await part(page, id).boundingBox())!;
  return { x: b.x + b.width * fx, y: b.y + b.height * fy };
}
async function press(page: Page, from: Pt, to: Pt, steps = 14) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps });
}
async function drag(page: Page, from: Pt, to: Pt, steps = 14) {
  await press(page, from, to, steps);
  await page.mouse.up();
  await page.waitForTimeout(150);
}
const waiting = (id: string) => {
  const r = w.shape(['read', id, '--notes']);
  expect(r.status, r.stderr).toBe(0);
  return (JSON.parse(r.stdout) as { notes: Record<string, unknown>[] }).notes;
};
/** The composer must never sit over the box it is about. */
async function composerClearOfBox(page: Page) {
  const c = (await composer(page).boundingBox())!;
  const b = (await box(page).first().boundingBox())!;
  const ox = Math.min(c.x + c.width, b.x + b.width) - Math.max(c.x, b.x);
  const oy = Math.min(c.y + c.height, b.y + b.height) - Math.max(c.y, b.y);
  expect(ox <= 0 || oy <= 0, `composer ${JSON.stringify(c)} over box ${JSON.stringify(b)}`).toBe(true);
}
/** The composer's actions, left to right. */
const buttonOrder = (page: Page) =>
  composer(page).locator('button').evaluateAll((bs) =>
    bs.filter((b) => ['Ask', 'Change it', 'Show me', 'Add to reply'].includes(b.textContent!.trim())).sort((a, b) => a.getBoundingClientRect().x - b.getBoundingClientRect().x).map((b) => b.textContent!.trim()));
/** A toast never covers the board's bar: it sits wholly above it. */
async function clearOfDock(page: Page, toast: ReturnType<Page['locator']>) {
  await page.waitForTimeout(300); // risen in
  const t = (await toast.boundingBox())!;
  const d = (await page.locator('.shp-dock').boundingBox())!;
  expect(t.y + t.height, `toast ${JSON.stringify(t)} over the bar ${JSON.stringify(d)}`).toBeLessThanOrEqual(d.y);
}
async function barShot(page: Page, name: string) {
  const d = (await page.locator('.shp-dock').boundingBox())!;
  await page.screenshot({ path: join(shots, name), clip: { x: d.x - 24, y: d.y - 20, width: d.width + 48, height: d.height + 40 } });
}

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  expect(existsSync(join(boardDir, 'board.json')), `make the board first: ${boardDir}`).toBe(true);
  mkdirSync(shots, { recursive: true });
  w = await seedShapeWorld({ binary, shape: true, boards: 'none' });
});
test.afterAll(async () => {
  for (const agent of w?.agents ?? []) await agent.close().catch(() => {});
  await removeInboxScratch();
});

test('the bar: one crosshair in place of Annotate and its tools; reading is as it was until it is on', async ({ browser }) => {
  for (const scheme of ['light', 'dark'] as const) {
    const { context, page, problems } = await openBoard(browser, store(`bar-${scheme}`), { colorScheme: scheme });
    const dock = page.locator('.shp-dock');
    await expect(dock.getByRole('button', { name: /Annotate/ })).toHaveCount(0);
    await expect(dock.locator('.shp-tstrip button')).toHaveCount(1);
    await expect(crosshair(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(crosshair(page)).toHaveAttribute('title', 'Comment: click a part, or drag across what you mean');
    // Off: a pointer, bubbles pop, a drag draws nothing.
    expect(await cursorOf(page, '.board')).not.toBe('crosshair');
    await page.locator('.shp-view:not(.leaving) .shp-rb').first().hover();
    await expect(page.locator('.shp-peek')).toBeVisible();
    await page.mouse.move(5, 5);
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(shots, `01-board-off-${scheme}.png`) });
    await barShot(page, `01-bar-off-${scheme}.png`);
    // A drag while off selects words, as it always did; it draws no box.
    await drag(page, await at(page, 'row-google', 0.1, 0.5), await at(page, 'row-bing', 0.9, 0.5));
    await expect(page.locator('.shp-box-band')).toHaveCount(0);
    await expect(composer(page)).toHaveCount(0);
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await crosshair(page).click();
    await page.mouse.move(5, 5);
    await expect(crosshair(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(crosshair(page)).toHaveAttribute('title', 'Stop commenting');
    expect(await cursorOf(page, '.board')).toBe('crosshair');
    await page.waitForTimeout(250);
    await barShot(page, `01-bar-on-${scheme}.png`);
    expect(problems).toEqual([]);
    await context.close();
  }
});

/** Sloppy drags a person would make, and what each one should pick. */
const LAZY: { name: string; from: [string, number, number]; to: [string, number, number]; want: string[] }[] = [
  { name: 'three rows, from the middle of the first to the middle of the last', from: ['row-google', 0.12, 0.45], to: ['row-bing', 0.85, 0.6], want: ['row-google', 'row-ddg', 'row-bing'] },
  { name: 'three rows, starting a little above and stopping short', from: ['row-ddg', 0.03, -0.15], to: ['row-kagi', 0.7, 0.7], want: ['row-ddg', 'row-bing', 'row-kagi'] },
  { name: 'the URL field, with room to spare', from: ['f-url', -0.08, -0.35], to: ['f-url', 1.06, 1.15], want: ['f-url'] },
  { name: 'the form, from inside its corner to past its edge', from: ['form', 0.06, 0.08], to: ['form', 1.04, 1.06], want: ['form'] },
  { name: 'across the address bar and the result', from: ['omnibox', 0.15, 0.2], to: ['result', 0.8, 0.85], want: ['omnibox', 'result'] },
  { name: 'along the words of one row', from: ['row-ddg', 0.18, 0.35], to: ['row-ddg', 0.62, 0.7], want: ['row-ddg'] },
  { name: 'a quick box inside the sticky note', from: ['sticky', 0.2, 0.25], to: ['sticky', 0.75, 0.7], want: ['sticky'] },
];

test('lazy drags pick what a person meant', async ({ browser }) => {
  const id = store('lazy');
  const { context, page, problems } = await openBoard(browser, id);
  await crosshair(page).click();
  const got: { name: string; want: string[]; parts: string[]; words: string }[] = [];
  const logged: string[] = [];
  page.on('console', (m) => {
    if (m.text().startsWith('[shape-box] Show me stub ')) logged.push(m.text().slice('[shape-box] Show me stub '.length));
  });
  for (const l of LAZY) {
    await drag(page, await at(page, ...l.from), await at(page, ...l.to));
    await expect(composer(page)).toBeVisible();
    await composer(page).getByRole('button', { name: 'Show me' }).click();
    await expect.poll(() => logged.length).toBe(got.length + 1);
    const sel = JSON.parse(logged[got.length]!) as { parts: string[]; words: string };
    got.push({ name: l.name, want: l.want, parts: sel.parts, words: sel.words });
  }
  writeFileSync(join(shots, 'lazy-drags.json'), JSON.stringify(got, null, 2));
  for (const g of got) expect(g.parts, g.name).toEqual(g.want);
  expect(problems).toEqual([]);
  await context.close();
});

for (const scheme of ['light', 'dark'] as const) {
  test(`the whole flow, ${scheme}: lazy drag, comment, kept box, and what the agent receives`, async ({ browser }) => {
    const id = store(`flow-${scheme}`);
    const { context, page, problems } = await openBoard(browser, id, { colorScheme: scheme });
    await crosshair(page).click();
    await page.mouse.move(700, 120);
    // No ring under the pointer in cross mode.
    await part(page, 'row-ddg').hover();
    await page.waitForTimeout(200);
    await expect(page.locator('.shp-pin-hover')).toHaveCount(0);

    await showCursor(page);
    await press(page, await at(page, 'row-google', 0.12, 0.45), await at(page, 'row-bing', 0.85, 0.6), 18);
    await expect(page.locator('.shp-box-band')).toHaveCount(1);
    await expect(page.locator('.shp-peek')).toHaveCount(0);
    await page.screenshot({ path: join(shots, `02-lazy-drag-${scheme}.png`) });
    await page.mouse.up();
    await hideCursor(page);

    await expect(composer(page)).toBeVisible();
    await expect(composer(page)).toContainText('Shape · 3 parts');
    // The owner's order, with Change it the filled one.
    expect(await buttonOrder(page)).toEqual(['Ask', 'Change it', 'Show me', 'Add to reply']);
    await composerClearOfBox(page);
    await composer(page).locator('textarea').fill('Make Kagi the default and put it first.');
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(shots, `03-comment-${scheme}.png`) });

    await composer(page).getByRole('button', { name: 'Change it' }).click();
    await expect(composer(page)).toHaveCount(0);
    await expect(kept(page)).toHaveCount(1);
    await expect(box(page)).toHaveCount(1);
    await page.mouse.move(5, 5);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(shots, `04-kept-${scheme}.png`) });

    const note = waiting(id)[0] as { part: string; quote: string; picture: string; code?: string[] };
    expect(note.part).toBe('row-google,row-ddg,row-bing');
    expect(note.quote).toContain('DuckDuckGo');
    copyFileSync(note.picture, join(shots, `05-agent-picture-${scheme}.png`));
    if (scheme === 'light') {
      writeFileSync(join(shots, '05-agent-receives.json'), JSON.stringify(note, null, 2));
      const sheet = await context.newPage();
      const shown = { ...note, picture: `<sandbox>/${note.picture.split('/').slice(-2).join('/')}` };
      await sheet.setContent(`<!doctype html><body style="margin:0;padding:28px;background:#fff;color:#111;font:13px/1.5 ui-monospace,Menlo,monospace"><div style="font:600 13px system-ui;margin-bottom:8px">plannotator shape read &lt;id&gt; --notes → notes[0]</div><pre style="margin:0 0 20px;white-space:pre-wrap;word-break:break-word;background:#f4f3ef;padding:14px;border-radius:8px">${JSON.stringify(shown, null, 2).replace(/</g, '&lt;')}</pre><div style="font:600 13px system-ui;margin-bottom:8px">the file at note.picture</div><img style="max-width:100%;outline:1px solid #ddd" src="data:image/png;base64,${readFileSync(note.picture).toString('base64')}"></body>`);
      await sheet.setViewportSize({ width: 1000, height: 900 });
      await sheet.waitForTimeout(200);
      await sheet.screenshot({ path: join(shots, '05-agent-receives.png'), fullPage: true });
      await sheet.close();
    }
    expect(problems).toEqual([]);
    await context.close();
  });
}

test('a click still marks one part; a tiny drag is a click; Esc cancels a drag and closes nothing else', async ({ browser }) => {
  const id = store('click');
  const { context, page, problems } = await openBoard(browser, id);
  await crosshair(page).click();
  const s = await at(page, 'save', 0.5, 0.5);
  await drag(page, s, { x: s.x + 3, y: s.y + 2 }, 3);
  await expect(composer(page)).toContainText('Shape · “Save”');
  await expect(composer(page).getByRole('button', { name: 'Show me' })).toHaveCount(0);
  await expect(box(page)).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(composer(page)).toHaveCount(0);

  await page.locator('.shp-dock').getByRole('button', { name: /References/ }).click();
  await expect(page.locator('.shp-sidep.open')).toBeVisible();
  await press(page, await at(page, 'row-google', 0.1, 0.3), await at(page, 'row-ddg', 0.6, 0.7));
  await expect(page.locator('.shp-box-band')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('.shp-box-band')).toHaveCount(0);
  await page.mouse.up();
  await page.waitForTimeout(150);
  await expect(composer(page)).toHaveCount(0);
  await expect(box(page)).toHaveCount(0);
  await expect(page.locator('.shp-sidep.open')).toBeVisible();
  expect(problems).toEqual([]);
  await context.close();
});

test('How it works and the words under the drawing: a lazy drag over a diagram and over words', async ({ browser }) => {
  const id = store('views');
  const { context, page, problems } = await openBoard(browser, id);
  await crosshair(page).click();
  await view(page, 'How it works');
  await drag(page, await at(page, 'h-fill', 0.1, 0.15), await at(page, 'h-open', 0.9, 0.85));
  await composerClearOfBox(page);
  await composer(page).locator('textarea').fill('Show me how this works');
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(shots, '06-diagram-comment.png') });
  await composer(page).getByRole('button', { name: 'Ask' }).click();
  await expect(composer(page)).toHaveCount(0);
  // views.know's words sit under the drawing in the Shape view.
  await view(page, 'Shape');
  await part(page, 'know-1').scrollIntoViewIfNeeded();
  await drag(page, await at(page, 'know-1', 0.02, 0.1), await at(page, 'know-1', 0.55, 0.6));
  await expect(composer(page)).toContainText('Shape · “Adding an engine takes');
  await composer(page).locator('textarea').fill('Plainer, please.');
  // An Ask opened the chat beside the board; the composer's own buttons still work (they are not a click on the board).
  await expect(page.locator('.shp-sidep.open')).toBeVisible();
  await composer(page).getByRole('button', { name: 'Change it' }).click();
  await expect(kept(page)).toHaveCount(1);
  const notes = waiting(id) as { view: string; part: string; code?: string[]; picture?: string }[];
  writeFileSync(join(shots, '06-agent-receives-diagram-and-words.json'), JSON.stringify(notes, null, 2));
  expect(notes.find((n) => n.view === 'how')!.part.split(',')).toEqual(expect.arrayContaining(['h-fill', 'h-open']));
  expect(notes.find((n) => n.view === 'how')!.code).toEqual(['src/search/template.ts#L8']);
  expect(notes.find((n) => n.view === 'know')!.part).toBe('know-1');
  expect(problems).toEqual([]);
  await context.close();
});

test('800 wide: the drag, the comment beside the box, the kept box', async ({ browser }) => {
  const id = store('narrow');
  const { context, page, problems } = await openBoard(browser, id, { viewport: { width: 800, height: 700 } });
  await crosshair(page).click();
  await showCursor(page);
  await press(page, await at(page, 'f-short', -0.05, -0.3), await at(page, 'f-url', 0.9, 1.2));
  await page.screenshot({ path: join(shots, '07-800-drag.png') });
  await page.mouse.up();
  await hideCursor(page);
  await expect(composer(page)).toBeVisible();
  await composerClearOfBox(page);
  await composer(page).locator('textarea').fill('One field: paste the URL and we guess the rest.');
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(shots, '07-800-comment.png') });
  await composer(page).getByRole('button', { name: 'Change it' }).click();
  await expect(kept(page)).toHaveCount(1);
  await page.mouse.move(5, 5);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(shots, '07-800-kept.png') });
  expect(problems).toEqual([]);
  await context.close();
});

test('a phone keeps its tap: the crosshair, a tap on a part, no box', async ({ browser }) => {
  const id = store('phone');
  const { context, page, problems } = await openBoard(browser, id, { ...phone, colorScheme: 'light' });
  await crosshair(page).tap();
  const t = await at(page, 'add-btn', 0.5, 0.5);
  await page.touchscreen.tap(t.x, t.y);
  await expect(composer(page)).toContainText('+ Add search engine');
  await expect(composer(page).getByRole('button', { name: 'Show me' })).toHaveCount(0);
  await expect(box(page)).toHaveCount(0);
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(shots, '08-phone-tap.png') });
  expect(problems).toEqual([]);
  await context.close();
});

// `args: []`: the config's launch flags are Chromium's, and WebKit (Firefox too) refuses them on Linux.
for (const [name, launch] of [
  ['webkit', () => webkit.launch({ args: [] })],
  ['firefox', () => firefox.launch({ args: [], executablePath: process.env.PLANNOTATOR_SHAPE_BOX_FIREFOX || undefined })],
] as const) {
  test(`the real build in ${name}: a lazy drag, the note and its picture`, async () => {
    // Firefox is not among the browsers the e2e job installs: it runs where one is named.
    test.skip(name === 'firefox' && !process.env.PLANNOTATOR_SHAPE_BOX_FIREFOX, 'no Firefox named (PLANNOTATOR_SHAPE_BOX_FIREFOX)');
    const other = await launch();
    const id = store(name);
    const { context, page, problems } = await openBoard(other, id, { deviceScaleFactor: 2 });
    await crosshair(page).click();
    expect(await cursorOf(page, '.board')).toBe('crosshair');
    await drag(page, await at(page, 'row-google', 0.12, 0.45), await at(page, 'row-bing', 0.85, 0.6));
    await composer(page).locator('textarea').fill(`In ${name}.`);
    await composer(page).getByRole('button', { name: 'Change it' }).click();
    await expect(kept(page)).toHaveCount(1);
    const note = waiting(id)[0] as { picture: string; part: string };
    expect(note.part).toBe('row-google,row-ddg,row-bing');
    copyFileSync(note.picture, join(shots, `09-agent-picture-${name}.png`));
    expect(problems).toEqual([]);
    await context.close();
    await other.close();
  });
}

// Add to reply (owner approval q-3dcdec04 A): the box's words and picture go into the reply of the board's thread, with
// "Added to your reply · Undo"; the board keeps no note of it. Undo takes out only what its own press added.
const replyShots = process.env.PLANNOTATOR_SHAPE_BOX_REPLY_SHOTS ?? shots;
// Each on its own thread: a reply draft stays with its thread.
for (const [look, options, thread] of [
  ['light', {}, 'snooze'],
  ['dark', { colorScheme: 'dark' }, 'kettle'],
  ['390', { viewport: { width: 390, height: 844 } }, 'notes'],
] as const) {
  test(`Add to reply, ${look}: the box's words and picture land in the reply draft, and Undo takes them out`, async ({ browser }) => {
    mkdirSync(replyShots, { recursive: true });
    const id = store(`reply-${look}`, thread);
    const { context, page, problems } = await openBoard(browser, id, options as Parameters<Browser['newContext']>[0], thread);
    const reply = page.getByRole('textbox', { name: /^Reply to / });
    const files = page.locator('[data-compose-file-name]');
    const toast = page.locator('.ib-toast');
    const words = '> Shape · 3 parts · “Google DuckDuckGo Bing”\n\nMake Kagi the default and put it first.';

    await crosshair(page).click();
    await page.mouse.move(5, 5);
    await drag(page, await at(page, 'row-google', 0.12, 0.45), await at(page, 'row-bing', 0.85, 0.6));
    await expect(composer(page)).toContainText('Shape · 3 parts');
    expect(await buttonOrder(page)).toEqual(['Ask', 'Change it', 'Show me', 'Add to reply']);
    await composer(page).locator('textarea').fill('Make Kagi the default and put it first.');
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(replyShots, `01-box-four-buttons-${look}.png`) });
    // Show me (a stub here) keeps the composer and its words.
    await composer(page).getByRole('button', { name: 'Show me' }).click();
    await expect(composer(page).locator('textarea')).toHaveValue('Make Kagi the default and put it first.');
    await composer(page).getByRole('button', { name: 'Add to reply' }).click();
    await expect(composer(page)).toHaveCount(0);
    await expect(box(page)).toHaveCount(0);
    await expect(toast.last()).toContainText('Added to your reply');
    await clearOfDock(page, toast.last());
    await page.screenshot({ path: join(replyShots, `02-added-toast-${look}.png`) });
    expect(waiting(id)).toEqual([]);
    // A phone's toast floats over the board (above the thread's reply under it), where the omnibox sits once the
    // words are under the drawing: a press there swipes the toast, not a box. Dismissed first, as a person would.
    if (await page.locator('.ib-toast-phone').count()) {
      await toast.last().locator('[data-toast-dismiss]').click();
      await expect(toast).toHaveCount(0);
    }

    // A second box, then its Undo: only the second goes, and its toast with it.
    await drag(page, await at(page, 'omnibox', 0.05, 0.2), await at(page, 'omnibox', 0.4, 0.8));
    await composer(page).locator('textarea').fill('Show the engine’s mark here.');
    await composer(page).getByRole('button', { name: 'Add to reply' }).click();
    const undo = page.locator('[data-toast-undo]').last();
    await expect(undo).toBeVisible();
    await undo.click();
    await expect(page.locator('.ib-toast', { hasText: 'Added to your reply' })).toHaveCount(0, { timeout: 1000 });

    await page.getByRole('button', { name: 'Close Shape' }).click();
    await expect(page.locator('[data-shape-layer]')).toHaveCount(0);
    await expect(reply).toHaveValue(words);
    await expect(files).toHaveCount(1);
    await expect(files.first()).toHaveAttribute('data-compose-file-name', 'row-google-row-ddg-row-bing.png');
    await expect(files.first()).toHaveAttribute('data-compose-file', 'done');
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(replyShots, `03-reply-draft-${look}.png`) });
    expect(problems).toEqual([]);
    await context.close();
  });
}

/** A thread of its own (its reply draft starts empty): a new session's first message, from its own agent. */
async function freshThread(key: string): Promise<{ thread: string; agent: SimAgent }> {
  const agent = await SimAgent.connect({ binary, env: w.env, name: 'Claude Code', host: 'claude-code' });
  w.agents.push(agent);
  const sent = await agent.send({ project_path: w.projects.plannotator!, subject: `Board ${key}`, body: 'The board is drawn.' });
  w.threads[key] = sent.thread_id as string;
  return { thread: key, agent };
}
const addToReply = async (page: Page, text = '') => {
  if (text) await composer(page).locator('textarea').fill(text);
  await composer(page).getByRole('button', { name: 'Add to reply' }).click();
  await expect(composer(page)).toHaveCount(0);
};
const replyFileNames = (page: Page) => page.locator('[data-compose-file-name]').evaluateAll((fs) => fs.map((f) => f.getAttribute('data-compose-file-name')));
const omniboxBox = async (page: Page) => drag(page, await at(page, 'omnibox', 0.05, 0.2), await at(page, 'omnibox', 0.4, 0.8));
/** The board again over its thread, as its chip opens it (the address the Inbox keeps). */
async function reopenBoard(page: Page, thread: string, id: string) {
  await page.evaluate((hash) => {
    window.location.hash = hash;
  }, `thread=${w.threads[thread]}&shape=${id}`);
  await expect(page.locator('.shp-dock')).toBeVisible();
  await page.waitForTimeout(3600); // drawn in
  if ((await crosshair(page).getAttribute('aria-pressed')) !== 'true') await crosshair(page).click();
  await page.mouse.move(5, 5);
}
/** Taken down by its own Undo, a Send or a Cancel: well inside its own 7 s, so it never just ran out. */
const gone = (toast: ReturnType<Page['locator']>) => expect(toast).toHaveCount(0, { timeout: 1000 });

test('Add to reply’s Undo: once, its own press only (even of the same words), its toast gone; edited words stay', async ({ browser }) => {
  const { thread } = await freshThread('undo');
  const id = store('reply-undo', thread);
  const { context, page, problems } = await openBoard(browser, id, {}, thread);
  const reply = page.getByRole('textbox', { name: /^Reply to / });
  const added = page.locator('.ib-toast', { hasText: 'Added to your reply' });
  await crosshair(page).click();
  await page.mouse.move(5, 5);

  // The same box twice, words typed only the first time: its quote twice, those words between, and a second picture
  // named beside the first.
  await omniboxBox(page);
  await addToReply(page, 'Between.');
  const one = await reply.inputValue();
  const quote = one.split('\n\n')[0]!;
  expect(quote.startsWith('> Shape · ')).toBe(true);
  expect(one).toBe(`${quote}\n\nBetween.`);
  await omniboxBox(page);
  await addToReply(page);
  await expect(reply).toHaveValue(`${one}\n\n${quote}`);
  await expect.poll(() => replyFileNames(page)).toEqual(['omnibox.png', 'omnibox-2.png']);
  await clearOfDock(page, added);
  await page.screenshot({ path: join(replyShots, '04-undo-toast-light.png') });

  // Its Undo: the second press's quote (not the first's, the same words) and file, and the toast goes. Z then has
  // nothing to undo.
  await page.locator('[data-toast-undo]').click();
  await gone(added);
  await expect(reply).toHaveValue(one);
  await expect.poll(() => replyFileNames(page)).toEqual(['omnibox.png']);
  await page.keyboard.press('z');
  await page.waitForTimeout(400);
  await expect(reply).toHaveValue(one);
  await expect.poll(() => replyFileNames(page)).toEqual(['omnibox.png']);
  await page.screenshot({ path: join(replyShots, '05-after-undo-light.png') });

  // Words the person changed since are theirs: Undo takes the file and leaves the words.
  await drag(page, await at(page, 'row-google', 0.12, 0.45), await at(page, 'row-bing', 0.85, 0.6));
  await addToReply(page, 'Grey it out.');
  await expect.poll(() => replyFileNames(page)).toEqual(['omnibox.png', 'row-google-row-ddg-row-bing.png']);
  await page.getByRole('button', { name: 'Close Shape' }).click();
  await expect(page.locator('[data-shape-layer]')).toHaveCount(0);
  const edited = (await reply.inputValue()).replace('Grey it out.', 'Grey it out, and say why.');
  await reply.fill(edited);
  await page.locator('[data-toast-undo]').click();
  await gone(added);
  await expect(reply).toHaveValue(edited);
  await expect.poll(() => replyFileNames(page)).toEqual(['omnibox.png']);
  await page.screenshot({ path: join(replyShots, '06-undo-after-edit-light.png') });
  expect(problems).toEqual([]);
  await context.close();
});

test('Add to reply with the box closed: Undo works on the saved draft, and a second picture is named beside the draft’s', async ({ browser }) => {
  const { thread } = await freshThread('closed');
  const id = store('reply-closed', thread);
  const { context, page, problems } = await openBoard(browser, id, {}, thread);
  const reply = page.getByRole('textbox', { name: /^Reply to / });
  const added = page.locator('.ib-toast', { hasText: 'Added to your reply' });
  const files = page.locator('[data-compose-file-name]');
  const close = async () => {
    await page.getByRole('button', { name: 'Close Shape' }).click();
    await expect(page.locator('[data-shape-layer]')).toHaveCount(0);
  };
  await crosshair(page).click();
  await page.mouse.move(5, 5);

  // Added, then Esc in the reply box (it closes into a draft), then Z: the draft loses them both.
  await omniboxBox(page);
  await addToReply(page, 'Cancel me.');
  await close();
  await expect(files).toHaveAttribute('data-compose-file', 'done');
  await reply.press('Escape');
  await expect(reply).toHaveCount(0);
  await expect(added).toHaveCount(1);
  await page.keyboard.press('z');
  await gone(added);
  await page.waitForTimeout(600); // the draft saved
  await page.keyboard.press('r');
  await expect(reply).toBeVisible();
  await expect(reply).toHaveValue('');
  await expect(files).toHaveCount(0);
  await page.screenshot({ path: join(replyShots, '07-undo-after-esc-light.png') });
  await reply.press('Escape');

  // Added, Cancel (the draft keeps the picture), the same box again: the second picture is omnibox-2.png.
  await reopenBoard(page, thread, id);
  await omniboxBox(page);
  await addToReply(page);
  await close();
  await expect(files).toHaveAttribute('data-compose-file', 'done');
  await page.locator('.ib-pfoot').getByRole('button', { name: 'Cancel' }).click();
  await expect(reply).toHaveCount(0);
  await reopenBoard(page, thread, id);
  await omniboxBox(page);
  await addToReply(page);
  await close();
  await expect.poll(() => replyFileNames(page)).toEqual(['omnibox.png', 'omnibox-2.png']);
  await page.screenshot({ path: join(replyShots, '08-second-picture-after-cancel-light.png') });
  expect(problems).toEqual([]);
  await context.close();
});

test('Add to reply, then Send (⌘Enter): the reply goes with its picture, and its Undo ends with it', async ({ browser }) => {
  const { thread, agent } = await freshThread('send');
  const id = store('reply-send', thread);
  const { context, page, problems } = await openBoard(browser, id, {}, thread);
  const reply = page.getByRole('textbox', { name: /^Reply to / });
  await crosshair(page).click();
  await page.mouse.move(5, 5);
  await omniboxBox(page);
  await addToReply(page, 'Put the engine’s mark here.');
  await page.getByRole('button', { name: 'Close Shape' }).click();
  await expect(page.locator('[data-shape-layer]')).toHaveCount(0);
  await expect(page.locator('[data-compose-file-name]')).toHaveAttribute('data-compose-file', 'done');
  const toast = page.locator('.ib-toast', { hasText: 'Added to your reply' });
  await expect(toast).toHaveCount(1);
  await reply.press('ControlOrMeta+Enter');
  // The Send took it down at once, so no Undo can open an empty reply box.
  await gone(toast);
  const sent = await agent.nextReply(w.threads[thread]!, 20);
  expect(String(sent.body)).toContain('Put the engine’s mark here.');
  expect(JSON.stringify(sent)).toContain('omnibox.png');
  expect(problems).toEqual([]);
  await context.close();
});

test('a picture too big for the limit comes smaller, never missing', async ({ browser }) => {
  // A part that is pure noise: no size of it compresses, so its picture at full size is over SHAPE_LIMITS.notePicture.
  const { thread } = await freshThread('big');
  const dir = join(w.root, 'boards', 'reply-big');
  mkdirSync(dir, { recursive: true });
  const maker = await browser.newPage();
  const png = await maker.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 1100;
    c.height = 1100;
    const g = c.getContext('2d')!;
    const px = g.createImageData(c.width, c.height);
    for (let i = 0; i < px.data.length; i += 65536) crypto.getRandomValues(px.data.subarray(i, Math.min(i + 65536, px.data.length)));
    for (let i = 3; i < px.data.length; i += 4) px.data[i] = 255;
    g.putImageData(px, 0, 0);
    return c.toDataURL('image/png').split(',')[1]!;
  });
  await maker.close();
  writeFileSync(join(dir, 'noise.png'), Buffer.from(png, 'base64'));
  const html = '<svg viewBox="0 0 1200 1200" width="100%"><g data-mark="noise"><image x="40" y="40" width="1100" height="1100" href="noise.png"/></g></svg>';
  writeFileSync(join(dir, 'board.json'), JSON.stringify({ title: 'Static', claim: 'Noise, for the picture limit.', views: { picture: { html } } }));
  const r = w.shape(['update', '--file', join(dir, 'board.json'), '--project', w.projects.pando!, '--thread', w.threads[thread]!]);
  expect(r.status, r.stderr).toBe(0);
  const id = (JSON.parse(r.stdout) as { id: string }).id;
  const { context, page, problems } = await openBoard(browser, id, {}, thread);
  await crosshair(page).click();
  await page.mouse.move(5, 5);
  await drag(page, await at(page, 'noise', 0.1, 0.05), await at(page, 'noise', 0.9, 0.5));
  await addToReply(page, 'Too busy.');
  await expect(page.locator('[data-compose-file-name]')).toHaveAttribute('data-compose-file-name', 'noise.png', { timeout: 20_000 });
  await expect(page.locator('[data-compose-file-name]')).toHaveAttribute('data-compose-file', 'done', { timeout: 20_000 });
  expect(problems).toEqual([]);
  await context.close();
});

test('the video: the crosshair, a lazy drag, a comment, a kept box, then Show me', async ({ browser }) => {
  // A recording for people, made with ffmpeg: only when asked for.
  test.skip(!process.env.PLANNOTATOR_SHAPE_BOX_VIDEO, 'no video asked for (PLANNOTATOR_SHAPE_BOX_VIDEO=1)');
  const id = store('video');
  const raw = join(shots, 'video-raw');
  const { context, page } = await openBoard(browser, id, { deviceScaleFactor: 1, recordVideo: { dir: raw, size: { width: 1440, height: 900 } } });
  await showCursor(page);
  const c = (await crosshair(page).boundingBox())!;
  await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2, { steps: 25 });
  await page.waitForTimeout(400);
  await crosshair(page).click();
  await page.waitForTimeout(400);
  const a = await at(page, 'row-google', 0.12, 0.45);
  const b = await at(page, 'row-bing', 0.85, 0.6);
  await page.mouse.move(a.x, a.y, { steps: 30 });
  await page.waitForTimeout(300);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 45 });
  await page.waitForTimeout(300);
  await page.mouse.up();
  await page.waitForTimeout(500);
  await composer(page).locator('textarea').pressSequentially('Make Kagi the default and put it first.', { delay: 28 });
  await page.waitForTimeout(400);
  await composer(page).getByRole('button', { name: 'Change it' }).click();
  await page.waitForTimeout(1000);
  const f = await at(page, 'form', 0.08, 0.1);
  const g = await at(page, 'form', 1.03, 1.05);
  await page.mouse.move(f.x, f.y, { steps: 30 });
  await page.mouse.down();
  await page.mouse.move(g.x, g.y, { steps: 40 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  await composer(page).locator('textarea').pressSequentially('Show me how this works', { delay: 32 });
  const s = (await composer(page).getByRole('button', { name: 'Show me' }).boundingBox())!;
  await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2, { steps: 20 });
  await page.waitForTimeout(1300);
  const video = page.video()!;
  await context.close();
  const webm = await video.path();
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', webm, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', join(shots, 'drag.mp4')]);
});
