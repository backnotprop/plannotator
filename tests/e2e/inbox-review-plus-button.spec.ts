/**
 * The + button on a line of a guide's diff in the Inbox (#3718: "the + does nothing in split view"), in a real
 * browser against the compiled binary. The + is the diff's line-comment button; in the Inbox's code review a press
 * on it opens the Comment · Ask bar for that line first (review-editor's SelectionChooser).
 *
 * What regresses if these fail: a press on the + opens nothing a person can see, in one layout or the other (the
 * bar never opens, opens hidden, or closes again at once). Each case says which in its failure message.
 *
 *  1. Unified, lines scroll sideways: the + opens the bar, and it stays.
 *  2. Split, lines scroll sideways: the same.
 *  3. Split, Wrap long lines on: the same.
 *  4. Unified, Wrap long lines on: the same.
 *  5. Split: a click on the line number opens the bar too (the control: the bar itself works in Split).
 *
 * HOME is a scratch folder and the sandbox env keeps the binary off the person's agents; the agent is scripted
 * (tests/helpers/inbox-ask-agent.ts). Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-review-plus-button.spec.ts`.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { scratchProject } from '../../scripts/inbox-sim';
import { startScriptedAskAgent, type ScriptedAskAgent } from '../helpers/inbox-ask-agent';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));

const LONG = 'src/jobs/long-worker.ts';

/** Odd lines change, even ones don't: both layouts draw an old and a new side. Long, so Scroll has lines to pan. */
const lineOf = (word: string, n: number) => `export const ${n % 2 ? word : 'same'}${n} = await step(${n}); // a line of the worker, number ${n}, long enough to reach past a split column`;
const longFile = (word: string) => Array.from({ length: 70 }, (_, i) => lineOf(word, i + 1));

function project(parent: string) {
  const path = scratchProject(parent, 'plus-button');
  const git = (...args: string[]) => {
    const run = spawnSync('git', args, { cwd: path, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } });
    if (run.status !== 0) throw new Error(run.stderr);
    return run.stdout;
  };
  const write = (lines: string[]) => {
    mkdirSync(join(path, LONG, '..'), { recursive: true });
    writeFileSync(join(path, LONG), `${lines.join('\n')}\n`);
    git('add', '-A');
  };
  write(longFile('before'));
  git('commit', '-q', '-m', 'base');
  write(longFile('after'));
  return { path, patch: git('diff', '--cached') };
}

const guide = {
  title: 'A long worker',
  intent: 'Half of the worker changes.',
  sections: [{ title: 'The worker', overview: 'All of it.', diffs: [{ file: LONG, summary: 'The worker.' }] }],
  review: { gitRef: 'main...HEAD', base: 'main' },
  generator: { engine: 'claude-code', model: 'claude-opus-5' },
};

interface World {
  url: string;
  thread: string;
  client: Client;
  agent: ScriptedAskAgent;
  context: BrowserContext;
  page: Page;
}

let world: World;

test.describe.configure({ mode: 'serial' });
test.use({ actionTimeout: 20_000 });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-plus-button-');
  const dataDir = join(root, 'data');
  markTourDecided(dataDir);
  const config = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) as Record<string, unknown>;
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ ...config, inboxCodeReview: true, inboxShape: true }));
  // Nothing here may reach the real gh, glab or tailscale.
  const trap = join(root, 'trap');
  mkdirSync(trap);
  for (const name of ['gh', 'glab', 'tailscale']) {
    writeFileSync(join(trap, name), `#!/bin/sh\necho "plus-button: ${name} must not run" >&2\nexit 97\n`);
    chmodSync(join(trap, name), 0o755);
  }
  for (const dir of ['claude', 'codex', 'xdg', 'opencode', 'home']) mkdirSync(join(root, dir), { recursive: true });
  const env: Record<string, string> = {
    PATH: `${trap}:${process.env.PATH ?? ''}`,
    HOME: join(root, 'home'),
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_INBOX_TAILSCALE: '0',
    PLANNOTATOR_INBOX_PHONES: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_BROWSER,
    NO_ANON_PING: '1',
    PLANNOTATOR_INBOX_NOTES: '0',
    PLANNOTATOR_TEST_SANDBOX: '1',
    PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    CODEX_HOME: join(root, 'codex'),
    XDG_CONFIG_HOME: join(root, 'xdg'),
    OPENCODE_CONFIG_DIR: join(root, 'opencode'),
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  const url = started.stdout.trim();
  const registry = JSON.parse(readFileSync(join(dataDir, 'inbox', 'inbox.json'), 'utf8')) as { port: number; token: string };
  const { path, patch } = project(join(root, 'src'));
  const client = new Client({ name: 'plus-button', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${registry.port}/mcp`)));
  // A connected agent that can take a question: the bar offers Ask (and Show me).
  const agent = startScriptedAskAgent({ port: registry.port, token: registry.token, session: 'ses-plus', project: path, reply: async () => 'An answer.' });
  const sent = (await client.callTool({ name: 'submit_guide', arguments: { project_path: path, guide, patch, review: true, subject: 'A long worker', body: 'Ready for review.', agent_session: 'ses-plus', agent_host: 'claude-code', agent_name: 'Claude Code' } })) as { isError?: boolean; content?: { text: string }[]; structuredContent: { thread_id: string } };
  if (sent.isError) throw new Error(sent.content?.map((c) => c.text).join(' '));
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: 'light', reducedMotion: 'reduce' });
  const page = await context.newPage();
  world = { url, thread: sent.structuredContent.thread_id, client, agent, context, page };
});

test.afterAll(async () => {
  try {
    if (!world) return;
    world.agent.stop();
    await world.client.close().catch(() => {});
    await world.context.close();
  } finally {
    await removeInboxScratch();
  }
});

const shell = (page: Page) => page.locator(`[data-guide-file-shell="${LONG}"]`).first();
/** A line's number, on its side (Split draws two columns; Unified one). */
const lineNumber = (page: Page, n: number, type = 'change-addition') => shell(page).locator(`[data-line-type="${type}"][data-column-number="${n}"]`).first();

async function openReview(page: Page): Promise<void> {
  await page.goto(`${world.url}#thread=${world.thread}`);
  await page.locator('[data-review-card]').last().getByRole('button', { name: /review/ }).click();
  await expect(page.locator('[data-review-message]')).toBeVisible();
  await expect(lineNumber(page, 1)).toBeVisible({ timeout: 30_000 });
}

/** The top bar's one Split / Unified button (DiffControls): it names the layout on screen, and a press flips it. */
async function setStyle(page: Page, style: 'split' | 'unified'): Promise<void> {
  const toggle = page.locator('[data-diff-controls] [data-diff-layout-toggle]').first();
  if ((await toggle.getAttribute('data-diff-layout-toggle')) !== style) await toggle.click();
  await expect(toggle).toHaveAttribute('data-diff-layout-toggle', style);
  await page.waitForTimeout(400);
}

/** The gear's "Wrap long lines" switch (DiffDisplayOptions), set as a person sets it. */
async function setWrap(page: Page, wrap: boolean): Promise<void> {
  await page.locator('[data-diff-controls]').first().getByRole('button', { name: 'Diff display options' }).click();
  const popup = page.locator('[data-diff-display-popup]');
  const sw = popup.getByRole('switch', { name: 'Wrap long lines' });
  if ((await sw.getAttribute('aria-checked')) !== String(wrap)) await sw.click();
  await expect(sw).toHaveAttribute('aria-checked', String(wrap));
  await page.keyboard.press('Escape');
  await expect(popup).toHaveCount(0);
  await expect(shell(page).locator(`pre[data-overflow="${wrap ? 'wrap' : 'scroll'}"]`).first()).toBeAttached();
  await page.waitForTimeout(300);
}

/** Everything the bar's showing depends on, read in the page: the failure message of every case. */
const state = (page: Page) =>
  page.evaluate(() => {
    const pop = document.querySelector<HTMLElement>('.review-selpop');
    const painted = [...document.querySelectorAll('diffs-container')].flatMap((host) => [...(host.shadowRoot?.querySelectorAll('[data-selected-line]') ?? [])]);
    const side = (el: Element) => (el.closest('[data-code]')?.hasAttribute('data-additions') ? 'additions' : el.closest('[data-code]')?.hasAttribute('data-deletions') ? 'deletions' : 'unified');
    const r = pop?.getBoundingClientRect();
    const pre = document.querySelector('diffs-container')?.shadowRoot?.querySelector('pre');
    return {
      barMounted: !!pop,
      barVisibility: pop ? getComputedStyle(pop).visibility : null,
      barShowing: !!pop?.hasAttribute('data-selection-chooser'),
      barBox: r ? { top: Math.round(r.top), left: Math.round(r.left), width: Math.round(r.width), height: Math.round(r.height) } : null,
      commentBox: document.querySelectorAll('.review-toolbar').length,
      painted: painted.map((el) => `${el.getAttribute('data-line') ?? `#${el.getAttribute('data-column-number')}`}@${side(el)}`),
      diffType: pre?.getAttribute('data-diff-type') ?? null,
      overflow: pre?.getAttribute('data-overflow') ?? null,
      viewport: { width: innerWidth, height: innerHeight },
    };
  });

/** The bar is on screen, a person can see it, and it is still there a moment later. */
async function barShowsAndStays(page: Page, what: string): Promise<void> {
  const shows = async () => {
    const s = await state(page);
    return s.barMounted && s.barShowing && s.barVisibility === 'visible' && (s.barBox?.width ?? 0) > 0;
  };
  const deadline = Date.now() + 5_000;
  while (!(await shows()) && Date.now() < deadline) await page.waitForTimeout(100);
  expect(await shows(), `${what}: the bar opened and shows. Page: ${JSON.stringify(await state(page))}`).toBe(true);
  await page.waitForTimeout(800);
  expect(await shows(), `${what}: the bar still shows a moment later. Page: ${JSON.stringify(await state(page))}`).toBe(true);
  await expect(page.locator('[data-selection-chooser]').getByRole('button', { name: 'Comment' })).toBeVisible();
}

/** Dismiss the bar as a person does: a press on nothing. */
async function closeBar(page: Page): Promise<void> {
  await page.mouse.click(4, 4);
  await expect(page.locator('.review-selpop')).toHaveCount(0);
}

/** Hover line `n`'s number, then press the + the diff shows on that line. */
async function pressPlus(page: Page, n: number): Promise<void> {
  const number = lineNumber(page, n);
  await number.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(300);
  await number.hover();
  const plus = shell(page).locator('[data-utility-button]');
  await expect(plus, 'the + shows on the hovered line').toBeVisible();
  await plus.click();
}

for (const { style, wrap } of [
  { style: 'unified', wrap: false },
  { style: 'split', wrap: false },
  { style: 'split', wrap: true },
  { style: 'unified', wrap: true },
] as const) {
  const name = `${style === 'split' ? 'Split' : 'Unified'}${wrap ? ', Wrap long lines on' : ''}`;
  test(`${name}: the + on a line opens the Comment · Ask bar, and it stays`, async () => {
    const { page } = world;
    await openReview(page);
    await setStyle(page, style);
    await setWrap(page, wrap);
    await pressPlus(page, 17);
    await barShowsAndStays(page, `${name}, the +`);
    await closeBar(page);
  });
}

test('Split: a click on a line number opens the bar too (the control)', async () => {
  const { page } = world;
  await openReview(page);
  await setStyle(page, 'split');
  await setWrap(page, false);
  const number = lineNumber(page, 17);
  await number.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(300);
  await number.click();
  await barShowsAndStays(page, 'Split, the line number');
  await closeBar(page);
});
