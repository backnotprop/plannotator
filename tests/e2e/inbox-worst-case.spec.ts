import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { LiveSessions, seedWorstCase, type WorstCaseWorld } from '../../scripts/inbox-worst-case';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';
import { INBOX_ASKER_RESTART_GRACE_MS } from '../../packages/server/inbox-sessions';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'worst-case');

interface World {
  url: string;
  startedAt: number;
  seed: WorstCaseWorld;
  ids: Record<string, string>;
  live: LiveSessions;
}

let world: World;

interface Width {
  name: string;
  width: number;
  height: number;
  touch?: boolean;
}

const WIDTHS: Width[] = [
  { name: '1440', width: 1440, height: 900 },
  { name: '1280', width: 1280, height: 800 },
  { name: '1024', width: 1024, height: 768 },
  { name: 'ipad', width: 820, height: 1180, touch: true },
  { name: 'phone', width: 390, height: 844, touch: true },
  { name: 'phone-side', width: 844, height: 390, touch: true },
  { name: 'zoom200', width: 720, height: 450 },
];

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-worst-case-e2e-');
  const dataDir = join(root, 'data');
  const seed = await seedWorstCase({ dataDir, src: join(root, 'src') });
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_UPDATE_CHECK: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  const url = started.stdout.trim().replace(/\/+$/, '');
  const projects = (await (await fetch(`${url}/api/inbox/projects`)).json()) as { projects: { id: string; root: string }[] };
  const ids = Object.fromEntries(Object.entries(seed.projects).map(([role, path]) => [role, projects.projects.find((p) => p.root === path)?.id ?? '']));
  world = { url, startedAt: Date.now(), seed, ids, live: new LiveSessions(dataDir, seed.projects.billing, 50) };
});

test.afterAll(async () => {
  try {
    await world?.live.stop();
  } finally {
    await removeInboxScratch();
  }
});

async function open(browser: Browser, w: Width, hash = '', colorScheme: 'light' | 'dark' = 'light'): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: w.width, height: w.height }, isMobile: !!w.touch, hasTouch: !!w.touch, deviceScaleFactor: 1, reducedMotion: 'reduce', colorScheme });
  const page = await context.newPage();
  await page.goto(`${world.url}/${hash ? `#${hash}` : ''}`);
  await page.waitForSelector('.pn-inbox');
  await page.waitForTimeout(500);
  return { context, page };
}

async function shapes(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const W = window.innerWidth;
    const H = window.innerHeight;
    const scroller = document.scrollingElement!;
    if (scroller.scrollWidth > W + 1) out.push(`the page is ${scroller.scrollWidth}px wide in a ${W}px window`);
    for (const el of document.querySelectorAll<HTMLElement>('.pn-inbox *')) {
      const style = getComputedStyle(el);
      if (style.position === 'fixed' || style.position === 'absolute') continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || style.visibility === 'hidden') continue;
      if (el.closest('pre, code, table, [data-code-view], .ib-cmd, .ib-docarea, .ib-imgstage, .ib-gbody')) continue;
      let clipped = false;
      for (let up = el.parentElement; up && !up.classList.contains('ib-shell'); up = up.parentElement) {
        if (getComputedStyle(up).overflowX !== 'visible' && up.getBoundingClientRect().right <= W + 1) {
          clipped = true;
          break;
        }
      }
      if (r.right > W + 1 && !clipped && el.closest('.ib-shell')) {
        out.push(`${el.tagName.toLowerCase()}.${[...el.classList].slice(0, 2).join('.')} reaches ${Math.round(r.right)} in a ${W}px window`);
        break;
      }
    }
    for (const button of document.querySelectorAll<HTMLElement>('.ib-btn.ib-pri')) {
      const r = button.getBoundingClientRect();
      if (r.width === 0 || getComputedStyle(button).visibility === 'hidden' || button.closest('[inert], [hidden]')) continue;
      if (r.bottom > H + 1 || r.right > W + 1 || r.top < -1) out.push(`"${button.textContent?.trim()}" is outside the window (${Math.round(r.left)},${Math.round(r.top)} to ${Math.round(r.right)},${Math.round(r.bottom)})`);
    }
    return out;
  });
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(proofDir, `${name}.png`) });
}

for (const [w, scheme] of [...WIDTHS.map((w) => [w, 'light'] as const), [WIDTHS[0]!, 'dark'] as const, [WIDTHS[4]!, 'dark'] as const]) {
  test(`${w.name}${scheme === 'dark' ? ' dark' : ''}: the list, a thread with files, a message table and Settings hold their shapes`, async ({ browser }) => {
    const { context, page } = await open(browser, w, '', scheme);
    try {
      expect(await shapes(page)).toEqual([]);
      await shot(page, `${w.name}-${scheme}-list`);
      await page.goto(`${world.url}/#thread=${world.seed.threads.files}`);
      await page.waitForSelector('section.ib-pane .ib-atts.ib-tiles');
      await page.waitForTimeout(400);
      expect(await shapes(page)).toEqual([]);
      const tiles = page.locator('section.ib-pane .ib-atts.ib-tiles').last().locator('.ib-att-t');
      const heights = new Set((await tiles.evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().height)))).filter((h) => h > 0));
      expect([...heights], 'tiles in one grid have one height').toHaveLength(1);
      await expect(page.locator(`section.ib-pane .ib-atts.ib-tiles [data-attachment-name="${world.seed.files.changed}"]`).last()).toContainText('2 annotations');
      await shot(page, `${w.name}-${scheme}-files`);
      await page.goto(`${world.url}/#thread=${world.seed.threads.kitchen}`);
      await page.waitForSelector('section.ib-pane .ib-body table');
      await page.waitForTimeout(600);
      expect(await shapes(page)).toEqual([]);
      const cell = await page.locator('section.ib-pane .ib-body td').first().evaluate((el) => el.getBoundingClientRect().width);
      expect(cell, 'a table cell keeps a word whole').toBeGreaterThan(40);
      const img = page.locator('section.ib-pane .ib-body img[data-ib-cut]');
      await expect(img).toHaveCount(1);
      const cut = (await img.boundingBox())!;
      expect(cut.height).toBeLessThanOrEqual(Math.max(320, w.height * 0.7) + 1);
      expect(cut.width).toBeLessThanOrEqual(390.5);
      const more = page.locator('section.ib-pane .ib-body').getByRole('button', { name: 'Show all of The checkout page on a phone' });
      await expect(more).toBeVisible();
      await shot(page, `${w.name}-${scheme}-kitchen`);
      if (scheme === 'light') {
        const at = page.url();
        await more.click();
        const whole = (await page.locator('section.ib-pane .ib-body img[data-ib-open]').boundingBox())!;
        expect(Math.round(whole.height / whole.width), 'the whole picture, its shape kept').toBe(Math.round(4000 / 390));
        expect(page.url(), 'Show all opens nothing else').toBe(at);
        await expect(page.locator('section.ib-pane .ib-body').getByRole('button', { name: 'Show less of The checkout page on a phone' })).toBeVisible();
      }
      await page.goto(`${world.url}/#settings/storage`);
      await page.waitForSelector('[data-store-project]');
      await page.locator('[data-store-project] .ib-fold', { hasText: 'billing-svc' }).first().click();
      await page.waitForTimeout(300);
      expect(await shapes(page)).toEqual([]);
      const table = await page.locator('.ib-stbl').evaluate((el) => ({ table: el.getBoundingClientRect().right, card: (el.closest('.ib-card') ?? el.parentElement)!.getBoundingClientRect().right }));
      expect(table.table).toBeLessThanOrEqual(table.card + 1);
      await shot(page, `${w.name}-${scheme}-storage`);
      await page.goto(`${world.url}/#settings/archived`);
      await page.waitForSelector('[data-archived-thread]');
      await page.waitForTimeout(300);
      expect(await shapes(page)).toEqual([]);
      const row = await page.locator('[data-archived-thread]').first().evaluate((el) => {
        const r = el.getBoundingClientRect();
        const b = el.querySelector('[data-archived-unarchive]')!.getBoundingClientRect();
        return { rowTop: r.top, rowBottom: r.bottom, button: b.top };
      });
      expect(row.button, 'Unarchive sits beside the subject, not under it').toBeLessThan(row.rowTop + 40);
      await shot(page, `${w.name}-${scheme}-archived`);
    } finally {
      await context.close();
    }
  });
}

test('the names: real folder names, a parent folder for two "api", days and years, hover text on what is cut', async ({ browser }) => {
  const { context, page } = await open(browser, WIDTHS[0]!);
  try {
    const sidebar = await page.locator('.ib-side .ib-proj .ib-name').allTextContents();
    for (const name of ['請求サービス', 'خدمة-الفواتير', 'dịch-vụ-thanh-toán', 'платёжный-сервис', 'api · work', 'api · personal', 'northwind-industries-holdings-platform-billing-service']) expect(sidebar).toContain(name);
    for (const height of await page.locator('.ib-side > .ib-nav').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height))) expect(height).toBe(32);
    await page.goto(`${world.url}/#project=${world.ids.billing}`);
    await page.waitForSelector(`[data-thread-id="${world.seed.threads.lastYear}"]`);
    await expect(page.locator(`[data-thread-id="${world.seed.threads.lastYear}"] .ib-t`)).toHaveText(new RegExp(`, ${new Date().getFullYear() - 1}$`));
    for (const subject of await page.locator('.ib-lbody :is(.ib-title, .ib-pv)').allTextContents()) expect(subject).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    const items = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('.ib-lbody .ib-title, .ib-lbody .ib-pv, .ib-lbody .ib-p')].map((el) => ({
        project: el.classList.contains('ib-p'),
        cut: el.scrollWidth > el.clientWidth + 1,
        text: el.textContent,
        title: el.getAttribute('title'),
      })),
    );
    expect(items.filter((t) => t.cut).length, 'the seed cuts something in this list').toBeGreaterThan(0);
    expect(items.filter((t) => t.title !== null)).toEqual([]);
    for (const project of [false, true]) {
      const cutIndex = items.findIndex((t) => t.project === project && t.cut);
      if (project && cutIndex < 0) continue;
      expect(cutIndex, 'a cut title, preview or label').toBeGreaterThanOrEqual(0);
      await page.locator('.ib-lbody :is(.ib-title, .ib-pv, .ib-p)').nth(cutIndex).hover();
      await expect(page.locator('[data-pn-tooltip]').getByText(items[cutIndex]!.text!, { exact: true })).toBeVisible();
      await page.mouse.move(1, 1);
    }
    await page.goto(`${world.url}/#project=${world.ids.long}&thread=${world.seed.threads.multiDay}`);
    await page.waitForSelector('section.ib-pane');
    expect((await page.locator('.ib-lhead').boundingBox())!.height).toBe(60);
    await expect(page.locator('section.ib-pane :is(.ib-tm, .ib-fl-tm)').first()).toContainText(/[A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} [AP]M/);
  } finally {
    await context.close();
  }
});

test('things that grow: the reply chooser with 50 sessions, the compose To picker, a long draft', async ({ browser }) => {
  await new Promise((r) => setTimeout(r, Math.max(0, world.startedAt + INBOX_ASKER_RESTART_GRACE_MS + 10_000 - Date.now())));
  for (const [w, thread] of [
    [WIDTHS[2]!, world.seed.threads.ended],
    [WIDTHS[6]!, world.seed.threads.ended2],
  ] as const) {
    const { context, page } = await open(browser, w, `thread=${thread}`);
    try {
      await page.waitForSelector('section.ib-pane');
      await page.locator('.ib-pfoot .ib-btn', { hasText: 'Reply' }).first().click();
      await page.locator('.ib-rtext').fill('Wait for Monday.');
      await page.locator('.ib-pfoot .ib-btn.ib-pri', { hasText: 'Send' }).click();
      await page.waitForSelector('[data-recipient-list]');
      await page.waitForTimeout(300);
      if (w.width < 768) await expect(page.locator('[data-recipient-list]')).toHaveAttribute('role', 'dialog');
      const list = (await page.locator('[data-recipient-list]').boundingBox())!;
      expect(list.y).toBeGreaterThanOrEqual(0);
      expect(list.y + list.height, 'the list ends inside the window').toBeLessThanOrEqual(w.height);
      expect(await page.locator('[data-recipient-list]').evaluate((el) => [el, ...el.querySelectorAll('[role="listbox"]')].some((box) => box.scrollHeight > box.clientHeight))).toBe(true);
      const send = (await page.locator('.ib-pfoot .ib-btn.ib-pri', { hasText: 'Send' }).boundingBox())!;
      expect(send.y + send.height).toBeLessThanOrEqual(w.height);
      expect(await shapes(page)).toEqual([]);
      await shot(page, `chooser-${w.name}`);
    } finally {
      await context.close();
    }
  }
  const { context, page } = await open(browser, WIDTHS[2]!, `thread=${world.seed.threads.kitchen}`);
  try {
    await page.locator('.ib-side [data-open-compose]').click();
    const dialog = page.locator('dialog[data-compose]');
    const to = dialog.locator('.ib-cp-tobtn');
    await expect(to).not.toHaveAttribute('data-loading', '', { timeout: 20_000 });
    await to.click();
    const picker = dialog.locator('[data-compose-picker]');
    await expect(picker).toBeVisible();
    await expect.poll(() => dialog.locator('[role="listbox"] [role="option"]').count(), { timeout: 20_000 }).toBeGreaterThanOrEqual(50);
    const box = (await picker.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(WIDTHS[2]!.height);
    expect(await shapes(page)).toEqual([]);
    await shot(page, 'compose-to-picker-1024');
  } finally {
    await context.close();
  }
});

test('a long file name never widens the window: stepping to it, the header (rows 49, 74)', async ({ browser }) => {
  const { context, page } = await open(browser, WIDTHS[0]!, `thread=${world.seed.threads.files}`);
  try {
    await page.locator(`section.ib-pane .ib-atts.ib-tiles [data-attachment-name="${world.seed.files.arabic}"]`).first().click();
    await page.waitForSelector('section.ib-view', { timeout: 20_000 });
    await page.getByRole('button', { name: /Global comment/ }).first().click();
    const box = page.getByPlaceholder(/comment/i).last();
    await box.waitFor({ timeout: 10_000 });
    await box.fill('Not saved yet.');
    await page.locator('[data-step-next]').click();
    await expect(page.locator('section.ib-view .ib-fname', { hasText: world.seed.files.long }).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-step-guard]')).toHaveCount(0);
    expect(await shapes(page)).toEqual([]);
    await shot(page, 'long-name-step-1440');
  } finally {
    await context.close();
  }
});

test('message HTML keeps its own alignment; an Arabic paragraph reads right to left and an English one left to right (row 14)', async ({ browser }) => {
  const { context, page } = await open(browser, WIDTHS[0]!, `thread=${world.seed.threads.centered}`);
  try {
    await page.waitForSelector('section.ib-pane .ib-body p');
    const placement = (match: string) =>
      page.locator('section.ib-pane .ib-body p', { hasText: match }).first().evaluate((p) => {
        const range = document.createRange();
        range.selectNodeContents(p);
        const text = range.getBoundingClientRect();
        const box = p.getBoundingClientRect();
        const style = getComputedStyle(p);
        return { left: text.left - box.left - parseFloat(style.paddingLeft), right: box.right - parseFloat(style.paddingRight) - text.right, align: style.textAlign };
      });
    for (const match of ['Centered by its own attribute.', 'Centered by its parent.']) {
      const at = await placement(match);
      expect(at.align, match).toMatch(/center/);
      expect(Math.abs(at.left - at.right), match).toBeLessThan(4);
      expect(at.left, match).toBeGreaterThan(100);
    }
    await shot(page, 'centered-1440');
    await page.goto(`${world.url}/#thread=${world.seed.threads.arabic}`);
    await page.waitForSelector('section.ib-pane .ib-body p');
    await page.waitForTimeout(300);
    const arabic = await placement('تمت مراجعة');
    expect(arabic.right, 'the Arabic paragraph starts at the right').toBeLessThan(2);
    expect(arabic.left).toBeGreaterThan(20);
    const english = await placement('The duplicates are in');
    expect(english.left, 'the English paragraph starts at the left').toBeLessThan(2);
    expect(english.right).toBeGreaterThan(20);
  } finally {
    await context.close();
  }
});

test('a file name cut in two copies whole, and reads whole to a screen reader (row 16)', async ({ browser }) => {
  const { context, page } = await open(browser, WIDTHS[2]!, `thread=${world.seed.threads.files}`);
  try {
    const name = world.seed.files.b;
    const tile = page.locator(`section.ib-pane .ib-atts.ib-tiles [data-attachment-name="${name}"]`).first();
    await expect(tile).toBeVisible();
    const copied = await tile.locator('.ib-fname').evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = document.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      const data = new DataTransfer();
      document.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }));
      return { selected: selection.toString(), copied: data.getData('text/plain') };
    });
    expect(copied.selected, 'the two parts are apart in the selection').toContain('\n');
    expect(copied.copied).toBe(name);
    expect(await tile.locator('.ib-fname').textContent()).toBe(name);
  } finally {
    await context.close();
  }
});

async function openFile(page: Page, thread: string, name: string): Promise<void> {
  const model = (await (await fetch(`${world.url}/api/inbox/threads/${thread}/attachments`)).json()) as { attachments: { id: string; name: string }[] };
  const id = model.attachments.find((a) => a.name === name)?.id;
  expect(id, `${name} is attached in ${thread}`).toBeTruthy();
  await page.goto(`${world.url}/#thread=${thread}&file=${id}`);
  await page.waitForSelector(`section.ib-view[data-attachment-pane="${id}"]`, { timeout: 20_000 });
  await page.waitForTimeout(500);
}

for (const width of [944, 1024, 1180, 1280]) {
  test(`${width}: a file beside the thread keeps a readable column; the comments fold into a button below 1280 (rows 45 to 47, 50)`, async ({ browser }) => {
    const { context, page } = await open(browser, { name: String(width), width, height: 800 });
    try {
      await openFile(page, world.seed.threads.kinds, world.seed.kinds.yaml);
      await page.waitForSelector('section.ib-view [data-code-view]');
      expect(await shapes(page)).toEqual([]);
      const view = page.locator('section.ib-view');
      const folded = width < 1280;
      await expect(view).toHaveClass(folded ? /\bib-fold\b/ : /^(?!.*\bib-fold\b)/);
      const pane = (await view.boundingBox())!;
      const doc = (await view.locator('.ib-docarea').boundingBox())!;
      if (folded) {
        expect(doc.width).toBeGreaterThan(pane.width - 4);
        await expect(view.locator('.ib-apanel')).toBeHidden();
        const button = view.locator('[data-annotations-sheet]');
        await expect(button).toHaveAttribute('aria-label', /^Comments, \d+$/);
        await button.click();
        await expect(view.locator('.ib-apanel')).toBeVisible();
        await expect(view.locator('.ib-apanel')).toHaveAttribute('id', (await button.getAttribute('aria-controls'))!);
        expect((await view.locator('.ib-apanel').boundingBox())!.width).toBeLessThanOrEqual(301);
        await shot(page, `fold-${width}-sheet`);
        await view.getByRole('button', { name: 'Close the comments' }).click();
        await expect(view.locator('.ib-apanel')).toBeHidden();
        await expect(button).toBeFocused();
        await button.click();
        await view.getByRole('button', { name: 'Close the comments' }).focus();
        await page.keyboard.press('Escape');
        await expect(view.locator('.ib-apanel')).toBeHidden();
        await expect(button).toBeFocused();
        await expect(view).toBeVisible();
      } else {
        await expect(view.locator('[data-annotations-sheet]')).toHaveCount(0);
        await expect(view.locator('.ib-apanel')).toBeVisible();
      }
      expect(doc.width, 'the file keeps a readable column').toBeGreaterThanOrEqual(480);
      await shot(page, `fold-${width}-yaml`);

      await openFile(page, world.seed.threads.files, world.seed.files.changed);
      await page.waitForSelector('section.ib-view .ib-toolstrip');
      const strip = (await page.locator('section.ib-view .ib-toolstrip').boundingBox())!;
      const actions = (await page.locator('section.ib-view [data-sticky-actions]').first().boundingBox())!;
      const overlaps = strip.x < actions.x + actions.width && actions.x < strip.x + strip.width && strip.y < actions.y + actions.height && actions.y < strip.y + strip.height;
      expect(overlaps, 'Global comment clears the toolstrip').toBe(false);

      await openFile(page, world.seed.threads.kinds, world.seed.kinds.pdf);
      await page.waitForSelector('section.ib-view [data-download-card]');
      await expect(page.locator('section.ib-view .ib-apanel')).toBeHidden();
      expect((await page.locator('section.ib-view [data-download-card] .ib-att-text').boundingBox())!.width).toBeGreaterThan(200);
      await shot(page, `fold-${width}-pdf`);

      await page.locator('section.ib-view').getByRole('button', { name: 'Full screen' }).click();
      await page.waitForTimeout(300);
      expect(await shapes(page)).toEqual([]);
      await expect(page.locator('section.ib-view [data-full-view-comments]')).toHaveCount(0);
      const toolbar = (await page.locator('section.ib-view [data-full-view-bar]').boundingBox())!;
      expect(toolbar.x).toBeGreaterThanOrEqual(0);
      expect(toolbar.x + toolbar.width).toBeLessThanOrEqual(width + 1);
      await shot(page, `fold-${width}-full`);
    } finally {
      await context.close();
    }
  });
}

test('a guided review at 1024 and 900 keeps its diffs readable, with its comments a button away (row 48)', async ({ browser }) => {
  for (const width of [900, 1024, 1440, 1600]) {
    const { context, page } = await open(browser, { name: String(width), width, height: 800 }, `thread=${world.seed.threads.guide}&guide=${world.seed.threads.guide}`);
    try {
      await expect(page.locator('section.ib-viewer .ib-gbody')).toContainText('Guard the refresh entry point', { timeout: 20_000 });
      await page.waitForTimeout(500);
      const viewer = page.locator('section.ib-viewer');
      if (width < 1500) {
        await expect(viewer).toHaveClass(/\bib-fold\b/);
        expect((await viewer.locator('.ib-gbody').boundingBox())!.width).toBeGreaterThan(width - 40);
        const button = viewer.locator('[data-guide-comments-sheet]');
        await button.click();
        await expect(viewer.locator('.ib-gpanel')).toBeVisible();
        await expect(viewer.locator('.ib-gpanel')).toHaveAttribute('id', (await button.getAttribute('aria-controls'))!);
        await shot(page, `guide-${width}-sheet`);
        await viewer.getByRole('button', { name: 'Close the comments' }).click();
        await expect(viewer.locator('.ib-gpanel')).toBeHidden();
        await expect(button).toBeFocused();
        await button.click();
        await viewer.getByRole('button', { name: 'Close the comments' }).focus();
        await page.keyboard.press('Escape');
        await expect(viewer.locator('.ib-gpanel')).toBeHidden();
        await expect(button).toBeFocused();
        await expect(viewer).toBeVisible();
      } else {
        await expect(viewer).not.toHaveClass(/\bib-fold\b/);
        const button = viewer.locator('[data-guide-comments-sheet]');
        const panel = viewer.locator('.ib-gpanel');
        const count = Number(await panel.getAttribute('data-guide-comments'));
        await expect(button).toHaveAttribute('aria-expanded', count > 0 ? 'true' : 'false');
        if (count === 0) {
          await expect(panel).toBeHidden();
          expect((await viewer.locator('.ib-gbody').boundingBox())!.width).toBeGreaterThan(width - 40);
          await button.click();
        }
        await expect(panel).toBeVisible();
        await shot(page, `guide-${width}-docked`);
        await viewer.getByRole('button', { name: 'Close the comments' }).click();
        await expect(panel).toBeHidden();
        await expect(button).toBeFocused();
        await expect(button).toHaveAttribute('aria-expanded', 'false');
      }
      await shot(page, `guide-${width}`);
    } finally {
      await context.close();
    }
  }
});

test('a panorama keeps a readable height, a 1×1 image stays one pixel, a minified file wraps (rows 51, 52, 59)', async ({ browser }) => {
  const { context, page } = await open(browser, WIDTHS[0]!, `thread=${world.seed.threads.kinds}`);
  try {
    await page.waitForSelector('section.ib-pane [data-image-gallery]');
    await page.waitForTimeout(800);
    const frame = page.locator(`section.ib-pane [data-gallery-image] .ib-gal-frame.ib-wide`).first();
    expect((await frame.boundingBox())!.height, 'a panorama is not a sliver').toBeGreaterThanOrEqual(120);
    const dot = await page.locator(`section.ib-pane [data-gallery-image][data-attachment-name="${world.seed.kinds.dot}"] img`).first().evaluate((img: HTMLImageElement) => {
      const r = img.getBoundingClientRect();
      return { fit: getComputedStyle(img).objectFit, natural: img.naturalWidth, box: r.width };
    });
    expect(dot.fit).toBe('scale-down');
    expect(dot.natural).toBe(1);
    await shot(page, 'images-1440');
    await page.locator(`section.ib-pane [data-gallery-image][data-attachment-name="${world.seed.kinds.pano}"]`).first().click();
    await page.waitForSelector('section.ib-view .ib-imgstage[data-wide="true"] img');
    await page.waitForTimeout(500);
    const stage = await page.locator('section.ib-view .ib-imgstage').evaluate((el) => {
      const r = el.querySelector('img')!.getBoundingClientRect();
      return { scrolls: r.width > el.clientWidth, height: r.height };
    });
    expect(stage.scrolls).toBe(true);
    expect(stage.height).toBeGreaterThanOrEqual(120);
    await shot(page, 'pano-viewer-1440');
    await openFile(page, world.seed.threads.kinds, world.seed.kinds.minified);
    await page.waitForSelector('section.ib-view [data-code-view] diffs-container');
    await page.waitForTimeout(1000);
    const wraps = await page.locator('section.ib-view [data-code-view] diffs-container').evaluate((host) => {
      const root = (host as HTMLElement).shadowRoot ?? host;
      return root.querySelector('[data-overflow]')?.getAttribute('data-overflow') ?? 'none';
    });
    expect(wraps).toBe('wrap');
    await shot(page, 'minified-1440');
  } finally {
    await context.close();
  }
});

test('a phone opens a PDF with no Comments button (row 61)', async ({ browser }) => {
  const { context, page } = await open(browser, WIDTHS[4]!, `thread=${world.seed.threads.kinds}`);
  try {
    await openFile(page, world.seed.threads.kinds, world.seed.kinds.pdf);
    await page.waitForSelector('section.ib-view [data-download-card]');
    await expect(page.locator('section.ib-view [data-full-view-bar]')).toBeVisible();
    await expect(page.locator('section.ib-view [data-full-view-comments]')).toHaveCount(0);
    await shot(page, 'phone-pdf');
  } finally {
    await context.close();
  }
});
