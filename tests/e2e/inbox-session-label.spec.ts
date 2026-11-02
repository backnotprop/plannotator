/**
 * Session labels in the To picker (approval `.product/approved/inbox-session-label/`,
 * issue #2450), on the compiled binary. Ten live sessions of one project, the
 * approved pictures' fixture: most labelled, a 60-character Latin label, a CJK
 * label on Pi, two with none. Nothing is mocked: `plannotator inbox --background`
 * under a temp HOME and PLANNOTATOR_DATA_DIR, and each session is the bridge's
 * real long-poll with a `label`. No real agent runs.
 *
 * At 1440, 390 and 320 px:
 *  - every row keeps its mark right against the agent's name, the name on one
 *    line and whole, and the labels in one column (Pi's short name keeps the
 *    column's gap, as the owner saw it);
 *  - a label is one line: desktop cuts it with "…" and keeps the folder's room,
 *    a phone cuts it before the project on the second line;
 *  - a row with no label keeps its words;
 *  - To is one line, label then project, and a label never wraps it.
 * Then: the filter finds a label, Latin or CJK; a label that changes or clears
 * reaches an open picker and To; the Board's New card, which shares the picker,
 * still opens and picks.
 *
 * Build the binary first (see inbox.spec.ts). SESSION_LABEL_SHOTS_DIR: where to
 * write the full-window PNGs (none when unset).
 */

import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { INBOX_BRIDGE_POLL_PATH } from '../../packages/shared/inbox/connection';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shotsDir = process.env.SESSION_LABEL_SHOTS_DIR ? resolve(process.env.SESSION_LABEL_SHOTS_DIR) : null;

/** Exactly 60 characters: the cap. */
const LONG = 'Rework billing export so very large CSV files stream to disk';
const CJK = '冲突筛查圆桌 · kelu';
/** 60 CJK characters: twice the width of LONG, with no space to break at. */
const LONG_CJK = '冲突筛查圆桌会议纪要与下一步行动清单汇总整理并同步给所有参与方确认后归档到项目知识库供后续查阅和复盘使用的完整版本草稿版';

const SESSIONS: { session: string; host: string; label?: string }[] = [
  { session: 'ses-stripe', host: 'claude-code', label: 'Stripe webhook retries' },
  { session: 'ses-plain-1', host: 'claude-code' },
  { session: 'ses-long', host: 'claude-code', label: LONG },
  { session: 'ses-plain-2', host: 'claude-code' },
  { session: 'ses-cjk', host: 'pi', label: CJK },
  { session: 'ses-flaky', host: 'claude-code', label: 'Flaky checkout e2e' },
  { session: 'ses-release', host: 'claude-code', label: 'Release notes' },
  { session: 'ses-login', host: 'claude-code', label: 'Fix login redirect' },
  { session: 'ses-docs', host: 'pi', label: 'Docs pass' },
  { session: 'ses-auth', host: 'claude-code', label: 'Migrate auth tokens' },
];

interface World {
  root: string;
  dataDir: string;
  url: string;
  agent: SimAgent;
  polls: Map<string, Poll>;
}

let world: World;

/** One live session: the bridge's long-poll. `label` is read for every poll, as a connection does. */
class Poll {
  private stopped = false;
  private readonly loop: Promise<void>;
  constructor(
    readonly session: string,
    readonly host: string,
    public label: string | undefined,
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
        body: JSON.stringify({ session: this.session, host: this.host, waitMs: 500, project_path: this.projectPath, started_at: this.startedAt, busy: false, idle_since: this.startedAt, ...(this.label === undefined ? {} : { label: this.label }) }),
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
  const root = inboxScratch('plannotator-session-label-e2e-');
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ inboxBoard: true, inboxBoardIntro: { shownAt: new Date().toISOString() } }));
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_UPDATE_CHECK: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  world = { root, dataDir, url: started.stdout.trim(), agent, polls: new Map() };
  const project = scratchProject(join(root, 'src'), 'ai-collab');
  await agent.send({ project_path: project, subject: 'Run finished', body: 'The export streams rows now.' });
  const now = Date.now();
  SESSIONS.forEach(({ session, host, label }, i) => world.polls.set(session, new Poll(session, host, label, project, now - i * 60_000)));
});

test.afterAll(async () => {
  try {
    if (!world) return;
    await Promise.all([...world.polls.values()].map((poll) => poll.stop()));
    await world.agent.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

const options = (dialog: Locator) => dialog.locator('[role="listbox"] > [role="option"]');

/** Opens New message with the picker open, all ten sessions in it. */
async function openPicker(page: Page, phone: boolean): Promise<Locator> {
  await page.locator(phone ? '.ib-lhead [data-open-compose]' : '.ib-side [data-open-compose]').first().click();
  const dialog = page.locator('dialog[data-compose]');
  const to = dialog.locator('.ib-cp-tobtn');
  await expect(to).not.toHaveAttribute('data-loading', /.*/, { timeout: 20_000 });
  await to.click();
  await expect(options(dialog)).toHaveCount(SESSIONS.length, { timeout: 20_000 });
  return dialog;
}

interface RowFacts {
  session: string;
  height: number;
  markGap: number;
  nameOneLine: boolean;
  nameWhole: boolean;
  labelLeft: number;
  labelText: string;
  labelCut: boolean;
  labelWhiteSpace: string;
  labelHeight: number;
  lineHeight: number;
  rowRight: number;
  folderWidth: number;
}

/** Every number the checks below need, one row at a time. */
function rowFacts(dialog: Locator): Promise<RowFacts[]> {
  return options(dialog).evaluateAll((rows) =>
    rows.map((row) => {
      const mark = row.querySelector('.ib-mk')!.getBoundingClientRect();
      const name = row.querySelector<HTMLElement>('.ib-cp-oa')!;
      const label = row.querySelector<HTMLElement>('.ib-cp-op')!;
      const inner = row.querySelector<HTMLElement>('.ib-cp-ol') ?? label;
      const folder = row.querySelector<HTMLElement>('.ib-cp-of');
      const style = getComputedStyle(label);
      return {
        session: row.getAttribute('data-compose-session')!,
        height: row.getBoundingClientRect().height,
        markGap: name.getBoundingClientRect().left - mark.right,
        nameOneLine: name.getBoundingClientRect().height < parseFloat(getComputedStyle(name).fontSize) * 2,
        nameWhole: name.scrollWidth <= name.clientWidth,
        labelLeft: label.getBoundingClientRect().left,
        labelText: label.textContent ?? '',
        labelCut: inner.scrollWidth > inner.clientWidth,
        labelWhiteSpace: getComputedStyle(inner).whiteSpace,
        labelHeight: label.getBoundingClientRect().height,
        lineHeight: parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5,
        rowRight: row.getBoundingClientRect().right,
        folderWidth: folder ? folder.getBoundingClientRect().width : 0,
      };
    }),
  );
}

/** What holds for every row at every width: the mark against the name, the name on one line and whole, the label on one line. */
function expectCleanRows(rows: RowFacts[], width: number): void {
  expect(rows).toHaveLength(SESSIONS.length);
  for (const row of rows) {
    expect(row.markGap, `${row.session}: the mark sits against the name`).toBeLessThanOrEqual(10.5);
    expect(row.markGap, `${row.session}: the mark and the name do not touch`).toBeGreaterThanOrEqual(4);
    expect(row.nameOneLine, `${row.session}: the name is on one line`).toBe(true);
    expect(row.nameWhole, `${row.session}: the name is whole`).toBe(true);
    expect(row.rowRight, row.session).toBeLessThanOrEqual(width);
  }
  for (const row of rows.filter((candidate) => SESSIONS.find((session) => session.session === candidate.session)?.label)) {
    expect(row.labelWhiteSpace, `${row.session}: a label never wraps`).toBe('nowrap');
    expect(row.labelHeight, `${row.session}: a label is one line`).toBeLessThan(row.lineHeight * 1.5);
  }
}

const toLine = (dialog: Locator) =>
  dialog.evaluate((el) => {
    const row = el.querySelector('.ib-cp-to')!;
    const button = row.querySelector('.ib-cp-tobtn')!;
    const detail = button.querySelector<HTMLElement>('.ib-cp-tod')!;
    const chevron = button.querySelector(':scope > svg.ib-ic:last-child')!;
    const lineHeight = parseFloat(getComputedStyle(detail).lineHeight);
    return {
      agent: button.querySelector('b')!.textContent,
      detail: detail.textContent,
      name: button.getAttribute('aria-label'),
      detailHeight: detail.getBoundingClientRect().height,
      lineHeight,
      rowBottom: row.getBoundingClientRect().bottom,
      rowRight: row.getBoundingClientRect().right,
      detailBottom: detail.getBoundingClientRect().bottom,
      chevronRight: chevron.getBoundingClientRect().right,
      detailRight: detail.getBoundingClientRect().right,
      chevronLeft: chevron.getBoundingClientRect().left,
      labelCut: [detail, ...detail.querySelectorAll<HTMLElement>('[data-cut]')].some((part) => part.scrollWidth > part.clientWidth + 0.5),
    };
  });

function expectOneLineTo(line: Awaited<ReturnType<typeof toLine>>): void {
  expect(line.detailHeight).toBeLessThan(line.lineHeight * 1.5);
  expect(line.detailBottom).toBeLessThanOrEqual(line.rowBottom);
  expect(line.detailRight).toBeLessThanOrEqual(line.chevronLeft + 0.5);
  expect(line.chevronRight).toBeLessThanOrEqual(line.rowRight);
}

async function pick(dialog: Locator, session: string): Promise<void> {
  await dialog.locator(`[data-compose-session="${session}"]`).click();
  await expect(dialog.locator('.ib-cp-tobtn')).toHaveAttribute('data-compose-to', session);
}

test('a desktop window: labels in one column, the folder kept, To one line, the filter', async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(world.url);
    const dialog = await openPicker(page, false);
    const rows = await rowFacts(dialog);
    expectCleanRows(rows, 1440);
    const by = (session: string) => rows.find((row) => row.session === session)!;

    // One column: Pi's short name keeps the gap, so its label starts where every other does.
    expect(new Set(rows.map((row) => Math.round(row.labelLeft))).size).toBe(1);
    for (const row of rows) expect(row.height).toBeLessThan(40);

    // The long label is cut and keeps the folder's room; the unlabelled rows keep their words.
    expect(by('ses-long').labelCut).toBe(true);
    expect(by('ses-long').folderWidth).toBeGreaterThan(70);
    expect(by('ses-plain-1').labelText).toBe('ai-collab');
    expect(by('ses-plain-2').labelText).toBe('ai-collab');
    expect(by('ses-login').labelText).toBe('Fix login redirect');
    expect(by('ses-cjk').labelText).toBe(CJK);

    // The cut label's whole text is a tooltip; one that fits has none.
    await dialog.locator('[data-compose-session="ses-long"] .ib-cp-op').hover();
    await expect(page.locator('[data-pn-tooltip]')).toHaveText(LONG);
    await page.mouse.move(0, 0);
    await expect(page.locator('[data-pn-tooltip]')).toHaveCount(0);
    await dialog.locator('[data-compose-session="ses-login"] .ib-cp-op').hover();
    await page.waitForTimeout(700);
    await expect(page.locator('[data-pn-tooltip]')).toHaveCount(0);
    await page.mouse.move(0, 0);

    // The filter finds a label, in either script.
    const filter = dialog.getByRole('combobox', { name: 'Find an agent or project' });
    await filter.fill('stripe');
    await expect(options(dialog)).toHaveCount(1);
    await expect(options(dialog).first()).toHaveAttribute('data-compose-session', 'ses-stripe');
    await filter.fill('圆桌');
    await expect(options(dialog)).toHaveCount(1);
    await expect(options(dialog).first()).toHaveAttribute('data-compose-session', 'ses-cjk');
    await filter.fill('');
    await expect(options(dialog)).toHaveCount(SESSIONS.length);

    // To: agent, label, project, on one line; the approved picture has the picker open over it.
    await pick(dialog, 'ses-login');
    const line = await toLine(dialog);
    expect(line.agent).toBe('Claude Code');
    expect(line.detail).toBe('· Fix login redirect · ai-collab');
    expect(line.name).toContain('Fix login redirect');
    expectOneLineTo(line);
    await dialog.locator('.ib-cp-tobtn').click();
    await expect(options(dialog)).toHaveCount(SESSIONS.length);
    await shot(page, 'to-after');

    // The longest label in To is cut, on one line, whichever script.
    await pick(dialog, 'ses-long');
    expectOneLineTo(await toLine(dialog));
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

for (const width of [390, 320]) {
  test(`a phone ${width} px wide: the second line, a label cut before its project, To one line`, async ({ browser }: { browser: Browser }) => {
    const context = await browser.newContext({ viewport: { width, height: width === 320 ? 640 : 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark' });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await page.goto(world.url);
      const dialog = await openPicker(page, true);
      const rows = await rowFacts(dialog);
      expectCleanRows(rows, width);
      const by = (session: string) => rows.find((row) => row.session === session)!;
      expect(by('ses-login').labelText).toBe('Fix login redirect · ai-collab');
      expect(by('ses-cjk').labelText).toBe(`${CJK} · ai-collab`);
      expect(by('ses-plain-1').labelText).toBe('ai-collab');
      // The label is cut before the project: the project is still there, whole.
      const long = dialog.locator('[data-compose-session="ses-long"]');
      await expect(long.locator('.ib-cp-olp')).toHaveText(' · ai-collab');
      const parts = await long.evaluate((row) => {
        const label = row.querySelector<HTMLElement>('.ib-cp-ol')!;
        const project = row.querySelector<HTMLElement>('.ib-cp-olp')!;
        return { labelCut: label.scrollWidth > label.clientWidth, projectCut: project.scrollWidth > project.clientWidth, overflow: getComputedStyle(label).textOverflow };
      });
      expect(parts).toEqual({ labelCut: true, projectCut: false, overflow: 'ellipsis' });
      await shot(page, `phone-${width}-to-after`);

      await pick(dialog, 'ses-long');
      await shot(page, `phone-${width}-to-long`);
      const line = await toLine(dialog);
      expectOneLineTo(line);
      expect(line.labelCut).toBe(true);
      await dialog.locator('.ib-cp-tobtn').click();
      await pick(dialog, 'ses-cjk');
      expectOneLineTo(await toLine(dialog));
      await dialog.locator('.ib-cp-tobtn').click();
      await pick(dialog, 'ses-plain-1');
      const plain = await toLine(dialog);
      expectOneLineTo(plain);
      expect(plain.detail).toBe('· ai-collab');
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });
}

test('a label that changes or clears reaches an open picker and To; 60 CJK characters hold the layout; a list with none looks as before', async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  const page = await context.newPage();
  const login = world.polls.get('ses-login')!;
  try {
    await page.goto(world.url);
    const dialog = await openPicker(page, false);
    await pick(dialog, 'ses-login');
    await dialog.locator('.ib-cp-tobtn').click();

    login.label = LONG_CJK;
    const row = dialog.locator('[data-compose-session="ses-login"] .ib-cp-op');
    await expect(row).toHaveText(LONG_CJK, { timeout: 12_000 });
    const rows = await rowFacts(dialog);
    expect(new Set(rows.map((entry) => Math.round(entry.labelLeft))).size).toBe(1);
    expect(rows.find((entry) => entry.session === 'ses-login')!.labelCut).toBe(true);
    expect(rows.find((entry) => entry.session === 'ses-login')!.folderWidth).toBeGreaterThan(70);
    await shot(page, 'to-long-cjk');
    await page.keyboard.press('Escape');
    expectOneLineTo(await toLine(dialog));

    // Cleared: the same session, under the same id, and To falls back to the project.
    login.label = '';
    await expect(dialog.locator('.ib-cp-tod')).toHaveText('· ai-collab', { timeout: 12_000 });
    await dialog.locator('.ib-cp-tobtn').click();
    await expect(row).toHaveText('ai-collab');

    // No label anywhere: the columns are the ones the approved "before" picture has.
    for (const poll of world.polls.values()) poll.label = '';
    await expect(dialog.locator('[role="listbox"]')).not.toHaveAttribute('data-session-labels', /.*/, { timeout: 12_000 });
    await shot(page, 'to-before');
  } finally {
    for (const { session, label } of SESSIONS) world.polls.get(session)!.label = label;
    await context.close();
  }
});

test("the Board's New card shares the picker: its rows show labels, a pick works, and nothing overflows", async ({ browser }: { browser: Browser }) => {
  for (const width of [1440, 390]) {
    const phone = width < 768;
    const context = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, ...(phone ? { isMobile: true, hasTouch: true } : {}), colorScheme: 'dark' });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await page.goto(`${world.url}#board`);
      await page.locator('[data-board-new]').first().click();
      const dialog = page.locator('dialog:has([data-new-card-title])');
      await expect(dialog).toBeVisible();
      await dialog.locator('[data-new-card-mode="send"]').click();
      const to = dialog.locator('[data-compose-to]');
      await expect(to).toHaveAttribute('data-compose-to', /.+/, { timeout: 20_000 });
      await expect(to).toHaveAttribute('aria-label', 'To: choose an agent', { timeout: 20_000 });
      // Choosing Send opens the picker once the live sessions are known; before that it stays shut.
      if ((await to.getAttribute('aria-expanded')) !== 'true') await to.click();
      await expect(options(dialog)).toHaveCount(SESSIONS.length, { timeout: 20_000 });
      await expect(dialog.locator('[data-compose-session="ses-login"]')).toContainText('Fix login redirect', { timeout: 12_000 });
      expectCleanRows(await rowFacts(dialog), width);
      await shot(page, `board-new-card-${width}`);
      await dialog.locator('[data-compose-session="ses-long"]').click();
      await expect(dialog.locator('[data-compose-picker]')).toHaveCount(0);
      await expect(to).toHaveAttribute('data-compose-to', 'ses-long');
      await expect(to).toContainText('Claude Code');
      await expect(to).toContainText('ai-collab');
      await expect(to).toHaveAttribute('aria-label', `To: Claude Code, ${LONG}, in ai-collab. Change`);
      await expect(to.locator('[data-compose-detail]')).toContainText(LONG);
      await shot(page, `board-new-card-to-${width}`);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }
});
