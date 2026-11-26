/**
 * A skill the person's sent reply used opens as its file beside the thread (the owner: "after calling a skill can i
 * click on its either inline link looking thing or the package name... and for it to open as a file"), proved in a
 * real browser against the compiled binary. Nothing is mocked: `plannotator inbox --background` under a temp data
 * dir and a scratch HOME holding one global skill, an agent connected through `plannotator inbox mcp`.
 *
 * Proves, on a computer (1440×900) and a phone (390×844): the sent reply shows its chips in the words and the skills
 * line; the chip opens the built-in skill's SKILL.md beside the thread (read only, "Plannotator skill"), Escape
 * gives focus back to the chip; the name on the skills line opens the person's own skill ("Your skill"), Close gives
 * focus back to the name; a skill moved out of the skill folders since says "is not on this computer."; on a phone
 * the name, and a tap on the chip in the words, open the file over the thread and Back returns to it; a scroll that
 * starts on the chip opens nothing. The chip's words still select (the message takes comments): a drag across the
 * chip offers the comment toolbar and opens nothing, and a double-click selects the chip's words and leaves no file
 * open, nor an entry the browser's Back would open it from. The chips' layer paints under a layer at the window's z 50 (the sidebar
 * sheet's, the peek's and the tips' level).
 *
 * Whole-window shots, light and dark, land in .local/proof/view-skill/ (PLANNOTATOR_E2E_PROOF_DIR).
 * CI runs it; build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-view-skill.spec.ts`.
 */

import { expect, test, type Browser, type Locator, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'view-skill');

interface World {
  url: string;
  root: string;
  project: string;
  agent: SimAgent;
}

let world: World;
let threadId = '';

async function shot(page: Page, name: string): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(proofDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
}

/** The middle of `el`'s box: the pointer goes through a chip's button to the words, so presses land by place. */
async function middleOf(el: Locator): Promise<{ x: number; y: number; left: number; right: number }> {
  await el.scrollIntoViewIfNeeded();
  const box = (await el.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, left: box.x + 2, right: box.x + box.width - 2 };
}

/** The words the comment tools hold: the selection, or once they take it, the pending marks they paint over it. */
const selectedText = (page: Page) =>
  page.evaluate(() => {
    const marks = [...document.querySelectorAll('[data-message-id] [data-highlight-id]')].map((mark) => mark.textContent ?? '').join('');
    return `${window.getSelection()?.toString() ?? ''}|${marks}`;
  });

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-view-skill-');
  const dataDir = join(root, 'data');
  // The catalog reads the global skill folders under HOME: only this scratch HOME's.
  const dir = join(root, '.claude', 'skills', 'readback');
  mkdirSync(join(dir, 'references'), { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    '---\nname: readback\ndescription: Read the request back before acting on it\n---\n\n# Readback\n\nBefore you change anything, say back in one sentence what Charlie Dunn asked for, then wait.\n\n## When\n\n- A request with more than one reading.\n- A change to the harbor checkout.\n',
  );
  writeFileSync(join(dir, 'references', 'examples.md'), '# Examples\n');
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    CLAUDE_CONFIG_DIR: join(root, '.claude'),
    CODEX_HOME: join(root, '.codex'),
    XDG_CONFIG_HOME: join(root, '.config'),
    PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    NO_ANON_PING: '1',
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  const project = scratchProject(join(root, 'src'), 'harbor');
  world = { url: started.stdout.trim(), root, project, agent: await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' }) };
});

test.afterAll(async () => {
  try {
    await world?.agent.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

test('a computer: the chip and the skills line each open the skill beside the thread, and focus comes back', async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const sent = await world.agent.send({ project_path: world.project, subject: 'Checkout total', body: 'The checkout total now rounds per line. Want to see how it works?' });
    threadId = String(sent.thread_id);
    await page.goto(`${world.url}#thread=${threadId}`);
    await page.locator('.ib-pfoot').getByRole('button', { name: 'Reply' }).click();
    await page.getByRole('textbox', { name: 'Reply to Claude Code' }).fill('/picture-it show me how it works, and $readback first.');
    // The reply box's chip is the words being written: painted, with no control that opens the skill.
    await expect(page.locator('[data-skill-ref-token="picture-it"]')).toHaveCount(1);
    await expect(page.locator('[data-skill-open]')).toHaveCount(0);
    await page.locator('.ib-pfoot').getByRole('button', { name: 'Send' }).click();
    const reply = await world.agent.nextReply(threadId, 40);
    expect(reply.body as string).toContain('/picture-it show me how it works');

    const line = page.locator('[data-skills-line]').last();
    await expect(line).toContainText('picture-it');
    await expect(line).toContainText('readback');
    const chip = page.locator('[data-skill-chips] [data-skill-open="picture-it"]').last();
    await expect(chip).toHaveCount(1);
    await line.scrollIntoViewIfNeeded();
    await shot(page, '1-sent-chip-and-skills-line');
    const pane = page.locator('[data-skill-file="picture-it"]');

    // The chip's words select as words do, and the message takes comments: a drag across the chip offers the
    // comment toolbar and opens nothing.
    const at = await middleOf(chip);
    await page.mouse.move(at.left, at.y);
    await page.mouse.down();
    await page.mouse.move(at.right, at.y, { steps: 6 });
    await page.mouse.up();
    await expect(page.locator('.annotation-toolbar')).toBeVisible();
    await expect.poll(() => selectedText(page)).toContain('picture');
    await page.waitForTimeout(300);
    await expect(pane).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await expect(page.locator('.annotation-toolbar')).toHaveCount(0);
    await expect.poll(() => selectedText(page)).not.toContain('picture');

    // A double-click selects the chip's words and leaves no file open (its first click's open is taken back).
    // An entry of this same thread under it first, so the browser's Back below stays on the thread.
    const threadHash = await page.evaluate(() => {
      window.history.pushState(null, '', window.location.hash);
      return window.location.hash;
    });
    await page.mouse.dblclick(at.x, at.y);
    await expect(pane).toHaveCount(0);
    await expect.poll(() => selectedText(page)).toContain('picture-it');
    await expect(page.locator('.annotation-toolbar')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(threadHash);
    // History is as it was before the double-click: the browser's Back opens no skill file.
    await page.evaluate(() => window.history.back());
    await page.waitForTimeout(500);
    await expect(pane).toHaveCount(0);
    expect(await page.evaluate(() => window.location.hash)).toBe(threadHash);

    // The chips' layer sits in the thread's own stacking level: a layer at the window's z 50 (the sidebar sheet's,
    // the peek's, a tip's) is above it. Read with the chip taking the pointer for a moment, so the hit test sees it.
    const under = await chip.evaluate((button) => {
      const box = button.getBoundingClientRect();
      const cover = document.createElement('div');
      cover.style.cssText = `position:fixed;z-index:50;left:${box.left - 4}px;top:${box.top - 4}px;width:${box.width + 8}px;height:${box.height + 8}px;`;
      document.querySelector('.pn-inbox')!.appendChild(cover);
      (button as HTMLElement).style.pointerEvents = 'auto';
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      (button as HTMLElement).style.pointerEvents = '';
      cover.remove();
      return hit === cover;
    });
    expect(under).toBe(true);

    // A click on the chip in the words: the built-in skill's text, read only, titled with its name.
    await page.mouse.click(at.x, at.y);
    await expect(pane.locator('[data-skill-doc]')).toContainText('Use HTML to help me understand');
    await expect(pane.locator('[data-header-from]')).toHaveText('Plannotator skill');
    await shot(page, '2-picture-it-open');
    await page.keyboard.press('Escape');
    await expect(pane).toHaveCount(0);
    await expect(chip).toBeFocused();

    // The name on the skills line: the person's own skill, its SKILL.md as written.
    const name = line.locator('[data-skill-open="readback"]');
    await name.click();
    const own = page.locator('[data-skill-file="readback"]');
    await expect(own.locator('[data-skill-doc]')).toContainText('say back in one sentence what Charlie Dunn asked for');
    await expect(own.locator('[data-header-from]')).toHaveText('Your skill');
    await shot(page, '3-readback-open');
    await own.getByRole('button', { name: 'Close readback' }).click();
    await expect(own).toHaveCount(0);
    await expect(name).toBeFocused();

    // Moved out of the skill folders since it was sent: the pane says so, calmly.
    renameSync(join(world.root, '.claude', 'skills', 'readback'), join(world.root, '.claude', 'readback-moved'));
    await name.click();
    await expect(own.locator('[data-ref-missing="missing"]')).toContainText('is not on this computer.');
    await shot(page, '4-no-longer-on-this-computer');
    await page.keyboard.press('Escape');
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('a phone: the name on the skills line opens the skill over the thread, and Back returns to it', async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'light' });
  const page = await context.newPage();
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${world.url}#thread=${threadId}`);
    const line = page.locator('[data-skills-line]').last();
    await expect(line).toContainText('picture-it');
    await line.scrollIntoViewIfNeeded();
    await shot(page, 'phone-1-sent');
    await line.locator('[data-skill-open="picture-it"]').tap();
    const pane = page.locator('[data-skill-file="picture-it"]');
    await expect(pane.locator('[data-skill-doc]')).toContainText('Use HTML to help me understand');
    await shot(page, 'phone-2-picture-it-open');
    await pane.locator('[data-ref-back]').tap();
    await expect(pane).toHaveCount(0);
    await expect(line).toBeVisible();
  } finally {
    await context.close();
  }
});

test('a phone: a tap on the chip in the words opens the skill over the thread; a scroll that starts on the chip opens nothing', async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'light' });
  const page = await context.newPage();
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${world.url}#thread=${threadId}`);
    const chip = page.locator('[data-skill-chips] [data-skill-open="picture-it"]').last();
    await expect(chip).toHaveCount(1);
    const pane = page.locator('[data-skill-file="picture-it"]');

    // A tap on the chip's words (its button lets the finger through to them): the file opens over the thread.
    let at = await middleOf(chip);
    await page.touchscreen.tap(at.x, at.y);
    await expect(pane.locator('[data-skill-doc]')).toContainText('Use HTML to help me understand');
    await shot(page, 'phone-3-chip-tapped');
    await pane.locator('[data-ref-back]').tap();
    await expect(pane).toHaveCount(0);
    await expect(chip).toBeVisible();

    // A finger that lands on the chip and scrolls the thread: a scroll, never an open.
    at = await middleOf(chip);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: at.x, y: at.y }] });
    for (let i = 1; i <= 8; i += 1) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: at.x, y: at.y - 25 * i }] });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(500);
    await expect(pane).toHaveCount(0);
  } finally {
    await context.close();
  }
});
