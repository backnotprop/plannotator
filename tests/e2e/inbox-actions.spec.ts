/**
 * Action items an agent needs the person to go do (approval "inbox-next-actions",
 * 2026-10-21, direction "In the thread"), proved in a real browser against the
 * compiled binary, with an agent writing through `plannotator inbox mcp`
 * (scripts/inbox-sim.ts):
 *
 *  - an agent's `:::action` block with `Stopped:` puts its thread under
 *    Stopped on you, and the row counts it in the box pill ("1 action to do", and the
 *    question count beside it): no new section, page or strip;
 *  - the thread draws the checklist card in place of the block (approval
 *    "action-items-checklist", option A): adjacent blocks are one card, blocks
 *    separated by prose are two; one row open at a time; the open row shows
 *    why, the Holds up words, Open for its link and the whole command with
 *    Copy (both when an item has both), then Done / Can't do it…;
 *  - Done goes into the reply draft (approval "inbox-action-items-in-reply",
 *    option A): the row is struck with its note field and "in your draft", no
 *    toast, the foot reads "Draft · 1 done" beside Send, the thread stays in
 *    Stopped on you, a reload keeps it, and nothing reaches the agent until
 *    Send; then wait_for_reply returns ONE reply whose first line joins the
 *    answers' ("Answered 1 question, did 1 action item."), with "Action items
 *    you asked for" and the note, and the sent message reads "You did 1
 *    action item";
 *  - the tick takes a Done back out of the draft;
 *  - Can't do it asks for the reason, which goes with the Send word for word;
 *  - the agent marks its own action item done (`done`): the card reads "Claude
 *    Code saw it done" and nothing is sent; over a Done waiting in the draft,
 *    the person's note still goes with their Send;
 *  - light and dark, desktop and a phone (WebKit, iPhone 15: 44 px targets).
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 * PNGs land in <PLANNOTATOR_E2E_PROOF_DIR or .local/proof>/actions/.
 * The agent's sim never waits for a reply it should not have: `readThread`
 * checks that nothing of the person's landed before the Send.
 */

import { devices, expect, test, webkit, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'actions');

const VERCEL = [
  'Release 4.2 is built and every check passed.',
  '',
  ':::action',
  'Approve the production deploy on Vercel',
  'The 4.2 build passed every check and waits under "Promote to Production". Nothing else needs changing.',
  '',
  'Where: [Vercel](https://vercel.com/acme/web/deployments/dpl_8Hk2mQ)',
  'Stopped: release 4.2 cannot go out until it is approved',
  "Watching: the deployment; I go on by myself once it is Ready",
  ':::',
].join('\n');

const NPM = [
  'The publish failed with E401.',
  '',
  ':::action',
  'Sign in to npm in your terminal',
  'The token on this machine expired; npm wants a browser sign-in with your security key.',
  '',
  'Run: `npm login`',
  'Holds up: the 0.29 publish',
  ':::',
  '',
  ':::question',
  'Publish 0.29 as latest, or as next first?',
  '',
  '- [ ] latest',
  '- [ ] next first',
  '',
  'Recommended: next first',
  ':::',
].join('\n');

const MERGE = [
  ':::action',
  'Merge PR #1937 on GitHub',
  'Branch protection needs a maintainer; I cannot merge it.',
  'Where: https://github.com/acme/web/pull/1937',
  'Watching: the PR; I go on once it is merged',
  ':::',
].join('\n');

const LONG_RUN = 'cd ~/workspaces/projects/appnotes/worktrees/main && npx wrangler secret put APPNOTES_GITHUB_APP_PRIVATE_KEY --env staging < ~/Downloads/appnotes-staging.private-key.pem && rm ~/Downloads/appnotes-staging.private-key.pem';

const STAGING = [
  'These are secrets, so only you can do them.',
  '',
  ':::action',
  'Set the GitHub App client secret on staging',
  'On the App\'s page, click "Generate a new client secret" and copy it.',
  'Where: https://github.com/organizations/acme/settings/apps/appnotes-staging',
  'Run: `pbpaste | npx wrangler secret put APPNOTES_GITHUB_APP_CLIENT_SECRET --env staging`',
  'Holds up: staging sign-in with GitHub',
  "Watching: the staging secret list; I'll see it appear",
  ':::',
  '',
  ':::action',
  'Set the GitHub App private key on staging',
  'On the same page, click "Generate a private key".',
  'Where: https://github.com/organizations/acme/settings/apps/appnotes-staging',
  `Run: \`${LONG_RUN}\``,
  'Holds up: the agent opening PRs on staging',
  "Watching: the staging secret list; I'll see it appear",
  ':::',
  '',
  'Then, once both are set:',
  '',
  ':::action',
  'Approve the staging deploy on Vercel',
  'Where: https://vercel.com/acme/appnotes/deployments',
  ':::',
].join('\n');

interface World {
  root: string;
  url: string;
  claude: SimAgent;
  context: BrowserContext;
  page: Page;
  errors: string[];
  threads: { vercel: string; npm: string; merge: string; mergeMessage: string; mergeKey: string; staging: string };
}

let world: World;

async function shot(page: Page, name: string, schemes: readonly ('light' | 'dark')[] = ['light', 'dark']): Promise<void> {
  for (const scheme of schemes) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(proofDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

const row = (page: Page, threadId: string) => page.locator(`[data-thread-id="${threadId}"]`).first();

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-actions-e2e-');
  const dataDir = join(root, 'data');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  const project = scratchProject(join(root, 'src'), 'web');
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const npm = await claude.send({ project_path: project, thread: 'publish', body: NPM });
  const merge = await claude.send({ project_path: project, thread: 'merge', body: MERGE });
  const vercel = await claude.send({ project_path: project, thread: 'release', body: VERCEL });
  const staging = await claude.send({ project_path: project, thread: 'staging', body: STAGING });
  const mergeKey = ((merge.actions as { key: string }[] | undefined) ?? [])[0]?.key ?? '';
  expect(mergeKey).toMatch(/^a-[0-9a-f]{8}$/);
  world = {
    root,
    url,
    claude,
    context,
    page,
    errors,
    threads: {
      vercel: vercel.thread_id as string,
      npm: npm.thread_id as string,
      merge: merge.thread_id as string,
      mergeMessage: merge.message_id as string,
      mergeKey,
      staging: staging.thread_id as string,
    },
  };
});

test.afterAll(async () => {
  try {
    if (!world) return;
    await world.claude.close().catch(() => {});
    await world.context.close();
  } finally {
    await removeInboxScratch();
  }
});

test('the list: no new section; the action item sits in Stopped on you and its row counts it in the box pill', async () => {
  const { page, threads } = world;
  await page.goto(world.url);
  const stopped = page.locator('section[aria-label="Stopped on you"], .ib-group').filter({ hasText: 'Stopped on you' }).first();
  await expect(stopped).toContainText('Approve the production deploy on Vercel');
  // The open action items' pill and the open questions' count (approval "inbox-row-action-icon"), named in words.
  for (const [id, actions, questions] of [[threads.vercel, 1, 0], [threads.npm, 1, 1], [threads.staging, 3, 0]] as const) {
    await expect(row(page, id).locator('[data-action-count]')).toHaveAttribute('data-action-count', String(actions));
    await expect(row(page, id).locator('.ib-qn')).toHaveCount(questions);
  }
  await expect(row(page, threads.vercel)).toHaveAccessibleName(/1 action to do/);
  await expect(row(page, threads.npm)).toHaveAccessibleName(/1 action to do 1 question/);
  await expect(row(page, threads.staging)).toHaveAccessibleName(/3 actions to do/);
  // No "Action item" section band, page or strip.
  await expect(page.getByText('Action item', { exact: true })).toHaveCount(0);
  await shot(page, '01-list');
});

test('the thread draws the checklist in place of the block: the open row shows why, the Holds up words, Open and the command', async () => {
  const { page, threads } = world;
  await page.goto(`${world.url}#thread=${threads.vercel}`);
  const card = page.locator('section.ib-pane [data-action-group]');
  await expect(card).toBeVisible();
  await expect(card).toContainText('1 thing only you can do');
  await expect(card.locator('[data-action-progress]')).toHaveText('0 of 1 done');
  await expect(card.locator('[data-action-badge]')).toHaveText('Stopped');
  await expect(card.locator('[data-action-toggle]')).toHaveAttribute('aria-expanded', 'true');
  await expect(card.locator('[data-action-stopped]')).toHaveText('Stopped release 4.2 cannot go out until it is approved');
  await expect(card.locator('[data-action-open]')).toHaveAttribute('href', 'https://vercel.com/acme/web/deployments/dpl_8Hk2mQ');
  await expect(card.locator('[data-action-watching]')).toHaveText('Claude Code is watching: the deployment; I go on by myself once it is Ready.');
  // A Done goes with the person's Send: no timer words.
  await expect(card.locator('[data-action-hint]')).toHaveCount(0);
  await expect(card).not.toContainText('10 s');
  // The block's own lines are not drawn beside the card.
  await expect(page.locator('section.ib-pane')).not.toContainText('Where: [Vercel]');
  // 👍 Looks good waits while the action item does.
  await expect(page.locator('section.ib-pane [data-ack]')).toHaveCount(0);
  await shot(page, '02-thread-open');
  await page.goto(`${world.url}#thread=${threads.npm}`);
  const npm = page.locator('section.ib-pane [data-action-group]');
  await expect(npm.locator('[data-action-cmd]')).toContainText('npm login');
  await expect(npm.locator('[data-action-badge]')).toHaveText('Holds up 1');
  await expect(npm.locator('[data-action-holds]')).toHaveText('Holds up the 0.29 publish');
  await expect(page.locator('section.ib-pane [data-question-key]').first()).toBeVisible();
  await shot(page, '03-thread-run-and-question');
});

test('adjacent action items are one checklist, one row open at a time; prose between them makes two; Open and the whole command both show', async () => {
  const { page, threads } = world;
  await page.goto(`${world.url}#thread=${threads.staging}`);
  const groups = page.locator('section.ib-pane [data-action-group]');
  await expect(groups).toHaveCount(2);
  const first = groups.nth(0);
  await expect(first.locator('[data-action-card]')).toHaveCount(2);
  await expect(groups.nth(1).locator('[data-action-card]')).toHaveCount(1);
  await expect(first).toContainText('2 things only you can do');
  await expect(first.locator('[data-action-badge]')).toHaveText('Holds up 2');
  const rows = first.locator('[data-action-card]');
  const toggle = (i: number) => rows.nth(i).locator('[data-action-toggle]');
  await expect(toggle(0)).toHaveAttribute('aria-expanded', 'true');
  await expect(toggle(1)).toHaveAttribute('aria-expanded', 'false');
  // One open at a time.
  await toggle(1).click();
  await expect(toggle(1)).toHaveAttribute('aria-expanded', 'true');
  await expect(toggle(0)).toHaveAttribute('aria-expanded', 'false');
  const open = rows.nth(1);
  await expect(open.locator('[data-action-open]')).toHaveText('Open github.com');
  await expect(open.locator('[data-action-copy]')).toBeVisible();
  await expect(open.locator('[data-action-holds]')).toHaveText('Holds up the agent opening PRs on staging');
  // The command whole: every character, wrapped, nothing cut or scrolled away.
  const cmd = open.locator('[data-action-cmd]');
  expect((await cmd.textContent())!.replace(/^\$\s/, '')).toBe(LONG_RUN);
  const fit = await cmd.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth, lines: Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)) }));
  expect(fit.scroll).toBeLessThanOrEqual(fit.client);
  expect(fit.lines).toBeGreaterThan(1);
  await toggle(0).click();
  await shot(page, '03b-checklist');
});

const personMessages = async (threadId: string) =>
  ((await world.claude.readThread(threadId)).messages as { author: { kind: string } }[]).filter((m) => m.author.kind === 'person').length;

test('Done goes into the reply draft: struck, its note, "in your draft", no toast; Stopped on you holds; a reload keeps it; nothing goes until Send', async () => {
  const { page, threads } = world;
  await page.goto(`${world.url}#thread=${threads.npm}`);
  const pane = page.locator('section.ib-pane');
  const card = pane.locator('[data-action-card]');
  await card.locator('[data-action-done]').click();
  await expect(card).toHaveAttribute('data-action-state', 'pending');
  await expect(card.locator('[data-action-draft-line]')).toHaveText(/^Done \d{1,2}:\d{2}\s?[AP]M · in your draft$/);
  await expect(card.locator('[data-action-undo]')).toHaveCount(0);
  await expect(page.locator('.ib-toast')).toHaveCount(0);
  await expect(pane.locator('[data-foot-status] [data-draft-foot]')).toContainText('1 done');
  await expect(pane.locator('[data-reply-actions="draft"]')).toHaveCount(0); // the box is closed: the foot counts it
  // The note, saved as it is typed.
  const note = card.locator('[data-action-draft-note]');
  await expect(note).toHaveAttribute('placeholder', 'Add a note for Claude Code');
  await note.fill('Signed in with the YubiKey; the token is good for 30 days.');
  await note.blur();
  await page.waitForTimeout(800);
  // Q2: the thread stays where the item put it.
  const holding = page.locator('.ib-group').filter({ hasText: 'Holding up work' }).first();
  await expect(holding.locator(`[data-thread-id="${threads.npm}"]`)).toBeVisible();
  await shot(page, '04-done-in-draft');
  // A reload keeps the Done and its note in the draft.
  await page.reload();
  await expect(card).toHaveAttribute('data-action-state', 'pending');
  await expect(card.locator('[data-action-draft-note]')).toHaveValue('Signed in with the YubiKey; the token is good for 30 days.');
  await expect(pane.locator('[data-foot-status] [data-draft-foot]')).toContainText('1 done');
  // Far past the old 10 s window: nothing of the person's reached the agent.
  await page.waitForTimeout(11_000);
  expect(await personMessages(threads.npm)).toBe(0);
});

test('Send carries the Done and its note with the answer: one first line, the section last; the sent message reads "You did 1 action item"', async () => {
  const { page, threads, claude } = world;
  const pane = page.locator('section.ib-pane');
  await pane.locator('[data-question-option]').filter({ hasText: 'next first' }).first().click();
  await expect(pane.locator('[data-foot-status] [data-draft-foot]')).toContainText('1 pick, 1 done');
  await shot(page, '05-draft-foot', ['light']);
  // The reply box lists what goes with the reply (approved A-03): the item, its Done and its note.
  await pane.locator('[data-reply-button]').click();
  const going = pane.locator('[data-reply-actions="draft"]');
  await expect(going).toContainText('Your action item goes with this reply');
  await expect(going.locator('.ib-ranswer')).toHaveCount(1);
  await expect(going.locator('.ib-ranswer')).toContainText('A1');
  await expect(going.locator('.ib-ranswer')).toContainText('Sign in to npm in your terminal');
  await expect(going.locator('.ib-ranswer-a')).toHaveText('Done · Note: Signed in with the YubiKey; the token is good for 30 days.');
  await shot(page, '05b-reply-box');
  await pane.locator('.ib-pfoot').getByRole('button', { name: 'Send' }).click();
  const answer = await claude.waitForReply(threads.npm, 40);
  expect(answer.status).toBe('replied');
  const body = (answer.reply as { body: string }).body;
  expect(body.startsWith('Answered 1 question, did 1 action item.\n\n')).toBe(true);
  const section = body.slice(body.indexOf('## Action items you asked for'));
  expect(section.startsWith('## Action items you asked for\n\n1 of 1 done.\n\n### A1. Sign in to npm in your terminal\nDone, ')).toBe(true);
  expect(section.endsWith('\nNote: Signed in with the YubiKey; the token is good for 30 days.')).toBe(true);
  expect(body.indexOf('## Answers to your questions')).toBeLessThan(body.indexOf('## Action items you asked for'));
  const card = pane.locator('[data-action-card]');
  await expect(card).toHaveAttribute('data-action-state', 'done', { timeout: 20_000 });
  await card.locator('[data-action-toggle]').click();
  await expect(card.locator('[data-action-settled]')).toContainText('Sent to Claude Code with your reply.');
  const sent = pane.locator('[data-reply-actions="sent"]');
  await expect(sent).toContainText('You did 1 action item');
  await expect(sent).toContainText('Done · Note: Signed in with the YubiKey');
  // The person's message shows their words and answers, not the agent-facing section.
  const mine = pane.locator('[data-message-id]').last();
  await expect(mine).not.toContainText('Action items you asked for');
  await expect(mine).not.toContainText('1 of 1 done.');
  await expect(mine).not.toContainText('Answered 1 question, did');
  await shot(page, '06-sent-you-did');
});

test("the row's tick is Done into the draft; the next open item opens; the tick takes it back", async () => {
  const { page, threads } = world;
  await page.goto(`${world.url}#thread=${threads.staging}`);
  const group = page.locator('section.ib-pane [data-action-group]').first();
  const rows = group.locator('[data-action-card]');
  await rows.nth(0).locator('[data-action-tick]').click();
  await expect(rows.nth(0)).toHaveAttribute('data-action-state', 'pending');
  await expect(rows.nth(1).locator('[data-action-toggle]')).toHaveAttribute('aria-expanded', 'true');
  await expect(group.locator('[data-action-progress]')).toHaveText('1 of 2 done');
  await shot(page, '07-tick-done', ['light']);
  await page.waitForTimeout(600);
  await rows.nth(0).locator('[data-action-tick]').click();
  await expect(rows.nth(0)).toHaveAttribute('data-action-state', 'open');
  await expect(page.locator('section.ib-pane [data-foot-status]')).toHaveCount(0);
});

test("Can't do it: the reason, with the Send, word for word", async () => {
  const { page, threads, claude } = world;
  await page.goto(`${world.url}#thread=${threads.vercel}`);
  const pane = page.locator('section.ib-pane');
  const card = pane.locator('[data-action-card]');
  await card.locator('[data-action-cant]').click();
  await expect(card.locator('[data-action-cant-send]')).toBeDisabled();
  await expect(card.locator('[data-action-cant-send]')).toHaveText("Can't do it");
  await card.locator('textarea').fill('Only Dana can promote to production; I asked her.');
  await shot(page, '08-cant-reason', ['light']);
  await card.locator('[data-action-cant-send]').click();
  await expect(card.locator('[data-action-draft-line]')).toContainText("Can't do it");
  await expect(pane.locator('[data-foot-status] [data-draft-foot]')).toContainText("1 can't do");
  // Q2: a Stopped item's mark waiting in the draft keeps the thread in Stopped on you.
  const stopped = page.locator('.ib-group').filter({ hasText: 'Stopped on you' }).first();
  await expect(stopped.locator(`[data-thread-id="${threads.vercel}"]`)).toBeVisible();
  await shot(page, '08b-cant-in-draft');
  expect(await personMessages(threads.vercel)).toBe(0);
  await pane.locator('.ib-pfoot').getByRole('button', { name: 'Send' }).click();
  const answer = await claude.waitForReply(threads.vercel, 40);
  const body = (answer.reply as { body: string }).body;
  expect(body.startsWith("Couldn't do 1 action item.\n\n## Action items you asked for")).toBe(true);
  expect(body).toContain("### A1. Approve the production deploy on Vercel\nCan't do it: Only Dana can promote to production; I asked her.");
  await expect(card).toHaveAttribute('data-action-state', 'cant', { timeout: 20_000 });
  await expect(card.locator('[data-action-settled]')).toHaveText("Can't do it: “Only Dana can promote to production; I asked her.” Sent to Claude Code with your reply.");
});

test("the agent marks its own action item done while the person's Done waits in the draft: the card says so, the note still goes with the Send", async () => {
  const { page, threads, claude } = world;
  await page.goto(`${world.url}#thread=${threads.merge}`);
  const pane = page.locator('section.ib-pane');
  const card = pane.locator('[data-action-card]');
  await expect(card).toHaveAttribute('data-action-state', 'open');
  await card.locator('[data-action-done]').click();
  await card.locator('[data-action-draft-note]').fill('Merged with a squash; kept the changelog line.');
  await card.locator('[data-action-draft-note]').blur();
  await page.waitForTimeout(800);
  const sent = await claude.send({
    project_path: world.root,
    reply_to: threads.mergeMessage,
    body: 'The PR is merged, so I marked the action item done. Running the release smoke tests now.',
    done: [`${threads.mergeMessage}/${threads.mergeKey}`],
  });
  expect(sent.done).toEqual([`${threads.mergeMessage}/${threads.mergeKey}`]);
  await expect(card).toHaveAttribute('data-action-state', 'seen', { timeout: 20_000 });
  await expect(card.locator('[data-action-settled]')).toContainText('Claude Code saw it done');
  await expect(card.locator('[data-action-draft-note]')).toHaveValue('Merged with a squash; kept the changelog line.');
  await expect(card.locator('[data-action-draft-line]')).toHaveText('Your note · in your draft');
  // The note is a draft: the row's Draft label says so (the open row stays where it is while it is open).
  await expect(row(page, threads.merge)).toContainText('1 done');
  await shot(page, '09-agent-saw-it-done-note');
  // Nothing from the person yet: the agent's two messages only.
  expect(await personMessages(threads.merge)).toBe(0);
  await pane.locator('.ib-pfoot').getByRole('button', { name: 'Send' }).click();
  const answer = await claude.waitForReply(threads.merge, 40);
  const body = (answer.reply as { body: string }).body;
  expect(body).toContain('### A1. Merge PR #1937 on GitHub\nYou saw it done, ');
  expect(body).toContain('\nNote: Merged with a squash; kept the changelog line.');
  await expect(card.locator('[data-action-draft-note]')).toHaveCount(0, { timeout: 20_000 });
  expect(world.errors).toEqual([]);
});

test('phone (WebKit, iPhone 15): the checklist, 44 px targets', async () => {
  let own: Browser | null = null;
  try {
    const project = scratchProject(join(world.root, 'phone'), 'mobile');
    const sent = await world.claude.send({ project_path: project, thread: 'phone', body: VERCEL.replace('4.2', '4.3') });
    own = await webkit.launch({ args: [] });
    const context = await own.newContext({ ...devices['iPhone 15'], colorScheme: 'light' });
    const page = await context.newPage();
    await page.goto(`${world.url}#thread=${sent.thread_id as string}`);
    const card = page.locator('section.ib-pane [data-action-card]');
    await expect(card).toBeVisible();
    for (const selector of ['[data-action-done]', '[data-action-cant]', '[data-action-open]']) {
      expect((await card.locator(selector).boundingBox())!.height).toBe(44);
    }
    for (const selector of ['[data-action-tick]', '[data-action-toggle]']) {
      const box = (await card.locator(selector).boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.width).toBeGreaterThanOrEqual(44);
    }
    await shot(page, '10-phone');
    // Done into the draft: the note field is a 44 px target with 16 px text (no zoom on focus).
    await card.locator('[data-action-done]').tap();
    const note = card.locator('[data-action-draft-note]');
    await expect(note).toBeVisible();
    expect((await note.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await note.evaluate((el) => getComputedStyle(el).fontSize)).toBe('16px');
    await expect(page.locator('section.ib-pane [data-foot-status] [data-draft-foot]')).toContainText('1 done');
    await shot(page, '10b-phone-in-draft');
    await context.close();
  } finally {
    await own?.close();
  }
});
