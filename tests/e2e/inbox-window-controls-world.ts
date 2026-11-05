/**
 * The world and the window states for inbox-window-controls.spec.ts: an Inbox
 * under a scratch HOME and data folder, a scripted `gh` and `glab` first on
 * PATH, and one thread with a picture, a guided review and a Shape board.
 */
import { type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { fakeForge } from './fake-forge';
import { inboxScratch, rememberInboxOf } from './inbox-scratch';

const repo = resolve(__dirname, '../..');

export interface ControlsWorld {
  url: string;
  /** The thread with the picture. */
  picture: string;
  /** The thread and message of the guided review. */
  thread: string;
  guide: string;
  board: string;
  /** The thread with two open questions: Decision mode's way in. */
  questions: string;
  /** An agent's code review: the full-window review. */
  review: { thread: string; message: string };
  agents: SimAgent[];
}

export async function seedControlsWorld(binary: string, prefix: string): Promise<ControlsWorld> {
  const root = inboxScratch(prefix);
  const home = join(root, 'home');
  const dataDir = join(root, 'data');
  mkdirSync(home, { recursive: true });
  markTourDecided(dataDir);
  const configPath = join(dataDir, 'config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  writeFileSync(configPath, JSON.stringify({ ...config, inboxShape: true, inboxBoard: true, inboxCodeReview: true, experimental: { decisionMode: true } }));
  const forge = fakeForge(join(root, 'forge'));
  const env: Record<string, string> = {
    PATH: `${forge.dir}:${process.env.PATH ?? ''}`,
    HOME: home,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_INBOX_NOTES: '0',
    PLANNOTATOR_TEST_SANDBOX: '1',
    NO_ANON_PING: '1',
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    CODEX_HOME: join(root, 'codex'),
    XDG_CONFIG_HOME: join(root, 'xdg'),
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  if (started.status !== 0) throw new Error(`inbox --background: ${started.stderr}`);
  rememberInboxOf(dataDir);

  const project = scratchProject(join(root, 'src'), 'ledger');
  const picture = join(project, 'shot.png');
  copyFileSync(join(repo, 'tests/manual/shape-harness/public/refs/built-desktop-light.png'), picture);
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const pi = await SimAgent.connect({ binary, env, name: 'Pi', host: 'pi' });
  const sent = await claude.send({ project_path: project, subject: 'The ledger export is ready', thread: 'export', body: 'The ledger export is ready. The picture shows the new page.', attachments: ['shot.png'] });
  const question = (prompt: string) => `:::question\n${prompt}\n\n- [ ] Yes\n- [ ] No\n:::`;
  const asked = await claude.send({ project_path: project, subject: 'Two calls before the export ships', thread: 'calls', body: `Two calls.\n\n${question('Keep the CSV?')}\n\n${question('Keep the JSON?')}` });
  const { example } = await pi.guideBrief();
  const guided = await pi.submitGuide({ project_path: project, ...example });
  const askedForReview = await pi.send({ project_path: project, subject: 'A review of the token refresh', thread: 'review', body: 'Asking for the review.' });
  const reviewed = await pi.submitGuide({ project_path: project, ...example, reply_to: askedForReview.message_id, body: 'The review.', review: true } as never);

  const boardFile = join(root, 'board.json');
  writeFileSync(boardFile, JSON.stringify({ title: 'Ledger export', claim: 'One page.', views: { picture: { html: '<p>The page.</p>', css: 'p { margin: 40px; }' } } }));
  const shaped = spawnSync(binary, ['shape', 'update', '--file', boardFile, '--project', project, '--thread', sent.thread_id as string], { env, cwd: project, encoding: 'utf8', timeout: 30_000 });
  if (shaped.status !== 0) throw new Error(`shape update: ${shaped.stderr}`);

  return {
    url: started.stdout.trim(),
    picture: sent.thread_id as string,
    questions: asked.thread_id as string,
    review: { thread: reviewed.thread_id as string, message: reviewed.message_id as string },
    thread: guided.thread_id as string,
    guide: guided.message_id as string,
    board: (JSON.parse(shaped.stdout) as { id: string }).id,
    agents: [claude, pi],
  };
}

/** Load a route on a fresh page, with the sidebar docked open or collapsed (nothing on a phone: it has no docked sidebar). */
export async function openRoute(page: Page, world: ControlsWorld, hash: string, sidebar: 'open' | 'collapsed' = 'open'): Promise<void> {
  const wanted = sidebar === 'open' ? 'expanded' : 'collapsed';
  const settled = () => page.waitForTimeout(500);
  await page.goto('about:blank');
  await page.goto(world.url);
  await page.locator('.pn-inbox .ib-main').waitFor();
  await settled();
  const docked = page.locator('.ib-sb');
  const isDocked = (await docked.count()) > 0;
  // The list's own toggle first: a layer on the route may cover the window's.
  if (isDocked && (await docked.getAttribute('data-state')) !== wanted) {
    await page.locator('.ib-lhead .ib-sb-trigger').click();
    await settled();
  }
  if (hash) {
    await page.evaluate((to) => {
      window.location.hash = to;
    }, hash);
    await settled();
  }
  // Settings holds its own open or closed, and shows no toggle off a phone.
  if (isDocked && hash === '#settings' && (await docked.getAttribute('data-state')) !== wanted) {
    await page.keyboard.press('ControlOrMeta+b');
    await settled();
  }
}

/** The picture of the thread, opened and taken to full screen (a phone opens it there at once). */
export async function openFullScreenFile(page: Page, world: ControlsWorld, threadId: string): Promise<void> {
  await openRoute(page, world, `#thread=${threadId}`);
  await page.locator('.ib-att-t').first().click();
  await page.locator('[data-attachment-pane]').waitFor();
  if ((await page.locator('.ib-view.ib-full').count()) === 0) await page.locator('[data-attachment-pane] [data-full-screen-toggle]').click();
  await page.locator('.ib-view.ib-full').waitFor();
  await page.waitForTimeout(400);
}
