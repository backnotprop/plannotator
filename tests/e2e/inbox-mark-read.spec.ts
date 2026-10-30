/**
 * Mark read, and a Send that skips the questions the person did not answer
 * (design record "inbox-mark-read", approved 2026-10-11; the owner's later
 * rulings: Mark read closes the questions it leaves, Sent sits below New
 * since you looked, and the person's own action never reorders the list
 * while they are still in the thread). Proved in a real browser against the
 * compiled binary, with agents writing through `plannotator inbox mcp`
 * (scripts/inbox-sim.ts):
 *
 *  - a reply defaults to Keep open (approval "inbox-explicit-skip": a Send
 *    never skips on its own); after Skip them, it skips the questions of a
 *    Waiting thread: the row does not move while the thread stays open, and
 *    sits in Sent, below New, once the person leaves it;
 *  - in a thread ONE session wrote (it asked, then posted a later update), a
 *    words-only Send after Skip it is one reply: one new person message,
 *    carrying the skip and the words, to the message that asked;
 *  - a words-only reply left as it is keeps every question open, and the
 *    agent's wait_for_reply gets the words plus the still-open line;
 *  - Mark read moves a thread to Quiet ("Read"), and an agent's new message
 *    brings it back to the top;
 *  - Mark read on a thread an agent is stopped on warns, and Z undoes it;
 *  - the row's hover action, and its Undo;
 *  - the toast's × and a swipe close it early, its Undo with it (Z no longer
 *    undoes), a short drag springs back, and the longest one-line toasts stay
 *    one line with the ×.
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 * PNGs at 1440 by 900 land in .local/proof/mark-read/.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'mark-read');

const INVOICES = [
  'The invoice list needs a few calls before I build it.',
  '',
  ':::question',
  'Which layout should the invoice list use?',
  '',
  '- [ ] Cards',
  '- [ ] A dense table',
  ':::',
  '',
  ':::question',
  'Should overdue invoices sort to the top?',
  '',
  '- [ ] Yes',
  '- [ ] No',
  ':::',
  '',
  ':::question-text',
  'Anything the empty state should say?',
  ':::',
].join('\n');

const SEARCH = ['Search for the docs site.', '', ':::question', 'Which search index should the docs use?', '', '- [ ] Pagefind', '- [ ] Orama', ':::'].join('\n');

const WORKER = [
  'The retry worker is waiting on you.',
  '',
  ':::question',
  'Which way should the worker go on a Stripe 409?',
  '',
  'Stopped: the retry worker cannot ship without this.',
  '',
  '- [ ] Retry with the same idempotency key',
  '- [ ] Fail the job',
  ':::',
].join('\n');

interface World {
  root: string;
  dataDir: string;
  url: string;
  project: string;
  agents: { claude: SimAgent; codex: SimAgent; pi: SimAgent };
  context: BrowserContext;
  page: Page;
  errors: string[];
  threads: { invoices: string; search: string; worker: string; news: string };
  searchMessage: string;
}

let world: World;

async function shot(name: string, schemes: readonly ('light' | 'dark')[] = ['dark']): Promise<void> {
  const page = world.page;
  for (const scheme of schemes) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(proofDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

/** The sections on screen, top to bottom, each with its thread ids. */
async function sections(page: Page): Promise<{ id: string; rows: string[] }[]> {
  return page.locator('.ib-lbody [data-section-id]').evaluateAll((groups) =>
    groups.map((g) => ({
      id: g.getAttribute('data-section-id') ?? '',
      rows: [...g.querySelectorAll('[data-row]')].map((r) => r.getAttribute('data-row') ?? ''),
    })),
  );
}

async function sectionOf(page: Page, threadId: string): Promise<string | null> {
  return (await sections(page)).find((s) => s.rows.includes(threadId))?.id ?? null;
}

const openQuiet = async (page: Page) => {
  const band = page.locator('[data-section-id="quiet"] .ib-band');
  if ((await band.getAttribute('aria-expanded')) !== 'true') await band.click();
};

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-markread-e2e-');
  const dataDir = join(root, 'data');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  const project = scratchProject(join(root, 'src'), 'billing');
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const codex = await SimAgent.connect({ binary, env, name: 'Codex', host: 'codex' });
  const pi = await SimAgent.connect({ binary, env, name: 'Pi', host: 'pi' });
  const worker = await claude.send({ project_path: project, subject: 'Retry worker: Stripe 409', thread: 'worker', body: WORKER });
  await new Promise((r) => setTimeout(r, 20));
  const news = await pi.send({ project_path: project, subject: 'Nightly build is green', body: 'The nightly build is green again.' });
  await new Promise((r) => setTimeout(r, 20));
  const search = await codex.send({ project_path: project, subject: 'Search for the docs site', body: SEARCH });
  await new Promise((r) => setTimeout(r, 20));
  const invoices = await claude.send({ project_path: project, subject: 'Invoice list: cards or a table?', thread: 'invoices', body: INVOICES });
  world = {
    root,
    dataDir,
    url,
    project,
    agents: { claude, codex, pi },
    context,
    page,
    errors,
    threads: { invoices: invoices.thread_id as string, search: search.thread_id as string, worker: worker.thread_id as string, news: news.thread_id as string },
    searchMessage: search.message_id as string,
  };
});

test.afterAll(async () => {
  try {
    if (!world) return;
    await Promise.all(Object.values(world.agents).map((a) => a.close().catch(() => {})));
    await world.context.close();
  } finally {
    // Every Inbox this spec started, then its folders (inbox-scratch.ts).
    await removeInboxScratch();
  }
});

test('the list before: Stopped, Waiting, then New', async () => {
  const { page, threads } = world;
  await page.goto(world.url);
  await expect(page.locator(`.ib-lbody [data-row="${threads.invoices}"]`)).toBeVisible();
  const order = (await sections(page)).filter((s) => s.rows.length > 0).map((s) => s.id);
  expect(order).toEqual(['stopped', 'waiting', 'new']);
  expect(await sectionOf(page, threads.invoices)).toBe('waiting');
  await shot('01-list-before', ['light', 'dark']);
});

test('a words-only reply keeps the questions open by default; after Skip them, it skips them; the row keeps its place while the thread is open, then sits in Sent below New', async () => {
  const { page, threads } = world;
  await page.locator(`.ib-lbody [data-thread-id="${threads.invoices}"]`).click();
  const pane = page.locator('section.ib-pane');
  await expect(pane.getByRole('heading', { name: 'Invoice list: cards or a table?' })).toBeVisible();
  await page.locator('.ib-pfoot').getByRole('button', { name: 'Reply' }).click();
  await page.locator('.ib-rtext').fill('Redo the design. Use the dense table from the payouts page, not cards; we can talk sort order after.');
  const chip = page.locator('[data-skip-chip]');
  // Keep open is the default (approval "inbox-explicit-skip").
  await expect(chip).toHaveAttribute('data-skip-chip', 'keep');
  await expect(chip).toContainText('3 questions stay open');
  await shot('02a-reply-keeps-open');
  await chip.getByRole('button', { name: 'Skip them' }).click();
  await expect(chip).toContainText('3 questions will be skipped');
  await shot('02-reply-skips');
  await page.locator('.ib-pfoot').getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('.ib-rtext')).toHaveCount(0);
  await expect(pane.getByText(/^Skipped · \d{1,2}:\d{2} [AP]M$/).first()).toBeVisible();
  // Not on top any more, but the visible list does not move while the person is in the thread.
  await expect(page.locator(`.ib-lbody [data-thread-id="${threads.invoices}"]`)).toHaveAttribute('data-section', 'sent');
  expect(await sectionOf(page, threads.invoices)).toBe('waiting');
  await page.waitForTimeout(800);
  expect(await sectionOf(page, threads.invoices)).toBe('waiting');
  await shot('03-after-reply-held');
  // Leaving the thread: the row is in Sent, below New since you looked.
  await page.keyboard.press('Escape');
  await expect(pane).toHaveCount(0);
  await expect.poll(() => sectionOf(page, threads.invoices)).toBe('sent');
  const order = (await sections(page)).filter((s) => s.rows.length > 0).map((s) => s.id);
  expect(order.indexOf('sent')).toBeGreaterThan(order.indexOf('new'));
  expect(order[0]).toBe('stopped');
  await shot('04-list-after-reply', ['light', 'dark']);
});

test('one session asked, then posted an update: a words-only Send writes exactly one person message', async () => {
  const { page, agents, project } = world;
  const asked = await agents.claude.send({ project_path: project, subject: 'Status page: which index?', body: SEARCH.replace('docs site', 'status page') });
  await agents.claude.send({ project_path: project, reply_to: asked.message_id as string, body: 'Update: the status page builds now.' });
  const threadId = asked.thread_id as string;
  type Model = { thread: { messages: { author: { kind: string }; reply_to: string | null; body: string }[] } };
  const persons = async () =>
    ((await (await fetch(new URL(`/api/inbox/threads/${threadId}`, world.url))).json()) as Model).thread.messages.filter((m) => m.author.kind === 'person');
  expect(await persons()).toHaveLength(0);
  await page.goto(`${world.url}#thread=${threadId}`);
  const pane = page.locator('section.ib-pane');
  await expect(pane.getByRole('heading', { name: 'Status page: which index?' })).toBeVisible();
  await page.locator('.ib-pfoot').getByRole('button', { name: 'Reply' }).click();
  await expect(page.locator('[data-skip-chip]')).toContainText('1 question stays open');
  await page.locator('[data-skip-chip]').getByRole('button', { name: 'Skip it' }).click();
  await expect(page.locator('[data-skip-chip]')).toContainText('1 question will be skipped');
  await page.locator('.ib-rtext').fill('Ship it as it is.');
  await page.locator('.ib-pfoot').getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('.ib-rtext')).toHaveCount(0);
  await expect(pane.getByText(/^Skipped · \d{1,2}:\d{2} [AP]M$/).first()).toBeVisible();
  // Give a second reply every chance to land before counting.
  await page.waitForTimeout(500);
  const mine = await persons();
  expect(mine).toHaveLength(1);
  expect(mine[0]!.reply_to).toBe(asked.message_id);
  expect(mine[0]!.body).toMatch(/^Skipped 1 question\./);
  expect(mine[0]!.body).toContain('Ship it as it is.');
  await shot('04b-one-session-one-reply');
  await page.keyboard.press('Escape');
  await expect(pane).toHaveCount(0);
});

test('a words-only reply left as it is: the questions stay open, and the agent gets the words and the still-open line', async () => {
  const { page, agents, project } = world;
  const asked = await agents.codex.send({ project_path: project, subject: 'Pricing page: a few calls', thread: 'pricing', body: INVOICES.replace('invoice list', 'pricing page') });
  const threadId = asked.thread_id as string;
  await page.goto(`${world.url}#thread=${threadId}`);
  const pane = page.locator('section.ib-pane');
  await expect(pane.getByRole('heading', { name: 'Pricing page: a few calls' })).toBeVisible();
  await page.locator('.ib-pfoot').getByRole('button', { name: 'Reply' }).click();
  await page.locator('.ib-rtext').fill("Received, I'll answer these after lunch.");
  await expect(page.locator('[data-skip-chip]')).toHaveAttribute('data-skip-chip', 'keep');
  await page.locator('.ib-pfoot').getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('.ib-rtext')).toHaveCount(0);
  // The cards still take answers: nothing was skipped.
  await expect(pane.getByText(/^Skipped · \d{1,2}:\d{2} [AP]M$/)).toHaveCount(0);
  await shot('04c-words-only-keeps-open');
  const waited = await agents.codex.waitForReply(threadId, 5);
  expect((waited.reply as { body: string }).body).toBe(
    "Received, I'll answer these after lunch.\n\nNo questions answered yet; all 3 are still open. Don't re-ask them; the person will answer in the Inbox.",
  );
  type Model = { thread: { messages: { questions?: { state: string }[] }[] } };
  const model = (await (await fetch(new URL(`/api/inbox/threads/${threadId}`, world.url))).json()) as Model;
  expect(model.thread.messages.flatMap((m) => m.questions ?? []).map((q) => q.state)).toEqual(['open', 'open', 'open']);
  await page.keyboard.press('Escape');
  await expect(pane).toHaveCount(0);
});

test('the foot after a pick: the buttons on the left, the draft status at the row\'s right end; too narrow, the status on its own line above the buttons', async () => {
  const { page, agents, project } = world;
  const asked = await agents.pi.send({ project_path: project, subject: 'Refunds page: a few calls', thread: 'refunds', body: INVOICES.replace('invoice list', 'refunds page') });
  await page.goto(`${world.url}#thread=${asked.thread_id as string}`);
  const pane = page.locator('section.ib-pane');
  await expect(pane.getByRole('heading', { name: 'Refunds page: a few calls' })).toBeVisible();
  await pane.locator('fieldset[data-question-key]').first().locator('[data-question-option]').filter({ hasText: 'A dense table' }).click();
  const row = page.locator('.ib-pfoot [data-foot-row]');
  const status = row.locator('[data-foot-status]');
  await expect(status.locator('[data-draft-foot]')).toContainText('1 pick');
  await expect(status.locator('[data-skip-chip]')).toContainText('2 questions stay open');
  const box = async (sel: string) => (await page.locator(sel).first().boundingBox())!;
  const send = async () => box('.ib-pfoot [data-foot-buttons] .ib-btn.ib-pri');
  const reask = async () => box('.ib-pfoot [data-foot-buttons] [data-open-questions]');
  // Wide: one line. Send first, the status after the last button ("N open questions", which holds Re-ask), ending at the row's end,
  // in full words at this width (narrower, the row shortens before it wraps: inbox-thread-foot.spec.ts).
  await page.setViewportSize({ width: 1920, height: 1000 });
  await expect.poll(async () => Math.round((await box('.ib-pfoot [data-foot-status]')).y - (await send()).y)).toBeLessThan(10);
  const wide = { row: await box('.ib-pfoot [data-foot-row]'), status: await box('.ib-pfoot [data-foot-status]'), send: await send(), reask: await reask() };
  expect(Math.abs(wide.status.y + wide.status.height / 2 - (wide.send.y + wide.send.height / 2))).toBeLessThan(2);
  expect(wide.status.x).toBeGreaterThan(wide.reask.x + wide.reask.width);
  expect(Math.abs(wide.status.x + wide.status.width - (wide.row.x + wide.row.width))).toBeLessThan(2);
  await shot('04d-foot-status-right');
  // A phone: the row shortens to its last step (Edit draft as its pencil) and keeps one line: the buttons, then the status.
  await page.setViewportSize({ width: 390, height: 844 });
  // Read in one frame (the layout moves while the window settles into the phone's).
  const narrow = () =>
    page.evaluate(() => {
      const r = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
      const [status, send, reask] = ['[data-foot-status]', '[data-foot-buttons] .ib-btn.ib-pri', '[data-foot-buttons] [data-open-questions]'].map((s) => r(`.ib-pfoot ${s}`));
      const mid = (b: DOMRect) => b.top + b.height / 2;
      return { besideButtons: Math.abs(mid(status!) - mid(send!)) < 4 && status!.left >= reask!.right, oneLine: Math.abs(reask!.top - send!.top) < 2 };
    });
  await expect.poll(narrow).toEqual({ besideButtons: true, oneLine: true });
  await expect(page.locator('.ib-pfoot [data-foot-buttons]').getByRole('button', { name: 'Edit draft' })).toBeVisible();
  await shot('04e-foot-status-phone');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(world.url);
  await expect(pane).toHaveCount(0);
});

test('Mark read moves the thread to Quiet ("Read"); a new agent message brings it back to the top', async () => {
  const { page, threads } = world;
  await page.locator(`.ib-lbody [data-thread-id="${threads.search}"]`).click();
  const head = page.locator('[data-mark-read]');
  await expect(head).toHaveAttribute('aria-pressed', 'false');
  await head.click();
  await expect(head).toHaveAttribute('aria-pressed', 'true');
  await expect(head).toContainText('Read');
  await expect(page.locator('[data-read-line]')).toContainText('It stays out of the top until Codex writes again.');
  await expect(page.locator('[data-inbox-toast]')).toContainText('Moves to Quiet');
  await shot('05-thread-read');
  await page.keyboard.press('Escape');
  await openQuiet(page);
  await expect.poll(() => sectionOf(page, threads.search)).toBe('quiet');
  await expect(page.locator(`.ib-lbody [data-row="${threads.search}"] .ib-c .ib-cs`)).toHaveText('Read');
  await shot('06-list-read-in-quiet', ['light', 'dark']);

  // The agent writes again: the thread waits behind "1 new", then is back on top.
  await world.agents.codex.send({ project_path: world.project, reply_to: world.searchMessage, body: ['One more:', '', ':::question', 'Index the API reference too?', '', '- [ ] Yes', '- [ ] No', ':::'].join('\n') });
  await expect(page.locator('[data-inbox-notice]')).toContainText('1 new in billing');
  await page.locator('[data-inbox-notice]').click();
  await expect.poll(() => sectionOf(page, threads.search)).toBe('waiting');
});

test('Mark read on a thread an agent is stopped on warns with Reply; Z undoes it', async () => {
  const { page, threads } = world;
  await page.locator(`.ib-lbody [data-thread-id="${threads.worker}"]`).click();
  await expect(page.locator('[data-mark-read]')).toHaveAttribute('aria-pressed', 'false');
  await page.locator('body').press('e');
  const toast = page.locator('[data-inbox-toast]');
  await expect(toast).toContainText('Claude Code was stopped');
  await expect(toast.getByRole('button', { name: 'Reply' })).toBeVisible();
  // One 40 px line (Reply, Undo and the ×), centered on the window (not the thread pane), 16 px from the
  // window's bottom edge even with a thread open (owner, 2026-10-18: a toast may cover the foot for a moment).
  await expect(toast.getByRole('button')).toHaveCount(3);
  await expect(toast.getByRole('button').last()).toHaveAccessibleName('Dismiss');
  await toast.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)).then(() => undefined));
  const [toastBox, paneBox] = await Promise.all([toast.boundingBox(), page.locator('section.ib-pane').boundingBox()]);
  expect(toastBox!.height).toBe(40);
  expect(toastBox!.width).toBeLessThanOrEqual(520);
  const viewport = page.viewportSize()!;
  expect(Math.abs(toastBox!.x + toastBox!.width / 2 - viewport.width / 2)).toBeLessThanOrEqual(1);
  // The list sits beside the thread, so the window's center is not the pane's.
  expect(Math.abs(paneBox!.x + paneBox!.width / 2 - viewport.width / 2)).toBeGreaterThan(40);
  expect(Math.abs(viewport.height - (toastBox!.y + toastBox!.height) - 16)).toBeLessThanOrEqual(1);
  await expect(page.locator('[data-mark-read]')).toHaveAttribute('aria-pressed', 'true');
  await shot('07-stopped-warning', ['light', 'dark']);
  await page.locator('body').press('z');
  await expect(page.locator('[data-mark-read]')).toHaveAttribute('aria-pressed', 'false');
  await expect(toast).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect.poll(() => sectionOf(page, threads.worker)).toBe('stopped');
});

test('the toast closes early: the × (focus back, Z no longer undoes), a mouse swipe past 40%; a short drag springs back; long one-line toasts keep one line', async () => {
  const { page, threads } = world;
  await page.locator(`.ib-lbody [data-thread-id="${threads.worker}"]`).click();
  const head = page.locator('[data-mark-read]');
  await expect(head).toHaveAttribute('aria-pressed', 'false');
  await head.focus();
  await page.keyboard.press('Enter');
  await expect(head).toHaveAttribute('aria-pressed', 'true');
  const toast = page.locator('[data-inbox-toast]');
  await toast.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)).then(() => undefined));
  const close = toast.locator('[data-toast-dismiss]');
  const closeBox = await close.boundingBox();
  expect(Math.round(closeBox!.width)).toBe(24);
  expect(Math.round(closeBox!.height)).toBe(24);

  // The × never makes a toast wrap: the widest toasts take the same lines (and stay within 520 px) with the ×
  // as without it, Undo dropping its Z hint where the line would wrap (data-tight, the component's own rule;
  // the fonts on another machine decide which copies need it). The live toast, copied with each one's words
  // and actions.
  const heights = await toast.evaluate((el) => {
    // [lead, detail, the actions before the ×]: the real copy of the widest one-line toasts.
    const copies: [string, string, ('reply' | 'undo' | 'drafts')[]][] = [
      ['Looks good', 'Goes to Claude Code in 10 s · Moves to Quiet', ['undo']],
      ['Draft saved', 'It waits under Drafts and never sends itself.', ['drafts']],
      ['Marked read', 'Claude Code was stopped', ['reply', 'undo']],
      ['Back in your Inbox', '“Retry worker: Stripe 409”', ['undo']],
    ];
    return copies.map(([lead, detail, acts]) => {
      const copy = el.cloneNode(true) as HTMLElement;
      const reply = copy.querySelector('[data-toast-reply]')!;
      if (acts.includes('drafts')) reply.textContent = 'Drafts';
      else if (!acts.includes('reply')) reply.remove();
      if (!acts.includes('undo')) copy.querySelector('[data-toast-undo]')!.remove();
      copy.removeAttribute('data-inbox-toast');
      copy.style.animation = 'none';
      copy.style.visibility = 'hidden';
      copy.querySelector('.ib-tlead')!.textContent = lead;
      copy.querySelector('.ib-tdetail')!.textContent = detail;
      copy.removeAttribute('data-tight');
      el.parentElement!.appendChild(copy);
      const say = copy.querySelector('.ib-tsay') as HTMLElement;
      const line = parseFloat(getComputedStyle(say).lineHeight) || 20;
      if (say.getBoundingClientRect().height > line * 1.5) copy.setAttribute('data-tight', '');
      const box = copy.getBoundingClientRect();
      copy.removeAttribute('data-tight');
      copy.querySelector('[data-toast-dismiss]')!.remove();
      copy.classList.remove('ib-toast-closable');
      const without = copy.getBoundingClientRect();
      copy.remove();
      return { lead, height: Math.round(box.height), without: Math.round(without.height), width: Math.round(box.width) };
    });
  });
  for (const h of heights) {
    expect(h.height, h.lead).toBe(h.without);
    expect(h.width, h.lead).toBeLessThanOrEqual(520);
  }
  // The approved one-line copies (👍 Looks good, the stopped warning) are one 40 px line.
  expect(heights.filter((h) => h.lead === 'Looks good' || h.lead === 'Marked read').map((h) => h.height)).toEqual([40, 40]);

  // The guarantee behind that, whatever the fonts: for a toast with Undo, the words grown until they JUST fit one
  // line WITHOUT the × (one more word would wrap) still fit one line with it, by the tight rule. (A toast with no
  // Undo has no Z hint to give up: its copy keeps room for the ×, as the real copies above show.)
  const edge = await toast.evaluate((el) => {
    const out: { acts: string; without: number; withClose: number }[] = [];
    for (const acts of [['undo'], ['reply', 'undo']] as string[][]) {
      const copy = el.cloneNode(true) as HTMLElement;
      const reply = copy.querySelector('[data-toast-reply]')!;
      if (acts.includes('drafts')) reply.textContent = 'Drafts';
      else if (!acts.includes('reply')) reply.remove();
      if (!acts.includes('undo')) copy.querySelector('[data-toast-undo]')!.remove();
      copy.removeAttribute('data-inbox-toast');
      copy.removeAttribute('data-tight');
      copy.style.animation = 'none';
      copy.style.visibility = 'hidden';
      copy.querySelector('.ib-tlead')!.textContent = 'Looks good';
      const detail = copy.querySelector('.ib-tdetail') as HTMLElement;
      detail.textContent = 'Goes';
      const close = copy.querySelector('[data-toast-dismiss]')!;
      const acts2 = close.parentElement!;
      el.parentElement!.appendChild(copy);
      const say = copy.querySelector('.ib-tsay') as HTMLElement;
      const line = parseFloat(getComputedStyle(say).lineHeight) || 20;
      const oneLine = () => say.getBoundingClientRect().height <= line * 1.5;
      // Without the ×: grow to the last length that fits.
      close.remove();
      copy.classList.remove('ib-toast-closable');
      let words = 0;
      while (words < 200) {
        detail.textContent += ' a';
        if (!oneLine()) {
          detail.textContent = detail.textContent!.slice(0, -2);
          break;
        }
        words++;
      }
      const without = Math.round(copy.getBoundingClientRect().height);
      // With the ×, by the component's rule.
      acts2.appendChild(close);
      copy.classList.add('ib-toast-closable');
      if (!oneLine() && copy.querySelector('[data-toast-undo]')) copy.setAttribute('data-tight', '');
      out.push({ acts: acts.join('+') || 'none', without, withClose: Math.round(copy.getBoundingClientRect().height) });
      copy.remove();
    }
    return out;
  });
  for (const e of edge) expect(e.withClose, `${e.acts}: a line that fit without the × fits with it`).toBe(e.without);

  // The live toast does it itself: words grown until the line just wraps with the Z hint and the × (whatever
  // the fonts), then a resize lets the toast decide again: it drops the hint and is one 40 px line, its Undo
  // still named for Z. Put back as it was after.
  const tight = await toast.evaluate((el) => {
    const detail = el.querySelector('.ib-tdetail') as HTMLElement;
    const say = el.querySelector('.ib-tsay') as HTMLElement;
    const before = detail.textContent;
    const line = parseFloat(getComputedStyle(say).lineHeight) || 20;
    el.removeAttribute('data-tight');
    let grown = 0;
    while (say.getBoundingClientRect().height <= line * 1.5 && grown < 80) {
      detail.textContent += ' a';
      grown++;
    }
    const wrapped = say.getBoundingClientRect().height > line * 1.5;
    window.dispatchEvent(new Event('resize'));
    const result = {
      wrapped,
      tight: el.hasAttribute('data-tight'),
      height: Math.round(el.getBoundingClientRect().height),
      kbd: getComputedStyle(el.querySelector('.ib-tundo kbd')!).display,
      keys: el.querySelector('[data-toast-undo]')!.getAttribute('aria-keyshortcuts'),
    };
    detail.textContent = before;
    window.dispatchEvent(new Event('resize'));
    return { ...result, back: el.hasAttribute('data-tight') };
  });
  expect(tight).toEqual({ wrapped: true, tight: true, height: 40, kbd: 'none', keys: 'Z', back: false });

  // Focus moves from Mark read onto the × (the toast sits at the end of the page, past the thread, so this
  // stands in for the Tabs); Enter on it: the toast goes, focus is back on Mark read, and Z has nothing to undo.
  await close.focus();
  await expect(close).toBeFocused();
  await shot('09-toast-close-focused', ['light', 'dark']);
  await page.keyboard.press('Enter');
  await expect(toast).toHaveCount(0);
  await expect(head).toBeFocused();
  await page.locator('body').press('z');
  await page.waitForTimeout(400);
  await expect(head).toHaveAttribute('aria-pressed', 'true');

  // Move it back (Undo), then swipe that toast away with the mouse: a short drag springs back first.
  await head.click();
  await expect(head).toHaveAttribute('aria-pressed', 'false');
  await head.click();
  await expect(head).toHaveAttribute('aria-pressed', 'true');
  await expect(toast).toContainText('Claude Code was stopped');
  await toast.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)).then(() => undefined));
  const box = (await toast.boundingBox())!;
  const grip = { x: box.x + 30, y: box.y + box.height / 2 };
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  for (let dx = 10; dx <= 60; dx += 10) {
    await page.mouse.move(grip.x + dx, grip.y);
    await page.waitForTimeout(30);
  }
  await expect.poll(() => toast.evaluate((el) => el.style.translate)).toBe('60px');
  await page.mouse.up();
  await expect(toast).toBeVisible();
  await expect.poll(() => toast.evaluate((el) => el.getAnimations().length)).toBe(0);
  const back = (await toast.boundingBox())!;
  expect(Math.abs(back.x - box.x)).toBeLessThanOrEqual(1);

  // Past 40% of its width: mid-swipe it follows the pointer and fades, then it slides out and is gone.
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  for (let dx = 20; dx <= Math.round(box.width * 0.5); dx += 20) {
    await page.mouse.move(grip.x + dx, grip.y);
    await page.waitForTimeout(30);
  }
  expect(Number(await toast.evaluate((el) => el.style.opacity))).toBeLessThan(1);
  await page.screenshot({ path: join(proofDir, '10-toast-mid-swipe-light.png') });
  await page.mouse.up();
  await expect(toast).toHaveCount(0);
  await expect(page.locator('[data-toast-ghost]')).toHaveCount(0);
  await page.locator('body').press('z');
  await page.waitForTimeout(400);
  await expect(head).toHaveAttribute('aria-pressed', 'true');

  // Put it back for the tests after this one.
  await head.click();
  await expect(head).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Escape');
  await expect.poll(() => sectionOf(page, threads.worker)).toBe('stopped');
});

test('the row hover action marks read without opening the thread; its Undo puts the row back; no page errors', async () => {
  const { page, threads } = world;
  const row = page.locator(`.ib-lbody [data-row="${threads.news}"]`);
  await row.hover();
  const action = row.locator('[data-row-mark-read]');
  await expect(action).toBeVisible();
  await shot('08-row-hover-action', ['light']);
  await action.click();
  await expect(page.locator('section.ib-pane')).toHaveCount(0);
  await expect.poll(() => sectionOf(page, threads.news)).toBe('quiet');
  // No thread open: the same place, centered on the window, 16 px from its bottom edge.
  const toast = page.locator('[data-inbox-toast]');
  await expect(toast).toContainText('Moved to Quiet');
  await toast.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)).then(() => undefined));
  const toastBox = await toast.boundingBox();
  const viewport = page.viewportSize()!;
  expect(Math.abs(toastBox!.x + toastBox!.width / 2 - viewport.width / 2)).toBeLessThanOrEqual(1);
  expect(Math.abs(viewport.height - (toastBox!.y + toastBox!.height) - 16)).toBeLessThanOrEqual(1);
  await toast.getByRole('button', { name: /Undo/ }).click();
  await expect.poll(() => sectionOf(page, threads.news)).toBe('new');
  expect(world.errors).toEqual([]);
});
