/**
 * #1001: one Ask AI chat for the whole session, against the compiled binary
 * and real files; only the AI transport is intercepted.
 *
 * - Annotate: switching files keeps the chat and its session. A question on a
 *   new file carries one short note naming that file's absolute path (and the
 *   one viewed before), never the document's text; a second question on the
 *   same file carries nothing; a busy question retried after a switch keeps
 *   the document it was asked about.
 * - Plan review: a revision keeps the chat; the next question names the new
 *   version's history file instead of pasting the revised plan.
 */
import { expect, test, type Page, type Route } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? '.local/plannotator');

type Query = { sessionId: string; prompt: string; draftAnnotations?: string; contextUpdate?: string };

const SEEN_COOKIES = [
  ['plannotator-plan-look-choice-resolved', 'true'],
  ['plannotator-announce-tui-herdr-seen', '1'],
  ['plannotator-announce-inbox-seen', '1'],
  ['plannotator-announce-ask-session-seen', '1'],
  ['plannotator-announce-agent-tool-seen', '1'],
  ['plannotator-look-feel-announcement-seen', '2'],
  ['plannotator-vim-mode-announcement-seen', '2'],
  ['plannotator-plan-ai-announcement-seen', '1'],
  ['plannotator-permission-mode-configured', 'true'],
];

function childEnv(root: string, ready: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '', HOME: root,
    PLANNOTATOR_DATA_DIR: join(root, 'data'), PLANNOTATOR_READY_FILE: ready,
    PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER,
    PLANNOTATOR_SKIP_BROWSER_OPEN: '1', PLANNOTATOR_REMOTE: '0', PLANNOTATOR_INBOX_CONNECT: '0',
  };
}

async function readyUrl(ready: string): Promise<string> {
  await expect.poll(() => existsSync(ready) ? readFileSync(ready, 'utf8') : '', { timeout: 20_000 }).toContain('"url"');
  return JSON.parse(readFileSync(ready, 'utf8').trim().split('\n')[0]!).url;
}

/** Fakes /api/ai/*: `busyFirst` answers the first query with agent_busy. */
async function fakeAI(page: Page, options: { bridge: boolean; busyFirst: boolean }) {
  let sessions = 0;
  const sessionBodies: unknown[] = [];
  const queries: Query[] = [];
  await page.route('**/api/ai/**', async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/capabilities')) {
      await route.fulfill({ json: { available: true, defaultProvider: 'test', providers: [{ id: 'test', name: options.bridge ? 'session-bridge' : 'test', capabilities: {}, models: [{ id: 'one', label: 'One' }] }] } });
    } else if (path.endsWith('/session')) {
      sessions += 1;
      sessionBodies.push(route.request().postDataJSON());
      await route.fulfill({ json: { sessionId: `s-${sessions}` } });
    } else if (path.endsWith('/query')) {
      queries.push(route.request().postDataJSON());
      const text = `Answer ${queries.length}`;
      const busy = options.busyFirst && queries.length === 1;
      const event = busy
        ? { type: 'error', error: 'The session is busy.', code: 'agent_busy' }
        : { type: 'text_delta', delta: text };
      const tail = busy ? 'data: [DONE]\n\n' : `data: ${JSON.stringify({ type: 'result', result: text })}\n\n`;
      await route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify(event)}\n\n${tail}` });
    } else {
      await route.fulfill({ json: {} });
    }
  });
  return { queries, sessionBodies, sessions: () => sessions };
}

async function openChat(page: Page) {
  const show = page.getByRole('button', { name: 'Show AI chat', exact: true });
  if (await show.isVisible()) await show.click();
}

async function ask(page: Page, question: string, answer: string) {
  await page.getByPlaceholder('Ask about this document...').fill(question);
  await page.getByRole('button', { name: 'Send AI question' }).click();
  await expect(page.getByText(answer, { exact: true })).toBeVisible();
}

async function stop(child: ChildProcess, url: string | undefined, root: string) {
  if (url) await fetch(new URL('/api/exit', url), { method: 'POST' }).catch(() => {});
  if (child.exitCode === null && child.signalCode === null) {
    // inbox-guard: own child (only the CLI spawned by this test).
    const exited = new Promise<void>(done => child.once('exit', () => done()));
    child.kill('SIGTERM');
    await exited;
  }
  await removeInboxScratch(root);
}

test('Ask AI keeps the chat across files and names each file by path', async ({ page }) => {
  page.setDefaultTimeout(15_000);
  expect(existsSync(binary), 'build the scratch binary first').toBe(true);
  const root = inboxScratch('plannotator-annotate-ai-e2e-');
  const docs = join(root, 'docs');
  mkdirSync(docs);
  writeFileSync(join(docs, 'alpha.md'), '# Alpha\n\nAlpha content.\n');
  writeFileSync(join(docs, 'beta.md'), '# Beta\n\nBeta content.\n');
  const ready = join(root, 'ready.jsonl');
  const child = spawn(binary, ['annotate', docs], { cwd: root, stdio: 'ignore', env: childEnv(root, ready) });
  let url: string | undefined;
  try {
    url = await readyUrl(ready);
    await page.context().addCookies(SEEN_COOKIES.map(([name, value]) => ({ name: name!, value: value!, url: url! })));
    const ai = await fakeAI(page, { bridge: true, busyFirst: true });
    await page.goto(url);
    await page.getByRole('button', { name: 'alpha', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Alpha', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Global comment', exact: true }).click();
    const composer = page.locator('[data-comment-popover]');
    await composer.getByPlaceholder('Add a global comment...').fill('Keep this draft separate');
    await composer.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByRole('button', { name: 'Show AI chat', exact: true }).click();
    await page.getByPlaceholder('Ask about this document...').fill('Question on alpha');
    await page.getByRole('button', { name: 'Send AI question' }).click();
    await expect(page.getByRole('button', { name: 'Ask when it finishes' })).toBeVisible();

    await page.getByRole('button', { name: 'beta', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Beta', exact: true })).toBeVisible();
    await openChat(page);
    await expect(page.getByText('Question on alpha', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Ask when it finishes' }).click();
    await expect(page.getByText('Answer 2', { exact: true })).toBeVisible();

    const [first, retried] = ai.queries;
    // The first question creates the session from the file on screen, so it
    // carries no note; the retry after the switch is the same question.
    expect(first!.prompt).toBe('Question on alpha');
    expect(retried!.prompt).toBe(first!.prompt);
    expect(first!.draftAnnotations).toContain('Keep this draft separate');
    expect(retried!.sessionId).toBe('s-1');

    await ask(page, 'Question on beta', 'Answer 3');
    const onBeta = ai.queries[2]!;
    expect(onBeta.sessionId).toBe('s-1');
    expect(onBeta.prompt).toMatch(/now looking at \/\S*\/docs\/beta\.md\./);
    expect(onBeta.prompt).toMatch(/Viewed earlier in this chat, most recent first: \/\S*\/docs\/alpha\.md\./);
    // Local files are named, never pasted, and drafts never ride the prompt.
    expect(onBeta.prompt).not.toContain('Beta content');
    expect(onBeta.prompt).not.toContain('Alpha content');
    expect(onBeta.prompt).not.toContain('Keep this draft separate');
    expect(onBeta.prompt.endsWith('Question on beta')).toBe(true);

    await ask(page, 'Again on beta', 'Answer 4');
    expect(ai.queries[3]!.prompt).toBe('Again on beta');
    expect(ai.sessions()).toBe(1);
    await expect(page.getByText('Question on alpha', { exact: true })).toHaveCount(1);
  } finally {
    await stop(child, url, root);
  }
});

test('Ask AI keeps the chat across a plan revision and names the new version file', async ({ page }) => {
  page.setDefaultTimeout(15_000);
  expect(existsSync(binary), 'build the scratch binary first').toBe(true);
  const root = inboxScratch('plannotator-plan-ai-e2e-');
  const launch = join(root, 'data', 'claude-code-mod', 'session-1', 'launch-1');
  mkdirSync(launch, { recursive: true });
  const ready = join(launch, 'ready');
  const revision = join(launch, 'revision.json');
  const v1 = '# Rollout plan\n\nFirst draft sentinel alpha.\n';
  const v2 = '# Rollout plan\n\nRevised sentinel bravo.\n';
  const child = spawn(binary, ['claude-mod-plan'], {
    cwd: root,
    stdio: ['pipe', 'ignore', 'ignore'],
    env: { ...childEnv(root, ready), PLANNOTATOR_HOST_RESULT_FILE: join(launch, 'result.json') },
  });
  child.stdin!.end(JSON.stringify({ plan: v1, revisionFile: revision }));
  let url: string | undefined;
  try {
    url = await readyUrl(ready);
    await page.context().addCookies(SEEN_COOKIES.map(([name, value]) => ({ name: name!, value: value!, url: url! })));
    const ai = await fakeAI(page, { bridge: false, busyFirst: false });
    await page.goto(url);
    await expect(page.getByRole('article').getByText('First draft sentinel alpha.')).toBeVisible();
    await page.getByRole('button', { name: 'Show AI chat', exact: true }).click();
    await ask(page, 'Question on v1', 'Answer 1');
    expect(ai.queries[0]!.prompt).toBe('Question on v1');
    // The session itself is made from the plan on screen (unchanged behavior).
    expect(JSON.stringify(ai.sessionBodies[0])).toContain('First draft sentinel alpha.');

    writeFileSync(revision, JSON.stringify({ seq: 1, plan: v2 }));
    await expect(page.getByRole('article').getByText('Revised sentinel bravo.')).toBeVisible({ timeout: 20_000 });
    await openChat(page);
    await expect(page.getByText('Question on v1', { exact: true })).toBeVisible();

    await ask(page, 'Question on v2', 'Answer 2');
    const onV2 = ai.queries[1]!;
    expect(onV2.sessionId).toBe('s-1');
    expect(onV2.prompt).toMatch(/The plan was revised to version 2: \/\S*002\.md\./);
    expect(onV2.prompt).toMatch(/\/\S*001\.md \(plan version 1\)/);
    expect(onV2.prompt).not.toContain('Revised sentinel bravo.');
    const path = onV2.prompt.match(/version 2: (\/\S*002\.md)\./)![1]!;
    expect(readFileSync(path, 'utf8')).toBe(v2);

    await ask(page, 'Again on v2', 'Answer 3');
    expect(ai.queries[2]!.prompt).toBe('Again on v2');
    expect(ai.sessions()).toBe(1);
  } finally {
    await stop(child, url, root);
  }
});
