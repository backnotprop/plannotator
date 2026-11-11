/**
 * "Ask your agent to look" on a PR card's tool state, in a real browser
 * against the compiled binary, on a poor link.
 *
 * A fake `gh` first on PATH is signed out, and its error output carries what
 * a careless tool prints: a home path and a token. Nothing reaches a forge.
 *
 * What it proves (the critical path, the owner's call 2026-11-11):
 *  - The card says why first ("gh isn't signed in to github.com", the
 *    command), and offers "Ask your agent to look" after it.
 *  - On a throttled link, one press opens New message filled in: To is the
 *    agent that owns the thread, the thread's name is "Look into: <the line>",
 *    and the body is the report (the line, the tool, what the Inbox tried, the
 *    read-only checks, the once-only offer), with the home path and the token
 *    redacted out of the tool's line.
 *  - Send is the only step: it creates the thread, addressed to that agent.
 *
 * Build the binary first (see inbox.spec.ts).
 */
import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { INBOX_BRIDGE_POLL_PATH } from '../../packages/shared/inbox/connection';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const PR = 'https://github.com/acme/widgets/pull/9';
const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123';

let url = '';
let root = '';
let threadId = '';
let session = '';
let claude: SimAgent | null = null;
let live: { stop: boolean; loop: Promise<void> | null } = { stop: false, loop: null };

test.beforeAll(async () => {
  test.setTimeout(180_000);
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  root = inboxScratch('plannotator-ask-agent-');
  const dataDir = join(root, 'data');
  markTourDecided(dataDir);
  for (const dir of ['claude', 'codex', 'xdg']) mkdirSync(join(root, dir), { recursive: true });
  const stubs = join(root, 'stubs');
  mkdirSync(stubs, { recursive: true });
  // gh: signed out everywhere; its error line names a home path and a token, as a careless tool might.
  writeFileSync(
    join(stubs, 'gh'),
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "gh version 2.103.0 (2026-10-01)"; exit 0; fi
if [ "$1" = auth ]; then echo "You are not logged into any accounts on github.com" >&2; exit 1; fi
echo "To get started with GitHub CLI, please run:  gh auth login" >&2
echo "read ${root}/.config/gh/hosts.yml: token ${TOKEN} rejected" >&2
exit 4
`,
  );
  for (const name of ['gh', 'glab', 'open', 'xdg-open']) {
    if (!existsSync(join(stubs, name))) writeFileSync(join(stubs, name), '#!/bin/sh\nexit 0\n');
    chmodSync(join(stubs, name), 0o755);
  }
  const env: Record<string, string> = {
    PATH: `${stubs}:/usr/bin:/bin`,
    HOME: root,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_ANON_PING: '1',
    PLANNOTATOR_INBOX_NOTES: '0',
    PLANNOTATOR_TEST_SANDBOX: '1',
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    CODEX_HOME: join(root, 'codex'),
    XDG_CONFIG_HOME: join(root, 'xdg'),
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  url = started.stdout.trim();
  expect(url).not.toContain(':49606');
  expect(url).not.toContain(':59812');
  const project = scratchProject(join(root, 'src'), 'widgets');
  claude = await SimAgent.connect({ binary, env: { ...env, PATH: `${stubs}:${process.env.PATH}` }, name: 'Claude Code', host: 'claude-code' });
  const sent = await claude.send({ project_path: project, thread: 'widgets export', subject: 'Widgets: retry the export', body: 'The PR is up.', pulls: [PR] } as never);
  threadId = sent.thread_id as string;
  // The session the agent wrote from, as the window reads the thread.
  const answer = (await (await fetch(`${url}api/inbox/threads/${threadId}`)).json()) as { thread?: { messages?: { author: { session?: string } }[] }; messages?: { author: { session?: string } }[] };
  session = (answer.thread?.messages ?? answer.messages ?? [])[0]?.author.session ?? '';
  expect(session).not.toBe('');
  // That session is live, as the mod's connection holds it, so New message can address it.
  const { port, token } = JSON.parse(readFileSync(join(dataDir, 'inbox', 'inbox.json'), 'utf8')) as { port: number; token: string };
  const startedAt = Date.now() - 10 * 60_000;
  live.loop = (async () => {
    while (!live.stop) {
      await fetch(`http://127.0.0.1:${port}${INBOX_BRIDGE_POLL_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ session, host: 'claude-code', waitMs: 1_000, project_path: project, started_at: startedAt, busy: false, idle_since: startedAt }),
      }).catch(() => null);
    }
  })();
});

test.afterAll(async () => {
  live.stop = true;
  await live.loop;
  await claude?.close().catch(() => {});
  await removeInboxScratch();
});

test('a signed-out gh: Ask your agent to look opens the report to the thread\'s agent, and Send makes the thread', async ({ browser }) => {
  test.setTimeout(180_000);
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  await page.emulateMedia({ reducedMotion: 'reduce' });

  // The page loads on a normal link; the card, the press and the send run on a poor one.
  await page.goto(`${url}#thread=${threadId}`);
  await expect(page.locator('section.ib-pane').getByRole('heading', { name: 'Widgets: retry the export' })).toBeVisible({ timeout: 30_000 });
  const card = page.locator('[data-pr-popover]');
  for (let i = 0; i < 30 && (await card.locator('[data-problem="tool.signed_out"]').count()) === 0; i++) {
    if ((await card.count()) === 0) await page.locator('section.ib-pane [data-pr-button]').first().click();
    await page.waitForTimeout(500);
    if (i % 6 === 5) await page.keyboard.press('Escape');
  }
  const problem = card.locator('[data-problem="tool.signed_out"]');
  await expect(problem.locator('[data-problem-title]')).toHaveText("gh isn't signed in to github.com");
  // The error and its own next step come first; the ask is after them.
  const order = await problem.evaluate((el) => {
    const all = [...el.querySelectorAll('[data-problem-title], [data-problem-command], [data-problem-ask]')];
    return all.map((n) => (n.hasAttribute('data-problem-title') ? 'title' : n.hasAttribute('data-problem-command') ? 'command' : 'ask'));
  });
  expect(order).toEqual(['title', 'command', 'ask']);

  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  // Chrome DevTools' "Slow 3G": 400 ms round trip, about 50 KB/s each way.
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 400, downloadThroughput: 50_000, uploadThroughput: 50_000 });
  const pressed = Date.now();
  await problem.locator('[data-problem-ask]').click();
  const dialog = page.locator('[data-compose]').first();
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  const openedMs = Date.now() - pressed;
  // To: the thread's own agent, chosen already.
  await expect(dialog.locator(`[data-compose-to="${session}"]`).first()).toBeVisible({ timeout: 15_000 });
  const body = await dialog.locator('[data-compose-text] textarea').first().inputValue();
  expect(body).toContain("**gh isn't signed in to github.com**");
  expect(body).toContain('gh (2.103.0), for github.com');
  expect(body).toContain('What the Inbox tried: `gh api graphql` exited with 4');
  expect(body).toContain('`gh auth status --hostname github.com`');
  expect(body).toContain(`thread id \`${threadId}\``);
  expect(body).toMatch(/ask me once, as a normal question in this thread/);
  // The tool's own line came through, with the home path and the token gone.
  expect(body).toContain('~/.config/gh/hosts.yml');
  expect(body).not.toContain(root);
  expect(body).not.toContain(TOKEN);
  await expect(dialog.getByRole('textbox', { name: 'Thread name' })).toHaveValue("Look into: gh isn't signed in to github.com");

  await dialog.locator('[data-compose-send]').first().click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  // The thread exists, addressed to that agent, and the agent reads the same report.
  let created: { thread_id: string } | undefined;
  for (let i = 0; i < 20 && !created; i++) {
    const list = (await (await page.request.get(`${url}api/inbox/threads`)).json()) as { sections?: { threads: { thread_id: string }[] }[] };
    created = (list.sections ?? []).flatMap((section) => section.threads).find((t) => t.thread_id !== threadId && JSON.stringify(t).includes("Look into: gh isn't signed in to github.com"));
    if (!created) await page.waitForTimeout(500);
  }
  expect(created, 'the new thread').toBeTruthy();
  const read = (await claude!.readThread(created!.thread_id)) as { messages: { body: string; to?: { session?: string } | null }[] };
  expect(read.messages[0]!.to?.session).toBe(session);
  expect(read.messages[0]!.body).not.toContain(TOKEN);
  console.log(`ask-agent: compose open ${openedMs} ms after the press on Slow 3G`);
  await context.close();
});
