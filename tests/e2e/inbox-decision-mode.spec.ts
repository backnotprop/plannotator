/**
 * Decision mode (approval "inbox-decision-mode-one-send"), proved in a real browser against the compiled binary.
 * Nothing is mocked: the binary runs `plannotator inbox --background` under a temp PLANNOTATOR_DATA_DIR and HOME, and
 * agents ask through `plannotator inbox mcp` (scripts/inbox-sim.ts), one shim per agent session.
 *
 * On by default, with a switch in Settings → Capabilities. Its one way in is the first row of a thread's open
 * questions. It shows one agent message at a time, drawn with the thread's own cards; answers are the thread's draft;
 * Later moves a message to the end; leaving with "‹ Thread" sends nothing and the way in reads Resume; the Send step
 * lists every answer, a row opens its message, a box takes the person's words, and ONE Send sends one reply to each
 * agent session (the words ride the reply to the agent who wrote last). Desktop (Chromium, 1440 by 900) and a phone
 * (WebKit, iPhone 15), whole-window PNGs of every step, light and dark.
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`. PNGs land in
 * PLANNOTATOR_DECISION_SHOTS, else .local/proof/decision-mode/.
 */

import { devices, expect, test, webkit, type Browser, type BrowserContext, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';
import { agentCliCalls, writeAgentCliStubs } from './agent-cli-stubs';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = resolve(process.env.PLANNOTATOR_DECISION_SHOTS ?? join(repo, '.local/proof/decision-mode'));

const q = (prompt: string, choices: string[], extra: string[] = [], kind = 'question') =>
  [`:::${kind}`, prompt, '', ...extra, ...(extra.length ? [''] : []), ...choices.map((c) => `- [ ] ${c}`), ':::'].join('\n');

/** A real PNG mock (a phone frame: a light screen, a dark header and a coloured pay bar), so a card has a picture. */
function mockPng(width = 240, height = 360, accent: [number, number, number] = [91, 63, 230]): Buffer {
  const table = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = table[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const edge = x < 12 || x >= width - 12 || y < 12 || y >= height - 12;
      const header = y >= 24 && y < 44 && x >= 28 && x < 150;
      const row = (y - 64) % 46 < 30 && y >= 64 && y < 250 && x >= 28 && x < width - 28;
      const pay = y >= height - 70 && y < height - 34 && x >= 28 && x < width - 28;
      const rgb = edge ? [200, 204, 214] : pay ? accent : header ? [24, 24, 30] : row ? [236, 238, 244] : [255, 255, 255];
      raw.set(rgb, y * (width * 3 + 1) + 1 + x * 3);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

interface World {
  root: string;
  dataDir: string;
  /** Agent CLI stubs first on the Inbox's PATH: each call is recorded. */
  stubs: string;
  env: Record<string, string>;
  url: string;
  claude: SimAgent;
  codex: SimAgent;
  billing: string;
  context: BrowserContext;
  page: Page;
  errors: string[];
}
let world: World;
/** The desktop thread: Claude Code (two messages) and Codex (one) ask in it. */
const ids = { thread: '', stopped: '', picture: '', action: '' };

function port(): number {
  return (JSON.parse(readFileSync(join(world.dataDir, 'inbox', 'inbox.json'), 'utf8')) as { port: number }).port;
}

async function shot(page: Page, name: string): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(proofDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

async function personReplies(threadId: string): Promise<{ body: string }[]> {
  const model = (await (await fetch(`http://127.0.0.1:${port()}/api/inbox/threads/${threadId}`)).json()) as { thread: { messages: { author: { kind: string }; body: string }[] } };
  return model.thread.messages.filter((m) => m.author.kind === 'person');
}

const pane = (page: Page) => page.locator('section.ib-pane');
const steps = (page: Page) => pane(page).locator('[data-decide-step]');
const currentStep = (page: Page) => pane(page).locator('[data-decide-step][aria-current]');
/** The messages on screen (decision mode shows one, or none on the Send step). */
const shown = (page: Page) => pane(page).locator('.ib-pbody > [data-message-article]:visible');

/** The way in: the thread, its open-questions list, then its first row. */
async function decideIn(page: Page, threadId: string, label: RegExp | string): Promise<void> {
  await page.goto(`${world.url}#thread=${threadId}`);
  const button = pane(page).locator('[data-open-questions]');
  await expect(button).toBeVisible();
  if (!(await page.locator('[data-open-questions-list]').isVisible())) await button.click();
  const row = page.locator('[data-thread-decide]');
  await expect(row).toHaveText(label);
  await row.click();
  await expect(pane(page).locator('[data-decide-head]')).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-decide-e2e-');
  const dataDir = join(root, 'data');
  // Codex sends with a wake, so the person's reply to it is queued through `codex queue`: under the test sandbox the
  // Inbox looks for no codex, and the stubs first on PATH record any lookup that gets past it (the last test).
  const stubs = writeAgentCliStubs(join(root, 'agent-clis'));
  const env = { PATH: `${stubs}:${process.env.PATH ?? ''}`, HOME: root, PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9', PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_TEST_SANDBOX: root };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const billing = scratchProject(join(root, 'src'), 'billing-svc');
  mkdirSync(join(billing, 'design'), { recursive: true });
  writeFileSync(join(billing, 'design', 'drawer-b.png'), mockPng());
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const codex = await SimAgent.connect({ binary, env, name: 'Codex', host: 'codex' });
  world = { root, dataDir, stubs, env, url, claude, codex, billing, context, page, errors };
  await fetch(`http://127.0.0.1:${port()}/api/inbox/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notifications: { dismissed: true } }) });
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

test('on by default: the switch in Settings → Capabilities, the way in from the open questions, off takes it away', async () => {
  const { page, url, claude, codex } = world;
  const first = await claude.send(
    {
      project_path: world.billing,
      subject: 'Stripe 409 retries',
      body: `Two calls before the refund worker ships.\n\n${q('Which way should the worker go on a Stripe 409?', ['Retry with the same key — Stripe charges once per key', "Fail to the dead-letter queue — today's behavior"], ['Stopped: the refund worker cannot ship without this.', '', 'Recommended: Retry with the same key'])}\n\n${q('Page on-call after 5 tries?', ['Yes, page on-call', 'No, a daily digest'])}`,
    },
    { wakes: true },
  );
  ids.thread = first.thread_id;
  ids.stopped = first.message_id;
  const picture = await codex.send({ project_path: world.billing, reply_to: first.message_id, body: `B tested best on small phones.\n\n${q('Ship drawer B to all of checkout?', ['Yes, ship B', 'No, keep A'], ['![Drawer B](design/drawer-b.png)', '', 'Holds up: the 4.2 release'])}` }, { wakes: true });
  ids.picture = picture.message_id;
  const action = await claude.send(
    {
      project_path: world.billing,
      reply_to: first.message_id,
      body: ['The retry branch is ready to try.', '', ':::action', 'Rotate the Stripe test key', 'The old one leaked into a CI log.', '', 'Where: [Stripe](https://dashboard.stripe.com/test/apikeys)', ':::', '', q('Open the PR as a draft?', ['Yes, a draft', 'No, ready for review'])].join('\n'),
    },
    { wakes: true },
  );
  ids.action = action.message_id;

  await page.goto(`${url}#settings/capabilities`);
  const row = page.locator('[data-settings-capabilities] [data-settings-decision-mode]');
  await expect(row).toContainText('Decision mode');
  const sw = row.getByRole('switch', { name: 'Decision mode' });
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  // Not an experiment any more.
  await expect(page.locator('[data-settings-experimental] [data-settings-decision-mode]')).toHaveCount(0);
  await row.scrollIntoViewIfNeeded();
  await shot(page, '01-settings-on');
  // The row itself, close up.
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(300);
    await row.screenshot({ path: join(proofDir, `01b-settings-row-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });

  // Off: the open questions have no Decide row.
  await sw.click();
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  await expect.poll(() => JSON.parse(readFileSync(join(world.dataDir, 'config.json'), 'utf8')).inboxDecisionMode).toBe(false);
  await page.goto(`${url}#thread=${ids.thread}`);
  await pane(page).locator('[data-open-questions]').click();
  await expect(page.locator('[data-open-questions-list]')).toBeVisible();
  await expect(page.locator('[data-thread-decide]')).toHaveCount(0);
  await page.keyboard.press('Escape');

  await page.goto(`${url}#settings/capabilities`);
  await sw.click();
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => JSON.parse(readFileSync(join(world.dataDir, 'config.json'), 'utf8')).inboxDecisionMode).toBe(true);

  // Four questions and an action item: the way in is the first row.
  await page.goto(`${url}#thread=${ids.thread}`);
  await pane(page).locator('[data-open-questions]').click();
  await expect(page.locator('[data-thread-decide]')).toHaveText('Decide 5 one at a time');
  await shot(page, '02-way-in');
});

test('one message at a time with the thread\'s own cards; Later moves it to the end; leaving sends nothing and offers Resume', async () => {
  const { page } = world;
  await decideIn(page, ids.thread, 'Decide 5 one at a time');
  // Stopped first, then Holds up, then the thread's order; Send last.
  await expect(steps(page)).toHaveCount(4);
  expect(await steps(page).evaluateAll((els) => els.map((el) => el.getAttribute('data-decide-step')))).toEqual([ids.stopped, ids.picture, ids.action, 'send']);
  await expect(shown(page)).toHaveCount(1);
  await expect(shown(page)).toHaveAttribute('data-message-article', ids.stopped);
  // The thread's own head and foot rest while deciding.
  await expect(pane(page).locator('.ib-phead:not(.dm-head)')).toBeHidden();
  await expect(pane(page).locator('.ib-pfoot:not(.dm-foot)')).toBeHidden();
  await expect(pane(page).locator('[data-decide-count]')).toHaveText('Message 1 of 3');
  await shot(page, '03-message-stopped');

  // The thread's own card: a pick is a draft.
  const article = shown(page);
  await article.getByRole('radio', { name: /^Retry with the same key/ }).click();
  await article.getByRole('radio', { name: /^Yes, page on-call/ }).click();
  await expect(pane(page).locator('[data-decide-status]')).toContainText('2 of 2 answered');
  await shot(page, '04-message-answered');
  await pane(page).locator('[data-decide-next]').click();

  // Codex's picture question: Later puts it after the last message.
  await expect(shown(page)).toHaveAttribute('data-message-article', ids.picture);
  await expect(shown(page).locator('img').first()).toBeVisible();
  await shot(page, '05-message-picture');
  await pane(page).locator('[data-decide-later]').click();
  expect(await steps(page).evaluateAll((els) => els.map((el) => el.getAttribute('data-decide-step')))).toEqual([ids.stopped, ids.action, ids.picture, 'send']);
  await expect(currentStep(page)).toHaveAttribute('data-decide-step', ids.action);
  await expect(pane(page).locator(`[data-decide-step="${ids.picture}"]`)).toContainText('later');
  await shot(page, '05b-later');

  // The action item: Done waits in the draft.
  await shown(page).locator('[data-action-done]').click();
  await expect(shown(page).locator('[data-action-card]')).toHaveAttribute('data-action-state', 'pending');
  await shown(page).getByRole('radio', { name: /^Yes, a draft/ }).click();
  await shot(page, '06-message-action');

  // Leave: nothing is sent, the way in reads Resume, and it opens where the person was.
  await pane(page).locator('[data-decide-leave]').click();
  await expect(pane(page).locator('[data-decide-head]')).toHaveCount(0);
  await expect(pane(page).locator('.ib-phead')).toBeVisible();
  expect(await personReplies(ids.thread)).toEqual([]);
  await shot(page, '07-left-thread');
  // The picks stay in the thread, as its draft: the open questions say so (the thread may fold the first message).
  if (!(await page.locator('[data-open-questions-list]').isVisible())) await pane(page).locator('[data-open-questions]').click();
  await expect(page.locator('[data-open-questions-list] .ib-oq-row', { hasText: 'Which way should the worker go' }).locator('.ib-oq-draft')).toContainText('Retry with the same key');
  await expect(page.locator('[data-open-questions-list] .ib-oq-row', { hasText: 'Page on-call after 5 tries?' }).locator('.ib-oq-draft')).toContainText('Yes, page on-call');
  await expect(page.locator('[data-thread-decide]')).toHaveText('Resume · 1 of 3 messages left');
  await shot(page, '08-resume');
  await page.locator('[data-thread-decide]').click();
  await expect(currentStep(page)).toHaveAttribute('data-decide-step', ids.action);
  // Escape puts decision mode away to the thread (the thread stays open); the way back in still reads Resume.
  await shown(page).getByRole('radio', { name: /^Yes, a draft/ }).focus();
  await page.keyboard.press('Escape');
  await expect(pane(page).locator('[data-decide-head]')).toHaveCount(0);
  await expect(pane(page).locator('.ib-phead')).toBeVisible();
  expect(page.url()).toContain(`thread=${ids.thread}`);
  if (!(await page.locator('[data-open-questions-list]').isVisible())) await pane(page).locator('[data-open-questions]').click();
  await expect(page.locator('[data-thread-decide]')).toHaveText('Resume · 1 of 3 messages left');
  await page.locator('[data-thread-decide]').click();
  await expect(currentStep(page)).toHaveAttribute('data-decide-step', ids.action);
  await pane(page).locator('[data-decide-next]').click();
  await expect(shown(page)).toHaveAttribute('data-message-article', ids.picture);
  await expect(pane(page).locator('[data-decide-later]')).toHaveCount(0);
  await shown(page).getByRole('radio', { name: /^Yes, ship B/ }).click();
  expect(await personReplies(ids.thread)).toEqual([]);
  expect(world.errors).toEqual([]);
});

test('the Send step: every answer, a row back to its message, the person\'s words, then one reply per agent session', async () => {
  const { page, claude } = world;
  await pane(page).locator('[data-decide-next]').click();
  const send = pane(page).locator('[data-decide-send]');
  await expect(send).toBeVisible();
  await expect(shown(page)).toHaveCount(0);
  await expect(pane(page).locator('[data-decide-count]')).toHaveText('3 of 3 messages answered');
  await expect(send.locator('[data-reply-answer]')).toHaveCount(4);
  await shot(page, '09-send-step');

  // A row opens its message; "Back to Send" comes back.
  await send.locator(`[data-reply-answer^="${ids.stopped}/"]`).first().click();
  await expect(shown(page)).toHaveAttribute('data-message-article', ids.stopped);
  await expect(pane(page).locator('[data-decide-back-to-send]')).toBeVisible();
  await shot(page, '10-from-send');
  await pane(page).locator('[data-decide-back-to-send]').click();
  await expect(send).toBeVisible();

  await send.locator('[data-decide-words]').fill('Go ahead. Ping me when the PR is up.');
  await shot(page, '11-send-words');
  expect(await personReplies(ids.thread)).toEqual([]);
  await pane(page).locator('[data-decide-send-button]').click();
  await expect(pane(page).locator('[data-decide-head]')).toHaveCount(0);

  // One reply to each agent session: Claude Code's carries both its messages' answers, its action item and the words.
  await expect.poll(async () => (await personReplies(ids.thread)).length, { timeout: 20_000 }).toBe(2);
  const replies = await personReplies(ids.thread);
  const claudes = replies.filter((m) => m.body.includes('Retry with the same key'));
  expect(claudes).toHaveLength(1);
  expect(claudes[0]!.body).toContain('Yes, page on-call');
  expect(claudes[0]!.body).toContain('Yes, a draft');
  expect(claudes[0]!.body).toContain('Go ahead. Ping me when the PR is up.');
  const codexes = replies.filter((m) => m.body.includes('Yes, ship B'));
  expect(codexes).toHaveLength(1);
  expect(codexes[0]!.body).not.toContain('Ping me');
  expect(JSON.stringify(await claude.readThread(ids.thread))).toContain('Yes, page on-call');
  await shot(page, '12-sent-thread');
  expect(world.errors).toEqual([]);
});

test('a phone (WebKit, iPhone 15): the way in, a message, answered, Later, the big question, the Send step, Resume, the thread after Send', async () => {
  const { claude, codex } = world;
  const refunds = await claude.send(
    { project_path: world.billing, thread: 'refund-emails', subject: 'Refund emails for partial refunds and the JPY rounding rule', body: q('Send the partial-refund email?', ['Yes, send it', 'No, not yet'], ['Stopped: the email job waits on this.']) },
    { wakes: true },
  );
  const big = await codex.send({ project_path: world.billing, reply_to: refunds.message_id, body: `The receipt with the new rounding, as a customer sees it.\n\n${q('Round half-even or half-up for JPY refunds?', ['Half-even — matches Stripe', 'Half-up — what finance does today'], ['![Receipt](design/drawer-b.png)'])}` }, { wakes: true });
  const own = await webkit.launch({ args: [] });
  try {
    // A context per scheme (WebKit repaints a scheme switched mid-page only in part). Both answer (drafts) and leave;
    // light then comes back through Resume and sends.
    for (const scheme of ['dark', 'light'] as const) {
      const context = await own.newContext({ ...devices['iPhone 15'], colorScheme: scheme, reducedMotion: 'reduce' });
      const page = await context.newPage();
      const snap = async (name: string) => {
        await page.waitForTimeout(300);
        await page.screenshot({ path: join(proofDir, `phone-${name}-${scheme}.png`) });
      };
      const openList = async () => {
        if (!(await page.locator('[data-open-questions-list]').isVisible())) await pane(page).locator('[data-open-questions]').tap();
      };
      await page.goto(world.url);
      await page.goto(`${world.url}#thread=${refunds.thread_id}`);
      await openList();
      await expect(page.locator('[data-thread-decide]')).toHaveText('Decide these 2');
      await snap('01-way-in');
      await page.locator('[data-thread-decide]').tap();
      await expect(pane(page).locator('[data-decide-count]')).toHaveText('1 of 2');
      await expect(shown(page)).toHaveAttribute('data-message-article', refunds.message_id);
      for (const target of await pane(page).locator('[data-decide-foot] .ib-btn:visible').all()) {
        const b = await target.boundingBox();
        if (b) expect(b.height).toBeGreaterThanOrEqual(44);
      }
      await snap('02-message');
      // A pick is the thread's draft: the second scheme's window finds the first one's picks already there.
      const pick = async (name: RegExp) => {
        const radio = shown(page).getByRole('radio', { name });
        if (!(await radio.isChecked())) await radio.tap();
        await expect(radio).toBeChecked();
      };
      await pick(/^Yes, send it/);
      await snap('03-answered');
      // Later: Codex's message (the big one, with its picture) comes now, Claude Code's goes last.
      await pane(page).locator('[data-decide-later]').tap();
      await expect(shown(page)).toHaveAttribute('data-message-article', big.message_id);
      await expect(shown(page).locator('img').first()).toBeVisible();
      await snap('04-later-big-question');
      await pick(/^Half-even/);
      await pane(page).locator('[data-decide-next]').tap();
      await expect(shown(page)).toHaveAttribute('data-message-article', refunds.message_id);
      await pane(page).locator('[data-decide-next]').tap();
      await expect(pane(page).locator('[data-decide-send]')).toBeVisible();
      await snap('05-send-step');
      // Leave before Send: nothing goes, and the way back in says everything is answered and opens on Send.
      await pane(page).locator('[data-decide-leave]').tap();
      expect(await personReplies(refunds.thread_id)).toEqual([]);
      await openList();
      await expect(page.locator('[data-thread-decide]')).toHaveText('Resume · all answered, not sent yet');
      await snap('06-resume');
      if (scheme === 'light') {
        await page.locator('[data-thread-decide]').tap();
        await expect(pane(page).locator('[data-decide-send]')).toBeVisible();
        await pane(page).locator('[data-decide-send-button]').tap();
        await expect.poll(async () => (await personReplies(refunds.thread_id)).length, { timeout: 20_000 }).toBe(2);
        await expect(pane(page).locator('[data-decide-head]')).toHaveCount(0);
        await snap('07-sent');
      }
      await context.close();
    }
  } finally {
    await own.close();
  }
});

test('the Codex session it answered is never woken through a codex CLI: none is looked up or run', async () => {
  const answered = (await personReplies(ids.thread)).some((m) => m.body.includes('Yes, ship B'));
  expect(answered, "Codex's question was answered (run this with the Send test)").toBe(true);
  expect(agentCliCalls(world.stubs)).toEqual([]);
});
