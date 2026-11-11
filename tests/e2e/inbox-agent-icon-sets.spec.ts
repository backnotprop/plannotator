/**
 * Agent icons from sets, the one critical flow in a real browser against the compiled binary (temp data dir and HOME,
 * sandboxed agent PATH, no browser opened): the face picker's "Sets" opens the agent icon dialog in the middle of the
 * window; an icon picked there applies at once, closes the dialog and gives focus back to the agent's face, and shows
 * on the row with no row changing size (pixel art at whole multiples, one-colour icons in the text colour); "Get" on a
 * fetchable set (a made-up one of generated pictures, tests/helpers/fake-icon-set.ts) fills its grid and finishes; the
 * window never reaches outside its Inbox. Everything else is guarded by the unit and DOM tests.
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

test('Sets: the dialog applies an icon everywhere at once, closes and gives focus back; Get fills a fetchable set', async () => {
  const { page, fake } = world;
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(world.url);
  await expect(page.locator(`[data-thread-id="${world.threads.tiny}"]`).first()).toBeVisible();
  if ((await page.locator('[data-agent-icon]').count()) === 0) await page.getByRole('button', { name: 'Agents', exact: true }).click();
  await expect.poll(() => page.locator('[data-agent-icon]').count()).toBeGreaterThanOrEqual(AGENTS.length);
  const ids = await agentIds(page);
  const before = await rowBoxes(page);
  // Nothing asked of the pointer until Sets opens.
  expect(fake.total()).toBe(0);

  // Three built-in icons, each picked in the dialog: it is centred, applies at once, closes, gives focus back.
  const dialog = page.locator('dialog[data-dialog="agent-icon"][open]');
  for (const [key, set, query] of [['tiny', 'tiny-creatures', 'zombie'], ['game', 'game-icons', 'wyvern'], ['dcss', 'dcss', 'orc wizard']] as const) {
    await openSets(page, ids[key]!);
    const box = (await dialog.boundingBox())!;
    const view = page.viewportSize()!;
    expect(Math.abs(box.x + box.width / 2 - view.width / 2)).toBeLessThan(2);
    await dialog.locator(`.am-sets-tab[data-set="${set}"]`).click();
    await dialog.locator('.am-sets-q').fill(query);
    if (key === 'tiny') await both(page, 'dialog-sets');
    await dialog.locator('.am-sets-i').first().click();
    await expect(dialog).toHaveCount(0);
    await expect(sidebarMark(page, ids[key]!)).toBeFocused();
    await expect(sidebarMark(page, ids[key]!).locator('[data-agent-mark]')).toHaveAttribute('data-face', AGENTS.find((a) => a.key === key)!.face);
    await expect(page.locator(`[data-thread-id="${world.threads[key]}"] .ib-set`).first()).toBeVisible();
  }
  await page.mouse.move(1000, 850);
  expect(await rowBoxes(page)).toEqual(before);
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const scales = await pixelScales(page);
    expect(scales.length).toBeGreaterThan(3);
    expect(scales.filter((s) => !wholeOrHalf(s.scale) || s.rendering !== 'pixelated')).toEqual([]);
    const mono = await monoColours(page);
    expect(mono.length).toBeGreaterThan(1);
    for (const m of mono) expect(m.fill).toBe(m.text);
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await both(page, 'list');

  // "Get": the grid fills in, then the set is like the others.
  await openSets(page, ids.blobs!);
  expect(fake.hits.get('/index.json')).toBe(1);
  await dialog.locator('.am-sets-tab[data-set="blobs"]').click();
  await dialog.locator('[data-get="blobs"]').click();
  await expect.poll(async () => dialog.locator('.am-sets-i:not(:disabled)').count(), { timeout: 20_000 }).toBeGreaterThan(8);
  await shot(page, 'fetch-2-filling-light', dialog);
  await expect(dialog.locator('.am-sets-get')).toHaveCount(0, { timeout: 30_000 });
  await expect(dialog.locator('.am-sets-i:not(:disabled)')).toHaveCount(64);
  await dialog.locator('.am-sets-i').nth(1).click();
  await expect(sidebarMark(page, ids.blobs!).locator('[data-agent-mark]')).toHaveAttribute('data-face', 'set:blobs/2');
  for (let n = 1; n <= 64; n++) expect(fake.hits.get(`/icons/${n}.png`)).toBe(1);
  expect(world.outside).toEqual([]);
});
