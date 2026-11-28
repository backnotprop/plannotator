/**
 * Decision mode (approval "inbox-decision-mode"; on unless Settings › Capabilities turns it off), proved in a real
 * browser against the compiled binary. Nothing is mocked: the binary runs `plannotator inbox --background` under a
 * scratch HOME and PLANNOTATOR_DATA_DIR (loopback only, no phones, no update check, no ping), and agents ask through
 * `plannotator inbox mcp` (scripts/inbox-sim.ts), one shim per agent session.
 *
 * In one harbor thread Claude Code asks three questions (a plain one, a Before/After one, a picture choice whose
 * options each have a prototype page, with a file attached) and Codex a pick-any. The focused dialog opens from the
 * thread's open-questions list and draws each question with the thread's own card. Pictures and prototypes open over
 * the dialog; the attached file opens beside the thread while the dialog waits in its pill, and the dialog comes back
 * on the same card once the file closes. Answers are drafts: nothing is sent until Send is pressed, Send sends only
 * the answered questions (one reply per agent session) and leaves the rest open, and leaving the dialog asks nothing
 * and keeps the drafts on the thread's cards. Last, the Capabilities switch, on by default, hides the way in when off.
 *
 * Proof: whole-window shots, numbered in the order a person meets them, at 1440×900 in light and dark and on a
 * 390×844 phone in light, in PLANNOTATOR_DECISION_SHOTS or <PLANNOTATOR_E2E_PROOF_DIR or .local/proof>/decision-mode/
 * (CI's inbox-window-proof artifact). Made-up projects and people only.
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 */

import { chromium, expect, test, type Browser, type BrowserContext, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';
import { agentCliCalls, writeAgentCliStubs } from './agent-cli-stubs';
import { png } from './test-png';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = resolve(process.env.PLANNOTATOR_DECISION_SHOTS ?? join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'decision-mode'));

const PLAIN = 'Ship the new search index tonight?';
const CHANGE = 'Keep the result count next to the search box?';
const LAYOUT = 'Which results layout should ship?';
const MULTI = 'Which exports should the search logs keep?';

const CLAUDE_BODY = [
  'Three calls before the harbor search index ships. Ada Novak signed off on the ranking; the rollout plan is attached.',
  '',
  ':::question',
  PLAIN,
  '',
  '- [ ] Yes, tonight — the index is warm and traffic is low',
  '- [ ] No, wait for Monday — Bob Tully is on call then',
  ':::',
  '',
  ':::question',
  CHANGE,
  '',
  'Where: The search page on a phone',
  'Before: The result count scrolls away under the filters',
  'After: The result count stays next to the search box',
  '',
  '- [ ] Yes, keep it there',
  '- [ ] No, leave it under the filters',
  ':::',
  '',
  ':::question',
  LAYOUT,
  'Stakes: every search in harbor uses it from Thursday.',
  '',
  '- [ ] A · Compact list — ![Compact list](shots/layout-a.png) closest to today',
  '    Prototype: proto/layout-a.html',
  '- [ ] B · Cards with previews — ![Cards with previews](shots/layout-b.png) more to read at a glance',
  '    Prototype: proto/layout-b.html',
  '',
  'Recommended: B · Cards with previews',
  '',
  'Why: Charlie Dunn found answers 30% faster with previews in the hallway test.',
  ':::',
].join('\n');

const CODEX_BODY = [
  'The logs exporter is ready once we pick its formats.',
  '',
  ':::question-multi',
  MULTI,
  '',
  '- [ ] CSV',
  '- [ ] Parquet',
  '- [ ] JSON lines',
  '',
  'Recommended: CSV, Parquet',
  ':::',
].join('\n');

const PROTOTYPE = (title: string, rows: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:15px system-ui,sans-serif;margin:0;background:#f7f7f9;color:#1d1d24}header{background:#1d1d24;color:#fff;padding:14px 20px}
main{padding:16px 20px;display:grid;gap:10px}.r{background:#fff;border:1px solid #dcdce4;border-radius:8px;padding:10px 12px}</style></head>
<body><header><h1 style="margin:0;font-size:18px">${title}</h1></header><main>${rows}</main></body></html>`;

interface Run {
  thread: string;
  claudeMessage: string;
  codexMessage: string;
}

interface World {
  root: string;
  dataDir: string;
  /** Agent CLI stubs first on the Inbox's PATH: each call is recorded. */
  stubs: string;
  url: string;
  claude: SimAgent;
  codex: SimAgent;
  harbor: string;
  context: BrowserContext;
  page: Page;
  errors: string[];
  desktop: Run | null;
}
let world: World;

function port(): number {
  return (JSON.parse(readFileSync(join(world.dataDir, 'inbox', 'inbox.json'), 'utf8')) as { port: number }).port;
}
const inboxGet = async <T,>(path: string): Promise<T> => (await (await fetch(`http://127.0.0.1:${port()}${path}`)).json()) as T;

type WireQuestion = { key: string; prompt: string; state: string; answer: { selected: string[] } | null };
async function questionOf(thread: string, prompt: string): Promise<WireQuestion | null> {
  const model = await inboxGet<{ thread: { messages: { questions?: WireQuestion[] }[] } }>(`/api/inbox/threads/${thread}`);
  return model.thread.messages.flatMap((m) => m.questions ?? []).find((q) => q.prompt === prompt) ?? null;
}
const stateOf = async (thread: string, prompt: string) => (await questionOf(thread, prompt))?.state ?? null;

/** A whole-window shot: light and dark on the desktop, light on the phone. */
async function shot(page: Page, tag: 'desktop' | 'phone', name: string): Promise<void> {
  for (const scheme of tag === 'phone' ? (['light'] as const) : (['light', 'dark'] as const)) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(proofDir, `${name}-${tag}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

const dialogOf = (page: Page) => page.locator('[data-decision-mode]');
const card = (page: Page) => page.locator('[data-decision-mode] [data-decision-card]');
const promptOf = (page: Page) => card(page).locator('[data-decision-question] [data-question-part="prompt"]');
const option = (page: Page, label: string) => card(page).locator('[data-question-option]', { hasText: label });

/** Whether the element is what a person sees at its middle: above the dialog, not behind it. */
function onTop(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const box = el.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return hit !== null && el.contains(hit);
  }, selector);
}

/** Decision mode's one way in: the thread, its open-questions list, then "Decide these N". */
async function openDecide(page: Page, thread: string): Promise<void> {
  await page.goto(`${world.url}#thread=${thread}`);
  await expect(page.locator('section.ib-pane [data-open-questions]')).toBeVisible();
  if (!(await page.locator('[data-open-questions-list]').isVisible())) await page.locator('section.ib-pane [data-open-questions]').click();
  await page.locator('[data-thread-decide]').click();
  await expect(dialogOf(page)).toBeVisible();
  await expect(promptOf(page)).toBeVisible();
}

/** The card of this prompt, through the read-only overview ("All"). */
async function goToCard(page: Page, prompt: string): Promise<void> {
  await dialogOf(page).locator('[data-decision-overview]').click();
  await dialogOf(page).locator('.ib-dm-allrow', { hasText: prompt }).click();
  await expect(promptOf(page)).toHaveText(prompt);
}

/** One thread to decide in: Claude Code's three questions and a file, then Codex's pick-any in the same thread. */
async function seed(subject: string): Promise<Run> {
  const asked = await world.claude.send(
    { project_path: world.harbor, subject, attachments: ['notes/rollout.md', 'proto/layout-a.html', 'proto/layout-b.html'], body: CLAUDE_BODY },
    { wakes: true },
  );
  const codex = await world.codex.send({ project_path: world.harbor, reply_to: asked.message_id as string, body: CODEX_BODY }, { wakes: true });
  return { thread: asked.thread_id as string, claudeMessage: asked.message_id as string, codexMessage: codex.message_id as string };
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-decide-e2e-');
  const dataDir = join(root, 'data');
  // Codex sends with a wake, so the person's reply to it is queued through `codex queue`: under the test sandbox the
  // Inbox looks for no codex, and the stubs first on PATH record any lookup that gets past it (the last test).
  const stubs = writeAgentCliStubs(join(root, 'agent-clis'));
  const env = {
    PATH: `${stubs}:${process.env.PATH ?? ''}`,
    HOME: root,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_BROWSER,
    PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_INBOX_PHONES: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    NO_ANON_PING: '1',
    PLANNOTATOR_TEST_SANDBOX: root,
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  expect(new URL(url).hostname).toMatch(/^(127\.0\.0\.1|localhost)$/);
  const harbor = scratchProject(join(root, 'src'), 'harbor');
  mkdirSync(join(harbor, 'shots'), { recursive: true });
  mkdirSync(join(harbor, 'proto'), { recursive: true });
  mkdirSync(join(harbor, 'notes'), { recursive: true });
  writeFileSync(join(harbor, 'shots', 'layout-a.png'), png(640, 480, [37, 99, 235]));
  writeFileSync(join(harbor, 'shots', 'layout-b.png'), png(640, 480, [22, 163, 74]));
  writeFileSync(join(harbor, 'proto', 'layout-a.html'), PROTOTYPE('Compact list', ['Harbor tide tables', 'Berth bookings', 'Pilot schedule'].map((r) => `<div class="r">${r}</div>`).join('')));
  writeFileSync(join(harbor, 'proto', 'layout-b.html'), PROTOTYPE('Cards with previews', ['Harbor tide tables — today 06:12 high', 'Berth bookings — 4 free this week', 'Pilot schedule — Ada Novak on duty'].map((r) => `<div class="r"><b>${r.split(' — ')[0]}</b><br>${r.split(' — ')[1]}</div>`).join('')));
  writeFileSync(join(harbor, 'notes', 'rollout.md'), '# Search rollout\n\n1. Warm the new index.\n2. Switch reads at 22:00.\n3. Keep the old index for a day.\n');
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const codex = await SimAgent.connect({ binary, env, name: 'Codex', host: 'codex' });
  world = { root, dataDir, stubs, url, claude, codex, harbor, context, page, errors, desktop: null };
  await fetch(`http://127.0.0.1:${port()}/api/inbox/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notifications: { dismissed: true } }) });
  // The rest of the Inbox, so the whole-window shots look like a day's work.
  await codex.send({ project_path: scratchProject(join(root, 'src'), 'fern-api'), subject: 'Partner API rate limits', body: 'Ada Novak asked for 600 requests a minute per key. The limiter is in and its numbers are in the PR.' });
  await claude.send({ project_path: scratchProject(join(root, 'src'), 'quill-docs'), subject: 'Docs search ranking', body: "Bob Tully's notes are in: guides now rank above API pages." });
  await claude.send({ project_path: scratchProject(join(root, 'src'), 'ledger'), subject: 'Month-end export', body: 'Charlie Dunn needs the CSV export by Friday; it runs nightly now.' });
});

test.afterAll(async () => {
  try {
    if (!world) return;
    for (const agent of [world.claude, world.codex]) await agent.close().catch(() => {});
    await world.context.close();
  } finally {
    await removeInboxScratch();
  }
});

/**
 * The walk, numbered as the shots are: the dialog and its cards, a picture, a prototype and a file from inside it,
 * two answers as drafts, Send, and the thread after leaving. Asserts what happens, not only what shows.
 */
async function walk(page: Page, run: Run, tag: 'desktop' | 'phone'): Promise<void> {
  const replies: { path: string; body: { questions?: { key: string }[]; words?: string } }[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && /\/api\/inbox\/messages\/[^/]+\/reply$/.test(path)) replies.push({ path, body: request.postDataJSON() });
  });
  const dialog = dialogOf(page);
  const send = dialog.locator('[data-decision-send]');

  // 01 · The dialog, on a plain question: the thread's own card, Send there and taking no press yet.
  await openDecide(page, run.thread);
  await goToCard(page, PLAIN);
  await expect(card(page).locator('fieldset[data-question-key]')).toHaveCount(1);
  await expect(send).toBeVisible();
  await expect(send).toBeDisabled();
  await shot(page, tag, '01-dialog-plain-question');

  // 02 · Before/After, the change marked, as on the thread's card.
  await goToCard(page, CHANGE);
  await expect(card(page).locator('[data-question-change-group]')).toBeVisible();
  await expect(card(page).locator('[data-question-change-after]')).toContainText('next to the search box');
  await shot(page, tag, '02-before-after');

  // 03 · Picture choices: tiles whose pictures load.
  await goToCard(page, LAYOUT);
  const tiles = card(page).locator('[data-question-tile]');
  await expect(tiles).toHaveCount(2);
  for (let i = 0; i < 2; i++) await expect.poll(() => tiles.nth(i).locator('[data-question-picture]').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  await shot(page, tag, '03-picture-choices');

  // 04 · A picture opened from inside the dialog: the viewer is above it, and a zoom answers nothing.
  await tiles.nth(1).locator('[data-question-zoom]').click();
  const viewer = page.locator('[data-image-lightbox]');
  await expect(viewer).toBeVisible();
  await expect.poll(() => onTop(page, '[data-image-lightbox]')).toBe(true);
  await shot(page, tag, '04-picture-in-the-viewer');
  await page.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);
  await expect(dialog).toBeVisible();
  expect(await stateOf(run.thread, LAYOUT)).toBe('open');

  // 05 · A prototype opened from inside the dialog: the thread's prototype window, above the dialog.
  await card(page).locator('[data-try-prototype]').click();
  const proto = page.locator('[data-prototype-window]');
  await expect(proto).toBeVisible();
  await expect(page.frameLocator('[data-prototype-window] iframe').locator('h1')).toBeVisible();
  await expect.poll(() => onTop(page, '[data-prototype-window]')).toBe(true);
  await shot(page, tag, '05-prototype');
  await proto.locator('[data-prototype-close]').click();
  await expect(proto).toHaveCount(0);
  await expect(dialog).toBeVisible();

  // 06 · The attached file opens beside the thread; the dialog waits in its pill.
  const cardId = await card(page).getAttribute('data-decision-card');
  await card(page).locator('[data-decision-file]', { hasText: 'rollout.md' }).click();
  const pane = page.locator('[data-attachment-pane]');
  await expect(pane).toBeVisible();
  await expect(page.locator('[data-decision-pill]')).toBeVisible();
  await expect(dialog).toBeHidden();
  await shot(page, tag, '06-file-open-dialog-in-its-pill');

  // 07 · The file closed: the dialog is back on the same card. A phone shows the file full screen only: its way out is
  // the bar's Back to the thread (the side-by-side header's × is not drawn there).
  const closeFile = tag === 'phone' ? pane.getByRole('button', { name: 'Back to the thread', exact: true }) : pane.getByRole('button', { name: /^Close / }).first();
  await expect(closeFile).toBeVisible();
  await closeFile.click();
  await expect(dialog).toBeVisible();
  await expect(card(page)).toHaveAttribute('data-decision-card', cardId!);
  await expect(page.locator('[data-decision-pill]')).toHaveCount(0);
  await shot(page, tag, '07-back-on-the-same-card');

  // 08 · Codex's pick-any.
  await goToCard(page, MULTI);
  await expect(card(page).locator('input[type="checkbox"]')).toHaveCount(3);
  await shot(page, tag, '08-multi-question');

  // 09 · Two answers: both drafts, Send counts them, and nothing was sent.
  await option(page, 'CSV').locator('input').click();
  await option(page, 'Parquet').locator('input').click();
  await expect.poll(() => stateOf(run.thread, MULTI)).toBe('picked');
  await goToCard(page, PLAIN);
  await option(page, 'Yes, tonight').click();
  await expect.poll(async () => (await questionOf(run.thread, PLAIN))?.answer?.selected).toEqual(['Yes, tonight']);
  await goToCard(page, PLAIN);
  await expect(card(page).locator('[data-question-tag]', { hasText: 'Draft' })).toBeVisible();
  await expect(send).toBeEnabled();
  await expect(send).toHaveText(/Send 2/);
  await page.waitForTimeout(6000);
  expect(replies, 'nothing is sent before Send').toEqual([]);
  expect(await stateOf(run.thread, PLAIN)).toBe('picked');
  await shot(page, tag, '09-two-drafts-and-send');

  // 10 · Send: one reply per agent session, each with only its answered question; the rest stay open.
  await send.click();
  await expect.poll(() => replies.length).toBe(2);
  await expect.poll(() => stateOf(run.thread, PLAIN)).toBe('sent');
  await expect.poll(() => stateOf(run.thread, MULTI)).toBe('sent');
  const plainKey = (await questionOf(run.thread, PLAIN))!.key;
  const multiKey = (await questionOf(run.thread, MULTI))!.key;
  const claudeReply = replies.find((r) => r.path.includes(run.claudeMessage));
  const codexReply = replies.find((r) => r.path.includes(run.codexMessage));
  expect(claudeReply?.body.questions?.map((q) => q.key)).toEqual([plainKey]);
  expect(codexReply?.body.questions?.map((q) => q.key)).toEqual([multiKey]);
  expect(await stateOf(run.thread, CHANGE)).toBe('open');
  expect(await stateOf(run.thread, LAYOUT)).toBe('open');
  await expect(send).toBeDisabled();
  await expect(dialog).toBeVisible();
  await goToCard(page, CHANGE);
  await shot(page, tag, '10-after-send-the-rest-still-open');

  // 11 · One more answer, then leave: nothing is asked or sent, and the thread's card holds it as a draft.
  await option(page, 'Yes, keep it there').click();
  await expect.poll(() => stateOf(run.thread, CHANGE)).toBe('picked');
  await dialog.locator('[data-decision-close]').click();
  await expect(dialog).toHaveCount(0);
  const changeKey = (await questionOf(run.thread, CHANGE))!.key;
  const threadCard = page.locator(`section.ib-pane [data-message-id="${run.claudeMessage}"] fieldset[data-question-key="${changeKey}"]`);
  await expect(threadCard.locator('[data-question-tag]', { hasText: 'Draft' })).toBeVisible();
  await threadCard.scrollIntoViewIfNeeded();
  await page.waitForTimeout(1500);
  expect(replies, 'leaving sends nothing').toHaveLength(2);
  expect(await stateOf(run.thread, CHANGE)).toBe('picked');
  expect(await stateOf(run.thread, LAYOUT)).toBe('open');
  await shot(page, tag, '11-the-thread-with-its-drafts');

  // 12 · Settings › Capabilities: the switch, on by default.
  await page.goto(`${world.url}#settings/capabilities`);
  const row = page.locator('[data-settings-decision-mode]');
  await expect(row).toBeVisible();
  await expect(row.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  await row.scrollIntoViewIfNeeded();
  await shot(page, tag, '12-settings-capabilities');
}

test('the desktop walk (1440×900, light and dark): the thread card, pictures, a prototype and a file inside, drafts, Send only when pressed', async () => {
  world.desktop = await seed('Harbor search: the last calls before 4.2');
  await world.page.goto(world.url);
  await walk(world.page, world.desktop, 'desktop');
  expect(world.errors).toEqual([]);
});

test('the phone walk (390×844, light): the same, on a phone', async () => {
  const run = await seed('Harbor search on phones: the last calls');
  const own = await chromium.launch();
  try {
    const context = await own.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: 'light' });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(world.url);
    await walk(page, run, 'phone');
    expect(errors).toEqual([]);
    await context.close();
  } finally {
    await own.close();
  }
});

test('the Capabilities switch off hides the way in and the route; on brings them back', async () => {
  const { page } = world;
  const run = await seed('Harbor search: a second look');
  await page.goto(`${world.url}#settings/capabilities`);
  const sw = page.locator('[data-settings-decision-mode]').getByRole('switch');
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  await sw.click();
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  await expect.poll(async () => (await fetch(`http://127.0.0.1:${port()}/api/inbox/decisions`)).status).toBe(404);
  try {
    await page.goto(`${world.url}#thread=${run.thread}`);
    await page.locator('section.ib-pane [data-open-questions]').click();
    await expect(page.locator('[data-open-questions-list] [data-open-question]').first()).toBeVisible();
    await expect(page.locator('[data-thread-decide]')).toHaveCount(0);
  } finally {
    await page.goto(`${world.url}#settings/capabilities`);
    const again = page.locator('[data-settings-decision-mode]').getByRole('switch');
    if ((await again.getAttribute('aria-checked')) === 'false') await again.click();
  }
  await expect.poll(async () => (await fetch(`http://127.0.0.1:${port()}/api/inbox/decisions`)).status).toBe(200);
  await page.goto(`${world.url}#thread=${run.thread}`);
  await page.locator('section.ib-pane [data-open-questions]').click();
  await expect(page.locator('[data-thread-decide]')).toBeVisible();
  expect(world.errors).toEqual([]);
});

test('the Codex session it answered is never woken through a codex CLI: none is looked up or run', async () => {
  // The desktop walk sends Codex's answer (its session sent with a wake): without that answer this proves nothing.
  expect(world.desktop, 'run this with the desktop walk').not.toBeNull();
  expect(await stateOf(world.desktop!.thread, MULTI)).toBe('sent');
  expect(agentCliCalls(world.stubs)).toEqual([]);
});
