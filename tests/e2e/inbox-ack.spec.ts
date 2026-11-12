import { devices, expect, test, webkit, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';
import { inboxWakeText, type InboxReplyCommand } from '../../packages/shared/inbox/connection';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'ack');

const QUESTION = ['Before I tag the release:', '', ':::question', 'Which currency rounding rule wins?', '', '- [ ] Banker\'s rounding', '- [ ] Half up', ':::'].join('\n');

interface World {
  root: string;
  dataDir: string;
  url: string;
  claude: SimAgent;
  context: BrowserContext;
  page: Page;
  errors: string[];
  threads: { merged: string; notes: string; phone: string; question: string; wake: string; wakeMessage: string };
}

let world: World;

async function shot(page: Page, name: string, schemes: readonly ('light' | 'dark')[] = ['light', 'dark']): Promise<void> {
  for (const scheme of schemes) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(proofDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

const footButtons = (page: Page) =>
  page.locator('section.ib-pane .ib-pfoot > .ib-acts button').evaluateAll((buttons) => buttons.map((b) => (b.textContent ?? '').replace(/\s+/g, '')));

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-ack-e2e-');
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
  const project = scratchProject(join(root, 'src'), 'plannotator');
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const question = await claude.send({ project_path: project, subject: 'Which currency rounding rule wins?', thread: 'rounding', body: QUESTION });
  const wake = await claude.send({ project_path: project, subject: 'Search index rebuilt', thread: 'search', body: 'The search index is rebuilt. Nothing needs you here.' }, { wakes: true });
  const phone = await claude.send({ project_path: project, subject: 'Docs deploy finished', thread: 'docs', body: 'The docs deploy finished. Nothing needs you here.' });
  const notes = await claude.send({ project_path: project, subject: 'Release notes for 0.29 drafted', thread: 'notes', body: 'Release notes for 0.29 are drafted in `docs/releases/0.29.md`.' });
  const merged = await claude.send({
    project_path: project,
    subject: 'Toast fix merged; CI is green',
    thread: 'toast',
    body: "Merged #1937. CI is green on `main` and the release branch picked it up.\n\nNothing needs you here. Next I'm looking at the stepping bug in full screen.",
  });
  world = {
    root,
    dataDir,
    url,
    claude,
    context,
    page,
    errors,
    threads: {
      merged: merged.thread_id as string,
      notes: notes.thread_id as string,
      phone: phone.thread_id as string,
      question: question.thread_id as string,
      wake: wake.thread_id as string,
      wakeMessage: wake.message_id as string,
    },
  };
});

test.afterAll(async () => {
  try {
    if (!world) return;
    await world.claude.close().catch(() => {});
    await world.context.close();
  } finally {
    await removeInboxScratch();
  }
});

test('the foot is Reply and Looks good side by side; no New message button; a question shows Reply and its open-questions button, no Looks good', async () => {
  const { page, threads } = world;
  await page.goto(`${world.url}#thread=${threads.merged}`);
  const ack = page.locator('section.ib-pane [data-ack]');
  await expect(ack).toBeVisible();
  expect(await footButtons(page)).toEqual(['Reply', '👍Looksgood']);
  await expect(page.locator('[data-new-message]')).toHaveCount(0);
  const [reply, thumbs] = await Promise.all([page.locator('.ib-pfoot').getByRole('button', { name: 'Reply' }).boundingBox(), ack.boundingBox()]);
  expect(Math.abs(reply!.y - thumbs!.y)).toBeLessThanOrEqual(1);
  expect(thumbs!.x - (reply!.x + reply!.width)).toBeGreaterThan(0);
  expect(thumbs!.x - (reply!.x + reply!.width)).toBeLessThanOrEqual(16);
  await shot(page, '01-before');

  await page.goto(`${world.url}#thread=${threads.question}`);
  await expect(page.locator('section.ib-pane [data-question-key]').first()).toBeVisible();
  await expect(page.locator('section.ib-pane [data-ack]')).toHaveCount(0);
  expect(await footButtons(page)).toEqual(['Reply', '1openquestion']);
  await shot(page, '02-open-question');
});

test('a click: pressed, the line and no toast, nothing sent yet; the row reads Looks good in Quiet', async () => {
  const { page, threads, claude } = world;
  await page.goto(`${world.url}#thread=${threads.merged}`);
  const ack = page.locator('section.ib-pane [data-ack]');
  await ack.click();
  await expect(ack).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-ack-pill]')).toHaveAttribute('data-ack-pill', 'pending');
  await expect(page.locator('[data-ack-pill]')).toContainText('goes to Claude Code in a few seconds');
  await expect(page.locator('[data-inbox-toast]')).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 900 });
  await shot(page, '03-after');
  const thread = await claude.readThread(threads.merged);
  expect((thread.messages as { author: { kind: string } }[]).map((m) => m.author.kind)).toEqual(['agent']);

  await page.locator('section.ib-pane [aria-label="Close the thread"]').click();
  const band = page.locator('[data-section-id="quiet"] .ib-band');
  await expect(band).toBeVisible();
  if ((await band.getAttribute('aria-expanded')) !== 'true') await band.click();
  await expect(page.locator(`[data-section-id="quiet"] [data-row="${threads.merged}"]`)).toContainText('👍 Looks good');
  await shot(page, '04-row-looks-good', ['light']);
});

test('after the Undo window the agent reads the 👍, and the line says Delivered to Claude Code', async () => {
  const { page, threads, claude } = world;
  await expect
    .poll(async () => ((await claude.readThread(threads.merged)).messages as { ack?: { label: string } | null }[]).at(-1)!.ack?.label, { timeout: 20_000 })
    .toBe('Looks good');
  await page.goto(`${world.url}#thread=${threads.merged}`);
  await expect(page.locator('[data-ack-pill]')).toHaveAttribute('data-ack-pill', 'delivered');
  await expect(page.locator('[data-ack-pill]')).toContainText(/👍 Looks good\s*Delivered to Claude Code, \d/);
  await shot(page, '05-delivered');
});

test('a waking connection: Queued, then one wake naming the message, then Delivered', async () => {
  const { page, threads, dataDir } = world;
  await page.goto(`${world.url}#thread=${threads.wake}`);
  const ack = page.locator('section.ib-pane [data-ack]');
  await ack.click();
  await expect(ack).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-ack-pill]')).toHaveAttribute('data-ack-pill', 'pending');
  const registry = JSON.parse(readFileSync(join(dataDir, 'inbox', 'inbox.json'), 'utf8')) as { port: number; token: string };
  const base = `http://127.0.0.1:${registry.port}`;
  const thread = (await (await fetch(`${base}/api/inbox/threads/${threads.wake}`)).json()) as { thread: { messages: { id: string; author: { session: string }; ack?: { settled_seq?: number | null } | null }[] } };
  const session = thread.thread.messages[0]!.author.session;
  await expect(async () => {
    await page.goto(`${world.url}#thread=${threads.wake}`);
    await expect(page.locator('[data-ack-pill]')).toHaveAttribute('data-ack-pill', 'queued', { timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
  await expect(page.locator('[data-ack-pill]')).toContainText('Queued for Claude Code; it gets this when its session is back.');
  const bridge = (path: string, body: unknown) =>
    fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${registry.token}` }, body: JSON.stringify(body) });
  expect((await bridge('/api/inbox/bridge/poll', { session, host: 'claude-code', waitMs: 0, busy: true, send_now: true })).status).toBe(200);
  await page.goto(`${world.url}#thread=${threads.wake}`);
  await expect(page.locator('[data-ack-pill]')).toContainText(/Undelivered(?: \d+ min)? · Claude Code is working · it gets this when its turn ends/);
  await expect(page.locator('[data-ack-pill]')).not.toContainText('by itself');
  await expect(page.locator('[data-send-now]')).toHaveCount(0);
  await shot(page, '06-queued');
  const polled = (await (await bridge('/api/inbox/bridge/poll', { session, host: 'claude-code', waitMs: 0 })).json()) as { commands: InboxReplyCommand[] };
  expect(polled.commands).toHaveLength(1);
  const command = polled.commands[0]!;
  expect(command.ack_of).toBe(threads.wakeMessage);
  expect(inboxWakeText(command).split('\n')[1]).toBe(`The person reacted 👍 Looks good to your message (${threads.wakeMessage}).`);
  expect((await bridge('/api/inbox/bridge/event', { session, host: 'claude-code', type: 'delivered', id: command.id })).status).toBe(200);
  expect(((await (await bridge('/api/inbox/bridge/poll', { session, host: 'claude-code', waitMs: 0 })).json()) as { commands: unknown[] }).commands).toEqual([]);
  await page.goto(`${world.url}#thread=${threads.wake}`);
  await expect(page.locator('[data-ack-pill]')).toHaveAttribute('data-ack-pill', 'delivered');
  await expect(page.locator('[data-ack-pill]')).toContainText('Delivered to Claude Code');
  await shot(page, '07-wake-delivered');
});

test('Z takes it back; no page errors', async () => {
  const { page, threads } = world;
  await page.goto(`${world.url}#thread=${threads.notes}`);
  const ack = page.locator('section.ib-pane [data-ack]');
  await ack.click();
  await expect(ack).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-ack-pill]')).toHaveAttribute('data-ack-pill', 'pending');
  await expect(async () => {
    await page.locator('body').press('z');
    await expect(ack).toHaveAttribute('aria-pressed', 'false', { timeout: 500 });
  }).toPass({ timeout: 8_000 });
  await expect(ack).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('[data-ack-pill]')).toHaveCount(0);
  expect(world.errors).toEqual([]);
});

test('phone (WebKit, iPhone 15): Reply and Looks good side by side, 44 px; after the click, the pill', async () => {
  let own: Browser | null = null;
  try {
    own = await webkit.launch({ args: [] });
    const context = await own.newContext({ ...devices['iPhone 15'], colorScheme: 'light' });
    const page = await context.newPage();
    await page.goto(`${world.url}#thread=${world.threads.phone}`);
    const ack = page.locator('section.ib-pane [data-ack]');
    await expect(ack).toBeVisible();
    await expect(page.locator('[data-new-message]')).toHaveCount(0);
    const [reply, thumbs] = await Promise.all([page.locator('.ib-pfoot').getByRole('button', { name: 'Reply' }).boundingBox(), ack.boundingBox()]);
    expect(reply!.height).toBe(44);
    expect(thumbs!.height).toBe(44);
    expect(Math.abs(reply!.y - thumbs!.y)).toBeLessThanOrEqual(1);
    await shot(page, '08-phone-before');
    await ack.tap();
    await expect(ack).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-ack-pill]')).toBeVisible();
    await shot(page, '09-phone-after');
    await context.close();
  } finally {
    await own?.close();
  }
});
