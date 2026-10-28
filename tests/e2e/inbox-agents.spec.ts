/**
 * The agents on this computer, proved in a real browser against the compiled
 * binary (the approved "inbox-agent-awareness" design, and
 * "inbox-agent-note-dialog": the note is asked once per agent, in a one-time
 * dialog). Fake agent CLIs on a scratch PATH and a scratch HOME
 * (tests/helpers/fake-agents.ts): the real agent CLIs never run and the real
 * home is never touched.
 *
 *  1. An agent starts the Inbox (`--background`): nothing is connected.
 *  2. The person runs `plannotator inbox`: it connects Codex and Gemini CLI.
 *     The window's first load shows the sound dialog (due), and never the note
 *     dialog on the same load. The next load opens the note dialog: the
 *     "Connected …" band, Codex, Gemini CLI and Claude Code all ticked with
 *     their exact files; Add writes the ticked notes and shows the results in
 *     the same rows. Every agent shown is answered: no dialog again.
 *  3. Gemini's switch goes off in Settings → Agents; a later run never adds
 *     it back, connects Pi and Amp (installed since), and the next load asks
 *     about Pi alone ("Add the note to Pi?"); Not now writes nothing and Pi is
 *     not asked again. A run that connects only Cursor (its rules live in the app)
 *     asks to copy its note by hand; nothing is written.
 *  4. Stress: every note agent at once, with long and non-Latin paths.
 *
 * PNGs land in /tmp/agent-note-dialog-built/ (PLANNOTATOR_AGENT_NOTE_SHOTS),
 * desktop 1280x800 and 375x820, dark and light, at 2x. Build the binary first
 * (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 */
import { markTourDecided } from '../helpers/tour-decided';
import { INBOX_NOTE_START } from '../../packages/server/inbox-agent-notes';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createFakeAgents, type FakeAgents } from '../helpers/fake-agents';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shots = resolve(process.env.PLANNOTATOR_AGENT_NOTE_SHOTS ?? '/tmp/agent-note-dialog-built');
const DESKTOP = { width: 1280, height: 800 };
const NARROW = { width: 375, height: 820 };

async function shot(page: Page, name: string, sizes: ('desktop' | 'narrow')[] = ['desktop']): Promise<void> {
  mkdirSync(shots, { recursive: true });
  for (const size of sizes) {
    await page.setViewportSize(size === 'desktop' ? DESKTOP : NARROW);
    for (const scheme of ['dark', 'light'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      // The window follows the OS scheme on the next frame.
      await page.waitForFunction((dark) => document.documentElement.classList.contains('light') !== dark, scheme === 'dark', { timeout: 3000 });
      // The scheme change cross-fades; wait it out so the shot is one scheme.
      await page.waitForTimeout(900);
      await page.screenshot({ path: join(shots, `${name}${size === 'narrow' ? '-375' : ''}-${scheme}.png`) });
    }
  }
  await page.setViewportSize(DESKTOP);
  await page.emulateMedia({ colorScheme: 'dark' });
}

function envFor(fake: FakeAgents, root: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...fake.env,
    PLANNOTATOR_DATA_DIR: join(root, 'data'),
    PLANNOTATOR_BROWSER: NO_BROWSER,
    PLANNOTATOR_SKIP_BROWSER_OPEN: '1',
    PLANNOTATOR_INBOX_CONNECT: '1',
    PLANNOTATOR_INBOX_PHONES: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
    PLANNOTATOR_UPDATE_API_URL: 'http://127.0.0.1:9/releases/latest',
    PLANNOTATOR_FEEDBACK_URL: 'http://127.0.0.1:9/feedback',
    PLANNOTATOR_INSTALL_SCRIPT_URL: 'http://127.0.0.1:9/install.sh',
    ...extra,
  };
}

const dialogOf = (page: Page) => page.locator('dialog[data-dialog="agent-note"]');
const rowsOf = (page: Page) => dialogOf(page).locator('.ib-anote-table > li');
const config = (root: string) => JSON.parse(readFileSync(join(root, 'data', 'config.json'), 'utf8'));

/** No note dialog on this load: the page has loaded the list and settled its one-time dialogs. */
async function expectNoDialog(page: Page): Promise<void> {
  await expect(page.locator('.ib-main h1').first()).toBeVisible();
  // The window reads the agents again 2.5 s after load before it decides.
  await page.waitForTimeout(4000);
  await expect(dialogOf(page)).toHaveCount(0);
}

async function newContext(browser: Browser) {
  return browser.newContext({ viewport: DESKTOP, deviceScaleFactor: 2, colorScheme: 'dark' });
}

test('plannotator inbox connects the agents found; the note is asked once per agent in a dialog, after the sound dialog', async ({ browser }) => {
  test.setTimeout(240_000);
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-inbox-agents-e2e-');
  const fake = createFakeAgents();
  fake.install('codex', 'gemini');
  mkdirSync(join(fake.home, '.codex'), { recursive: true });
  writeFileSync(join(fake.home, '.codex', 'AGENTS.md'), '# My rules\n\nBe brief.\n');
  // Plannotator's Claude Code plugin: Claude Code is offered and ticked like every other agent.
  mkdirSync(join(fake.home, '.claude'), { recursive: true });
  writeFileSync(join(fake.home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'plannotator@plannotator': true } }));
  // The sound dialog is due (as after an update): it shows first, and the note dialog waits for another load.
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(join(root, 'data', 'config.json'), JSON.stringify({ inboxSound: { dialogDueFor: '0.0.0-dev' } }));
  // The first-run connect screen, not the tour's entry screen (inbox-tour.spec.ts proves that one).
  markTourDecided(join(root, 'data'));
  const env = envFor(fake, root);
  const run = (args: string[]) => spawnSync(binary, ['inbox', ...args], { env, cwd: root, encoding: 'utf8', timeout: 90_000 });
  const adds = () => fake.calls().filter((c) => c.args[1] === 'add').map((c) => c.name);
  const context = await newContext(browser);
  try {
    const started = run(['--background']);
    expect(started.status, started.stderr).toBe(0);
    const url = started.stdout.trim();
    expect(fake.calls()).toEqual([]);

    const person = run(['--no-open']);
    expect(person.status, person.stderr).toBe(0);
    expect(person.stderr).toContain('Connected Codex and Gemini CLI to the Inbox');
    expect(adds().sort()).toEqual(['codex', 'gemini']);

    const page = await context.newPage();
    await page.goto(url);
    const sound = page.locator('dialog[data-dialog="sound-intro"]');
    await expect(sound).toBeVisible();
    await sound.getByRole('button', { name: 'Keep it on' }).click();
    await expect(sound).toHaveCount(0);
    // Never two one-time dialogs on one load.
    await expectNoDialog(page);

    await page.reload();
    const dialog = dialogOf(page);
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await expect(dialog.locator('[data-anote-band] p')).toHaveText(['Connected Codex and Gemini CLI to the Inbox.']);
    await expect(dialog.getByRole('heading', { name: 'Tell your agents about the Inbox' })).toBeVisible();
    await expect(rowsOf(page)).toHaveCount(3);
    await expect(rowsOf(page).locator('.ib-anote-name')).toHaveText(['Codex', 'Gemini CLI', 'Claude Code']);
    await expect(rowsOf(page).locator('.ib-anote-path')).toHaveText(['~/.codex/AGENTS.md', '~/.gemini/GEMINI.md', '~/.claude/rules/plannotator-inbox.md']);
    await expect(rowsOf(page).locator('.ib-anote-pill')).toHaveText(['Adds to end', 'New file', 'New file']);
    for (const box of await rowsOf(page).locator('input[type="checkbox"]').all()) await expect(box).toBeChecked();
    const primary = dialog.locator('[data-anote-primary]');
    await expect(primary).toHaveText('Add to Codex, Gemini CLI and Claude Code');
    await expect(primary).toBeFocused();
    await shot(page, 'checklist-01-several', ['desktop', 'narrow']);
    await dialog.getByRole('button', { name: 'Show the note' }).click();
    await expect(dialog.locator('.ib-anote-note pre')).toContainText(INBOX_NOTE_START);
    await shot(page, 'checklist-05-show-note');
    await dialog.getByRole('button', { name: 'Hide the note' }).click();

    // Untick Claude Code: the primary follows; nothing ticked reads "Don't add a note" without Not now.
    await rowsOf(page).nth(2).locator('input').uncheck();
    await expect(primary).toHaveText('Add to Codex and Gemini CLI');
    await rowsOf(page).nth(0).locator('input').uncheck();
    await rowsOf(page).nth(1).locator('input').uncheck();
    await expect(primary).toHaveText("Don't add a note");
    await expect(dialog.locator('[data-anote-notnow]')).toHaveCount(0);
    await shot(page, 'checklist-06-nothing-ticked');
    await rowsOf(page).nth(0).locator('input').check();
    await rowsOf(page).nth(1).locator('input').check();

    // Gemini's folder cannot be written (a permission a root runner would ignore): its row says why, with Try again.
    const failGemini = process.getuid?.() !== 0;
    if (failGemini) chmodSync(join(fake.home, '.gemini'), 0o555);
    await primary.click();
    if (failGemini) {
      await expect(dialog.getByRole('heading', { name: 'Added the note to Codex' })).toBeVisible();
      await expect(rowsOf(page).locator('.ib-anote-st')).toHaveText(['Added', 'Not added']);
      await expect(rowsOf(page).nth(1).locator('.ib-anote-err')).toContainText('Try again');
      await expect(dialog.locator('[data-anote-band]')).toHaveCount(0);
      await expect(dialog.getByRole('button', { name: 'Done' })).toBeFocused();
      await shot(page, 'checklist-08-error', ['desktop', 'narrow']);
      chmodSync(join(fake.home, '.gemini'), 0o755);
      await rowsOf(page).nth(1).getByRole('button', { name: 'Try again' }).click();
    }
    await expect(dialog.getByRole('heading', { name: 'Added the note to Codex and Gemini CLI' })).toBeVisible();
    await expect(rowsOf(page).locator('.ib-anote-st')).toHaveText(['Added', 'Created']);
    // The results view: the band is gone and Done has the focus.
    await expect(dialog.locator('[data-anote-band]')).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Done' })).toBeFocused();
    await shot(page, 'checklist-07-added', ['desktop', 'narrow']);
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toHaveCount(0);
    expect(readFileSync(join(fake.home, '.codex', 'AGENTS.md'), 'utf8').startsWith(`# My rules\n\nBe brief.\n\n${INBOX_NOTE_START}\n`)).toBe(true);
    expect(readFileSync(join(fake.home, '.gemini', 'GEMINI.md'), 'utf8')).toContain('## Plannotator Inbox');
    // Claude Code was unticked: no file, and it is answered (asked once).
    expect(existsSync(join(fake.home, '.claude', 'rules', 'plannotator-inbox.md'))).toBe(false);
    expect(config(root).inboxAgentNotes).toEqual({ offered: true, asked: ['claude-code', 'codex', 'gemini'] });
    await shot(page, 'list-after-dialog');

    // Every agent shown was answered: no dialog on the next load.
    await page.reload();
    await expectNoDialog(page);

    // Removing Codex's note in Settings → Agents never brings the question back: the person said yes once.
    const removed = await page.evaluate(async () => {
      const settings = await (await fetch('/api/inbox/settings')).json();
      const answer = await fetch('/api/inbox/agents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serverSession: settings.serverSession, agent: 'codex', note: false }) });
      return answer.status;
    });
    expect(removed).toBe(200);
    expect(readFileSync(join(fake.home, '.codex', 'AGENTS.md'), 'utf8')).toBe('# My rules\n\nBe brief.\n');
    await page.reload();
    await expectNoDialog(page);
    expect(config(root).inboxAgentNotes.asked).toEqual(['claude-code', 'codex', 'gemini']);

    // The person turns Gemini off (the same route Settings → Agents uses): its entry goes, and stays gone.
    const off = await page.evaluate(async () => {
      const settings = await (await fetch('/api/inbox/settings')).json();
      const answer = await fetch('/api/inbox/agents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serverSession: settings.serverSession, agent: 'gemini', reach: false }) });
      return answer.status;
    });
    expect(off).toBe(200);
    expect(JSON.parse(readFileSync(join(fake.home, '.gemini', 'settings.json'), 'utf8')).mcpServers).toEqual({});

    // Settings → Agents: Codex connected, its note off (removed above), Gemini off (never re-added).
    await page.goto(`${url}#settings/agents`);
    const codex = page.locator('[data-agent="codex"]');
    await expect(codex.getByRole('switch', { name: 'Reaches the Inbox: Codex' })).toHaveAttribute('aria-checked', 'true');
    await expect(codex.getByRole('switch', { name: 'Note in its instructions: Codex' })).toHaveAttribute('aria-checked', 'false');
    await expect(page.locator('[data-agent="gemini"]').getByRole('switch', { name: 'Reaches the Inbox: Gemini CLI' })).toHaveAttribute('aria-checked', 'false');
    await page.goto(url);

    // A later run connects Pi and Amp (installed since): the next load asks about Pi alone.
    fake.install('pi', 'amp');
    const later = run(['--no-open']);
    expect(later.status, later.stderr).toBe(0);
    expect(later.stderr).toContain('to the Inbox (new on this computer).');
    expect(adds().sort()).toEqual(['amp', 'codex', 'gemini', 'pi']);
    await page.reload();
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await expect(dialog.getByRole('heading', { name: 'Add the note to Pi?' })).toBeVisible();
    await expect(dialog.locator('[data-anote-band] p').first()).toContainText('(new on this computer).');
    await expect(rowsOf(page)).toHaveCount(1);
    await expect(dialog.locator('input[type="checkbox"]')).toHaveCount(0);
    await expect(rowsOf(page).locator('.ib-anote-path')).toHaveText('~/.pi/agent/AGENTS.md');
    await expect(dialog.locator('[data-anote-primary]')).toHaveText('Add to Pi');
    await shot(page, 'checklist-02-later-one-agent', ['desktop', 'narrow']);
    await dialog.getByRole('button', { name: 'Not now' }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => config(root).inboxAgentNotes.asked).toEqual(['claude-code', 'codex', 'gemini', 'pi']);
    expect(existsSync(join(fake.home, '.pi', 'agent', 'AGENTS.md'))).toBe(false);
    await page.reload();
    await expectNoDialog(page);

    // Cursor keeps its rules in the app (Customize → Rules): its note is offered to copy by hand, never written or reported added.
    mkdirSync(join(fake.home, '.cursor'), { recursive: true });
    const cursor = run(['--no-open']);
    expect(cursor.status, cursor.stderr).toBe(0);
    expect(cursor.stderr).toContain('Connected Cursor to the Inbox (new on this computer).');
    await page.reload();
    const cursorDialog = dialogOf(page);
    await expect(cursorDialog).toBeVisible({ timeout: 15_000 });
    await expect(cursorDialog.getByRole('heading', { name: 'Copy the note into Cursor?' })).toBeVisible();
    await expect(rowsOf(page).locator('.ib-anote-path')).toHaveCount(0);
    await expect(cursorDialog.locator('[data-anote-primary]')).toHaveText('Show the note to copy');
    await cursorDialog.locator('[data-anote-primary]').click();
    await expect(cursorDialog.getByRole('heading', { name: 'Copy the note into Cursor', exact: true })).toBeVisible();
    await expect(rowsOf(page).locator('.ib-anote-st')).toHaveText('Copy by hand');
    await expect(cursorDialog.locator('.ib-anote-doneline')).toContainText("Plannotator can't see, update or remove that copy.");
    await expect(cursorDialog.locator('.ib-anote-note pre')).toContainText('## Plannotator Inbox');
    await expect(cursorDialog.locator('.ib-anote-note pre')).not.toContainText('plannotator-inbox:start');
    expect(existsSync(join(fake.home, '.cursor', 'rules'))).toBe(false);
    const noteRecords = JSON.parse(readFileSync(join(root, 'data', 'inbox', 'agent-notes.json'), 'utf8')) as { notes: Record<string, unknown> };
    expect(noteRecords.notes).not.toHaveProperty('cursor');
    expect(config(root).inboxAgentNotes.asked).toContain('cursor');
    await cursorDialog.getByRole('button', { name: 'Done' }).click();
    await expect(cursorDialog).toHaveCount(0);
    await page.goto(`${url}#settings/agents`);
    const cursorSettings = page.locator('[data-agent="cursor"]');
    const cursorNoteRow = cursorSettings.locator('.ib-agrow').filter({ hasText: 'Note in its instructions' });
    await expect(cursorNoteRow).toContainText('Customize → Rules in Cursor · copy by hand');
    await expect(cursorNoteRow.getByRole('switch')).toHaveCount(0);
    await cursorSettings.getByRole('button', { name: 'Show note' }).click();
    await expect(cursorSettings.locator('.ib-agnote')).toContainText("Plannotator can't see, update or remove that copy.");
    await expect(cursorSettings.locator('.ib-agnote pre')).toContainText('## Plannotator Inbox');
    await expect(cursorSettings.locator('.ib-agnote pre')).not.toContainText('plannotator-inbox:start');
  } finally {
    await context.close().catch(() => {});
    await removeInboxScratch(root);
    // A failure halfway must not leave a folder the cleanup cannot empty.
    try {
      chmodSync(join(fake.home, '.gemini'), 0o755);
    } catch {}
    fake.remove();
  }
});

test('stress: every note agent at once, long and non-Latin paths, at 1280 and 375', async ({ browser }) => {
  test.setTimeout(180_000);
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-inbox-agents-stress-');
  const fake = createFakeAgents();
  fake.install('codex', 'gemini', 'pi');
  const codexHome = join(fake.home, 'Library', 'Application Support', 'com.openai.codex', 'profiles', 'work-laptop-2026-q4');
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, 'AGENTS.override.md'), '# Work rules\n');
  mkdirSync(join(fake.home, '.gemini'), { recursive: true });
  writeFileSync(join(fake.home, '.gemini', 'settings.json'), JSON.stringify({ context: { fileName: 'instructions-for-every-gemini-session-on-this-machine.md' } }));
  const piDir = join(fake.home, 'ジョン・スミス', '.config', 'pi', 'agent');
  mkdirSync(piDir, { recursive: true });
  const claudeDir = join(fake.home, 'Documents', 'مشاريع', 'وكلاء', '.claude');
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({ enabledPlugins: { 'plannotator@plannotator': true } }));
  const openCodeDir = join(fake.home, '.config', 'opencode');
  mkdirSync(openCodeDir, { recursive: true });
  writeFileSync(join(openCodeDir, 'opencode.json'), JSON.stringify({ plugin: ['@plannotator/opencode'] }));
  writeFileSync(join(openCodeDir, 'AGENTS.md'), '# OpenCode rules\n');
  const env = envFor(fake, root, { CODEX_HOME: codexHome, PI_CODING_AGENT_DIR: piDir, CLAUDE_CONFIG_DIR: claudeDir });
  const run = (args: string[]) => spawnSync(binary, ['inbox', ...args], { env, cwd: root, encoding: 'utf8', timeout: 90_000 });
  const context = await newContext(browser);
  try {
    const started = run(['--background']);
    expect(started.status, started.stderr).toBe(0);
    const person = run(['--no-open']);
    expect(person.status, person.stderr).toBe(0);
    const page = await context.newPage();
    await page.goto(started.stdout.trim());
    const dialog = dialogOf(page);
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await expect(rowsOf(page).locator('.ib-anote-name')).toHaveText(['Codex', 'Gemini CLI', 'Pi', 'OpenCode', 'Claude Code']);
    await expect(dialog.locator('[data-anote-primary]')).toHaveText('Add to 5 agents');
    // The whole path is in the DOM (and the title), however it is cut on screen.
    await expect(rowsOf(page).nth(0).locator('.ib-anote-path')).toHaveText('~/Library/Application Support/com.openai.codex/profiles/work-laptop-2026-q4/AGENTS.override.md');
    await expect(rowsOf(page).nth(4).locator('.ib-anote-path')).toHaveText('~/Documents/مشاريع/وكلاء/.claude/rules/plannotator-inbox.md');
    // The footer stays in view however long the list.
    await page.setViewportSize({ width: 1280, height: 560 });
    await expect(dialog.locator('[data-anote-primary]')).toBeInViewport();
    await page.setViewportSize(NARROW);
    await expect(dialog.locator('[data-anote-primary]')).toBeInViewport();
    await shot(page, 'checklist-04-stress', ['desktop', 'narrow']);
    await dialog.getByRole('button', { name: 'Not now' }).click();
    await expect(dialog).toHaveCount(0);
    expect(readFileSync(join(codexHome, 'AGENTS.override.md'), 'utf8')).toBe('# Work rules\n');
  } finally {
    await context.close().catch(() => {});
    await removeInboxScratch(root);
    fake.remove();
  }
});
