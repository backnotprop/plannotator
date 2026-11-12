/**
 * The skill picker in compose (New message) opens at the caret, on top of
 * everything in the dialog, proved in real browsers against the compiled
 * binary. The bug: the picker hung off the whole (tall) message field, inside
 * the dialog's scrolling body, so it opened under the field where the
 * footer (paperclip, status, Send) covered it; only a faint border showed, or
 * the top two rows once attachments made the dialog taller.
 *
 * Nothing is mocked: `plannotator inbox --background` under a temp data dir
 * and a scratch HOME holding a dozen global skills, one agent message from
 * `plannotator inbox mcp`, and one live agent session as a connection runs
 * it (the bridge's long-poll), so compose opens addressed to it.
 *
 * For each case (Chromium at 1440×900 and 1024×768, empty and with two
 * attachments, and a field scrolled by long text; an iPhone in WebKit):
 * typing `/` opens the picker; it lies fully inside the viewport (on a
 * desktop it floats over the footer and past the dialog's edge when it needs
 * to; on a phone it stays in the sheet above its footer); the point at the
 * middle of its first and last visible rows hits that row (elementFromPoint:
 * nothing covers it); at least min(6, matches) rows show (four on a phone,
 * whose list is 4½ rows); it starts at the caret's line, not at the field's
 * bottom; and Escape closes the picker, not the dialog.
 *
 * The comment card on picked words (a message's, and so a file's: one card) has the same picker. The bug there:
 * the list was drawn inside the card's scrolling field, which clipped all of it, so `/` showed nothing; and the
 * card could not be dragged (a drag from its words selected the page and closed it as a draft). Typing `/` in the
 * card shows the list with nothing over its rows, a click writes the reference, and dragging the quoted words
 * moves the card, open, with its words, whole inside the window.
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bun run test:e2e:inbox -- inbox-compose-skill-picker.spec.ts`.
 * PNGs land in .local/proof/compose-skill-picker/ (and SKILL_PICKER_SHOTS_DIR
 * when set, prefixed with SKILL_PICKER_SHOTS_PREFIX). A shot is taken before
 * the picker's placement is checked, so an older binary still leaves one.
 */

import { devices, expect, test, webkit, type Browser, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { INBOX_BRIDGE_POLL_PATH } from '../../packages/shared/inbox/connection';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'compose-skill-picker');
const extraShots = process.env.SKILL_PICKER_SHOTS_DIR ? resolve(process.env.SKILL_PICKER_SHOTS_DIR) : null;
const shotPrefix = process.env.SKILL_PICKER_SHOTS_PREFIX ?? '';

const SKILLS = [
  'agents', 'anatomy', 'animate', 'break-ui', 'changelog-draft', 'design-artifact',
  'effect', 'emil-design-eng', 'foundry', 'html-plan', 'loop', 'write-better',
];

interface World {
  root: string;
  dataDir: string;
  url: string;
  agent: SimAgent;
  stopPolling: () => Promise<void>;
  files: string[];
  /** The agent's message, opened in the window. */
  thread: string;
}

let world: World;

function registry(dataDir: string): { port: number; token: string } {
  return JSON.parse(readFileSync(join(dataDir, 'inbox', 'inbox.json'), 'utf8'));
}

/** One live agent session, polling as the mod, Pi and OpenCode do, so compose has someone to write to. */
function liveSession(dataDir: string, project: string): () => Promise<void> {
  let stopped = false;
  const startedAt = Date.now() - 30 * 60_000;
  const loop = (async () => {
    while (!stopped) {
      const { port, token } = registry(dataDir);
      await fetch(`http://127.0.0.1:${port}${INBOX_BRIDGE_POLL_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ session: 'ses_picker', host: 'claude-code', waitMs: 1_000, project_path: project, started_at: startedAt, busy: true, idle_since: null }),
      }).catch(() => null);
    }
  })();
  return async () => {
    stopped = true;
    await loop;
  };
}

async function shot(page: Page, name: string, schemes: readonly ('light' | 'dark')[] = ['light', 'dark']): Promise<void> {
  for (const scheme of schemes) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(250);
    const file = join(proofDir, `${shotPrefix}${name}-${scheme}.png`);
    await page.screenshot({ path: file });
    if (extraShots) copyFileSync(file, join(extraShots, `${shotPrefix}${name}-${scheme}.png`));
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  if (extraShots) mkdirSync(extraShots, { recursive: true });
  const root = inboxScratch('plannotator-inbox-compose-skill-picker-e2e-');
  const dataDir = join(root, 'data');
  // The picker reads the global skill folders under HOME: only this scratch HOME's.
  for (const name of SKILLS) {
    const dir = join(root, '.claude', 'skills', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: The ${name} skill, with a description long enough to be cut at the row's end in a narrow dialog.\n---\n\n# ${name}\n`);
  }
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    CLAUDE_CONFIG_DIR: join(root, '.claude'),
    CODEX_HOME: join(root, '.codex'),
    XDG_CONFIG_HOME: join(root, '.config'),
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const project = scratchProject(join(root, 'src'), 'plannotator');
  const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const sent = await agent.send({ project_path: project, subject: 'Run finished', body: 'The export now streams rows to the file.' });
  const files = ['notes.md', 'plan.md'].map((name) => {
    const file = join(root, name);
    writeFileSync(file, `# ${name}\n\nA file to attach.\n`);
    return file;
  });
  world = { root, dataDir, url, agent, stopPolling: liveSession(dataDir, project), files, thread: String(sent.url) };
});

test.afterAll(async () => {
  try {
    if (!world) return;
    await world.stopPolling();
    await world.agent.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function box(page: Page, selector: string): Promise<Box> {
  const found = await page.locator(selector).first().boundingBox();
  if (!found) throw new Error(`no box for ${selector}`);
  return found;
}

/** Opens compose addressed to the live session, the message field focused. */
async function openCompose(page: Page, opener: string): Promise<void> {
  await page.goto(world.url);
  await page.locator(opener).first().click();
  const dialog = page.locator('dialog[data-compose]');
  await expect(dialog).toBeVisible();
  // A plain New message opens with To empty: pick the live session (a computer's To line, a phone's pill in the foot's row).
  const to = dialog.locator('[data-compose-to]');
  await expect(to).not.toHaveAttribute('data-loading', /.*/);
  await to.click();
  await dialog.locator('[data-compose-session="ses_picker"]').click();
  await expect(to).toContainText('Claude Code');
  await dialog.getByRole('textbox', { name: 'Message' }).focus();
}

/** The checks every case makes once `/` was typed. */
/**
 * The checks every case makes once `/` was typed: the picker is fully inside the viewport (it may float over
 * the dialog's footer and past its bottom edge), on top at the middle of its first and last visible rows, at
 * least min(`minRows`, matches) rows show, and it hangs off the caret's line.
 */
async function expectPickerAtCaret(page: Page, options: { firstLine: boolean; minRows: number; minRowHeight?: number }): Promise<void> {
  const menu = page.locator('dialog[data-compose] [data-skill-menu]');
  await expect(menu).toBeVisible();
  // Settle the placement (it re-measures after the caret box lands).
  await page.waitForTimeout(150);
  const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  const picker = await box(page, 'dialog[data-compose] [data-skill-menu]');
  const field = await box(page, 'dialog[data-compose] textarea.ib-rtext');
  // Fully inside the viewport.
  expect(picker.y).toBeGreaterThanOrEqual(-0.5);
  expect(picker.x).toBeGreaterThanOrEqual(-0.5);
  expect(picker.x + picker.width).toBeLessThanOrEqual(viewport.width + 0.5);
  expect(picker.y + picker.height).toBeLessThanOrEqual(viewport.height + 0.5);
  // Nothing covers the rows: the first and the last one that shows are hit at their middle.
  const rows = page.locator('dialog[data-compose] [data-skill-item]');
  const seen = await rows.evaluateAll((all) => {
    const list = all[0]?.parentElement;
    if (!list) return { total: 0, shown: 0, hits: [] };
    const view = list.getBoundingClientRect();
    const shown = all.filter((row) => {
      const r = row.getBoundingClientRect();
      return r.top >= view.top - 0.5 && r.bottom <= view.bottom + 0.5;
    });
    const hits = [shown[0], shown[shown.length - 1]].map((row) => {
      const r = row!.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { name: row!.getAttribute('data-skill-item'), hit: !!hit && row!.contains(hit), height: r.height };
    });
    return { total: all.length, shown: shown.length, hits };
  });
  expect(seen.shown).toBeGreaterThanOrEqual(Math.min(options.minRows, seen.total));
  expect(seen.hits.length).toBe(2);
  for (const hit of seen.hits) {
    expect(hit.hit, `${hit.name} is covered`).toBe(true);
    if (options.minRowHeight) expect(hit.height).toBeGreaterThanOrEqual(options.minRowHeight);
  }
  // At the caret: on a one-line message the picker hangs off the first line (below it, or above it when
  // there is no room), never off the bottom of the 150 px field as it did.
  if (options.firstLine) {
    const placement = await menu.getAttribute('data-skill-menu-placement');
    if (placement === 'below') expect(picker.y).toBeLessThan(field.y + 48);
    else expect(picker.y + picker.height).toBeLessThanOrEqual(field.y + 0.5);
  }
}

async function expectEscapeClosesPickerFirst(page: Page): Promise<void> {
  const dialog = page.locator('dialog[data-compose]');
  await page.keyboard.press('Escape');
  await expect(dialog.locator('[data-skill-menu]')).toHaveCount(0);
  await expect(dialog).toBeVisible();
  // The next Escape is the dialog's: it keeps the message as a draft and leaves, with no question.
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('[data-inbox-toast]')).toContainText('Draft saved');
}

for (const size of [
  { name: '1440', viewport: { width: 1440, height: 900 } },
  { name: '1024', viewport: { width: 1024, height: 768 } },
]) {
  test(`desktop ${size.name}: empty, the picker opens at the caret on top of the footer; Escape closes it first`, async ({ browser }: { browser: Browser }) => {
    const context = await browser.newContext({ viewport: size.viewport, colorScheme: 'light' });
    const page = await context.newPage();
    try {
      await openCompose(page, '.ib-side [data-open-compose]');
      await page.keyboard.type('The skill selector in the new message box is broken /');
      await expect(page.locator('dialog[data-compose] [data-skill-menu]')).toBeVisible();
      if (size.name === '1440') await shot(page, `desktop-${size.name}-empty`);
      await expectPickerAtCaret(page, { firstLine: true, minRows: 6 });
      // A query filters in place and the picker stays at the caret.
      await page.keyboard.type('an');
      await expect(page.locator('dialog[data-compose] [data-skill-item]').first()).toHaveAttribute('data-skill-item', /an/);
      await expectEscapeClosesPickerFirst(page);
    } finally {
      await context.close();
    }
  });

  test(`desktop ${size.name}: with two attachments the picker still opens at the caret on top of everything`, async ({ browser }: { browser: Browser }) => {
    const context = await browser.newContext({ viewport: size.viewport, colorScheme: 'light' });
    const page = await context.newPage();
    try {
      await openCompose(page, '.ib-side [data-open-compose]');
      const dialog = page.locator('dialog[data-compose]');
      await dialog.locator('[data-compose-attach]').setInputFiles(world.files);
      await expect(dialog.locator('[data-compose-file="done"]')).toHaveCount(2);
      await dialog.getByRole('textbox', { name: 'Message' }).focus();
      await page.keyboard.type('The skill selector in the new message box is broken /');
      await expect(dialog.locator('[data-skill-menu]')).toBeVisible();
      if (size.name === '1440') await shot(page, `desktop-${size.name}-two-attachments`);
      await expectPickerAtCaret(page, { firstLine: true, minRows: 6 });
      // A pointer pick inserts the skill and keeps the dialog.
      await dialog.locator('[data-skill-item="anatomy"]').dispatchEvent('pointerdown');
      await expect(dialog.getByRole('textbox', { name: 'Message' })).toHaveValue(/\/anatomy /);
      await expect(dialog.locator('[data-skill-menu]')).toHaveCount(0);
      // Escape keeps it as a draft and closes.
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
}

test('desktop 1440: in a field scrolled by a long message the picker follows the caret and stays on screen', async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  try {
    await openCompose(page, '.ib-side [data-open-compose]');
    const field = page.locator('dialog[data-compose]').getByRole('textbox', { name: 'Message' });
    await field.fill(Array.from({ length: 30 }, (_, i) => `Line ${i + 1} of a long message.`).join('\n') + '\n');
    await field.press('End');
    await page.keyboard.type('/');
    const scrolled = await field.evaluate((el) => el.scrollTop);
    expect(scrolled).toBeGreaterThan(0);
    await shot(page, 'desktop-1440-scrolled-field', ['light']);
    await expectPickerAtCaret(page, { firstLine: false, minRows: 6 });
    // The caret's line is at the field's bottom: the picker sits next to it, not at the field's top.
    const picker = await box(page, 'dialog[data-compose] [data-skill-menu]');
    const text = await box(page, 'dialog[data-compose] textarea.ib-rtext');
    const placement = await page.locator('dialog[data-compose] [data-skill-menu]').getAttribute('data-skill-menu-placement');
    if (placement === 'above') expect(picker.y + picker.height).toBeGreaterThan(text.y + text.height - 80);
    else expect(picker.y).toBeGreaterThan(text.y + text.height - 80);
    await page.keyboard.press('Escape');
    await expect(page.locator('dialog[data-compose] [data-skill-menu]')).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('an iPhone (WebKit): the picker opens full width at the caret, 44 px rows, inside the sheet above its footer', async () => {
  // No args: the config's Chromium flags (--use-mock-keychain) stop WebKit from starting on Linux.
  const browser = await webkit.launch({ args: [] });
  try {
    const context = await browser.newContext({ ...devices['iPhone 15'], colorScheme: 'light' });
    const page = await context.newPage();
    await openCompose(page, '.ib-lhead [data-open-compose]');
    await page.keyboard.type('Broken /');
    await expect(page.locator('dialog[data-compose] [data-skill-menu]')).toBeVisible();
    await shot(page, 'phone-iphone15');
    // A phone keeps the reply box's rule: 4½ rows of 44 px, so four whole rows show.
    await expectPickerAtCaret(page, { firstLine: true, minRows: 4, minRowHeight: 43.5 });
    // The sheet's picker stays below its top bar and above its footer (the keyboard sits there).
    const sheetPicker = await box(page, 'dialog[data-compose] [data-skill-menu]');
    const bar = await box(page, 'dialog[data-compose] .ib-cp-bar');
    const sheetFoot = await box(page, 'dialog[data-compose] .ib-cp-foot');
    expect(sheetPicker.y).toBeGreaterThanOrEqual(bar.y + bar.height - 0.5);
    expect(sheetPicker.y + sheetPicker.height).toBeLessThanOrEqual(sheetFoot.y + 0.5);
    // Full width: the field's width.
    const picker = await box(page, 'dialog[data-compose] [data-skill-menu]');
    const text = await box(page, 'dialog[data-compose] textarea.ib-rtext');
    expect(Math.abs(picker.width - text.width)).toBeLessThanOrEqual(2);
    await page.keyboard.press('Escape');
    await expect(page.locator('dialog[data-compose] [data-skill-menu]')).toHaveCount(0);
    await expect(page.locator('dialog[data-compose]')).toBeVisible();
    await context.close();
  } finally {
    await browser.close();
  }
});

test('the comment card on picked words: "/" lists the skills on top, a pick writes the reference, and its words drag it', async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  try {
    await page.goto(world.thread);
    const words = page.getByText('The export now streams rows to the file.').last();
    await expect(words).toBeVisible();
    const line = (await words.boundingBox())!;
    await page.mouse.move(line.x + 3, line.y + line.height / 2);
    await page.mouse.down();
    await page.mouse.move(line.x + 150, line.y + line.height / 2, { steps: 8 });
    await page.mouse.up();
    await page.locator('.annotation-toolbar').getByRole('button', { name: 'Comment', exact: true }).click();
    const card = page.locator('[data-comment-popover][data-comment-card]');
    const field = card.locator('textarea');
    await expect(field).toBeFocused();
    await page.keyboard.type('Tighten this /');
    const menu = card.locator('[data-skill-menu]');
    await expect(menu).toBeVisible();
    await page.waitForTimeout(150);
    // Every row that shows is hit at its middle: nothing clips or covers the list, and it is inside the window.
    const seen = await card.locator('[data-skill-item]').evaluateAll((rows) => {
      const list = rows[0]!.parentElement!.getBoundingClientRect();
      const menuBox = rows[0]!.closest('[data-skill-menu]')!.getBoundingClientRect();
      const shown = rows.filter((row) => { const r = row.getBoundingClientRect(); return r.top >= list.top - 0.5 && r.bottom <= list.bottom + 0.5; });
      return {
        shown: shown.length,
        covered: shown.filter((row) => { const r = row.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !hit || !row.contains(hit); }).map((row) => row.getAttribute('data-skill-item')),
        inside: menuBox.top >= 0 && menuBox.left >= 0 && menuBox.bottom <= window.innerHeight && menuBox.right <= window.innerWidth,
      };
    });
    expect(seen.shown).toBeGreaterThanOrEqual(4);
    expect(seen.covered).toEqual([]);
    expect(seen.inside).toBe(true);
    await card.locator('[data-skill-item="agents"]').click();
    await expect(field).toHaveValue('Tighten this /agents ');
    await expect(menu).toHaveCount(0);

    // Dragged by the quoted words: it moves that far, stays open with its words, and no draft was left behind.
    const handle = card.locator('[data-comment-card-handle]');
    const from = (await card.boundingBox())!;
    const grip = (await handle.boundingBox())!;
    await page.mouse.move(grip.x + 40, grip.y + grip.height / 2);
    await page.mouse.down();
    await page.mouse.move(grip.x + 40 + 180, grip.y + grip.height / 2 + 120, { steps: 10 });
    await page.mouse.up();
    const to = (await card.boundingBox())!;
    expect(Math.abs(to.x - from.x - 180)).toBeLessThanOrEqual(1);
    expect(Math.abs(to.y - from.y - 120)).toBeLessThanOrEqual(1);
    await expect(field).toHaveValue('Tighten this /agents ');
    await expect(page.locator('[data-comment-draft-badge]')).toHaveCount(0);
    // Thrown past a corner, the whole card is still inside the window.
    const grip2 = (await handle.boundingBox())!;
    await page.mouse.move(grip2.x + 40, grip2.y + grip2.height / 2);
    await page.mouse.down();
    await page.mouse.move(4000, 4000, { steps: 6 });
    await page.mouse.up();
    const far = (await card.boundingBox())!;
    expect(far.x + far.width).toBeLessThanOrEqual(1440 + 1);
    expect(far.y + far.height).toBeLessThanOrEqual(900 + 1);
    await expect(field).toHaveValue('Tighten this /agents ');
  } finally {
    await context.close();
  }
});
