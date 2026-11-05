/**
 * Session labels everywhere else (issue #2450, after #2467's To picker), on the compiled binary. Nothing is mocked:
 * `plannotator inbox --background` under a temp PLANNOTATOR_DATA_DIR (HOME is never set; every agent home is a temp
 * folder), sessions are the bridge's real long-polls carrying a `label` as the Claude Code mod sends it, and their
 * messages go through the Inbox's own MCP `send_message`. No real agent runs.
 *
 * Three named Claude Code sessions in one project, one unnamed, one that stops before it takes a message, and a named
 * Pi session (its extension sends Pi's session name the same way, `getSessionName` on each poll).
 *  - The @ picker offers each named session by its name, the long one cut with "…" and every row inside 390 px;
 *    the unnamed one reads as an unnamed session always has.
 *  - The thread row's agent marks are named by every session's label.
 *  - A thread's authors keep their agent's name and add the session's after it, quieter ("Claude Code · Docs pass"),
 *    folded and open heads alike, the whole label on hover and to a screen reader, inside 390 and 320 px phones; a
 *    named Pi session's message reads "Pi · …"; an unnamed session's thread looks as it did.
 *  - Send to another session lists the labels and its button says where it sends.
 *  - The "Tell your agents" dialog never appears and the page throws nothing.
 *
 * Build the binary first (see inbox.spec.ts). SESSION_LABEL_SURFACES_SHOTS: where to write PNGs and the walkthrough
 * video (none when unset). SESSION_LABEL_SURFACES_BASELINE=1 runs the same world on an older binary
 * (PLANNOTATOR_E2E_BINARY) for the "before" pictures only, with no label checks.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { INBOX_BRIDGE_POLL_PATH } from '../../packages/shared/inbox/connection';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shotsDir = process.env.SESSION_LABEL_SURFACES_SHOTS ? resolve(process.env.SESSION_LABEL_SURFACES_SHOTS) : null;
const BASELINE = process.env.SESSION_LABEL_SURFACES_BASELINE === '1';
const prefix = BASELINE ? 'before-' : 'after-';

const STRIPE = 'Stripe webhook retries';
const DOCS = 'Docs pass';
/** Longer than the picker's 40: cut in the middle. */
const AUTH = 'Migrate auth tokens from the legacy cookie store to JWTs';
/** A named Pi session: Pi's name for it, as `getSessionName()` answers. */
const PI = 'Refactor billing exports';

const S = { stripe: 'cc-stripe-6f2c9e14', docs: 'cc-docs-91b0d3aa', auth: 'cc-auth-44e1c7f0', plain: 'cc-plain-0193ab', gone: 'cc-gone-55aa01', pi: 'pi-5d1e0c7a-2b44' } as const;
const LABELS: Record<string, string | undefined> = { [S.stripe]: STRIPE, [S.docs]: DOCS, [S.auth]: AUTH, [S.pi]: PI };
const HOSTS: Record<string, string> = { [S.pi]: 'pi' };

const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, reducedMotion: 'reduce' as const };
const PHONE_320 = { ...PHONE, viewport: { width: 320, height: 640 } };

interface World {
  url: string;
  dataDir: string;
  token: string;
  project: string;
  polls: Map<string, Poll>;
  ids: { t1: string; t1msg: string; t2: string; t3: string; t4: string };
}
let world: World;
const contexts: BrowserContext[] = [];

/** One live session: the bridge's long-poll, with the tags capability and its label on every poll, as the mod (or Pi's extension) sends them. */
class Poll {
  private stopped = false;
  private readonly loop: Promise<void>;
  constructor(
    readonly session: string,
    readonly label: string | undefined,
    private readonly startedAt: number,
    readonly host = 'claude-code',
  ) {
    this.loop = this.run();
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      const response = await fetch(`${world.url}${INBOX_BRIDGE_POLL_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${world.token}` },
        body: JSON.stringify({
          session: this.session,
          host: this.host,
          waitMs: 500,
          project_path: world.project,
          started_at: this.startedAt,
          busy: false,
          idle_since: this.startedAt + 60_000,
          tags: true,
          ...(this.label === undefined ? {} : { label: this.label }),
        }),
      }).catch(() => null);
      await response?.text().catch(() => '');
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.loop;
  }
}

let rpc = 1;
/** An agent's message through the Inbox's own MCP endpoint. `agent_name` is what a model would pass; the label never comes from it. */
async function send(args: Record<string, unknown>): Promise<{ message_id: string; thread_id: string }> {
  const res = await fetch(`${world.url}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: rpc++,
      method: 'tools/call',
      params: { name: 'send_message', arguments: { agent_host: 'claude-code', agent_name: 'Claude Code', project_path: world.project, ...args }, _meta: { 'ai.plannotator/inbox-wakes': true } },
    }),
  });
  const text = await res.text();
  const line = text.split('\n').find((l) => l.startsWith('data:'));
  const json = JSON.parse(line ? line.slice(5) : text) as { error?: unknown; result?: { isError?: boolean; structuredContent: { message_id: string; thread_id: string } } };
  if (json.error || json.result?.isError) throw new Error(text);
  return json.result!.structuredContent;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${world.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = (await r.json().catch(() => null)) as T;
  if (r.status >= 400) throw new Error(`${path} ${r.status} ${JSON.stringify(json)}`);
  return json;
}

async function taggable(threadId: string): Promise<string[]> {
  const res = (await (await fetch(`${world.url}/api/inbox/threads/${threadId}/taggable`)).json()) as { sessions: { session: string }[] };
  return res.sessions.map((s) => s.session);
}

async function until(what: string, check: () => Promise<boolean>, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function shot(page: Page, name: string): Promise<void> {
  if (!shotsDir) return;
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(shotsDir, `${prefix}${name}.png`) });
}

/** Records it if the "Tell your agents" dialog ever appears on this page, from its first paint on. */
async function newPage(browser: Browser, options: Parameters<Browser['newContext']>[0] = {}): Promise<{ page: Page; errors: string[] }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', ...options });
  contexts.push(context);
  const page = await context.newPage();
  await page.addInitScript(() => {
    const seen = () => {
      if (document.querySelector('[data-dialog="agent-note"]') || document.body?.innerText.includes('Tell your agents')) (window as any).__agentNote = true;
    };
    new MutationObserver(seen).observe(document, { subtree: true, childList: true, characterData: true });
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return { page, errors };
}

async function clean(page: Page, errors: string[]): Promise<void> {
  expect(await page.evaluate(() => Boolean((window as any).__agentNote)), 'the "Tell your agents" dialog appeared').toBe(false);
  expect(errors).toEqual([]);
}

/** Open a thread and its reply box, empty. */
async function openReply(page: Page, threadId: string) {
  await page.goto(`${world.url}#thread=${threadId}`);
  const pane = page.locator('section.ib-pane');
  await expect(pane.locator('h2.ib-subject')).toBeVisible();
  const box = pane.getByRole('textbox', { name: /^Reply to/ });
  const reply = pane.locator('.ib-pfoot').getByRole('button', { name: /^(Reply|Edit draft)$/ });
  for (let attempt = 0; attempt < 10 && !(await box.isVisible()); attempt += 1) {
    await reply.click({ timeout: 1_000 }).catch(() => {});
  }
  await expect(box).toBeVisible();
  await box.fill('');
  return box;
}

/** A thread's list row: a read thread with nothing waiting folds into Quiet, so open Quiet when the row is not shown. */
async function listRow(page: Page, threadId: string) {
  const row = page.locator(`.ib-lbody [data-row="${threadId}"]`);
  await expect(page.locator('.ib-lbody [data-row]').first()).toBeVisible();
  if (!(await row.isVisible())) await page.getByRole('button', { name: /^Quiet \d+$/ }).click();
  await expect(row).toBeVisible();
  return row;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  if (shotsDir) mkdirSync(shotsDir, { recursive: true });
  const root = inboxScratch('plannotator-session-label-surfaces-e2e-');
  const dataDir = join(root, 'data');
  const project = join(root, 'src', 'billing-api');
  for (const dir of [dataDir, project, join(root, 'claude'), join(root, 'codex'), join(root, 'xdg-config'), join(root, 'xdg-data')]) mkdirSync(dir, { recursive: true });
  const past = '2026-10-01T10:00:00.000Z';
  writeFileSync(join(dataDir, 'update-state.json'), JSON.stringify({ inboxVersion: '0.0.0-dev' }));
  writeFileSync(
    join(dataDir, 'config.json'),
    JSON.stringify({
      inboxTour: { version: 2, seen_at: past, skipped_at: past },
      inboxNotifications: { dismissed: true },
      inboxAgentNotes: { offered: true, asked: ['claude-code', 'codex', 'opencode', 'pi', 'gemini', 'qwen', 'cursor'] },
      inboxSound: { dialogShownFor: '0.0.0-dev' },
      inboxListIntro: { shownAt: past },
      inboxVoiceIntro: { shownAt: past },
      inboxSnoozeIntro: { shownAt: past },
      inboxBoardIntro: { shownAt: past },
      inboxReveals: { lastShownAt: past },
    }),
  );
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    PLANNOTATOR_DATA_DIR: dataDir,
    NO_ANON_PING: '1',
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_INBOX_NOTES: '0',
    PLANNOTATOR_INBOX_PHONES: '0',
    PLANNOTATOR_INBOX_TAILSCALE: '0',
    PLANNOTATOR_TEST_SANDBOX: root,
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    CODEX_HOME: join(root, 'codex'),
    XDG_CONFIG_HOME: join(root, 'xdg-config'),
    XDG_DATA_HOME: join(root, 'xdg-data'),
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  const url = started.stdout.trim().replace(/\/$/, '');
  expect(url).not.toContain(':59812');
  const { token } = JSON.parse(readFileSync(join(dataDir, 'inbox', 'inbox.json'), 'utf8')) as { token: string };
  world = { url, dataDir, token, project, polls: new Map(), ids: { t1: '', t1msg: '', t2: '', t3: '', t4: '' } };

  const now = Date.now();
  const sessions: [string, number][] = [[S.stripe, 4], [S.docs, 2], [S.auth, 3], [S.plain, 1], [S.gone, 5], [S.pi, 6]];
  for (const [session, hours] of sessions) world.polls.set(session, new Poll(session, LABELS[session], now - hours * 3600_000, HOSTS[session]));

  // T1: Stripe owns it; the person tags Docs and Auth, both answer, Stripe goes on.
  const t1 = await send({
    agent_session: S.stripe,
    subject: 'Retry policy for the Stripe webhook',
    body: 'The webhook handler drops events when the ledger write times out. I moved retries onto the `ledger-writes` queue: 5 tries, then the dead-letter queue.',
  });
  await until('every session to poll', async () => (await taggable(t1.thread_id)).length >= sessions.length);
  const r1 = await post<{ reply: { id: string } }>(`/api/inbox/messages/${t1.message_id}/reply`, {
    idempotency_key: 'surfaces-1',
    words: `Good. @${DOCS} please document the retry limits. @Migrate auth tokens, does the token refresh hit this queue too?`,
    tags: [
      { session: S.docs, label: DOCS },
      { session: S.auth, label: 'Migrate auth tokens' },
    ],
  });
  const d1 = await send({ agent_session: S.docs, reply_to: r1.reply.id, body: 'Documented in docs/webhooks.md: 5 tries with backoff 2 s, 10 s, 60 s, 5 min, 30 min, then the dead-letter queue.' });
  await send({ agent_session: S.auth, reply_to: r1.reply.id, body: 'No. Token refresh writes to its own table and never goes through `ledger-writes`.' });
  await send({ agent_session: S.stripe, reply_to: d1.message_id, body: 'Thanks both. I turned on the dead-letter alert and linked the doc from the runbook.' });
  // T2: the unnamed session's own thread.
  const t2 = await send({ agent_session: S.plain, subject: 'Lint config cleanup', body: 'I removed the three unused ESLint plugins. `bun run lint` is clean.' });
  // T4: the named Pi session's own thread, one message (its head is the open one, with no fold button).
  const t4 = await send({ agent_host: 'pi', agent_name: 'Pi', agent_session: S.pi, subject: 'CSV export columns', body: 'The billing CSV export now writes `amount_cents` and `currency` as two columns. Old reports still parse.' });
  // T3: the person writes to a session that stops before it takes the message.
  const t3 = await post<{ thread_id: string }>('/api/inbox/messages', {
    to: { host: 'claude-code', session: S.gone },
    body: 'Rename the Quiet section to Done? Quiet reads like muted to me.',
    idempotency_key: 'surfaces-3',
  });
  await world.polls.get(S.gone)!.stop();
  world.polls.delete(S.gone);
  world.ids = { t1: t1.thread_id, t1msg: t1.message_id, t2: t2.thread_id, t3: t3.thread_id, t4: t4.thread_id };
  // The stopped session leaves the picker once it is not live (30 s).
  await until('the stopped session to leave the picker', async () => !(await taggable(t1.thread_id)).includes(S.gone), 60_000);
});

test.afterAll(async () => {
  try {
    await Promise.all(contexts.map((c) => c.close().catch(() => {})));
    if (world) await Promise.all([...world.polls.values()].map((poll) => poll.stop()));
  } finally {
    await removeInboxScratch();
  }
});

test('a thread row: its agent marks are named by every session label', async ({ browser }) => {
  test.skip(BASELINE, 'after only');
  const { page, errors } = await newPage(browser);
  await page.goto(world.url);
  const marks = (await listRow(page, world.ids.t1)).locator('[data-row-agents]');
  await expect(marks).toHaveAttribute('aria-label', '3 Claude Code sessions (Stripe webhook retries, Docs pass, Migrate auth tok…e store to JWTs)');
  await expect((await listRow(page, world.ids.t2)).locator('[data-row-agents]')).toHaveAttribute('aria-label', 'Claude Code');
  await marks.hover();
  await page.waitForTimeout(900);
  await shot(page, '02-row-agent-marks');
  await clean(page, errors);
});

test('the @ picker offers named sessions by name, the long one cut; the unnamed one as before; nothing past 390 px', async ({ browser }) => {
  for (const scheme of ['light', 'dark'] as const) {
    const { page, errors } = await newPage(browser, { colorScheme: scheme });
    const box = await openReply(page, world.ids.t1);
    await box.pressSequentially('Thanks. @');
    const picker = page.locator('[data-tag-picker]');
    await expect(picker).toBeVisible();
    await expect(page.locator(`[data-tag-option="${S.plain}"]`)).toBeVisible();
    if (!BASELINE) {
      await expect(page.locator(`[data-tag-option="${S.stripe}"] .ib-tg-on`)).toHaveText(STRIPE);
      await expect(page.locator(`[data-tag-option="${S.docs}"] .ib-tg-on`)).toHaveText(DOCS);
      const auth = (await page.locator(`[data-tag-option="${S.auth}"] .ib-tg-on`).textContent())!;
      expect(auth).toContain('…');
      expect(auth.startsWith('Migrate auth')).toBe(true);
      expect(auth.endsWith('to JWTs')).toBe(true);
      // An unnamed session keeps the words an unnamed session has.
      await expect(page.locator(`[data-tag-option="${S.plain}"] .ib-tg-on`)).toHaveText(/^Claude Code \(another session( \d+)?\)$/);
    }
    await shot(page, `01-at-picker-${scheme}`);
    await page.keyboard.press('Escape');
    await box.fill('');
    await clean(page, errors);
  }
  for (const scheme of ['light', 'dark'] as const) {
    const { page, errors } = await newPage(browser, { ...PHONE, colorScheme: scheme });
    const box = await openReply(page, world.ids.t1);
    await expect.poll(async () => Math.round((await page.locator('section.ib-pane').boundingBox())?.x ?? -1), { timeout: 10_000 }).toBe(0);
    await box.pressSequentially('@');
    await expect(page.locator('[data-tag-picker]')).toBeVisible();
    const rows = await page.locator('[data-tag-option]').evaluateAll((els) =>
      els.map((el) => {
        const name = el.querySelector<HTMLElement>('.ib-tg-on')!;
        return { right: el.getBoundingClientRect().right, nameRight: name.getBoundingClientRect().right, height: name.getBoundingClientRect().height, line: parseFloat(getComputedStyle(name).lineHeight) || 20 };
      }),
    );
    expect(rows.length).toBeGreaterThanOrEqual(4);
    for (const row of rows) {
      expect(row.right).toBeLessThanOrEqual(390);
      expect(row.nameRight).toBeLessThanOrEqual(390);
      expect(row.height, 'a name is one line').toBeLessThan(row.line * 1.6);
    }
    await shot(page, `01-at-picker-phone-390-${scheme}`);
    await page.keyboard.press('Escape');
    await box.fill('');
    await clean(page, errors);
  }
});

/** Each message head's author as drawn: the agent's part, the label's part, and whether either is cut or spills. */
async function authors(page: Page) {
  return page.locator('section.ib-pane [data-message-article]').evaluateAll((els) =>
    els.map((article) => {
      const name = article.querySelector<HTMLElement>('.ib-fl-nm')!;
      const agent = name.querySelector<HTMLElement>('[data-author-agent]');
      const part = name.querySelector<HTMLElement>('.ib-fl-lbl');
      const fold = article.querySelector<HTMLElement>('[data-fold-head]');
      const box = name.getBoundingClientRect();
      const row = name.closest<HTMLElement>('.ib-fline')!.getBoundingClientRect();
      const line = parseFloat(getComputedStyle(name).lineHeight) || 20;
      return {
        folded: article.hasAttribute('data-folded'),
        // What is drawn: the screen reader's own span left out.
        text: [...name.childNodes].filter((n) => !(n instanceof HTMLElement && n.classList.contains('ib-sr'))).map((n) => n.textContent).join(''),
        agent: agent?.textContent ?? null,
        label: part?.querySelector('[data-author-label]')?.textContent ?? null,
        agentCut: agent ? agent.scrollWidth > agent.clientWidth + 1 : false,
        agentColor: agent ? getComputedStyle(agent).color : null,
        labelColor: part ? getComputedStyle(part).color : null,
        labelWeight: part ? Number(getComputedStyle(part).fontWeight) : null,
        labelSize: part ? parseFloat(getComputedStyle(part).fontSize) : null,
        agentSize: agent ? parseFloat(getComputedStyle(agent).fontSize) : null,
        right: box.right,
        rowRight: row.right,
        oneLine: box.height < line * 1.6,
        aria: fold?.getAttribute('aria-label') ?? null,
        sr: name.querySelector('.ib-sr')?.textContent ?? null,
      };
    }),
  );
}

/** Nothing past its head row or the screen, one line; a label never cuts its agent's name, and is quieter than it. */
function expectQuietLabels(list: Awaited<ReturnType<typeof authors>>, width: number) {
  for (const a of list) {
    expect(a.right, `${a.text} stays in its row`).toBeLessThanOrEqual(a.rowRight + 0.5);
    expect(a.right, `${a.text} stays on the screen`).toBeLessThanOrEqual(width);
    expect(a.oneLine, `${a.text} is one line`).toBe(true);
    if (a.label === null) continue;
    expect(a.agentCut, `the agent's name is never cut: ${a.text}`).toBe(false);
    expect(a.labelColor, 'the label is in the secondary colour').not.toBe(a.agentColor);
    expect(a.labelWeight, 'the label is never bold').toBeLessThanOrEqual(450);
    expect(a.labelSize!, 'the label is no bigger than the name').toBeLessThanOrEqual(a.agentSize!);
  }
}

test('a thread: each author keeps its agent and adds its session label; the unnamed session thread looks as it did', async ({ browser }) => {
  const { page, errors } = await newPage(browser);
  if (!BASELINE) {
    await page.goto(`${world.url}#thread=${world.ids.t1}`);
    const pane = page.locator('section.ib-pane');
    await expect(pane.locator('h2.ib-subject')).toBeVisible();
    await expect(pane.locator('[data-session-label]').first()).toBeVisible();
    const list = await authors(page);
    // Folded and open heads alike, every agent message: "Claude Code · <label>".
    expect(list.some((a) => a.folded)).toBe(true);
    expect(list.some((a) => !a.folded)).toBe(true);
    const agents = list.filter((a) => a.text !== 'You');
    expect(agents.map((a) => a.agent)).toEqual(['Claude Code', 'Claude Code', 'Claude Code', 'Claude Code']);
    expect(agents.map((a) => a.label)).toEqual([STRIPE, DOCS, 'Migrate auth tok…e store to JWTs', STRIPE]);
    expect(agents[0]!.text).toBe(`Claude Code · ${STRIPE}`);
    // The person's reply (when drawn: a read thread folds it into "1 earlier message") is still "You", with no label part.
    for (const you of list.filter((a) => a.text === 'You')) expect(you.label).toBeNull();
    // A screen reader hears both names and the whole label on each fold button.
    expect(agents[0]!.aria?.startsWith(`Claude Code (${STRIPE}), `), agents[0]!.aria ?? "").toBe(true);
    expect(agents[2]!.aria?.startsWith(`Claude Code (${AUTH}), `), agents[2]!.aria ?? "").toBe(true);
    expectQuietLabels(list, 1440);
    // The hover says both, the whole label (the tooltip is ui's Tooltip, no native title).
    await pane.locator('[data-message-article] .ib-fl-nm[data-session-label]').nth(2).hover();
    await expect(page.locator('[data-pn-tooltip]').filter({ hasText: `Claude Code · ${AUTH}` })).toBeVisible();
    await shot(page, '03-thread-named-authors');
    await page.mouse.move(0, 0);
    // An open head (its fold button under the row): the name takes the pointer for its hover, and a click on it still folds.
    const openArticle = pane.locator('[data-message-article]:not([data-folded])').filter({ has: page.locator('.ib-fl-hit') }).last();
    const openName = openArticle.locator('.ib-fl-nm[data-session-label]');
    const openId = (await openArticle.getAttribute('data-message-article'))!;
    await openName.hover();
    await expect(page.locator('[data-pn-tooltip]').filter({ hasText: `Claude Code · ${STRIPE}` })).toBeVisible();
    await openName.click();
    await expect(pane.locator(`[data-message-article="${openId}"]`)).toHaveAttribute('data-folded', '');

    // A named Pi session: "Pi · <its name>", on a one-message thread's open head (no fold button: the head says it).
    await page.goto(`${world.url}#thread=${world.ids.t4}`);
    await expect(pane.locator('h2.ib-subject')).toHaveText('CSV export columns');
    await expect(pane.locator('[data-session-label]').first()).toBeVisible();
    const pi = await authors(page);
    expect(pi.map((a) => [a.agent, a.label])).toEqual([['Pi', PI]]);
    expect(pi[0]!.text).toBe(`Pi · ${PI}`);
    expect(pi[0]!.sr).toBe(`Pi (${PI})`);
    expectQuietLabels(pi, 1440);
    await shot(page, '03-thread-named-pi');

    // Phones: the same words, the label giving way with "…", nothing past the screen.
    for (const [name, options, width] of [['phone-390', PHONE, 390], ['phone-320', PHONE_320, 320]] as const) {
      const phone = await newPage(browser, options);
      await phone.page.goto(`${world.url}#thread=${world.ids.t1}`);
      const phonePane = phone.page.locator('section.ib-pane');
      await expect(phonePane.locator('h2.ib-subject')).toBeVisible();
      await expect.poll(async () => Math.round((await phonePane.boundingBox())?.x ?? -1), { timeout: 10_000 }).toBe(0);
      await expect(phonePane.locator('[data-session-label]').first()).toBeVisible();
      const small = await authors(phone.page);
      expect(small.filter((a) => a.text !== 'You').map((a) => a.agent)).toEqual(['Claude Code', 'Claude Code', 'Claude Code', 'Claude Code']);
      expectQuietLabels(small, width);
      await shot(phone.page, `03-thread-named-authors-${name}`);
      await clean(phone.page, phone.errors);
    }
  }
  await page.goto(`${world.url}#thread=${world.ids.t2}`);
  const pane = page.locator('section.ib-pane');
  await expect(pane.locator('h2.ib-subject')).toHaveText('Lint config cleanup');
  await expect(pane.locator('.ib-pbody')).toBeVisible();
  if (!BASELINE) {
    await expect(pane.locator('[data-session-label]')).toHaveCount(0);
    await expect(pane.locator('.ib-fl-lbl')).toHaveCount(0);
    await expect(pane.locator('.ib-pbody[data-session-labels]')).toHaveCount(0);
  }
  await expect(pane.getByText('Claude Code', { exact: true }).first()).toBeVisible();
  await shot(page, '04-unnamed-session-unchanged');
  await clean(page, errors);
});

test('Send to another session lists the labels and says where it sends', async ({ browser }) => {
  test.skip(BASELINE, 'after only');
  test.setTimeout(240_000);
  const { page, errors } = await newPage(browser);
  await page.goto(`${world.url}#thread=${world.ids.t3}`);
  const pane = page.locator('section.ib-pane');
  await expect(pane.locator('[data-delivery="undelivered"]')).toBeVisible({ timeout: 150_000 });
  await pane.locator('[data-readdress-open]').click();
  await expect(pane.locator(`[data-readdress-session="${S.docs}"] [data-session-label]`)).toHaveText(DOCS);
  await expect(pane.locator(`[data-readdress-session="${S.stripe}"] [data-session-label]`)).toHaveText(STRIPE);
  await expect(pane.locator(`[data-readdress-session="${S.plain}"] [data-session-label]`)).toHaveCount(0);
  await pane.locator(`[data-readdress-session="${S.docs}"]`).click();
  await expect(pane.locator('[data-readdress-send]')).toHaveText(`Send to ${DOCS}`);
  await shot(page, '05-send-to-another-session');
  await clean(page, errors);
});

test('walkthrough video (only with SESSION_LABEL_SURFACES_SHOTS)', async ({ browser }) => {
  test.skip(BASELINE || !shotsDir, 'pictures only');
  test.setTimeout(120_000);
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'light', recordVideo: { dir: join(shotsDir!, 'video'), size: { width: 1280, height: 800 } } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(world.url);
  const marks = (await listRow(page, world.ids.t1)).locator('[data-row-agents]');
  await expect(marks).toBeVisible();
  await page.waitForTimeout(1200);
  await marks.hover();
  await page.waitForTimeout(2500);
  await page.locator(`.ib-lbody [data-row="${world.ids.t1}"]`).click();
  await expect(page.locator('section.ib-pane h2.ib-subject')).toBeVisible();
  await page.waitForTimeout(3500);
  const box = await openReply(page, world.ids.t1);
  await box.pressSequentially('Ship it. @', { delay: 60 });
  await expect(page.locator('[data-tag-picker]')).toBeVisible();
  await page.waitForTimeout(2500);
  await box.pressSequentially('Docs', { delay: 120 });
  await page.waitForTimeout(1500);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);
  await box.fill('');
  await page.goto(`${world.url}#thread=${world.ids.t3}`);
  const pane = page.locator('section.ib-pane');
  await expect(pane.locator('[data-delivery="undelivered"]')).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1200);
  await pane.locator('[data-readdress-open]').click();
  await page.waitForTimeout(1500);
  await pane.locator(`[data-readdress-session="${S.auth}"]`).click();
  await page.waitForTimeout(2500);
  await page.goto(`${world.url}#thread=${world.ids.t2}`);
  await page.waitForTimeout(2500);
  await context.close();
  expect(errors).toEqual([]);
});
