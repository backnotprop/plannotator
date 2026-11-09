/**
 * Commands in an action item, and selecting text in a card (the owner: "some
 * of the action items create like a copy block, which is perfect. But
 * sometimes agents put in raw commands I need to manually copy, and it
 * doesn't work, because something's eating the select"), proved in a real
 * browser against the compiled binary:
 *
 *  - an action item whose why carries two fenced commands draws two code
 *    blocks, each with its own copy button, in order, and a copy button puts
 *    its own command on the clipboard;
 *  - an action item written as a task list item with indented fences under
 *    it (the coordinator's report) keeps both fences with the action item,
 *    each with a copy button, and its task reads without the `[ ]`;
 *  - the owner's own case, a command written as prose ("Run in Terminal on
 *    this MacBook: npm publish …"), draws it as a code block with a copy
 *    button that copies the command alone;
 *  - dragging a selection across an action item's why, and across a question
 *    card's prompt, leaves the selection in place after mouseup, on a desktop
 *    and on a phone viewport (touch emulation), so Cmd+C or the copy menu
 *    works.
 *
 * Build the binary first (see inbox.spec.ts). PNGs land in
 * <PLANNOTATOR_E2E_PROOF_DIR or .local/proof>/action-copy-blocks/.
 */

import { devices, expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'action-copy-blocks');

const PACK = 'npm pack ./packages/core --pack-destination dist';
const PUBLISH = 'npm publish dist/plannotator-core-0.29.0.tgz --access public';

const NPM = [
  'Both tarballs are built.',
  '',
  ':::action',
  'Publish the two npm tarballs, in order',
  'The registry wants your security key, so only you can publish. Run these in the repo root, one after the other:',
  '',
  '```',
  PACK,
  '```',
  '',
  '```',
  PUBLISH,
  '```',
  '',
  'Stopped: the 0.29 release cannot go out until both are published',
  ':::',
  '',
  ':::question',
  'Tag 0.29 as latest, or as next first?',
  '',
  '- [ ] latest',
  '- [ ] next first',
  '',
  'Recommended: next first',
  ':::',
].join('\n');

const COPY_ID = 'ssh-copy-id -i ~/.ssh/id_ed25519.pub user@host';
const MKDIR = 'mkdir -p ~/.ssh && chmod 700 ~/.ssh';

/** The coordinator's markdown, word for word: a task list item with indented fences under it. */
const SSH = [
  ':::action',
  "- [ ] Let this MacBook's key into the Mac mini — **Easiest, on this MacBook:** run this in Terminal, then type the Mini's login password once when it asks:",
  '',
  '  ```',
  `  ${COPY_ID}`,
  '  ```',
  '',
  '  **Or on the Mini itself**, in Terminal:',
  '',
  '  ```',
  `  ${MKDIR}`,
  '  ```',
  ':::',
].join('\n');

const UI_PUBLISH = 'npm publish /path/to/plannotator-ui-0.55.0.tgz --access public';

/** The owner's case, word for word: "this needed to be something in a copy block". */
const OWNER = [
  ':::action',
  'Publish @plannotator/ui 0.55.0 to npm',
  `Run in Terminal on this MacBook: ${UI_PUBLISH}`,
  'Watching: npm showing @plannotator/ui 0.55.0',
  ':::',
].join('\n');

let url = '';
let ownerThread = '';
let npmThread = '';
let sshThread = '';
let claude: SimAgent;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-action-copy-e2e-');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: join(root, 'data'), PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  url = started.stdout.trim();
  claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const project = scratchProject(join(root, 'src'), 'web');
  sshThread = (await claude.send({ project_path: project, thread: 'mac mini', body: SSH })).thread_id as string;
  ownerThread = (await claude.send({ project_path: project, thread: 'ui publish', body: OWNER })).thread_id as string;
  npmThread = (await claude.send({ project_path: project, thread: 'publish', body: NPM })).thread_id as string;
});

test.afterAll(async () => {
  try {
    await claude?.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

async function openThread(page: Page, threadId: string): Promise<Locator> {
  await page.goto(`${url}#thread=${threadId}`);
  const card = page.locator('section.ib-pane [data-action-group]');
  await expect(card.locator('[data-action-why]')).toBeVisible();
  return card;
}

/** Drag the mouse from the start of `el`'s first text to its end, as a person selects with a mouse. */
async function dragAcross(page: Page, el: Locator): Promise<void> {
  await el.scrollIntoViewIfNeeded();
  const box = await el.boundingBox();
  if (!box) throw new Error('no box to drag across');
  const y = box.y + Math.min(box.height / 2, 10);
  await page.mouse.move(box.x + 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, y, { steps: 8 });
  await page.mouse.move(box.x + box.width - 4, y, { steps: 8 });
  await page.mouse.up();
}

const selected = (page: Page) => page.evaluate(() => window.getSelection()?.toString() ?? '');

async function desktop(browser: Browser, scheme: 'light' | 'dark'): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme, reducedMotion: 'reduce' });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(url).origin });
  return { context, page: await context.newPage() };
}

test('two fenced commands draw two copy buttons, in order, and each copies its own command', async ({ browser }) => {
  const { context, page } = await desktop(browser, 'light');
  try {
    const card = await openThread(page, npmThread);
    const blocks = card.locator('[data-action-why] pre code');
    await expect(blocks).toHaveText([PACK, PUBLISH]);
    const buttons = card.locator('[data-action-why] button[title="Copy code"]');
    await expect(buttons).toHaveCount(2);
    await buttons.nth(1).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(PUBLISH);
    await buttons.nth(0).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(PACK);
  } finally {
    await context.close();
  }
});


test('a task list item with indented fences under it (the coordinator\'s markdown): both fences stay with the action item and copy without the indent', async ({ browser }) => {
  const { context, page } = await desktop(browser, 'light');
  try {
    const card = await openThread(page, sshThread);
    const task = card.locator('[data-action-toggle]').first();
    await expect(task).toContainText(/^Let this MacBook.s key into the Mac mini/);
    await expect(task).not.toContainText('[ ]');
    await expect(card.locator('[data-action-why] pre code')).toHaveText([COPY_ID, MKDIR]);
    await expect(card.locator('[data-action-why] strong')).toHaveText(['Or on the Mini itself']);
    const buttons = card.locator('[data-action-why] button[title="Copy code"]');
    await expect(buttons).toHaveCount(2);
    await buttons.nth(0).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(COPY_ID);
    await buttons.nth(1).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(MKDIR);
  } finally {
    await context.close();
  }
});

test('the owner\'s "Run in Terminal on this MacBook: …" line draws its command in a code block with a copy button', async ({ browser }) => {
  const { context, page } = await desktop(browser, 'light');
  try {
    const card = await openThread(page, ownerThread);
    await expect(card.locator('[data-action-why] p').first()).toHaveText('Run in Terminal on this MacBook:');
    await expect(card.locator('[data-action-why] pre code')).toHaveText([UI_PUBLISH]);
    const buttons = card.locator('[data-action-why] button[title="Copy code"]');
    await expect(buttons).toHaveCount(1);
    await buttons.click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(UI_PUBLISH);
    await expect(card.locator('[data-action-foot]')).toContainText('npm showing @plannotator/ui 0.55.0');
  } finally {
    await context.close();
  }
});

test('desktop: a drag across the why, and across a question prompt, keeps its selection and Cmd+C copies it; a plain click still toggles the row', async ({ browser }) => {
  const { context, page } = await desktop(browser, 'light');
  try {
    const card = await openThread(page, npmThread);
    const why = card.locator('[data-action-why] p').first();
    await dragAcross(page, why);
    await page.waitForTimeout(300);
    expect(await selected(page)).toContain('registry wants your security key');
    await page.keyboard.press('ControlOrMeta+c');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('registry wants your security key');
    // The full-window shot of a selection held in the action item's text.
    await page.screenshot({ path: join(proofDir, 'desktop-selection-light.png') });

    const prompt = page.locator('section.ib-pane [data-question-key] [data-question-part="prompt"]').first();
    await dragAcross(page, prompt);
    await page.waitForTimeout(300);
    expect(await selected(page)).toContain('Tag 0.29');

    // A click with no selection still does what it did: the row's toggle closes and opens it.
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    const toggle = card.locator('[data-action-toggle]').first();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    // The message's own text still takes a comment: a drag there opens the comment toolbar.
    await dragAcross(page, page.locator('section.ib-pane [data-message-id] p', { hasText: 'Both tarballs are built.' }).first());
    await expect(page.locator('.annotation-toolbar')).toBeVisible();
  } finally {
    await context.close();
  }
});

test('phone (touch emulation): a drag, and a long-press selection the system menu holds, both keep the selection in the why', async ({ browser }) => {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = devices['Pixel 7'];
  const context = await browser.newContext({ viewport, userAgent, deviceScaleFactor, isMobile, hasTouch, colorScheme: 'light', reducedMotion: 'reduce' });
  try {
    const page = await context.newPage();
    const card = await openThread(page, npmThread);
    expect(await page.evaluate(() => window.matchMedia('(pointer: coarse)').matches)).toBe(true);
    const why = card.locator('[data-action-why] p').first();
    await dragAcross(page, why);
    await page.waitForTimeout(300);
    expect(await selected(page)).toContain('registry wants your security key');

    // A long press: the system selects a word range, then the finger lifts (touchend) and the
    // highlighter's touch bridge looks at the selection 400 ms later.
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await why.evaluate((p) => {
      const text = [...p.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.includes('security key'))!;
      const at = text.textContent!.indexOf('security key');
      const range = document.createRange();
      range.setStart(text, at);
      range.setEnd(text, at + 'security key'.length);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      const touch = new Touch({ identifier: 1, target: p, clientX: 10, clientY: 10 });
      p.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, changedTouches: [touch] }));
    });
    await page.waitForTimeout(700);
    expect(await selected(page)).toBe('security key');
  } finally {
    await context.close();
  }
});

test('shots: the two commands with their copy buttons, desktop light and dark, and on the phone', async ({ browser }) => {
  for (const scheme of ['light', 'dark'] as const) {
    const { context, page } = await desktop(browser, scheme);
    try {
      const card = await openThread(page, npmThread);
      await expect(card.locator('[data-action-why] button[title="Copy code"]')).toHaveCount(2);
      await card.scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(proofDir, `desktop-${scheme}.png`) });
    } finally {
      await context.close();
    }
  }
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = devices['Pixel 7'];
  const context = await browser.newContext({ viewport, userAgent, deviceScaleFactor, isMobile, hasTouch, colorScheme: 'light', reducedMotion: 'reduce' });
  try {
    const page = await context.newPage();
    const card = await openThread(page, npmThread);
    const buttons = card.locator('[data-action-why] button[title="Copy code"]');
    await expect(buttons).toHaveCount(2);
    // Both buttons show without a hover on a phone.
    for (const i of [0, 1]) expect(await buttons.nth(i).evaluate((b) => getComputedStyle(b).opacity)).toBe('1');
    await card.locator('[data-action-why] pre').first().scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(proofDir, 'phone-light.png') });
  } finally {
    await context.close();
  }
});
