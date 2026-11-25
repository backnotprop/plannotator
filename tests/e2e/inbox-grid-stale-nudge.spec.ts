/**
 * Grid's Stale group and Nudge (approval "inbox-agent-grid", round 4; experimental, turned on here with
 * PLANNOTATOR_EXPERIMENTAL=grid), proved in a real browser against two compiled Inboxes on loopback, Studio and Mini,
 * linked through the real CLI pairing. Their work is made up and written into each event log at times in the past
 * (inbox-grid-stale-nudge-seed.ts); the agents are made-up sessions that poll the bridge as a connection does, so
 * they are still there, and they carry names (tide-ios, wrangler, …) as Rename… gives them. The PRs' states come from
 * the forge fixture (PLANNOTATOR_TEST_FORGE_STATES): no gh runs.
 *
 *  1. Desktop: the Stale group with its count, between Not moving and Landed. Mini's Haptics on save (#22, tests
 *     failing, quiet 3 h 37 min) says "Stale 3.5 h · tests failing" in full beside its bar; no line's words are cut.
 *     Nudge shows only while the line is pointed at; one click sends exactly one reply, through Studio to Mini, with the
 *     approved words, and nothing more after; the line says "Nudged just now"; Mini keeps one nudge in the thread, and
 *     tide-ios is handed it. A Moving line's light runs meanwhile (so the reduced-motion case below means something).
 *  2. Phone: no Nudge until a line is tapped; a tap on Nightly summary opens its readout on the page's own ground
 *     (no panel) with "Nudge wrangler" beside Open thread; one tap sends one reply with the approved words.
 *  3. Reduced motion: nothing on the Grid page animates, pointed at or not.
 *
 * Proof: whole-window shots in PLANNOTATOR_E2E_PROOF_DIR/grid-stale-nudge, else .local/proof/grid-stale-nudge: the
 * desktop at 1440×900 in light and dark, the phone at 390×844.
 *
 * Build the binary first (see inbox.spec.ts).
 */
import { expect, test, type Browser, type BrowserContext, type Page, type Request } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { INBOX_BRIDGE_POLL_PATH } from '../../packages/shared/inbox/connection';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'grid-stale-nudge');
const CLOSED = 'http://127.0.0.1:9';
const MIN = 60_000;
/** The approved second sentence, word for word. */
const ASK = 'Please finish it, or tell me in a few words why it stopped.';

interface Seeded {
  threads: Record<string, string>;
  quiet: Record<string, string>;
  agents: Record<string, string>;
}

interface Machine {
  name: string;
  root: string;
  dataDir: string;
  env: Record<string, string>;
  url: string;
  id: string;
  seeded: Seeded;
}

let studio: Machine;
let mini: Machine;
const contexts: BrowserContext[] = [];
const errors: string[] = [];
let polling = true;
let pollers: Promise<void>[] = [];
/** What each agent session was handed by its polls: message id → body. */
const handed = new Map<string, Map<string, string>>();

function machine(name: string, computer: 'studio' | 'mini'): Machine {
  const root = inboxScratch(`plannotator-grid-stale-nudge-${computer}-`);
  const tools = join(root, 'bin');
  mkdirSync(tools, { recursive: true });
  for (const tool of ['tailscale', 'gh', 'glab']) {
    writeFileSync(join(tools, tool), '#!/bin/sh\nexit 1\n');
    chmodSync(join(tools, tool), 0o755);
  }
  const dataDir = join(root, 'data');
  const env = {
    PATH: `${tools}:/usr/bin:/bin`,
    HOME: root,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_TEST_SANDBOX: root,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    PLANNOTATOR_MACHINE_NAME: name,
    PLANNOTATOR_EXPERIMENTAL: 'grid',
    PLANNOTATOR_TEST_FORGE_STATES: join(root, 'forge.json'),
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
  };
  // The work, at times in the past, before the Inbox starts (the seed writes forge.json beside the data dir).
  const seeded = spawnSync('bun', [join(repo, 'tests/e2e/inbox-grid-stale-nudge-seed.ts'), dataDir, join(root, 'src'), computer], {
    cwd: repo,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_TEST_SANDBOX: root, PLANNOTATOR_RELAY_URL: CLOSED },
  });
  expect(seeded.status, seeded.stderr).toBe(0);
  return { name, root, dataDir, env, url: '', id: '', seeded: JSON.parse(seeded.stdout.trim()) as Seeded };
}

const cli = (m: Machine, ...args: string[]) => {
  const run = spawnSync(binary, ['inbox', ...args], { env: m.env, cwd: m.root, encoding: 'utf8', timeout: 60_000 });
  return { status: run.status ?? -1, out: run.stdout ?? '', err: run.stderr ?? '' };
};
const registry = (m: Machine) => JSON.parse(readFileSync(join(m.dataDir, 'inbox', 'inbox.json'), 'utf8')) as { port: number; token: string };
const base = (m: Machine) => `http://127.0.0.1:${registry(m).port}`;
const read = async <T>(m: Machine, path: string): Promise<T> => (await (await fetch(`${base(m)}${path}`)).json()) as T;

async function start(m: Machine): Promise<void> {
  const run = cli(m, '--background');
  rememberInboxOf(m.dataDir);
  expect(run.status, run.err).toBe(0);
  m.url = run.out.trim();
  expect(new URL(m.url).hostname).toMatch(/^(127\.0\.0\.1|localhost)$/);
  await expect.poll(async () => (m.id = (await read<{ inbox_id: string }>(m, '/api/inbox/health').catch(() => ({ inbox_id: '' }))).inbox_id), { timeout: 15_000 }).not.toBe('');
}

function link(from: Machine, to: Machine): void {
  const offered = cli(to, 'link', '--offer');
  expect(offered.status, offered.err).toBe(0);
  const linked = cli(from, 'link', offered.out.trim(), '--address', base(to), '--back', base(from));
  expect(linked.status, linked.err).toBe(0);
}

/** Each of the machine's agent sessions polls its bridge every 2 s, as a connection does: its agent is still there. */
function keepAgents(m: Machine): Promise<void> {
  const { token } = registry(m);
  const projectOf = (session: string) => join(m.root, 'src', session.includes('tide') || session.includes('ledger') ? 'ledger' : session.includes('quill') ? 'quill-docs' : session.includes('fern') || session.includes('wrangler') ? 'fern-api' : 'harbor');
  return (async () => {
    while (polling) {
      for (const session of Object.keys(m.seeded.agents)) {
        const answer = await fetch(`${base(m)}${INBOX_BRIDGE_POLL_PATH}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ session, host: 'claude-code', waitMs: 0, project_path: projectOf(session), busy: false }),
        })
          .then((r) => r.json() as Promise<{ commands?: { type: string; id: string; body?: string }[] }>)
          .catch(() => ({ commands: [] }));
        for (const command of answer.commands ?? []) if (command.type === 'reply') handed.set(session, (handed.get(session) ?? new Map()).set(command.id, command.body ?? ''));
      }
      await new Promise((r) => setTimeout(r, 2_000));
    }
  })();
}

/** The nudge's words for a line quiet since `quiet`, said at `at` ("3 h 37 min"), with its detail. */
function nudgeWords(name: string, quiet: string, at: number, detail: string): string {
  const minutes = Math.floor((at - Date.parse(quiet)) / MIN);
  return `${name} has been quiet for ${Math.floor(minutes / 60)} h ${minutes % 60} min${detail}. ${ASK}`;
}
/** The words at any minute the press could have fallen in (a linked computer's clock is read to the millisecond, so a minute either side). */
const wordsBetween = (name: string, quiet: string, from: number, to: number, detail: string) => [...new Set([from - MIN, from, to, to + MIN].map((at) => nudgeWords(name, quiet, at, detail)))];

/** Every reply the window posts. */
function replies(page: Page): { url: string; body: { words: string; nudge?: unknown } }[] {
  const sent: { url: string; body: { words: string; nudge?: unknown } }[] = [];
  page.on('request', (request: Request) => {
    if (request.method() === 'POST' && /\/messages\/[^/]+\/reply$/.test(new URL(request.url()).pathname)) sent.push({ url: request.url(), body: request.postDataJSON() });
  });
  return sent;
}

async function shot(page: Page, name: string, schemes: readonly ('light' | 'dark')[] = ['light', 'dark']): Promise<void> {
  for (const scheme of schemes) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(proofDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

async function open(browser: Browser, options: { phone?: boolean; reducedMotion?: 'reduce' | 'no-preference' } = {}): Promise<Page> {
  const context = await browser.newContext({
    viewport: options.phone ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: 'light',
    reducedMotion: options.reducedMotion ?? 'no-preference',
    ...(options.phone ? { isMobile: true, hasTouch: true } : {}),
  });
  contexts.push(context);
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${studio.url}#grid`);
  await expect(page.locator('[data-grid-page]')).toBeVisible();
  // Mini's work, read through the link.
  await expect(lineOf(page, mini.seeded.threads['Haptics on save']!)).toBeVisible({ timeout: 30_000 });
  return page;
}

const lineOf = (page: Page, thread: string) => page.locator(`[data-grid-line="${thread}"]`);

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  studio = machine('Studio', 'studio');
  mini = machine('Mini', 'mini');
  await start(studio);
  await start(mini);
  link(studio, mini);
  pollers = [keepAgents(studio), keepAgents(mini)];
});

test.afterAll(async () => {
  try {
    polling = false;
    await Promise.all(pollers);
    for (const context of contexts) await context.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

test('desktop: Stale with its time and why; Nudge on pointing; one click, one reply with the approved words; "Nudged just now"', async ({ browser }) => {
  test.setTimeout(120_000);
  const page = await open(browser);
  const haptics = mini.seeded.threads['Haptics on save']!;
  const line = lineOf(page, haptics);

  // The Stale group, between Not moving and Landed, with its count; its lines are the quiet ones.
  await expect(page.locator('[data-grid-counts]')).toContainText('3 stale');
  const order = await page.locator('[data-grid-group]').evaluateAll((groups) => groups.map((g) => g.getAttribute('data-grid-group')));
  expect(order.indexOf('stale')).toBeGreaterThan(order.indexOf('quiet'));
  expect(order.indexOf('stale')).toBeLessThan(order.indexOf('land'));
  await expect(page.locator('[data-grid-group="stale"] h2')).toContainText('Stale');
  await expect(line).toHaveAttribute('data-group', 'stale');
  await expect(lineOf(page, studio.seeded.threads['Nightly summary']!)).toHaveAttribute('data-group', 'stale');
  await expect(lineOf(page, studio.seeded.threads['Plan: move the docs theme to the new tokens']!)).toHaveAttribute('data-group', 'stale');
  await expect(lineOf(page, studio.seeded.threads['Rate limit the export']!)).toHaveAttribute('data-group', 'move');
  // Its agent by name, not the thread's title.
  await expect(line.locator('.ib-grid-nm')).toHaveText('tide-ios');
  // "Stale 3.5 h · tests failing", in full: the detail that says why is inside the words' column, nothing cut.
  const words = line.locator('.ib-grid-s');
  await expect(words).toContainText('Stale 3.5 h');
  await expect(words).toContainText('tests failing');
  const fit = await page.locator('[data-grid-line] .ib-grid-s').evaluateAll((all) =>
    all.map((s) => {
      const box = s.getBoundingClientRect();
      const last = s.lastElementChild?.getBoundingClientRect();
      return { text: (s as HTMLElement).innerText, cut: s.scrollWidth > s.clientWidth + 1 || (last ? last.right > box.right + 1 || last.bottom > box.bottom + 1 : false) };
    }),
  );
  expect(fit.filter((f) => f.cut)).toEqual([]);
  const detail = await line.locator('.ib-grid-s [data-bad]').boundingBox();
  const column = await words.boundingBox();
  expect(detail!.x + detail!.width).toBeLessThanOrEqual(column!.x + column!.width + 1);

  // Glint runs: a Moving line's light is animating within a few turns of the walk.
  await page.mouse.move(5, 895);
  await expect
    .poll(() => page.evaluate(() => document.getAnimations().some((a) => !!((a.effect as KeyframeEffect | null)?.target as Element | null)?.closest('[data-group="move"] .ib-grid-glc'))), { timeout: 12_000, intervals: [100] })
    .toBe(true);
  await shot(page, '01-desktop-stale');

  // Nudge shows only while the line is pointed at.
  const nudge = line.locator('[data-grid-nudge]');
  await expect(nudge).toBeHidden();
  await line.locator('.ib-grid-t').hover();
  await expect(nudge).toBeVisible();
  await expect(nudge).toHaveAccessibleName('Nudge tide-ios');
  await shot(page, '02-desktop-nudge-on-pointing', ['light']);

  const sent = replies(page);
  const quiet = mini.seeded.quiet['Haptics on save']!;
  const before = Date.now();
  await nudge.click();
  await expect(line.locator('[data-grid-nudged]')).toHaveText('Nudged just now');
  await page.waitForTimeout(2_000);
  const after = Date.now();
  // One click, one reply, through Studio to Mini's thread, with the approved words.
  expect(sent).toHaveLength(1);
  expect(sent[0]!.url).toContain(`/api/inbox/m/${mini.id}/messages/`);
  expect(wordsBetween('Haptics on save', quiet, before, after, ', with tests failing on #22')).toContain(sent[0]!.body.words);
  await expect(line.locator('[data-grid-nudge]')).toHaveCount(0);
  // Mini keeps one nudge in the thread, with those words, and hands it to tide-ios.
  await expect
    .poll(async () => (await read<{ thread: { messages: { body: string; nudge?: unknown }[] } }>(mini, `/api/inbox/threads/${haptics}`)).thread.messages.filter((m) => m.nudge).map((m) => m.body), { timeout: 15_000 })
    .toEqual([sent[0]!.body.words]);
  await expect.poll(() => [...(handed.get('ses_tide_ios')?.values() ?? [])].filter((body) => body.startsWith(sent[0]!.body.words)).length, { timeout: 15_000 }).toBe(1);
  await page.mouse.move(5, 895);
  await shot(page, '03-desktop-nudged-just-now');
  expect(errors).toEqual([]);
});

test('phone: a tap opens the stale line on the page\'s ground with Nudge beside Open thread; one tap, one reply', async ({ browser }) => {
  test.setTimeout(120_000);
  const page = await open(browser, { phone: true });
  const nightly = studio.seeded.threads['Nightly summary']!;
  const line = lineOf(page, nightly);
  await expect(line).toHaveAttribute('data-group', 'stale');
  await line.scrollIntoViewIfNeeded();
  // No pointing on a phone: nothing to nudge until the line is tapped.
  await expect(page.locator('[data-grid-nudge]')).toHaveCount(0);
  await shot(page, '04-phone-stale', ['light']);
  await line.locator('.ib-grid-name').tap();
  const readout = line.locator('[data-grid-readout]');
  await expect(readout).toBeVisible();
  const nudge = readout.locator('[data-grid-nudge]');
  await expect(nudge).toHaveText('Nudge wrangler');
  await expect(readout.getByRole('button', { name: 'Open thread' })).toBeVisible();
  // Beside it, on one row.
  const [a, b] = [await nudge.boundingBox(), await readout.getByRole('button', { name: 'Open thread' }).boundingBox()];
  expect(Math.abs(a!.y - b!.y)).toBeLessThan(4);
  // The tapped line keeps the page's ground: no grey panel behind it.
  expect(await line.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
  await readout.scrollIntoViewIfNeeded();
  await shot(page, '05-phone-tapped-stale', ['light', 'dark']);

  const sent = replies(page);
  const quiet = studio.seeded.quiet['Nightly summary']!;
  const before = Date.now();
  await nudge.tap();
  await expect(line.locator('[data-grid-nudged]')).toHaveText('Nudged just now');
  await page.waitForTimeout(2_000);
  const after = Date.now();
  expect(sent).toHaveLength(1);
  expect(wordsBetween('Nightly summary', quiet, before, after, ', with #7 still a draft')).toContain(sent[0]!.body.words);
  // One nudge in the thread, with those words, handed to wrangler.
  await expect
    .poll(async () => (await read<{ thread: { messages: { body: string; nudge?: unknown }[] } }>(studio, `/api/inbox/threads/${nightly}`)).thread.messages.filter((m) => m.nudge).map((m) => m.body), { timeout: 15_000 })
    .toEqual([sent[0]!.body.words]);
  await expect.poll(() => [...(handed.get('ses_wrangler')?.values() ?? [])].filter((body) => body.startsWith(sent[0]!.body.words)).length, { timeout: 15_000 }).toBe(1);
  await shot(page, '06-phone-nudged', ['light']);
  expect(errors).toEqual([]);
});

test('reduced motion: nothing on the Grid page animates, pointed at or not', async ({ browser }) => {
  test.setTimeout(60_000);
  const page = await open(browser, { reducedMotion: 'reduce' });
  const moving = () =>
    page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running' && !!((a.effect as KeyframeEffect | null)?.target as Element | null)?.closest('[data-grid-page]')).length);
  const counts: number[] = [];
  // Three turns of the glint's walk, then pointing at a Moving line and a Needs-you one.
  for (let i = 0; i < 20; i++) {
    counts.push(await moving());
    await page.waitForTimeout(250);
  }
  await lineOf(page, studio.seeded.threads['Rate limit the export']!).locator('.ib-grid-t').hover();
  await lineOf(page, studio.seeded.threads['Pagination cursors']!).locator('.ib-grid-t').hover();
  counts.push(await moving());
  expect(counts.every((n) => n === 0)).toBe(true);
  await shot(page, '07-desktop-reduced-motion', ['light']);
  expect(errors).toEqual([]);
});
