/**
 * Two phone bugs the owner reported (an iPhone, dark), proved against the
 * compiled binary on an iPhone 15 (WebKit) and a Pixel 7 (Chromium):
 *
 * 1. The question card's footer: Hide note, Skip and Accept recommended were
 *    squeezed until their words broke mid-word ("Acce pt reco mme nded")
 *    while "Picked 8:48 AM · in your draft" kept its room. Now no button
 *    shrinks or breaks a word, and the status takes its own line above the
 *    buttons when the row cannot hold both. And the radios: WebKit's native
 *    dark-scheme radio was a solid black disc, picked or not; picked now
 *    reads clearly different from unpicked, light and dark.
 * 2. Images on a phone: iOS offers no Paste for an image-only clipboard in a
 *    plain text field (WebKit's canPerformAction:paste: accepts only text and
 *    URL types outside rich editing), so the reply box and compose get an
 *    attach button on a phone; and an image copied from a page (it carries its
 *    URL as the plain text) now attaches when pasted.
 *
 * Build the binary first (see inbox.spec.ts). PNGs land in
 * .local/proof/mobile-fixes/ (and MOBILE_FIXES_SHOTS when set), named with
 * MOBILE_FIXES_SHOT_PREFIX (default `after`).
 */

import { chromium, devices, expect, test, webkit, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { INBOX_BRIDGE_POLL_PATH } from '../../packages/shared/inbox/connection';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'mobile-fixes');
const extraShots = process.env.MOBILE_FIXES_SHOTS ? resolve(process.env.MOBILE_FIXES_SHOTS) : null;
const prefix = process.env.MOBILE_FIXES_SHOT_PREFIX ?? 'after';
/** A `before` run (against the old binary, for the pictures) records the failures and goes on to the next picture. */
const check = prefix === 'before' ? expect.soft : expect;
const PASTED = /^pasted-image-\d{4}-\d\d-\d\d-\d{4}(-\d+)?\.png$/;

const QUESTIONS = [
  'Two things on the board header copy.',
  '',
  ':::question',
  'The lede runs two lines on a phone because of the “You:” line. Keep that, or shorter?',
  '',
  '- [ ] Shorter: “Work in flight, by stage. Agents keep their cards current.”',
  '- [ ] Keep it',
  'Recommended: Shorter',
  ':::',
  '',
  ':::question-multi',
  'Which columns should start folded?',
  '',
  '- [ ] Icebox',
  '- [ ] Dropped',
  '- [ ] Shipped',
  'Recommended: Icebox, Dropped',
  ':::',
].join('\n');

// A 2×2 PNG: a real picture for the upload path.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDK+mmyAAAAABJRU5ErkJggg==',
  'base64',
);

interface World {
  root: string;
  dataDir: string;
  url: string;
  project: string;
  agent: SimAgent;
  stopPoll: () => Promise<void>;
}

let world: World;

function registry(dataDir: string): { port: number; token: string } {
  return JSON.parse(readFileSync(join(dataDir, 'inbox', 'inbox.json'), 'utf8'));
}

/** A connection's long-poll: the session stays live, so compose can address it. */
function keepLive(dataDir: string, session: string, host: string, project: string): () => Promise<void> {
  let stopped = false;
  const startedAt = Date.now() - 20 * 60_000;
  const loop = (async () => {
    while (!stopped) {
      const { port, token } = registry(dataDir);
      await fetch(`http://127.0.0.1:${port}${INBOX_BRIDGE_POLL_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ session, host, waitMs: 1_000, project_path: project, started_at: startedAt, busy: false, idle_since: startedAt }),
      }).catch(() => null);
    }
  })();
  return async () => {
    stopped = true;
    await loop;
  };
}

async function shot(page: Page, name: string): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    // The theme's colour transition settles before the picture.
    await page.waitForTimeout(1_500);
    const file = join(proofDir, `${prefix}-${name}-${scheme}.png`);
    await page.screenshot({ path: file });
    if (extraShots) copyFileSync(file, join(extraShots, `${prefix}-${name}-${scheme}.png`));
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

test.describe.configure({ mode: prefix === 'before' ? 'default' : 'serial' });

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  mkdirSync(proofDir, { recursive: true });
  if (extraShots) mkdirSync(extraShots, { recursive: true });
  const root = inboxScratch('plannotator-inbox-mobile-fixes-e2e-');
  const dataDir = join(root, 'data');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const project = scratchProject(join(root, 'src'), 'board');
  const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const stopPoll = keepLive(dataDir, 'ses-pi', 'pi', project);
  world = { root, dataDir, url, project, agent, stopPoll };
});

test.afterAll(async () => {
  try {
    if (!world) return;
    await world.stopPoll();
    await world.agent.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

/**
 * Each footer button's words on one line, inside the button, and the
 * footer's parts inside the card. Returns the problems found.
 */
async function footerProblems(page: Page, minTarget = 44): Promise<string[]> {
  return page.evaluate((minTarget) => {
    const out: string[] = [];
    for (const card of document.querySelectorAll<HTMLElement>('section.ib-pane fieldset[data-question-key]')) {
      const foot = card.querySelector<HTMLElement>(':scope > div.border-t');
      if (!foot) continue;
      const cardBox = card.getBoundingClientRect();
      for (const button of foot.querySelectorAll<HTMLButtonElement>('button')) {
        const range = document.createRange();
        range.selectNodeContents(button);
        const tops = new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)));
        const name = button.textContent?.trim() ?? '';
        if (tops.size > 1) out.push(`"${name}" wraps onto ${tops.size} lines`);
        if (button.scrollWidth > button.clientWidth + 1) out.push(`"${name}" overflows its button`);
        const box = button.getBoundingClientRect();
        if (box.right > cardBox.right + 1 || box.left < cardBox.left - 1) out.push(`"${name}" sits outside the card`);
        if (box.height < minTarget - 0.5) out.push(`"${name}" is ${box.height}px tall, under ${minTarget}`);
      }
      const status = foot.querySelector<HTMLElement>('.ib-qfoot-st');
      if (status) {
        const s = status.getBoundingClientRect();
        if (s.right > cardBox.right + 1) out.push(`the status runs past the card (${Math.round(s.right)} > ${Math.round(cardBox.right)})`);
        // Never between the buttons: on the buttons' line (after them), or wholly above them.
        const buttons = [...foot.querySelectorAll('button')].map((b) => b.getBoundingClientRect());
        const top = Math.min(...buttons.map((b) => b.top));
        const sameLine = buttons.some((b) => s.top < b.bottom && s.bottom > b.top);
        if (sameLine) {
          if (buttons.some((b) => b.left > s.left)) out.push('the status sits between the buttons');
        } else if (s.bottom > top + 1) out.push('the status sits below the buttons');
      }
    }
    return out;
  }, minTarget);
}

/** The radio dot's painted look: what tells picked from unpicked. */
async function radioLooks(page: Page): Promise<{ checked: string; unchecked: string; checkedDot: string; uncheckedDot: string; uncheckedFill: string }> {
  return page.evaluate(() => {
    const card = document.querySelector('section.ib-pane fieldset[data-question-key]')!;
    const radios = [...card.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    const on = radios.find((r) => r.checked)!;
    const off = radios.find((r) => !r.checked)!;
    const look = (el: HTMLInputElement) => {
      const s = getComputedStyle(el);
      return `${s.appearance}|${s.borderTopColor}|${s.backgroundColor}|${s.boxShadow}`;
    };
    const dot = (el: HTMLInputElement) => getComputedStyle(el, '::before').transform;
    return { checked: look(on), unchecked: look(off), checkedDot: dot(on), uncheckedDot: dot(off), uncheckedFill: getComputedStyle(off).backgroundColor };
  });
}

const PHONES = [
  { name: 'iPhone 15 (WebKit)', device: devices['iPhone 15'], engine: 'webkit' as const, tag: 'iphone' },
  { name: 'Pixel 7 (Chromium)', device: devices['Pixel 7'], engine: 'chromium' as const, tag: 'pixel' },
];

for (const phone of PHONES) {
  test.describe(phone.name, () => {
    let browser: Browser;
    let context: BrowserContext;
    let page: Page;
    let threadId: string;
    const errors: string[] = [];

    test.beforeAll(async () => {
      // Each phone answers its own thread.
      const sent = await world.agent.send({ project_path: world.project, subject: `Board header copy (${phone.tag})`, body: QUESTIONS });
      threadId = sent.thread_id as string;
      browser = phone.engine === 'webkit' ? await webkit.launch({ args: [] }) : await chromium.launch();
      context = await browser.newContext({ ...phone.device, colorScheme: 'dark' });
      page = await context.newPage();
      // WebKit reports the window's own reads cut off by a navigation (page.goto) as "… due to access control
      // checks": not an error of the page.
      page.on('pageerror', (error) => {
        if (!/due to access control checks/.test(error.message)) errors.push(error.message);
      });
    });

    test.afterAll(async () => {
      await context?.close();
      await browser?.close();
    });

    test('the question card footer: whole words in every button, the status above them, 44 px targets', async () => {
      await page.goto(`${world.url}#thread=${threadId}`);
      const pane = page.locator('section.ib-pane');
      const cards = pane.locator('fieldset[data-question-key]');
      await expect(cards).toHaveCount(2);
      // The first card: a note only, as in the owner's picture (Accept recommended stays offered).
      const first = cards.nth(0);
      await first.getByRole('button', { name: 'Add note' }).click();
      await first.locator('textarea').last().fill('For backlog items I’d like a way to tell the agent to start.');
      await expect(first.locator('.ib-qfoot-st')).toContainText('in your draft');
      // The second card (pick any): one recommended box ticked plus a note; Accept stays offered.
      const second = cards.nth(1);
      await second.locator('label[data-question-option]').first().click();
      await second.getByRole('button', { name: 'Add note' }).click();
      await second.locator('textarea').last().fill('Shipped too, after a week.');
      await expect(second.locator('.ib-qfoot-st')).toContainText('in your draft');
      await expect(second.getByRole('button', { name: 'Accept recommended' })).toBeVisible();
      await first.scrollIntoViewIfNeeded();
      await shot(page, `${phone.tag}-card-footer-390`);
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        await page.waitForTimeout(150);
        check(await footerProblems(page), `at ${width} px`).toEqual([]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      }
      await first.scrollIntoViewIfNeeded();
      await shot(page, `${phone.tag}-card-footer-320`);
      await page.setViewportSize(phone.device.viewport);
    });

    test('the radios: picked reads clearly different from unpicked, light and dark', async () => {
      if (!page.url().includes('#thread=')) await page.goto(`${world.url}#thread=${threadId}`);
      const pane = page.locator('section.ib-pane');
      const first = pane.locator('fieldset[data-question-key]').first();
      await first.locator('label[data-question-option]').nth(1).click();
      await expect(first.locator('input[type="radio"]').nth(1)).toBeChecked();
      await first.scrollIntoViewIfNeeded();
      await shot(page, `${phone.tag}-radios`);
      for (const scheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        const looks = await radioLooks(page);
        // On a touch screen, drawn by the page, not the platform: the same in WebKit and Chromium.
        check(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
        check(looks.unchecked.startsWith('none|')).toBe(true);
        check(looks.checked).not.toBe(looks.unchecked);
        // The picked radio carries the dot (its ::before at full size); the unpicked one is a hollow ring.
        check(looks.uncheckedDot).toMatch(/^matrix\(0, 0, 0, 0,/);
        check(looks.checkedDot).not.toBe(looks.uncheckedDot);
        check(looks.uncheckedFill).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
      }
      await page.emulateMedia({ colorScheme: 'dark' });
    });

    test('the reply box: an attach button on a phone, a picked image uploads and rides the Send', async () => {
      const pane = page.locator('section.ib-pane');
      await pane.locator('.ib-pfoot').getByRole('button', { name: /^(Reply|Edit draft)$/ }).first().click();
      const box = pane.locator('.ib-rbox');
      await box.getByRole('textbox').fill(`From the ${phone.tag}: the header on my phone.`);
      const attach = pane.locator('[data-reply-attach]');
      await expect(attach).toHaveCount(1);
      const target = await pane.locator('.ib-rattach').boundingBox();
      expect(target!.width).toBeGreaterThanOrEqual(44);
      expect(target!.height).toBeGreaterThanOrEqual(44);
      // What the photo library hands over: a file named image.png (iOS) with no name a person chose.
      await attach.setInputFiles({ name: 'image.png', mimeType: 'image/png', buffer: PNG });
      await expect(box.locator('[data-compose-file="done"]')).toHaveCount(1);
      const name = (await box.locator('[data-compose-file]').getAttribute('data-compose-file-name'))!;
      expect(name).toMatch(PASTED);
      // A paste on the reply box: an image.png beside `text` and `html`. Returns whether the browser's own paste was prevented.
      await box.getByRole('textbox').focus();
      const pasteWith = (text: string, html: string) =>
        page.evaluate(
          ({ b64, text, html }) => {
            const data = new DataTransfer();
            data.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'image.png', { type: 'image/png' }));
            data.setData('text/plain', text);
            data.setData('text/html', html);
            const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
            document.activeElement!.dispatchEvent(event);
            return event.defaultPrevented;
          },
          { b64: PNG.toString('base64'), text, html },
        );
      const link = 'https://example.com/board/header.png';
      // A spreadsheet cell whose value is a URL (its text, an HTML table, a picture of the cell): text, nothing attaches.
      expect(await pasteWith(link, `<table><tr><td>${link}</td></tr></table>`)).toBe(false);
      await page.waitForTimeout(300);
      await expect(box.locator('[data-compose-file]')).toHaveCount(1);
      // An image copied from a page on a phone: its link as the text and an <img> of that link. It attaches.
      expect(await pasteWith(link, `<meta charset="utf-8"><img src="${link}">`)).toBe(true);
      await expect(box.locator('[data-compose-file="done"]')).toHaveCount(2);
      // The URL never lands in the words.
      await expect(box.getByRole('textbox')).not.toHaveValue(/example\.com/);
      await shot(page, `${phone.tag}-reply-attached`);
      const names = await box.locator('[data-compose-file]').evaluateAll((els) => els.map((el) => el.getAttribute('data-compose-file-name')!));
      await pane.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(box).toHaveCount(0);
      const answer = await world.agent.waitForReply(threadId, 10);
      const body = (answer.reply as { body: string }).body;
      for (const n of names) expect(body).toContain(`Attached: ${n} (`);
      expect(errors).toEqual([]);
    });

    test('compose on a phone: the attach button takes a picked image that rides the Send', async () => {
      await page.goto(world.url);
      await page.locator('[data-open-compose]').filter({ visible: true }).first().click();
      const dialog = page.locator('dialog[data-compose]');
      const to = dialog.locator('.ib-cp-tobtn');
      await expect(to).not.toHaveAttribute('data-loading', /.*/, { timeout: 15_000 });
      await to.click();
      await page.locator('[data-compose-session="ses-pi"]').click();
      await dialog.getByRole('textbox', { name: 'Message' }).fill(`Compose from the ${phone.tag}.`);
      const clip = await dialog.locator('.ib-cp-clip').boundingBox();
      expect(clip!.width).toBeGreaterThanOrEqual(44);
      await dialog.locator('[data-compose-attach]').setInputFiles({ name: 'image.png', mimeType: 'image/png', buffer: PNG });
      const tile = dialog.locator('[data-compose-file="done"]');
      await expect(tile).toHaveCount(1);
      const name = (await tile.getAttribute('data-compose-file-name'))!;
      expect(name).toMatch(PASTED);
      await shot(page, `${phone.tag}-compose-attached`);
      await dialog.locator('[data-compose-phone-send], [data-compose-send]').filter({ visible: true }).first().click();
      await expect(dialog).toHaveCount(0);
      expect(errors).toEqual([]);
    });
  });
}

test.describe('a desktop, the thread beside a file (Chromium)', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let threadId: string;

  test.beforeAll(async () => {
    writeFileSync(join(world.project, 'board-notes.md'), '# Board notes\n\nThe header copy, the columns.\n');
    const sent = await world.agent.send({ project_path: world.project, subject: 'Board header copy (desktop)', body: QUESTIONS, attachments: ['board-notes.md'] });
    threadId = sent.thread_id as string;
    browser = await chromium.launch();
    context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
    page = await context.newPage();
  });

  test.afterAll(async () => {
    await context?.close();
    await browser?.close();
  });

  test('the card footer in a ~440 px thread: whole words in every button, the status above them; the system radios stay', async () => {
    await page.goto(`${world.url}#thread=${threadId}`);
    const pane = page.locator('section.ib-pane');
    const cards = pane.locator('fieldset[data-question-key]');
    await expect(cards).toHaveCount(2);
    const first = cards.nth(0);
    await first.getByRole('button', { name: 'Add note' }).click();
    await first.locator('textarea').last().fill('For backlog items I’d like a way to tell the agent to start.');
    await expect(first.locator('.ib-qfoot-st')).toContainText('in your draft');
    const second = cards.nth(1);
    await second.locator('label[data-question-option]').first().click();
    await second.getByRole('button', { name: 'Add note' }).click();
    await second.locator('textarea').last().fill('Shipped too, after a week.');
    await expect(second.locator('.ib-qfoot-st')).toContainText('in your draft');
    // Open the attached file beside the thread: the thread narrows to its column.
    await pane.getByRole('button', { name: 'Open board-notes.md' }).first().click();
    await expect(page.locator('.ib-pane.ib-withfile')).toBeVisible();
    const width = (await pane.locator('fieldset[data-question-key]').first().boundingBox())!.width;
    expect(width).toBeLessThan(470);
    check(await footerProblems(page, 0), `the card at ${Math.round(width)} px`).toEqual([]);
    // The status no longer fits beside the buttons, so it sits above them.
    const status = (await first.locator('.ib-qfoot-st').boundingBox())!;
    const accept = (await first.getByRole('button', { name: 'Accept recommended' }).boundingBox())!;
    check(status.y + status.height).toBeLessThanOrEqual(accept.y + 1);
    // A mouse and a trackpad keep the system's radios and checkboxes, as before.
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(false);
    const appearance = await first.locator('input[type="radio"]').first().evaluate((el) => getComputedStyle(el).appearance);
    expect(appearance).not.toBe('none');
    await first.scrollIntoViewIfNeeded();
    await shot(page, 'desktop-beside-file-card-footer');
  });

  test('a 700 px desktop window: the footer keeps one row when it fits, as before; the system radios stay', async () => {
    await page.setViewportSize({ width: 700, height: 900 });
    await page.goto(`${world.url}#thread=${threadId}`);
    const first = page.locator('section.ib-pane fieldset[data-question-key]').first();
    await expect(first).toBeVisible();
    // Run alone, the note the test above wrote is not there yet: write it.
    if ((await first.locator('.ib-qfoot-st').count()) === 0) {
      await first.getByRole('button', { name: 'Add note' }).click();
      await first.locator('textarea').last().fill('For backlog items I’d like a way to tell the agent to start.');
    }
    await expect(first.locator('.ib-qfoot-st')).toContainText('in your draft');
    await first.scrollIntoViewIfNeeded();
    expect(await footerProblems(page, 0)).toEqual([]);
    // One row: the status on the buttons' line, after the last of them (no phone reordering on a mouse).
    const row = await first.evaluate((card) => {
      const foot = card.querySelector(':scope > div.border-t')!;
      const status = foot.querySelector('.ib-qfoot-st')!.getBoundingClientRect();
      const buttons = [...foot.querySelectorAll('button')].map((b) => b.getBoundingClientRect());
      return {
        sameLine: buttons.every((b) => status.top < b.bottom && status.bottom > b.top),
        after: buttons.every((b) => status.left >= b.right - 0.5),
      };
    });
    expect(row).toEqual({ sameLine: true, after: true });
    const appearance = await first.locator('input[type="radio"]').first().evaluate((el) => getComputedStyle(el).appearance);
    expect(appearance).not.toBe('none');
    await shot(page, 'desktop-700-card-footer');
  });
});
