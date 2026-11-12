import { devices, expect, test, type Browser, type Page } from '@playwright/test';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { removeInboxScratch } from './inbox-scratch';
import { seedShapeWorld, type ShapeWorld } from './inbox-shape-seed';
// @ts-expect-error the kit is plain JavaScript, with no types
import { box, followCss, on, part, pick, svg, text } from '../../packages/core/shape-kit.mjs';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const { defaultBrowserType: _phoneBrowser, ...phone } = devices['iPhone 15'];
let w: ShapeWorld;

const follow =
  pick('all', 20, 10, 140, 44, 'All paths', { of: ['a', 'b'], checked: true }) +
  pick('a', 180, 10, 140, 44, 'Path A') +
  on(['a'], part('p-a', 1, box(20, 80, 240, 90), text(40, 130, 'Path A box'))) +
  on(['b'], part('p-b', 2, box(20, 200, 240, 90), text(40, 250, 'Path B box')));
const shapes =
  '<rect id="lone-dash" class="dash" x="300" y="80" width="120" height="60" stroke-width="2"></rect>' +
  '<rect id="own-dash" class="dash" fill="var(--mark-soft)" stroke="var(--mark)" x="300" y="300" width="120" height="60"></rect>' +
  '<svg id="nested" x="300" y="160" width="40" height="40" viewBox="0 0 40 40"><rect id="past-edge" x="0" y="0" width="400" height="400" class="line"></rect></svg>' +
  '<image id="kept" href="shot.png" x="460" y="80" width="200" height="120"></image>' +
  '<g data-ref="1"><circle cx="700" cy="60" r="14" style="fill:var(--mark)"></circle></g>' +
  '<foreignObject x="700" y="100" width="40" height="40"><span data-ref="2"></span></foreignObject>';
const board = {
  title: 'Follow a path',
  claim: 'Built. Nothing waits on you.',
  views: {
    picture: { html: svg(900, 400, shapes).html.replace('width="100%"', 'width="900" height="400"'), width: 900, height: 400 },
    how: { ...svg(900, 400, follow), css: followCss(['a', 'b']) },
    know: 'The first thing to **know** [^1].\n\nThe second thing to know.',
  },
  refs: [{ n: 1, kind: 'image', title: 'The screen', sub: 'One line about it.', target: 'shot.png', images: [{ src: 'shot.png', alt: 'The screen', crop: [0, 0, 0.5, 0.5] }] }, { n: 2, kind: 'link', title: 'The page', target: 'https://example.com/page' }],
};

function store(key: string, value: unknown): string {
  const dir = join(w.root, 'boards', key);
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(repo, 'tests/manual/shape-harness/public/refs/built-desktop-light.png'), join(dir, 'shot.png'));
  writeFileSync(join(dir, 'board.json'), JSON.stringify(value));
  const r = w.shape(['update', '--file', join(dir, 'board.json'), '--project', w.projects.plannotator!, '--thread', w.threads.snooze!]);
  expect(r.status, r.stderr).toBe(0);
  return (JSON.parse(r.stdout) as { id: string }).id;
}

async function openBoard(browser: Browser, id: string, options: Parameters<Browser['newContext']>[0] = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options });
  await context.grantPermissions(['notifications'], { origin: new URL(w.url).origin });
  await context.route((url) => !['127.0.0.1', 'localhost'].includes(url.hostname), (route) => route.abort());
  const page = await context.newPage();
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(e.message));
  page.on('response', (r) => { if (r.status() >= 400 && r.url().includes('/api/shapes')) problems.push(`${r.status()} ${r.url()}`); });
  await page.goto(`${w.url}#thread=${w.threads.snooze}&shape=${id}`);
  await expect(page.locator('.shp-dock')).toBeVisible();
  await page.waitForTimeout(1500);
  return { context, page, problems };
}
const view = (page: Page, name: string) => page.locator('.shp-dock').getByRole('button', { name, exact: true }).click();
const crosshair = (page: Page) => page.locator('.shp-dock').getByRole('button', { name: 'Comment', exact: true });
const drawing = <T,>(page: Page, fn: (root: ShadowRoot) => T) =>
  page.evaluate(`(${fn.toString()})(document.querySelector('.shp-view:not(.leaving) .shp-drawn-host').shadowRoot)`) as Promise<T>;

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  w = await seedShapeWorld({ binary, shape: true, boards: 'none' });
});
test.afterAll(async () => {
  for (const agent of w?.agents ?? []) await agent.close().catch(() => {});
  await removeInboxScratch();
});

test('pick follows a path, off and on annotation, and opens no box', async ({ browser }) => {
  const { context, page, problems } = await openBoard(browser, store('follow', board));
  await view(page, 'How it works');
  await page.waitForTimeout(1500);
  const faded = () => drawing(page, (r) => [...r.querySelectorAll('.d')].map((d) => Number(getComputedStyle(d).opacity).toFixed(2)));
  expect(await faded()).toEqual(['1.00', '1.00']);
  const pickA = page.locator('.shp-view:not(.leaving) label.pick', { hasText: 'Path A' });
  await pickA.click();
  await page.waitForTimeout(500);
  expect(await faded()).toEqual(['1.00', '0.12']);
  expect(await drawing(page, (r) => (r.querySelector('input.f-a') as HTMLInputElement).checked)).toBe(true);
  await expect(page.locator('[data-comment-popover]')).toHaveCount(0);

  await crosshair(page).click();
  await page.locator('.shp-view:not(.leaving) label.pick', { hasText: 'All paths' }).click();
  await page.waitForTimeout(500);
  expect(await faded()).toEqual(['1.00', '1.00']);
  await expect(page.locator('[data-comment-popover]')).toHaveCount(0);
  expect(problems).toEqual([]);
  await context.close();
});

test('annotation is off until asked for; an SVG part can be picked once it is on', async ({ browser }) => {
  const { context, page, problems } = await openBoard(browser, store('annotate', board));
  await view(page, 'How it works');
  await page.waitForTimeout(1500);
  const part = page.locator('.shp-view:not(.leaving) [data-mark="p-a"]');
  await part.hover();
  await expect(page.locator('.shp-pin-hover')).toHaveCount(0);
  await part.click();
  await expect(page.locator('[data-comment-popover]')).toHaveCount(0);

  await crosshair(page).click();
  await page.mouse.move(5, 5);
  await part.hover();
  await expect(page.locator('.shp-pin-hover')).toHaveCount(0);
  await part.click();
  await expect(page.locator('[data-comment-popover]')).toContainText('Path A box');
  expect(problems).toEqual([]);
  await context.close();
});

test('a nested svg clips, a lone dash is an outline, a kept picture loads, a number shows its bubble', async ({ browser }) => {
  const id = store('frame', board);
  const { context, page, problems } = await openBoard(browser, id);
  const styles = await drawing(page, (r) => ({
    outer: getComputedStyle(r.querySelector('svg')!).overflow,
    nested: getComputedStyle(r.querySelector('#nested')!).overflow,
    fill: getComputedStyle(r.querySelector('#lone-dash')!).fill,
    dasharray: getComputedStyle(r.querySelector('#lone-dash')!).strokeDasharray,
    ownFill: getComputedStyle(r.querySelector('#own-dash')!).fill,
    ownStroke: getComputedStyle(r.querySelector('#own-dash')!).stroke,
    loneStroke: getComputedStyle(r.querySelector('#lone-dash')!).stroke,
    href: r.querySelector('#kept')!.getAttribute('href'),
  }));
  expect(styles.outer).toBe('visible');
  expect(styles.nested).toBe('hidden');
  expect(styles.fill).toBe('none');
  expect(styles.dasharray).not.toBe('none');
  expect(styles.ownFill).not.toBe('none');
  expect(styles.ownStroke).not.toBe(styles.loneStroke);
  expect(styles.href).toContain('/files/');
  expect((await page.request.get(new URL(styles.href!, w.url).href)).status()).toBe(200);

  await page.locator('.shp-view:not(.leaving) .shp-drawn [data-ref="1"]').hover();
  const peek = page.locator('.shp-peek');
  await expect(peek).toContainText('One line about it.');
  await expect(peek.locator('.shp-peek-crop')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(peek).toHaveCount(0);
  await expect(page.locator('.shp-surface')).toBeVisible();
  expect(problems).toEqual([]);

  await page.goto(`${w.url}#shapes`);
  await expect(page.locator('[data-shape-page] .shp-gcard').first()).toBeVisible();
  await page.waitForTimeout(1000);
  const thumbs = await page.evaluate(() => [...document.querySelectorAll('.shp-thumb .shp-drawn-host')].map((h) => h.shadowRoot?.querySelector('#kept')?.getAttribute('href') ?? ''));
  expect(thumbs.some((href) => href.includes('/files/'))).toBe(true);
  expect(problems).toEqual([]);
  await context.close();
});

test('views.know is not drawn: no tab, no words, the drawing is the last thing in the view; a board saved with Requirements still opens without them', async ({ browser }) => {
  const { context, page, problems } = await openBoard(browser, store('know', board));
  await expect(page.locator('.shp-dock').getByRole('button', { name: 'Shape', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.shp-dock').getByRole('button', { name: 'What to know', exact: true })).toHaveCount(0);
  await expect(page.locator('.shp-know')).toHaveCount(0);
  await expect(page.locator('.shp-root')).not.toContainText('The first thing to know');
  const last = await page.locator('.shp-view:not(.leaving)').evaluate((v) => {
    v.scrollTop = v.scrollHeight;
    return v.lastElementChild?.classList.contains('shp-drawn') ?? false;
  });
  expect(last).toBe(true);
  await context.close();
  expect(problems).toEqual([]);

  const id = store('old', { title: 'Old board', claim: 'Saved before What to know.', views: { picture: { html: '<p data-mark="p">Picture</p>' } }, refs: [{ n: 1, kind: 'link', title: 'R', target: 'https://example.com/r' }] });
  const shapes = join(w.dataDir, 'shapes');
  const file = readdirSync(shapes).map((p) => join(shapes, p, id, 'versions.jsonl')).find(existsSync)!;
  const v = JSON.parse(readFileSync(file, 'utf8').trim());
  v.views.reqs = { heading: 'What I understand', groups: [{ id: 'g', label: 'Who gets it', items: [{ id: 'r-1', text: 'At least **2 days** [^1]' }, { id: 'r-2', text: 'Never a guest' }] }], foot: [{ label: 'Open', text: 'Nothing waits.' }] };
  v.parts.push({ view: 'reqs', id: 'r-1', text: 'Who gets it: At least **2 days** [^1]' });
  writeFileSync(file, `${JSON.stringify(v)}\n`);

  const old = await openBoard(browser, id);
  await expect(old.page.locator('.shp-dock').getByRole('button', { name: 'Shape', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(old.page.locator('.shp-view:not(.leaving) .shp-drawn')).toHaveCount(1);
  await expect(old.page.locator('.shp-know')).toHaveCount(0);
  await expect(old.page.locator('.shp-root')).not.toContainText('What I understand');
  expect(old.problems).toEqual([]);
  await old.context.close();
});

test('a phone pans a canvas with no tall drawing', async ({ browser }) => {
  const { context, page, problems } = await openBoard(browser, store('phone', board), { ...phone });
  const frame = page.locator('.shp-view:not(.leaving) .shp-drawn.pan');
  await expect(frame).toHaveCount(1);
  expect(await drawing(page, (r) => getComputedStyle(r.querySelector('.shp-rb:not(.own)') ?? r.querySelector('.shp-rb')!).minWidth)).toBe('22px');
  const wider = await page.locator('.shp-view:not(.leaving)').evaluate((v) => {
    const scroller = [v, ...v.querySelectorAll('*')].find((el) => el.scrollWidth > el.clientWidth + 40 && /(auto|scroll)/.test(getComputedStyle(el).overflowX));
    return !!scroller;
  });
  expect(wider).toBe(true);
  expect(problems).toEqual([]);
  await context.close();
});
