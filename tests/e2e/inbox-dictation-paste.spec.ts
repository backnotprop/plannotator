/**
 * Dictated (pasted) text lands in the field the person is writing in,
 * proved in a real Chromium (and WebKit) against the compiled binary.
 *
 * Dictation apps on macOS (Hex and others) insert text by putting it on the
 * clipboard and posting a synthetic ⌘V. In the Inbox, focus often leaves the
 * field the person is writing in without them noticing: a click on a question
 * card's choice moves it to that radio, a click on the message text or on a
 * chip in the reply box moves it to the page, a double-click selects a word of
 * the message, and the reply box stays open.
 * Before the fix the ⌘V then pasted into nothing. Each case below writes the
 * clipboard, moves focus the way a person does, presses ⌘V, and expects the
 * words in the field: the reply box, a question card's note, compose, and a
 * full-screen file's own comment box (portaled outside the file); after search
 * opened and closed, the reply box still. And the other side: a paste aimed at
 * a field stays in it, a page where no field was used keeps it nowhere, a file
 * shown full screen over the thread keeps it out of the reply box hidden under
 * it, and words selected in a file to comment on keep their toolbar. With
 * image paste (#1953, `compose/paste.ts`): an image pasted after a pick
 * attaches once to the reply box, and text is still inserted once. And
 * Chrome 155-156's dropped paste (pasteInsert.ts, forced on here): with the
 * browser's own insertion cancelled, the page still inserts each dictation
 * once, as an undo step, into the reply box, search and compose; on an engine
 * without the bug the browser's own paste is kept.
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 */

import { expect, test, webkit, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';
import { forgetFileViewChoice } from './file-view';
import { NO_BROWSER } from '../helpers/no-browser';
import { chromiumPasteBugAffected, FORCE_PLAIN_TEXT_PASTE_FLAG } from '../../packages/ui/utils/pasteInsert';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));

const QUESTIONS = [
  'I checked the 409 row. Two things before I go on.',
  '',
  ':::question',
  'Which way should the worker go on a Stripe 409?',
  '',
  '- [ ] Retry with the same idempotency key',
  '- [ ] Fail the job',
  ':::',
  '',
  ':::question',
  'Ship it behind a flag?',
  '',
  '- [ ] Yes',
  '- [ ] No',
  ':::',
].join('\n');

let url = '';
let threadId = '';
let filesThreadId = '';
let claude: SimAgent;
let context: BrowserContext;
let page: Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-inbox-paste-e2e-');
  const dataDir = join(root, 'data');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  url = started.stdout.trim();
  const project = scratchProject(join(root, 'src'), 'plannotator');
  writeFileSync(join(project, 'retry-plan.md'), '# Retry plan\n\nRetry with the same key, three times, then the dead-letter queue.\n');
  claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  threadId = (await claude.send({ project_path: project, subject: 'The 409 row', thread: 'retry', body: QUESTIONS })).thread_id as string;
  filesThreadId = (await claude.send({ project_path: project, subject: 'The retry plan', thread: 'plan', body: 'The plan is attached.', attachments: ['retry-plan.md'] }))
    .thread_id as string;
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
  page = await context.newPage();
});

/** A view pressed in a test is remembered in the shared context: forgotten after each (file-view.ts). */
test.afterEach(async () => forgetFileViewChoice(context));

test.afterAll(async () => {
  try {
    await claude?.close().catch(() => {});
    await context?.close();
  } finally {
    await removeInboxScratch();
  }
});

/** What a dictation app does: the words on the clipboard, then ⌘V. */
async function dictate(on: Page, words: string): Promise<void> {
  await on.evaluate((text) => navigator.clipboard.writeText(text), words);
  await on.keyboard.press('ControlOrMeta+v');
}

/** The middle of one word inside the element holding `text`, for a double-click on that word. */
async function wordRect(on: Page, text: string, word: string): Promise<{ x: number; y: number }> {
  const point = await on.evaluate(
    ([text, word]) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const value = node.textContent ?? '';
        if (!value.includes(text)) continue;
        const start = value.indexOf(text) + text.indexOf(word);
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, start + word.length);
        const box = range.getBoundingClientRect();
        return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
      }
      return null;
    },
    [text, word],
  );
  if (!point) throw new Error(`no text node holds ${text}`);
  return point;
}

/**
 * Open the thread's reply box. The words typed in earlier tests are kept as the
 * thread's reply draft (approval "inbox-reply-drafts"), which reopens the box by
 * itself once the draft is read; otherwise the foot offers Reply, or Edit draft
 * while picks wait. The draft's read can land between the check and the click,
 * so a click that finds no button is tried again. A restored box does not take
 * focus (the person may only be reading), so the box is focused here, as a
 * click on Reply does.
 */
async function openReply(on: Page): Promise<Locator> {
  const box = on.locator('section.ib-pane .ib-rbox textarea');
  const button = on.locator('.ib-pfoot').getByRole('button', { name: /^(Reply|Edit draft)$/ });
  for (let attempt = 0; attempt < 10 && !(await box.isVisible()); attempt += 1) {
    await button.click({ timeout: 1_000 }).catch(() => {});
  }
  await expect(box).toBeVisible();
  await box.focus();
  return box;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function expectLanded(field: Locator, words: string): Promise<void> {
  await expect(field).toHaveValue(new RegExp(escapeRegExp(words.trim())));
  await expect(field).toBeFocused();
}

/** Every text field's value on the page, so a paste that landed anywhere is seen. */
const allValues = (on: Page) =>
  on.evaluate(() => [...document.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>('textarea, input')].map((el) => el.value).join('\n'));

test('the reply box: after a pick, after a click on the message, after a chip', async () => {
  await page.goto(`${url}#thread=${threadId}`);
  await openReply(page);
  const box = page.locator('section.ib-pane .ib-rbox textarea');
  await expect(box).toBeFocused();
  await dictate(page, 'Focused dictation. ');
  await expectLanded(box, 'Focused dictation.');

  await page.locator('fieldset[data-question-key]').getByText('Retry with the same idempotency key').click();
  await expect(box).not.toBeFocused();
  await dictate(page, 'After a pick. ');
  await expectLanded(box, 'After a pick.');
  // The caret comes back where the person left it: at the end.
  expect(await box.inputValue()).toBe('Focused dictation. After a pick. ');

  await page.getByText('I checked the 409 row.').click();
  await expect(box).not.toBeFocused();
  await dictate(page, 'After reading. ');
  await expectLanded(box, 'After reading.');

  await page.locator('section.ib-pane .ib-rfoot button').first().click();
  await expect(box).not.toBeFocused();
  await dictate(page, 'After a chip. ');
  await expectLanded(box, 'After a chip.');
  expect(await box.inputValue()).toBe('Focused dictation. After a pick. After reading. After a chip. ');
});

test('a press in the reply box beside its text (the row of chips) puts the caret in the reply: typing and a dictation with Option held first land', async () => {
  const p = await context.newPage();
  try {
    await p.goto(`${url}#thread=${threadId}`);
    // Earlier tests leave a reply draft, which reopens the box by itself (see openReply).
    await openReply(p);
    const rbox = p.locator('section.ib-pane .ib-rbox');
    const box = rbox.locator('textarea');
    await expect(box).toBeFocused();
    // An earlier test's picks may have drafted a reply: start from the person's own words.
    await box.fill('Typed first. ');
    // The box is drawn as one field (its focus ring is always on); its lower part is the chips' row, not the textarea.
    const outer = (await rbox.boundingBox())!;
    const text = (await box.boundingBox())!;
    const chips = (await rbox.locator('.ib-rfoot').boundingBox())!;
    expect(chips.y).toBeGreaterThanOrEqual(text.y + text.height - 1);
    // Leave the box (a click on the message), then press inside it, right of the chips, as a person clicks into a field.
    await p.getByText('I checked the 409 row.').click();
    await expect(box).not.toBeFocused();
    await p.mouse.click(outer.x + outer.width - 24, chips.y + chips.height / 2);
    await expect(box).toBeFocused();
    await p.keyboard.type('Then typed. ');
    // Hex starts on Option (held, then released), then pastes with ⌘V.
    await p.keyboard.down('Alt');
    await p.waitForTimeout(400);
    await p.keyboard.up('Alt');
    await dictate(p, 'Then dictated.');
    await expect(box).toHaveValue('Typed first. Then typed. Then dictated.');
    // A press on a control in the box keeps its own meaning: the chip's button is pressed, not stolen.
    const chip = rbox.locator('[data-skip-chip]');
    const before = await chip.getAttribute('data-skip-chip');
    await rbox.locator('[data-skip-toggle]').click();
    await expect(chip).toHaveAttribute('data-skip-chip', before === 'keep' ? 'skip' : 'keep');
  } finally {
    await p.close();
  }
});

test('a word double-clicked in the message (selected, nothing to comment on) does not keep the dictation out of the reply box', async () => {
  const p = await context.newPage();
  try {
    await p.goto(`${url}#thread=${threadId}`);
    await openReply(p);
    const box = p.locator('section.ib-pane .ib-rbox textarea');
    await box.fill('Reading first. ');
    // A double-click on a word of the agent's message selects it, as people do while reading.
    const word = await wordRect(p, 'I checked the 409 row.', 'checked');
    await p.mouse.dblclick(word.x, word.y);
    // The word is drawn as the comment toolbar's pending highlight (approval "inbox-message-comments"):
    // the toolbar is an offer, so the dictation still follows the reply box.
    await expect(p.locator('section.ib-pane .ib-body mark.annotation-highlight')).toHaveText('checked');
    await expect(p.locator('.annotation-toolbar')).toBeVisible();
    await expect(box).not.toBeFocused();
    await dictate(p, 'Then this.');
    await expect(box).toHaveValue('Reading first. Then this.');
    await expect(box).toBeFocused();
    // The words were left for the field: their pending highlight and toolbar went with them.
    await expect(p.locator('.annotation-toolbar')).toHaveCount(0);
    await expect(p.locator('section.ib-pane .ib-body mark.annotation-highlight')).toHaveCount(0);
  } finally {
    await p.close();
  }
});

test('a range selected in the reply box before a pick is not replaced: the dictation goes after it', async () => {
  await page.goto(`${url}#thread=${threadId}`);
  const box = page.locator('section.ib-pane .ib-rbox textarea');
  await openReply(page);
  await box.fill('Keep these words.');
  await box.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(5, 10)); // "these", selected
  await page.locator('fieldset[data-question-key]').getByText('Fail the job').click();
  await expect(box).not.toBeFocused();
  await dictate(page, ' Dictated.');
  await expect(box).toHaveValue('Keep these Dictated. words.');
});

test('a question card note: after a pick on the same card', async () => {
  await page.goto(`${url}#thread=${threadId}`);
  const card = page.locator('section.ib-pane fieldset[data-question-key]').nth(1);
  await card.getByRole('button', { name: 'Add note' }).click();
  const note = card.getByPlaceholder('Context for the agent…');
  await expect(note).toBeFocused();
  await dictate(page, 'Only if the flag is off by default. ');
  await expectLanded(note, 'Only if the flag is off by default.');
  await card.getByText('Yes', { exact: true }).click();
  await expect(note).not.toBeFocused();
  await dictate(page, 'And tell the team. ');
  await expectLanded(note, 'And tell the team.');
});

test('a paste aimed at another field stays in it: the reply box keeps its words', async () => {
  await page.goto(`${url}#thread=${threadId}`);
  const box = page.locator('section.ib-pane .ib-rbox textarea');
  await openReply(page);
  await box.fill('My reply.');
  const card = page.locator('section.ib-pane fieldset[data-question-key]').nth(1);
  const note = card.getByPlaceholder('Context for the agent…');
  if (!(await note.isVisible())) await card.getByRole('button', { name: 'Add note' }).click();
  await note.click();
  await dictate(page, 'Into the note. ');
  await expectLanded(note, 'Into the note.');
  await expect(box).toHaveValue('My reply.');
});

test('compose: after focus moves to another control in the dialog', async () => {
  await page.goto(`${url}#thread=${threadId}`);
  await page.locator('[data-open-compose]').first().click();
  const message = page.getByRole('dialog').getByRole('textbox', { name: 'Message' });
  await expect(message).toBeVisible();
  await message.click();
  await dictate(page, 'An idea for later. ');
  await expectLanded(message, 'An idea for later.');
  // Focus moves to another of the dialog's controls (no agent is live here, so To is plain text).
  await page.getByRole('dialog').getByRole('button', { name: 'Save draft' }).focus();
  await expect(message).not.toBeFocused();
  await dictate(page, 'With one more thought. ');
  await expectLanded(message, 'With one more thought.');
});

test('no field used on the page yet: a paste lands nowhere and opens nothing', async () => {
  const fresh = await context.newPage();
  try {
    await fresh.goto(`${url}#thread=${threadId}`);
    await expect(fresh.locator('section.ib-pane fieldset[data-question-key]').first()).toBeVisible();
    await fresh.getByText('I checked the 409 row.').click();
    await dictate(fresh, 'Nowhere at all. ');
    await fresh.waitForTimeout(300);
    expect(await allValues(fresh)).not.toContain('Nowhere at all.');
    expect(await fresh.evaluate(() => document.activeElement?.tagName)).not.toMatch(/^(TEXTAREA|INPUT)$/);
  } finally {
    await fresh.close();
  }
});

test('a file full screen over the thread: the reply box hidden under it takes no paste', async () => {
  const p = await context.newPage();
  try {
    await p.goto(`${url}#thread=${filesThreadId}`);
    await openReply(p);
    const box = p.locator('section.ib-pane .ib-rbox textarea');
    await box.fill('Under the file.');
    await p.locator('section.ib-pane .ib-atts [data-attachment-id]').first().click();
    await p.getByRole('button', { name: 'Full screen' }).click();
    await expect(p.locator('.ib-view.ib-full')).toBeVisible();
    await p.locator('.ib-view.ib-full').getByText('Retry with the same key').click();
    await dictate(p, 'Not into the hidden box. ');
    await p.waitForTimeout(300);
    await expect(box).toHaveValue('Under the file.');
    await expect(box).not.toBeFocused();
  } finally {
    await p.close();
  }
});

test('a full-screen file: its own comment box (portaled outside the file) takes the paste', async () => {
  const p = await context.newPage();
  try {
    await p.goto(`${url}#thread=${filesThreadId}`);
    await p.locator('section.ib-pane .ib-atts [data-attachment-id]').first().click();
    await p.getByRole('button', { name: 'Full screen' }).click();
    await expect(p.locator('.ib-view.ib-full')).toBeVisible();
    await p.getByRole('button', { name: /Global comment/ }).first().click();
    const comment = p.getByPlaceholder(/comment/i).last();
    await expect(comment).toBeFocused();
    await dictate(p, 'First thought. ');
    await expectLanded(comment, 'First thought.');
    // Focus moves to a button in the comment box.
    await p.keyboard.press('Shift+Tab');
    await expect(comment).not.toBeFocused();
    await dictate(p, 'Second thought. ');
    await expectLanded(comment, 'Second thought.');
    expect(await comment.inputValue()).toBe('First thought. Second thought. ');
  } finally {
    await p.close();
  }
});

test('search opened and closed between: the paste still goes to the reply box', async () => {
  const p = await context.newPage();
  try {
    await p.goto(`${url}#thread=${threadId}`);
    await openReply(p);
    const box = p.locator('section.ib-pane .ib-rbox textarea');
    await box.fill('Start. ');
    await p.locator('[data-open-search]').first().click();
    await expect(p.locator('dialog[data-search-palette][open]')).toBeVisible();
    await p.keyboard.press('Escape');
    await expect(p.locator('dialog[data-search-palette][open]')).toHaveCount(0);
    await p.locator('fieldset[data-question-key]').getByText('Fail the job').click();
    await expect(box).not.toBeFocused();
    await dictate(p, 'After search.');
    await expect(box).toHaveValue('Start. After search.');
  } finally {
    await p.close();
  }
});

test('text selected in a file to comment on: the paste is not taken to the reply box', async () => {
  const p = await context.newPage();
  try {
    await p.goto(`${url}#thread=${filesThreadId}`);
    await openReply(p);
    const box = p.locator('section.ib-pane .ib-rbox textarea');
    await box.fill('My reply.');
    await p.locator('section.ib-pane .ib-atts [data-attachment-id]').first().click();
    const text = p.locator('.ib-view').getByText('Retry with the same key');
    await expect(text).toBeVisible();
    // The pane may still be sliding in: measure once it stands still.
    await p.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined))));
    // Drag across the words, as a person selects text to comment on (the rect of the words themselves).
    const rect = await p.evaluate(() => {
      const walker = document.createTreeWalker(document.querySelector('.ib-view')!, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.includes('Retry with the same key')) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const r = range.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      }
      return null;
    });
    expect(rect).not.toBeNull();
    await p.mouse.move(rect!.x + 2, rect!.y + rect!.height / 2);
    await p.mouse.down();
    await p.mouse.move(rect!.x + rect!.width / 2, rect!.y + rect!.height / 2, { steps: 8 });
    await p.mouse.up();
    // The viewer draws the selected words as a pending highlight under its comment toolbar.
    const toolbar = p.locator('[data-pn-annotation-toolbar-row]');
    await expect(toolbar).toBeVisible();
    await dictate(p, 'Not into the reply. ');
    await p.waitForTimeout(300);
    await expect(box).toHaveValue('My reply.');
    await expect(box).not.toBeFocused();
    // The toolbar is still there: the person can still comment on the words they chose.
    await expect(toolbar).toBeVisible();
  } finally {
    await p.close();
  }
});

/**
 * Chrome 155-156 on macOS (pasteInsert.ts): after a dictation app's synthetic ⌘V the `paste` event
 * carries the words, but the browser's own insertion is skipped. Simulated here by cancelling the
 * browser's `insertFromPaste` beforeinput (`drop`), which is exactly the insertion Chrome drops. The
 * workaround runs only on Chromium 155 and 156 on macOS, so `force` turns it on in this Chromium
 * (the window flag pasteInsert.ts reads). The page's own insertion (execCommand's `insertText`,
 * which fires `input` and no `beforeinput`) is what lands. Every `beforeinput` and `input` is
 * recorded as `<type>:<inputType>`.
 */
async function recordPasteInputs(on: Page, { drop, force }: { drop: boolean; force: boolean }): Promise<void> {
  await on.addInitScript(
    ({ dropIt, forceIt, flag }) => {
      if (forceIt) (window as unknown as Record<string, unknown>)[flag] = true;
      const seen: string[] = [];
      (window as unknown as { __pasteInputs: string[] }).__pasteInputs = seen;
      const record = (event: Event) => {
        const input = event as InputEvent;
        seen.push(`${input.type}:${input.inputType}`);
        if (dropIt && input.type === 'beforeinput' && input.inputType === 'insertFromPaste') input.preventDefault();
      };
      window.addEventListener('beforeinput', record, true);
      window.addEventListener('input', record, true);
    },
    { dropIt: drop, forceIt: force, flag: FORCE_PLAIN_TEXT_PASTE_FLAG },
  );
}
const pasteInputs = (on: Page) => on.evaluate(() => (window as unknown as { __pasteInputs: string[] }).__pasteInputs.splice(0));

test('Chrome 155-156 dropping the paste: the reply box, search and compose still get every dictation, once', async () => {
  const p = await context.newPage();
  try {
    await recordPasteInputs(p, { drop: true, force: true });
    await p.goto(`${url}#thread=${threadId}`);
    // The simulation is real: a field the page leaves native gets nothing.
    await p.evaluate(() => {
      const control = document.createElement('textarea');
      control.id = 'native-control';
      control.setAttribute('data-native-paste', '');
      document.body.append(control);
    });
    await p.locator('#native-control').focus();
    await dictate(p, 'Dropped by the browser.');
    await p.waitForTimeout(200);
    await expect(p.locator('#native-control')).toHaveValue('');
    expect(await pasteInputs(p)).toEqual(['beforeinput:insertFromPaste']);
    await p.evaluate(() => document.getElementById('native-control')?.remove());

    // The reply box (a React-controlled textarea under the skill-reference mirror).
    await openReply(p);
    const box = p.locator('section.ib-pane .ib-rbox textarea');
    await expect(box).toBeFocused();
    await box.fill(''); // a pick saved by an earlier test seeds the box
    await pasteInputs(p);
    await dictate(p, 'First dictation. ');
    await expect(box).toHaveValue('First dictation. ');
    await dictate(p, 'Second dictation. ');
    await expect(box).toHaveValue('First dictation. Second dictation. ');
    expect(await pasteInputs(p)).toEqual(['input:insertText', 'input:insertText']);
    // After a pick, the dictation follows the field (pasteTarget.ts) and is inserted by the page.
    await p.locator('fieldset[data-question-key]').getByText('Retry with the same idempotency key').click();
    await expect(box).not.toBeFocused();
    await dictate(p, 'After a pick.');
    await expect(box).toHaveValue('First dictation. Second dictation. After a pick.');
    // React holds the words: typing after them keeps them.
    await p.keyboard.type(' Typed.');
    await expect(box).toHaveValue('First dictation. Second dictation. After a pick. Typed.');
    // The insertion is an undo step.
    await dictate(p, ' Undo me.');
    await expect(box).toHaveValue('First dictation. Second dictation. After a pick. Typed. Undo me.');
    await p.keyboard.press('ControlOrMeta+z');
    await expect(box).toHaveValue('First dictation. Second dictation. After a pick. Typed.');

    // Search (a text input).
    await p.locator('[data-open-search]').first().click();
    const search = p.locator('dialog[data-search-palette][open] input').first();
    await expect(search).toBeFocused();
    await dictate(p, 'retry');
    await expect(search).toHaveValue('retry');
    await p.keyboard.press('Escape');

    // Compose's message.
    await p.locator('[data-open-compose]').first().click();
    const message = p.getByRole('dialog').getByRole('textbox', { name: 'Message' });
    await message.click();
    await dictate(p, 'An idea, dictated.');
    await expect(message).toHaveValue('An idea, dictated.');
  } finally {
    await p.close();
  }
});

test('the workaround on, the bug not hit: a dictation is inserted exactly once (the page inserts, the browser does not too)', async () => {
  const p = await context.newPage();
  try {
    await recordPasteInputs(p, { drop: false, force: true });
    await p.goto(`${url}#thread=${threadId}`);
    await openReply(p);
    const box = p.locator('section.ib-pane .ib-rbox textarea');
    await expect(box).toBeFocused();
    await box.fill('');
    await pasteInputs(p);
    await dictate(p, 'Once.');
    await expect(box).toHaveValue('Once.');
    await p.waitForTimeout(200);
    await expect(box).toHaveValue('Once.');
    expect(await pasteInputs(p)).toEqual(['input:insertText']);
  } finally {
    await p.close();
  }
});

test('an engine without the bug (this Chromium is neither 155 nor 156): the browser pastes, the page does not', async () => {
  const p = await context.newPage();
  try {
    // Playwright 1.64 ships Chromium 156: on macOS that engine HAS the bug, so
    // the workaround is on and this premise does not hold. Linux (CI) and any
    // other version keep the native path. The gate is the app's own.
    const affected = chromiumPasteBugAffected(
      await p.evaluate(() => {
        const nav = navigator as Navigator & { userAgentData?: { brands?: { brand: string; version: string }[]; platform?: string } };
        return { userAgent: nav.userAgent, platform: nav.platform, userAgentData: nav.userAgentData ? { brands: nav.userAgentData.brands, platform: nav.userAgentData.platform } : null };
      }),
    );
    test.skip(affected, 'this Chromium is 155 or 156 on macOS, where the workaround is on by design');
    await recordPasteInputs(p, { drop: false, force: false });
    await p.goto(`${url}#thread=${threadId}`);
    await openReply(p);
    const box = p.locator('section.ib-pane .ib-rbox textarea');
    await expect(box).toBeFocused();
    await box.fill('');
    await pasteInputs(p);
    await dictate(p, 'Native.');
    await expect(box).toHaveValue('Native.');
    expect(await pasteInputs(p)).toEqual(['beforeinput:insertFromPaste', 'input:insertFromPaste']);
  } finally {
    await p.close();
  }
});

/** A 1 by 1 PNG, as a screenshot would put it on the clipboard. */
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('with image paste (#1953): an image pasted after a pick attaches once to the reply box, its words untouched', async () => {
  const p = await context.newPage();
  try {
    await p.goto(`${url}#thread=${threadId}`);
    await openReply(p);
    const rbox = p.locator('section.ib-pane .ib-rbox');
    const box = rbox.locator('textarea');
    await box.fill('With a screenshot.');
    await p.locator('fieldset[data-question-key]').getByText('Fail the job').click();
    await expect(box).not.toBeFocused();
    // The real clipboard holds an image only, and the browser's own paste runs (no event made by hand).
    await p.evaluate(async (b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })]);
    }, PNG_B64);
    await p.keyboard.press('ControlOrMeta+v');
    await expect(box).toBeFocused();
    await expect(rbox.locator('[data-compose-file="done"]')).toHaveCount(1);
    await p.waitForTimeout(300);
    await expect(rbox.locator('[data-compose-file]')).toHaveCount(1);
    await expect(box).toHaveValue('With a screenshot.');
    // Then text after another pick: inserted once, and the image stays the one attached.
    await p.locator('fieldset[data-question-key]').getByText('Retry with the same idempotency key').click();
    await dictate(p, ' And words.');
    await expect(box).toHaveValue('With a screenshot. And words.');
    await expect(rbox.locator('[data-compose-file]')).toHaveCount(1);
  } finally {
    await p.close();
  }
});

test('WebKit: after a pick, the paste goes back to the reply box', async () => {
  let browser: Browser | null = null;
  try {
    browser = await webkit.launch();
  } catch (error) {
    test.skip(true, `WebKit is not installed here: ${(error as Error).message.split('\n')[0]}`);
    return;
  }
  try {
    const wk = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await wk.newPage();
    await p.goto(`${url}#thread=${threadId}`);
    await openReply(p);
    const box = p.locator('section.ib-pane .ib-rbox textarea');
    await box.fill('Typed. ');
    await p.locator('fieldset[data-question-key]').getByText('Retry with the same idempotency key').click();
    await expect(box).not.toBeFocused();
    // WebKit gives the page no clipboard permission to set, so this proves the half that is ours:
    // the ⌘V keydown puts focus back in the reply box, caret at its end, before the browser pastes.
    await p.keyboard.press('ControlOrMeta+v');
    await expect(box).toBeFocused();
    expect(await box.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([7, 7]);
  } finally {
    await browser.close();
  }
});
