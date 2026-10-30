/**
 * The Soft look's polish pass (owner, 2026-10-17), proved in a real browser
 * against the compiled binary:
 *
 *  - Mark read's `E` is a keycap inside its borderless button, centred on it;
 *  - a tile's hidden Open holds no room, so a name is never cut more than in
 *    today's look; when Open shows (hover, keyboard focus) it is back in the
 *    row and the name is cut before it, keeping its end, left to right and
 *    right to left; a screen without hover keeps its room;
 *  - layout corners one step smaller (panes 10, row pills 8, tiles 10), buttons
 *    unchanged;
 *  - the text size (`--inbox-text-size`, the Text size setting, 14 by default):
 *    13 takes the base to 13 with the window and ui's drawing following,
 *    nothing under 11 px, and 15 grows every size;
 *  - list rows with no line between them, at today's pitch, light and dark,
 *    beside an open thread and on a phone.
 *
 * Each part is checked against its switch turned off (today's look) in the same
 * page, by a style that sets the switch to `initial`. Build the binary first
 * (see inbox.spec.ts), then `bun run test:e2e:inbox`. PNGs land in
 * .local/proof/soft-polish/.
 */

import { devices, expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'soft-polish');

const LONG = 'refund-worker-artifacts-reconciliation-ledger-october.md';
const RTL = 'تقرير-مطابقة-دفتر-الأستاذ-لشهر-أكتوبر-النهائي.md';
const ASK = ['The refund worker needs a call.', '', ':::question', 'Should the worker retry a 409?', '', '- [ ] Retry with the same key', '- [ ] Dead-letter it', ':::'].join('\n');

interface World {
  url: string;
  context: BrowserContext;
  page: Page;
  claude: SimAgent;
  thread: string;
}

let world: World;

/** Turns one Soft switch off (today's look) until the returned function runs. */
async function todays(page: Page, ...switches: string[]): Promise<() => Promise<void>> {
  const css = `.pn-inbox, :root.light .pn-inbox { ${switches.map((s) => `--ib-soft-${s}: initial !important;`).join(' ')} }`;
  const handle = await page.addStyleTag({ content: css });
  return async () => {
    await handle.evaluate((el) => el.remove());
  };
}

async function shot(page: Page, name: string): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.evaluate((s) => {
      document.documentElement.classList.toggle('light', s === 'light');
      document.documentElement.classList.toggle('dark', s === 'dark');
    }, scheme);
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(proofDir, `${name}-${scheme}.png`) });
  }
  await page.evaluate(() => {
    document.documentElement.classList.add('light');
    document.documentElement.classList.remove('dark');
  });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-soft-polish-');
  const dataDir = join(root, 'data');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const project = scratchProject(join(root, 'src'), 'billing');
  mkdirSync(join(project, 'docs'), { recursive: true });
  writeFileSync(join(project, 'docs', LONG), '# Reconciliation\n\nThe October ledger, refund by refund.\n');
  writeFileSync(join(project, 'docs', RTL), '# تقرير\n\nمطابقة دفتر الأستاذ.\n');
  writeFileSync(join(project, 'docs', 'retry-plan.md'), '# Retry plan\n\nRetry once with the same key.\n');
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const first = await claude.send({ project_path: project, subject: 'Refund worker: retry a 409?', thread: 'refunds', body: ASK, attachments: [`docs/${LONG}`, `docs/${RTL}`, 'docs/retry-plan.md'] });
  // Each in a thread of its own (one session's plain sends would share its default thread).
  for (const subject of ['Nightly build is green', 'Ledger ownership', 'Rotate the processor key?', 'Idempotency cache and paging']) {
    await new Promise((r) => setTimeout(r, 15));
    await claude.send({ project_path: project, subject, thread: subject.toLowerCase().replace(/\W+/g, '-').replace(/-$/, ''), body: `${subject}. Details in the runbook.` });
  }
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  world = { url, context, page, claude, thread: first.thread_id as string };
});

test.afterAll(async () => {
  try {
    if (!world) return;
    await world.claude.close().catch(() => {});
    await world.context.close();
  } finally {
    await removeInboxScratch();
  }
});

test("rows have no line between them at today's pitch; the hover pill still marks the row", async () => {
  const { page } = world;
  await page.goto(world.url);
  const rows = page.locator('.ib-row');
  await expect(rows.first()).toBeVisible();
  await shot(page, '1-list');
  const soft = await rows.evaluateAll((els) => els.map((e) => ({ line: getComputedStyle(e).borderBottomColor, width: getComputedStyle(e).borderBottomWidth, h: e.getBoundingClientRect().height })));
  for (const row of soft) {
    expect(row.line).toBe('rgba(0, 0, 0, 0)');
    expect(row.width).toBe('1px');
  }
  const back = await todays(page, 'rows');
  const today = await rows.evaluateAll((els) => els.map((e) => ({ line: getComputedStyle(e).borderBottomColor, h: e.getBoundingClientRect().height })));
  await back();
  expect(today.map((r) => r.h)).toEqual(soft.map((r) => r.h));
  expect(today[0]!.line).not.toBe('rgba(0, 0, 0, 0)');
  // Dark too.
  await page.evaluate(() => document.documentElement.classList.replace('light', 'dark'));
  // (ui fades colours over 150 ms when the theme changes.)
  await expect.poll(() => rows.first().evaluate((e) => getComputedStyle(e).borderBottomColor)).toBe('rgba(0, 0, 0, 0)');
  await page.evaluate(() => document.documentElement.classList.replace('dark', 'light'));
  await rows.nth(1).hover();
  await expect.poll(() => rows.nth(1).evaluate((e) => getComputedStyle(e, '::before').backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
});

test('beside an open thread the two-line rows have no line either', async () => {
  const { page } = world;
  await page.goto(`${world.url}#thread=${world.thread}`);
  await expect(page.locator('[data-mark-read]')).toBeVisible();
  const rows = page.locator('.ib-nrow');
  await expect(rows.first()).toBeVisible();
  for (const line of await rows.evaluateAll((els) => els.map((e) => getComputedStyle(e).borderBottomColor))) expect(line).toBe('rgba(0, 0, 0, 0)');
  // The open row's pill reads with no lines around it.
  expect(await page.locator('.ib-nrow.ib-sel').evaluate((e) => getComputedStyle(e, '::before').backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
  // Only the rows lose their lines: the thread's own lines (its header's, its foot's) keep today's colour.
  const lines = () => page.evaluate(() => [getComputedStyle(document.querySelector('.ib-phead')!).borderBottomColor, getComputedStyle(document.querySelector('.ib-pfoot')!).borderTopColor]);
  const soft = await lines();
  const back = await todays(page, 'rows');
  const today = await lines();
  await back();
  expect(soft).toEqual(today);
  expect(soft[0]).not.toBe('rgba(0, 0, 0, 0)');
  await shot(page, '2-thread');
});

test("Mark read's E is a keycap inside its button, centred on it; today's look keeps its outlined key", async () => {
  const { page } = world;
  await page.goto(`${world.url}#thread=${world.thread}`);
  const button = page.locator('[data-mark-read]');
  await expect(button).toBeEnabled();
  const kbd = button.locator('.ib-kbd');
  const geometry = async () =>
    button.evaluate((b) => {
      const k = b.querySelector('.ib-kbd')!;
      const br = b.getBoundingClientRect();
      const kr = k.getBoundingClientRect();
      const cs = getComputedStyle(k);
      return { inside: kr.left >= br.left && kr.right <= br.right && kr.top >= br.top && kr.bottom <= br.bottom, dy: Math.abs(kr.top + kr.height / 2 - (br.top + br.height / 2)), end: br.right - kr.right, bg: cs.backgroundColor, line: cs.borderTopColor, w: kr.width };
    });
  const soft = await geometry();
  expect(soft.inside).toBe(true);
  expect(soft.dy).toBeLessThanOrEqual(1);
  expect(soft.bg).not.toBe('rgba(0, 0, 0, 0)');
  expect(soft.w).toBeGreaterThanOrEqual(18);
  // The space after the cap is about the space around its letter: the key ends the control.
  expect(soft.end).toBeLessThan(8);
  await button.hover();
  await expect.poll(() => button.evaluate((b) => getComputedStyle(b).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
  await page.locator('.ib-phead').screenshot({ path: join(proofDir, '3-mark-read-hover.png') });
  await page.mouse.move(700, 880);
  const back = await todays(page, 'hbtns');
  const today = await geometry();
  await back();
  expect(today.line).not.toBe('rgba(0, 0, 0, 0)');
  // Today: the button's 11 px end padding and its 1 px border.
  expect(today.end).toBeCloseTo(12, 0);
  await expect(kbd).toHaveAttribute('data-keycap', 'E');
});

test("a tile's hidden Open holds no room at rest; when it shows (hover, keyboard focus) the name is cut before it and keeps its end, left to right and right to left", async () => {
  const { page } = world;
  await page.goto(`${world.url}#thread=${world.thread}`);
  await expect(page.locator('[data-mark-read]')).toBeVisible();
  for (const name of [LONG, RTL]) {
    const tile = page.locator(`.ib-atts .ib-att-t:has(.ib-fname[data-name="${name}"])`).last();
    await expect(tile).toBeVisible();
    await page.mouse.move(700, 880);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const measure = () =>
      tile.evaluate((t) => {
        const text = t.querySelector('.ib-att-text')!.getBoundingClientRect();
        const name = t.querySelector('.ib-fname')!.getBoundingClientRect();
        const head = t.querySelector('.ib-fname-h') as HTMLElement;
        const tail = t.querySelector('.ib-fname-t')!.getBoundingClientRect();
        const openEl = t.querySelector('.ib-open') as HTMLElement;
        const open = openEl.getBoundingClientRect();
        return {
          shown: head.clientWidth,
          position: getComputedStyle(openEl).position,
          opacity: Number(getComputedStyle(openEl).opacity),
          // The name's end (the extension) and its start are both inside the text box, and Open covers none of it.
          tailInside: tail.left >= text.left - 0.5 && tail.right <= text.right + 0.5,
          nameInside: name.left >= text.left - 0.5 && name.right <= text.right + 0.5,
          clearOfOpen: name.right <= open.left + 0.5 || name.left >= open.right - 0.5,
          openInside: open.right <= t.getBoundingClientRect().right,
        };
      });
    const rest = await measure();
    expect(rest.position, name).toBe('absolute');
    expect(rest.opacity, name).toBe(0);
    const back = await todays(page, 'surfaces');
    const today = await measure();
    await back();
    expect(today.position).toBe('static');
    // At rest more of the name shows than in today's look, where Open keeps its room.
    expect(rest.shown, name).toBeGreaterThan(today.shown);
    await tile.hover();
    await expect.poll(async () => (await measure()).opacity).toBe(1);
    const hovered = await measure();
    expect(hovered.position, name).toBe('static');
    expect(hovered, `${name} hovered`).toMatchObject({ tailInside: true, nameInside: true, clearOfOpen: true, openInside: true });
    // Never cut more than today's look while Open shows.
    expect(hovered.shown, name).toBeGreaterThanOrEqual(today.shown - 0.5);
    await page.locator('.ib-atts').last().screenshot({ path: join(proofDir, `4-tiles-hover-${name === LONG ? 'ltr' : 'rtl'}.png`) });
    // From the keyboard: focus-visible shows Open the same way.
    await page.mouse.move(700, 880);
    await expect.poll(async () => (await measure()).opacity).toBe(0);
    await tile.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(tile).toBeFocused();
    await expect.poll(async () => (await measure()).opacity).toBe(1);
    expect(await measure(), `${name} focused`).toMatchObject({ position: 'static', tailInside: true, nameInside: true, clearOfOpen: true });
  }
  await page.mouse.move(700, 880);
  await page.locator('.ib-atts').last().screenshot({ path: join(proofDir, '4-tiles-rest.png') });
});

test('layout corners are one step smaller; buttons keep theirs', async () => {
  const { page } = world;
  await page.goto(`${world.url}#thread=${world.thread}`);
  await expect(page.locator('[data-mark-read]')).toBeVisible();
  const r = (selector: string, pseudo?: string) => page.locator(selector).first().evaluate((e, p) => getComputedStyle(e, p ?? null).borderTopLeftRadius, pseudo);
  expect(await r('.ib-main > .ib-pane')).toBe('10px');
  expect(await r('.ib-main > .ib-listcol')).toBe('10px');
  expect(await r('.ib-nrow', '::before')).toBe('8px');
  expect(await r('.ib-band')).toBe('8px');
  expect(await r('.ib-att-t')).toBe('10px');
  expect(await r('.pn-inbox fieldset.question-block')).toBe('12px');
  // Buttons are not layout: the header's and the foot's keep their corners.
  expect(await r('[data-mark-read]')).toBe('10px');
  expect(await r('.ib-pfoot .ib-btn')).toBe('999px');
});

test("the text size is 14 by default; at 13 the base is 13 and every size follows, none under 11 px; at 15 every size grows", async () => {
  const { page } = world;
  await page.goto(`${world.url}#thread=${world.thread}`);
  await expect(page.locator('[data-question-part="prompt"]').first()).toBeVisible();
  const sizes = () =>
    page.evaluate(() => {
      const root = document.querySelector('.pn-inbox')!;
      const all = [...root.querySelectorAll<HTMLElement>('*')].filter((e) => e.getClientRects().length && e.childNodes.length && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim()));
      return {
        base: getComputedStyle(root).fontSize,
        prompt: getComputedStyle(document.querySelector('[data-question-part="prompt"]')!).fontSize,
        subject: getComputedStyle(document.querySelector('.ib-subject')!).fontSize,
        each: all.map((e) => parseFloat(getComputedStyle(e).fontSize)),
      };
    });
  const off = await sizes();
  expect(off.base).toBe('14px');
  expect(off.prompt).toBe('15px');
  await page.evaluate(() => document.documentElement.style.setProperty('--inbox-text-size', '13'));
  const on = await sizes();
  expect(on.base).toBe('13px');
  expect(parseFloat(on.prompt)).toBeCloseTo(15 * (13 / 14), 1);
  expect(parseFloat(on.subject)).toBeLessThan(parseFloat(off.subject));
  // One knob: every text that was 11 px or more is still at least 11 px, and none grew.
  expect(on.each.length).toBe(off.each.length);
  for (let i = 0; i < off.each.length; i++) {
    expect(on.each[i]!).toBeLessThanOrEqual(off.each[i]! + 0.01);
    if (off.each[i]! >= 11) expect(on.each[i]!).toBeGreaterThanOrEqual(11);
  }
  await shot(page, '5-type-on');
  await page.evaluate(() => document.documentElement.style.setProperty('--inbox-text-size', '15'));
  const big = await sizes();
  expect(big.base).toBe('15px');
  expect(big.each.length).toBe(off.each.length);
  for (let i = 0; i < off.each.length; i++) expect(big.each[i]!).toBeGreaterThanOrEqual(off.each[i]! - 0.01);
  await page.evaluate(() => document.documentElement.style.removeProperty('--inbox-text-size'));
});

test('a phone: list rows with no line, a tile keeps its Open with its own room', async ({ browser }) => {
  const { defaultBrowserType: _ignored, ...options } = devices['Pixel 7'] as typeof devices['Pixel 7'] & { defaultBrowserType?: string };
  const context = await browser.newContext({ ...options, colorScheme: 'light' });
  try {
    const page = await context.newPage();
    await page.goto(world.url);
    const rows = page.locator('.ib-mrow');
    await expect(rows.first()).toBeVisible();
    for (const line of await rows.evaluateAll((els) => els.map((e) => getComputedStyle(e).borderBottomColor))) expect(line).toBe('rgba(0, 0, 0, 0)');
    await page.screenshot({ path: join(proofDir, '6-phone-list-light.png') });
    await page.goto(`${world.url}#thread=${world.thread}`);
    const tile = page.locator(`.ib-atts .ib-att-t:has(.ib-fname[data-name="${LONG}"])`).last();
    await expect(tile).toBeVisible();
    const open = tile.locator('.ib-open');
    expect(await open.evaluate((o) => getComputedStyle(o).position)).toBe('static');
    expect(Number(await open.evaluate((o) => getComputedStyle(o).opacity))).toBe(1);
    const box = await tile.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(43.9);
  } finally {
    await context.close();
  }
});
