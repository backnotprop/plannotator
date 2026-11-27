/**
 * Reads of a linked computer's thread (mark `linked-reads`; the owner, 2026-11-24: "Whatever I can do on one
 * computer, I should be able to do across computers"), proved in a real browser against two compiled Inboxes on
 * loopback, linked through the real CLI pairing. Studio is the window's; Laptop owns the threads. Laptop has Steps
 * and Code review on; Studio has Steps off, so the checklist on Laptop's thread shows by Laptop's switch.
 *
 *  1. Laptop's thread in Studio's window: its checklist shows (read through the forward), and moves when Laptop's
 *     agent changes a step, with no reload.
 *  2. Laptop's guided review in Studio's window: expand arrows, a changed picture's preview, the package changes card
 *     and Viewed ticks, each read from Laptop through the forward; a Viewed tick lands on Laptop.
 *  3. Laptop stopped: a Viewed tick shows ticked with the thread pane's own held words ("Will send when Laptop is
 *     back") and no error; the window stays quick. Laptop back: the tick lands there once, and the held line goes.
 *  4. A code span on Laptop's thread: the code window has Laptop's file, and Copy path alone, which copies Laptop's
 *     path; no Open, and nothing ever asks to launch an app.
 *  5. Search: the Tag chip lists a tag made on Laptop, and picking it finds Laptop's thread.
 *  6. A phone at 390: the checklist and the far review the same way.
 *  7. An older peer, when PLANNOTATOR_E2E_OLDER_BINARY names a real release from before `linked-reads`: none of it
 *     shows on its threads, and the console has no errors.
 *
 * Whole-window pictures land in PLANNOTATOR_LINKED_READS_SHOTS, else .local/proof/linked-reads (CI keeps
 * .local/proof/ as the inbox-window-proof artifact). Build the binary first (see inbox.spec.ts).
 */

import { expect, test, type Browser, type BrowserContext, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, rememberInboxOf, removeInboxScratch, stopScratchInbox } from './inbox-scratch';
import { picture } from './inbox-review-images-world';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const older = process.env.PLANNOTATOR_E2E_OLDER_BINARY ? resolve(process.env.PLANNOTATOR_E2E_OLDER_BINARY) : null;
const shots = resolve(process.env.PLANNOTATOR_LINKED_READS_SHOTS ?? join(repo, '.local/proof/linked-reads'));
const CLOSED = 'http://127.0.0.1:9';

interface Machine {
  name: string;
  dataDir: string;
  root: string;
  env: Record<string, string>;
  binary: string;
  id: string;
  url: string;
}

type Json = Record<string, any>;

let studio: Machine;
let laptop: Machine;
let context: BrowserContext;
let page: Page;
/** Every console error and page error of every page, but a failed load while Laptop is stopped on purpose. */
const errors: string[] = [];
const agents: SimAgent[] = [];
/** Every request the window made, as `METHOD path`. */
const requests: string[] = [];
let laptopDown = false;
let stillOlder: Machine | null = null;

function machine(name: string, bin = binary): Machine {
  const root = inboxScratch(`plannotator-linked-reads-${name.toLowerCase().replace(/\W+/g, '-')}-`);
  const path = join(root, 'bin');
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(path, 'tailscale'), 0o755);
  const dataDir = join(root, 'data');
  for (const dir of ['claude', 'codex', 'xdg']) mkdirSync(join(root, dir), { recursive: true });
  return {
    name,
    root,
    dataDir,
    binary: bin,
    id: '',
    url: '',
    env: {
      PATH: `${path}:/usr/bin:/bin`,
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
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      CODEX_HOME: join(root, 'codex'),
      XDG_CONFIG_HOME: join(root, 'xdg'),
      PLANNOTATOR_RELAY_URL: CLOSED,
      PLANNOTATOR_UPDATE_API_URL: `${CLOSED}/releases/latest`,
      PLANNOTATOR_INSTALL_SCRIPT_URL: `${CLOSED}/install.sh`,
      PLANNOTATOR_RELEASE_DOWNLOAD_URL: `${CLOSED}/download`,
      PLANNOTATOR_FEEDBACK_URL: `${CLOSED}/feedback`,
    },
  };
}

const cli = (m: Machine, ...args: string[]) => {
  const run = spawnSync(m.binary, ['inbox', ...args], { env: m.env, cwd: m.root, encoding: 'utf8', timeout: 60_000 });
  return { status: run.status ?? -1, out: run.stdout ?? '', err: run.stderr ?? '' };
};
const base = (m: Machine) => `http://127.0.0.1:${(JSON.parse(readFileSync(join(m.dataDir, 'inbox', 'inbox.json'), 'utf8')) as { port: number }).port}`;
const read = async <T = Json>(m: Machine, path: string): Promise<T> => (await (await fetch(`${base(m)}${path}`)).json()) as T;

/** A write as the window sends it: its Origin, same-origin, this run's page session. */
async function windowPost(m: Machine, path: string, body: Json): Promise<Response> {
  const { serverSession } = await read<{ serverSession: string }>(m, '/api/inbox/health');
  return fetch(`${base(m)}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base(m), 'Sec-Fetch-Site': 'same-origin' }, body: JSON.stringify({ serverSession, ...body }) });
}

async function start(m: Machine): Promise<void> {
  const run = cli(m, '--background');
  rememberInboxOf(m.dataDir);
  expect(run.status, run.err).toBe(0);
  m.url = run.out.trim();
  await expect.poll(async () => (m.id = (await read<{ inbox_id: string }>(m, '/api/inbox/health').catch(() => ({ inbox_id: '' }))).inbox_id), { timeout: 15_000 }).not.toBe('');
}

/** Steps and Code review, as the person sets them in Settings → Capabilities. */
async function switches(m: Machine, steps: boolean): Promise<void> {
  const response = await fetch(`${base(m)}/api/inbox/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code_review: { on: true }, steps: { on: steps } }) });
  expect(response.status, await response.clone().text()).toBe(200);
}

function link(from: Machine, to: Machine): void {
  const offered = cli(to, 'link', '--offer');
  expect(offered.status, offered.err).toBe(0);
  const linked = cli(from, 'link', offered.out.trim(), '--address', base(to), '--back', base(from));
  expect(linked.status, linked.err).toBe(0);
}

function git(project: string, ...args: string[]): string {
  const run = spawnSync('git', args, {
    cwd: project,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Bob Tully', GIT_AUTHOR_EMAIL: 'bob@example.com', GIT_COMMITTER_NAME: 'Bob Tully', GIT_COMMITTER_EMAIL: 'bob@example.com' },
  });
  if (run.status !== 0) throw new Error(run.stderr);
  return run.stdout;
}

const ROUTES = 'src/routes.ts';
const MAP = 'assets/map.png';
const MANIFEST = 'package.json';
const manifest = (dependencies: Record<string, string>) => `${JSON.stringify({ name: 'fern-api', version: '1.0.0', dependencies }, null, 2)}\n`;
const routesFile = (edited: boolean) => `${Array.from({ length: 90 }, (_, i) => (i === 44 ? `export const retries = ${edited ? 5 : 3};` : `export const route${i} = '/v1/fern/${i}';`)).join('\n')}\n`;

interface Far {
  agent: SimAgent;
  /** The thread with steps and a code span (project harbor). */
  harbor: { thread: string; project: string };
  /** The guided review (project fern-api). */
  review: { thread: string; message: string };
}

/** The agent's checklist on its thread, through the `steps` tool (SimAgent keeps its MCP call private). */
const steps = (agent: SimAgent, thread: string, list: { step: string; status: string }[]) =>
  (agent as unknown as { call(name: string, args: Json): Promise<Json> }).call('steps', { thread_id: thread, steps: list, agent_name: agent.name, agent_host: agent.host });

const CHECKLIST = (second: 'doing' | 'done') => [
  { step: 'Read the berth schedule', status: 'done' },
  { step: 'Retry the tide sync', status: second },
  { step: 'Write the release note for Charlie Dunn', status: 'todo' },
];

/** On `m`: a harbor thread naming `src/berth.ts` with a checklist, and a guided review of a fern-api change. */
async function threadsOn(m: Machine): Promise<Far> {
  const agent = await SimAgent.connect({ binary: m.binary, env: m.env, name: 'Claude Code', host: 'claude-code', cwd: m.root });
  agents.push(agent);
  const harborProject = scratchProject(join(m.root, 'code'), 'harbor');
  mkdirSync(join(harborProject, 'src'), { recursive: true });
  writeFileSync(join(harborProject, 'src', 'berth.ts'), `// The berth schedule on ${m.name}.\nexport const berths = ['north', 'south'];\nexport const tideWindowMinutes = 40;\n`);
  const sent = await agent.send({ project_path: harborProject, subject: 'Harbor berth schedule', body: `Bob Tully asked for the tide sync. The schedule is in \`src/berth.ts\`; I am on step 2.` });
  const harborThread = String(sent.thread_id);
  await steps(agent, harborThread, CHECKLIST('doing'));

  const fern = scratchProject(join(m.root, 'code'), 'fern-api');
  mkdirSync(join(fern, 'src'), { recursive: true });
  mkdirSync(join(fern, 'assets'), { recursive: true });
  writeFileSync(join(fern, ROUTES), routesFile(false));
  writeFileSync(join(fern, MAP), picture(320, 200, [246, 244, 238], [{ x: 20, y: 20, w: 120, h: 80, color: [59, 110, 214] }]));
  writeFileSync(join(fern, MANIFEST), manifest({ 'left-pad': '^1.1.0' }));
  git(fern, 'add', '-A');
  git(fern, 'commit', '-q', '-m', 'base');
  writeFileSync(join(fern, ROUTES), routesFile(true));
  writeFileSync(join(fern, MAP), picture(320, 200, [246, 244, 238], [{ x: 20, y: 20, w: 120, h: 80, color: [59, 110, 214] }, { x: 180, y: 90, w: 100, h: 60, color: [232, 128, 52] }]));
  writeFileSync(join(fern, MANIFEST), manifest({ 'left-pad': '^1.3.0', 'tiny-queue': '^0.2.1' }));
  git(fern, 'add', '-A');
  git(fern, 'commit', '-q', '-m', 'the change');
  const patch = git(fern, 'diff', '--no-renames', 'HEAD~1', 'HEAD');
  const guide = {
    title: 'Fern API retries',
    intent: 'Retries go to five, the route map shows the new region, and the queue joins the dependencies.',
    sections: [
      { title: 'Retries', overview: 'One number moves.', diffs: [{ file: ROUTES, summary: 'Five retries.' }] },
      { title: 'Map and packages', overview: 'A picture and the manifest.', diffs: [{ file: MAP, summary: 'The new region.' }, { file: MANIFEST, summary: 'tiny-queue in, left-pad up.' }] },
    ],
  };
  const review = await agent.submitGuide({ project_path: fern, subject: guide.title, guide, patch, body: 'Three files for you.', review: true } as never);
  return { agent, harbor: { thread: harborThread, project: harborProject }, review: { thread: String(review.thread_id), message: String(review.message_id) } };
}

const stateOf = async (viewer: Machine, other: Machine) => (await read<{ machines: { id: string; state: string }[] }>(viewer, '/api/inbox/machines')).machines.find((x) => x.id === other.id)?.state;
const viewedOn = async (m: Machine, thread: string, message: string): Promise<string[]> =>
  ((await read<{ thread: { messages: { id: string; guide_viewed?: string[] }[] } }>(m, `/api/inbox/threads/${thread}`)).thread.messages.find((x) => x.id === message)?.guide_viewed ?? []).slice().sort();
const settled = (on: Page) => on.evaluate(() => Promise.all(document.getAnimations().filter((motion) => motion.effect?.getTiming().iterations !== Infinity).map((motion) => motion.finished.catch(() => {}))));
const shell = (on: Page, path: string) => on.locator(`[data-guide-file-shell="${path}"]`);
const pane = (on: Page) => on.locator('[data-review-message]');

/** Whole-window pictures, light and dark (the window follows the system's scheme). */
async function shoot(on: Page, name: string, dark = true, hovering = false): Promise<void> {
  // Out of the way, but for a hover window's picture: moving off its words closes it.
  if (!hovering) await on.mouse.move(0, 0).catch(() => {});
  await settled(on);
  await on.screenshot({ path: join(shots, `${name}-light.png`) });
  if (!dark) return;
  await on.emulateMedia({ colorScheme: 'dark' });
  await settled(on);
  await on.screenshot({ path: join(shots, `${name}-dark.png`) });
  await on.emulateMedia({ colorScheme: 'light' });
}

function watch(on: Page): void {
  on.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  on.on('console', (message) => {
    if (message.type() !== 'error') return;
    // A read of Laptop failing while the spec stopped it on purpose is the browser's network log, not the window's.
    if (laptopDown && /Failed to load resource/.test(message.text())) return;
    // A failed load names its resource only in its location: kept, so a failure here says which read it was.
    const at = message.location().url;
    errors.push(`console: ${message.text()}${at ? ` (${at.replace(/^https?:\/\/[^/]+/, '')})` : ''}`);
  });
  on.on('request', (request) => requests.push(`${request.method()} ${new URL(request.url()).pathname}`));
}

/**
 * Open `hash` (a thread of `thread`'s machine) in `on` as a person does from the list: the window is loaded and its
 * list names the thread's machine first. A link opened cold reads the thread on this Inbox before that list lands (a
 * 404, then the read on its machine: panes/paneReads.ts, proved in inbox-machines.spec.ts 2d), and Ask reads it too.
 */
async function openFromList(on: Page, thread: string, hash: string): Promise<void> {
  if (on.url().startsWith(studio.url)) {
    // Loaded: its list names the thread once it draws its row.
    await expect(on.locator(`[data-thread-id="${thread}"]`).first()).toBeAttached({ timeout: 20_000 });
  } else {
    // Loaded now: its own list read names the thread (a read thread is in a closed Quiet band: no row is drawn).
    const listed = on.waitForResponse(async (r) => r.request().method() === 'GET' && new URL(r.url()).pathname === '/api/inbox/threads' && (await r.text().catch(() => '')).includes(thread), { timeout: 20_000 });
    await on.goto(studio.url);
    await listed;
    await expect(on.locator('.ib-band, [data-thread-id]').first()).toBeAttached({ timeout: 20_000 });
  }
  await on.goto(`${studio.url}#${hash}`);
}

let far: Far;
let ownThread = '';

test.describe.configure({ mode: 'serial' });
test.use({ actionTimeout: 20_000 });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  mkdirSync(shots, { recursive: true });
  studio = machine('Studio');
  laptop = machine('Laptop');
  await start(studio);
  await start(laptop);
  await switches(studio, false);
  await switches(laptop, true);
  link(studio, laptop);
  far = await threadsOn(laptop);
  // Studio's own thread, for the window's own reads while Laptop is stopped.
  const own = await SimAgent.connect({ binary, env: studio.env, name: 'Claude Code', host: 'claude-code', cwd: studio.root });
  agents.push(own);
  ownThread = String((await own.send({ project_path: scratchProject(join(studio.root, 'code'), 'fern-api'), subject: 'Fern API rate limits on Studio', body: 'Rate limits are set for the fern-api gateway.' })).thread_id);
  await expect
    .poll(async () => {
      const merged = JSON.stringify(await read(studio, '/api/inbox/threads?machines=1'));
      return merged.includes(far.harbor.thread) && merged.includes(far.review.thread);
    }, { timeout: 20_000 })
    .toBe(true);
  await expect.poll(async () => ((await read<{ machines: { id: string; marks: string[] }[] }>(studio, '/api/inbox/machines')).machines.find((x) => x.id === laptop.id)?.marks ?? []).includes('linked-reads'), { timeout: 20_000 }).toBe(true);
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(studio.url).origin });
  page = await context.newPage();
  watch(page);
});

test.afterAll(async () => {
  try {
    for (const agent of agents) await agent.close().catch(() => {});
    await context?.close();
    if (stillOlder) cli(stillOlder, 'stop');
  } finally {
    await removeInboxScratch();
  }
});

test("1. Laptop's checklist on its thread in Studio's window, by Laptop's switch; it moves when Laptop's agent changes a step", async () => {
  await openFromList(page, far.harbor.thread, `thread=${far.harbor.thread}`);
  const button = page.locator('[data-steps-button]');
  await expect(button).toBeVisible({ timeout: 20_000 });
  // A step in progress: the button's spinner and its count (the pie shows only when none is worked on).
  await expect(button).toContainText('1/3');
  await expect(button.locator('[data-step-mark="doing"]')).toHaveCount(1);
  // Read on Laptop, through the forward: Studio's own Steps switch is off.
  expect(requests).toContain(`GET /api/inbox/m/${laptop.id}/threads/${far.harbor.thread}/steps`);
  await button.click();
  const panel = page.locator('[data-steps-panel]');
  await expect(panel.locator('[data-step-status]')).toHaveCount(3);
  await expect(panel.locator('[data-step-status="doing"]')).toContainText('Retry the tide sync');
  await shoot(page, '01-steps');
  await page.keyboard.press('Escape');

  // Laptop's agent moves a step: the open thread's checklist follows with no reload.
  await steps(far.agent, far.harbor.thread, CHECKLIST('done'));
  await expect(button).toContainText('2/3', { timeout: 20_000 });
  await expect(button.locator('[data-steps-pie="2/3"]')).toHaveCount(1);
  await button.click();
  await expect(panel.locator('[data-step-status="done"]')).toHaveCount(2);
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

test("2. Laptop's guided review in Studio's window: expand arrows, a picture's preview, package changes and Viewed, all read on Laptop", async () => {
  await page.goto(`${studio.url}#thread=${far.review.thread}&guide=${far.review.message}`);
  await expect(pane(page)).toBeVisible({ timeout: 20_000 });
  const routes = shell(page, ROUTES);
  await expect(routes).toBeVisible({ timeout: 30_000 });
  // The expand arrows read Laptop's whole file.
  const arrow = routes.locator('[data-expand-button]').first();
  await expect(arrow).toBeVisible({ timeout: 30_000 });
  await arrow.click();
  await expect.poll(() => requests.some((r) => r.startsWith(`GET /api/inbox/m/${laptop.id}/messages/${far.review.message}/guide/file`)), { timeout: 15_000 }).toBe(true);

  // The changed picture's preview: both sides drawn from Laptop's blobs.
  const map = shell(page, MAP);
  await map.scrollIntoViewIfNeeded();
  const preview = map.locator('[data-image-diff-preview]');
  await expect(preview).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(() => preview.locator('img[src^="blob:"]').evaluateAll((imgs) => imgs.filter((img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0).length), { timeout: 20_000 })
    .toBeGreaterThanOrEqual(2);
  await expect(preview.locator('[data-image-error]')).toHaveCount(0);
  expect(requests.some((r) => r.startsWith(`GET /api/inbox/m/${laptop.id}/messages/${far.review.message}/guide/review-image`))).toBe(true);

  // The package changes card, from Laptop's patch.
  const card = shell(page, MANIFEST).locator(`[data-package-changes="ready"][data-package-changes-path="${MANIFEST}"]`);
  await card.scrollIntoViewIfNeeded();
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).toContainText('tiny-queue');
  expect(requests.some((r) => r.startsWith(`GET /api/inbox/m/${laptop.id}/messages/${far.review.message}/guide/package-changes`))).toBe(true);
  await map.scrollIntoViewIfNeeded();
  await shoot(page, '02-review');

  // A Viewed tick lands on Laptop, not Studio.
  const viewed = shell(page, MAP).locator('[data-file-header-viewed]').first();
  await expect(viewed).toHaveAttribute('aria-pressed', 'false');
  await viewed.click();
  await expect(viewed).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => viewedOn(laptop, far.review.thread, far.review.message), { timeout: 15_000 }).toEqual([MAP]);
  expect(errors).toEqual([]);
});

test('3. Laptop stopped: a Viewed tick shows ticked with the held words and no error; the window stays quick; Laptop back, it lands once', async () => {
  const review = pane(page);
  await expect(review).toBeVisible();
  laptopDown = true;
  await stopScratchInbox(laptop.dataDir);
  await expect.poll(() => stateOf(studio, laptop), { timeout: 30_000 }).toBe('offline');

  const routes = shell(page, ROUTES);
  await routes.scrollIntoViewIfNeeded();
  const viewed = routes.locator('[data-file-header-viewed]').first();
  await viewed.click();
  await expect(viewed).toHaveAttribute('aria-pressed', 'true');
  const held = review.locator('[data-review-held] [data-outbox-line]');
  await expect(held).toBeVisible({ timeout: 15_000 });
  await expect(held).toHaveText('Will send when Laptop is back');
  await expect(held).toHaveAttribute('data-delivery', 'queued');
  await expect(review.locator('.ib-error, [role="alert"]')).toHaveCount(0);
  // The first tick, kept on Laptop, still shows.
  await expect(shell(page, MAP).locator('[data-file-header-viewed]').first()).toHaveAttribute('aria-pressed', 'true');
  await shoot(page, '04-held-viewed');

  // The window stays quick with Laptop stopped: the review answers a press, and Studio's own thread opens in a tab.
  await review.locator('[data-review-mode-choice="files"]').click();
  await expect(review).toHaveAttribute('data-review-mode', 'files');
  await review.locator('[data-review-mode-choice="walkthrough"]').click();
  await expect(review).toHaveAttribute('data-review-mode', 'walkthrough');
  const other = await context.newPage();
  watch(other);
  const at = Date.now();
  await other.goto(`${studio.url}#thread=${ownThread}`);
  await expect(other.getByText('Rate limits are set for the fern-api gateway.')).toBeVisible({ timeout: 10_000 });
  expect(Date.now() - at).toBeLessThan(10_000);
  await other.close();

  await start(laptop);
  // Away until Studio sees it back: a read in between is Studio's "cannot be reached now" (503), as while it was down.
  await expect.poll(() => stateOf(studio, laptop), { timeout: 30_000 }).toBe('online');
  laptopDown = false;
  await expect.poll(() => viewedOn(laptop, far.review.thread, far.review.message), { timeout: 45_000 }).toEqual([MAP, ROUTES].sort());
  // Landed: the held line goes, with no reload, and nothing is left waiting.
  await expect(held).toHaveCount(0, { timeout: 30_000 });
  await expect(viewed).toHaveAttribute('aria-pressed', 'true');
  const waiting = (await read<{ waiting: { route: string }[] }>(studio, '/api/inbox/outbox')).waiting.filter((entry) => entry.route.endsWith('/guide/viewed'));
  expect(waiting).toEqual([]);
  // Once: Laptop keeps the two files, each once.
  expect(await viewedOn(laptop, far.review.thread, far.review.message)).toEqual([MAP, ROUTES].sort());
  await shoot(page, '04b-viewed-landed', false);
  expect(errors).toEqual([]);
});

test("4. A code span on Laptop's thread: Laptop's file and its path there, Copy path alone, no launch", async () => {
  await page.goto(`${studio.url}#thread=${far.harbor.thread}`);
  const words = page.locator('.ib-body [data-code-hover="src/berth.ts"]').first();
  await expect(words).toBeVisible({ timeout: 20_000 });
  const checked = page.waitForResponse((response) => response.request().method() === 'GET' && new URL(response.url()).pathname === `/api/inbox/m/${laptop.id}/open-in/file`);
  await page.mouse.move(1, 1);
  await words.hover();
  const window = page.locator('[data-code-snippet-preview]');
  await expect(window).toBeVisible({ timeout: 15_000 });
  await expect(window).toContainText(`The berth schedule on Laptop.`);
  const answer = (await (await checked).json()) as { found: boolean; path: string };
  const laptopPath = join(far.harbor.project, 'src', 'berth.ts');
  expect(answer).toMatchObject({ found: true, path: laptopPath });
  // Copy path alone: no Open, no list of apps.
  const copy = window.locator('[data-open-in-copy-path]');
  await expect(copy).toBeVisible();
  await expect(window.locator('[data-open-in-primary], [data-open-in-caret]')).toHaveCount(0);
  await shoot(page, '05-hover-copy-path', false, true);
  await expect(copy).toBeVisible();
  await copy.click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(laptopPath);
  // Nothing ever asked to launch an app, here or there.
  expect(requests.filter((r) => /^POST .*\/open-in(\/file)?$/.test(r))).toEqual([]);
  expect(errors).toEqual([]);
});

test("5. Search: the Tag chip lists Laptop's tag, and picking it finds Laptop's thread", async () => {
  expect((await windowPost(laptop, `/api/inbox/threads/${far.harbor.thread}/tags`, { name: 'Tide window', on: true })).status).toBe(200);
  await expect.poll(async () => JSON.stringify(await read(studio, '/api/inbox/threads?machines=1')).includes('Tide window'), { timeout: 20_000 }).toBe(true);
  // A fresh window, so its merged list is read with the new tag.
  await page.goto(studio.url);
  await page.reload();
  const palette = page.locator('dialog[data-search-palette]');
  await page.locator('.ib-side .ib-sp-entry').first().click();
  await expect(palette).toBeVisible();
  await palette.getByRole('combobox').fill('berth');
  const chip = palette.locator('[data-chip="tag"]');
  await expect(chip).toBeVisible({ timeout: 15_000 });
  await chip.click();
  const option = page.locator('.ib-sp-menu [role="menuitemcheckbox"]').filter({ hasText: 'Tide window' });
  await expect(option).toBeVisible();
  await option.click();
  await expect(chip).toHaveText('Tagged Tide window');
  // The thread's row (its first message shares its id, and may be listed too).
  await expect(palette.locator(`[data-result="thread"][data-result-id="${far.harbor.thread}"]`)).toBeVisible({ timeout: 15_000 });
  // The tagged search asked with Laptop's tag, through the merged route.
  expect(requests.some((r) => r === 'GET /api/inbox/search')).toBe(true);
  await shoot(page, '06-search-tag');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

test("6. A phone at 390: Laptop's checklist and its review, the same way", async ({ browser }) => {
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, colorScheme: 'light' });
  try {
    const on = await phone.newPage();
    watch(on);
    await openFromList(on, far.harbor.thread, `thread=${far.harbor.thread}`);
    await expect(on.locator('[data-steps-button] [data-steps-pie="2/3"]')).toBeVisible({ timeout: 20_000 });
    await shoot(on, '07-phone-steps');
    await on.goto(`${studio.url}#thread=${far.review.thread}&guide=${far.review.message}`);
    await expect(pane(on)).toBeVisible({ timeout: 20_000 });
    const map = shell(on, MAP);
    await map.scrollIntoViewIfNeeded();
    await expect(map.locator('[data-image-diff-preview]')).toBeVisible({ timeout: 30_000 });
    const fits = await map.locator('[data-image-diff-preview]').evaluate((el) => ({ right: el.getBoundingClientRect().right, width: window.innerWidth }));
    expect(fits.right).toBeLessThanOrEqual(fits.width + 0.5);
    await shoot(on, '08-phone-review');
    expect(errors).toEqual([]);
  } finally {
    await phone.close();
  }
});

test('7. An older peer: no checklist, arrows, picture preview or Viewed on its threads, and no console errors', async () => {
  test.skip(older === null, 'needs PLANNOTATOR_E2E_OLDER_BINARY, a real release from before linked reads');
  const old = machine('Old Laptop', older!);
  stillOlder = old;
  await start(old);
  await switches(old, true);
  link(studio, old);
  const there = await threadsOn(old);
  await expect.poll(async () => JSON.stringify(await read(studio, '/api/inbox/threads?machines=1')).includes(there.review.thread), { timeout: 20_000 }).toBe(true);
  const asked = requests.length;
  await openFromList(page, there.harbor.thread, `thread=${there.harbor.thread}`);
  await expect(page.getByText('Bob Tully asked for the tide sync.').first()).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(1_500);
  await expect(page.locator('[data-steps-button]')).toHaveCount(0);
  await page.goto(`${studio.url}#thread=${there.review.thread}&guide=${there.review.message}`);
  await expect(shell(page, ROUTES)).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1_500);
  await expect(shell(page, ROUTES).locator('[data-expand-button]')).toHaveCount(0);
  await expect(page.locator('[data-image-diff-preview]')).toHaveCount(0);
  await expect(page.locator('[data-file-header-viewed]')).toHaveCount(0);
  // Asked nothing new: no steps, guide file, image or package read went to it.
  const theirs = requests.slice(asked).filter((r) => r.includes(`/api/inbox/m/${old.id}/`));
  expect(theirs.filter((r) => /\/steps$|\/guide\/(file|review-image|review-markdown-image|package-changes|viewed)$|\/open-in\/file(\/code)?$/.test(r))).toEqual([]);
  await shoot(page, '09-older-peer');
  expect(errors).toEqual([]);
});
