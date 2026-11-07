/**
 * The bar selected lines open in the Inbox's code review (Comment · Ask · Show me),
 * in a real browser against the compiled binary. What regresses if these fail: the
 * bar lands on the lines it is about, drifts off them, falls off the screen, or
 * the diff's + mark sits against it.
 *
 * Proves, with lines the diff really painted (read from its shadow DOM, as the bar does):
 *  1. Unified: words only, under the last selected line, at the start of its code,
 *     wherever the pointer is; the + mark is gone while it is open and back after.
 *  2. Split: under the side the selection ends on (new or old).
 *  3. The bottom of a card: under the file's last line, on screen, nothing clipped.
 *  4. The bottom of the viewport: above the first selected line, not on them.
 *  5. More selected lines than the screen holds: on screen (the one case it may cover them).
 *  6. A scroll: it stays with its lines.
 *  7. Comment after the bar: the comment box opens and the + mark is back.
 *  8. All files: the same bar, the same place.
 *  9. A phone at 390 px: touch-sized, on screen, not on the lines.
 *
 * HOME is a scratch folder and the sandbox env keeps the binary off the person's agents;
 * the agent is scripted (tests/helpers/inbox-ask-agent.ts). Build the binary first (see
 * inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-review-selection-bar.spec.ts`.
 * 2x PNGs land in PLANNOTATOR_E2E_SHOTS_DIR (default .local/proof/selection-bar).
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
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
const shotsDir = resolve(process.env.PLANNOTATOR_E2E_SHOTS_DIR ?? join(repo, '.local/proof/selection-bar'));

const LONG = 'src/jobs/long-worker.ts';
const TAIL = 'src/jobs/tail.ts';
/** In no chapter of the first review: the file the two-file review holds after the worker. */
const NEXT = 'src/jobs/next-worker.ts';

/** Odd lines change, even ones don't: Unified draws old beside new as it goes, and both layouts have lines near the top. */
const lineOf = (word: string, n: number) => `export const ${n % 2 ? word : 'same'}${n} = await step(${n}); // a line of the worker, number ${n}`;
const longFile = (word: string) => Array.from({ length: 70 }, (_, i) => lineOf(word, i + 1));
const tailFile = (word: string) => Array.from({ length: 9 }, (_, i) => lineOf(word, i + 1));

function project(parent: string) {
  const path = scratchProject(parent, 'selection-bar');
  const git = (...args: string[]) => {
    const run = spawnSync('git', args, { cwd: path, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } });
    if (run.status !== 0) throw new Error(run.stderr);
    return run.stdout;
  };
  const write = (files: Record<string, string[]>) => {
    for (const [file, lines] of Object.entries(files)) {
      mkdirSync(join(path, file, '..'), { recursive: true });
      writeFileSync(join(path, file), `${lines.join('\n')}\n`);
    }
    git('add', '-A');
  };
  write({ [LONG]: longFile('before'), [TAIL]: tailFile('before'), [NEXT]: longFile('before') });
  git('commit', '-q', '-m', 'base');
  write({ [LONG]: longFile('after'), [TAIL]: tailFile('after'), [NEXT]: longFile('after') });
  return { path, patch: git('diff', '--cached') };
}

const guide = {
  title: 'A long worker',
  intent: 'Half of the worker changes.',
  sections: [
    { title: 'The worker', overview: 'All of it.', diffs: [{ file: LONG, summary: 'The worker.' }] },
    { title: 'The tail', overview: 'The end of the review.', diffs: [{ file: TAIL, summary: 'The tail.' }] },
  ],
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
  path: string;
  patch: string;
}

let world: World;

test.describe.configure({ mode: 'serial' });
test.use({ actionTimeout: 20_000 });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  mkdirSync(shotsDir, { recursive: true });
  const root = inboxScratch('plannotator-selection-bar-');
  const dataDir = join(root, 'data');
  markTourDecided(dataDir);
  const config = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8')) as Record<string, unknown>;
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ ...config, inboxCodeReview: true }));
  // Nothing here may reach the real gh, glab or tailscale.
  const trap = join(root, 'trap');
  mkdirSync(trap);
  for (const name of ['gh', 'glab', 'tailscale']) {
    writeFileSync(join(trap, name), `#!/bin/sh\necho "selection-bar: ${name} must not run" >&2\nexit 97\n`);
    chmodSync(join(trap, name), 0o755);
  }
  for (const dir of ['claude', 'codex', 'xdg', 'opencode', 'home']) mkdirSync(join(root, dir), { recursive: true });
  const env: Record<string, string> = {
    PATH: `${trap}:${process.env.PATH ?? ''}`,
    // A scratch home: the skills route reads folders under it (`~/.agents/skills`).
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
  const client = new Client({ name: 'selection-bar', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${registry.port}/mcp`)));
  // A connected agent that can take a question: Ask and Show me are offered.
  const agent = startScriptedAskAgent({ port: registry.port, token: registry.token, session: 'ses-bar', project: path, reply: async () => 'An answer.' });
  const sent = (await client.callTool({ name: 'submit_guide', arguments: { project_path: path, guide, patch, review: true, subject: 'A long worker', body: 'Ready for review.', agent_session: 'ses-bar', agent_host: 'claude-code', agent_name: 'Claude Code' } })) as { isError?: boolean; content?: { text: string }[]; structuredContent: { thread_id: string } };
  if (sent.isError) throw new Error(sent.content?.map((c) => c.text).join(' '));
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light', reducedMotion: 'reduce' });
  const page = await context.newPage();
  world = { url, thread: sent.structuredContent.thread_id, client, agent, context, page, path, patch };
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

const bar = (page: Page) => page.locator('[data-selection-chooser]');
/** The bar whether it shows or not: hidden, it isn't `bar` (the + mark comes back). */
const selpop = (page: Page) => page.locator('.review-selpop');
/** What a press at the middle of this element really reaches. */
const free = (page: Page, name: string, el: ReturnType<Page['locator']>) =>
  el.evaluate((node, label) => {
    const r = node.getBoundingClientRect();
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return at === node || node.contains(at) ? 'free' : `${label} covered by ${at?.className}`;
  }, name);

interface Box { top: number; bottom: number; left: number; right: number }

/** What the diff really painted, on each side, and the bar's box: read in the page, as the bar reads it. */
const geometry = (page: Page) =>
  page.evaluate(() => {
    const boxOf = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
    };
    const painted = [...document.querySelectorAll('diffs-container')].flatMap((host) => [...(host.shadowRoot?.querySelectorAll('[data-selected-line]') ?? [])]);
    const onSide = (side: string) => painted.filter((el) => el.closest('[data-code]')?.hasAttribute(`data-${side}`));
    const code = painted.filter((el) => el.hasAttribute('data-line')).map(boxOf);
    const gutterRight = (els: Element[]) => {
      const gutter = els.find((el) => el.hasAttribute('data-column-number'));
      return gutter ? boxOf(gutter).right : null;
    };
    const chooser = document.querySelector('[data-selection-chooser]');
    return {
      rows: code,
      top: Math.min(...code.map((b) => b.top)),
      bottom: Math.max(...code.map((b) => b.bottom)),
      codeAdditions: gutterRight(onSide('additions')),
      codeDeletions: gutterRight(onSide('deletions')),
      codeAny: gutterRight(painted),
      bar: chooser ? boxOf(chooser) : null,
      viewport: { width: innerWidth, height: innerHeight },
      plus: [...document.querySelectorAll('diffs-container')].flatMap((host) => [...(host.shadowRoot?.querySelectorAll('[data-utility-button]') ?? [])]).filter((el) => el.getBoundingClientRect().width > 0).length,
    };
  });

/** The bar on screen and over none of the painted lines (either column). */
function clearOfLines(g: Awaited<ReturnType<typeof geometry>>): Box {
  const box = g.bar!;
  expect(box.top, 'on screen, top').toBeGreaterThanOrEqual(0);
  expect(box.bottom, 'on screen, bottom').toBeLessThanOrEqual(g.viewport.height);
  expect(box.left, 'on screen, left').toBeGreaterThanOrEqual(0);
  expect(box.right, 'on screen, right').toBeLessThanOrEqual(g.viewport.width);
  for (const row of g.rows) {
    const over = box.top < row.bottom && box.bottom > row.top && box.left < row.right && box.right > row.left;
    expect(over, `over a selected line at ${row.top}–${row.bottom}: bar ${box.top}–${box.bottom}`).toBe(false);
  }
  return box;
}

const line = (page: Page, file: string, n: number, type = 'change-addition') =>
  page.locator(`[data-guide-file-shell="${file}"]`).first().locator(`[data-line-type="${type}"][data-column-number="${n}"]`).first();

async function select(page: Page, file: string, from: number, to: number, type = 'change-addition'): Promise<void> {
  await expect(line(page, file, from, type)).toBeVisible({ timeout: 30_000 });
  await line(page, file, from, type).click();
  if (to !== from) await line(page, file, to, type).click({ modifiers: ['Shift'] });
  await settled(page);
}

/** The bar is up, the lines are painted, and neither has moved for a moment (a click may have scrolled them). */
async function settled(page: Page): Promise<void> {
  await expect(bar(page)).toBeVisible();
  await expect.poll(async () => {
    const a = await geometry(page);
    await page.waitForTimeout(120);
    const b = await geometry(page);
    return b.rows.length > 0 && a.top === b.top && a.bar?.top === b.bar?.top;
  }).toBe(true);
}

/** Dismiss the bar as a person does: a press on nothing. */
async function closeBar(page: Page): Promise<void> {
  await page.mouse.click(4, 4);
  await expect(bar(page)).toHaveCount(0);
}

async function openReview(page: Page, chapter = 1, thread = world.thread): Promise<void> {
  await page.goto(`${world.url}#thread=${thread}`);
  await page.locator('[data-review-card]').last().getByRole('button', { name: /review/ }).click();
  await expect(page.locator('[data-review-message]')).toBeVisible();
  await page.locator('[data-review-chapters] li').nth(chapter).click();
}

async function setStyle(page: Page, style: 'split' | 'unified'): Promise<void> {
  await page.locator(`[data-diff-style="${style}"]`).first().click();
  await expect(page.locator('[data-diff-style-switch]').first()).toHaveAttribute('data-diff-style-switch', style);
  await page.waitForTimeout(400);
}

async function pictures(page: Page, name: string, around: Box, close = false): Promise<void> {
  await expect(page.getByText('Tell your agents', { exact: false })).toHaveCount(0);
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(450);
    await page.screenshot({ path: join(shotsDir, `${name}-${scheme}.png`) });
    if (close) {
      const clip = { x: Math.max(0, around.left - 320), y: Math.max(0, around.top - 150), width: 860, height: 300 };
      clip.height = Math.min(clip.height, 900 - clip.y);
      await page.screenshot({ path: join(shotsDir, `${name}-close-${scheme}.png`), clip });
    }
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
}

test('Unified: words only, under the last line at the start of its code, wherever the pointer is; the + is gone while it is open', async () => {
  const { page } = world;
  await openReview(page);
  await expect(line(page, LONG, 1)).toBeVisible({ timeout: 30_000 });
  await setStyle(page, 'unified');
  await select(page, LONG, 17, 19);

  const words = bar(page).getByRole('button');
  await expect(words).toHaveText(['Comment', 'Ask', 'Show me']);
  await expect(bar(page).locator('svg')).toHaveCount(0);
  // The accent is Show me's text; nothing is filled. Hairlines split the words.
  const look = await bar(page).evaluate((el) => {
    const [comment, ask, show] = [...el.querySelectorAll('button')].map((b) => getComputedStyle(b));
    const probe = document.createElement('i');
    probe.style.color = 'var(--primary)';
    document.body.appendChild(probe);
    const primary = getComputedStyle(probe).color;
    probe.remove();
    return { showColor: show!.color, primary, commentColor: comment!.color, showFill: show!.backgroundColor, commentLine: comment!.borderLeftWidth, askLine: ask!.borderLeftWidth, showLine: show!.borderLeftWidth };
  });
  expect(look.showColor).toBe(look.primary);
  expect(look.commentColor).not.toBe(look.primary);
  expect(look.showFill).toBe('rgba(0, 0, 0, 0)');
  expect([look.commentLine, look.askLine, look.showLine]).toEqual(['0px', '1px', '1px']);

  const g = await geometry(page);
  const box = clearOfLines(g);
  expect(box.top - g.bottom, 'just under the last line').toBeGreaterThan(0);
  expect(box.top - g.bottom).toBeLessThan(12);
  expect(Math.abs(box.left - g.codeAny!), 'at the start of the code').toBeLessThan(1);

  await page.mouse.move(700, 150);
  await pictures(page, 'unified', box, true);

  // The pointer moved far away: the bar stays with its lines. The + mark is gone, on any hovered line.
  await line(page, LONG, 23).hover();
  await expect.poll(async () => (await geometry(page)).plus).toBe(0);
  await expect.poll(async () => {
    const now = await geometry(page);
    return now.bar!.top - now.bottom;
  }).toBeCloseTo(box.top - g.bottom, 0);
  expect(clearOfLines(await geometry(page)).left).toBe(box.left);

  await closeBar(page);
  await line(page, LONG, 23).hover();
  await expect.poll(async () => (await geometry(page)).plus, 'the + is back once the bar has closed').toBeGreaterThan(0);
});

test('Split: under the side the selection ends on', async () => {
  const { page } = world;
  await openReview(page);
  await expect(line(page, LONG, 1)).toBeVisible({ timeout: 30_000 });
  await setStyle(page, 'split');

  await select(page, LONG, 17, 19);
  let g = await geometry(page);
  let box = clearOfLines(g);
  expect(Math.abs(box.left - g.codeAdditions!), 'the new side').toBeLessThan(1);
  expect(g.codeAdditions!).toBeGreaterThan(g.codeDeletions ?? 0);
  expect(box.top - g.bottom).toBeLessThan(12);
  await page.mouse.move(700, 150);
  await pictures(page, 'split', box, true);
  await closeBar(page);

  await select(page, LONG, 21, 23, 'change-deletion');
  g = await geometry(page);
  box = clearOfLines(g);
  expect(Math.abs(box.left - g.codeDeletions!), 'the old side').toBeLessThan(1);
  await expect(bar(page).getByRole('button')).toHaveText(['Comment', 'Ask']);
  await closeBar(page);
});

test('the bottom of a card: under the file\'s last line, on screen, nothing clipped', async () => {
  const { page } = world;
  await openReview(page, 2);
  await expect(line(page, TAIL, 9)).toBeVisible({ timeout: 30_000 });
  for (const style of ['split', 'unified'] as const) {
    await setStyle(page, style);
    await select(page, TAIL, 7, 9);
    const g = await geometry(page);
    const box = clearOfLines(g);
    const shell = (await page.locator(`[data-guide-file-shell="${TAIL}"]`).first().boundingBox())!;
    expect(box.top, 'below the last line').toBeGreaterThan(g.bottom);
    // It reaches past the file's box, and every word is still there to press.
    expect(box.bottom).toBeGreaterThan(shell.y + shell.height);
    for (const word of ['comment', 'ask', 'show-me']) {
      const button = bar(page).locator(`[data-selection-action="${word}"]`);
      const b = (await button.boundingBox())!;
      const at = await page.evaluate(([x, y]) => (document.elementFromPoint(x!, y!) as HTMLElement | null)?.dataset.selectionAction ?? null, [b.x + b.width / 2, b.y + b.height / 2]);
      expect(at).toBe(word);
    }
    await page.mouse.move(700, 150);
    if (style === 'split') await pictures(page, 'card-bottom', box);
    await closeBar(page);
  }
});

test('the bottom of the viewport: above the first selected line, not on them, in Split and Unified', async () => {
  const { page } = world;
  await openReview(page);
  await expect(line(page, LONG, 1)).toBeVisible({ timeout: 30_000 });
  for (const style of ['split', 'unified'] as const) {
    await setStyle(page, style);
    await line(page, LONG, 25).scrollIntoViewIfNeeded();
    // The last selected line is the last on screen.
    await line(page, LONG, 27).evaluate((el) => el.scrollIntoView({ block: 'end' }));
    await page.waitForTimeout(300);
    await select(page, LONG, 25, 27);
    const g = await geometry(page);
    const box = clearOfLines(g);
    expect(g.viewport.height - g.bottom, 'no room for it below').toBeLessThan(42);
    expect(box.bottom, 'above the first line').toBeLessThanOrEqual(g.top);
    expect(g.top - box.bottom).toBeLessThan(12);
    await page.mouse.move(700, 150);
    if (style === 'split') await pictures(page, 'viewport-bottom', box);
    await closeBar(page);
  }
});

test('more selected lines than the screen holds: it stays on screen', async () => {
  const { page } = world;
  await page.setViewportSize({ width: 1440, height: 420 });
  try {
    await openReview(page);
    await expect(line(page, LONG, 1)).toBeVisible({ timeout: 30_000 });
    await setStyle(page, 'unified');
    await line(page, LONG, 5).evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(300);
    await line(page, LONG, 5).click();
    await line(page, LONG, 25).evaluate((el) => el.scrollIntoView({ block: 'end' }));
    await page.waitForTimeout(300);
    await line(page, LONG, 25).click({ modifiers: ['Shift'] });
    await line(page, LONG, 15).evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await expect(bar(page)).toBeVisible();
    await expect.poll(async () => {
      const box = (await geometry(page)).bar!;
      return box.top >= 0 && box.bottom <= 420;
    }).toBe(true);
    // All of them scrolled off the top: nothing to sit by, so it is gone, and the page's header stays free.
    await line(page, LONG, 25).evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await page.mouse.move(1000, 300);
    await page.mouse.wheel(0, 200);
    await expect.poll(async () => (await line(page, LONG, 25).boundingBox())?.y ?? 0).toBeLessThan(-30);
    await expect(selpop(page)).toBeHidden();
    await closeBar(page);
  } finally {
    await page.setViewportSize({ width: 1440, height: 900 });
  }
});

test('a scroll: it stays with its lines', async () => {
  const { page } = world;
  await openReview(page);
  await expect(line(page, LONG, 1)).toBeVisible({ timeout: 30_000 });
  await setStyle(page, 'unified');
  await line(page, LONG, 25).evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(300);
  await select(page, LONG, 25, 27);
  const before = await geometry(page);
  clearOfLines(before);
  await page.mouse.move(700, 450);
  // A scroll that keeps them on screen: down the file when they are low, up it when they are high.
  const by = before.top > 450 ? 120 : -120;
  await page.mouse.wheel(0, by);
  await expect.poll(async () => Math.abs((await geometry(page)).top - before.top)).toBeGreaterThan(60);
  // Right against the lines still, on whichever side has the room.
  await expect.poll(async () => {
    const g = await geometry(page);
    return Math.min(Math.abs(g.bar!.top - g.bottom), Math.abs(g.top - g.bar!.bottom));
  }).toBeLessThan(12);
  clearOfLines(await geometry(page));
  await closeBar(page);
});

test('Comment after the bar: the comment box opens for the lines and the + is back', async () => {
  const { page } = world;
  await openReview(page);
  await expect(line(page, LONG, 1)).toBeVisible({ timeout: 30_000 });
  await setStyle(page, 'unified');
  await select(page, LONG, 17, 19);
  await bar(page).getByRole('button', { name: 'Comment' }).click();
  await expect(bar(page)).toHaveCount(0);
  await expect(page.locator('.review-toolbar')).toBeVisible();
  await line(page, LONG, 23).hover();
  await expect.poll(async () => (await geometry(page)).plus).toBeGreaterThan(0);
});

test('All files: the same bar, the same place', async () => {
  const { page } = world;
  await openReview(page);
  await page.locator('[data-review-message]').getByText('All files', { exact: true }).click();
  const anyLine = (n: number) => page.locator(`[data-line-type="change-addition"][data-column-number="${n}"]`).first();
  await expect(anyLine(17)).toBeVisible({ timeout: 30_000 });
  await anyLine(17).click();
  await anyLine(19).click({ modifiers: ['Shift'] });
  await settled(page);
  const g = await geometry(page);
  const box = clearOfLines(g);
  await expect(bar(page).getByRole('button')).toHaveText(['Comment', 'Ask', 'Show me']);
  expect(Math.min(Math.abs(box.top - g.bottom), Math.abs(g.top - box.bottom))).toBeLessThan(12);
  await closeBar(page);
});

test('a phone at 390 px: touch-sized, on screen, not on the lines, at the bottom of the viewport too', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, colorScheme: 'light', reducedMotion: 'reduce' });
  const page = await context.newPage();
  try {
    await page.goto(`${world.url}#thread=${world.thread}`);
    await page.locator('[data-review-card]').last().getByRole('button', { name: /review/ }).click();
    await expect(page.locator('[data-review-message]')).toBeVisible();
    await page.locator('[data-review-phonebar] select').selectOption('0');
    await expect(line(page, LONG, 1)).toBeVisible({ timeout: 30_000 });
    await line(page, LONG, 17).evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(300);
    // A real tap on one line; the range below uses clicks, as a touch has no shift key.
    await line(page, LONG, 17).tap();
    await settled(page);
    await expect(bar(page).getByRole('button')).toHaveText(['Comment', 'Ask', 'Show me']);
    const heights = await bar(page).getByRole('button').evaluateAll((all) => all.map((b) => b.getBoundingClientRect().height));
    for (const height of heights) expect(height).toBeGreaterThanOrEqual(44);
    const g = await geometry(page);
    const box = clearOfLines(g);
    expect(box.top).toBeGreaterThan(g.bottom);
    expect(box.top - g.bottom).toBeLessThan(12);
    await pictures(page, 'phone', box);
    await page.touchscreen.tap(195, 8);
    await expect(bar(page)).toHaveCount(0);

    await line(page, LONG, 25).evaluate((el) => el.scrollIntoView({ block: 'end' }));
    await page.waitForTimeout(300);
    await line(page, LONG, 23).click();
    await line(page, LONG, 25).click({ modifiers: ['Shift'] });
    await settled(page);
    const low = await geometry(page);
    const lowBox = clearOfLines(low);
    expect(lowBox.bottom, 'above the first line').toBeLessThanOrEqual(low.top);
    await pictures(page, 'phone-viewport-bottom', lowBox);
    // Scrolled off: Thread and Comments are free.
    // A touch scroll of the page, past the lines.
    await page.locator('.ib-gbody').first().evaluate((body) => { body.scrollTop += 700; });
    await page.waitForTimeout(300);
    // And the diff's own scroller under it, which takes over at the page's end.
    await line(page, LONG, 25).evaluate((row) => {
      for (let el: Element | null = row; el; el = el.parentElement ?? (el.getRootNode() as ShadowRoot).host ?? null) {
        if (el.scrollHeight > el.clientHeight + 200 && /auto|scroll/.test(getComputedStyle(el).overflowY)) {
          el.scrollTop += 700;
          return;
        }
      }
    });
    await page.waitForTimeout(300);
    await expect(selpop(page)).toBeHidden();
    expect(await free(page, 'Thread', page.locator('[data-review-message]').getByRole('button', { name: 'Thread' }).first())).toBe('free');
    expect(await free(page, 'Comments', page.locator('[data-review-message]').getByRole('button', { name: /^Comments/ }).first())).toBe('free');
  } finally {
    await context.close();
  }
});

test('two files with the same line numbers: scrolled to the next file, the lines and the bar stay with the first', async () => {
  const { page } = world;
  // One chapter holding both: scrolling down it hands focus to the next file.
  const both = { ...guide, sections: [{ title: 'Both files', overview: 'Both.', diffs: [{ file: LONG, summary: 'The worker.' }, { file: NEXT, summary: 'The next one.' }] }] };
  const sent = (await world.client.callTool({ name: 'submit_guide', arguments: { project_path: world.path, guide: both, patch: world.patch, review: true, thread: 'two-files', subject: 'Two files', body: 'Ready for review.', agent_session: 'ses-bar', agent_host: 'claude-code', agent_name: 'Claude Code' } })) as { isError?: boolean; content?: { text: string }[]; structuredContent: { thread_id: string } };
  if (sent.isError) throw new Error(sent.content?.map((c) => c.text).join(' '));
  await openReview(page, 1, sent.structuredContent.thread_id);
  await expect(line(page, LONG, 1)).toBeVisible({ timeout: 30_000 });
  await setStyle(page, 'split');
  await line(page, LONG, 1).evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(300);
  await select(page, LONG, 1, 3);
  const inFile = (file: string) => page.locator(`[data-guide-file-shell="${file}"]`).first().locator('[data-line][data-selected-line]');
  await expect(inFile(LONG).first()).toBeAttached();

  // Scroll with the bar open until the next file takes focus.
  await page.mouse.move(1000, 500);
  for (let i = 0; i < 40 && !(await inFile(NEXT).count()) && !(await line(page, NEXT, 9).isVisible()); i += 1) {
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(100);
  }
  await line(page, NEXT, 9).evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await page.mouse.wheel(0, 200);
  await page.waitForTimeout(800);
  await expect(inFile(NEXT), 'its numbers painted on the next file').toHaveCount(0);
  await expect(selpop(page)).toBeHidden();

  // Back: the same lines, the bar under them, and Comment goes to this file.
  await line(page, LONG, 1).evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await settled(page);
  const g = await geometry(page);
  const box = clearOfLines(g);
  const three = await line(page, LONG, 3).boundingBox();
  expect(Math.abs(box.top - (three!.y + three!.height + 6))).toBeLessThan(3);
  await bar(page).getByRole('button', { name: 'Comment' }).click();
  await expect(page.locator('.review-toolbar')).toBeVisible();
  await page.keyboard.type('On the first file.');
  await page.keyboard.press('Meta+Enter');
  await expect(page.locator('.review-toolbar')).toHaveCount(0);
  await expect(page.locator(`[data-guide-file-shell="${LONG}"]`).first().getByText('On the first file.')).toBeVisible();
  await expect(page.locator(`[data-guide-file-shell="${NEXT}"]`).first().getByText('On the first file.')).toHaveCount(0);
});

test('its lines gone: the bar hides, the header is free, the + rule lifts, and it comes back with them', async () => {
  const { page } = world;
  await openReview(page);
  await expect(line(page, LONG, 1)).toBeVisible({ timeout: 30_000 });
  await setStyle(page, 'unified');
  await line(page, LONG, 7).evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(300);
  await select(page, LONG, 7, 9);
  // A line the diff may not have drawn yet: scrolled to as a person does, then placed.
  const bring = async (n: number, by: number, block: ScrollLogicalPosition = 'center') => {
    await page.mouse.move(1000, 500);
    for (let i = 0; i < 40 && !(await line(page, LONG, n).count()); i += 1) {
      await page.mouse.wheel(0, by);
      await page.waitForTimeout(100);
    }
    await line(page, LONG, n).evaluate((el, at) => el.scrollIntoView({ block: at }), block);
  };
  const headerFree = async () => {
    await expect(selpop(page)).toBeHidden();
    await expect(bar(page)).toHaveCount(0);
    const pane = page.locator('[data-review-message]');
    expect(await free(page, 'Approve', pane.getByRole('button', { name: /Approve|Send Feedback/ }).first())).toBe('free');
    expect(await free(page, 'Thread', pane.getByRole('button', { name: 'Thread' }).first())).toBe('free');
  };
  // Just off the top of what the page shows, then far away, past where the diff draws rows.
  await bring(17, 400, 'start');
  await page.mouse.wheel(0, 10);
  await headerFree();
  await bring(61, 400);
  await headerFree();
  // The + is free to come back while the bar is hidden (comments.css keys it on the bar showing).
  const plusRule = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--review-selection-plus').trim());
  expect(await plusRule()).toBe('');
  await bring(7, -400);
  await settled(page);
  expect(await plusRule()).toBe('none');
  clearOfLines(await geometry(page));
  // Dismissed while hidden: a press on nothing closes it for good.
  await bring(61, 400);
  await expect(selpop(page)).toBeHidden();
  await page.mouse.click(4, 4);
  await expect(selpop(page)).toHaveCount(0);
  await bring(7, -400);
  await page.waitForTimeout(300);
  await expect(selpop(page)).toHaveCount(0);
});
