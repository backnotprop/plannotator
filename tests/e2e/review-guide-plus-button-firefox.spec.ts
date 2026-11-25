/**
 * The + on a diff line in the review window's guide, in Firefox (the owner's report of 2026-11-24: in Firefox,
 * pressing the + on a diff line in a Guided Review "blanks out the screen and errors"). The report was made on
 * `plannotator review` with a Guided Review open, the surface this spec drives; inbox-review-plus-button-firefox.spec.ts
 * covers the Inbox's guide reader. In the `firefox` project only, against the compiled binary.
 *
 * A scratch repository holds one Swift file whose diff has three hunks, with collapsed "unmodified lines" between
 * them. Its guide is put on the review's shelf with `plannotator guide import` before the review starts
 * (review-scratch-session.ts `importGuide`), and opened from the header's Guide, as a person does with AI features off.
 * In Unified, the + is pressed on the first and on the second context line after a collapsed separator, on an added
 * line and on a removed line: first while the file's semantic note is still being worked out (the parsers it loads
 * are held back), then once it has landed. Each press opens the comment box, and Escape closes it. At the end a
 * comment is written with the + and shows on its line.
 *
 * What regresses if this fails: in Firefox a press on the + throws (any `pageerror` fails the case), blanks the
 * window (an empty `#root`), or leaves a part of it saying "This part didn't load" (ui's RegionBoundary,
 * `[data-region-failed]`); or the + opens no comment box. Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts --project firefox review-guide-plus-button-firefox.spec.ts`.
 */

import { expect, test, type Locator, type Page } from '@playwright/test';
import { importGuide, openReview, openSavedGuide, reviewOf } from './review-scratch-session';

const FILE = 'Sources/Harbor/Berth.swift';
/** Far apart, so the diff is three hunks with unmodified lines folded between them. */
const CHANGED = [20, 60, 100];
const berths = (changed: boolean) =>
  Array.from({ length: 120 }, (_, i) => {
    const n = i + 1;
    const slip = changed && CHANGED.includes(n) ? n * 10 : n;
    return `let berth${n} = Berth(slip: ${slip}, harbor: "harbor", pilot: "Ada Novak") // berth ${n} of the north quay`;
  }).join('\n') + '\n';

const GUIDE = {
  title: 'Harbor berths move to new slips',
  intent: 'Three berths of the north quay move to new slips.',
  sections: [{ title: 'The berths', overview: 'One file, three changes far apart.', diffs: [{ file: FILE, summary: 'Three slips change.' }] }],
};

type Kind = 'change-addition' | 'change-deletion' | 'context';

const shellOf = (page: Page) => page.locator(`[data-guide-file-shell="${FILE}"]`).first();
/** A line's number, of its kind (Unified: one number per row; a removed line's is its old number). */
const lineNumber = (shell: Locator, n: number, kind: Kind) => shell.locator(`[data-line-type="${kind}"][data-column-number="${n}"]`).first();
const commentBox = (page: Page) => page.locator('.review-toolbar');

/** Nothing failed: no uncaught error, no part of the window in its failure notice, and the window is drawn. */
async function nothingBroke(page: Page, errors: string[], what: string): Promise<void> {
  expect(errors, `${what}: the page threw`).toEqual([]);
  await expect(page.locator('[data-region-failed]'), `${what}: a part of the window says it didn't load`).toHaveCount(0);
  const root = await page.evaluate(() => {
    const el = document.getElementById('root');
    return { children: el?.childElementCount ?? 0, text: (el?.innerText ?? '').trim().length };
  });
  expect(root.children, `${what}: the window is blank (#root has no children)`).toBeGreaterThan(0);
  expect(root.text, `${what}: the window is blank (#root shows no text)`).toBeGreaterThan(0);
}

/** Hover line `n`'s number, press the + it shows: the comment box opens (through the Comment · Ask bar when it shows). */
async function pressPlus(page: Page, errors: string[], n: number, kind: Kind, what: string): Promise<void> {
  const shell = shellOf(page);
  const number = lineNumber(shell, n, kind);
  await expect(number, `${what}: line ${n} (${kind}) is drawn`).toBeAttached({ timeout: 15_000 });
  await number.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(300);
  await number.hover();
  const plus = shell.locator('[data-gutter-utility-slot] [data-utility-button]').first();
  await expect(plus, `${what}: the + shows`).toBeVisible();
  await plus.click();
  const box = commentBox(page);
  const chooser = page.locator('[data-selection-chooser]');
  await expect(box.or(chooser).first(), `${what}: the + opened nothing`).toBeVisible({ timeout: 5_000 });
  if (await chooser.isVisible()) await chooser.getByRole('button', { name: 'Comment' }).click();
  await expect(box, `${what}: the comment box opens`).toBeVisible();
  await nothingBroke(page, errors, what);
}

async function closeBox(page: Page, errors: string[], what: string): Promise<void> {
  await commentBox(page).locator('textarea').first().press('Escape');
  await expect(commentBox(page), `${what}: Escape closes the comment box`).toHaveCount(0, { timeout: 5_000 });
  await expect(shellOf(page), `${what}: the guide is still open`).toBeVisible();
  await nothingBroke(page, errors, `${what}, closed`);
}

test.use({ actionTimeout: 20_000 });

test("the review window's guide, Unified: the + on context lines after a fold, an added and a removed line opens the comment box, before and after the semantic note lands", async ({ browser }) => {
  test.setTimeout(180_000);
  const session = await reviewOf('review-guide-plus-firefox', { [FILE]: berths(false) }, { [FILE]: berths(true) }, { before: (repo) => importGuide(repo, GUIDE) });
  // The semantic parsers are held back until the settled half: until then the file's note is still being worked out.
  let release = () => {};
  const held = new Promise<void>((done) => {
    release = done;
  });
  const errors: string[] = [];
  try {
    const { context, page } = await openReview(browser, session.url, async (page) => {
      page.on('pageerror', (error) => errors.push(`${error.name}: ${error.message}\n${error.stack ?? ''}`));
      await page.context().addCookies([{ name: 'plannotator-diff-style', value: 'unified', url: session.url }]);
      await page.context().route('**/assets/sem-diff/**', async (route) => {
        await held;
        await route.continue().catch(() => {});
      });
    });

    // Where each hunk starts on the new side: its first two rows are the context lines after the fold above it.
    const { rawPatch } = (await (await fetch(new URL('/api/diff', session.url))).json()) as { rawPatch: string };
    const starts = [...rawPatch.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/gm)].map((m) => Number(m[1]));
    expect(starts, 'the diff is three hunks').toHaveLength(3);

    await openSavedGuide(page, GUIDE.title);
    const shell = shellOf(page);
    await shell.scrollIntoViewIfNeeded();
    await shell.hover();
    await expect(lineNumber(shell, CHANGED[0]!, 'change-addition'), 'the guide draws the file').toBeVisible({ timeout: 30_000 });
    await expect(shell.locator('pre[data-diff-type="split"]'), 'the diff is in Unified').toHaveCount(0);
    await expect(shell.locator('[data-unmodified-lines]').first(), 'unmodified lines are folded between the hunks').toBeAttached();
    await nothingBroke(page, errors, 'the guide, opened');

    const phases = [
      { name: 'semantic note pending', hunk: starts[1]!, changed: CHANGED[1]! },
      { name: 'semantic note landed', hunk: starts[2]!, changed: CHANGED[2]! },
    ];
    for (const phase of phases) {
      if (phase.name === 'semantic note pending') {
        const landed = await shell.locator('[data-semantic-file-badge]:not([data-semantic-file-badge="pending"])').count();
        // Best effort: where the held parsers did not hold the note back (a worker's request the route does not see), say so.
        if (landed > 0) test.info().annotations.push({ type: 'note', description: 'the semantic note had landed before the pending half' });
      } else {
        release();
        // The guide's own file header: the review's panes behind the guide keep badges of their own, which can stay
        // pending (a pane not drawn does not work its files out), so a page-wide count never settles.
        await expect(shell.locator('[data-semantic-file-badge]:not([data-semantic-file-badge="pending"])'), 'the semantic note lands').toHaveCount(1, { timeout: 30_000 });
        await expect(shell.locator('[data-semantic-file-badge="pending"]'), 'the semantic note lands').toHaveCount(0);
      }
      const cases: [number, Kind, string][] = [
        [phase.hunk, 'context', 'the first context line after a fold'],
        [phase.hunk + 1, 'context', 'the second context line after a fold'],
        [phase.changed, 'change-addition', 'an added line'],
        [phase.changed, 'change-deletion', 'a removed line'],
      ];
      for (const [n, kind, which] of cases) {
        const what = `${phase.name}: the + on ${which} (line ${n})`;
        await pressPlus(page, errors, n, kind, what);
        await closeBox(page, errors, what);
      }
    }

    // A comment written with the +, as a person does: it shows on its line.
    const words = 'Charlie Dunn: berth 20 keeps its pilot.';
    await pressPlus(page, errors, CHANGED[0]!, 'change-addition', 'the + for a comment');
    await commentBox(page).locator('textarea').first().fill(words);
    await commentBox(page).getByRole('button', { name: 'Add Comment' }).click();
    await expect(commentBox(page)).toHaveCount(0, { timeout: 5_000 });
    await expect(shell.getByText(words), 'the comment shows on its line').toBeVisible();
    await nothingBroke(page, errors, 'the comment, saved');
    await context.close();
  } finally {
    release();
    await session.close();
  }
});
