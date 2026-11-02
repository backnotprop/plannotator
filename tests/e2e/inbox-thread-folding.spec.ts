/**
 * Folding a thread (design record, not in this repo; variant "Land"), proved
 * in a real browser against the compiled binary. Claude Code and the person
 * go back and forth in docs-site through `plannotator inbox mcp`
 * (scripts/inbox-sim.ts) and the window's own routes: questions answered, a
 * file annotated, a guided review, replies the agent read. The person looks;
 * then one more message arrives. Seven messages, one new.
 *
 * Opened, the thread lands at "New since you looked" with the last read line
 * above it; the read run folds to lines, its middle behind "3 earlier
 * messages"; each line says what its message holds; opening a line keeps it
 * where it was; n, j and k move between messages; Expand all gives back the
 * fully open thread, and the "↓ 1 new" pill points down to the new message.
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 * PNGs light and dark at 1440 by 900 land in .local/proof/thread-folding/
 * (or PLANNOTATOR_E2E_PROOF_DIR/thread-folding).
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'thread-folding');

/** A 160-odd character prompt with inline markdown: its folded line must still show the answer. */
const LONG_PROMPT = 'Which search index should the docs site use for its first public release, given the **1.6 MB** index, the `astro build` step in CI and the review deadline this Friday?';
const LONG_PLAIN = 'Which search index should the docs site use for its first public release, given the 1.6 MB index, the astro build step in CI and the review deadline this Friday';

const ASK = [
  'I looked at three ways to add search to the docs site. Short version: the site is static, about 240 pages, and every option works with the Astro build we already have.',
  '',
  '| Option | How it runs | Cost |',
  '| --- | --- | --- |',
  '| Pagefind | Index built at deploy, searched in the browser | ~1.6 MB index, no service |',
  '| Algolia DocSearch | Hosted crawler and API | Free for open source, needs approval |',
  '',
  'Two calls before I start:',
  '',
  ':::question',
  LONG_PROMPT,
  '',
  '- [ ] Pagefind',
  '- [ ] Algolia DocSearch',
  '',
  'Recommended: Pagefind',
  ':::',
  '',
  ':::question-multi',
  'Which sections go in the index?',
  '',
  '- [ ] Guides',
  '- [ ] API reference',
  '- [ ] Blog',
  ':::',
].join('\n');

const PLAN = [
  'Pagefind is wired into the build on a branch. Before I polish it, here is the plan. Annotate it if something is off.',
  '',
  ':::question',
  'Which shortcut opens search?',
  '',
  '- [ ] / and ⌘K',
  '- [ ] ⌘K only',
  ':::',
].join('\n');

const LATEST = [
  'CI is green. The empty state now offers the closest section and a GitHub search link.',
  '',
  'One number changed my mind about deploys: the index is **1.8 MB** across 312 files, and building it on every deploy adds about **40 seconds** to each preview build.',
  '',
  '| Build | Previews | Main |',
  '| --- | --- | --- |',
  '| Every deploy | always current, +40 s each | current |',
  '| Main and release tags | the last main index | current |',
  '| Release tags only | can lag by days | can lag by days |',
  '',
  'What changes either way:',
  '',
  '- The index is uploaded with the site, never served from elsewhere.',
  '- The panel keeps the last query when it reopens.',
  '- An empty result suggests the closest section.',
  '',
  ':::question',
  'When should the search index build?',
  '',
  'Stopped: the docs-search branch cannot merge without this.',
  '',
  '- [ ] On main and release tags',
  '- [ ] On every deploy',
  '',
  'Recommended: On main and release tags',
  ':::',
].join('\n');

interface World {
  root: string;
  dataDir: string;
  url: string;
  docs: string;
  claude: SimAgent;
  context: BrowserContext;
  page: Page;
  errors: string[];
  threadId: string;
  ids: string[];
}

let world: World;

async function shot(name: string): Promise<void> {
  const page = world.page;
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(proofDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

async function post(path: string, body: unknown): Promise<Record<string, any>> {
  const response = await fetch(`${world.url.replace(/\/$/, '')}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Record<string, any>;
}

type Sent = { message_id: string; thread_id: string; questions: { key: string; prompt: string; kind: string }[]; attachments?: { id: string }[] };
const answer = (q: Sent['questions'][number], selected: string[]) => ({ key: q.key, revision: 0, answer: { v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected } });

const pane = () => world.page.locator('section.ib-pane');
const article = (id: string) => pane().locator(`[data-message-article="${id}"]`);
const top = async (id: string) => (await article(id).boundingBox())!.y;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-folding-e2e-');
  const dataDir = join(root, 'data');
  // Nothing here may reach the real tailscale CLI: a trap fails loudly first on PATH.
  const trap = join(root, 'bin');
  mkdirSync(trap);
  writeFileSync(join(trap, 'tailscale'), "#!/bin/sh\necho 'inbox-thread-folding.spec: tailscale must not run' >&2\nexit 97\n");
  chmodSync(join(trap, 'tailscale'), 0o755);
  const env = { PATH: `${trap}:${process.env.PATH ?? ''}`, HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER };
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
  const docs = scratchProject(join(root, 'src'), 'docs-site');
  writeFileSync(join(docs, 'search-plan.md'), '# Search plan\n\nThe index builds after `astro build`, in CI only.\n\nResults are grouped by section.\n');
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  world = { root, dataDir, url, docs, claude, context, page, errors, threadId: '', ids: [] };

  // 1. Claude Code asks two questions; 2. the person answers both.
  const ask = (await claude.send({ project_path: docs, subject: 'Search for the docs site', body: ASK })) as Sent;
  world.threadId = ask.thread_id;
  const [index, sections] = ask.questions;
  const r1 = await post(`/api/inbox/messages/${ask.message_id}/reply`, {
    idempotency_key: 'r1',
    // No words of its own: its folded line shows the answers it sent.
    questions: [answer(index!, ['Pagefind']), answer(sections!, ['Guides', 'API reference'])],
  });
  // 3. The plan as a file, one more question; 4. the person answers with two annotations on it.
  const plan = (await claude.send({ project_path: docs, body: PLAN, reply_to: ask.message_id, attachments: ['search-plan.md'] })) as Sent;
  for (const id of ['ann-1', 'ann-2']) {
    await post('/api/inbox/annotations', {
      attachment_id: plan.attachments![0]!.id,
      version: 'current',
      annotation: { id, type: 'COMMENT', text: 'Show the section path on each result.', originalText: 'Results are grouped by section.', blockId: 'block-1', startOffset: 0, endOffset: 0, createdA: 1 },
    });
  }
  const r2 = await post(`/api/inbox/messages/${plan.message_id}/reply`, {
    idempotency_key: 'r2',
    words: 'The plan is close. Two notes on the file.',
    questions: [answer(plan.questions[0]!, ['/ and ⌘K'])],
    feedback: '# Feedback on the attached files\n\nShow the section path on each result.',
    annotation_ids: ['ann-1', 'ann-2'],
  });
  // 5. A guided review of the change; 6. the person's reply. The agent reads every reply.
  const { example } = await claude.guideBrief();
  const guide = (await claude.submitGuide({ project_path: docs, ...example, body: 'Both notes are in: results show the section path. Ready for a read, file by file.', reply_to: ask.message_id })) as Sent;
  const r3 = await post(`/api/inbox/messages/${guide.message_id}/reply`, { idempotency_key: 'r3', words: 'Read it, looks good. One thing: an empty result says only "No results".' });
  await claude.readThread(ask.thread_id);
  // The person looks at the thread (the window's look), then 7. one more message arrives: new since that look.
  await post(`/api/inbox/threads/${ask.thread_id}/seen`, {});
  const latest = (await claude.send({ project_path: docs, body: LATEST, reply_to: ask.message_id })) as Sent;
  world.ids = [ask.message_id, r1.reply.id, plan.message_id, r2.reply.id, guide.message_id, r3.reply.id, latest.message_id];
});

test.afterAll(async () => {
  try {
    if (!world) return;
    await world.claude.close().catch(() => {});
    await world.context.close();
  } finally {
    // Every Inbox this spec started, then its folders (inbox-scratch.ts).
    await removeInboxScratch();
  }
});

test('opened, the thread lands at "New since you looked" with the last read line above it; the subject moves into the header', async () => {
  const { page, ids } = world;
  await page.goto(world.url);
  await page.locator(`.ib-lbody [data-thread-id="${world.threadId}"]`).click();
  await expect(pane().locator('[data-thread-meta]')).toContainText(/^7 messages.*1 new since you looked$/);
  const divider = pane().locator('[data-new-divider]');
  await expect(divider).toHaveText('New since you looked');
  // The last read line just above the divider, both in view; the subject scrolled away into the header.
  await expect(article(ids[5]!)).toBeInViewport();
  await expect(divider).toBeInViewport();
  await expect(pane().locator('h2.ib-subject')).not.toBeInViewport();
  await expect(pane().locator('[data-header-subject]')).toHaveAttribute('data-on', '');
  await expect(pane().locator('[data-header-subject]')).toHaveText('Search for the docs site');
  // The new message is open with its New pill and its question card; it is the last, so the pill is off.
  await expect(article(ids[6]!)).toHaveAttribute('data-new', '');
  await expect(article(ids[6]!)).toHaveAttribute('data-open', '');
  await expect(article(ids[6]!).locator('.ib-newtag')).toHaveText('New');
  await expect(article(ids[6]!).getByText('When should the search index build?')).toBeVisible();
  await expect(pane().locator('[data-new-pill]')).toHaveAttribute('data-off', '');
  await shot('1-opened-at-new');
});

test('the read run folds: first and last two as lines, the middle behind "3 earlier messages"; each line says what its message holds', async () => {
  const { ids } = world;
  for (const id of [ids[0]!, ids[4]!, ids[5]!]) await expect(article(id)).toHaveAttribute('data-folded', '');
  for (const id of [ids[1]!, ids[2]!, ids[3]!]) await expect(article(id)).toHaveCount(0);
  await expect(pane().locator('[data-middle-fold]')).toHaveText('3 earlier messages');
  // Every question answered: the line shows the answers, not the first words.
  const first = article(ids[0]!);
  // A long prompt is cut at a word, so the answer stays on the line; the whole prompt is the line's tooltip.
  const answers = first.locator('[data-snippet="answers"]');
  await expect(answers).toHaveText('Which search index should the docs site… → Pagefind · Which sections go in the index → Guides, API reference');
  // The whole answers are its component tooltip, never a native title.
  await expect(answers).not.toHaveAttribute('title', /./);
  await answers.hover();
  await expect(world.page.locator('[data-side].bg-popover')).toHaveText(`${LONG_PLAIN}: Pagefind; Which sections go in the index: Guides, API reference`);
  await world.page.mouse.move(1, 1);
  const line = (await answers.boundingBox())!;
  const answer = (await answers.locator('b').first().boundingBox())!;
  expect(answer.x).toBeGreaterThanOrEqual(line.x);
  expect(answer.x + answer.width).toBeLessThanOrEqual(line.x + line.width);
  await expect(first.locator('[data-holding]')).toHaveText(['2 answered']);
  await expect(article(ids[4]!).locator('[data-snippet="words"]')).toHaveText(/^Both notes are in: results show the section path/);
  await expect(article(ids[4]!).locator('[data-holding]')).toHaveText(['Guided review']);
  await expect(article(ids[5]!).locator('[data-holding]')).toHaveText(['Delivered']);
  // The fold opens to lines, not to full messages; the plan's line holds its file, the reply its annotations.
  await pane().locator('[data-middle-fold] button').click();
  await expect(pane().locator('[data-middle-fold]')).toHaveCount(0);
  await expect(pane().locator(':focus')).toHaveAttribute('aria-label', /^You, /);
  await expect(article(ids[2]!).locator('[data-holding]')).toHaveText(['1 answered', '1']);
  await expect(article(ids[2]!).locator('[data-holding="files"]')).toHaveText('1');
  await expect(article(ids[3]!).locator('[data-holding="annotations"]')).toHaveText('2');
  await expect(article(ids[3]!).locator('[data-holding="delivered"]')).toHaveText('Delivered');
  // Replies: the person's own words, without "Answered N questions." and the answers section; with no words, the answers.
  await expect(article(ids[3]!).locator('[data-snippet="words"]')).toHaveText('The plan is close. Two notes on the file.');
  await expect(article(ids[1]!).locator('[data-snippet="answers"]')).toHaveText('Which search index should the docs site… → Pagefind · Which sections go in the index → Guides, API reference');
  await shot('2-middle-fold-opened');
});

test('opening and folding a line keeps it where it was', async () => {
  const { page, ids } = world;
  const id = ids[4]!;
  const before = await top(id);
  // The head row the person clicks (inbox-polish, item 5): the mark and the name stay exactly where they were.
  const box = async (selector: string) => (await article(id).locator(selector).first().boundingBox())!;
  const markBefore = await box('.ib-mk.ib-big');
  const nameBefore = await box('.ib-fl-nm');
  await article(id).locator('[data-fold-head]').click();
  await expect(article(id)).toHaveAttribute('data-open', '');
  await expect(article(id).locator('.ib-body')).toBeVisible();
  expect(Math.abs((await top(id)) - before)).toBeLessThan(2);
  const markAfter = await box('.ib-mk.ib-big');
  const nameAfter = await box('.ib-fl-nm');
  expect([markAfter.x, markAfter.y, markAfter.width, markAfter.height].map(Math.round)).toEqual([markBefore.x, markBefore.y, markBefore.width, markBefore.height].map(Math.round));
  expect(markAfter.width).toBe(24);
  expect(Math.round(nameAfter.x)).toBe(Math.round(nameBefore.x));
  // The body lines up with the name.
  const body = (await article(id).locator('.ib-body').first().boundingBox())!;
  expect(Math.abs(body.x - nameAfter.x)).toBeLessThan(2);
  await expect(page.locator(':focus')).toHaveAttribute('aria-expanded', 'true');
  await shot('3-opened-in-place');
  await article(id).locator('[data-fold-head]').click();
  await expect(article(id)).toHaveAttribute('data-folded', '');
  expect(Math.abs((await top(id)) - before)).toBeLessThan(2);
  await expect(page.locator(':focus')).toHaveAttribute('aria-expanded', 'false');
  // A 1280 or 1366 px window beside the list keeps the folded line one 44 px row (the two-line row is for a
  // thread under 560 px of text: beside a file, or a phone).
  try {
    for (const width of [1280, 1366]) {
      await page.setViewportSize({ width, height: 900 });
      await expect.poll(async () => Math.round((await article(id).locator('button.ib-fline').boundingBox())!.height), { message: `${width} px` }).toBe(44);
    }
  } finally {
    await page.setViewportSize({ width: 1440, height: 900 });
  }
});

test('keys: n goes to the first new message, Shift+K and Shift+J move between messages; never while typing', async () => {
  const { page, ids } = world;
  await page.locator('h2.ib-subject').click({ force: true }).catch(() => {});
  await page.keyboard.press('n');
  await expect(page.locator(':focus')).toHaveAttribute('aria-label', /^Claude Code, .*, new\. Fold this message$/);
  await page.keyboard.press('Shift+K');
  await expect(page.locator(':focus')).toHaveAttribute('aria-label', new RegExp(`^You, `));
  expect(await page.locator(':focus').evaluate((el) => el.closest('[data-message-article]')?.getAttribute('data-message-article'))).toBe(ids[5]);
  await page.keyboard.press('Shift+K');
  expect(await page.locator(':focus').evaluate((el) => el.closest('[data-message-article]')?.getAttribute('data-message-article'))).toBe(ids[4]);
  await page.keyboard.press('Shift+J');
  await page.keyboard.press('Shift+J');
  expect(await page.locator(':focus').evaluate((el) => el.closest('[data-message-article]')?.getAttribute('data-message-article'))).toBe(ids[6]);
  // Enter folds the focused message; Enter again opens it.
  await page.keyboard.press('Enter');
  await expect(article(ids[6]!)).toHaveAttribute('data-folded', '');
  await expect(article(ids[6]!).locator('[data-holding]')).toHaveText(['1 open question']);
  await page.keyboard.press('Enter');
  await expect(article(ids[6]!)).toHaveAttribute('data-open', '');
  // Typing in the reply box is typing.
  await pane().locator('.ib-pfoot').getByRole('button', { name: 'Reply' }).click();
  const box = page.getByRole('textbox', { name: 'Reply to Claude Code' });
  await box.pressSequentially('njJ');
  await expect(box).toHaveValue('njJ');
  await expect(box).toBeFocused();
  await pane().locator('.ib-pfoot').getByRole('button', { name: 'Cancel' }).click();
});

test("Expand all gives back today's fully open thread; scrolled up past the new message already read, no pill comes back; n goes down to it", async () => {
  const { page, ids } = world;
  await pane().locator('[data-expand-all]').click();
  await expect(pane().locator('[data-expand-all]')).toHaveAttribute('aria-label', 'Fold the earlier messages');
  for (const id of ids) await expect(article(id)).toHaveAttribute('data-open', '');
  await expect(pane().locator('[data-folded]')).toHaveCount(0);
  await expect(pane().locator('[data-middle-fold]')).toHaveCount(0);
  await expect(article(ids[0]!).getByText(/^Which search index should the docs site use for its first public release/)).toBeVisible();
  await expect(article(ids[3]!).locator('.ib-body')).toContainText('The plan is close.');
  await pane().locator('.ib-pbody').evaluate((el) => el.scrollTo({ top: 0 }));
  // The new message has been on screen this visit (the tests above opened and
  // read it), so scrolling back up above it never brings the pill back (the
  // owner, 2026-10-16: "Why does this whole 'one new' thing keep showing, even
  // though I've seen the whole message? Shows when I scroll up."). The pill
  // pointing down to a message not yet on screen is proved in
  // inbox-seen-on-sight.spec.ts.
  const pill = pane().locator('[data-new-pill]');
  await page.waitForTimeout(300);
  await expect(pill).toHaveAttribute('data-off', '');
  await expect(pane().locator('[data-header-subject]')).not.toHaveAttribute('data-on', '');
  await shot('4-expanded-scrolled-up');
  // n still goes down to the first new message.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('n');
  await expect(pane().locator('[data-new-divider]')).toBeInViewport();
  await expect(pill).toHaveAttribute('data-off', '');
  // Fold all: back to lines, the new message's included; the last stays open.
  await pane().locator('[data-expand-all]').click();
  await expect(pane().locator('[data-expand-all]')).toHaveAttribute('aria-label', 'Expand all messages');
  await expect(article(ids[6]!)).toHaveAttribute('data-open', '');
  await expect(pane().locator('[data-middle-fold]')).toHaveText('3 earlier messages');
  expect(world.errors).toEqual([]);
});

test('a pick folded says it is not sent; the reply that sends it is a look, so nothing above it is new any more; reopened, the thread opens at the top', async () => {
  const { page, ids } = world;
  // A pick on the new question: the list and the thread update, the marks stay.
  await article(ids[6]!).getByText('On main and release tags', { exact: true }).click();
  await expect(pane().locator('.ib-pfoot [data-draft-foot]')).toContainText('Draft');
  await expect(article(ids[6]!)).toHaveAttribute('data-new', '');
  // Folded by hand, its line says the pick is not sent.
  await article(ids[6]!).locator('[data-fold-head]').click();
  await expect(article(ids[6]!).locator('[data-holding]')).toHaveText(['1 pick in your draft']);
  await shot('5-pick-folded');
  await article(ids[6]!).locator('[data-fold-head]').click();
  // Send: the person's reply is a look at everything before it.
  await pane().locator('.ib-pfoot').getByRole('button', { name: 'Send', exact: true }).click();
  await expect(pane().locator('[data-thread-meta]')).toHaveText(/^8 messages/);
  await expect(pane().locator('[data-message-article][data-new]')).toHaveCount(0);
  await expect(pane().locator('.ib-newtag')).toHaveCount(0);
  await expect(pane().locator('[data-new-divider]')).toHaveCount(0);
  await expect(pane().locator('[data-new-pill]')).toHaveCount(0);
  await expect(pane().locator('[data-thread-meta]')).not.toContainText('new since you looked');
  await shot('6-sent');
  // Left and opened again: nothing new, the thread opens at the top.
  await pane().getByRole('button', { name: 'Close the thread' }).click();
  await expect(pane()).toHaveCount(0);
  await page.locator(`.ib-lbody [data-thread-id="${world.threadId}"]`).click();
  await expect(pane().locator('[data-thread-meta]')).toHaveText(/^8 messages/);
  await expect(pane().locator('[data-new-divider]')).toHaveCount(0);
  await expect(pane().locator('h2.ib-subject')).toBeInViewport();
  expect(world.errors).toEqual([]);
});
