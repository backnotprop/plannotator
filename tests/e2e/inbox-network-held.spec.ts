/**
 * The window never waits on the network to draw what the person typed or clicked, and it asks the network for no more
 * than it needs (data-layer brief, 2026-11-10: the "network held" guard and the request budgets).
 *
 * Against the compiled binary (build it first, see inbox.spec.ts), in a scratch Inbox:
 *  - every write held unanswered: keys typed in "Other…", a pick, Send (busy at once, the words kept) and Mark read
 *    (the ⋯ menu offers Move back at once) all draw within a few frames;
 *  - budgets, counted from the requests the page makes: 60 keys in "Other…" make at most 2 requests and no list or
 *    drafts read; clicking through five threads whose reads are slow reads only the last (the others given up), and
 *    going back to one of them draws it before its read answers; one Send reads the thread no more than once after
 *    it, and draws the sent reply before any such read;
 *  - a Mark read the Inbox refuses puts the row back and shows the Inbox's own error;
 *  - two windows picking different answers on one question 50 ms apart end on the same answer, the later one, with
 *    no raw "changed since you read it" error (pickConflict.ts holds that rule);
 *  - a long thread that receives messages while the person types a reply on a poor link keeps every key, the caret
 *    and the reply box where they were, and draws each new message (each one draws only its own body: stage 3).
 */

import { expect, test, type BrowserContext, type Page, type Request } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));

const BODY = (topic: string) =>
  [`Two choices about ${topic}.`, '', ':::question', `Which layout for ${topic}?`, '', '- [ ] Cards', '- [ ] A dense table', ':::', '', ':::question', `Sort overdue ${topic} first?`, '', '- [ ] Yes', '- [ ] No', ':::'].join('\n');

let url = '';
let claude: SimAgent;
const T: string[] = [];
let project = '';
/** A long thread: its first message, then many updates and a few replies of the person's. */
let long = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-inbox-network-held-e2e-');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: join(root, 'data'), PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  url = started.stdout.trim().replace(/\/$/, '');
  await fetch(`${url}/api/inbox/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notifications: { dismissed: true } }) });
  claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  project = scratchProject(join(root, 'src'), 'billing');
  for (const topic of ['invoices', 'refunds', 'credits', 'taxes', 'payouts', 'disputes', 'plans', 'coupons']) {
    T.push((await claude.send({ project_path: project, subject: `Billing ${topic}`, thread: `billing-${topic}`, body: BODY(topic) }, { wakes: true })).thread_id as string);
  }
  long = (await claude.send({ project_path: project, subject: 'Billing ledger', thread: 'billing-ledger', body: 'The ledger rewrite starts now.' }, { wakes: true })).thread_id as string;
  for (let i = 1; i <= 80; i++) {
    const sent = await claude.send({ project_path: project, thread: 'billing-ledger', body: `Ledger update ${i}.\n\n- one point\n- another with \`code\`\n\n${'Some prose that takes a line or two. '.repeat(4)}` }, { wakes: true });
    if (i % 20 === 0) {
      await fetch(`${url}/api/inbox/messages/${sent.message_id}/reply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idempotency_key: `ledger-${i}`, words: `Noted ${i}.`, questions: [] }) });
    }
  }
});

test.afterAll(async () => {
  try {
    await claude?.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

const pane = (id: string) => `section.ib-pane[data-thread-id="${id}"]`;
const row = (id: string) => `.ib-lbody [data-thread-id="${id}"]`;
const card = (page: Page, id: string, n: number) => page.locator(`${pane(id)} fieldset[data-question-key]`).nth(n);
const api = (r: Request) => new URL(r.url()).pathname.startsWith('/api/inbox/') && !new URL(r.url()).pathname.startsWith('/api/inbox/events');
const threadRead = (r: Request) => r.method() === 'GET' && /^\/api\/inbox\/threads\/msg_[A-Z0-9]+$/.test(new URL(r.url()).pathname);

async function open(context: BrowserContext, thread: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${url}/#thread=${encodeURIComponent(thread)}`);
  await expect(card(page, thread, 1)).toBeVisible();
  return page;
}

/** Ms from `act` until `drawn` holds at a frame, measured in the page. */
async function paintMs(page: Page, act: () => Promise<unknown>, drawn: string): Promise<number> {
  await page.evaluate(() => ((window as unknown as { __t0: number }).__t0 = performance.now()));
  await act();
  return page.evaluate(
    (cond) =>
      new Promise<number>((done) => {
        const ok = new Function(cond) as () => boolean;
        const t0 = (window as unknown as { __t0: number }).__t0;
        const tick = () => (ok() ? done(Math.round(performance.now() - t0)) : performance.now() - t0 > 5000 ? done(-1) : requestAnimationFrame(tick));
        tick();
      }),
    drawn,
  );
}

test('every write held unanswered: typing, a pick, Send and Mark read still draw at once, and 60 keys make at most 2 requests', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await open(context, T[0]!);
  // From here every write waits for good: nothing the person does may wait on one.
  const held: Request[] = [];
  await page.route('**/api/inbox/**', (route) => {
    if (route.request().method() === 'POST') {
      held.push(route.request());
      return;
    }
    return route.fallback();
  });
  // The open's own reads (the look, the list after it, the pane's parts) finish first.
  await page.waitForTimeout(3000);
  const requests: Request[] = [];
  // What typing can cause: a save, a read of the list, the drafts or the thread (the 5 s sessions poll is the pane's own).
  page.on('request', (r) => api(r) && !/\/sessions(\?|$)/.test(new URL(r.url()).pathname) && requests.push(r));

  // 60 keys in "Other…": every key drawn, at most two requests, no list or drafts read.
  const other = card(page, T[0]!, 0).locator('textarea[aria-label^="Other answer"]');
  await other.click();
  const words = 'Cards, but keep the totals pinned at the bottom of the list.';
  expect(words).toHaveLength(60);
  await page.keyboard.type(words, { delay: 15 });
  await expect(other).toHaveValue(words);
  await page.waitForTimeout(1200);
  const typing = requests.splice(0);
  expect(typing.length, typing.map((r) => `${r.method()} ${r.url()}`).join('\n')).toBeLessThanOrEqual(2);
  expect(typing.filter((r) => r.method() === 'GET' && /\/api\/inbox\/(threads|drafts)(\?|$)/.test(r.url()))).toHaveLength(0);

  // A pick: checked at once.
  const pickMs = await paintMs(page, () => card(page, T[0]!, 1).locator('[data-question-option]').first().click(), `return [...document.querySelectorAll('${pane(T[0]!)} fieldset[data-question-key]')][1]?.querySelector('[data-question-option] input:checked') != null`);
  expect(pickMs).toBeGreaterThanOrEqual(0);
  expect(pickMs).toBeLessThan(250);

  // Send: busy at once, the words kept while its saves wait.
  await page.locator(`${pane(T[0]!)} .ib-pfoot`).getByRole('button', { name: /^(Reply|Edit)/ }).first().click();
  const box = page.locator(`${pane(T[0]!)} .ib-rbox textarea`);
  await box.fill('ok go');
  const sendMs = await paintMs(page, () => page.locator(`${pane(T[0]!)} .ib-rbox [data-reply-send]`).click(), `return !!document.querySelector('${pane(T[0]!)} .ib-rbox [data-reply-send]')?.disabled`);
  expect(sendMs).toBeGreaterThanOrEqual(0);
  expect(sendMs).toBeLessThan(250);
  await expect(box).toHaveValue('ok go');
  await expect(other).toHaveValue(words);

  // Mark read on another thread, from the ⋯ menu: read at once, its write still held.
  await page.evaluate((id) => (location.hash = `#thread=${encodeURIComponent(id)}`), T[1]!);
  const more = page.locator(`${pane(T[1]!)} [data-thread-more]`);
  await more.click();
  await page.locator('[data-thread-menu] [data-thread-read-item]').click();
  await more.click();
  await expect(page.locator('[data-thread-menu] [data-thread-move-back-item]')).toBeVisible({ timeout: 1000 });
  await expect.poll(() => held.some((r) => r.url().endsWith(`/threads/${T[1]}/read`))).toBe(true);
  await context.close();
});

test('clicking through five threads whose reads are slow reads only the last, and going back to one draws it before its read answers', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${url}/`);
  // Each opened and read for a moment, so its look has landed and its copy is kept (a record of the thread, its own
  // look's included, drops the copy until the next read: threadCache.ts).
  for (const id of T.slice(2, 7)) {
    await page.locator(row(id)).click();
    await expect(page.locator(`${pane(id)} [data-message-article]`).first()).toBeVisible();
    await page.waitForTimeout(1500);
  }
  await page.waitForTimeout(500);
  // Every read of a thread now takes 800 ms.
  await page.route('**/api/inbox/threads/*', async (route) => {
    if (!threadRead(route.request())) return route.fallback();
    await new Promise((done) => setTimeout(done, 800));
    await route.continue().catch(() => {});
  });
  const finished: Request[] = [];
  const failed: Request[] = [];
  page.on('requestfinished', (r) => threadRead(r) && finished.push(r));
  page.on('requestfailed', (r) => threadRead(r) && failed.push(r));
  const order = [T[7]!, T[6]!, T[5]!, T[4]!, T[3]!];
  for (const id of order) {
    await page.locator(row(id)).click();
    await page.waitForTimeout(100);
  }
  const last = order.at(-1)!;
  await expect(page.locator(`${pane(last)} [data-message-article]`).first()).toBeVisible();
  await page.waitForTimeout(1500);
  // Only the thread landed on was read through; the others were given up as the person moved on.
  expect(finished.length, finished.map((r) => r.url()).join('\n')).toBeLessThanOrEqual(2);
  expect(failed.length).toBeGreaterThanOrEqual(3);
  await expect(page.locator(pane(last))).toBeVisible();

  // Back to the one before: drawn from its last read, well before its 800 ms read answers.
  const back = order.at(-2)!;
  const backMs = await paintMs(page, () => page.locator(row(back)).click(), `return !!document.querySelector('${pane(back)} [data-message-article]')`);
  expect(backMs).toBeGreaterThanOrEqual(0);
  expect(backMs).toBeLessThan(500);
  await context.close();
});

test('one Send draws the reply from its own answer: no read of the thread before it shows, at most one after', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await open(context, T[2]!);
  await card(page, T[2]!, 0).locator('[data-question-option]').first().click();
  await page.waitForTimeout(600);
  const before = await page.locator(`${pane(T[2]!)} [data-message-article]`).count();
  const reads: { at: number; r: Request }[] = [];
  page.on('request', (r) => threadRead(r) && reads.push({ at: Date.now(), r }));
  await page.locator(`${pane(T[2]!)} .ib-pfoot`).getByRole('button', { name: /^(Reply|Edit)/ }).first().click();
  await page.locator(`${pane(T[2]!)} .ib-rbox textarea`).fill('Cards it is.');
  await page.locator(`${pane(T[2]!)} .ib-rbox [data-reply-send]`).click();
  await expect(page.locator(`${pane(T[2]!)} [data-message-article]`)).toHaveCount(before + 1);
  const shownAt = Date.now();
  await page.waitForTimeout(2000);
  expect(reads.filter((x) => x.at < shownAt)).toHaveLength(0);
  expect(reads.length).toBeLessThanOrEqual(1);
  await context.close();
});

test('a Mark read the Inbox refuses puts the row back and shows its own error', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await open(context, T[5]!);
  await page.route('**/api/inbox/threads/*/read', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'The disk is full.', code: 'internal_error' }) }));
  const more = page.locator(`${pane(T[5]!)} [data-thread-more]`);
  await more.click();
  await page.locator('[data-thread-menu] [data-thread-read-item]').click();
  await expect(page.locator('.ib-tlead', { hasText: 'The disk is full.' })).toBeVisible();
  await more.click();
  await expect(page.locator('[data-thread-menu] [data-thread-read-item]')).toBeVisible();
  await expect(page.locator('[data-thread-menu] [data-thread-move-back-item]')).toHaveCount(0);
  await context.close();
});

test('two windows pick different answers on one question 50 ms apart: both end on the later one, with no raw error', async ({ browser }) => {
  const a = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const b = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const pageA = await open(a, T[6]!);
  const pageB = await open(b, T[6]!);
  await pageA.waitForTimeout(500);
  const first = card(pageA, T[6]!, 1).locator('[data-question-option]').nth(0).click();
  await pageA.waitForTimeout(50);
  const second = card(pageB, T[6]!, 1).locator('[data-question-option]').nth(1).click();
  await Promise.all([first, second]);
  for (const page of [pageA, pageB]) {
    await expect(card(page, T[6]!, 1).locator('[data-question-option] input').nth(1)).toBeChecked({ timeout: 10_000 });
    await expect(card(page, T[6]!, 1).locator('[data-question-option] input').nth(0)).not.toBeChecked();
    await expect(page.getByText(/changed since you read it/)).toHaveCount(0);
  }
  const thread = (await (await fetch(`${url}/api/inbox/threads/${T[6]}`)).json()) as { thread: { messages: { questions?: { answer: { selected: string[] } | null }[] }[] } };
  expect(thread.thread.messages[0]!.questions![1]!.answer?.selected).toEqual(['No']);
  await a.close();
  await b.close();
});

test('a long thread receiving messages while the person types a reply on a poor link: every key kept, nothing moves, nothing stuck', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  // A poor link: every read and write takes 700 ms (the live stream itself is not held).
  await page.route('**/api/inbox/**', async (route) => {
    if (new URL(route.request().url()).pathname.startsWith('/api/inbox/events')) return route.fallback();
    await new Promise((done) => setTimeout(done, 700));
    return route.fallback();
  });
  await page.goto(`${url}/#thread=${encodeURIComponent(long)}`);
  const p = pane(long);
  const articles = page.locator(`${p} [data-message-article]`);
  await expect(articles.first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  // Much of the thread open, as a person reading it back has it: the middle fold shown, 40 folded lines opened.
  for (const all of await page.locator(`${p} [data-fold-all]`).all()) await all.click();
  const folded = page.locator(`${p} article[data-folded] [data-fold-head]`);
  for (let i = 0; i < 40 && (await folded.count()) > 0; i++) await folded.first().click();
  await page.locator(`${p} .ib-pfoot`).getByRole('button', { name: /^(Reply|Edit)/ }).first().click();
  const box = page.locator(`${p} .ib-rbox textarea`);
  await expect(box).toBeFocused();
  const before = await articles.count();
  // Reading an earlier message, halfway up: what is on screen must not move as messages land below it.
  const anchor = await page.evaluate((sel) => {
    const body = document.querySelector<HTMLElement>(`${sel} .ib-pbody`)!;
    body.scrollTop = Math.round((body.scrollHeight - body.clientHeight) / 2);
    const view = body.getBoundingClientRect();
    const near = [...body.querySelectorAll<HTMLElement>('[data-message-article]')].find((a) => a.getBoundingClientRect().top >= view.top);
    return { id: near?.getAttribute('data-message-article') ?? null, below: body.scrollHeight - body.scrollTop - body.clientHeight };
  }, p).then((at) => {
    // Well above the end: an arrival there is not followed into view (seenOnSight.ts AT_END_PX).
    expect(at.below).toBeGreaterThan(200);
    return at.id;
  });
  expect(anchor).not.toBeNull();
  await page.waitForTimeout(300);
  const anchorTop = () => page.locator(`${p} [data-message-article="${anchor}"]`).evaluate((el) => Math.round(el.getBoundingClientRect().top));
  const boxTop = () => box.evaluate((el) => Math.round(el.getBoundingClientRect().top));
  await box.focus();
  const [top0, anchor0] = [await boxTop(), await anchorTop()];

  // Five agent messages land while 80 keys are typed.
  const words = 'Keep the ledger totals on the right and move the export button into the header.';
  const arrivals = (async () => {
    for (let i = 1; i <= 5; i++) {
      await new Promise((done) => setTimeout(done, 450));
      await claude.send({ project_path: project, thread: 'billing-ledger', body: `Live update ${i} while you type.` }, { wakes: true });
    }
  })();
  await page.keyboard.type(words, { delay: 35 });
  await arrivals;

  // Every key is in the box, the caret at its end, focus and the box where they were.
  await expect(box).toHaveValue(words);
  await expect(box).toBeFocused();
  expect(await box.evaluate((el: HTMLTextAreaElement) => el.selectionStart === el.value.length)).toBe(true);
  expect(Math.abs((await boxTop()) - top0)).toBeLessThanOrEqual(1);
  // Each new message is drawn below, and what the person was reading did not move.
  await expect(articles).toHaveCount(before + 5, { timeout: 20_000 });
  await expect(page.locator(`${p} [data-message-article]`, { hasText: 'Live update 5 while you type.' })).toHaveCount(1);
  expect(Math.abs((await anchorTop()) - anchor0)).toBeLessThanOrEqual(1);
  await expect(page.locator(`${p} [aria-busy="true"]`)).toHaveCount(0);
  await expect(box).toHaveValue(words);
  await expect(box).toBeFocused();
  await context.close();
});
