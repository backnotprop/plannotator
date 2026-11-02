/**
 * Compose's To row stays one clean line on a phone (the owner, 2026-10-30:
 * "Creating a new thread needs to be a bit more responsive"). His phone showed
 * "To · Claude Code · main · workspaces/worktr" wrapped onto two lines and cut
 * mid-glyph: on a phone the session detail was a two-line clamp.
 *
 * Proved in Chromium against the compiled binary with worst-case sessions: a
 * long checkout name (a `feature/…` branch), deep worktree paths, two projects
 * whose folders share a name (so the Inbox names them with their parents), two
 * Claude Code sessions in one project, and a plain project with no checkout.
 * At 390 and 320 px, with the longest session in To:
 *  - the To row is as tall as it is for a short name (one line);
 *  - the agent's mark and name are whole (scrollWidth <= clientWidth);
 *  - the detail is `nowrap` with `text-overflow: ellipsis`, one line high,
 *    and inside the row, the chevron after it, also inside;
 *  - To's label sits in the Thread label's column, on the agent name's baseline.
 * The phone picker shows each session's whole detail, never cut; on a desktop
 * (1440 and 810 px) the cut detail opens a tooltip with the whole name and folder.
 *
 * Nothing is mocked: `plannotator inbox --background` under a temp HOME and
 * PLANNOTATOR_DATA_DIR, agents write through `plannotator inbox mcp`
 * (scripts/inbox-sim.ts), and the sessions are the bridge's real long-poll.
 * Build the binary first (see inbox.spec.ts). COMPOSE_TO_SHOTS_DIR: where to
 * write the full-window PNGs (none when unset).
 */

import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { INBOX_BRIDGE_POLL_PATH } from '../../packages/shared/inbox/connection';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shotsDir = process.env.COMPOSE_TO_SHOTS_DIR ? resolve(process.env.COMPOSE_TO_SHOTS_DIR) : null;

const BRANCH = 'northwind-reconciliation-ledger-close-v2';

interface World {
  root: string;
  dataDir: string;
  url: string;
  agent: SimAgent;
  polls: Poll[];
}

let world: World;

/** One live session: the bridge's long-poll, as the mod, Pi and OpenCode run it. */
class Poll {
  private stopped = false;
  private readonly loop: Promise<void>;
  constructor(
    readonly session: string,
    readonly host: string,
    private readonly projectPath: string,
    private readonly startedAt: number,
  ) {
    this.loop = this.run();
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      const { port, token } = JSON.parse(readFileSync(join(world.dataDir, 'inbox', 'inbox.json'), 'utf8')) as { port: number; token: string };
      const response = await fetch(`http://127.0.0.1:${port}${INBOX_BRIDGE_POLL_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ session: this.session, host: this.host, waitMs: 1_000, project_path: this.projectPath, started_at: this.startedAt, busy: false, idle_since: this.startedAt }),
      }).catch(() => null);
      await response?.text().catch(() => '');
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.loop;
  }
}

async function shot(page: Page, name: string): Promise<void> {
  if (!shotsDir) return;
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(shotsDir, `${name}.png`) });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  if (shotsDir) mkdirSync(shotsDir, { recursive: true });
  const root = inboxScratch('plannotator-compose-to-row-e2e-');
  const dataDir = join(root, 'data');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  world = { root, dataDir, url: started.stdout.trim(), agent, polls: [] };

  // Two checkouts named `main` and two of one long `feature/…` branch: the Inbox names each with the parents
  // that tell it apart ("main · workspaces/worktrees", "northwind-… · northwind/worktrees/feature").
  const main = scratchProject(join(root, 'workspaces/worktrees'), 'main');
  const otherMain = scratchProject(join(root, 'src/plannotator/worktrees'), 'main');
  const long = scratchProject(join(root, 'workspaces/projects/northwind/worktrees/feature'), BRANCH);
  const otherLong = scratchProject(join(root, 'workspaces/projects/ledger-service/worktrees/feature'), BRANCH);
  // No checkout at all: a plain folder.
  const plain = scratchProject(join(root, 'src'), 'billing');
  for (const project of [main, otherMain, long, otherLong, plain]) {
    await agent.send({ project_path: project, subject: 'Run finished', body: 'The export streams rows now.' });
  }
  const now = Date.now();
  world.polls.push(
    new Poll('ses-long-1', 'claude-code', long, now - 50 * 60_000),
    new Poll('ses-long-2', 'claude-code', long, now - 20 * 60_000),
    new Poll('ses-main', 'claude-code', main, now - 40 * 60_000),
    new Poll('ses-other-long', 'opencode', otherLong, now - 30 * 60_000),
    new Poll('ses-other-main', 'pi', otherMain, now - 35 * 60_000),
    new Poll('ses-plain', 'codex', plain, now - 10 * 60_000),
  );
});

test.afterAll(async () => {
  try {
    if (!world) return;
    await Promise.all(world.polls.map((poll) => poll.stop()));
    await world.agent.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

/** Opens New message and puts `session` in To through the picker. */
async function composeTo(page: Page, phone: boolean, session: string, onPicker?: () => Promise<void>): Promise<Locator> {
  await page.locator(phone ? '.ib-lhead [data-open-compose]' : '.ib-side [data-open-compose]').first().click();
  const dialog = page.locator('dialog[data-compose]');
  const to = dialog.locator('.ib-cp-tobtn');
  await expect(to).not.toHaveAttribute('data-loading', /.*/, { timeout: 20_000 });
  await to.click();
  await expect(dialog.locator('[role="listbox"] > [role="option"]')).toHaveCount(6, { timeout: 20_000 });
  if (onPicker) await onPicker();
  await dialog.locator(`[data-compose-session="${session}"]`).click();
  await expect(to).toHaveAttribute('data-compose-to', session);
  // The message field has focus now; a phone's keyboard does not count here.
  await dialog.getByRole('textbox', { name: 'Message' }).blur();
  return dialog;
}

interface RowMeasure {
  rowHeight: number;
  detailHeight: number;
  detailLine: number;
  row: { left: number; right: number; top: number; bottom: number };
  detail: { left: number; right: number; top: number; bottom: number };
  chevron: { left: number; right: number };
  mark: { width: number };
  agentCut: boolean;
  markCut: boolean;
  detailCut: boolean;
  textOverflow: string;
  whiteSpace: string;
  labelLeft: { to: number; thread: number };
  labelBaseline: { to: number; agent: number };
}

/** The To row's geometry: every number the checks below need, in one read. */
function measure(dialog: Locator): Promise<RowMeasure> {
  return dialog.evaluate((el) => {
    const rect = (node: Element) => {
      const r = node.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const row = el.querySelector('.ib-cp-to')!;
    const button = row.querySelector('.ib-cp-tobtn')!;
    const agent = button.querySelector('b')! as HTMLElement;
    const mark = button.querySelector('.ib-mk, [data-host-mark], svg')! as HTMLElement;
    const detail = button.querySelector('.ib-cp-tod')! as HTMLElement;
    const chevron = button.querySelector(':scope > svg.ib-ic:last-child')!;
    const style = getComputedStyle(detail);
    const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5;
    const toLabel = row.querySelector('.ib-cp-tol')!;
    const threadLabel = el.querySelector('.ib-cp-thread .ib-cp-tol')!;
    // The text's baseline: the bottom of an inline-block placed on it.
    const baseline = (node: Element) => {
      const probe = document.createElement('span');
      probe.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
      node.appendChild(probe);
      const y = probe.getBoundingClientRect().bottom;
      probe.remove();
      return y;
    };
    // The detail's own ellipsis boxes: each cut part (leaf, parents) is nowrap and ellipsis.
    const parts = [detail, ...detail.querySelectorAll<HTMLElement>('[data-cut]')];
    const cut = parts.some((part) => part.scrollWidth > part.clientWidth + 0.5);
    return {
      rowHeight: rect(row).height,
      detailHeight: rect(detail).height,
      detailLine: lineHeight,
      row: rect(row),
      detail: rect(detail),
      chevron: rect(chevron),
      mark: rect(mark),
      agentCut: agent.scrollWidth > agent.clientWidth,
      markCut: rect(mark).width < 12,
      detailCut: cut,
      textOverflow: parts.map((part) => getComputedStyle(part).textOverflow).join(','),
      whiteSpace: parts.map((part) => getComputedStyle(part).whiteSpace).join(','),
      labelLeft: { to: rect(toLabel).left, thread: rect(threadLabel).left },
      labelBaseline: { to: baseline(toLabel), agent: baseline(agent) },
    };
  });
}

function expectOneCleanLine(m: RowMeasure, singleLineRow: number): void {
  // One line: the row is as tall as with a short name, and the detail is one line high.
  expect(m.rowHeight).toBeCloseTo(singleLineRow, 0);
  expect(m.detailHeight).toBeLessThan(m.detailLine * 1.5);
  // The agent's mark and name are whole.
  expect(m.agentCut).toBe(false);
  expect(m.markCut).toBe(false);
  // The detail is cut with an ellipsis, never wrapped, and stays in the row; the chevron follows it, inside too.
  expect(m.detailCut).toBe(true);
  for (const value of m.textOverflow.split(',')) expect(value).toBe('ellipsis');
  for (const value of m.whiteSpace.split(',')) expect(value).toBe('nowrap');
  expect(m.detail.left).toBeGreaterThanOrEqual(m.row.left);
  expect(m.detail.right).toBeLessThanOrEqual(m.chevron.left + 0.5);
  expect(m.chevron.right).toBeLessThanOrEqual(m.row.right);
  expect(m.detail.top).toBeGreaterThanOrEqual(m.row.top);
  expect(m.detail.bottom).toBeLessThanOrEqual(m.row.bottom);
  // To's label sits in the same column as Thread's, on the agent name's baseline.
  expect(m.labelLeft.to).toBeCloseTo(m.labelLeft.thread, 0);
  expect(Math.abs(m.labelBaseline.to - m.labelBaseline.agent)).toBeLessThanOrEqual(1);
}

for (const width of [390, 320]) {
  test(`a phone ${width} px wide: the To row is one clean line with the longest session in To`, async ({ browser }: { browser: Browser }) => {
    const context = await browser.newContext({ viewport: { width, height: width === 320 ? 640 : 844 }, isMobile: true, hasTouch: true, colorScheme: 'dark' });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await page.goto(world.url);
      // The single-line height: To naming a short project with no parents.
      let dialog = await composeTo(page, true, 'ses-plain');
      const short = await measure(dialog);
      expect(short.detailCut).toBe(false);
      await dialog.locator('[data-compose-cancel]').click();
      await expect(dialog).toHaveCount(0);

      dialog = await composeTo(page, true, 'ses-long-1', async () => {
        // The picker on a phone: every session's whole detail, never cut.
        const options = dialog.locator('[role="listbox"] > [role="option"]');
        for (const option of await options.all()) {
          const cut = await option.evaluate((el) => [...el.querySelectorAll<HTMLElement>('.ib-cp-op, .ib-cp-oa')].some((part) => part.scrollWidth > part.clientWidth + 0.5));
          expect(cut, await option.getAttribute('aria-label')).toBe(false);
          const box = (await option.boundingBox())!;
          expect(box.x + box.width).toBeLessThanOrEqual(width);
        }
        if (width === 390) await shot(page, 'phone-390-dark-picker');
      });
      if (width === 390) {
        await shot(page, 'phone-390-dark');
        await page.emulateMedia({ colorScheme: 'light' });
        await shot(page, 'phone-390-light');
        await page.emulateMedia({ colorScheme: 'dark' });
      } else {
        await shot(page, 'phone-320-dark');
      }
      expectOneCleanLine(await measure(dialog), short.rowHeight);
      // The other worst cases: the `main` checkout named with its parents, and two sessions of one project.
      for (const session of ['ses-main', 'ses-long-2', 'ses-other-long']) {
        await dialog.locator('.ib-cp-tobtn').click();
        await dialog.locator(`[data-compose-session="${session}"]`).click();
        await dialog.getByRole('textbox', { name: 'Message' }).blur();
        const m = await measure(dialog);
        expect(m.rowHeight).toBeCloseTo(short.rowHeight, 0);
        expect(m.detailHeight).toBeLessThan(m.detailLine * 1.5);
        expect(m.agentCut).toBe(false);
        expect(m.chevron.right).toBeLessThanOrEqual(m.row.right);
      }
      // The Thread row keeps its own height under it.
      const thread = (await dialog.locator('.ib-cp-thread').boundingBox())!;
      expect(thread.width).toBeLessThanOrEqual(width);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });
}

test('a desktop window: the To row is one line at 1440 and 810 px, and the whole detail is a tooltip while it is cut', async ({ browser }: { browser: Browser }) => {
  for (const width of [1440, 810]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: 'light' });
    const page = await context.newPage();
    try {
      await page.goto(world.url);
      await page.locator('.ib-side [data-open-compose]').first().click();
      let dialog = page.locator('dialog[data-compose]');
      await expect(dialog.locator('.ib-cp-tobtn')).not.toHaveAttribute('data-loading', /.*/, { timeout: 20_000 });
      await page.keyboard.press('Escape');
      dialog = await composeTo(page, false, 'ses-plain');
      const short = await measure(dialog);
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      dialog = await composeTo(page, false, 'ses-other-long');
      const m = await measure(dialog);
      expect(m.rowHeight).toBeCloseTo(short.rowHeight, 0);
      expect(m.detailHeight).toBeLessThan(m.detailLine * 1.5);
      expect(m.agentCut).toBe(false);
      expect(m.chevron.right).toBeLessThanOrEqual(m.row.right);
      expect(Math.abs(m.labelBaseline.to - m.labelBaseline.agent)).toBeLessThanOrEqual(1);
      // The 680 px dialog cuts this one too: the whole name and its folder are a tooltip.
      expect(m.detailCut).toBe(true);
      await dialog.locator('.ib-cp-tod').hover();
      await expect(page.locator('[data-pn-tooltip]')).toContainText(`${BRANCH} · ledger-service/worktrees/feature`);
      await expect(page.locator('[data-pn-tooltip]')).toContainText(`/ledger-service/worktrees/feature/${BRANCH}`);
      await page.mouse.move(0, 0);
      await expect(page.locator('[data-pn-tooltip]')).toHaveCount(0);
      if (width === 1440) await shot(page, 'desktop-1440-light');
    } finally {
      await context.close();
    }
  }
});
