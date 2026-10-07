/**
 * Plannotator Inbox, step 3: decisions, proved in a real browser against the
 * compiled binary. Nothing is mocked: the binary runs `plannotator inbox
 * --background` under a temp PLANNOTATOR_DATA_DIR (and HOME), agents write
 * and read through `plannotator inbox mcp` with the MCP SDK's stdio client
 * (scripts/inbox-sim.ts), and Chromium drives the window.
 *
 * What it proves (the window record's 3.1 and 3.2, the approved
 * inbox-decision-toggle): the tag is on for a `Decision: when answered`
 * question and off for a plain one; switching it off hides the row and
 * holds across a reload; the tag's words open the card under it, drafted
 * answer first; Done keeps edits; Send records a decision only where the
 * switch is on (decisions.jsonl on disk) and the thread says "Settled"; a
 * sent (read-only) card has no switch; the Decisions page lists Waiting and
 * Settled; list_decisions returns it; record_decision appears live; Retire
 * folds it; Replace keeps history.
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 * PNGs of every proved state, light and dark at 1440 by 900, land in
 * .local/proof/decisions/ with a contact sheet.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DEMO_MESSAGES, SimAgent, scratchProject } from '../../scripts/inbox-sim';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'decisions');

const Q1 = 'Which way should the worker go on a Stripe 409?';
const DRAFTED = 'Retry with the same idempotency key.';
const EDITED = 'Retry a Stripe 409 with the same idempotency key.';
const REPLACED = 'Retry a Stripe 409 with the same key, at most three times.';
const AGENT_DECISION = 'Webhooks are verified before any database write.';

interface World {
  root: string;
  dataDir: string;
  env: Record<string, string>;
  url: string;
  billing: string;
  claude: SimAgent;
  opencode: SimAgent;
  context: BrowserContext;
  page: Page;
  errors: string[];
  threadId: string;
  messageId: string;
  q1: string;
  q2: string;
  decisionId: string;
}

let world: World;

/** Every line of the project's decisions.jsonl, as written. */
function decisionLines(): { seq: number; id: string; record: Record<string, any> }[] {
  const projects = join(world.dataDir, 'inbox', 'projects');
  const out: { seq: number; id: string; record: Record<string, any> }[] = [];
  for (const key of readdirSync(projects)) {
    const file = join(projects, key, 'decisions.jsonl');
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split('\n')) if (line.trim()) out.push(JSON.parse(line));
  }
  return out;
}

/** The current snapshot per decision id. */
function decisionsOnDisk(): Map<string, Record<string, any>> {
  const out = new Map<string, Record<string, any>>();
  for (const line of decisionLines().sort((a, b) => a.seq - b.seq)) out.set(line.id, line.record);
  return out;
}

async function shot(name: string): Promise<void> {
  const page = world.page;
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(proofDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

function pane(page: Page) {
  return page.locator('section.ib-pane');
}

/** The diamonds (the switch) and the words (the card) of the thread's tags, in card order. */
function switches(page: Page) {
  return pane(page).getByRole('button', { name: 'Record as a decision', exact: true });
}
function words(page: Page) {
  return pane(page).getByRole('button', { name: 'Records a decision', exact: true });
}

function side(page: Page) {
  return page.getByRole('complementary', { name: 'Inbox navigation' });
}

async function questionOf(agent: SimAgent, key: string): Promise<Record<string, any>> {
  const thread = await agent.readThread(world.threadId);
  return thread.messages[0].questions.find((q: { key: string }) => q.key === key);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-decisions-e2e-')));
  const dataDir = join(root, 'data');
  const home = join(root, 'home');
  mkdirSync(home);
  const env = { PATH: process.env.PATH ?? '', HOME: home, PLANNOTATOR_DATA_DIR: dataDir };
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
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const opencode = await SimAgent.connect({ binary, env, name: 'OpenCode', host: 'opencode' });
  world = {
    root,
    dataDir,
    env,
    url,
    billing: scratchProject(join(root, 'src'), 'billing-svc'),
    claude,
    opencode,
    context,
    page,
    errors,
    threadId: '',
    messageId: '',
    q1: '',
    q2: '',
    decisionId: '',
  };
});

test.afterAll(async () => {
  if (!world) return;
  await Promise.all([world.claude.close().catch(() => {}), world.opencode.close().catch(() => {})]);
  await world.context.close();
  try {
    const entry = JSON.parse(readFileSync(join(world.dataDir, 'inbox', 'inbox.json'), 'utf8'));
    process.kill(entry.pid, 'SIGTERM');
  } catch {
    // Already gone.
  }
  rmSync(world.root, { recursive: true, force: true });
  const names = [...new Set(readdirSync(proofDir).filter((f) => f.endsWith('-light.png')).map((f) => f.replace(/-light\.png$/, '')))].sort();
  writeFileSync(
    join(proofDir, 'index.html'),
    `<!doctype html><meta charset="utf-8"><title>Plannotator Inbox decisions: proof</title><style>body{font:14px system-ui;margin:24px;background:#e9eaee}h2{font-size:15px;margin:24px 0 8px}.pair{display:flex;gap:12px}.pair img{width:calc(50% - 6px);box-shadow:0 0 0 1px #0002;border-radius:6px}</style><h1>Plannotator Inbox decisions: every proved state, light and dark, 1440 by 900</h1>${names
      .map((n) => `<section><h2>${n}</h2><div class="pair"><img src="${n}-light.png" alt="${n} light"><img src="${n}-dark.png" alt="${n} dark"></div></section>`)
      .join('\n')}`,
  );
});

test('the tag is on for a `Decision: when answered` question and off for a plain one', async () => {
  const { page } = world;
  const sent = await world.claude.send({ project_path: world.billing, body: DEMO_MESSAGES.stopped });
  world.threadId = sent.thread_id;
  world.messageId = sent.message_id;
  world.q1 = sent.questions[0].key;
  world.q2 = sent.questions[1].key;
  await page.goto(`${world.url}#thread=${world.threadId}`);
  await expect(pane(page).getByRole('heading', { name: Q1 })).toBeVisible();
  await expect(switches(page)).toHaveCount(2);
  await expect(switches(page).nth(0)).toHaveAttribute('aria-pressed', 'true');
  await expect(switches(page).nth(1)).toHaveAttribute('aria-pressed', 'false');
  await expect(pane(page).getByText('Answering this records a decision')).toHaveCount(1);
  // The record says so too, and the sidebar counts the one that waits.
  expect((await questionOf(world.claude, world.q1)).decision_recording).toBe(true);
  expect((await questionOf(world.claude, world.q2)).decision_recording).toBe(false);
  await expect(side(page).getByRole('button', { name: /^Decisions/ })).toContainText('1');
});

test('switching it off hides the row and holds across a reload', async () => {
  const { page } = world;
  await switches(page).nth(0).click();
  await expect(switches(page).nth(0)).toHaveAttribute('aria-pressed', 'false');
  await expect(pane(page).getByText('Answering this records a decision')).toHaveCount(0);
  await expect.poll(async () => (await questionOf(world.claude, world.q1)).decision_recording).toBe(false);
  await expect(side(page).getByRole('button', { name: /^Decisions/ })).not.toContainText('1');
  await page.reload();
  await expect(switches(page).nth(0)).toHaveAttribute('aria-pressed', 'false');
  await expect(pane(page).getByText('Answering this records a decision')).toHaveCount(0);
  await shot('3.1-switch-off');
  await switches(page).nth(0).click();
  await expect(switches(page).nth(0)).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await questionOf(world.claude, world.q1)).decision_recording).toBe(true);
});

test("the tag's words open the card under the tag, drafted answer first", async () => {
  const { page } = world;
  await pane(page).getByText('Retry with the same idempotency key', { exact: true }).click();
  await expect(pane(page).getByText(/^Picked .*, not sent$/)).toHaveCount(1);
  await words(page).nth(0).click();
  const card = page.getByRole('dialog', { name: 'Record as a decision' });
  await expect(card).toBeVisible();
  // Anchored: just under the tag's words, right edges aligned (the record's 3.1).
  const tag = (await words(page).nth(0).boundingBox())!;
  const box = (await card.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(tag.y + tag.height);
  expect(box.y - (tag.y + tag.height)).toBeLessThan(12);
  expect(Math.abs(box.x + box.width - (tag.x + tag.width))).toBeLessThan(2);
  expect(box.width).toBe(400);
  const statement = card.getByRole('textbox', { name: 'Decision' });
  await expect(statement).toBeFocused();
  await expect(statement).toHaveValue(DRAFTED);
  await expect(card.getByRole('textbox', { name: 'Why (optional)' })).toHaveValue(`Asked by Claude Code: ${Q1}`);
  await expect(card.locator('[data-decision-card-where]')).toHaveText('In billing-svc, when you send');
  await shot('3.1-decision-card');
  // Escape is Cancel: the card closes, the thread stays.
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
  await expect(pane(page)).toBeVisible();
});

test('Done keeps the edits, on the question record', async () => {
  const { page } = world;
  await words(page).nth(0).click();
  const card = page.getByRole('dialog', { name: 'Record as a decision' });
  await card.getByRole('textbox', { name: 'Decision' }).fill(EDITED);
  await card.getByRole('button', { name: 'Done' }).click();
  await expect(card).toHaveCount(0);
  await expect.poll(async () => (await questionOf(world.claude, world.q1)).decision_draft).toEqual({ text: EDITED, reason: null });
  await page.reload();
  await words(page).nth(0).click();
  await expect(card.getByRole('textbox', { name: 'Decision' })).toHaveValue(EDITED);
  await expect(card.getByRole('textbox', { name: 'Why (optional)' })).toHaveValue(`Asked by Claude Code: ${Q1}`);
  await card.getByRole('button', { name: 'Cancel' }).click();
  await expect(card).toHaveCount(0);
});

test('Send records a decision only where the switch is on, and the thread says "Settled"', async () => {
  const { page } = world;
  await pane(page).getByText('Yes', { exact: true }).click();
  await expect(pane(page).getByText(/^Picked .*, not sent$/)).toHaveCount(2);
  const reply = world.claude.waitForReply(world.threadId, 50);
  await page.locator('.ib-pfoot').getByRole('button', { name: 'Send' }).click();
  expect((await reply).status).toBe('replied');

  // On disk: one decision, the switched-on question's, in the card's words.
  const onDisk = [...decisionsOnDisk().values()];
  expect(onDisk).toHaveLength(1);
  const decision = onDisk[0]!;
  expect(decision).toMatchObject({
    text: EDITED,
    reason: `Asked by Claude Code: ${Q1}`,
    state: 'current',
    version: 1,
    source: { kind: 'answer', question_id: `${world.messageId}/${world.q1}`, message_id: world.messageId, thread_id: world.threadId },
  });
  expect(decision.id).toMatch(/^dec_[0-9A-Z]{26}$/);
  world.decisionId = decision.id;
  // The answered question names it; the switched-off one recorded nothing.
  expect((await questionOf(world.claude, world.q1)).decision_id).toBe(decision.id);
  expect((await questionOf(world.claude, world.q2)).decision_id).toBeNull();

  const settled = pane(page).locator('[data-question-settled]');
  await expect(settled).toHaveCount(1);
  await expect(settled).toHaveAttribute('data-question-settled', world.q1);
  await expect(settled).toHaveText(`Settled: ${EDITED}`);
  await shot('3.1-settled');
});

test('a sent card is read-only: the tag stays, with no switch and no card', async () => {
  const { page } = world;
  await expect(pane(page).locator('[data-question-decision-recording]')).toHaveCount(2);
  await expect(switches(page)).toHaveCount(0);
  await expect(words(page)).toHaveCount(0);
});

test('list_decisions through the MCP client returns it', async () => {
  const current = await world.claude.listDecisions(world.billing);
  expect(current.map((d) => [d.id, d.text, d.state])).toEqual([[world.decisionId, EDITED, 'current']]);
  expect(await world.claude.listDecisions(world.billing, 'retired')).toEqual([]);
});

test('the Decisions page: Waiting, then Settled; the Settled link opens the row beside the list', async () => {
  const { page } = world;
  const waiting = await world.opencode.send({
    project_path: world.billing,
    body: [':::question', 'Which queue holds the dead letters?', 'Decision: when answered', '', '- [ ] The jobs queue', '- [ ] Its own queue', ':::'].join('\n'),
  });
  await pane(page).locator('[data-question-settled] a').click();
  await expect(page).toHaveURL(new RegExp(`#decisions=prj_[0-9A-Z]{26}&decision=${world.decisionId}$`));
  const detail = page.locator(`[data-decision-pane="${world.decisionId}"]`);
  await expect(detail.getByRole('heading', { name: EDITED })).toBeVisible();
  await expect(detail).toContainText(`Asked by Claude Code: ${Q1}`);
  await expect(detail).toContainText('From your answer to Claude Code');
  await expect(detail.getByRole('button', { name: 'Open the thread' })).toBeVisible();
  await expect(detail.getByRole('button', { name: 'Retire' })).toBeVisible();
  await expect(detail.getByRole('button', { name: 'Replace' })).toBeVisible();
  await shot('3.2-decision-open');

  await detail.getByRole('button', { name: 'Close the decision' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Decisions' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Project' })).toHaveValue(/^prj_/);
  await expect(page.getByText('What holds true in billing-svc, and what waits on a call.')).toBeVisible();
  const waitingRow = page.locator(`[data-decision-group="waiting"] [data-waiting-question="${waiting.message_id}/${waiting.questions[0].key}"]`);
  await expect(waitingRow).toContainText('Which queue holds the dead letters?');
  await expect(waitingRow).toContainText('Asked by OpenCode, today');
  const row = page.locator(`[data-decision-group="settled"] [data-decision-id="${world.decisionId}"]`);
  await expect(row).toContainText(EDITED);
  await expect(row).toContainText('From your answer to Claude Code');
  await expect(row).toContainText('Recorded at Send');
  await expect(side(page).getByRole('button', { name: /^Decisions/ })).toContainText('1');
  await shot('3.2-decisions');

  // Open on a waiting question opens its thread.
  await waitingRow.getByRole('button', { name: 'Open' }).click();
  await expect(page.locator('section.ib-pane[data-thread-id]')).toHaveAttribute('data-thread-id', waiting.thread_id);
  await page.goBack();
  await expect(page.getByRole('heading', { level: 1, name: 'Decisions' })).toBeVisible();
});

test("record_decision from the simulation appears in the list, live and once", async () => {
  const { page } = world;
  const first = await world.claude.recordDecision({ project_path: world.billing, text: AGENT_DECISION, reason: 'A replayed webhook must not double-charge.', idempotency_key: 'webhook-verify' });
  const again = await world.claude.recordDecision({ project_path: world.billing, text: AGENT_DECISION, reason: 'A replayed webhook must not double-charge.', idempotency_key: 'webhook-verify' });
  expect(again.replayed).toBe(true);
  expect(again.decision.id).toBe(first.decision.id);
  const row = page.locator(`[data-decision-group="settled"] [data-decision-id="${first.decision.id}"]`);
  await expect(row).toContainText(AGENT_DECISION);
  await expect(row).toContainText('Recorded by Claude Code');
  await expect(row).toContainText('record_decision');
  await expect(page.locator('[data-decision-group="settled"] [data-decision-id]')).toHaveCount(2);
});

test('Retire moves it to the folded "Replaced or retired" group', async () => {
  const { page } = world;
  const id = (await world.claude.listDecisions(world.billing)).find((d) => d.text === AGENT_DECISION)!.id as string;
  await page.locator(`[data-decision-id="${id}"]`).click();
  const detail = page.locator(`[data-decision-pane="${id}"]`);
  await detail.getByRole('button', { name: 'Retire' }).click();
  await expect(detail.locator('.ib-dstate')).toHaveText('Retired');
  await expect(detail.getByRole('button', { name: 'Retire' })).toHaveCount(0);
  await expect(page.locator(`[data-decision-group="settled"] [data-decision-id="${id}"]`)).toHaveCount(0);
  await expect(page.locator(`[data-decision-group="ended"] [data-decision-id="${id}"]`)).toHaveAttribute('data-decision-state', 'retired');
  expect(decisionsOnDisk().get(id)).toMatchObject({ state: 'retired', version: 2 });
  // Folded when nothing in it is open.
  await detail.getByRole('button', { name: 'Close the decision' }).click();
  const band = page.locator('[data-decision-group="ended"] .ib-band');
  await expect(band).toHaveAttribute('aria-expanded', 'false');
  await expect(band).toHaveText(/^Replaced or retired\s*1$/);
  await expect(page.locator(`[data-decision-id="${id}"]`)).toHaveCount(0);
  await band.click();
  await expect(page.locator(`[data-decision-group="ended"] [data-decision-id="${id}"]`)).toBeVisible();
  await shot('3.2-retired-folded');
});

test('Replace writes a new decision and keeps the old one as replaced', async () => {
  const { page } = world;
  await page.locator(`[data-decision-id="${world.decisionId}"]`).click();
  const detail = page.locator(`[data-decision-pane="${world.decisionId}"]`);
  await detail.getByRole('button', { name: 'Replace' }).click();
  await detail.getByRole('textbox', { name: 'Decision' }).fill(REPLACED);
  await detail.getByRole('button', { name: 'Replace' }).click();

  const all = await world.claude.listDecisions(world.billing, 'all');
  const old = all.find((d) => d.id === world.decisionId)!;
  const next = all.find((d) => d.text === REPLACED)!;
  expect(old).toMatchObject({ state: 'replaced', replacement_id: next.id, version: 2, text: EDITED });
  expect(next).toMatchObject({ state: 'current', replaces_id: old.id, version: 1, source: { kind: 'person' } });
  expect((await world.claude.listDecisions(world.billing)).map((d) => d.text)).toEqual([REPLACED]);

  const opened = page.locator(`[data-decision-pane="${next.id}"]`);
  await expect(opened.getByRole('heading', { name: REPLACED })).toBeVisible();
  await expect(opened.getByRole('button', { name: EDITED })).toBeVisible();
  await expect(page.locator(`[data-decision-group="settled"] [data-decision-id="${next.id}"]`)).toBeVisible();
  await expect(page.locator(`[data-decision-group="ended"] .ib-band`)).toHaveText(/^Replaced or retired\s*2$/);
  // The old one, opened from its replacement, says what replaced it.
  await opened.getByRole('button', { name: EDITED }).click();
  const history = page.locator(`[data-decision-pane="${world.decisionId}"]`);
  await expect(history.locator('.ib-dstate')).toHaveText('Replaced');
  await expect(history.getByRole('button', { name: REPLACED })).toBeVisible();
  await expect(page.locator(`[data-decision-group="ended"] [data-decision-id="${world.decisionId}"]`)).toHaveAttribute('data-decision-state', 'replaced');
  await shot('3.2-replaced-history');
});

test('read-only per question: in a half-sent message the sent card has a plain tag, the open one keeps its switch and card', async () => {
  const { page } = world;
  const asked = await world.opencode.send({
    project_path: world.billing,
    thread: 'partial-send',
    body: [
      ':::question',
      'Log the 409 body?',
      'Decision: when answered',
      '',
      '- [ ] Yes',
      '- [ ] No',
      ':::',
      '',
      ':::question',
      'Alert on the third retry?',
      'Decision: when answered',
      '',
      '- [ ] Yes, page the on-call',
      '- [ ] No',
      ':::',
    ].join('\n'),
  });
  const [first, second] = asked.questions.map((q: { key: string }) => q.key) as [string, string];
  await page.goto(`${world.url}#thread=${asked.thread_id}`);
  const sentCard = pane(page).locator(`[data-question-key="${first}"]`);
  const openCard = pane(page).locator(`[data-question-key="${second}"]`);
  await sentCard.getByText('Yes', { exact: true }).click();
  await expect(pane(page).getByText(/^Picked .*, not sent$/)).toHaveCount(1);
  await page.locator('.ib-pfoot').getByRole('button', { name: 'Send' }).click();
  await expect(sentCard.getByText(/^Sent \d{1,2}:\d{2} [AP]M$/)).toBeVisible();

  // The sent one: its tag stays (and its decision is recorded), with no switch and no opener.
  await expect(sentCard).toHaveAttribute('data-question-decision-recording', 'on');
  await expect(sentCard.getByText('Records a decision', { exact: true })).toBeVisible();
  await expect(sentCard.getByRole('button', { name: 'Record as a decision', exact: true })).toHaveCount(0);
  await expect(sentCard.getByRole('button', { name: 'Records a decision', exact: true })).toHaveCount(0);
  await expect(pane(page).locator(`[data-question-settled="${first}"]`)).toHaveText('Settled: Yes.');
  // The open one keeps both, and its switch saves without a refusal.
  const toggle = openCard.getByRole('button', { name: 'Record as a decision', exact: true });
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(openCard.getByRole('button', { name: 'Records a decision', exact: true })).toBeVisible();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(async () => {
    const thread = await world.opencode.readThread(asked.thread_id);
    return thread.messages[0].questions.find((q: { key: string }) => q.key === second).decision_recording;
  }).toBe(false);
  await expect(pane(page).getByRole('alert')).toHaveCount(0);
  await shot('3.1-half-sent');
});

test('no page errors and no CSP refusals along the way', async () => {
  expect(world.errors).toEqual([]);
});
