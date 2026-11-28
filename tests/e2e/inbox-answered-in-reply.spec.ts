import { expect, test, type Browser, type BrowserContext, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));

const ASK = [
  'The new build runner is up for harbor.',
  '',
  ':::question',
  'Which region should the new runner live in?',
  '',
  'Holds up: the runner image',
  '',
  '- [ ] us-east-1',
  '- [ ] eu-west-1',
  ':::',
  '',
  ':::question',
  'Keep the old Jenkins job as a fallback for a week?',
  '',
  '- [ ] Yes',
  '- [ ] No',
  ':::',
].join('\n');

const WORDS = "Yep, keep Jenkins for a week, that's fine.";

let root: string;
let context: BrowserContext;
let page: Page;
let claude: SimAgent;
let harbor: string;
let first: { message_id: string; thread_id: string; questions: { key: string }[] };

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  root = inboxScratch('plannotator-inbox-answered-e2e-');
  const trap = join(root, 'bin');
  mkdirSync(trap);
  writeFileSync(join(trap, 'tailscale'), "#!/bin/sh\necho 'inbox-answered-in-reply.spec: tailscale must not run' >&2\nexit 97\n");
  chmodSync(join(trap, 'tailscale'), 0o755);
  const env = { PATH: `${trap}:${process.env.PATH ?? ''}`, HOME: root, PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9', PLANNOTATOR_DATA_DIR: join(root, 'data'), PLANNOTATOR_BROWSER: NO_BROWSER };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'light' });
  page = await context.newPage();
  harbor = scratchProject(join(root, 'src'), 'harbor');
  claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  first = (await claude.send({ project_path: harbor, body: ASK })) as typeof first;
  await page.goto(started.stdout.trim());
});

test.afterAll(async () => {
  try {
    await claude?.close().catch(() => {});
    await context?.close();
  } finally {
    await removeInboxScratch();
  }
});

const card = () => page.locator(`[data-message-id="${first.message_id}"] [data-question-key="${first.questions[1]!.key}"]`);

test('the person answers in words, the agent takes it as the answer, and Reopen gives the question back', async () => {
  await page.locator(`.ib-lbody [data-thread-id="${first.thread_id}"]`).click();
  await expect(page.locator('.ib-pfoot')).toContainText('2 open questions');
  await page.locator('.ib-pfoot').getByRole('button', { name: 'Reply', exact: true }).click();
  await page.getByRole('textbox', { name: 'Reply to Claude Code' }).fill(WORDS);
  await page.locator('.ib-pfoot').getByRole('button', { name: 'Send', exact: true }).click();
  const reply = await claude.nextReply(first.thread_id, 20);
  expect(String(reply.body)).toContain('name it in answered_in_reply');

  const ref = `${first.message_id}/${first.questions[1]!.key}`;
  const sent = await claude.send({ project_path: harbor, reply_to: String(reply.id), body: 'Got it: Jenkins stays as a fallback for a week.', answered_in_reply: [{ question: ref }] });
  expect(sent.answered_in_reply).toEqual([ref]);
  await expect(card()).toHaveAttribute('data-question-state', 'answered_in_reply');
  await expect(card().locator('[data-answered-quote]')).toContainText(`“${WORDS}”`);
  await expect(card().locator('[data-answered-by]')).toContainText(/^Claude Code took this from your reply · \d{1,2}:\d{2} [AP]M$/);
  await expect(page.locator('.ib-pfoot')).toContainText('1 open question');

  await card().getByRole('button', { name: 'Reopen' }).click();
  await expect(card()).not.toHaveAttribute('data-question-state', 'answered_in_reply');
  await expect(card().getByRole('radio')).toHaveCount(2);
  await expect(page.locator('.ib-pfoot')).toContainText('2 open questions');
  const note = await claude.nextReply(first.thread_id, 20, String(sent.message_id));
  expect(String(note.body)).toContain(ref);
  expect(String(note.body)).toContain("don't use those words as the answer");
});
