/**
 * The thread's foot with the reply box closed keeps ONE row where it can
 * (the owner on the stacked foot beside a file, 2026-10-25: "We can make the
 * text shorter before we start multi-lining buttons and stuff on top of each
 * other"). Before the draft status wraps above the buttons, the row shortens,
 * in this order: Edit draft ("Edit"), the open questions button (its icon and
 * the count), then the words after the Draft pill. Only when even that does not
 * fit does the status take its own line.
 *
 * One count per thing (approval "reply-bar-pairs"): the open questions count
 * only the unanswered ones and hold this Send's skip as their list's first row;
 * on a phone Edit draft carries the draft's count ("Draft 2") and no status is
 * drawn, so the row is Send, Draft, the questions: one line at 390 and 320,
 * every target at least 44 px.
 *
 * A real Chromium against the compiled binary: picks, a comment on an attached
 * file and an open question, with and without the file beside the thread, at
 * 1440, 1280, 900, 810 (stacked), 390 and 320 (phones), and a thread with 12
 * questions left open. Screenshots in $PLANNOTATOR_THREAD_FOOT_SHOTS (default
 * .local/proof/thread-foot/). The first test only takes them, so it also runs
 * against an older binary for "before" pictures (`--grep pictures`).
 */

import { expect, test, type Browser, type BrowserContext, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shotsDir = resolve(process.env.PLANNOTATOR_THREAD_FOOT_SHOTS ?? join(repo, '.local/proof/thread-foot'));

const question = (prompt: string, a: string, b: string) => [':::question', prompt, '', `- [ ] ${a}`, `- [ ] ${b}`, ':::'].join('\n');

const CHECKOUT = ['The checkout copy is in copy.md. Two calls before I ship it.', '', question('Ship the new checkout copy?', 'Yes', 'No, revise'), '', question('Keep the yearly price first?', 'Yes', 'No')].join('\n');

const MANY = [
  'The onboarding flow has a lot of open calls; take them as you can.',
  '',
  ...Array.from({ length: 13 }, (_, i) => question(`Onboarding call ${i + 1}: keep step ${i + 1}?`, 'Keep', 'Drop')).flatMap((q) => [q, '']),
].join('\n');

type Sent = { message_id: string; thread_id: string; questions: { key: string; prompt: string; kind: string }[]; attachments?: { id: string }[] };

interface World {
  url: string;
  context: BrowserContext;
  page: Page;
  agent: SimAgent;
  checkout: { thread: string; file: string };
  many: { thread: string; file: string };
}

let world: World;

async function post(path: string, body: unknown): Promise<void> {
  const response = await fetch(`${world.url.replace(/\/$/, '')}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  expect(response.status, await response.clone().text()).toBe(200);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  mkdirSync(shotsDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-threadfoot-e2e-');
  const dataDir = join(root, 'data');
  const trap = join(root, 'bin');
  mkdirSync(trap);
  writeFileSync(join(trap, 'tailscale'), "#!/bin/sh\necho 'inbox-thread-foot.spec: tailscale must not run' >&2\nexit 97\n");
  chmodSync(join(trap, 'tailscale'), 0o755);
  const env = { PATH: `${trap}:${process.env.PATH ?? ''}`, HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  const project = scratchProject(join(root, 'src'), 'acme-checkout');
  writeFileSync(join(project, 'copy.md'), '# Checkout copy\n\nPro plan, billed yearly.\n\nTaxes calculated at the next step.\n');
  const agent = await SimAgent.connect({ binary, env, name: 'Codex', host: 'codex' });
  world = { url, context, page, agent, checkout: { thread: '', file: '' }, many: { thread: '', file: '' } };
  const checkout = (await agent.send({ project_path: project, subject: 'Checkout redesign is running locally', thread: 'checkout', body: CHECKOUT, attachments: ['copy.md'] })) as Sent;
  const many = (await agent.send({ project_path: project, subject: 'Onboarding: thirteen calls', thread: 'onboarding', body: MANY, attachments: ['copy.md'] })) as Sent;
  await post(`/api/inbox/messages/${checkout.message_id}/picks`, {
    questions: [{ key: checkout.questions[0]!.key, revision: 0, answer: { v: 1, key: checkout.questions[0]!.key, kind: 'single', prompt: checkout.questions[0]!.prompt, selected: ['Yes'] } }],
  });
  await post(`/api/inbox/messages/${many.message_id}/picks`, {
    questions: [{ key: many.questions[0]!.key, revision: 0, answer: { v: 1, key: many.questions[0]!.key, kind: 'single', prompt: many.questions[0]!.prompt, selected: ['Keep'] } }],
  });
  for (const [sent, id] of [[checkout, 'ann-checkout'], [many, 'ann-many']] as const) {
    await post('/api/inbox/annotations', {
      attachment_id: sent.attachments![0]!.id,
      version: 'current',
      annotation: { id, type: 'COMMENT', text: 'Say "billed yearly" once.', originalText: 'Pro plan, billed yearly.', blockId: 'block-1', startOffset: 0, endOffset: 0, createdA: 1 },
    });
  }
  world.checkout = { thread: checkout.thread_id, file: checkout.attachments![0]!.id };
  world.many = { thread: many.thread_id, file: many.attachments![0]!.id };
});

test.afterAll(async () => {
  try {
    if (!world) return;
    await world.agent.close().catch(() => {});
    await world.context.close();
  } finally {
    await removeInboxScratch();
  }
});

type Layout = { width: number; file: boolean; thread: 'checkout' | 'many' };

const LAYOUTS: Layout[] = [
  { width: 1440, file: false, thread: 'checkout' },
  { width: 1440, file: true, thread: 'checkout' },
  { width: 1280, file: false, thread: 'checkout' },
  { width: 1280, file: true, thread: 'checkout' },
  { width: 900, file: false, thread: 'checkout' },
  { width: 810, file: false, thread: 'checkout' },
  { width: 390, file: false, thread: 'checkout' },
  { width: 320, file: false, thread: 'checkout' },
  { width: 1440, file: true, thread: 'many' },
  { width: 1280, file: true, thread: 'many' },
  { width: 810, file: false, thread: 'many' },
];

const nameOf = (l: Layout) => `${l.thread}-${l.width}${l.file ? '-file' : ''}`;

/** Opens the thread (with its file beside it) at that width, and waits for the foot's Edit draft. */
async function open(l: Layout): Promise<void> {
  const { page } = world;
  const t = world[l.thread];
  await page.setViewportSize({ width: l.width, height: l.width < 500 ? 844 : 900 });
  await page.goto(`${world.url}#thread=${t.thread}${l.file ? `&file=${t.file}&view=side` : ''}`);
  await expect(page.locator('.ib-pfoot [data-foot-buttons] [data-edit-draft]')).toBeVisible();
  if (l.file) await expect(page.locator('.ib-view').first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
}

/** The foot in one frame: every box of the row on one line, what the row shows, and the thread column's width. */
function measure(page: Page) {
  return page.evaluate(() => {
    const row = document.querySelector('.ib-pfoot [data-foot-row]')!;
    const parts = [...row.querySelectorAll<HTMLElement>('[data-foot-buttons] > *, [data-foot-status] > *')].filter((el) => el.getBoundingClientRect().width > 0);
    const mids = parts.map((el) => {
      const r = el.getBoundingClientRect();
      return r.top + r.height / 2;
    });
    const pane = document.querySelector('section.ib-pane')!.getBoundingClientRect();
    return {
      oneRow: mids.every((m) => Math.abs(m - mids[0]!) < 4),
      text: (row as HTMLElement).innerText.replace(/\s+/g, ' ').trim(),
      fit: row.getAttribute('data-fit'),
      pane: Math.round(pane.width),
      overflow: row.scrollWidth > row.clientWidth + 1,
    };
  });
}

test('pictures: the foot at every width and state', async () => {
  for (const l of LAYOUTS) {
    await open(l);
    await world.page.locator('.ib-pfoot').screenshot({ path: join(shotsDir, `foot-${nameOf(l)}.png`) });
    await world.page.screenshot({ path: join(shotsDir, `window-${nameOf(l)}.png`) });
    console.log(nameOf(l), JSON.stringify(await measure(world.page)));  }
});

test('one row beside a file and in every wide layout; it shortens before it wraps', async () => {
  const { page } = world;
  for (const l of LAYOUTS.filter((x) => x.width >= 810)) {
    await open(l);
    const m = await measure(page);
    expect(m.oneRow, `${nameOf(l)}: ${m.text} (fit ${m.fit}, pane ${m.pane})`).toBe(true);
    expect(m.overflow, nameOf(l)).toBe(false);
  }
  // Beside a file at 1280 the long words give way: never "Edit draft" on two lines, never the status above Send.
  await open({ width: 1280, file: true, thread: 'checkout' });
  const beside = await measure(page);
  expect(beside.oneRow).toBe(true);
  // The accessible names keep the full words whatever is drawn.
  const foot = page.locator('.ib-pfoot [data-foot-buttons]');
  await expect(foot.getByRole('button', { name: 'Edit draft' })).toBeVisible();
  // One count per thing: the picked question is the draft's, so the open questions count the other one.
  await expect(foot.locator('[data-open-questions]')).toHaveAccessibleName('1 open question');
  // No skip chip in the foot; Send is still described by the draft and the skip.
  await expect(page.locator('.ib-pfoot [data-skip-chip], .ib-pfoot [data-skip-toggle]')).toHaveCount(0);
  await expect(foot.locator('.ib-btn.ib-pri')).toHaveAccessibleDescription(/1 pick, 1 comment.*1 question stays open/);
});

/** The phone row: each button's box, in order, and whether a status or chip is drawn. */
function phoneRow(page: Page) {
  return page.evaluate(() => {
    const row = document.querySelector('.ib-pfoot [data-foot-row]')!;
    const buttons = [...row.querySelectorAll<HTMLElement>('[data-foot-buttons] > button')].filter((b) => b.getBoundingClientRect().width > 0);
    const boxes = buttons.map((b) => {
      const r = b.getBoundingClientRect();
      return { name: b.getAttribute('aria-label') ?? b.innerText.replace(/\s+/g, ' ').trim(), text: b.innerText.replace(/\s+/g, ' ').trim(), w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top) };
    });
    return {
      boxes,
      oneLine: boxes.every((b) => Math.abs(b.top - boxes[0]!.top) < 2),
      rowHeight: Math.round(row.getBoundingClientRect().height),
      status: !!row.querySelector('[data-foot-status], [data-skip-chip], [data-draft-foot]'),
      overflow: row.scrollWidth > row.clientWidth + 1,
    };
  });
}

for (const width of [390, 320]) {
  test(`a phone at ${width}: Send first, one Draft button with the draft's count, the unanswered questions; one line, 44 px targets, no status`, async () => {
    const { page } = world;
    await open({ width, file: false, thread: 'checkout' });
    const m = await phoneRow(page);
    expect(m.status).toBe(false);
    expect(m.oneLine, JSON.stringify(m.boxes)).toBe(true);
    expect(m.overflow).toBe(false);
    expect(m.boxes.map((b) => b.name)).toEqual(['Send', 'Draft 2: 1 pick, 1 comment. Edit draft', '1 open question']);
    // "✎ Draft 2": the pick and the comment, once each, on one button.
    expect(m.boxes[1]!.text).toBe('Draft 2');
    for (const b of m.boxes) {
      expect(b.w, b.name).toBeGreaterThanOrEqual(44);
      expect(b.h, b.name).toBeGreaterThanOrEqual(44);
    }
    // The keys are unchanged: R on Edit draft, Q on the open questions.
    const buttons = page.locator('.ib-pfoot [data-foot-buttons]');
    await expect(buttons.locator('[data-edit-draft]')).toHaveAttribute('aria-keyshortcuts', 'R');
    await expect(buttons.locator('[data-open-questions]')).toHaveAttribute('aria-keyshortcuts', 'Q');
    await expect(buttons.locator('.ib-btn.ib-pri')).toHaveAccessibleDescription(/^Draft, 1 pick, 1 comment\b.*1 question stays open/);
    await page.locator('.ib-pfoot').screenshot({ path: join(shotsDir, `foot-checkout-${width}-pairs.png`) });

    // The skip for this Send: the sheet's first row. Skip it, then the button reads "1 to skip" (or the count with
    // the skip glyph where the words do not fit), still one line; Keep open undoes it.
    await buttons.locator('[data-open-questions]').click();
    const row = page.locator('[data-open-questions-list] [data-open-questions-skip-row]');
    await expect(row).toHaveAttribute('data-open-questions-skip-row', 'keep');
    await expect(row).toContainText('1 stays open when you send');
    const toggle = row.locator('[data-skip-toggle]');
    const tap = await toggle.boundingBox();
    expect(tap!.height).toBeGreaterThanOrEqual(44);
    await toggle.click();
    await expect(row).toHaveAttribute('data-open-questions-skip-row', 'skip');
    await expect(row).toContainText('1 skipped when you send');
    await page.screenshot({ path: join(shotsDir, `sheet-checkout-${width}-skipped.png`) });
    await page.locator('[data-open-questions-close]').click();
    await expect(page.locator('[data-open-questions-list]')).toHaveCount(0);
    await expect(buttons.locator('[data-open-questions]')).toHaveAccessibleName('1 question skipped when you send');
    await expect(buttons.locator('[data-open-questions] [data-oq-words]')).toHaveText(/^1( to skip)?$/);
    const after = await phoneRow(page);
    expect(after.oneLine, JSON.stringify(after.boxes)).toBe(true);
    expect(after.overflow).toBe(false);
    await expect(buttons.locator('.ib-btn.ib-pri')).toHaveAccessibleDescription(/1 question will be skipped/);
    await buttons.locator('[data-open-questions]').click();
    await row.locator('[data-skip-toggle]').click();
    await expect(row).toHaveAttribute('data-open-questions-skip-row', 'keep');
    await page.locator('[data-open-questions-close]').click();
    await expect(buttons.locator('[data-open-questions]')).toHaveAccessibleName('1 open question');
  });
}

test('step 4 keeps the comment count in the Draft pill; the pick words go', async () => {
  const { page } = world;
  for (const l of [{ width: 1440, file: true, thread: 'checkout' }, { width: 1280, file: true, thread: 'checkout' }] as Layout[]) {
    await open(l);
    const m = await measure(page);
    expect(m.fit, nameOf(l)).toContain('draft');
    await expect(page.locator('.ib-pfoot [data-draft-pill-count]'), nameOf(l)).toBeVisible();
    await expect(page.locator('.ib-pfoot [data-draft-pill-count]')).toHaveText('1');
    // Visually hidden text (a 1 px clipped box), not removed.
    expect(await page.locator('.ib-pfoot .ib-draft-foot .ib-st').evaluate((el) => el.getBoundingClientRect().width), nameOf(l)).toBeLessThanOrEqual(1);
    // The words stay for a screen reader: Send is described by all of it.
    await expect(page.locator('.ib-pfoot [data-foot-buttons] .ib-btn.ib-pri')).toHaveAccessibleDescription(/^Draft, 1 pick, 1 comment\b/);
    // The pill's count is the comments button; the clipped words leave the Tab order.
    const words = page.locator('.ib-pfoot button[data-draft-comments]');
    expect(await words.evaluate((el: HTMLElement) => (el.focus(), document.activeElement === el)), nameOf(l)).toBe(false);
    const pill = page.locator('.ib-pfoot button[data-draft-pill-count]');
    await pill.click();
    await expect(page.getByRole('dialog', { name: '1 comment', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(pill).toBeFocused();
  }
  // Wide enough for the words: no count in the pill, the words as before.
  await open({ width: 1440, file: false, thread: 'checkout' });
  await expect(page.locator('.ib-pfoot [data-draft-pill-count]')).toBeHidden();
  expect(await page.locator('.ib-pfoot .ib-draft-foot .ib-st').evaluate((el) => el.getBoundingClientRect().width)).toBeGreaterThan(40);
});

test('with no comments beside a file: one row, no count in the pill; at step 4 the pill reads "Draft" alone', async () => {
  const { page } = world;
  // Last test: it removes the checkout thread's comment.
  const removed = await fetch(`${world.url.replace(/\/$/, '')}/api/inbox/annotations/ann-checkout/remove`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  expect(removed.status, await removed.clone().text()).toBe(200);
  await open({ width: 1440, file: true, thread: 'checkout' });
  const m = await measure(page);
  expect(m.oneRow, m.text).toBe(true);
  expect(m.overflow).toBe(false);
  // With the skip chip gone "Draft, 1 pick" may fit whole; where it does not, step 4 leaves the pill alone.
  const words = page.locator('.ib-pfoot .ib-draft-foot .ib-st');
  if (m.fit?.split(' ').includes('draft')) expect(await words.evaluate((el) => el.getBoundingClientRect().width)).toBeLessThanOrEqual(1);
  else await expect(words).toHaveText('1 pick');
  await expect(page.locator('.ib-pfoot [data-draft-pill-count]')).toHaveCount(0);
  await expect(page.locator('.ib-pfoot .ib-draft-pill')).toHaveText(/^Draft,?$/);
  await expect(page.locator('.ib-pfoot [data-foot-buttons] .ib-btn.ib-pri')).toHaveAccessibleDescription(/^Draft, 1 pick\b/);
  await page.locator('.ib-pfoot').screenshot({ path: join(shotsDir, 'foot-checkout-1440-file-no-comments.png') });
});
