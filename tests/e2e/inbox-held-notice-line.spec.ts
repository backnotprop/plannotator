/**
 * The list's "N new" line and the project a session started in a checkouts folder files under, proved
 * against the compiled binary with agents writing through `plannotator inbox mcp` (scripts/inbox-sim.ts).
 *
 * The owner, 2026-11-02: the held line read "1 new in appnotes · Users/ramos/workspaces/projects" on two
 * lines beside Show. `~/workspaces/projects/appnotes` is a plain folder of notes whose `worktrees` folder
 * holds the repository's checkouts (`worktrees/main` and linked worktrees); a session started in the folder
 * made a folder project beside the repository's, both "appnotes", and the window's name climbed to the root.
 *
 * - A session started in that folder files into the repository's project (no folder project is made).
 * - The line is ONE line at 1440 px (the list wide, and narrow beside a thread), on a 390 px phone and on a
 *   320 px one: the count and Show keep their size, a long project name is cut with "…", and on a desktop the
 *   whole line is the tooltip while it is cut.
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-held-notice-line.spec.ts`.
 */

import { devices, expect, test, type Browser, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const LONG = 'customer-research-and-design-notes-for-the-appnotes-launch';

interface World {
  url: string;
  agent: SimAgent;
  folder: string;
  main: string;
  long: string;
}

let world: World;
let sent = 0;

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com' };
function git(cwd: string, ...args: string[]): void {
  const result = spawnSync('git', ['-c', 'init.defaultBranch=main', ...args], { cwd, env: GIT_ENV, encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-inbox-heldline-e2e-');
  // Never a real agent's CLI: no connection runs (PLANNOTATOR_INBOX_CONNECT=0), and stubs that refuse come first on PATH.
  const stubs = join(root, 'bin');
  mkdirSync(stubs, { recursive: true });
  for (const name of ['claude', 'codex', 'opencode', 'pi', 'gemini', 'cursor-agent', 'amp']) writeFileSync(join(stubs, name), '#!/bin/sh\necho "this stub never runs" >&2\nexit 1\n', { mode: 0o755 });
  const dataDir = join(root, 'data');
  const env = {
    PATH: `${stubs}:${process.env.PATH ?? ''}`,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    CLAUDE_CONFIG_DIR: join(root, 'claude-config'),
  };

  // The owner's layout: a plain folder of notes, the repository's main checkout and a linked worktree in its `worktrees`.
  const folder = join(root, 'src', 'workspaces', 'projects', 'appnotes');
  mkdirSync(join(folder, 'worktrees'), { recursive: true });
  writeFileSync(join(folder, 'DESIGN.md'), '# Design\n');
  const main = join(folder, 'worktrees', 'main');
  git(root, 'init', '-q', main);
  writeFileSync(join(main, 'README.md'), 'appnotes\n');
  git(main, 'add', '.');
  git(main, 'commit', '-qm', 'init');
  git(main, 'worktree', 'add', '-q', join(folder, 'worktrees', 'agent-pr-plan-box'), '-b', 'agent-pr-plan-box');
  const long = scratchProject(join(root, 'src'), LONG);

  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  for (const [n, subject] of ['Plan box follow-ups', 'Auth callback hotfix', 'Billing self-serve'].entries()) {
    await agent.send({ project_path: join(folder, 'worktrees', 'agent-pr-plan-box'), subject, body: `${subject}. Nothing to answer.`, agent_session: `ses_seed_${n}` } as Parameters<SimAgent['send']>[0]);
  }
  await agent.send({ project_path: long, subject: 'Interview notes', body: 'Interview notes are in.', agent_session: 'ses_seed_long' } as Parameters<SimAgent['send']>[0]);
  world = { url: started.stdout.trim().replace(/\/$/, ''), agent, folder: realpathSync(folder), main: realpathSync(main), long };
});

test.afterAll(async () => {
  try {
    await world?.agent.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

test("a session started in the checkouts' folder files into the repository's project", async () => {
  const fromFolder = (await world.agent.send({ project_path: world.folder, subject: 'Notes from the folder', body: 'Written from appnotes.', agent_session: 'ses_folder' } as Parameters<SimAgent['send']>[0])) as {
    project: { root: string; name: string };
  };
  expect(fromFolder.project.root).toBe(world.main);
  const list = (await (await fetch(`${world.url}/api/inbox/projects`)).json()) as { projects: { root: string }[] };
  expect(list.projects.map((p) => p.root)).not.toContain(world.folder);
});

/** An agent writes in the long-named project while the person reads a thread: the list holds it behind "1 new". */
async function newsWhileReading(page: Page, phone: boolean): Promise<void> {
  await page.goto(world.url);
  const first = page.locator('.ib-listcol .ib-lbody [data-thread-id]').first();
  await expect(first).toBeVisible();
  await first.click();
  await expect(page.locator('section.ib-pane')).toBeVisible();
  sent += 1;
  await world.agent.send({ project_path: world.long, subject: `Survey ${sent}`, body: 'The survey results are in.', agent_session: `ses_long_${sent}` } as Parameters<SimAgent['send']>[0]);
  if (phone) await page.locator('[data-phone-back]').click();
  await expect(page.locator('[data-inbox-notice]')).toContainText(`1 new in ${LONG}`);
}

/** The line's geometry: one line, Show whole inside it, and whether the project name is cut. */
function lineOf(page: Page) {
  return page.locator('[data-inbox-notice]').evaluate((button) => {
    const box = button.getBoundingClientRect();
    const text = button.querySelector<HTMLElement>('.ib-notice-text')!;
    const project = button.querySelector<HTMLElement>('.ib-notice-proj')!;
    const show = button.querySelector<HTMLElement>('b')!.getBoundingClientRect();
    const lineHeight = parseFloat(getComputedStyle(text).lineHeight) || parseFloat(getComputedStyle(text).fontSize) * 1.5;
    return {
      height: box.height,
      oneLine: text.getBoundingClientRect().height <= lineHeight * 1.2 && project.getClientRects().length === 1,
      showInside: show.width > 20 && show.left >= box.left && show.right <= box.right + 0.5,
      cut: project.scrollWidth > project.clientWidth + 0.5,
      projectText: project.textContent,
    };
  });
}

for (const shape of [
  { name: '1440 px, the list beside a thread', width: 1440, height: 900, phone: false, close: false },
  { name: '1440 px, the list alone', width: 1440, height: 900, phone: false, close: true },
  { name: '390 px phone', width: 390, height: 844, phone: true, close: false },
  { name: '320 px phone', width: 320, height: 640, phone: true, close: false },
]) {
  test(`the "1 new" line is one line with Show in it: ${shape.name}`, async ({ browser }: { browser: Browser }) => {
    const context = await browser.newContext(
      shape.phone ? { ...devices['iPhone 15'], viewport: { width: shape.width, height: shape.height }, colorScheme: 'light' } : { viewport: { width: shape.width, height: shape.height }, colorScheme: 'light' },
    );
    try {
      const page = await context.newPage();
      await newsWhileReading(page, shape.phone);
      if (shape.close) {
        await page.keyboard.press('Escape');
        await expect(page.locator('section.ib-pane')).toHaveCount(0);
      }
      const line = await lineOf(page);
      expect(line.projectText).toBe(LONG);
      expect(line.oneLine, JSON.stringify(line)).toBe(true);
      expect(line.showInside, JSON.stringify(line)).toBe(true);
      expect(line.height).toBeLessThanOrEqual(shape.phone ? 46 : 40);
      // Too long for a phone or the list beside a thread: cut with "…", never wrapped.
      if (shape.phone || !shape.close) expect(line.cut).toBe(true);
      if (!shape.phone && line.cut) {
        await page.locator('[data-inbox-notice]').hover();
        await expect(page.locator('[data-pn-tooltip]').filter({ hasText: `1 new in ${LONG}` }).first()).toBeVisible();
      }
    } finally {
      await context.close();
    }
  });
}
