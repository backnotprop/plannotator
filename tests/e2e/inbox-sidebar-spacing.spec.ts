import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const builtBinary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const CLOSED_COOKIE = 'plannotator-inbox-sidebar-closed';
const SELF = 'ibx_01KSELF000000000000000000';
const OTHER = 'ibx_01KOTHERMACHINE0000000000';

interface World {
  url: string;
  thread: string;
  agent: SimAgent;
  context: BrowserContext;
  page: Page;
}
let world: World;

const layout = (page: Page, scope: string) =>
  page.evaluate((selector) => {
    const root = document.querySelector(selector)!;
    const short: Record<string, string> = { pinned: 'Pin', agents: 'Ag', projects: 'Proj' };
    let line = '';
    let bottom: number | null = null;
    for (const el of root.querySelectorAll('[data-sidebar-section], .ib-sidescroll .ib-pins, .ib-sidescroll .ib-agents-body, .ib-sidescroll .ib-projs')) {
      const section = el.getAttribute('data-sidebar-section');
      const rows = section ? [el] : [...el.children];
      if (rows.length === 0) continue;
      if (bottom !== null) line += ` -${Math.round(rows[0]!.getBoundingClientRect().top - bottom)}- `;
      line += section ? short[section] : 'rows';
      bottom = rows[rows.length - 1]!.getBoundingClientRect().bottom;
    }
    return line;
  }, scope);

async function open(closed: string[], phone = false, hash = ''): Promise<string> {
  const { context, page, url } = world;
  await context.clearCookies({ name: CLOSED_COOKIE });
  if (closed.length > 0) await context.addCookies([{ name: CLOSED_COOKIE, value: encodeURIComponent(closed.join(',')), url }]);
  await page.setViewportSize(phone ? { width: 390, height: 844 } : { width: 1280, height: 800 });
  await page.goto('about:blank');
  await page.goto(`${url}${hash}`);
  const scope = phone ? '[role="dialog"]' : '[aria-label="Inbox navigation"]';
  if (phone) await page.locator('.ib-lhead').getByRole('button', { name: 'Toggle Sidebar' }).click();
  await expect(page.locator(`${scope} [data-sidebar-section="pinned"]`)).toBeVisible();
  await expect(page.locator(`${scope} [data-sidebar-section="agents"]`)).toBeVisible();
  return scope;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  const root = inboxScratch('plannotator-inbox-spacing-e2e-');
  const dataDir = join(root, 'data');
  const home = join(root, 'home');
  mkdirSync(home);
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_INBOX_NOTES: '0',
    PLANNOTATOR_TEST_SANDBOX: '1',
    NO_ANON_PING: '1',
  };
  const started = spawnSync(builtBinary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  const url = started.stdout.trim();
  const agent = await SimAgent.connect({ binary: builtBinary, env, name: 'Claude Code', host: 'claude-code' });
  let thread = '';
  for (const name of ['plannotator', 'acme-web']) {
    const sent = await agent.send({ project_path: scratchProject(join(root, 'src'), name), subject: `Status of ${name}`, body: 'The build passed.' });
    thread = sent.thread_id as string;
  }
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(url);
  const status = await page.evaluate(async (id) => {
    const list = (await (await fetch('/api/inbox/threads?archived=exclude')).json()) as { serverSession: string };
    return (await fetch(`/api/inbox/threads/${id}/pin`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serverSession: list.serverSession, pinned: true }) })).status;
  }, thread);
  expect(status).toBeLessThan(300);
  await page.route(/\/api\/inbox\/threads(\?|$)/, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const response = await route.fetch();
    const json = (await response.json()) as Record<string, unknown>;
    const machine = { state: 'online', since: '2026-11-05T10:00:00.000Z', reason: null, version: '0.0.0', address: null, both_ways: true, waiting: 0 };
    json.self = SELF;
    json.machines = [{ ...machine, id: SELF, name: 'Studio', self: true }, { ...machine, id: OTHER, name: 'MacBook', self: false }];
    await route.fulfill({ response, json });
  });
  await page.route(/\/api\/inbox\/events\?/, async (route) => {
    const stream = new URL(route.request().url());
    stream.searchParams.delete('agents');
    await route.continue({ url: stream.toString() });
  });
  world = { url, thread, agent, context, page };
});

test.afterAll(async () => {
  try {
    await world?.agent.close().catch(() => {});
    await world?.context.close();
  } finally {
    await removeInboxScratch();
  }
});

for (const [device, phone, set, shut] of [['desktop', false, 12, 2], ['phone', true, 8, 8]] as const) {
  test(`${device}: closed headers sit evenly, and rows stay with their header and set off the next`, async () => {
    const { page } = world;
    expect(await layout(page, await open(['pinned', 'agents'], phone))).toBe(`Pin -${shut}- Ag -${shut}- Proj -0- rows`);
    expect(await layout(page, await open(['pinned', 'agents', 'projects'], phone))).toBe(`Pin -${shut}- Ag -${shut}- Proj`);
    expect(await layout(page, await open([], phone))).toBe(`Pin -0- rows -${set}- Ag -2- rows -${set}- Proj -0- rows`);
    expect(await layout(page, await open(['pinned'], phone))).toBe(`Pin -${shut}- Ag -2- rows -${set}- Proj -0- rows`);
    expect(await layout(page, await open(['agents'], phone))).toBe(`Pin -0- rows -${set}- Ag -${shut}- Proj -0- rows`);
  });
}

test("a closed section's kept row sets off the next header, like any rows", async () => {
  const { page, thread } = world;
  const scope = await open(['pinned', 'agents'], false, `#thread=${thread}`);
  await expect(page.locator(`${scope} .ib-pins > *`)).toHaveCount(1);
  expect(await layout(page, scope)).toBe('Pin -0- rows -12- Ag -2- Proj -0- rows');
});

test('the gap above Projects is no hover: the row around its header is exactly the header', async () => {
  const { page } = world;
  const scope = await open(['pinned', 'agents']);
  const header = (await page.locator(`${scope} [data-sidebar-section="projects"]`).boundingBox())!;
  const row = (await page.locator(`${scope} .ib-secrow`, { has: page.locator('[data-sidebar-section="projects"]') }).boundingBox())!;
  expect([row.y, row.height]).toEqual([header.y, header.height]);
});
