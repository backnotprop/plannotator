/**
 * The world of inbox-comments-list.spec.ts and inbox-comments-list-webkit.spec.ts:
 * a scratch Inbox from the compiled binary, an agent writing through
 * `plannotator inbox mcp`, and a thread per test holding comments saved as the
 * window saves them, on the agent's message and on its attached files.
 */
import { expect, type Locator, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));

export const MESSAGE_WORDS = 'a late success cannot charge twice';
export const FILE_WORDS = 'retries them one by one';

const BODY = [
  `The retries reuse the idempotency key, so ${MESSAGE_WORDS}. Dead-lettered charges land in the admin view.`,
  '',
  ':::question',
  'Ship the retry worker behind a flag?',
  '',
  '- [ ] Yes',
  '- [ ] No',
  ':::',
].join('\n');

const PLAN = `# Retry worker\n\nThe admin view lists dead-lettered charges and ${FILE_WORDS}.\n\nThe flag stays on for a day.\n`;
const PAGE = '<!doctype html><meta charset="utf-8"><title>Admin</title><h1>Dead-lettered charges</h1><button>Retry all</button>';

export interface ListWorld {
  url: string;
  agent: SimAgent;
  project: string;
}

export interface ListThread {
  thread: string;
  message: string;
  plan: string;
  page: string;
  /** The comment on the message's words. */
  onMessage: string;
  /** The comment on the Markdown file's words. */
  onPlan: string;
  count: number;
}

export async function startWorld(): Promise<ListWorld> {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-inbox-comments-list-');
  const dataDir = join(root, 'data');
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    CODEX_HOME: join(root, 'codex'),
    OPENCODE_CONFIG_DIR: join(root, 'opencode'),
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  const project = scratchProject(join(root, 'src'), 'billing-svc');
  mkdirSync(join(project, 'docs'));
  writeFileSync(join(project, 'docs', 'retry-plan.md'), PLAN);
  writeFileSync(join(project, 'docs', 'admin-view.html'), PAGE);
  return { url: started.stdout.trim(), agent: await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' }), project };
}

export async function stopWorld(world: ListWorld | undefined): Promise<void> {
  try {
    await world?.agent.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
}

const api = (world: ListWorld, path: string) => new URL(path, world.url).toString();

async function post(world: ListWorld, path: string, body: object): Promise<void> {
  const res = await fetch(api(world, path), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  expect(res.status, path).toBe(200);
}

let threads = 0;

/** A new thread with `spare` comments on the Markdown file ahead of the one on the message, so a long list has it far down. */
export async function seededThread(world: ListWorld, spare = 0): Promise<ListThread> {
  const n = ++threads;
  const sent = await world.agent.send({ project_path: world.project, subject: `Retry worker ${n}`, thread: `retry-${n}`, body: BODY, attachments: ['docs/retry-plan.md', 'docs/admin-view.html'] });
  const thread = sent.thread_id as string;
  const model = (await (await fetch(api(world, `/api/inbox/threads/${thread}/attachments`))).json()) as { attachments: { id: string; name: string }[] };
  const idOf = (name: string) => model.attachments.find((a) => a.name === name)!.id;
  const plan = idOf('retry-plan.md');
  const onPlan = `plan-${n}`;
  const onMessage = `message-${n}`;
  const onFile = (id: string, text: string) => post(world, '/api/inbox/annotations', { attachment_id: plan, version: 'current', annotation: { id, type: 'COMMENT', text, originalText: FILE_WORDS, blockId: '', startOffset: 0, endOffset: 0, createdA: Date.now() } });
  await onFile(onPlan, 'One by one is right.');
  for (let i = 0; i < spare; i++) await onFile(`spare-${n}-${i}`, `Another thought, number ${i}.`);
  await post(world, `/api/inbox/messages/${sent.message_id}/annotations`, {
    annotation: { id: onMessage, type: 'COMMENT', text: 'Is that true when the first request times out?', originalText: MESSAGE_WORDS, blockId: '', startOffset: 0, endOffset: 0, createdA: Date.now() },
  });
  return { thread, message: sent.message_id as string, plan, page: idOf('admin-view.html'), onMessage, onPlan, count: 2 + spare };
}

/** A thread the same agent wrote, with files but no comment. */
export async function quietThread(world: ListWorld): Promise<string> {
  const n = ++threads;
  const sent = await world.agent.send({ project_path: world.project, subject: `Quiet ${n}`, thread: `quiet-${n}`, body: 'Nothing here needs you.', attachments: ['docs/retry-plan.md'] });
  return sent.thread_id as string;
}

export const threadUrl = (world: ListWorld, t: ListThread) => `${world.url}#thread=${t.thread}`;
export const fileUrl = (world: ListWorld, t: ListThread, file: string, view: 'side' | 'full') => `${threadUrl(world, t)}&file=${file}&view=${view}`;

export const pane = (page: Page) => page.locator('section.ib-pane');
export const countLink = (page: Page, count: number) => pane(page).locator('[data-foot-status]').getByRole('button', { name: `${count} comments`, exact: true });
export const theList = (page: Page, count: number) => page.getByRole('dialog', { name: `${count} comments`, exact: true });
export const rowOf = (page: Page, id: string) => page.locator(`[data-annotation-row="${id}"]`);
export const highlight = (page: Page, t: ListThread) => page.locator(`[data-message-id="${t.message}"]`).locator('[data-bind-id], [data-highlight-id]').first();
export const cardChip = (page: Page) => page.locator('[data-fcomp]').locator('[data-fcomp-comments]');
export const fileHighlight = (page: Page) => page.locator('[data-attachment-pane]').locator('[data-bind-id], [data-highlight-id]');

/** Goes to a thread and waits for its comment's highlight, drawn after the message. */
export async function openThread(page: Page, world: ListWorld, t: ListThread): Promise<void> {
  await page.goto(threadUrl(world, t));
  await expect(highlight(page, t)).toBeVisible();
}

/** Where everything behind the list is, once a phone's pane has finished pushing in. */
export async function layout(page: Page): Promise<string> {
  await page.evaluate(() => Promise.allSettled((document.querySelector('section.ib-pane')?.getAnimations() ?? []).map((animation) => animation.finished)));
  return page.evaluate(() =>
    JSON.stringify(
      ['section.ib-pane .ib-pbody', 'section.ib-pane .ib-body', 'section.ib-pane .ib-pfoot', 'section.ib-pane .ib-footrow', '[data-fcomp]'].map((selector) => {
        const box = document.querySelector(selector)?.getBoundingClientRect();
        return box ? [box.left, box.top, box.width, box.height].map(Math.round) : null;
      }),
    ) + String(document.querySelector('section.ib-pane .ib-pbody')?.scrollTop ?? 0),
  );
}

/** The whole of the box is in the window, and above the keyboard when `bottom` is where that starts. */
export async function onScreen(page: Page, part: Locator, bottom?: number): Promise<void> {
  const box = await part.boundingBox();
  expect(box, 'it is drawn').not.toBeNull();
  const view = await page.evaluate(() => ({ width: document.documentElement.clientWidth, height: window.innerHeight }));
  expect(box!.x).toBeGreaterThanOrEqual(-0.5);
  expect(box!.x + box!.width).toBeLessThanOrEqual(view.width + 0.5);
  expect(box!.y).toBeGreaterThanOrEqual(-0.5);
  expect(box!.y + box!.height).toBeLessThanOrEqual((bottom ?? view.height) + 0.5);
}

/** The row is inside the list's own scroll. */
export async function rowShown(list: Locator, row: Locator): Promise<void> {
  const [outer, inner] = [await list.boundingBox(), await row.boundingBox()];
  expect(inner!.y).toBeGreaterThanOrEqual(outer!.y - 0.5);
  expect(inner!.y + inner!.height).toBeLessThanOrEqual(outer!.y + outer!.height + 0.5);
}
