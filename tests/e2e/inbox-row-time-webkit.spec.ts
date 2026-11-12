import { devices, expect, test, type BrowserContext, type Browser, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shots = process.env.PLANNOTATOR_ROW_TIME_SHOTS ? resolve(process.env.PLANNOTATOR_ROW_TIME_SHOTS) : null;
const tag = process.env.PLANNOTATOR_ROW_TIME_TAG ?? 'row-time';

const LONG_PROJECT = 'a-very-long-project-name-that-never-seems-to-end-at-all';
const LINE = 17;
const ROW_PADDING = 16;

const today = (hours: number) => {
  const date = new Date();
  date.setHours(hours, 0, 0, 0);
  return date.toISOString();
};
const novemberDay = () => {
  const now = new Date();
  return new Date(now.getFullYear(), 10, now.getMonth() === 10 && now.getDate() === 12 ? 13 : 12, 9).toISOString();
};

let root: string;
let url: string;
let post: (path: string, body: object) => Promise<void>;
let agents: SimAgent[] = [];
const back = new Map<string, string>();
let rows: Record<string, string> = {};

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  root = inboxScratch('plannotator-inbox-row-time-');
  const dataDir = join(root, 'data');
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_INBOX_NOTES: '0',
    PLANNOTATOR_TEST_SANDBOX: '1',
    NO_ANON_PING: '1',
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  url = started.stdout.trim();
  const health = (await (await fetch(new URL('/api/inbox/health', url))).json()) as { serverSession: string };
  post = async (path, body) => {
    const res = await fetch(new URL(path, url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, serverSession: health.serverSession }) });
    expect(res.ok, `${path}: ${res.status} ${await res.text()}`).toBe(true);
  };

  const src = join(root, 'src');
  const long = scratchProject(src, LONG_PROJECT);
  const short = scratchProject(src, 'shop');
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const named = await SimAgent.connect({ binary, env, name: 'An agent whose name is much longer than any phone row', host: 'codex' });
  agents = [claude, named];
  const send = async (agent: SimAgent, project: string, subject: string) => (await agent.send({ project_path: project, subject, thread: subject, body: `${subject}: the details.` })).thread_id as string;

  rows = {
    longTwo: await send(claude, long, 'Rotate the staging signing key before the migration?'),
    longNoon: await send(named, long, 'Refund window for annual plans'),
    shortTwo: await send(claude, short, 'Webhook replay finished'),
    longDate: await send(named, long, 'Remove the old feature flags'),
    pinned: await send(claude, long, 'Vendor invoices are waiting'),
    plain: await send(claude, long, 'The nightly export finished'),
    sent: await send(named, long, 'Poll the token endpoint?'),
  };
  back.set(rows.longTwo!, today(14));
  back.set(rows.longNoon!, today(12));
  back.set(rows.shortTwo!, today(14));
  back.set(rows.longDate!, novemberDay());
  back.set(rows.pinned!, today(14));

  const until = new Date(Date.now() + 3_000).toISOString();
  for (const id of back.keys()) await post(`/api/inbox/threads/${id}/snooze`, { until });
  await post(`/api/inbox/threads/${rows.pinned}/pin`, { pinned: true });
  await post(`/api/inbox/threads/${rows.plain}/read`, {});
  await post(`/api/inbox/messages/${rows.sent}/reply`, { idempotency_key: 'row-time-sent', words: 'Every ten minutes.', questions: [] });
  await new Promise((done) => setTimeout(done, 3_500));
});

test.afterAll(async () => {
  try {
    for (const agent of agents) await agent.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

function withBackTimes(value: unknown): void {
  if (Array.isArray(value)) return value.forEach(withBackTimes);
  if (!value || typeof value !== 'object') return;
  const row = value as Record<string, unknown>;
  const at = typeof row.thread_id === 'string' && row.snooze_back ? back.get(row.thread_id) : undefined;
  if (at) row.last_at = at;
  Object.values(row).forEach(withBackTimes);
}

async function phone(browser: Browser, width: number, scheme: 'light' | 'dark'): Promise<{ context: BrowserContext; page: Page }> {
  const { defaultBrowserType: _ignored, ...iPhone } = devices['iPhone 15'];
  const context = await browser.newContext({ ...iPhone, viewport: { width, height: width === 320 ? 640 : 844 }, colorScheme: scheme, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.route('**/api/inbox/threads**', async (route) => {
    const response = await route.fetch();
    if (!(response.headers()['content-type'] ?? '').includes('json')) return route.fulfill({ response });
    const json: unknown = await response.json();
    withBackTimes(json);
    await route.fulfill({ response, json });
  });
  return { context, page };
}

async function openList(page: Page) {
  await page.goto(url);
  await expect(page.locator(`.ib-lbody .ib-mrow[data-thread-id="${rows.longTwo}"] [data-snooze-back-mark]`)).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

async function lineOf(page: Page, id: string) {
  const row = page.locator(`.ib-lbody .ib-mrow[data-thread-id="${id}"]`);
  await row.scrollIntoViewIfNeeded();
  return row.evaluate((el) => {
    const box = (node: Element | null | undefined) => {
      const r = node?.getBoundingClientRect();
      return r ? { left: r.left, right: r.right, height: r.height } : null;
    };
    const time = el.querySelector('.ib-m1 > .ib-t');
    const project = el.querySelector<HTMLElement>('.ib-m1 > .ib-from .ib-p');
    return {
      words: (time?.textContent ?? '').replace(/\s+/g, ' ').trim(),
      time: box(time)!,
      row: box(el)!,
      lead: box(time?.parentElement?.querySelector('.ib-from')),
      projectCut: project ? project.scrollWidth > project.clientWidth : false,
    };
  });
}

test('at 320 the clock and the time keep one line, and the long project is what gives way', async ({ browser }) => {
  await post('/api/inbox/settings', { rows: [], text_size: 14 });
  const { context, page } = await phone(browser, 320, 'dark');
  try {
    await openList(page);
    const expected: Record<string, RegExp> = { longTwo: /^2:00 PM$/, longNoon: /^12:00 PM$/, shortTwo: /^2:00 PM$/, longDate: /^Nov 1[23]$/ };
    for (const [name, words] of Object.entries(expected)) {
      const line = await lineOf(page, rows[name]!);
      expect(line.words, name).toMatch(words);
      expect(line.time.height, `${name}: "${line.words}" is one line`).toBeLessThan(LINE * 1.5);
      if (name !== 'shortTwo') expect(line.projectCut, `${name}: the project is cut`).toBe(true);
    }
  } finally {
    await context.close();
  }
});

test('every row, every look, 320 and 390, at the largest text size: the time is whole', async ({ browser }) => {
  for (const width of [320, 390]) {
    const { context, page } = await phone(browser, width, 'dark');
    try {
      for (const text_size of [14, 15]) {
        for (const look of [[], ['compact'], ['titleFirst'], ['highlight', 'compact', 'hideAgents']]) {
          await post('/api/inbox/settings', { rows: look, text_size });
          await openList(page);
          const quiet = page.locator('[data-section-id="quiet"] .ib-band');
          if ((await quiet.getAttribute('aria-expanded')) !== 'true') await quiet.click();
          for (const [name, id] of Object.entries(rows)) {
            const where = `${width}px, text ${text_size}, [${look.join(' ')}], ${name}`;
            const line = await lineOf(page, id);
            expect(line.time.height, `${where}: "${line.words}" is one line`).toBeLessThan(LINE * 1.5);
            expect(line.time.right, `${where}: the time stays inside the row's padding`).toBeLessThanOrEqual(line.row.right - ROW_PADDING);
            if (line.lead) expect(line.lead.right, `${where}: the project stops before the time`).toBeLessThanOrEqual(line.time.left);
          }
        }
      }
    } finally {
      await context.close();
    }
  }
});

test('pictures: a phone, dark and light, 390 and 320', async ({ browser }) => {
  test.skip(!shots, 'set PLANNOTATOR_ROW_TIME_SHOTS to a folder');
  mkdirSync(shots!, { recursive: true });
  await post('/api/inbox/settings', { rows: [], text_size: 14 });
  for (const scheme of ['dark', 'light'] as const) {
    for (const width of [390, 320]) {
      const { context, page } = await phone(browser, width, scheme);
      try {
        await openList(page);
        await page.waitForTimeout(300);
        await page.screenshot({ path: join(shots!, `${tag}-${scheme}-${width}.png`) });
      } finally {
        await context.close();
      }
    }
  }
});
