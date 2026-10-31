/**
 * Line 1 of the three-line and phone list rows (approval "inbox-list-row-v2",
 * 2026-10-30), proved in a real Chromium against the compiled binary under a
 * temp HOME and PLANNOTATOR_DATA_DIR; agents write through `plannotator inbox
 * mcp` (scripts/inbox-sim.ts). Nothing is mocked.
 *
 * At 1440 beside an open thread, and at a 390 px phone:
 *  - the agents' tiles come right before the project, centred on its line;
 *  - a very long project with five agents stays one line: the project ends in
 *    "…" and line 1 is no taller than a short project's;
 *  - at most two tiles, then a "+3" tile; the run's name, and beside a thread
 *    its tooltip, list all five agents; beside a thread the cut project's
 *    tooltip shows it whole.
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-row-lead.spec.ts`.
 * PNGs land in PLANNOTATOR_E2E_PROOF_DIR/row-lead, or .local/proof/row-lead/.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'row-lead');

const LONG_PROJECT = 'acme-global-payments-ledger-reconciliation-and-settlement-platform-monorepo';
const EVERY_AGENT = 'Claude Code, Codex, OpenCode, Pi and Cursor';

let url = '';
let agents: SimAgent[] = [];
/** The long project's thread, with five agents. */
let crowd = '';
/** A short project's thread, one agent. */
let lone = '';
/** The thread opened beside the list (opening marks it read, out of the list's top). */
let opened = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-row-lead-e2e-');
  const dataDir = join(root, 'data');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_UPDATE_CHECK: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  url = started.stdout.trim();
  rememberInboxOf(dataDir);
  const huge = scratchProject(join(root, 'src'), LONG_PROJECT);
  const small = scratchProject(join(root, 'src'), 'api');
  for (const [name, host] of [['Claude Code', 'claude-code'], ['Codex', 'codex'], ['OpenCode', 'opencode'], ['Pi', 'pi'], ['Cursor', 'cursor']]) agents.push(await SimAgent.connect({ binary, env, name, host }));
  const [claude, ...others] = agents;
  opened = (await claude!.send({ project_path: small, thread: 'Changelog', subject: 'The changelog is up', body: 'The changelog is up.' })).thread_id;
  lone = (await claude!.send({ project_path: small, thread: 'Rate limits', subject: 'Raise the rate limit for the batch import', body: 'Raise the rate limit for the batch import.' })).thread_id;
  const first = await claude!.send({ project_path: huge, thread: 'Settlement cutover', subject: 'Cut the settlement batch over to the new ledger before Friday', body: [':::question', 'Cut over on Thursday night?', '', '- [ ] Yes', '- [ ] No', ':::'].join('\n') });
  crowd = first.thread_id;
  for (const agent of others) await agent.send({ project_path: huge, reply_to: crowd, body: 'Joined: the numbers agree on my side.' });
});

test.afterAll(async () => {
  try {
    for (const agent of agents) await agent.close().catch(() => {});
    agents = [];
  } finally {
    await removeInboxScratch();
  }
});

/** Line 1 of a row, read in the page. */
function lineOne(row: Element) {
  const line = (row.querySelector(':scope > .ib-l1') ?? row.querySelector(':scope > .ib-m1'))!;
  const tiles = line.querySelector<HTMLElement>('.ib-from > .ib-atiles')!;
  const project = line.querySelector<HTMLElement>('.ib-from > .ib-p')!;
  const t = tiles.getBoundingClientRect();
  const p = project.getBoundingClientRect();
  const lineHeight = parseFloat(getComputedStyle(project).lineHeight);
  return {
    from: [...line.querySelector(':scope > .ib-from')!.children].map((c) => c.className.split(' ')[0]),
    lineHeight: line.getBoundingClientRect().height,
    projectLines: Math.round(p.height / lineHeight),
    projectCut: project.scrollWidth > project.clientWidth + 0.5,
    projectText: project.textContent,
    ellipsis: getComputedStyle(project).textOverflow,
    // Before the name, hugging it, centred on its line.
    gap: p.left - t.right,
    centred: Math.abs((t.top + t.bottom) / 2 - (p.top + p.bottom) / 2),
    tiles: tiles.querySelectorAll(':scope > .ib-atile:not(.ib-atmore)').length,
    more: tiles.querySelector(':scope > .ib-atmore')?.textContent ?? null,
    name: tiles.getAttribute('aria-label'),
    inside: t.left >= row.getBoundingClientRect().left && p.right <= line.getBoundingClientRect().right,
  };
}

async function measure(page: Page, rowClass: string, id: string): Promise<ReturnType<typeof lineOne>> {
  return (await page.evaluate(`(${lineOne.toString()})(document.querySelector('.${rowClass}[data-thread-id="${id}"]'))`)) as ReturnType<typeof lineOne>;
}

function expectLead(crowded: ReturnType<typeof lineOne>, short: ReturnType<typeof lineOne>, at: string) {
  for (const l of [crowded, short]) {
    expect(l.from, at).toEqual(['ib-p', 'ib-atiles']);
    expect(l.gap, `${at}: the tiles hug the project`).toBeGreaterThanOrEqual(5.5);
    expect(l.gap, `${at}: the tiles hug the project`).toBeLessThanOrEqual(6.5);
    expect(l.centred, `${at}: the tiles sit on the project's line`).toBeLessThanOrEqual(1);
    expect(l.projectLines, `${at}: the project wrapped`).toBe(1);
    expect(l.inside, `${at}: line 1 spills`).toBe(true);
  }
  // Five agents on a very long project: one line, the project cut with "…", no taller than a short project's line.
  expect(crowded.projectText).toBe(LONG_PROJECT);
  expect(crowded.projectCut, `${at}: the long project is cut`).toBe(true);
  expect(crowded.ellipsis).toBe('ellipsis');
  expect(Math.abs(crowded.lineHeight - short.lineHeight), `${at}: line 1 grows`).toBeLessThanOrEqual(0.5);
  expect(crowded.lineHeight, `${at}: line 1 is one line`).toBeLessThanOrEqual(20);
  expect([crowded.tiles, crowded.more, crowded.name]).toEqual([2, '+3', EVERY_AGENT]);
  expect([short.tiles, short.more, short.name]).toEqual([1, null, 'Claude Code']);
}

const tooltip = (page: Page) => page.locator('[data-pn-tooltip]:not([data-closed])');

test('1440 beside an open thread: the tiles before the project, one line for a long project with five agents, every agent in the name and the tooltip', async ({ browser }: { browser: Browser }) => {
  const context: BrowserContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light', reducedMotion: 'reduce' });
  try {
    const page = await context.newPage();
    await page.goto(`${url}#thread=${opened}`);
    await expect(page.locator(`.ib-nrow[data-thread-id="${crowd}"]`)).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    expectLead(await measure(page, 'ib-nrow', crowd), await measure(page, 'ib-nrow', lone), '1440');
    const row = page.locator(`.ib-nrow[data-thread-id="${crowd}"]`);
    await row.locator('.ib-atiles').hover();
    await expect(tooltip(page)).toHaveText(EVERY_AGENT);
    await page.mouse.move(5, 5);
    await expect(tooltip(page)).toHaveCount(0);
    await row.locator('.ib-l1 .ib-p').hover();
    await expect(tooltip(page)).toHaveText(LONG_PROJECT);
    await page.mouse.move(5, 5);
    await expect(tooltip(page)).toHaveCount(0);
    await page.screenshot({ path: join(proofDir, 'beside-thread-1440.png') });
  } finally {
    await context.close();
  }
});

test('a 390 px phone: the tiles before the project, one line for a long project with five agents, every agent in the name', async ({ browser }: { browser: Browser }) => {
  const context: BrowserContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'light', reducedMotion: 'reduce' });
  try {
    const page = await context.newPage();
    await page.goto(url);
    await expect(page.locator(`.ib-mrow[data-thread-id="${crowd}"]`)).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    expectLead(await measure(page, 'ib-mrow', crowd), await measure(page, 'ib-mrow', lone), 'phone');
    await page.screenshot({ path: join(proofDir, 'phone-390.png') });
  } finally {
    await context.close();
  }
});
