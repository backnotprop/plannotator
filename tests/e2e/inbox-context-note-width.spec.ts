/**
 * A guided review's notes on a phone, proved in a real browser against the compiled binary, in the scratch world of
 * inbox-review-comments-phone-world.ts (the agent's review of a real `git diff`, here with a long Review note on a line).
 *
 * With Wrap long lines on, the diff's lines wrap at the window's width and the diff never pans sideways. A closed note is
 * one line of all its words (`nowrap`, cut by an ellipsis), and that line counted in full toward the width of the diff's
 * code column: with a note in the rows the diff draws, the column grew to the note's length, every row wrapped at that
 * width instead of the phone's, and the diff panned sideways. Scrolling a note into and out of the drawn rows then flipped
 * the layout between the two, a frame at a time (rows 1.5k px shorter, the page moved to keep its place, the note out of
 * the rows, the rows long again). The note takes the width the column has and is cut there.
 */
import { expect, test } from '@playwright/test';
import { openReview, SHORT_FILE, startWorld, stopWorld, windowAt, type PhoneWorld } from './inbox-review-comments-phone-world';

/** Far longer than a phone's width on one line (about 6 px a character at the note's size). */
const NOTE =
  'Each attempt is a constant the loop reads, so the loop stops when this list runs out: add one here and the worker tries once more, which is why the first words of this note have to stay on one line when it is closed.';

const GUIDE = {
  title: 'Retry a failed charge',
  intent: 'Back off between attempts, and stop when the charge cannot succeed.',
  sections: [{ title: 'The attempts', overview: 'Each attempt is a constant the loop reads.', diffs: [{ file: SHORT_FILE, summary: 'The attempts.', notes: [{ lineStart: 10, lineEnd: 10, text: NOTE }] }] }],
};

let world: PhoneWorld;
test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  world = await startWorld(browser, GUIDE);
  const { context } = await windowAt(browser, 390, 844, true);
  const saved = await context.request.post(`${world.url}api/inbox/settings`, { data: { diff_options: { overflow: 'wrap' } } });
  expect(saved.status()).toBe(200);
  await context.close();
});

test.afterAll(async () => {
  await stopWorld(world);
});

test('a closed note on a phone leaves the wrapped diff as wide as the window', async ({ browser }) => {
  const width = 390;
  const { context, page } = await windowAt(browser, width, 844, true);
  try {
    await openReview(world, page);
    const note = page.locator(`[data-guide-file-shell="${SHORT_FILE}"] [data-context-note-row]`);
    await expect(note).toBeVisible();
    // The note is closed: one line of its words, cut where the column ends.
    const words = note.locator('.ib-ctxn-first');
    await expect(words).toBeVisible();
    expect(await words.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    // The diff did not grow to hold that line: it wraps at the window and does not pan.
    const code = page.locator(`[data-guide-file-shell="${SHORT_FILE}"] [data-code]`).first();
    const { client, scroll } = await code.evaluate((el) => ({ client: el.clientWidth, scroll: el.scrollWidth }));
    expect(client).toBeLessThanOrEqual(width);
    expect(scroll).toBeLessThanOrEqual(client);
    const box = await note.boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
  } finally {
    await context.close();
  }
});
