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

  const main = scratchProject(join(root, 'workspaces/worktrees'), 'main');
  const otherMain = scratchProject(join(root, 'src/plannotator/worktrees'), 'main');
  const long = scratchProject(join(root, 'workspaces/projects/northwind/worktrees/feature'), BRANCH);
  const otherLong = scratchProject(join(root, 'workspaces/projects/ledger-service/worktrees/feature'), BRANCH);
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

async function composeTo(page: Page, phone: boolean, session: string, onPicker?: () => Promise<void>): Promise<Locator> {
  await page.locator(phone ? '.ib-lhead [data-open-compose]' : '.ib-side [data-open-compose]').first().click();
  const dialog = page.locator('dialog[data-compose]');
  const to = dialog.locator(phone ? '.ib-cp-foot [data-compose-to]' : '.ib-cp-tobtn');
  await expect(to).not.toHaveAttribute('data-loading', /.*/, { timeout: 20_000 });
  await to.click();
  await expect(dialog.locator('[role="listbox"] > [role="option"]')).toHaveCount(6, { timeout: 20_000 });
  if (onPicker) await onPicker();
  await dialog.locator(`[data-compose-session="${session}"]`).click();
  await expect(to).toHaveAttribute('data-compose-to', session);
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
    const baseline = (node: Element) => {
      const probe = document.createElement('span');
      probe.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
      node.appendChild(probe);
      const y = probe.getBoundingClientRect().bottom;
      probe.remove();
      return y;
    };
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

interface PillMeasure {
  footHeight: number;
  foot: { left: number; right: number; top: number; bottom: number };
  pill: { left: number; right: number; top: number; bottom: number; height: number };
  chevron: { left: number; right: number };
  name: { right: number };
  send: { left: number };
  nameCut: boolean;
  markCut: boolean;
  textOverflow: string;
  whiteSpace: string;
  words: string;
  label: string;
}

function measurePill(dialog: Locator): Promise<PillMeasure> {
  return dialog.evaluate((el) => {
    const rect = (node: Element) => {
      const r = node.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const foot = el.querySelector('.ib-cp-foot')!;
    const pill = foot.querySelector('[data-compose-to]')!;
    const name = pill.querySelector('.ib-apill-n')! as HTMLElement;
    const mark = pill.querySelector('.ib-apill-m')!;
    const chevron = pill.querySelector(':scope > svg.ib-apill-c')!;
    const style = getComputedStyle(name);
    return {
      footHeight: rect(foot).height,
      foot: rect(foot),
      pill: rect(pill),
      chevron: rect(chevron),
      name: rect(name),
      send: rect(foot.querySelector('[data-compose-send]')!),
      nameCut: name.scrollWidth > name.clientWidth,
      markCut: rect(mark).width < 12,
      textOverflow: style.textOverflow,
      whiteSpace: style.whiteSpace,
      words: name.textContent ?? '',
      label: pill.getAttribute('aria-label') ?? '',
    };
  });
}

function expectOneCleanPill(m: PillMeasure, singleLineFoot: number, nameWhole = true): void {
  expect(m.footHeight).toBeCloseTo(singleLineFoot, 0);
  expect(m.pill.height).toBeCloseTo(36, 0);
  if (nameWhole) expect(m.nameCut).toBe(false);
  expect(m.markCut).toBe(false);
  expect(m.textOverflow).toBe('ellipsis');
  expect(m.whiteSpace).toBe('nowrap');
  expect(m.name.right).toBeLessThanOrEqual(m.chevron.left + 0.5);
  expect(m.chevron.right).toBeLessThanOrEqual(m.pill.right + 0.5);
  expect(m.pill.left).toBeGreaterThanOrEqual(m.foot.left);
  expect(m.pill.right).toBeLessThanOrEqual(m.send.left + 0.5);
  expect(m.pill.top).toBeGreaterThanOrEqual(m.foot.top);
  expect(m.pill.bottom).toBeLessThanOrEqual(m.foot.bottom);
}

for (const width of [390, 320]) {
  test(`a phone ${width} px wide: To is one clean pill in the foot's row with the longest session in To`, async ({ browser }: { browser: Browser }) => {
    const context = await browser.newContext({ viewport: { width, height: width === 320 ? 640 : 844 }, isMobile: true, hasTouch: true, colorScheme: 'dark' });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await page.goto(world.url);
      let dialog = await composeTo(page, true, 'ses-plain');
      await expect(dialog.locator('.ib-cp-to, .ib-cp-tod')).toHaveCount(0);
      const short = await measurePill(dialog);
      expect(short.nameCut).toBe(false);
      await dialog.locator('[data-compose-cancel]').click();
      await expect(dialog).toHaveCount(0);

      dialog = await composeTo(page, true, 'ses-long-1', async () => {
        const sheet = dialog.locator('[data-compose-to-sheet]');
        const sheetBox = (await sheet.boundingBox())!;
        const options = sheet.locator('[role="listbox"] > [role="option"]');
        const shown: string[] = [];
        const details = new Map<string, string>();
        for (const option of await options.all()) {
          const name = (await option.getAttribute('aria-label'))!;
          const project = (await option.getAttribute('data-compose-project'))!;
          const parts = await option.evaluate((el) => {
            const row = el.getBoundingClientRect();
            const title = el.querySelector<HTMLElement>('.ib-sheet-t')!;
            const detail = el.querySelector<HTMLElement>('.ib-sheet-d')!;
            const box = detail.getBoundingClientRect();
            return {
              cut: title.scrollWidth > title.clientWidth + 0.5 || detail.scrollWidth > detail.clientWidth + 0.5,
              detailOverflow: getComputedStyle(detail).textOverflow,
              inRow: box.left >= row.left && box.right <= row.right + 0.5 && box.top >= row.top && box.bottom <= row.bottom + 0.5,
              words: `${title.textContent} | ${detail.textContent}`,
              detail: detail.textContent ?? '',
            };
          });
          expect(parts.cut, name).toBe(false);
          expect(parts.detailOverflow, name).not.toBe('ellipsis');
          expect(parts.inRow, name).toBe(true);
          expect(parts.detail, name).toContain(project);
          shown.push(parts.words.replace(/ · [^·]*$/, ''));
          details.set((await option.getAttribute('data-compose-session'))!, parts.detail.replace(/ · [^·]*$/, ''));
          const box = (await option.boundingBox())!;
          expect(box.x).toBeGreaterThanOrEqual(sheetBox.x);
          expect(box.x + box.width).toBeLessThanOrEqual(sheetBox.x + sheetBox.width + 0.5);
          expect(box.x).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width).toBeLessThanOrEqual(width);
        }
        expect(new Set(shown).size).toBe(5);
        expect(details.get('ses-long-1')).toBe(details.get('ses-long-2'));
        expect(details.get('ses-long-1')).not.toBe(details.get('ses-other-long'));
        expect(details.get('ses-main')).not.toBe(details.get('ses-other-main'));
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
      const long = await measurePill(dialog);
      expectOneCleanPill(long, short.footHeight, width >= 360);
      expect(long.words).toBe('Claude Code');
      expect(long.label).toContain(BRANCH);
      for (const session of ['ses-main', 'ses-long-2', 'ses-other-long']) {
        const to = dialog.locator('.ib-cp-foot [data-compose-to]');
        await to.click();
        await dialog.locator(`[data-compose-to-sheet] [data-compose-session="${session}"]`).click();
        await expect(to).toHaveAttribute('data-compose-to', session);
        await dialog.getByRole('textbox', { name: 'Message' }).blur();
        expectOneCleanPill(await measurePill(dialog), short.footHeight, width >= 360);
      }
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
