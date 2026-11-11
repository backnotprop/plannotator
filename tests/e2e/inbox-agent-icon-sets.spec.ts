/**
 * "Sets": icons from built-in and fetchable sets as agents' icons, proved in a real browser against the compiled binary
 * (temp data dir and HOME, sandboxed agent PATH, no browser opened, nothing real asked). The fetchable set is a made-up
 * one of generated pictures, served by a local fake server (tests/helpers/fake-icon-set.ts) that the Inbox's pointer
 * names (PLANNOTATOR_ICON_SETS_URL).
 *
 *  1. Nothing is asked of the pointer until the person opens Sets; the window itself never reaches outside its Inbox.
 *  2. The picker opens fast with the largest set, loading only the icons in view (timed and counted).
 *  3. A chosen icon shows on its agent everywhere: sidebar, list row, message author, the "to" pill, the Board card.
 *     No row changes size.
 *  4. Pixel sets are drawn nearest-neighbour at whole multiples of their native size (or exactly half) on 1x, 2x and 3x
 *     screens; one-colour icons take the theme's text colour in light and dark.
 *  5. "Get" downloads a fetchable set in one click; its grid fills in as icons arrive.
 *
 * PNGs land in PLANNOTATOR_ICON_SETS_SHOTS when set. Build the binary first (see inbox.spec.ts).
 */
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { E2E_LAUNCH_OFF, inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';
import { serveFakeIconSet, type FakeIconSet } from '../helpers/fake-icon-set';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shots = process.env.PLANNOTATOR_ICON_SETS_SHOTS ? resolve(process.env.PLANNOTATOR_ICON_SETS_SHOTS) : null;

interface World {
  root: string;
  url: string;
  agents: SimAgent[];
  context: BrowserContext;
  page: Page;
  threads: Record<string, string>;
  outside: string[];
  fake: FakeIconSet;
  env: Record<string, string>;
}
let world: World;

const AGENTS = [
  { key: 'tiny', name: 'Claude Code', host: 'claude-code', subject: 'Pricing page copy', face: 'set:tiny-creatures/zombie' },
  { key: 'game', name: 'Codex', host: 'codex', subject: 'Release 0.28.62', face: 'set:game-icons/wyvern' },
  { key: 'dcss', name: 'Pi', host: 'pi', subject: 'Docs: Inbox guide', face: 'set:dcss/orc-wizard' },
  { key: 'blobs', name: 'OpenCode', host: 'opencode', subject: 'Scratch: CSV import', face: 'set:blobs/2' },
  { key: 'noto', name: 'Claude Code', host: 'claude-code', subject: 'Agent icons brief', face: 'set:noto-3d/fox' },
] as const;

async function shot(page: Page, name: string, target?: Locator): Promise<void> {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.waitForTimeout(250);
  if (target) await target.screenshot({ path: join(shots, `${name}.png`) });
  else await page.screenshot({ path: join(shots, `${name}.png`) });
}
async function both(page: Page, name: string, target?: Locator) {
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, `${name}-dark`, target);
  await page.emulateMedia({ colorScheme: 'light' });
  await shot(page, `${name}-light`, target);
}

const sidebarMark = (page: Page, agentId: string) => page.locator(`[data-agent-icon="${agentId}"]`);

async function rowBoxes(page: Page) {
  return page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll<HTMLElement>('[data-thread-id]')].map((row) => [
        row.dataset.threadId,
        {
          h: +row.getBoundingClientRect().height.toFixed(2),
          tiles: [...row.querySelectorAll('.ib-atile')].map((t) => {
            const r = t.getBoundingClientRect();
            return `${r.width.toFixed(2)}x${r.height.toFixed(2)}`;
          }),
        },
      ]),
    ),
  );
}

async function agentIds(page: Page): Promise<Record<string, string>> {
  const marks = await page.locator('.ib-sbagent').evaluateAll((rows) => rows.map((row) => ({ id: row.querySelector('[data-agent-icon]')?.getAttribute('data-agent-icon') ?? '', label: (row.querySelector('.ib-proj') as HTMLElement | null)?.innerText ?? '' })));
  return Object.fromEntries(
    AGENTS.map((a) => {
      const found = marks.find((m) => m.label.split('\n')[0]!.trim() === a.key);
      if (!found) throw new Error(`no sidebar mark for ${a.key}: ${JSON.stringify(marks)}`);
      return [a.key, found.id];
    }),
  );
}

async function openFan(page: Page, agentId: string) {
  await sidebarMark(page, agentId).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.am-fan[data-open] [data-face-choice="sets"]')).toBeVisible();
}
async function openSets(page: Page, agentId: string): Promise<Locator> {
  await openFan(page, agentId);
  await page.locator('.am-fan[data-open] [data-face-choice="sets"]').click();
  const panel = page.locator('dialog[data-dialog="agent-icon"][open]');
  await expect(panel).toBeVisible();
  return panel;
}
async function closeSets(page: Page) {
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog[data-dialog="agent-icon"][open]')).toHaveCount(0);
  await page.mouse.move(1000, 850);
}

/** Every pixel icon drawn: its scale in device pixels against its native size (a whole number, or exactly 1/2 or 1/4). */
async function pixelScales(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLImageElement>('.ib-set[data-pixel] > img, .am-setart[data-pixel] > img, .am-sets-art[data-pixel] > img')]
      .filter((img) => img.offsetParent && img.getAttribute('src'))
      .map((img) => {
        const native = parseFloat(getComputedStyle(img.parentElement!).getPropertyValue('--set-px'));
        const width = parseFloat(getComputedStyle(img).width);
        return { where: img.parentElement!.className, scale: +((width * devicePixelRatio) / native).toFixed(4), rendering: getComputedStyle(img).imageRendering };
      }),
  );
}
/**
 * A whole multiple, or exactly a half or a quarter. Within 1 %: on a 3x screen a third of a CSS pixel is snapped to the
 * layout's 1/64 px grid (32 device px drawn as 31.97), far less than one source pixel.
 */
const wholeOrHalf = (scale: number) => [Math.round(scale), 0.5, 0.25].some((k) => k > 0 && Math.abs(scale - k) < 0.01);

/** Every one-colour icon drawn: its fill against the theme's text colour where it sits, and that it is a mask. */
async function monoColours(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.ib-set-mono, .am-set-mono, .am-sets-mono')]
      .filter((el) => el.offsetParent && getComputedStyle(el).maskImage.startsWith('url('))
      .map((el) => {
        // The text colour in that place (the sidebar's own theme variables, a row's, a card's).
        const probe = document.createElement('span');
        probe.style.color = 'var(--foreground)';
        el.parentElement!.append(probe);
        const text = getComputedStyle(probe).color;
        probe.remove();
        return { fill: getComputedStyle(el).backgroundColor, text };
      }),
  );
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const fake = await serveFakeIconSet({ count: 64, delayMs: 350 });
  const root = inboxScratch('plannotator-inbox-icon-sets-e2e-');
  const data = join(root, 'data');
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, 'config.json'), JSON.stringify({ ...E2E_LAUNCH_OFF, inboxBoard: true, inboxBoardIntro: { shownAt: new Date().toISOString() } }));
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    PLANNOTATOR_DATA_DIR: data,
    PLANNOTATOR_TEST_SANDBOX: '1',
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_ICON_SETS_URL: fake.pointer,
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const project = scratchProject(join(root, 'src'), 'plannotator');
  const agents: SimAgent[] = [];
  const threads: Record<string, string> = {};
  const firsts: Record<string, string> = {};
  for (const a of AGENTS) {
    const agent = await SimAgent.connect({ binary, env, name: a.name, host: a.host });
    agents.push(agent);
    const sent = await agent.send({ project_path: project, subject: a.subject, thread: a.key, body: [`${a.subject}: one decision waits on you.`, '', ':::question', 'Ship it?', '', '- [ ] Yes', '- [ ] No', ':::'].join('\n') });
    threads[a.key] = sent.thread_id as string;
    await agent.card({ op: 'create', project_path: project, title: a.subject, column: 'in_progress', thread_id: sent.thread_id });
    firsts[a.key] = sent.message_id as string;
  }
  // A second agent in the first thread: the reply box then offers its "to" pill.
  const helper = await SimAgent.connect({ binary, env, name: 'Helper', host: 'claude-code' });
  agents.push(helper);
  const helped = await helper.send({ project_path: project, reply_to: firsts.tiny, body: 'I can take the copy edits too.' });
  await agents[0]!.send({ project_path: project, reply_to: helped.message_id as string, body: [':::question', 'Ship the copy today?', '', '- [ ] Yes', '- [ ] No', ':::'].join('\n') });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  world = { root, url: started.stdout.trim(), agents, context, page, threads, outside: [], fake, env };
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.host !== new URL(world.url).host) world.outside.push(request.url());
  });
});

test.afterAll(async () => {
  try {
    if (!world) return;
    for (const agent of world.agents) await agent.close().catch(() => {});
    await world.context.close();
    await world.fake.stop();
  } finally {
    await removeInboxScratch();
  }
});

test('Sets: the pointer is read only when Sets opens; the largest set opens fast, loading only what is in view', async () => {
  const { page, fake } = world;
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(world.url);
  await expect(page.locator(`[data-thread-id="${world.threads.tiny}"]`).first()).toBeVisible();
  if ((await page.locator('[data-agent-icon]').count()) === 0) await page.getByRole('button', { name: 'Agents', exact: true }).click();
  await expect.poll(() => page.locator('[data-agent-icon]').count()).toBeGreaterThanOrEqual(AGENTS.length);
  const ids = await agentIds(page);
  // Started, the list and the sidebar drawn, the fan opened: the pointer not asked yet.
  await openFan(page, ids.tiny!);
  await page.locator('.am-fan[data-open] [data-face-choice="sets"]').focus();
  await shot(page, 'fan-sets-place-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, 'fan-sets-place-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  expect(fake.total()).toBe(0);
  await page.keyboard.press('Enter');
  await expect(page.locator('dialog[data-dialog="agent-icon"][open]')).toBeVisible();
  await expect.poll(() => fake.hits.get('/index.json') ?? 0).toBe(1);
  // Only the pointer: nothing of the set itself until "Get".
  expect(fake.total()).toBe(1);
  await expect(page.locator('.am-sets-tab')).toHaveText(['Tiny Creatures', 'game-icons.net', 'Dungeon Crawl', 'Noto Emoji 3D', 'Blobs']);

  // Each built-in set's grid, light and dark.
  for (const [set, name] of [['tiny-creatures', 'tiny'], ['game-icons', 'game'], ['noto-3d', 'noto'], ['dcss', 'dcss']] as const) {
    await page.locator(`.am-sets-tab[data-set="${set}"]`).click();
    await expect(page.locator('.am-sets-i').first()).toBeVisible();
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLElement>('.am-sets-art')].slice(0, 24).every((el) => el.style.getPropertyValue('--set-src') || el.querySelector('img')?.complete));
    await both(page, `grid-${name}`);
  }
  await closeSets(page);

  // Timed: open Sets on the largest set (Dungeon Crawl, 419 icons, the one last looked at), cold then warm.
  const timings: Record<string, unknown>[] = [];
  for (const round of ['first', 'again']) {
    await openFan(page, ids.tiny!);
    timings.push(
      await page.evaluate(async (label) => {
        const frame = () => new Promise((done) => requestAnimationFrame(() => done(null)));
        const t0 = performance.now();
        document.querySelector<HTMLButtonElement>('.am-fan[data-open] [data-face-choice="sets"]')!.click();
        const until = t0 + 20_000;
        while (document.querySelectorAll('dialog[data-dialog="agent-icon"][open] .am-sets-i').length < 419 && performance.now() < until) await frame();
        const grid = performance.now() - t0;
        const scroller = document.querySelector('.am-sets-scroll')!.getBoundingClientRect();
        while (performance.now() < until) {
          await frame();
          const visible = [...document.querySelectorAll<HTMLImageElement>('.am-sets-i img')].filter((img) => {
            const r = img.getBoundingClientRect();
            return r.bottom > scroller.top && r.top < scroller.bottom;
          });
          // Every cell in view has been given its address, and every one has loaded.
          if (visible.length && visible.every((img) => img.getAttribute('src') && img.complete && img.naturalWidth > 0)) break;
        }
        return { round: label, cells: document.querySelectorAll('.am-sets-i').length, gridMs: Math.round(grid), iconsInViewMs: Math.round(performance.now() - t0), iconsAsked: document.querySelectorAll('.am-sets-i img[src]').length };
      }, round),
    );
    await closeSets(page);
  }
  console.log('PICKER-TIMING', JSON.stringify(timings));
  for (const t of timings) {
    expect(t.cells).toBe(419);
    expect(t.iconsInViewMs as number).toBeLessThan(5000);
    expect(t.gridMs as number).toBeLessThan(1000);
    // Lazy: far fewer icons asked than the set holds.
    expect(t.iconsAsked as number).toBeLessThan(150);
  }
  expect(world.outside).toEqual([]);
});

test('search by name and by number', async () => {
  const { page } = world;
  const ids = await agentIds(page);
  await openSets(page, ids.tiny!);
  await page.locator('.am-sets-tab[data-set="dcss"]').click();
  await page.locator('.am-sets-q').fill('orc');
  await expect(page.locator('.am-sets-head')).toContainText('found');
  await page.waitForTimeout(300);
  await both(page, 'search-name');
  await page.locator('.am-sets-q').fill('27');
  await expect(page.locator('.am-sets-i')).toHaveCount(1);
  await expect(page.locator('.am-sets-n')).toHaveText('#027');
  await page.waitForTimeout(300);
  await both(page, 'search-number');
  await closeSets(page);
});

test('a chosen icon shows everywhere; no row changes size; pixel art at whole multiples; one colour takes the text colour', async () => {
  const { page } = world;
  const ids = await agentIds(page);
  const before = await rowBoxes(page);
  // Three built-in icons, chosen through the panel's search.
  for (const [key, set, query] of [['tiny', 'tiny-creatures', 'zombie'], ['game', 'game-icons', 'wyvern'], ['dcss', 'dcss', 'orc wizard'], ['noto', 'noto-3d', 'fox']] as const) {
    await openSets(page, ids[key]!);
    await page.locator(`.am-sets-tab[data-set="${set}"]`).click();
    await page.locator('.am-sets-q').fill(query);
    await page.locator('.am-sets-i').first().click();
    await expect(page.locator('dialog[data-dialog="agent-icon"][open]')).toHaveCount(0);
    await expect(sidebarMark(page, ids[key]!).locator('[data-agent-mark]')).toHaveAttribute('data-face', AGENTS.find((a) => a.key === key)!.face);
  }
  await page.mouse.move(1000, 850);
  // The sidebar's icon takes the mark's box exactly.
  for (const key of ['tiny', 'game', 'dcss', 'noto']) expect(await sidebarMark(page, ids[key]!).locator('.am-face:not([hidden]) .am-setart').evaluate((el) => [(el as HTMLElement).offsetWidth, (el as HTMLElement).offsetHeight])).toEqual([24, 24]);
  for (const key of ['tiny', 'game', 'dcss', 'noto']) await expect(page.locator(`[data-thread-id="${world.threads[key]}"] .ib-set`).first()).toBeVisible();
  expect(await rowBoxes(page)).toEqual(before);
  await both(page, 'list');
  await both(page, 'sidebar', page.locator('.ib-sbagent').first().locator('xpath=..'));

  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const scales = await pixelScales(page);
    expect(scales.length).toBeGreaterThan(3);
    for (const s of scales) expect({ ...s, ok: wholeOrHalf(s.scale) && s.rendering === 'pixelated' }).toMatchObject({ ok: true });
    const mono = await monoColours(page);
    expect(mono.length).toBeGreaterThan(1);
    for (const m of mono) expect(m.fill).toBe(m.text);
  }
  await page.emulateMedia({ colorScheme: 'light' });

  // The thread: the author and the "to" pill.
  await page.locator(`[data-thread-id="${world.threads.tiny}"]`).first().click();
  await expect.poll(() => page.locator('.ib-set img[src="/api/inbox/icon-sets/tiny-creatures/zombie"]').count()).toBeGreaterThanOrEqual(2);
  await page.keyboard.press('r');
  await expect(page.locator('.ib-rto .ib-set img[src="/api/inbox/icon-sets/tiny-creatures/zombie"]')).toBeVisible();
  await both(page, 'thread');
  await page.keyboard.press('Escape');

  // The Board's cards.
  await page.evaluate(() => (location.hash = '#board'));
  for (const key of ['tiny', 'dcss']) await expect(page.locator(`.ib-bc-who .ib-set img[src="/api/inbox/icon-sets/${AGENTS.find((a) => a.key === key)!.face.slice(4)}"]`).first()).toBeVisible();
  await expect(page.locator('.ib-bc-who .ib-set[data-mono]').first()).toBeVisible();
  for (const s of await pixelScales(page)) expect(wholeOrHalf(s.scale)).toBe(true);
  await both(page, 'board');
  await page.evaluate(() => (location.hash = ''));
  expect(world.outside).toEqual([]);
});

test('the credits line under game-icons.net', async () => {
  const { page } = world;
  const ids = await agentIds(page);
  await openSets(page, ids.game!);
  await expect(page.locator('.am-sets-credit')).toHaveText('Icons by game-icons.net authors · CC BY 3.0 · Credits');
  const credits = await page.request.get(new URL((await page.locator('.am-sets-credit a').getAttribute('href'))!, world.url).toString());
  expect(await credits.text()).toContain('Icons made by Delapouite');
  await both(page, 'credits', page.locator('dialog[data-dialog="agent-icon"][open]'));
  await closeSets(page);
});

test('a fetchable set: "Get", the grid filling in, then a set like the others', async () => {
  const { page, fake } = world;
  const ids = await agentIds(page);
  await openSets(page, ids.blobs!);
  await page.locator('.am-sets-tab[data-set="blobs"]').click();
  await expect(page.locator('.am-sets-get')).toContainText('64 icons');
  await both(page, 'fetch-1-get', page.locator('dialog[data-dialog="agent-icon"][open]'));
  await page.locator('[data-get="blobs"]').click();
  await expect.poll(async () => page.locator('.am-sets-i:not(:disabled)').count(), { timeout: 20_000 }).toBeGreaterThan(8);
  await shot(page, 'fetch-2-filling-light', page.locator('dialog[data-dialog="agent-icon"][open]'));
  await expect(page.locator('.am-sets-get')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.locator('.am-sets-i:not(:disabled)')).toHaveCount(64);
  await page.waitForTimeout(400);
  await both(page, 'fetch-3-done', page.locator('dialog[data-dialog="agent-icon"][open]'));
  await page.locator('.am-sets-i').nth(1).click();
  await expect(sidebarMark(page, ids.blobs!).locator('[data-agent-mark]')).toHaveAttribute('data-face', 'set:blobs/2');
  await expect(page.locator(`[data-thread-id="${world.threads.blobs}"] .ib-set img[src="/api/inbox/icon-sets/blobs/2"]`).first()).toBeVisible();
  // Every icon asked of the fake server once; the window itself never reached it.
  for (let n = 1; n <= 64; n++) expect(fake.hits.get(`/icons/${n}.png`)).toBe(1);
  expect(world.outside).toEqual([]);
});

test('the dialog: in the middle of the window, picking applies and closes, Escape closes, focus returns to the face', async () => {
  const { page } = world;
  const ids = await agentIds(page);
  const before = await rowBoxes(page);
  // "Your own…" from the fan: the Inbox's dialog, centred, naming the agent with its icon now.
  await openFan(page, ids.noto!);
  await page.locator('.am-fan[data-open] [data-face-choice="own"]').click();
  const dialog = page.locator('dialog[data-dialog="agent-icon"][open]');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('h2')).toHaveText('noto');
  await expect(dialog.locator('.ib-agi-mark .ib-set img')).toHaveAttribute('src', '/api/inbox/icon-sets/noto-3d/fox');
  const box = (await dialog.boundingBox())!;
  const view = page.viewportSize()!;
  expect(Math.abs(box.x + box.width / 2 - view.width / 2)).toBeLessThan(2);
  expect(Math.abs(box.y + box.height / 2 - view.height / 2)).toBeLessThan(2);
  expect(box.width).toBeGreaterThan(600);
  await both(page, 'dialog-your-own');
  // Escape: closed, focus back on the agent's face, nothing changed.
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(sidebarMark(page, ids.noto!)).toBeFocused();
  // "Sets": wider grid; picking applies at once and closes; focus back on the face.
  await openFan(page, ids.noto!);
  await page.locator('.am-fan[data-open] [data-face-choice="sets"]').click();
  await expect(dialog.locator('.am-sets-q')).toBeFocused();
  await dialog.locator('.am-sets-tab[data-set="tiny-creatures"]').click();
  await page.waitForTimeout(300);
  await both(page, 'dialog-sets');
  const columns = await dialog.locator('.am-sets-g').evaluate((g) => getComputedStyle(g).gridTemplateColumns.split(' ').length);
  expect(columns).toBeGreaterThanOrEqual(10);
  await dialog.locator('.am-sets-i').nth(5).click();
  await expect(dialog).toHaveCount(0);
  await expect(sidebarMark(page, ids.noto!).locator('[data-agent-mark]')).toHaveAttribute('data-face', /^set:tiny-creatures\//);
  await expect(sidebarMark(page, ids.noto!)).toBeFocused();
  // A click outside closes it too.
  await openFan(page, ids.noto!);
  await page.locator('.am-fan[data-open] [data-face-choice="sets"]').click();
  await expect(dialog).toBeVisible();
  await page.mouse.click(view.width - 10, view.height - 10);
  await expect(dialog).toHaveCount(0);
  expect(await rowBoxes(page)).toEqual(before);
  // Back to the fox for the shots that follow.
  await openSets(page, ids.noto!);
  await dialog.locator('.am-sets-tab[data-set="noto-3d"]').click();
  await dialog.locator('.am-sets-q').fill('fox');
  await dialog.locator('.am-sets-i').first().click();
  await page.mouse.move(1000, 850);
});

test('phone: the dialog is a full-height sheet', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await page.goto(world.url);
  await expect(page.locator(`[data-thread-id="${world.threads.dcss}"]`).first()).toBeVisible();
  await page.getByRole('button', { name: /Toggle Sidebar/ }).first().click();
  const ids = await agentIds(page);
  await sidebarMark(page, ids.tiny!).focus();
  await page.keyboard.press('Enter');
  await page.locator('.am-fan[data-open] [data-face-choice="sets"]').click();
  const dialog = page.locator('dialog[data-dialog="agent-icon"][open]');
  await expect(dialog).toBeVisible();
  await page.waitForTimeout(400);
  const box = (await dialog.boundingBox())!;
  expect(box.width).toBe(390);
  expect(Math.round(box.y + box.height)).toBe(844);
  expect(box.height).toBeGreaterThan(780);
  await both(page, 'dialog-phone-sets');
  await dialog.locator('[data-agi-place="own"]').click();
  await page.waitForTimeout(200);
  await both(page, 'dialog-phone-your-own');
  await context.close();
});

test('phone and other screens: the icons at phone size, pixel art at whole multiples on 1x and 3x', async ({ browser }) => {
  for (const [scale, viewport] of [
    [3, { width: 390, height: 844 }],
    [1, { width: 1440, height: 900 }],
  ] as const) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: scale, hasTouch: scale === 3, isMobile: scale === 3 });
    const page = await context.newPage();
    await page.goto(world.url);
    await expect(page.locator(`[data-thread-id="${world.threads.dcss}"] .ib-set`).first()).toBeVisible();
    await page.waitForTimeout(400);
    const scales = await pixelScales(page);
    expect(scales.length).toBeGreaterThan(0);
    expect(scales.filter((s) => !wholeOrHalf(s.scale) || s.rendering !== 'pixelated').map((s) => ({ screen: scale, ...s }))).toEqual([]);
    console.log('PIXEL-SCALES', scale, JSON.stringify([...new Set(scales.map((s) => `${s.where.split(' ')[0]}:${s.scale}`))]));
    if (scale === 3) await both(page, 'phone-list');
    await context.close();
  }
});
