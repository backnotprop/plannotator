/**
 * Comments in the Inbox's review (a pull request and a guided review), proved
 * in a real browser against the compiled binary, in a scratch world
 * (inbox-review-comments-phone-world.ts).
 *
 * On a phone Comments is the whole screen: nothing of the page shows or takes a
 * tap beside it, its top is one row, its controls are 44 px targets, and Close
 * returns to the same place in the diff. A double tap on Close does not reach
 * the page's bar under it, Escape closes the sheet before it leaves the review,
 * words typed in the sheet stay, and a turn of the phone keeps it whole. A
 * selection bar on the page goes when Comments opens, by a tap or by a key. A
 * desktop's panel stays the 300 px column or edge sheet it was.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { LONG_FILE, openPull, openReview, seedPull, seedReview, SHORT_FILE, startWorld, stopWorld, windowAt, type Comment, type PhoneWorld } from './inbox-review-comments-phone-world';

const COMMENTS: Comment[] = [
  { line: 12, text: 'Cap the backoff here; nothing stops it growing.' },
  { line: 18, text: 'This retries forever if the charge keeps failing.' },
  { line: 26, text: 'Log the attempt number before giving up.' },
];

let world: PhoneWorld;
test.describe.configure({ mode: 'serial' });
test.use({ actionTimeout: 20_000 });

test.beforeAll(async ({ browser }) => {
  world = await startWorld(browser);
  const { context, page } = await windowAt(browser, 1000, 800, false);
  await seedReview(world, page, COMMENTS);
  await context.close();
});

test.afterAll(async () => {
  await stopWorld(world);
});

const opens = {
  'a pull request': async (page: Page) => {
    await seedPull(page, COMMENTS);
    await openPull(world, page);
  },
  'a guided review': (page: Page) => openReview(world, page),
};

/** What a tap at each of these points of the window lands on is inside the sheet: nothing of the page shows or takes it. */
async function expectCovered(page: Page, width: number, height: number): Promise<void> {
  const uncovered = await page.evaluate(
    ([w, h]) => {
      const points: [number, number][] = [];
      for (let x = 1; x < w; x += (w - 2) / 6) for (let y = 1; y < h; y += (h - 2) / 12) points.push([x, y]);
      return points.filter(([x, y]) => !document.elementFromPoint(x, y)?.closest('.ib-gpanel')).length;
    },
    [width, height],
  );
  expect(uncovered).toBe(0);
}

/** The control's whole 44 px square, around its centre, is the control: a tap there lands on it and not on a neighbour. */
async function expectTarget(control: Locator): Promise<void> {
  const box = (await control.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
  const inside = await control.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const [cx, cy] = [r.left + r.width / 2, r.top + r.height / 2];
    return [[-21, 0], [21, 0], [0, -21], [0, 21]].map(([dx, dy]) => {
      const hit = document.elementFromPoint(cx + dx!, cy + dy!);
      return !!hit && (hit === el || el.contains(hit)) ? 'ok' : `${hit?.tagName}.${hit?.className}`;
    });
  });
  expect(inside).toEqual(['ok', 'ok', 'ok', 'ok']);
}

for (const [name, open] of Object.entries(opens)) {
  for (const [width, height] of [[390, 844], [320, 568]] as const) {
    test(`a phone at ${width}, ${name}: Comments is the whole screen, one row on top, and Close returns to the same place`, async ({ browser }) => {
      const { context, page } = await windowAt(browser, width, height, true);
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      try {
        await open(page);
        const body = page.locator('.ib-gbody');
        await body.evaluate((el) => {
          el.scrollTop = 300;
        });
        const place = await body.evaluate((el) => el.scrollTop);
        expect(place).toBeGreaterThan(100);

        const button = page.locator('.ib-vcomments');
        await button.tap();
        const sheet = page.locator('.ib-gpanel');
        await expect(sheet).toBeVisible();
        const box = (await sheet.boundingBox())!;
        expect(box).toEqual({ x: 0, y: 0, width, height });
        await expectCovered(page, width, height);

        // The sheet's own row is the only one over the list: the page's bars do not show.
        await expect(page.locator('.ib-vhead')).toBeHidden();
        await expect(body).toBeHidden();
        const head = sheet.locator('.ib-sheet-h');
        await expect(head).toContainText('Comments');
        expect((await head.boundingBox())!.y).toBe(0);

        const close = sheet.getByRole('button', { name: 'Close the comments' });
        await expect(close).toBeFocused();
        await expectTarget(close);
        const actions = sheet.locator('[data-annotation-panel] .ml-auto button');
        expect(await actions.count()).toBe(COMMENTS.length * 2);
        for (const action of await actions.all()) await expectTarget(action);
        await actions.first().tap();
        await expectTarget(sheet.getByRole('button', { name: 'Save', exact: true }));
        const cancel = sheet.getByRole('button', { name: 'Cancel', exact: true });
        await expectTarget(cancel);
        await cancel.tap();

        await close.tap();
        await expect(sheet).toBeHidden();
        await expect(page.locator('.ib-vhead')).toBeVisible();
        await expect(button).toBeFocused();
        expect(await body.evaluate((el) => el.scrollTop)).toBe(place);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    });
  }
}

for (const [name, open] of Object.entries(opens)) {
  const reviewOf = (page: Page) => page.locator('[data-review-message], [data-pull-review]');

  test(`a phone, ${name}: a double tap on Close stops at the sheet, the words typed in it stay, and a later tap reaches the bar`, async ({ browser }) => {
    const { context, page } = await windowAt(browser, 390, 844, true);
    try {
      await open(page);
      const sheet = page.locator('.ib-gpanel');
      const button = page.locator('.ib-vcomments');
      await button.tap();
      await sheet.locator('[data-annotation-panel] .ml-auto button').first().tap();
      const words = 'Words typed before the double tap.';
      await sheet.locator('textarea').fill(words);
      const close = (await sheet.getByRole('button', { name: 'Close the comments' }).boundingBox())!;
      const [x, y] = [close.x + close.width / 2, close.y + close.height / 2];

      await page.touchscreen.tap(x, y);
      await page.waitForTimeout(150);
      await page.touchscreen.tap(x, y);
      await expect(sheet).toBeHidden();
      await page.waitForTimeout(100);
      await expect(reviewOf(page)).toBeVisible();
      await expect(page.getByRole('menu')).toHaveCount(0);

      await page.waitForTimeout(350);
      await button.tap();
      await expect(sheet.locator('textarea')).toHaveValue(words);

      // Past the moment the same spot is the bar's again.
      await page.touchscreen.tap(x, y);
      await expect(sheet).toBeHidden();
      await page.waitForTimeout(450);
      await page.touchscreen.tap(x, y);
      await expect(page.locator('[data-review-message]').or(page.getByRole('menu'))).toHaveCount(name === 'a guided review' ? 0 : 1);
    } finally {
      await context.close();
    }
  });

  test(`a phone, ${name}: Escape closes the sheet before it leaves the review, and in the edit box only cancels`, async ({ browser }) => {
    const { context, page } = await windowAt(browser, 390, 844, true);
    try {
      await open(page);
      const sheet = page.locator('.ib-gpanel');
      const button = page.locator('.ib-vcomments');
      const closedToTheReview = async () => {
        await expect(sheet).toBeHidden();
        await expect(reviewOf(page)).toBeVisible();
        await expect(button).toBeFocused();
      };

      // Focus on its close.
      await button.tap();
      await page.keyboard.press('Escape');
      await closedToTheReview();

      // In the edit box: the edit goes, the sheet stays. Focus has dropped to the page, and the next Escape is the sheet's.
      await button.tap();
      await sheet.locator('[data-annotation-panel] .ml-auto button').first().tap();
      await expect(sheet.locator('textarea')).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(sheet.locator('textarea')).toHaveCount(0);
      await expect(sheet).toBeVisible();
      expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
      await page.keyboard.press('Escape');
      await closedToTheReview();

      // The same after a tap on the sheet's title.
      await button.tap();
      await sheet.locator('.ib-sheet-h b').tap();
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press('Escape');
      await closedToTheReview();
    } finally {
      await context.close();
    }
  });

  test(`a phone, ${name}: turned on its side and back, the sheet still covers the screen and Close finds the same place`, async ({ browser }) => {
    const { context, page } = await windowAt(browser, 390, 844, true);
    try {
      await open(page);
      const body = page.locator('.ib-gbody');
      await body.evaluate((el) => {
        el.scrollTop = 300;
      });
      const place = await body.evaluate((el) => el.scrollTop);
      await page.locator('.ib-vcomments').tap();
      const sheet = page.locator('.ib-gpanel');
      await expect(sheet).toBeVisible();
      await page.setViewportSize({ width: 844, height: 390 });
      await expect.poll(async () => sheet.boundingBox()).toEqual({ x: 0, y: 0, width: 844, height: 390 });
      await expectCovered(page, 844, 390);
      await page.setViewportSize({ width: 390, height: 844 });
      await expect.poll(async () => sheet.boundingBox()).toEqual({ x: 0, y: 0, width: 390, height: 844 });
      await expectCovered(page, 390, 844);
      await sheet.getByRole('button', { name: 'Close the comments' }).tap();
      await expect(sheet).toBeHidden();
      expect(await body.evaluate((el) => el.scrollTop)).toBe(place);
    } finally {
      await context.close();
    }
  });
}

test('a phone, a pull request: a comment chosen in the sheet closes it, to show its lines', async ({ browser }) => {
  const { context, page } = await windowAt(browser, 390, 844, true);
  try {
    await opens['a pull request'](page);
    await page.locator('.ib-vcomments').tap();
    const sheet = page.locator('.ib-gpanel');
    await sheet.getByText('Log the attempt number before giving up.').tap();
    await expect(sheet).toBeHidden();
    await expect(page.locator(`[data-guide-file-shell="${SHORT_FILE}"] [data-column-number="26"]`).first()).toBeInViewport();
  } finally {
    await context.close();
  }
});

for (const route of ['tap', 'keyboard'] as const) {
  test(`a phone, a guided review: a selection bar on the page goes when Comments opens by ${route === 'tap' ? 'a tap' : 'a key'}, and nothing floats over the sheet`, async ({ browser }) => {
    const { context, page } = await windowAt(browser, 390, 844, true);
    try {
      // An agent that can answer, as Show me's spec has a live one: only then does a selection open on the bar.
      await page.route(/\/threads\/[^/]+\/ask(\?.*)?$/, (ask) => ask.fulfill({ json: { conversation: null, running: null, can_ask: true } }));
      await openReview(world, page);
      const line = page.locator(`[data-guide-file-shell="${SHORT_FILE}"] [data-line-type="change-addition"][data-column-number="4"]`).first();
      await expect(line).toBeVisible({ timeout: 30_000 });
      await page.waitForTimeout(300);
      await line.click();
      const bar = page.locator('[data-selection-chooser]');
      await expect(bar).toBeVisible();
      const at = (await bar.boundingBox())!;
      const button = page.locator('.ib-vcomments');
      if (route === 'tap') await button.tap();
      else {
        await button.focus();
        await page.keyboard.press('Enter');
      }
      await expect(page.locator('.ib-gpanel')).toBeVisible();
      await expect(bar).toHaveCount(0);
      await expectCovered(page, 390, 844);
      expect(await page.evaluate(([x, y]) => !!document.elementFromPoint(x!, y!)?.closest('.ib-gpanel'), [at.x + at.width / 2, at.y + at.height / 2])).toBe(true);
    } finally {
      await context.close();
    }
  });
}

test('a phone: the worst case stays in the sheet, thirty comments and a long one on a long file name', async ({ browser }) => {
  const { context, page } = await windowAt(browser, 320, 568, true);
  try {
    await seedPull(page, [
      { file: LONG_FILE, line: 3, text: `${'A long comment that goes on. '.repeat(30)}https://example.com/${'unbroken'.repeat(30)}` },
      ...Array.from({ length: 29 }, (_, i) => ({ file: LONG_FILE, line: i + 1, text: `Comment ${i + 1}.` })),
    ]);
    await openPull(world, page);
    await page.locator('.ib-vcomments').tap();
    const sheet = page.locator('.ib-gpanel');
    await expect(sheet).toBeVisible();
    await expect(sheet.locator('.ib-sheet-h')).toContainText('30');
    // Nothing runs off the screen sideways, and the list scrolls to its last comment inside the sheet.
    const wide = await sheet.evaluate((el) => [...el.querySelectorAll('*')].filter((child) => child.getBoundingClientRect().right > innerWidth + 0.5 && !child.closest('[data-annotation-panel] [style*="overflow"]')).length);
    expect(wide).toBe(0);
    const last = sheet.getByText('Comment 29.', { exact: true });
    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeInViewport();
    expect((await sheet.boundingBox())!.height).toBe(568);
  } finally {
    await context.close();
  }
});

test('a desktop: the panel is the docked column or the 300 px sheet at the right edge, under the bars', async ({ browser }) => {
  // The review's own fold is 1500 px wide. A pull request's page sits beside the open sidebar, not over it, so its
  // window needs the sidebar's width more than that to keep the column docked; the panel's edge is the review's.
  const reviewRight = async (page: Page) => {
    const review = (await page.locator('.ib-review').boundingBox())!;
    return review.x + review.width;
  };
  for (const [name, open] of Object.entries(opens)) {
    const docked = await windowAt(browser, 1900, 900, false);
    try {
      await open(docked.page);
      const panel = (await docked.page.locator('.ib-gpanel').boundingBox())!;
      expect(panel.width).toBe(300);
      expect(panel.x + panel.width).toBe(await reviewRight(docked.page));
      expect(panel.y, name).toBeGreaterThan(0);
      await expect(docked.page.locator('.ib-vhead')).toBeVisible();
      await expect(docked.page.locator('.ib-gbody')).toBeVisible();
    } finally {
      await docked.context.close();
    }
    for (const width of [1100, 800]) {
      const folded = await windowAt(browser, width, 800, false);
      try {
        await open(folded.page);
        await folded.page.locator('.ib-vcomments').click();
        const sheet = folded.page.locator('.ib-gpanel');
        await expect(sheet).toBeVisible();
        const box = (await sheet.boundingBox())!;
        // 300 px, or the diff's width when that is less (a pull request beside the sidebar at 800).
        const diff = (await folded.page.locator('.ib-gbody').boundingBox())!;
        expect(box.width).toBe(Math.min(300, diff.width));
        expect(box.x + box.width).toBe(await reviewRight(folded.page));
        expect(box.y, name).toBeGreaterThan(0);
        expect(await sheet.evaluate((el) => getComputedStyle(el).position)).toBe('absolute');
        await expect(folded.page.locator('.ib-vhead')).toBeVisible();
        await expect(folded.page.locator('.ib-gbody')).toBeVisible();
        // Its row and its Edit and Delete keep their desktop sizes.
        expect((await sheet.locator('.ib-sheet-h').boundingBox())!.height).toBe(44);
        const action = (await sheet.locator('[data-annotation-panel] .ml-auto button').first().boundingBox())!;
        expect(action.width).toBe(24);
      } finally {
        await folded.context.close();
      }
    }
  }
});
