/**
 * The code review app's keys on a review in the Inbox (approval 2026-11-23: "Yes, the same keys as code review",
 * "Yes, the review's keys win while a review is open"), by real key presses against the compiled binary, in the scratch
 * world of inbox-review-comments-phone-world.ts: a teammate's pull request and an agent's guided review of the same two
 * files (a 120-line file and a 40-line one, each one change; the PR's page lists them as its tree does, the guided review
 * as its chapters do, so the walk reads the order off the page).
 *
 * What is proved, on a PR's page and on a guided review: Home, J and K move between files and never between threads;
 * N and Shift+N go to the next and previous change, across files, and open nothing; X folds the file on screen and Z
 * opens it again; C, whose feature the Inbox's review lacks (file comments), does nothing and never opens New message;
 * Escape still leaves; and once the review is gone C is New message again and J / K step threads. The picture
 * (review-parity/b7-01-next-change-light.png) is the PR's page after N.
 */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from './inbox-test';
import { openPull, openReview, startWorld, stopWorld, windowAt, type PhoneWorld } from './inbox-review-comments-phone-world';

const repo = resolve(__dirname, '../..');
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'review-parity');

let world: PhoneWorld;
let other: string;
test.describe.configure({ mode: 'serial' });
test.use({ actionTimeout: 20_000 });

test.beforeAll(async ({ browser }) => {
  world = await startWorld(browser);
  // A second thread, for J / K to step to once the review is gone.
  const sent = await world.agent.send({ project_path: world.project, thread: 'keys-other', subject: 'Another thread', body: 'Something else.' });
  other = String(sent.thread_id);
});

test.afterAll(async () => {
  await stopWorld(world);
});

/** Where a file's top is, from the top of the review's scroller. */
const placeOf = (page: Page, path: string) =>
  page.locator(`[data-guide-file-shell="${path}"]`).evaluate((shell) => {
    const scroller = shell.closest('.ib-gbody') ?? document.documentElement;
    return Math.round(shell.getBoundingClientRect().top - scroller.getBoundingClientRect().top);
  });
const changeIn = (page: Page, path: string) => page.locator(`[data-guide-file-shell="${path}"] [data-line-type^="change-"]`).first();
const newMessage = (page: Page) => page.getByRole('dialog', { name: /New message/ });
const arrowOf = (page: Page, path: string) => page.locator(`[data-guide-file-shell="${path}"] [data-file-collapse-toggle]`).first();

/** The review's files in the order drawn. */
const filesOf = (page: Page) =>
  page.locator('[data-guide-file-shell]').evaluateAll((shells) => shells.map((shell) => (shell as HTMLElement).dataset.guideFileShell ?? ''));
/** Whether a file has been brought to the top of the view, or as near as the scroller goes (it is at its end). */
const atTop = (page: Page, path: string) =>
  page.locator(`[data-guide-file-shell="${path}"]`).evaluate((shell) => {
    const scroller = (shell.closest('.ib-gbody') as HTMLElement | null) ?? document.documentElement;
    const top = shell.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    return (top < 200 && top > -40) || (top > 0 && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2);
  });

/** Keys from the page itself, as after a click on nothing in particular. */
async function fromThePage(page: Page): Promise<void> {
  await expect(page.locator('[data-review-keys]')).toHaveCount(1);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
}

async function walk(page: Page, picture?: string): Promise<void> {
  const route = () => page.evaluate(() => location.hash);
  const at = await route();
  await fromThePage(page);
  const [FIRST, SECOND] = await filesOf(page);
  expect(SECOND).toBeTruthy();
  expect(await placeOf(page, SECOND!)).toBeGreaterThan(600);

  // Home: the first file at the top of the view, from further down. J: the next file there; K back. The route (the
  // thread, the PR) stays.
  await page.locator(`[data-guide-file-shell="${SECOND}"]`).evaluate((shell) => shell.scrollIntoView({ block: 'start' }));
  await expect.poll(() => placeOf(page, FIRST!)).toBeLessThan(-100);
  await page.keyboard.press('Home');
  await expect.poll(() => placeOf(page, FIRST!)).toBeLessThan(60);
  await page.keyboard.press('j');
  await expect.poll(() => atTop(page, SECOND!)).toBe(true);
  await expect(page.locator(`[data-guide-file-shell="${SECOND}"]`)).toBeInViewport();
  await page.keyboard.press('k');
  await expect.poll(() => placeOf(page, FIRST!)).toBeLessThan(60);
  expect(await route()).toBe(at);

  // N: on to the next change until it is the other file's (the first press from the top of the page can land on the
  // first file's own change, as in the review app); Shift+N back to the first file's. Nothing opens.
  await expect(async () => {
    await page.keyboard.press('n');
    await expect(changeIn(page, SECOND!)).toBeInViewport({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  expect(await placeOf(page, SECOND!)).toBeLessThan(600);
  expect(await route()).toBe(at);
  await expect(newMessage(page)).toHaveCount(0);
  if (picture) {
    mkdirSync(proofDir, { recursive: true });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(proofDir, picture) });
  }
  await page.keyboard.press('Shift+N');
  // The first file's change starts at its top: back there, its top is on screen again.
  await expect.poll(() => placeOf(page, FIRST!), { timeout: 10_000 }).toBeGreaterThan(-200);
  expect(await placeOf(page, FIRST!)).toBeLessThan(700);

  // X folds the file on screen, Z opens it again (and undoes nothing).
  await page.keyboard.press('x');
  await expect(arrowOf(page, FIRST!)).toHaveAttribute('data-file-collapse-toggle', 'collapsed');
  await page.keyboard.press('z');
  await expect(arrowOf(page, FIRST!)).toHaveAttribute('data-file-collapse-toggle', 'expanded');

  // C: no file comments in the Inbox's review yet, so nothing, and never New message.
  await page.keyboard.press('c');
  await page.waitForTimeout(300);
  await expect(newMessage(page)).toHaveCount(0);
  expect(await route()).toBe(at);
}

test('on a PR’s page the review’s keys win, and the Inbox’s come back on the way out', async ({ browser }) => {
  const { context, page } = await windowAt(browser, 1440, 900, false, 'light');
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await openPull(world, page);
    await walk(page, 'b7-01-next-change-light.png');

    // Out of the review: C is New message again.
    await page.locator('[data-pull-review] .ib-back').first().click();
    await expect(page.locator('[data-review-keys]')).toHaveCount(0);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
    await page.keyboard.press('c');
    await expect(newMessage(page)).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('on a guided review the review’s keys win; Escape still leaves, and J / K step threads again', async ({ browser }) => {
  const { context, page } = await windowAt(browser, 1440, 900, false, 'light');
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await openReview(world, page);
    await walk(page);

    await page.keyboard.press('Escape');
    await expect(page.locator('[data-review-message]')).toHaveCount(0);
    await expect(page.locator('[data-review-keys]')).toHaveCount(0);
    const thread = () => page.evaluate(() => new URLSearchParams(location.hash.slice(1)).get('thread'));
    expect(await thread()).toBe(world.thread);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
    // The other thread is the one next to it in the list, above or below: K or J goes there, the other key back.
    let back = 'k';
    await page.keyboard.press('j');
    if (!(await expect.poll(thread, { timeout: 2_000 }).toBe(other).then(() => true, () => false))) {
      await page.keyboard.press('k');
      back = 'j';
      await expect.poll(thread).toBe(other);
    }
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
    await page.keyboard.press(back);
    await expect.poll(thread).toBe(world.thread);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
