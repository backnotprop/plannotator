import { expect, test, type Browser, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));

let url = '';
let agents: SimAgent[] = [];
let post: (path: string, body: object) => Promise<void> = async () => {};
let opener = '';
const projects = { pinned: '', unpinned: '' };

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-inbox-fit-counts-e2e-');
  const dataDir = join(root, 'data');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_UPDATE_CHECK: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  url = started.stdout.trim();
  rememberInboxOf(dataDir);
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const codex = await SimAgent.connect({ binary, env, name: 'Codex', host: 'codex' });
  agents = [claude, codex];
  const src = join(root, 'src');
  const ask = (q: string) => [':::question', q, '', '- [ ] Yes', '- [ ] No', ':::'].join('\n');
  const questions = (n: number) => Array.from({ length: n }, (_, i) => ask(`Question ${i}?`)).join('\n\n');
  const actions = (n: number) => Array.from({ length: n }, (_, i) => [':::action', `Approve thing ${i}`, ':::'].join('\n')).join('\n\n');
  const say = async (agent: SimAgent, project: string, subject: string, body: string) =>
    (await agent.send({ project_path: scratchProject(src, project), thread: subject, subject, body })).thread_id as string;
  opener = await say(codex, 'billing-svc', 'Token refresh fails after the laptop sleeps', 'Retry on wake is in.');
  await say(claude, 'docs-site', 'The install page is up', `${actions(100)}\n\n${questions(100)}`);
  const pinned = await say(codex, 'workspaces', 'Nightly build passed', 'All green.');
  await say(claude, 'workspaces', 'Ship on Monday', ask('Ship on Monday?'));
  await say(codex, 'workspaces', 'Twelve questions', questions(12));
  await say(claude, 'workspaces', 'One of each', `${actions(1)}\n\n${ask('Go?')}`);
  await say(codex, 'workspaces', 'Release checklist', `${actions(12)}\n\n${questions(12)}`);
  await say(claude, 'workspaces', 'Three action items', actions(3));
  await say(codex, 'workspaces', 'A hundred questions', questions(100));
  await say(claude, 'workspaces', 'Backlog triage', `${actions(100)}\n\n${questions(100)}`);
  await say(codex, 'workspaces', 'Audit follow-ups', `${actions(100)}\n\n${ask('Close the audit?')}`);
  const health = (await (await fetch(new URL('/api/inbox/health', url))).json()) as { serverSession: string };
  post = async (path: string, body: object) => {
    const res = await fetch(new URL(path, url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, serverSession: health.serverSession }) });
    expect(res.ok, `${path}: ${res.status} ${await res.text()}`).toBe(true);
  };
  await post(`/api/inbox/threads/${pinned}/pin`, { pinned: true });
  await post('/api/inbox/settings', { theme: { mode: 'system', light: 'github', dark: 'plannotator' } });
  const model = (await (await fetch(new URL('/api/inbox/projects', url))).json()) as { projects: { id: string; name: string }[] };
  projects.pinned = model.projects.find((p) => p.name === 'workspaces')!.id;
  projects.unpinned = model.projects.find((p) => p.name === 'docs-site')!.id;
});

test.afterAll(async () => {
  try {
    for (const agent of agents) await agent.close().catch(() => {});
    agents = [];
  } finally {
    await removeInboxScratch();
  }
});

interface Fit {
  app: string;
  perRow: string;
  pinColumn: boolean;
  cells: number;
}

async function fit(page: Page): Promise<Fit> {
  await page.evaluate(() => document.fonts.ready.then(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)))));
  return page.evaluate(() => {
    const list = document.querySelector<HTMLElement>('section.ib-listcol')!;
    const pinColumn = list.classList.contains('ib-pincol');
    let widest = 0;
    let cells = 0;
    for (const cell of list.querySelectorAll<HTMLElement>('.ib-row > .ib-cq')) {
      if (cell.firstElementChild) cells++;
      if (!pinColumn) continue;
      const lefts = [...cell.children].map((part) => part.getBoundingClientRect()).filter((box) => box.width > 1).map((box) => box.left);
      if (lefts.length) widest = Math.max(widest, cell.getBoundingClientRect().right - Math.min(...lefts));
    }
    (window as unknown as { __cqReads?: Set<Element> }).__cqReads?.clear();
    return { app: list.style.getPropertyValue('--ib-cq-w'), perRow: widest > 84 ? `${Math.ceil(widest)}px` : '', pinColumn, cells };
  });
}

type Shape = 'full words' | 'short words' | 'one project' | 'three-line' | 'beside a thread' | 'no pin' | 'phone';
const SHAPES: { shape: Shape; width: number; hash: () => string; row: string; pinColumn: boolean }[] = [
  { shape: 'full words', width: 1440, hash: () => '', row: 'ib-row', pinColumn: true },
  { shape: 'short words', width: 1280, hash: () => '', row: 'ib-row', pinColumn: true },
  { shape: 'one project', width: 1024, hash: () => `#project=${projects.pinned}`, row: 'ib-row', pinColumn: true },
  { shape: 'three-line', width: 1024, hash: () => '', row: 'ib-nrow', pinColumn: false },
  { shape: 'beside a thread', width: 1440, hash: () => `#thread=${opener}`, row: 'ib-nrow', pinColumn: false },
  { shape: 'no pin', width: 1440, hash: () => `#project=${projects.unpinned}`, row: 'ib-row', pinColumn: false },
  { shape: 'phone', width: 390, hash: () => '', row: 'ib-mrow', pinColumn: false },
];

async function page(browser: Browser, width: number, scheme: 'light' | 'dark') {
  const phone = width < 600;
  const context = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, deviceScaleFactor: 2, isMobile: phone, hasTouch: phone, colorScheme: scheme, reducedMotion: 'reduce' });
  await context.addInitScript(() => {
    const reads = new Set<Element>();
    (window as unknown as { __cqReads: Set<Element> }).__cqReads = reads;
    const read = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const cell = this.closest('.ib-row > .ib-cq');
      if (cell) reads.add(cell);
      return read.call(this);
    };
  });
  return { context, page: await context.newPage() };
}

for (const size of [12, 13, 14, 15]) {
  test(`text ${size} px, light and dark: the counts column is the per-row measure's in every shape`, async ({ browser }) => {
    await post('/api/inbox/settings', { text_size: size });
    for (const scheme of ['light', 'dark'] as const) {
      for (const { shape, width, hash, row, pinColumn } of SHAPES) {
        const label = `${scheme}, text ${size}, ${shape} at ${width} px`;
        const { context, page: p } = await page(browser, width, scheme);
        try {
          await p.goto(`${url}${hash()}`);
          await expect(p.locator(`.ib-lbody .${row}`).first(), label).toBeVisible();
          await expect.poll(() => p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--inbox-text-size').trim()), label).toBe(size === 14 ? '' : String(size));
          const at = await fit(p);
          expect(at.pinColumn, `${label}: the pin's column`).toBe(pinColumn);
          expect(at.app, `${label}: the per-row measure's width`).toBe(at.perRow);
          if (pinColumn) expect(at.app, `${label}: widened`).not.toBe('');
          if (pinColumn) expect(at.cells, `${label}: counts drawn`).toBeGreaterThan(5);
          await p.emulateMedia({ colorScheme: scheme === 'light' ? 'dark' : 'light' });
          const switched = await fit(p);
          expect(switched.app, `${label}, then the other scheme`).toBe(switched.perRow);
        } finally {
          await context.close();
        }
      }
    }
  });
}

test('a scheme change between halves with different fonts fits the column to the new font, and keeps it', async ({ browser }) => {
  await post('/api/inbox/settings', { text_size: 14 });
  const { context, page: p } = await page(browser, 1440, 'dark');
  try {
    await p.goto(url);
    await expect(p.locator('.ib-lbody .ib-row').first()).toBeVisible();
    const font = () => p.evaluate(() => getComputedStyle(document.querySelector('.pn-inbox')!).fontFamily);
    await expect.poll(() => p.evaluate(() => document.documentElement.classList.contains('theme-plannotator'))).toBe(true);
    const dark = await fit(p);
    const darkFont = await font();
    expect(dark.app, 'dark (Inter)').toBe(dark.perRow);
    await p.emulateMedia({ colorScheme: 'light' });
    await expect.poll(() => p.evaluate(() => document.documentElement.classList.contains('theme-github'))).toBe(true);
    expect(await font(), 'the light half draws another font').not.toBe(darkFont);
    const light = await fit(p);
    expect(light.app, 'light (system-ui)').toBe(light.perRow);
    await p.locator('.ib-lbody .ib-row').first().click({ button: 'right' });
    await p.keyboard.press('Escape');
    const after = await fit(p);
    expect(after.app, 'after an unrelated render').toBe(after.perRow);
    await p.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(() => p.evaluate(() => document.documentElement.classList.contains('theme-plannotator'))).toBe(true);
    const back = await fit(p);
    expect(back.app, 'dark again').toBe(back.perRow);
  } finally {
    await context.close();
  }
});

test('opening a thread reads no counts cell; the way back reads one cell for each different counts', async ({ browser }) => {
  await post('/api/inbox/settings', { text_size: 14 });
  const { context, page: p } = await page(browser, 1440, 'light');
  try {
    await p.goto(url);
    await expect(p.locator('.ib-lbody .ib-row').first()).toBeVisible();
    const before = await fit(p);
    expect(before.app).toBe(before.perRow);
    expect(before.app).not.toBe('');
    const reads = () => p.evaluate(() => (window as unknown as { __cqReads: Set<Element> }).__cqReads.size);
    const settle = () => p.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok))));
    await p.evaluate(() => (window as unknown as { __cqReads: Set<Element> }).__cqReads.clear());
    await p.evaluate((id) => (location.hash = `#thread=${id}`), opener);
    await expect(p.locator(`section.ib-pane[data-thread-id="${opener}"]`)).toBeVisible();
    await expect(p.locator('.ib-lbody .ib-nrow').first()).toBeVisible();
    await settle();
    expect(await reads(), 'opening a thread').toBe(0);
    await p.evaluate(() => (location.hash = ''));
    await expect(p.locator('.ib-lbody .ib-row').first()).toBeVisible();
    await settle();
    const back = await p.evaluate(() => {
      const cells = [...document.querySelectorAll<HTMLElement>('.ib-lbody .ib-row > .ib-cq')].filter((c) => c.firstElementChild);
      const different = new Set(cells.map((c) => c.textContent)).size;
      return { read: (window as unknown as { __cqReads: Set<Element> }).__cqReads.size, cells: cells.length, different };
    });
    expect(back.cells).toBeGreaterThan(back.different);
    expect(back.read, 'back to the list').toBeGreaterThan(0);
    expect(back.read, 'back to the list').toBeLessThanOrEqual(back.different);
    const after = await fit(p);
    expect(after.app).toBe(before.app);
  } finally {
    await context.close();
  }
});
