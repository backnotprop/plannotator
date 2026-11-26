/**
 * A reply draft on a thread that lives on another linked machine (the owner, 2026-11-24: "Whatever I can do on one
 * computer, I should be able to do across computers"), proved in a real browser against compiled Inboxes on loopback,
 * linked through the real CLI pairing. Studio is the window's; MacBook owns the thread.
 *
 *  1. Type in MacBook's thread from Studio's window and leave: the draft is on MacBook's disk and not on Studio's, the
 *     row says Draft, and the words are back in the box after a reload.
 *  2. MacBook's own window shows the same words in its box.
 *  3. Studio's Drafts page lists it.
 *  4. The Send that carries it clears it on MacBook.
 *  5. MacBook asleep: the words typed are held here (nothing waiting, no notice) and land on MacBook when it is back.
 *
 * PNGs land in .local/proof/reply-drafts-machines/ (or PLANNOTATOR_E2E_PROOF_DIR). Build the binary first (see
 * inbox.spec.ts).
 */

import { expect, test, type Browser, type BrowserContext, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, rememberInboxOf, removeInboxScratch, stopScratchInbox } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'reply-drafts-machines');
const CLOSED = 'http://127.0.0.1:9';
const WORDS = 'Retry it once, then page me if the second try fails.';

interface Machine {
  name: string;
  dataDir: string;
  root: string;
  env: Record<string, string>;
  id: string;
  url: string;
}

let studio: Machine;
let macbook: Machine;
let context: BrowserContext;
let page: Page;
const errors: string[] = [];
const agents: SimAgent[] = [];

function machine(name: string): Machine {
  const root = inboxScratch(`plannotator-reply-drafts-machines-${name.toLowerCase()}-`);
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(bin, 'tailscale'), 0o755);
  const dataDir = join(root, 'data');
  return {
    name,
    root,
    dataDir,
    id: '',
    url: '',
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: root,
      PLANNOTATOR_DATA_DIR: dataDir,
      PLANNOTATOR_TEST_SANDBOX: root,
      PLANNOTATOR_BROWSER: NO_BROWSER,
      PLANNOTATOR_MACHINE_NAME: name,
      PLANNOTATOR_INBOX_CONNECT: '0',
      PLANNOTATOR_INBOX_PHONES: '0',
      PLANNOTATOR_INBOX_NOTES: '0',
      PLANNOTATOR_UPDATE_CHECK: '0',
      NO_ANON_PING: '1',
      PLANNOTATOR_RELAY_URL: CLOSED,
      PLANNOTATOR_UPDATE_API_URL: `${CLOSED}/releases/latest`,
      PLANNOTATOR_INSTALL_SCRIPT_URL: `${CLOSED}/install.sh`,
      PLANNOTATOR_RELEASE_DOWNLOAD_URL: `${CLOSED}/download`,
      PLANNOTATOR_FEEDBACK_URL: `${CLOSED}/feedback`,
    },
  };
}

const cli = (m: Machine, ...args: string[]) => {
  const run = spawnSync(binary, ['inbox', ...args], { env: m.env, cwd: m.root, encoding: 'utf8', timeout: 60_000 });
  return { status: run.status ?? -1, out: run.stdout ?? '', err: run.stderr ?? '' };
};
const base = (m: Machine) => `http://127.0.0.1:${(JSON.parse(readFileSync(join(m.dataDir, 'inbox', 'inbox.json'), 'utf8')) as { port: number }).port}`;
const read = async <T>(m: Machine, at: string): Promise<T> => (await (await fetch(`${base(m)}${at}`)).json()) as T;

async function start(m: Machine): Promise<void> {
  const run = cli(m, '--background');
  rememberInboxOf(m.dataDir);
  expect(run.status, run.err).toBe(0);
  m.url = run.out.trim();
  await expect.poll(async () => (m.id = (await read<{ inbox_id: string }>(m, '/api/inbox/health').catch(() => ({ inbox_id: '' }))).inbox_id), { timeout: 15_000 }).not.toBe('');
}

function link(from: Machine, to: Machine): void {
  const offered = cli(to, 'link', '--offer');
  expect(offered.status, offered.err).toBe(0);
  const linked = cli(from, 'link', offered.out.trim(), '--address', base(to), '--back', base(from));
  expect(linked.status, linked.err).toBe(0);
}

async function asked(m: Machine, subject: string): Promise<string> {
  const agent = await SimAgent.connect({ binary, env: m.env, name: 'Claude Code', host: 'claude-code', cwd: m.root });
  agents.push(agent);
  const sent = await agent.send({ project_path: scratchProject(join(m.root, 'code'), 'billing-svc'), subject, body: `${subject} Tell me how to handle a failed refund webhook.` });
  return sent.thread_id as string;
}

/** The thread's reply draft as it sits on `m`'s disk: its words, or null. */
const onDisk = (m: Machine, threadId: string): string | null => {
  const file = join(m.dataDir, 'inbox', 'reply-drafts', `${threadId}.json`);
  return existsSync(file) ? ((JSON.parse(readFileSync(file, 'utf8')) as { body: string }).body ?? null) : null;
};
const stateOf = async (viewer: Machine, other: Machine) => (await read<{ machines: { id: string; state: string }[] }>(viewer, '/api/inbox/machines')).machines.find((x) => x.id === other.id)?.state;

const row = (p: Page, id: string) => p.locator(`.ib-lbody [data-thread-id="${id}"]`);
const pane = (p: Page) => p.locator('section.ib-pane');
const box = (p: Page) => pane(p).locator('textarea');

async function shot(p: Page, name: string): Promise<void> {
  await p.evaluate(() => Promise.all(document.getAnimations().filter((motion) => motion.effect?.getTiming().iterations !== Infinity).map((motion) => motion.finished.catch(() => {}))));
  await p.screenshot({ path: join(proofDir, `${name}.png`) });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  mkdirSync(proofDir, { recursive: true });
  studio = machine('Studio');
  macbook = machine('MacBook');
  await start(studio);
  await start(macbook);
  link(studio, macbook);
  // Studio has read MacBook's list, and it keeps MacBook's drafts there.
  await expect.poll(async () => (await read<{ machines: { id: string; marks?: string[] }[] }>(studio, '/api/inbox/machines')).machines.find((m) => m.id === macbook.id)?.marks?.includes('reply-drafts') ?? false, { timeout: 30_000 }).toBe(true);
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
});

test.afterAll(async () => {
  try {
    for (const agent of agents) await agent.close().catch(() => {});
    await context?.close();
  } finally {
    await removeInboxScratch();
  }
});

let thread = '';

test("1. Type in MacBook's thread and leave: the draft is on MacBook, the row says Draft, and a reload brings the words back", async () => {
  thread = await asked(macbook, 'Refund webhook on the MacBook.');
  await page.goto(studio.url);
  await row(page, thread).click();
  await pane(page).locator('.ib-pfoot').getByRole('button', { name: 'Reply' }).click();
  await box(page).fill(WORDS);
  await expect.poll(() => onDisk(macbook, thread), { timeout: 15_000 }).toBe(WORDS);
  expect(onDisk(studio, thread)).toBeNull();
  await page.setViewportSize({ width: 1280, height: 860 });
  await shot(page, 'linked-inside-thread-draft-1280');
  await pane(page).getByRole('button', { name: 'Close the thread' }).click();
  await expect(pane(page)).toHaveCount(0);
  await expect(row(page, thread).locator('[data-draft-label]')).toHaveText('Draft');
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(row(page, thread).locator('[data-draft-label]')).toHaveText('Draft · Your reply');
  await shot(page, 'linked-list-draft-1440');
  await page.reload();
  await row(page, thread).click();
  await expect(box(page)).toHaveValue(WORDS);
  await expect(box(page)).not.toBeFocused();
});

test("2. MacBook's own window shows the same words", async ({ browser }: { browser: Browser }) => {
  const own = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  try {
    const p = await own.newPage();
    p.on('pageerror', (error) => errors.push(error.message));
    await p.goto(macbook.url);
    await expect(row(p, thread).locator('[data-draft-label]')).toHaveText('Draft · Your reply');
    await row(p, thread).click();
    await expect(box(p)).toHaveValue(WORDS);
    await shot(p, 'linked-own-window-draft-1440');
  } finally {
    await own.close();
  }
});

test("3. Studio's Drafts page lists it", async () => {
  await page.goto(studio.url);
  const nav = page.locator('[data-drafts-nav]');
  await expect(nav).toHaveText(/^Drafts\s*1$/);
  await nav.click();
  await expect(page.locator(`[data-reply-draft="${thread}"]`)).toContainText(WORDS);
  await shot(page, 'linked-drafts-page-1440');
});

test('4. The Send that carries it clears it on MacBook', async () => {
  await page.goto(studio.url);
  await row(page, thread).click();
  await expect(box(page)).toHaveValue(WORDS);
  await pane(page).getByRole('button', { name: 'Send', exact: true }).click();
  await expect(box(page)).toHaveCount(0);
  await expect.poll(() => onDisk(macbook, thread), { timeout: 15_000 }).toBeNull();
  await pane(page).getByRole('button', { name: 'Close the thread' }).click();
  await expect(row(page, thread).locator('[data-draft-label]')).toHaveCount(0);
});

test('5. MacBook asleep: the words are held here, nothing waits or warns, and they land when it is back', async () => {
  const asleep = await asked(macbook, 'A second webhook question.');
  await expect.poll(async () => JSON.stringify(await read(studio, '/api/inbox/threads?machines=1')).includes(asleep), { timeout: 15_000 }).toBe(true);
  await page.reload();
  await row(page, asleep).click();
  await pane(page).locator('.ib-pfoot').getByRole('button', { name: 'Reply' }).click();
  await expect(box(page)).toBeVisible();

  await stopScratchInbox(macbook.dataDir);
  await expect.poll(() => stateOf(studio, macbook), { timeout: 30_000 }).toBe('offline');
  await box(page).fill('Typed while the MacBook sleeps.');
  await expect
    .poll(async () => (await read<{ draft: { body: string } | null }>(studio, `/api/inbox/m/${macbook.id}/threads/${asleep}/draft`)).draft?.body ?? null, { timeout: 15_000 })
    .toBe('Typed while the MacBook sleeps.');
  const outbox = await read<{ waiting: unknown[]; notices: unknown[] }>(studio, '/api/inbox/outbox');
  expect(outbox.waiting).toEqual([]);
  expect(outbox.notices).toEqual([]);
  await expect(page.locator('[data-inbox-toast]')).toHaveCount(0);
  await shot(page, 'linked-draft-held-machine-asleep-1440');

  await start(macbook);
  await expect.poll(() => onDisk(macbook, asleep), { timeout: 45_000 }).toBe('Typed while the MacBook sleeps.');
  expect((await read<{ notices: unknown[] }>(studio, '/api/inbox/outbox')).notices).toEqual([]);
  // The page lost MacBook's stream while it slept: only those errors are expected.
  expect(errors.filter((e) => !/net::ERR_|Failed to fetch|cannot be reached/.test(e))).toEqual([]);
});
