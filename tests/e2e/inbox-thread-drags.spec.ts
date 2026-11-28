/**
 * Dragging a thread row (approval "inbox-drag-threads", drag-system.html; packages/inbox/components/listDrops.tsx and
 * EmptyThreadPanel.tsx), in a real browser against the compiled binary, at 1440 by 900, with an agent writing through
 * `plannotator inbox mcp` (scripts/inbox-sim.ts). A real pointer: pressed on a row, moved in steps, let go.
 *
 * - The list's edges: nothing shows until a row is carried; then Priority docks over the list's top and Archive and
 *   Quiet over its bottom. A drop on Priority adds the row to Priority with the menu's toast, whose Undo takes it out;
 *   Archive takes it out of the list, and its Undo brings it back; Quiet marks it read. A place that takes the row is
 *   its name alone. A row already in Priority: Priority greyed, "Already in Priority", and a drop changes nothing. Two ⌘-picked rows go to the archive together, one toast.
 * - Combine: a row held on another for a moment opens the Combine dialog with both, Cancel focused; nothing combines.
 * - The empty thread panel (the ⋮'s Keep thread panel open), with the free layout's switch off and on: "Open here"
 *   while a row is carried, and the drop opens that thread.
 * - An Undo toast up over the bottom edge does not stand in the way: the place under it takes the drop.
 * - The free layout's whole pane area (switch on): a row let go on its right rim opens a column the area's full height
 *   beside every pane where the room holds a third column (1920 x 1080), and says "No room on the right" and changes
 *   nothing where it does not (1440 x 900). Boxes are read once the layout has settled.
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-thread-drags.spec.ts`.
 */
import { expect, test, type Locator, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { E2E_LAUNCH_OFF, inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(resolve(__dirname, '../..'), '.local/plannotator'));
const ASK = ['Two options, both under 50 ms.', '', ':::question', 'Which search index?', '', '- [ ] Pagefind', '- [ ] Orama', ':::'].join('\n');
const PANEL_COOKIE = 'plannotator-inbox-thread-panel';

interface Inbox {
  url: string;
  agent: SimAgent;
  path: string;
  send: (subject: string, body?: string) => Promise<string>;
}

let off: Inbox;
let on: Inbox;

async function start(prefix: string, splitView: boolean): Promise<Inbox> {
  const root = inboxScratch(prefix);
  const data = join(root, 'data');
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, 'config.json'), JSON.stringify({ ...E2E_LAUNCH_OFF, ...(splitView ? { inboxSplitView: true } : {}) }));
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9', PLANNOTATOR_DATA_DIR: data, PLANNOTATOR_TEST_SANDBOX: root, PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_INBOX_TAILSCALE: '0', PLANNOTATOR_INBOX_PHONES: '0', PLANNOTATOR_INBOX_NOTES: '0', PLANNOTATOR_UPDATE_CHECK: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(data);
  const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const path = scratchProject(join(root, 'src'), 'billing-svc');
  let n = 0;
  const send = async (subject: string, body = `${subject}. Nothing to answer.`) =>
    String((await agent.send({ project_path: path, subject, body, agent_session: `ses_drags_${n++}` } as Parameters<SimAgent['send']>[0])).thread_id);
  return { url: started.stdout.trim().replace(/\/$/, ''), agent, path, send };
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  off = await start('inbox-thread-drags-off-', false);
  on = await start('inbox-thread-drags-on-', true);
});

test.afterAll(async () => {
  try {
    await off?.agent.close().catch(() => {});
    await on?.agent.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

const body = (page: Page) => page.locator('.ib-listcol .ib-lbody');
const row = (page: Page, id: string) => body(page).locator(`[data-thread-id="${id}"]`);
const group = (page: Page, id: string) => body(page).locator(`.ib-group[data-section-id="${id}"]`);
const place = (page: Page, name: 'priority' | 'archive' | 'quiet') => page.locator(`[data-thread-place="${name}"]`);
const toast = (page: Page) => page.locator('[data-inbox-toast]');

/** A box once it stops moving (rows slide into place after a list read): two reads a frame apart agree. */
async function settledBox(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  await expect(locator).toBeVisible();
  let last = await locator.boundingBox();
  for (let i = 0; i < 40; i++) {
    await locator.page().waitForTimeout(50);
    const now = await locator.boundingBox();
    if (now && last && now.x === last.x && now.y === last.y && now.width === last.width && now.height === last.height) return now;
    last = now;
  }
  throw new Error('the box never settled');
}

const centre = (box: { x: number; y: number; width: number; height: number }) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

/** Press a row and carry it past the threshold: the drag is on, the button still held. */
async function pickUp(page: Page, id: string): Promise<void> {
  const box = await settledBox(row(page, id));
  await page.mouse.move(box.x + 60, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 72, box.y + box.height / 2 + 6, { steps: 3 });
  await expect(page.locator('[data-thread-ghost]').last()).toBeVisible();
}

/** Carry the held row to `to` in steps, as a hand moves. */
async function carryTo(page: Page, to: { x: number; y: number }): Promise<void> {
  await page.mouse.move(to.x, to.y, { steps: 12 });
}

async function onServer(page: Page, inbox: Inbox, id: string) {
  const model = (await (await page.request.get(`${inbox.url}/api/inbox/threads?archived=exclude&snoozed=exclude`)).json()) as { sections: { id: string; threads: { thread_id: string; priority?: { at: string } | null; read_at?: string | null }[] }[] };
  for (const section of model.sections) {
    const found = section.threads.find((r) => r.thread_id === id);
    if (found) return { section: section.id, priority: found.priority ?? null, read: (found.read_at ?? null) !== null };
  }
  return null;
}

test('the list edges: shown only while a row is carried; Priority, Archive and Quiet each run the menu action with its toast and Undo', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const ask = await off.send('Which search index should the docs use?', ASK);
  const first = await off.send('Release notes draft');
  const second = await off.send('Install page links fixed');
  const third = await off.send('Changelog drafted');
  await page.goto(off.url);
  await expect(row(page, third)).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.ib-tedge')).toHaveCount(0);

  // Priority: the place shows once the row is carried, lights under the pointer, and the drop adds it.
  await pickUp(page, first);
  // Each place that takes the row is its name alone, no description line.
  await expect(place(page, 'priority')).toHaveText('Priority');
  await expect(place(page, 'archive')).toHaveText('Archive');
  await expect(place(page, 'quiet')).toHaveText('Quiet');
  await carryTo(page, centre(await settledBox(place(page, 'priority'))));
  await expect(place(page, 'priority')).toHaveAttribute('data-hot', '');
  await expect(page.locator('[data-thread-ghost] .ib-tdrag-w').last()).toHaveText('Priority');
  await page.mouse.up();
  await expect(page.locator('.ib-tedge')).toHaveCount(0);
  await expect(toast(page)).toContainText('Added to Priority');
  await expect(group(page, 'priority').locator(`[data-thread-id="${first}"]`)).toBeVisible();
  expect((await onServer(page, off, first))?.priority).not.toBeNull();
  await toast(page).locator('[data-toast-undo]').click();
  await expect(group(page, 'priority')).toHaveCount(0);
  await expect.poll(async () => (await onServer(page, off, first))?.priority ?? null).toBeNull();

  // A row already in Priority: greyed, says so, and a drop there changes nothing.
  await row(page, second).click({ button: 'right' });
  await page.locator('[data-row-menu] [data-row-action="priority-add"]').click();
  await expect(group(page, 'priority').locator(`[data-thread-id="${second}"]`)).toBeVisible();
  await expect(toast(page)).toContainText('Added to Priority');

  // Archive while that toast is still up over the list's bottom (the places draw above it and a drop never lands on
  // it): red only under the pointer; the row leaves the list, and Undo brings it back.
  await pickUp(page, third);
  await expect(toast(page)).toBeVisible();
  await carryTo(page, centre(await settledBox(place(page, 'archive'))));
  await expect(place(page, 'archive')).toHaveAttribute('data-hot', '');
  await expect(place(page, 'quiet')).not.toHaveAttribute('data-hot', '');
  await page.mouse.up();
  await expect(toast(page)).toContainText('Archived');
  await expect.poll(async () => await onServer(page, off, third)).toBeNull();
  await toast(page).locator('[data-toast-undo]').click();
  await expect.poll(async () => (await onServer(page, off, third))?.section ?? null).not.toBeNull();
  await expect(row(page, third)).toBeVisible();

  await pickUp(page, second);
  await expect(place(page, 'priority')).toHaveAttribute('data-refused', '');
  await expect(place(page, 'priority')).toContainText('Already in Priority');
  await carryTo(page, centre(await settledBox(place(page, 'priority'))));
  await expect(place(page, 'priority')).not.toHaveAttribute('data-hot', '');
  await page.mouse.up();
  // The drop says why it did nothing.
  await expect(page.locator('[data-thread-drag-live]')).toHaveText('Already in Priority. Nothing changed.');
  await expect(group(page, 'priority').locator(`[data-thread-id="${second}"]`)).toBeVisible();
  expect((await onServer(page, off, second))?.priority).not.toBeNull();

  // Quiet on a row with an open question takes it, its name alone (Mark read's own warning names what it sets aside;
  // no drop here).
  await pickUp(page, ask);
  await expect(place(page, 'quiet')).toHaveText('Quiet');
  await expect(place(page, 'quiet')).not.toHaveAttribute('data-refused');
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(page.locator('.ib-tedge')).toHaveCount(0);
  expect((await onServer(page, off, ask))?.read).toBe(false);

  // Quiet: Mark read.
  await pickUp(page, first);
  await carryTo(page, centre(await settledBox(place(page, 'quiet'))));
  await expect(place(page, 'quiet')).toHaveAttribute('data-hot', '');
  await page.mouse.up();
  await expect(toast(page)).toContainText(/Marked read|Moved to Quiet/);
  await expect.poll(async () => (await onServer(page, off, first))?.read ?? false).toBe(true);
  await toast(page).locator('[data-toast-undo]').click();
  await expect.poll(async () => (await onServer(page, off, first))?.read ?? true).toBe(false);
  expect(errors).toEqual([]);
  await context.close();
});

test('two ⌘-picked rows dropped on Archive go together, one toast; a row held on another opens the Combine dialog', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const a = await off.send('Webhook signatures checked');
  const b = await off.send('Queue drain on shutdown');
  const c = await off.send('Retry worker wired');
  await page.goto(off.url);
  await expect(row(page, c)).toBeVisible({ timeout: 30_000 });

  // Held on another row for a moment (the oldest, lowest of the three, clear of the top edge's place): the dialog, with
  // both, Cancel focused; nothing combines.
  await pickUp(page, c);
  await carryTo(page, centre(await settledBox(row(page, a))));
  await expect(row(page, a)).toHaveAttribute('data-thread-combine', 'on', { timeout: 3_000 });
  await expect(page.locator('.ib-tcomb')).toHaveText('Combine with this thread');
  await page.mouse.up();
  const dialog = page.locator('[data-dialog="combine"]');
  await expect(dialog.locator('h2')).toHaveText('Combine 2 threads');
  await expect(dialog.locator('[data-combine-cancel]')).toBeFocused();
  await dialog.locator('[data-combine-cancel]').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('[data-pick-bar]')).toHaveCount(0);
  expect(await onServer(page, off, a)).not.toBeNull();
  expect(await onServer(page, off, c)).not.toBeNull();

  // Two picked rows carried together onto Archive: one toast for both.
  await row(page, a).click({ modifiers: ['ControlOrMeta'] });
  await row(page, b).click({ modifiers: ['ControlOrMeta'] });
  await expect(page.locator('[data-pick-bar]')).toBeVisible();
  await pickUp(page, b);
  await expect(page.locator('[data-thread-ghost]').last()).toHaveClass(/ib-tdrag-stack/);
  await carryTo(page, centre(await settledBox(place(page, 'archive'))));
  await page.mouse.up();
  await expect(toast(page)).toContainText('Archived 2 threads');
  await expect.poll(async () => [await onServer(page, off, a), await onServer(page, off, b)]).toEqual([null, null]);
  await toast(page).locator('[data-toast-undo]').click();
  await expect.poll(async () => (await onServer(page, off, a)) !== null && (await onServer(page, off, b)) !== null).toBe(true);
  await context.close();
});

for (const world of ['off', 'on'] as const)
  test(`the empty thread panel (free layout switch ${world}): "Open here" while a row is carried, and the drop opens it`, async ({ browser }) => {
    const inbox = world === 'on' ? on : off;
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addCookies([{ name: PANEL_COOKIE, value: '1', url: inbox.url }]);
    const page = await context.newPage();
    const id = await inbox.send(`Search page filters keep their state (${world})`);
    await page.goto(inbox.url);
    await expect(row(page, id)).toBeVisible({ timeout: 30_000 });
    const empty = page.locator('[data-thread-panel-empty]');
    await expect(empty).toHaveText('No thread selected');
    await pickUp(page, id);
    await expect(empty.locator('.ib-topen')).toHaveText('Open here');
    await carryTo(page, centre(await settledBox(empty)));
    await expect(empty).toHaveAttribute('data-thread-drop', 'over');
    await expect(page.locator('[data-thread-ghost] .ib-tdrag-w').last()).toHaveText('Open here');
    // One label: the drag's says it, so the panel's own pill steps out of sight (QA 0.28.67, 056: the two overlapped).
    await expect(empty.locator('.ib-topen')).toBeHidden();
    await page.mouse.up();
    await expect(page.locator(`section.ib-pane[data-thread-id="${id}"]`)).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`#thread=${id}`));
    await expect(empty).toHaveCount(0);
    await context.close();
  });

/** The box around every pane on screen, once two reads a moment apart agree (the layout animates into place). */
async function settledArea(page: Page): Promise<{ left: number; top: number; right: number; bottom: number }> {
  const read = () =>
    page.evaluate(() => {
      const boxes = [...document.querySelectorAll<HTMLElement>('.ib-layout > [data-layout-pane]:not([data-pane-hidden="true"])')].map((el) => el.getBoundingClientRect());
      return boxes.length ? { left: Math.min(...boxes.map((b) => b.left)), top: Math.min(...boxes.map((b) => b.top)), right: Math.max(...boxes.map((b) => b.right)), bottom: Math.max(...boxes.map((b) => b.bottom)) } : null;
    });
  let last = await read();
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(60);
    const now = await read();
    if (now && last && now.left === last.left && now.top === last.top && now.right === last.right && now.bottom === last.bottom) return now;
    last = now;
  }
  throw new Error('the panes never settled');
}

/** Each locator's box, once two reads a moment apart agree for all of them: the panes FLIP into place (200 ms), a new
 * one already where it ends while the others still shrink from their old boxes, so a single read can overlap them. */
async function settledBoxes(locators: Locator[]): Promise<{ x: number; y: number; width: number; height: number }[]> {
  const read = async () => Promise.all(locators.map((locator) => locator.boundingBox()));
  const same = (one: Awaited<ReturnType<typeof read>>, two: Awaited<ReturnType<typeof read>>) =>
    one.every((box, i) => box && two[i] && box.x === two[i]!.x && box.y === two[i]!.y && box.width === two[i]!.width && box.height === two[i]!.height);
  let last = await read();
  for (let i = 0; i < 60; i++) {
    await locators[0]!.page().waitForTimeout(60);
    const now = await read();
    if (same(last, now)) return now.map((box) => box!);
    last = now;
  }
  throw new Error('the boxes never settled');
}

const paneHost = (page: Page, id: string) => page.locator(`.ib-layout > [data-layout-pane]:has(section.ib-pane[data-thread-id="${id}"])`);

/** Opens `first` (a click), then carries `second` to pane `first`'s `side` edge: two panes. */
async function twoPanes(page: Page, first: string, second: string, side: 'right' | 'bottom'): Promise<void> {
  await row(page, first).click();
  await expect(paneHost(page, first)).toBeVisible();
  const box = await settledBox(paneHost(page, first));
  await pickUp(page, second);
  // The bottom edge zone is the pane's lowest 30%, its closed reply bar included (paneDrop.ts); 80% of the height is
  // well inside it and clear of the area's 24 px rim strip, whose drop is the whole bottom instead.
  await carryTo(page, side === 'right' ? { x: box.x + box.width - 60, y: box.y + box.height / 2 } : { x: box.x + box.width / 2, y: box.y + box.height * 0.8 });
  await expect(page.locator('[data-thread-ghost] .ib-tdrag-w').last()).toHaveText(side === 'right' ? 'Open on the right' : 'Open below');
  await page.mouse.up();
  await expect(paneHost(page, second)).toBeVisible();
}

test("the pane area's right rim (switch on, 1920 x 1080): a row opens a column the area's full height beside both panes", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  const a = await on.send('Ledger export columns');
  const b = await on.send('Ledger export totals');
  const c = await on.send('Ledger export audit trail');
  await page.goto(on.url);
  await expect(row(page, c)).toBeVisible({ timeout: 30_000 });
  // a above b: two rows of one pane each.
  await twoPanes(page, a, b, 'bottom');
  const before = await settledArea(page);
  await pickUp(page, c);
  // Inside pane a's own right edge zone it splits a; on the rim it is the whole side.
  await carryTo(page, { x: before.right - 60, y: before.top + 120 });
  await expect(page.locator('[data-thread-ghost] .ib-tdrag-w').last()).toHaveText('Open on the right');
  await carryTo(page, { x: before.right - 6, y: before.top + 120 });
  await expect(page.locator('[data-thread-ghost] .ib-tdrag-w').last()).toHaveText('Open on the right, full height');
  // The preview eases from a's own right zone (a's height) to the rim's in 120 ms (panes.css): read it once it settles.
  const z = await settledBox(page.locator('.ib-droppreview'));
  expect(Math.abs(z.y - before.top)).toBeLessThanOrEqual(1);
  expect(Math.abs(z.y + z.height - before.bottom)).toBeLessThanOrEqual(1);
  expect(Math.abs(z.x + z.width - before.right)).toBeLessThanOrEqual(1);
  await page.mouse.up();
  await expect(paneHost(page, c)).toBeVisible();
  const after = await settledArea(page);
  const [boxA, boxB, boxC] = await settledBoxes([paneHost(page, a), paneHost(page, b), paneHost(page, c)]);
  // c: the whole height, at the right end, beside both.
  expect(Math.abs(boxC.y - after.top)).toBeLessThanOrEqual(1);
  expect(Math.abs(boxC.y + boxC.height - after.bottom)).toBeLessThanOrEqual(1);
  expect(Math.abs(boxC.x + boxC.width - after.right)).toBeLessThanOrEqual(1);
  expect(boxC.x).toBeGreaterThan(boxA.x + boxA.width - 1);
  expect(boxC.x).toBeGreaterThan(boxB.x + boxB.width - 1);
  // a and b still one above the other, each at least the pane minimum.
  expect(boxB.y).toBeGreaterThan(boxA.y + boxA.height - 1);
  for (const box of [boxA, boxB, boxC]) {
    expect(box.width).toBeGreaterThanOrEqual(399);
    expect(box.height).toBeGreaterThanOrEqual(259);
  }
  await context.close();
});

test("the pane area's right rim with no room for a third column (switch on, 1440 x 900): it says so, draws nothing, and nothing changes", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const d = await on.send('Search page filters');
  const e = await on.send('Search page sort order');
  const f = await on.send('Search page empty state');
  await page.goto(on.url);
  await expect(row(page, f)).toBeVisible({ timeout: 30_000 });
  await twoPanes(page, d, e, 'right');
  const before = await settledArea(page);
  const shown = await page.locator('.ib-layout > [data-layout-pane]:not([data-pane-hidden="true"])').count();
  await pickUp(page, f);
  await carryTo(page, { x: before.right - 6, y: (before.top + before.bottom) / 2 });
  await expect(page.locator('[data-thread-ghost] .ib-tdrag-w').last()).toHaveText('No room on the right');
  await expect(page.locator('.ib-droppreview')).toHaveCount(0);
  await page.mouse.up();
  await expect(page.locator('[data-thread-drag-live]')).toHaveText('No room on the right. Nothing changed.');
  await expect(paneHost(page, f)).toHaveCount(0);
  await expect(page.locator('.ib-layout > [data-layout-pane]:not([data-pane-hidden="true"])')).toHaveCount(shown);
  await context.close();
});
