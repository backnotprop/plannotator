/**
 * The + on a diff line in Firefox (the owner's report of 2026-11-24: on Firefox, pressing the + on a diff line in a
 * Guided Review "blanks out the screen and errors"), in the `firefox` project only, against the compiled binary.
 *
 * The + is the diff's line-comment button. Here it is pressed on an added, a removed and a context line, in Unified
 * and in Split, in both places the Inbox draws a guide's diff:
 *
 *  - the guide reader (a guide sent without review: the walkthrough opened from the thread);
 *  - the code review of a guide (a guide sent with review: its review card's button).
 *
 * Each press opens the comment box (through the Comment · Ask bar when it shows), a comment is typed and saved, and
 * it shows on its line. What regresses if this fails: in Firefox a press on the + throws (any `pageerror` fails the
 * case), blanks the window, or leaves a part of it saying "This part didn't load" (ui's RegionBoundary,
 * `[data-region-failed]`) or "Couldn't load this view" (`[data-lazy-load-failed]`); or the comment never lands.
 *
 * The approach is inbox-review-plus-button.spec.ts's (Chromium). HOME is a scratch folder and the sandbox env keeps
 * the binary off the person's agents; the agent is scripted (tests/helpers/inbox-ask-agent.ts). Build the binary
 * first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts --project firefox inbox-review-plus-button-firefox.spec.ts`.
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

/** Odd lines change, even ones don't: every odd line is a removed and an added line, every even one context. */
const lineOf = (word: string, n: number) => `export const ${n % 2 ? word : 'same'}${n} = await step(${n}); // a line of the worker, number ${n}`;
const longFile = (word: string) => Array.from({ length: 70 }, (_, i) => lineOf(word, i + 1));

function project(parent: string) {
  const path = scratchProject(parent, 'plus-firefox');
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

type Surface = 'reader' | 'review';

interface World {
  url: string;
  /** Per surface: the thread, and the guide's message. */
  sent: Record<Surface, { thread: string; message: string }>;
  client: Client;
  agent: ScriptedAskAgent;
  context: BrowserContext;
  page: Page;
  /** Every uncaught error the page reported, with its stack. */
  errors: string[];
}

let world: World;

test.describe.configure({ mode: 'serial' });
test.use({ actionTimeout: 20_000 });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-plus-firefox-');
  const dataDir = join(root, 'data');
  markTourDecided(dataDir);
  const config = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) as Record<string, unknown>;
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ ...config, inboxCodeReview: true }));
  // Nothing here may reach the real gh, glab or tailscale.
  const trap = join(root, 'trap');
  mkdirSync(trap);
  for (const name of ['gh', 'glab', 'tailscale']) {
    writeFileSync(join(trap, name), `#!/bin/sh\necho "plus-firefox: ${name} must not run" >&2\nexit 97\n`);
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
  const client = new Client({ name: 'plus-firefox', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${registry.port}/mcp`)));
  // A connected agent that can take a question: the bar offers Ask, as on the owner's machine.
  const agent = startScriptedAskAgent({ port: registry.port, token: registry.token, session: 'ses-plus-firefox', project: path, reply: async () => 'An answer.' });
  const send = async (review: boolean) => {
    const sent = (await client.callTool({
      name: 'submit_guide',
      arguments: { project_path: path, guide, patch, review, subject: review ? 'A long worker, for review' : 'A long worker, to read', body: 'Ready.', agent_session: 'ses-plus-firefox', agent_host: 'claude-code', agent_name: 'Claude Code' },
    })) as { isError?: boolean; content?: { text: string }[]; structuredContent: { thread_id: string; message_id: string } };
    if (sent.isError) throw new Error(sent.content?.map((c) => c.text).join(' '));
    return { thread: sent.structuredContent.thread_id, message: sent.structuredContent.message_id };
  };
  const sent = { reader: await send(false), review: await send(true) };
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: 'light', reducedMotion: 'reduce' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`${error.name}: ${error.message}\n${error.stack ?? ''}`));
  world = { url, sent, client, agent, context, page, errors };
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
type Kind = 'change-addition' | 'change-deletion' | 'context';
/** A line's number, of its kind (Split draws two columns; a context line's first is the old side). */
const lineNumber = (page: Page, n: number, kind: Kind) => shell(page).locator(`[data-line-type="${kind}"][data-column-number="${n}"]`).first();

/** Nothing failed: no uncaught error, no part of the window in its failure notice, and the window is drawn. */
async function nothingBroke(page: Page, what: string): Promise<void> {
  expect(world.errors, `${what}: the page threw`).toEqual([]);
  await expect(page.locator('[data-region-failed]'), `${what}: a part of the window says it didn't load`).toHaveCount(0);
  await expect(page.locator('[data-lazy-load-failed]'), `${what}: a part of the window could not load`).toHaveCount(0);
  expect(await page.evaluate(() => document.getElementById('root')?.childElementCount ?? 0), `${what}: the window is blank`).toBeGreaterThan(0);
}

async function open(page: Page, surface: Surface): Promise<void> {
  const { thread, message } = world.sent[surface];
  // A fresh load each case: a goto to the address already open only moves the hash, the diff keeps the last case's
  // scroll, and the rows it scrolled past are not drawn (the diff is virtualized), line 1's among them.
  await page.goto('about:blank');
  if (surface === 'reader') {
    await page.goto(`${world.url}#thread=${thread}&guide=${message}`);
  } else {
    await page.goto(`${world.url}#thread=${thread}`);
    await page.locator('[data-review-card]').last().getByRole('button', { name: /review/ }).click();
  }
  await expect(page.locator('[data-review-message]')).toBeVisible();
  await expect(lineNumber(page, 1, 'change-addition')).toBeVisible({ timeout: 30_000 });
}

/** The top bar's one Split / Unified button (DiffControls): it names the layout on screen, and a press flips it. */
async function setStyle(page: Page, style: 'split' | 'unified'): Promise<void> {
  const toggle = page.locator('[data-diff-controls] [data-diff-layout-toggle]').first();
  if ((await toggle.getAttribute('data-diff-layout-toggle')) !== style) await toggle.click();
  await expect(toggle).toHaveAttribute('data-diff-layout-toggle', style);
  await page.waitForTimeout(400);
}

/** Hover line `n`'s number, press the + it shows, and write a comment there as a person does. */
async function commentWithPlus(page: Page, n: number, kind: Kind, words: string): Promise<void> {
  const number = lineNumber(page, n, kind);
  await number.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(300);
  await number.hover();
  const plus = shell(page).locator('[data-utility-button]');
  await expect(plus, `the + shows on ${kind} line ${n}`).toBeVisible();
  await plus.click();
  const box = page.locator('.review-toolbar');
  const chooser = page.locator('[data-selection-chooser]');
  // The Comment · Ask bar first where an agent can take a question; the comment box at once where not.
  await expect(box.or(chooser).first(), `the + on ${kind} line ${n} opened nothing`).toBeVisible({ timeout: 5_000 });
  if (await chooser.isVisible()) await chooser.getByRole('button', { name: 'Comment' }).click();
  await expect(box).toBeVisible();
  await box.locator('textarea').first().fill(words);
  await box.locator('textarea').first().press('ControlOrMeta+Enter');
  await expect(box).toHaveCount(0);
  await expect(shell(page).getByText(words), `the comment on ${kind} line ${n} shows on its line`).toBeVisible();
}

/** Lines per layout, so no case lands on a line that already holds a comment. */
const LINES: Record<'unified' | 'split', Record<Kind, number>> = {
  unified: { 'change-addition': 17, 'change-deletion': 21, context: 24 },
  split: { 'change-addition': 29, 'change-deletion': 33, context: 36 },
};
const KIND_NAME: Record<Kind, string> = { 'change-addition': 'an added line', 'change-deletion': 'a removed line', context: 'a context line' };

for (const surface of ['reader', 'review'] as const) {
  for (const style of ['unified', 'split'] as const) {
    for (const kind of ['change-addition', 'change-deletion', 'context'] as const) {
      const where = `${surface === 'reader' ? 'The guide reader' : 'Code review of a guide'}, ${style === 'split' ? 'Split' : 'Unified'}`;
      test(`${where}: the + on ${KIND_NAME[kind]} opens the comment box, and the comment saves`, async () => {
        const { page } = world;
        await open(page, surface);
        await setStyle(page, style);
        await nothingBroke(page, `${where}, opened`);
        const n = LINES[style][kind];
        await commentWithPlus(page, n, kind, `Firefox ${surface} ${style} ${kind} ${n}.`);
        await nothingBroke(page, `${where}, the + on ${KIND_NAME[kind]}`);
      });
    }
  }
}
