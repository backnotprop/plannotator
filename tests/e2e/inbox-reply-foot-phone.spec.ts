/**
 * The reply box's row (approval "inbox-reply-box", T6, built on "inbox-reply-foot-phone" variant B "Summary"), proved in
 * Chromium against the compiled binary.
 *
 *  - a phone, the worst case (four open questions, three comments, two files, the mic, a long agent name), at 390 and
 *    320: the summary line on its own line over the row, then ONE row: the paperclip at the left and Skills, the mic
 *    and Send (a round arrow) at the right edge; no bin (the owner: "maybe we don't need delete icon. I like
 *    attachment on left"); every control drawn 36 px and 44 px to press (approval "inbox-phone-composer-picker");
 *    nothing runs past the box; one agent wrote there, so nothing says who gets the reply;
 *  - two agents: who gets the reply is a pill in that row, after Skills, never on the line over it;
 *  - a tap on the summary sheet's scrim closes it and presses nothing under it; Skip them, Review comments; a long
 *    agent name in the list stays on one line;
 *  - recording (decision D5): the status takes the paperclip's and Skills' place; the mic, Send and the box never move;
 *  - a long draft (decision D1): the box stops at about half the window and scrolls inside; Send stays on screen;
 *  - a computer: Send, the paperclip, Skills, the mic at the left, the bin at the far right; the chips when they fit,
 *    the summary line when they don't (decision D4); the row stays still while recording too.
 *
 * The cases one by one are DOM tests: packages/inbox/replyFootPhone.test.tsx. Build the binary first (see inbox.spec.ts).
 */

import { expect, test, type Browser, type Page } from '@playwright/test';
import { FILE_WORDS, MESSAGE_WORDS, pane, startWorld, stopWorld, type ListWorld } from './inbox-comments-list-world';

const LONG_NAME = 'Codex (northwind-industries-holdings platform reviewer)';
const BODY = [
  `Four decisions before I go on: ${MESSAGE_WORDS}.`,
  ...['Which backoff should the worker use?', 'Ship it behind a flag?', 'Keep the dead-letter queue for 7 days or 30?', 'Who reviews the migration?'].flatMap((prompt) => [
    '',
    ':::question',
    prompt,
    '',
    '- [ ] Yes',
    '- [ ] No',
    ':::',
  ]),
].join('\n');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

// A fake microphone, so the mic can record.
test.use({ launchOptions: { args: ['--use-mock-keychain', '--password-store=basic', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] } });
test.describe.configure({ mode: 'serial' });

let world: ListWorld;
let thread = '';
/** A thread both agents wrote in: the box's row names who gets the reply (a pill after Skills). */
let twoAgents = '';
let serverSession = '';

test.beforeAll(async () => {
  world = await startWorld({ agentName: LONG_NAME, second: 'Codex' });
  const sent = await world.agent.send({ project_path: world.project, subject: 'Retry worker', thread: 'retry-foot', body: BODY, attachments: ['docs/retry-plan.md'] });
  thread = sent.thread_id as string;
  await world.agent.send({ project_path: world.project, subject: 'Two agents', thread: 'retry-two', body: 'First, from the long name.' });
  twoAgents = (await world.other!.send({ project_path: world.project, subject: 'Two agents', thread: 'retry-two', body: 'Second, from Codex.' })).thread_id as string;
  const post = async (path: string, body: object) => expect((await fetch(new URL(path, world.url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).status, path).toBe(200);
  const model = (await (await fetch(new URL(`/api/inbox/threads/${thread}/attachments`, world.url))).json()) as { attachments: { id: string; name: string }[] };
  const plan = model.attachments.find((a) => a.name === 'retry-plan.md')!.id;
  for (const [i, text] of ['One by one is right.', 'Log each retry.'].entries())
    await post('/api/inbox/annotations', { attachment_id: plan, version: 'current', annotation: { id: `plan-${i}`, type: 'COMMENT', text, originalText: FILE_WORDS, blockId: '', startOffset: 0, endOffset: 0, createdA: Date.now() } });
  await post(`/api/inbox/messages/${sent.message_id}/annotations`, {
    annotation: { id: 'on-message', type: 'COMMENT', text: 'Is that true when the first request times out?', originalText: MESSAGE_WORDS, blockId: '', startOffset: 0, endOffset: 0, createdA: Date.now() },
  });
  // The mic on, as the owner has it.
  const settings = (await (await fetch(new URL('/api/inbox/settings', world.url))).json()) as { serverSession: string };
  serverSession = settings.serverSession;
  await post('/api/inbox/settings', { serverSession, voice: { on: true } });
});

/**
 * Every test starts from a thread with no draft. A test leaves its two files in the box, and the box keeps its files
 * as the thread's draft (approval "inbox-reply-drafts"); a thread opened with a draft opens its box by itself, holding
 * it, so the next test would find no Reply to press.
 */
test.beforeEach(async () => {
  const discard = await fetch(new URL(`/api/inbox/threads/${thread}/draft/delete`, world.url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ serverSession }) });
  expect(discard.status).toBe(200);
  const left = (await (await fetch(new URL(`/api/inbox/threads/${thread}/draft`, world.url))).json()) as { draft: unknown };
  expect(left.draft, 'no draft left by the test before').toBeNull();
});

test.afterAll(async () => {
  await stopWorld(world);
});

/**
 * This computer's voice is ready (no Codex sign-in in the scratch world), and a clip comes back as no words. The page
 * answers both, never the Inbox: its status read and its transcribe each run `codex app-server`, an agent CLI, which
 * the run's stub fails. A tap on the mic that a slow runner holds past HOLD_MS is a hold, and its release transcribes.
 */
async function voiceReady(page: Page): Promise<void> {
  await page.route('**/api/inbox/voice/status**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ state: 'ready', plan: null }) }));
  await page.route('**/api/inbox/voice/transcribe**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: '' }) }));
}

async function phone(browser: Browser, width: number): Promise<Page> {
  const context = await browser.newContext({ viewport: { width, height: 760 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, colorScheme: 'light', permissions: ['microphone'] });
  const page = await context.newPage();
  await voiceReady(page);
  return page;
}

/** The thread with the reply box open, two files in it. */
async function openBox(page: Page): Promise<void> {
  await page.goto(`${world.url}#thread=${thread}`);
  await pane(page).locator('.ib-pfoot').getByRole('button', { name: /^Reply$|Edit draft$/ }).first().click();
  await expect(pane(page).locator('.ib-rbox textarea')).toBeVisible();
  await pane(page).locator('.ib-rbox [data-reply-attach]').setInputFiles([
    { name: 'retry-worker-backoff-screenshot.png', mimeType: 'image/png', buffer: PNG },
    { name: 'dead-letter-retention-notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Notes\n') },
  ]);
  await expect(pane(page).locator('.ib-rbox [data-compose-file="done"]')).toHaveCount(2);
  await expect(pane(page).locator('.ib-rbox [data-reply-row] [data-voice-mic]')).toBeVisible();
}

const line = (page: Page) => pane(page).locator('.ib-rbox [data-foot-summary]');
/** The line's words are drawn whole: nothing cut with an ellipsis (`innerText` reads them whole either way). */
const whole = (page: Page) => line(page).locator('[data-foot-summary-text]').evaluate((el) => el.scrollWidth <= el.clientWidth);

/** The row as drawn: each visible control's box and its press area (its own box, or its ::after where that is bigger). */
const readRow = (page: Page) =>
  pane(page).locator('.ib-rbox').evaluate((box) => {
    const row = box.querySelector<HTMLElement>('[data-reply-row]')!;
    const controls = [...row.querySelectorAll<HTMLElement>('button, label')].filter((el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden');
    const press = (el: HTMLElement) => {
      const own = el.getBoundingClientRect();
      const after = getComputedStyle(el, '::after');
      const width = after.content !== 'none' && after.position === 'absolute' ? Math.max(own.width, parseFloat(after.width) || 0) : own.width;
      const height = after.content !== 'none' && after.position === 'absolute' ? Math.max(own.height, parseFloat(after.height) || 0) : own.height;
      // `chip`: inside a computer's chips, which keep their 26 px look (inbox-attachments.spec.ts checks it).
      return { name: el.getAttribute('aria-label') || el.textContent!.trim(), chip: el.closest('.ib-rchips') !== null, left: own.left, right: own.right, top: own.top, bottom: own.bottom, width, height };
    };
    const b = box.getBoundingClientRect();
    return { scroll: row.scrollWidth, client: row.clientWidth, boxLeft: b.left, boxRight: b.right, rowRight: row.getBoundingClientRect().right, controls: controls.map(press) };
  });

function oneRow(row: Awaited<ReturnType<typeof readRow>>, press = 44): void {
  expect(row.scroll, 'nothing runs past the row').toBeLessThanOrEqual(row.client);
  expect(row.rowRight).toBeLessThanOrEqual(row.boxRight + 0.5);
  const middles = row.controls.map((c) => (c.top + c.bottom) / 2);
  for (const middle of middles) expect(Math.abs(middle - middles[0]!), 'every control on one line').toBeLessThanOrEqual(2);
  for (const c of row.controls) expect(c.right, `"${c.name}" inside the box`).toBeLessThanOrEqual(row.boxRight + 0.5);
  // The row's own controls (Send, the paperclip, Skills, who gets the reply where it shows, the mic, the bin, the summary line); a
  // chip's button is the chip's size. A phone draws them 36 px and makes up the rest with `::after` (`readRow`).
  for (const c of row.controls.filter((c) => !c.chip)) expect(Math.min(c.width, c.height), `"${c.name}" is ${press} px to press`).toBeGreaterThanOrEqual(press);
}

/** Where the things a person aims at are: the mic, Send, the bin (a computer), and the box itself. */
const spots = (page: Page) =>
  pane(page).locator('.ib-rbox').evaluate((box) => {
    const at = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return [r.left, r.top, r.width, r.height].map((n) => Math.round(n * 2) / 2);
    };
    return { box: at(box), mic: at(box.querySelector('[data-voice-mic]')), send: at(box.querySelector('[data-reply-send]')), bin: at(box.querySelector('[data-reply-discard]')) };
  });

const MIC = 'Dictate: hold to talk, or tap';

for (const width of [390, 320] as const) {
  test(`a phone at ${width} wide, the worst case: the line over one row of the paperclip, Skills, the mic and Send; no bin`, async ({ browser }) => {
    const page = await phone(browser, width);
    await openBox(page);
    // On its own line over the row the whole words fit even at 320 (on main they shared Send's row and were cut to
    // "4 open · 3 comments" there); never cut with an ellipsis either.
    const words = '4 questions open · 3 comments';
    await expect(line(page)).toHaveText(words);
    expect(await whole(page), 'the words are not cut').toBe(true);
    // Its name is the words it shows (what a voice-control user says); the full sentence is its description.
    await expect(line(page)).toHaveAccessibleName(words);
    await expect(line(page)).toHaveAccessibleDescription('4 questions stay open, 3 comments');
    // The line sits on its own line, over the row, inside the box, its words on one line.
    const placed = await pane(page).locator('.ib-rbox').evaluate((box) => {
      const lineBox = box.querySelector('[data-reply-line]')!.getBoundingClientRect();
      const rowBox = box.querySelector('[data-reply-row]')!.getBoundingClientRect();
      const text = box.querySelector('[data-foot-summary-text]')!;
      const range = document.createRange();
      range.selectNodeContents(text);
      const tops = new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)));
      const outer = box.getBoundingClientRect();
      return { above: lineBox.bottom <= rowBox.top + 0.5, inside: lineBox.left >= outer.left - 0.5 && lineBox.right <= outer.right + 0.5, lines: tops.size };
    });
    expect(placed).toEqual({ above: true, inside: true, lines: 1 });
    const row = await readRow(page);
    // One agent wrote here: nothing says who gets the reply (as on a computer). Send is the round arrow, still named "Send".
    expect(row.controls.map((c) => c.name)).toEqual(['Attach files', 'Skills', MIC, 'Send']);
    oneRow(row);
    const drawn = await pane(page).locator('.ib-rbox [data-reply-row]').evaluate((el) => {
      const size = (selector: string) => {
        const r = el.querySelector(selector)!.getBoundingClientRect();
        return [r.width, r.height];
      };
      const word = el.querySelector('[data-reply-send] .ib-rsend-w')!.getBoundingClientRect();
      return {
        sizes: ['.ib-rclip', '[data-reply-skills]', '[data-voice-mic]', '[data-reply-send]'].map(size),
        arrow: el.querySelector('[data-reply-send] svg.ib-rsend-i')!.getClientRects().length > 0,
        word: Math.max(word.width, word.height),
      };
    });
    expect(drawn.sizes, 'every control is drawn 36 px round').toEqual(Array.from({ length: 4 }, () => [36, 36]));
    expect(drawn.arrow, 'Send is the arrow').toBe(true);
    expect(drawn.word, 'the word "Send" is not drawn (it is the name)').toBeLessThanOrEqual(1);
    await expect(pane(page).locator('.ib-rbox [data-recipient]'), 'one agent: no recipient control').toHaveCount(0);
    // The paperclip at the left edge, Send at the right edge.
    expect(row.controls[0]!.left - row.boxLeft).toBeLessThanOrEqual(12);
    expect(row.boxRight - row.controls.at(-1)!.right).toBeLessThanOrEqual(12);
    // No bin on a phone, and no chip: Discard is on the Draft line above the box once the draft is saved.
    await expect(pane(page).locator('[data-reply-discard]')).toHaveCount(0);
    await expect(pane(page).locator('.ib-rbox').locator('[data-skip-chip], [data-annotations-chip], [data-picks-chip]')).toHaveCount(0);
    await expect(pane(page).locator('[data-draft-above] [data-draft-discard]')).toBeVisible();
    await page.context().close();
  });
}

for (const width of [390, 320] as const) {
  test(`a phone at ${width} wide, two agents: who gets the reply is a pill (its mark and a chevron) in the row after Skills, 36 px drawn and 44 px to press, never on the line over it`, async ({ browser }) => {
    const page = await phone(browser, width);
    await page.goto(`${world.url}#thread=${twoAgents}`);
    await pane(page).locator('.ib-pfoot').getByRole('button', { name: /^Reply$|Edit draft$/ }).first().click();
    const pill = pane(page).locator('.ib-rbox [data-reply-row] [data-recipient]');
    await expect(pill).toBeVisible();
    await expect(pill).toHaveAttribute('data-agent-pill', '');
    await expect(pill).toHaveAccessibleName(/^Reply goes to .+\. Change$/);
    await expect(pane(page).locator('.ib-rbox [data-reply-line] [data-recipient]')).toHaveCount(0);
    await expect(pane(page).locator('.ib-rbox .ib-rto')).toHaveCount(0);
    await expect(pane(page).locator('.ib-rbox [data-reply-row] [data-voice-mic]')).toBeVisible();
    const drawn = await pill.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const box = el.closest('.ib-rbox')!.getBoundingClientRect();
      const skills = el.closest('[data-reply-row]')!.querySelector('[data-reply-skills]')!.getBoundingClientRect();
      const mic = el.closest('[data-reply-row]')!.querySelector('[data-voice-mic]')!.getBoundingClientRect();
      return {
        height: r.height,
        press: parseFloat(getComputedStyle(el, '::after').height),
        // The two agents wear different marks (Claude Code, Codex): the mark and the chevron, no name.
        name: el.querySelector('.ib-apill-n') !== null,
        mark: (el.querySelector('.ib-apill-m .ib-mk')?.getClientRects().length ?? 0) > 0 && el.querySelector('.ib-apill-c') !== null,
        afterSkills: r.left >= skills.right - 0.5 && Math.abs((r.top + r.bottom) / 2 - (skills.top + skills.bottom) / 2) <= 2,
        beforeMic: r.right <= mic.left + 0.5,
        inside: r.left >= box.left - 0.5 && r.right <= box.right + 0.5,
      };
    });
    expect(drawn.height, 'the pill is drawn 36 px tall').toBe(36);
    expect(drawn.press, 'the pill is 44 px to press').toBeGreaterThanOrEqual(44);
    expect({ name: drawn.name, mark: drawn.mark, afterSkills: drawn.afterSkills, beforeMic: drawn.beforeMic, inside: drawn.inside }).toEqual({ name: false, mark: true, afterSkills: true, beforeMic: true, inside: true });
    oneRow(await readRow(page));
    await page.context().close();
  });
}

test('a tap on the sheet\'s scrim closes it and presses nothing under it (a question\'s option there stays unpicked)', async ({ browser }) => {
  const page = await phone(browser, 390);
  await openBox(page);
  // A question's option in view, where the scrim (not the sheet) will be.
  const option = pane(page).locator('fieldset[data-question-key]').first().locator('[data-question-option]').filter({ hasText: 'Yes' });
  await option.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(300);
  const spot = (await option.boundingBox())!;
  const x = spot.x + spot.width / 2;
  const y = spot.y + spot.height / 2;
  expect(await option.evaluate((el, [px, py]) => el.contains(document.elementFromPoint(px!, py!)), [x, y]), 'the option is what is under that point').toBe(true);
  await line(page).tap();
  const sheet = page.getByRole('dialog', { name: 'Goes with this reply' });
  await expect(sheet).toBeVisible();
  expect(y, 'the point is above the sheet, on its scrim').toBeLessThan((await sheet.boundingBox())!.y);
  await page.touchscreen.tap(x, y);
  await expect(sheet).toHaveCount(0);
  // Long enough for a click that went through to have made its pick.
  await page.waitForTimeout(800);
  await expect(pane(page).locator('.ib-rbox [data-reply-answers]')).toHaveCount(0);
  await expect(line(page)).toHaveText('4 questions open · 3 comments');
  await expect(line(page)).toBeFocused();
  await page.context().close();
});

test('the sheet: Skip them skips them, Review opens the list, and a long agent name there stays on one line', async ({ browser }) => {
  const page = await phone(browser, 320);
  await openBox(page);
  await line(page).tap();
  const sheet = page.getByRole('dialog', { name: 'Goes with this reply' });
  await expect(sheet).toBeVisible();
  for (const button of await sheet.getByRole('button').all()) {
    const box = (await button.boundingBox())!;
    expect(Math.min(box.width, box.height), `"${await button.textContent()}" is 44 px to press`).toBeGreaterThanOrEqual(44);
  }
  await sheet.getByRole('button', { name: 'Skip them' }).tap();
  await expect(line(page)).toHaveText('4 questions to skip · 3 comments');
  expect(await whole(page), 'the words are not cut').toBe(true);
  await expect(sheet.getByRole('button', { name: 'Keep open' })).toBeVisible();
  await sheet.getByRole('button', { name: 'Review comments' }).tap();
  await expect(sheet).toHaveCount(0);
  const list = page.getByRole('dialog', { name: '3 comments', exact: true });
  await expect(list).toBeVisible();
  const place = list.locator('[data-annotation-row="on-message"] .ib-af');
  // The Inbox keeps the whole name: "Codex (northwind-industries-holdings platform reviewer)'s message, 3:49 PM", far wider than a 320 px row.
  await expect(place).toHaveText(/^Codex \(northwind-industries-holdings platform reviewer\)'s message, \d/);
  const drawn = await place.evaluate((el) => {
    const style = getComputedStyle(el);
    return { height: el.getBoundingClientRect().height, line: parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.6, align: style.textAlign };
  });
  expect(drawn.height, 'one line, never three').toBeLessThan(drawn.line * 1.5);
  expect(drawn.align).toBe('start');
  await page.context().close();
});

for (const width of [320, 390] as const) {
  test(`a phone at ${width} wide, recording: the status takes the paperclip's and Skills' place; the mic, Send and the box never move`, async ({ browser }) => {
    const page = await phone(browser, width);
    await openBox(page);
    const before = await spots(page);
    await pane(page).locator('.ib-rbox [data-voice-mic]').tap();
    const cancel = pane(page).locator('.ib-rbox [data-reply-row] [data-voice-cancel]');
    await expect(cancel).toBeVisible();
    expect(await spots(page), 'nothing moved when the take started').toEqual(before);
    // The paperclip and Skills step aside (decision D5); the summary line over the row stays.
    await expect(pane(page).locator('.ib-rbox [data-reply-row] .ib-rclip')).toBeHidden();
    await expect(pane(page).locator('.ib-rbox [data-reply-skills]')).toBeHidden();
    await expect(line(page)).toBeVisible();
    // The level is drawn: some of its strokes have room to show.
    const strokes = await pane(page).locator('.ib-rbox [data-reply-row] .ib-vbars').evaluate((strip) => {
      const room = strip.getBoundingClientRect();
      return [...strip.children].filter((s) => {
        const at = s.getBoundingClientRect();
        return at.width > 0 && at.left >= room.left - 0.5 && at.right <= room.right + 0.5;
      }).length;
    });
    expect(strokes).toBeGreaterThanOrEqual(4);
    const row = await readRow(page);
    oneRow(row);
    await page.waitForTimeout(600);
    expect(await spots(page), 'nothing moved while it records').toEqual(before);
    await cancel.tap();
    await expect(cancel).toHaveCount(0);
    await expect(pane(page).locator('.ib-rbox [data-reply-row] .ib-rclip')).toBeVisible();
    expect(await spots(page), 'nothing moved when it ended').toEqual(before);
    await page.context().close();
  });
}

/** Sixty lines of words: a draft far taller than half the window. */
const LONG_DRAFT = Array.from({ length: 60 }, (_, i) => `Line ${i + 1}: the retry worker waits, then tries again with the same key.`).join('\n');

for (const size of [
  { width: 390, height: 760, phone: true },
  { width: 1280, height: 800, phone: false },
]) {
  test(`a long draft at ${size.width} wide: the box stops at about half the window and scrolls inside; Send stays on screen`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, isMobile: size.phone, hasTouch: size.phone, colorScheme: 'light', permissions: ['microphone'] });
    const page = await context.newPage();
    await voiceReady(page);
    await openBox(page);
    const field = pane(page).locator('.ib-rbox textarea');
    await field.fill(LONG_DRAFT);
    await field.press('End');
    await page.waitForTimeout(300);
    const drawn = await pane(page).locator('.ib-rbox').evaluate((box) => {
      const scroll = box.querySelector<HTMLElement>('[data-reply-scroll]')!;
      const send = box.querySelector('[data-reply-send]')!.getBoundingClientRect();
      const b = box.getBoundingClientRect();
      return {
        scrolls: scroll.scrollHeight > scroll.clientHeight + 1,
        boxHeight: b.height,
        send: { top: send.top, bottom: send.bottom, left: send.left, right: send.right },
        box: { top: b.top, bottom: b.bottom },
        view: { width: window.innerWidth, height: window.innerHeight },
        hit: box.querySelector('[data-reply-send]')!.contains(document.elementFromPoint((send.left + send.right) / 2, (send.top + send.bottom) / 2)),
      };
    });
    expect(drawn.scrolls, 'the words scroll inside the box').toBe(true);
    expect(drawn.boxHeight, 'the box stops at about half the window').toBeLessThanOrEqual(drawn.view.height * 0.62);
    expect(drawn.send.top).toBeGreaterThanOrEqual(drawn.box.top);
    expect(drawn.send.bottom).toBeLessThanOrEqual(Math.min(drawn.box.bottom, drawn.view.height) + 0.5);
    expect(drawn.send.left).toBeGreaterThanOrEqual(0);
    expect(drawn.send.right).toBeLessThanOrEqual(drawn.view.width + 0.5);
    expect(drawn.hit, 'nothing is drawn over Send').toBe(true);
    await context.close();
  });
}

test('a computer: Send, the paperclip, Skills and the mic at the left, the bin at the far right; chips when they fit, the summary line when they do not; recording moves nothing', async ({ browser }) => {
  // 1440: the box (about 740 px) has room for the chips; at 1280 (about 580) they fold into the line.
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', permissions: ['microphone'] });
  const page = await context.newPage();
  await voiceReady(page);
  await openBox(page);
  const row = pane(page).locator('.ib-rbox [data-reply-row]');
  const drawn = await readRow(page);
  expect(drawn.controls.slice(0, 4).map((c) => c.name)).toEqual(['Send', 'Attach files', 'Skills', MIC]);
  expect(drawn.controls.at(-1)!.name).toBe('Discard draft');
  expect(drawn.boxRight - drawn.controls.at(-1)!.right, 'the bin at the far right').toBeLessThanOrEqual(16);
  oneRow(drawn, 32);
  // Room for the chips (decision D4).
  await expect(row.locator('[data-skip-chip]')).toContainText('4 questions stay open');
  await expect(row.locator('[data-annotations-chip]')).toHaveText('3 comments');
  await expect(row.locator('[data-foot-summary]')).toHaveCount(0);
  // A box too narrow for them: the one summary line instead, and the row still one row inside the box.
  const narrow = await page.addStyleTag({ content: 'section.ib-pane .ib-rbox { width: 440px !important; }' });
  await expect(row.locator('[data-foot-summary]')).toHaveText('4 open · 3 comments');
  await expect(row.locator('[data-skip-chip], [data-annotations-chip]')).toHaveCount(0);
  oneRow(await readRow(page), 32);
  await narrow.evaluate((el) => el.remove());
  await expect(row.locator('[data-annotations-chip]')).toHaveText('3 comments');
  // Recording: the status takes the chips' place; the mic, Send, the bin and the box stay where they are.
  const before = await spots(page);
  await row.locator('[data-voice-mic]').click();
  await expect(row.locator('[data-voice-cancel]')).toBeVisible();
  await expect(row.locator('[data-annotations-chip]')).toBeHidden();
  expect(await spots(page)).toEqual(before);
  await row.locator('[data-voice-cancel]').click();
  await expect(row.locator('[data-annotations-chip]')).toBeVisible();
  expect(await spots(page)).toEqual(before);
  await context.close();
});
