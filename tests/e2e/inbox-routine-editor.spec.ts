/**
 * The routine editor saves by itself, proved in a real browser against the
 * compiled binary: `plannotator inbox --background` under a temp
 * PLANNOTATOR_DATA_DIR, with Routines on in its config.json
 * (`inboxScheduledThreads`) and "Start agents" left off, so nothing can run.
 * The spec only creates and edits: it never presses Run once now or Turn on.
 *
 *  - A half-made new routine (a prompt, no name) is never created, and a
 *    reload brings its words back at `#routine=new`.
 *  - Words typed into a saved routine and a reload at once, inside the typing
 *    pause: the write on the way out keeps them, in the Inbox and in the
 *    editor after the reload.
 *  - A new routine being made (its create held back a moment) keeps the
 *    focus and every character typed after its create was sent and while it
 *    gets its id: the editor and its prompt box are the same elements before
 *    and after, the later words go to it as an update, and one routine is made.
 *
 * The Inbox gets a PATH of the system's own tools and the test sandbox: a
 * create checks the routine's agent, which looks `claude` up on PATH (the
 * runner's PATH holds the agent CLI stubs, whose teardown fails a run that
 * calls one), and with Routines on the Inbox writes its start-at-login item,
 * under its own data dir while sandboxed. Build the binary first (see
 * inbox.spec.ts), then `bun run test:e2e:inbox`.
 */

import { expect, test, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { E2E_LAUNCH_OFF, inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));

interface Routine {
  id: string;
  name: string;
  prompt: string;
}

let url = '';

/** The Inbox's own routines, read from it (never the page). (`url` ends in `/`: a `//api/…` path is the page's 404.) */
async function routines(): Promise<Routine[]> {
  const answer = await fetch(new URL('/api/inbox/scheduled', url), { headers: { Accept: 'application/json' } });
  expect(answer.status).toBe(200);
  return ((await answer.json()) as { scheduled: Routine[] }).scheduled;
}

async function savedPrompt(id: string): Promise<string | null> {
  const answer = await fetch(new URL(`/api/inbox/scheduled/${encodeURIComponent(id)}`, url), { headers: { Accept: 'application/json' } });
  return answer.ok ? ((await answer.json()) as { scheduled: Routine }).scheduled.prompt : null;
}

const editor = (page: Page) => page.locator('[data-scheduled-editor]');
const nameBox = (page: Page) => editor(page).locator('input[aria-label="Name"]');
const promptBox = (page: Page) => editor(page).locator('textarea[aria-label="Prompt"]');
const status = (page: Page) => editor(page).locator('[data-scheduled-status]');
const hashOf = (page: Page) => new URL(page.url()).hash;

/** The Routines page, then a new routine's editor from its New button. */
async function openNew(page: Page): Promise<void> {
  await page.goto(`${url}#routines`);
  await page.locator('[data-scheduled-new]').click();
  await expect(editor(page)).toHaveAttribute('data-scheduled-editor', 'new');
  await expect.poll(() => hashOf(page)).toBe('#routine=new');
}

/** Once a new routine is made, the address it took in place of `new`: its id. */
async function madeId(page: Page): Promise<string> {
  await expect.poll(() => hashOf(page)).toMatch(/^#routine=sch_/);
  const id = decodeURIComponent(hashOf(page).slice('#routine='.length));
  await expect(editor(page)).toHaveAttribute('data-scheduled-editor', id);
  return id;
}

/** Errors the page throws, for the test's last check. */
function pageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.skip(process.platform === 'win32', 'Routines are not offered on Windows.');
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-routine-editor-e2e-');
  const home = join(root, 'home');
  const dataDir = join(root, 'data');
  for (const dir of [home, dataDir]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ ...E2E_LAUNCH_OFF, inboxScheduledThreads: true }));
  const env: Record<string, string> = {
    // The system's own tools only: never the agents installed on the machine running the spec, nor the runner's stubs.
    PATH: '/usr/bin:/bin',
    // The test sandbox: no agent CLI is looked up, and the start-at-login item is written under the data dir, run by nothing.
    PLANNOTATOR_TEST_SANDBOX: root,
    HOME: home,
    NO_ANON_PING: '1',
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_INBOX_TAILSCALE: '0',
    PLANNOTATOR_INBOX_PHONES: '0',
    PLANNOTATOR_INBOX_NOTES: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  url = started.stdout.trim();
});

test.afterAll(async () => {
  await removeInboxScratch();
});

test('a half-made new routine survives a reload', async ({ page }) => {
  const errors = pageErrors(page);
  const PROMPT = 'Sort the overnight bug reports by area and flag anything about payments.';
  await openNew(page);
  await promptBox(page).fill(PROMPT);
  // Past the typing pause: with no name there is nothing to save.
  await page.waitForTimeout(1200);
  await expect(status(page)).toHaveAttribute('data-scheduled-status', 'new');
  await expect(editor(page).locator('[data-scheduled-turn-on]')).toBeDisabled();
  await expect(editor(page).locator('[data-scheduled-run-now]')).toHaveCount(0);

  await page.reload();
  await expect(editor(page)).toHaveAttribute('data-scheduled-editor', 'new');
  await expect(promptBox(page)).toHaveValue(PROMPT);
  await expect(nameBox(page)).toHaveValue('');
  await expect(status(page)).toHaveAttribute('data-scheduled-status', 'new');
  expect(hashOf(page)).toBe('#routine=new');
  // Coming back made nothing either.
  await page.waitForTimeout(1200);
  expect((await routines()).filter((r) => r.prompt === PROMPT)).toEqual([]);
  await expect(page.locator('[data-scheduled-row]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('words typed into a saved routine survive a reload inside the typing pause', async ({ page }) => {
  const errors = pageErrors(page);
  const NAME = 'Weekly dependency check';
  const FIRST = 'List the outdated dependencies in the billing service';
  const MORE = ', and open one pull request per major bump.';
  await openNew(page);
  await nameBox(page).fill(NAME);
  await promptBox(page).fill(FIRST);
  const id = await madeId(page);
  await expect(status(page)).toHaveAttribute('data-scheduled-status', 'saved');
  await expect.poll(() => savedPrompt(id)).toBe(FIRST);
  await expect(page.locator(`[data-scheduled-row="${id}"]`)).toHaveCount(1);
  await expect(editor(page).locator('[data-scheduled-run-now]')).toHaveCount(1);

  // More words at the end, then a reload at once: no wait for the pause.
  const box = promptBox(page);
  await box.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(el.value.length, el.value.length));
  await box.pressSequentially(MORE);
  await page.reload();

  // The write on the way out may land just after the reloaded page reads the routine.
  await expect.poll(() => savedPrompt(id)).toBe(FIRST + MORE);
  expect(hashOf(page)).toBe(`#routine=${id}`);
  await expect(editor(page)).toHaveAttribute('data-scheduled-editor', id);
  await expect(promptBox(page)).toHaveValue(FIRST + MORE);
  await expect(nameBox(page)).toHaveValue(NAME);
  expect((await routines()).filter((r) => r.name === NAME)).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('a new routine keeps focus and words while it is being made', async ({ page }) => {
  const errors = pageErrors(page);
  const NAME = 'Morning inbox triage';
  const FIRST = 'Read the new support tickets';
  const MORE = ' and draft a reply to each one that asks about refunds.';
  // The create is held back a moment, so the typing below goes on while it is in flight and while it lands.
  await page.route(
    (u) => u.pathname === '/api/inbox/scheduled',
    async (route) => {
      if (route.request().method() === 'POST') await new Promise((done) => setTimeout(done, 1500));
      await route.continue().catch(() => {});
    },
  );
  await openNew(page);
  const root = await editor(page).elementHandle();
  const box = await promptBox(page).elementHandle();
  const isCreate = (r: { method(): string; url(): string }) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/inbox/scheduled';
  const createSent = page.waitForRequest(isCreate);
  await nameBox(page).fill(NAME);
  await promptBox(page).click();
  await promptBox(page).pressSequentially(FIRST, { delay: 20 });
  // The pause after FIRST sends the create (it has a name and a prompt now); MORE is typed only once it is on its way.
  const create = await createSent;
  expect((create.postDataJSON() as { prompt: string }).prompt).toBe(FIRST);
  await expect(status(page)).toHaveAttribute('data-scheduled-status', 'saving');
  const updateSent = page.waitForRequest((r) => r.method() === 'POST' && /^\/api\/inbox\/scheduled\/sch_[^/]+$/.test(new URL(r.url()).pathname));
  await promptBox(page).pressSequentially(MORE, { delay: 60 });

  const id = await madeId(page);
  // MORE, typed while the create was in flight, goes to the routine it made, as an update.
  const update = await updateSent;
  expect(new URL(update.url()).pathname).toBe(`/api/inbox/scheduled/${id}`);
  await expect(promptBox(page)).toBeFocused();
  await expect(promptBox(page)).toHaveValue(FIRST + MORE);
  // Not remounted when it got its id: the same editor and the same box.
  expect(await root!.evaluate((el) => el.isConnected)).toBe(true);
  expect(await box!.evaluate((el) => el.isConnected && el === document.activeElement)).toBe(true);
  await expect(status(page)).toHaveAttribute('data-scheduled-status', 'saved');
  await expect.poll(() => savedPrompt(id)).toBe(FIRST + MORE);
  expect((await routines()).filter((r) => r.name === NAME).map((r) => r.id)).toEqual([id]);
  await expect(page.locator(`[data-scheduled-row="${id}"]`)).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("a routine's Runs tab is in the address: a reload lands on it, and a switch mid-edit keeps the words", async ({ page }) => {
  const errors = pageErrors(page);
  const routine = (await routines()).find((r) => r.name === 'Weekly dependency check');
  expect(routine, 'made by the test above').toBeTruthy();
  const id = routine!.id;
  const tab = (which: 'edit' | 'runs') => editor(page).locator(`[data-scheduled-tab="${which}"]`);
  const panel = (which: 'edit' | 'runs') => editor(page).locator(`[data-scheduled-panel="${which}"]`);
  await page.goto(`${url}#routine=${encodeURIComponent(id)}`);
  await expect(tab('edit')).toHaveAttribute('aria-selected', 'true', { timeout: 10_000 });

  // Words typed, then Runs at once, inside the typing pause: the words save, and the header says so on Runs.
  const MORE = ' Skip the dev dependencies.';
  // The saved words, and the box showing them before typing: opened by its link, the editor draws (tabs and all)
  // before the routine is read, with the box empty until then.
  const before = (await savedPrompt(id)) ?? '';
  expect(before, 'the routine has a prompt').not.toBe('');
  await expect(promptBox(page)).toHaveValue(before, { timeout: 10_000 });
  await promptBox(page).click();
  await promptBox(page).press('End');
  await promptBox(page).pressSequentially(MORE);
  await tab('runs').click();
  await expect.poll(() => hashOf(page), { timeout: 5_000 }).toBe(`#routine=${id}&runs`);
  await expect(panel('runs')).toBeVisible();
  await expect(panel('edit')).toBeHidden();
  await expect(panel('runs').locator('[data-scheduled-no-runs]')).toBeVisible();
  await expect(status(page)).toHaveAttribute('data-scheduled-status', 'saved', { timeout: 10_000 });
  await expect.poll(() => savedPrompt(id), { timeout: 10_000 }).toBe(before + MORE);

  // A reload (and so a shared link) opens on Runs.
  await page.reload();
  await expect(tab('runs')).toHaveAttribute('aria-selected', 'true', { timeout: 10_000 });
  await expect(panel('runs')).toBeVisible();

  // Back to Edit: the address drops `&runs` in place, and the words are there.
  await tab('edit').click();
  await expect.poll(() => hashOf(page), { timeout: 5_000 }).toBe(`#routine=${id}`);
  await expect(promptBox(page)).toHaveValue(before + MORE);
  expect(errors).toEqual([]);
});
