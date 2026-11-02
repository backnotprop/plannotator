/**
 * The reply box's foot on a phone (approval "inbox-reply-foot-phone", variant B "Summary"), proved in Chromium
 * against the compiled binary. The owner, of the chips it replaces: "the stacking is very bad looking on mobile.
 * not good, not acceptable".
 *
 *  - the worst case (four open questions, three comments, two files in the box, the mic, a long agent name) is ONE
 *    row at 390 and at 320: the paperclip, one line, the mic; nothing runs past the box;
 *  - the line says "4 questions open · 3 comments" at 390 and "4 open · 3 comments" at 320;
 *  - every control in the row and in its sheet is at least 44 px to press;
 *  - the sheet: Skip them skips them (the line says so), Review opens the comments list;
 *  - in that list, a comment's place ("<long agent name>'s message, 10:41 AM") is one line from the left;
 *  - dictating, the row stays one row and the status line's Cancel is 44 px to press;
 *  - a desktop window keeps today's chips.
 *
 * The cases one by one (nothing, comments only, questions only, both, focus) are DOM tests:
 * packages/inbox/replyFootPhone.test.tsx. Build the binary first (see inbox.spec.ts).
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

test.beforeAll(async () => {
  world = await startWorld({ agentName: LONG_NAME });
  const sent = await world.agent.send({ project_path: world.project, subject: 'Retry worker', thread: 'retry-foot', body: BODY, attachments: ['docs/retry-plan.md'] });
  thread = sent.thread_id as string;
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
  await post('/api/inbox/settings', { serverSession: settings.serverSession, voice: { on: true } });
});

test.afterAll(async () => {
  await stopWorld(world);
});

async function phone(browser: Browser, width: number): Promise<Page> {
  const context = await browser.newContext({ viewport: { width, height: 760 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, colorScheme: 'light', permissions: ['microphone'] });
  const page = await context.newPage();
  // This computer's voice is ready (no Codex sign-in in the scratch world).
  await page.route('**/api/inbox/voice/status**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ state: 'ready', plan: null }) }));
  return page;
}

/** The thread with the reply box open, two files in it. */
async function openBox(page: Page): Promise<void> {
  await page.goto(`${world.url}#thread=${thread}`);
  await pane(page).locator('.ib-pfoot').getByRole('button', { name: /^(Reply|Edit draft)$/ }).first().click();
  await expect(pane(page).locator('.ib-rbox textarea')).toBeVisible();
  await pane(page).locator('.ib-rbox [data-reply-attach]').setInputFiles([
    { name: 'retry-worker-backoff-screenshot.png', mimeType: 'image/png', buffer: PNG },
    { name: 'dead-letter-retention-notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Notes\n') },
  ]);
  await expect(pane(page).locator('.ib-rbox [data-compose-file="done"]')).toHaveCount(2);
  await expect(pane(page).locator('.ib-rfoot [data-voice-mic]')).toBeVisible();
}

const line = (page: Page) => pane(page).locator('.ib-rfoot [data-foot-summary]');

/** The row as drawn: each visible control's box and its press area (its own box, or its ::after where that is bigger). */
const readRow = (page: Page) =>
  pane(page).locator('.ib-rbox').evaluate((box) => {
    const row = box.querySelector<HTMLElement>('.ib-rfoot')!;
    const controls = [...row.querySelectorAll<HTMLElement>('button, label')].filter((el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden');
    const press = (el: HTMLElement) => {
      const own = el.getBoundingClientRect();
      const after = getComputedStyle(el, '::after');
      const width = after.content !== 'none' && after.position === 'absolute' ? Math.max(own.width, parseFloat(after.width) || 0) : own.width;
      const height = after.content !== 'none' && after.position === 'absolute' ? Math.max(own.height, parseFloat(after.height) || 0) : own.height;
      return { name: el.getAttribute('aria-label') || el.textContent!.trim(), top: own.top, bottom: own.bottom, width, height };
    };
    return { scroll: row.scrollWidth, client: row.clientWidth, boxRight: box.getBoundingClientRect().right, rowRight: row.getBoundingClientRect().right, controls: controls.map(press) };
  });

function oneRow(row: Awaited<ReturnType<typeof readRow>>): void {
  expect(row.scroll, 'nothing runs past the row').toBeLessThanOrEqual(row.client);
  expect(row.rowRight).toBeLessThanOrEqual(row.boxRight + 0.5);
  const middles = row.controls.map((c) => (c.top + c.bottom) / 2);
  for (const middle of middles) expect(Math.abs(middle - middles[0]!), 'every control on one line').toBeLessThanOrEqual(2);
  for (const c of row.controls) expect(Math.min(c.width, c.height), `"${c.name}" is 44 px to press`).toBeGreaterThanOrEqual(44);
}

for (const [width, words] of [
  [390, '4 questions open · 3 comments'],
  [320, '4 open · 3 comments'],
] as const) {
  test(`at ${width} wide the worst case is one row: the paperclip, "${words}", the mic`, async ({ browser }) => {
    const page = await phone(browser, width);
    await openBox(page);
    await expect(line(page)).toHaveText(words);
    await expect(line(page)).toHaveAccessibleName('4 questions stay open, 3 comments');
    const row = await readRow(page);
    expect(row.controls.map((c) => c.name)).toEqual(['Attach files', '4 questions stay open, 3 comments', 'Dictate: hold to talk, or tap']);
    oneRow(row);
    // No chip of today's is left in the phone's box.
    await expect(pane(page).locator('.ib-rbox').locator('[data-skip-chip], [data-annotations-chip], [data-picks-chip]')).toHaveCount(0);
    await page.context().close();
  });
}

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
  await expect(line(page)).toHaveText('4 to skip · 3 comments');
  await expect(sheet.getByRole('button', { name: 'Keep open' })).toBeVisible();
  await sheet.getByRole('button', { name: 'Review comments' }).tap();
  await expect(sheet).toHaveCount(0);
  const list = page.getByRole('dialog', { name: '3 comments', exact: true });
  await expect(list).toBeVisible();
  const place = list.locator('[data-annotation-row="on-message"] .ib-af');
  // The Inbox keeps 40 characters of a name: "Codex (northwind-industries-holdings…'s message, 3:49 PM", still wider than a 320 px row.
  await expect(place).toHaveText(/^Codex \(northwind-industries-holdings…'s message, \d/);
  const drawn = await place.evaluate((el) => {
    const style = getComputedStyle(el);
    return { height: el.getBoundingClientRect().height, line: parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.6, align: style.textAlign };
  });
  expect(drawn.height, 'one line, never three').toBeLessThan(drawn.line * 1.5);
  expect(drawn.align).toBe('start');
  await page.context().close();
});

test('dictating, the row stays one row and its Cancel is 44 px to press', async ({ browser }) => {
  const page = await phone(browser, 320);
  await openBox(page);
  await pane(page).locator('.ib-rfoot [data-voice-mic]').tap();
  const cancel = pane(page).locator('.ib-rfoot [data-voice-cancel]');
  await expect(cancel).toBeVisible();
  // The line steps aside while the status speaks.
  await expect(line(page)).toBeHidden();
  const row = await readRow(page);
  oneRow(row);
  await cancel.tap();
  await expect(cancel).toHaveCount(0);
  await expect(line(page)).toBeVisible();
  await page.context().close();
});

test('a desktop window keeps its chips', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'light' });
  const page = await context.newPage();
  await page.goto(`${world.url}#thread=${thread}`);
  await pane(page).locator('.ib-pfoot').getByRole('button', { name: /^(Reply|Edit draft)$/ }).first().click();
  const foot = pane(page).locator('.ib-rbox .ib-rfoot');
  await expect(foot.locator('[data-skip-chip]')).toContainText('4 questions stay open');
  await expect(foot.locator('[data-annotations-chip]')).toHaveText('3 comments');
  await expect(foot.locator('[data-foot-summary]')).toHaveCount(0);
  await context.close();
});
