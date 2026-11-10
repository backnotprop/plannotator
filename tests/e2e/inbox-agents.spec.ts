/**
 * The agents on this computer, proved in a real browser against the compiled
 * binary (the approved "inbox-agent-awareness" design, and
 * "inbox-agent-note-auto": the note is written by itself for the agents
 * proven to load it, Claude Code, Codex, Gemini CLI, Pi and OpenCode, and
 * said once in a quiet line above the list; Qwen Code is still offered in
 * the one-time dialog, Cursor's note is still copied by hand). Fake agent
 * CLIs on a scratch PATH and a scratch HOME (tests/helpers/fake-agents.ts):
 * the real agent CLIs never run and the real home is never touched.
 *
 *  1. An agent starts the Inbox (`--background`): nothing is connected.
 *  2. The person runs `plannotator inbox`: it connects Codex and Gemini CLI,
 *     and the notes are written by then: Codex's AGENTS.md (its blank
 *     AGENTS.override.md is not what Codex reads), Gemini's GEMINI.md above
 *     its memory section, Claude Code's rules file. The window's first load
 *     shows the sound dialog (due) and, never a dialog, the line: "Connected
 *     Codex and Gemini CLI to the Inbox." and "Added the Inbox note to the
 *     instructions of …", each file in its name's tooltip. It is said once:
 *     the next load is clear, and no note dialog ever asks about them.
 *  3. Codex's note goes off in Settings → Agents; a later run never writes it
 *     back, connects Qwen Code (installed since), and the next load's line
 *     says so while the dialog asks about Qwen alone ("Add the note to Qwen
 *     Code?"); Add writes it. A run that connects only Cursor (its rules live
 *     in the app) asks to copy its note by hand; nothing is written.
 *  4. Stress: every proven agent at once, with long and non-Latin paths.
 *
 * Deterministic: no sleeps. A load is "settled" when the window has read the
 * agents twice (its second read decides the line and the dialog), and what the
 * line shows is checked against the Inbox's own model too.
 *
 * PNGs land in /tmp/agent-note-auto-built/ (PLANNOTATOR_AGENT_NOTE_SHOTS),
 * desktop 1280x800 and 375x820, dark and light, at 2x. Build the binary first
 * (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 */
import { markTourDecided } from '../helpers/tour-decided';
import { INBOX_NOTE_START } from '../../packages/server/inbox-agent-notes';
import { expect, test, type Browser, type Page, type Request } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createFakeAgents, type FakeAgents } from '../helpers/fake-agents';
import { E2E_LAUNCH_OFF, inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';
import { savedConfig } from '../helpers/saved-config';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shots = resolve(process.env.PLANNOTATOR_AGENT_NOTE_SHOTS ?? '/tmp/agent-note-auto-built');
const DESKTOP = { width: 1280, height: 800 };
const NARROW = { width: 375, height: 820 };

/** Every animation with an end (a scheme cross-fade, a line coming in) has finished; a spinner's never ends and is skipped. */
async function animationsDone(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await new Promise<void>((done) => requestAnimationFrame(() => done()));
    const ending = document.getAnimations().filter((animation) => Number.isFinite(Number(animation.effect?.getComputedTiming().endTime)));
    await Promise.allSettled(ending.map((animation) => animation.finished));
  });
}

async function shot(page: Page, name: string, sizes: ('desktop' | 'narrow')[] = ['desktop']): Promise<void> {
  mkdirSync(shots, { recursive: true });
  for (const size of sizes) {
    await page.setViewportSize(size === 'desktop' ? DESKTOP : NARROW);
    for (const scheme of ['dark', 'light'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      // The window follows the OS scheme on the next frame.
      await page.waitForFunction((dark) => document.documentElement.classList.contains('light') !== dark, scheme === 'dark', { timeout: 3000 });
      // The scheme change cross-fades: the shot waits for it to end, so it is one scheme.
      await animationsDone(page);
      await page.screenshot({ path: join(shots, `${name}${size === 'narrow' ? '-375' : ''}-${scheme}.png`) });
    }
  }
  await page.setViewportSize(DESKTOP);
  await page.emulateMedia({ colorScheme: 'dark' });
}

function envFor(fake: FakeAgents, root: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...fake.env,
    // The fakes' scratch home, where they set the agents up (spread above; named so the HOME scan sees it).
    HOME: fake.env.HOME,
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
const lineOf = (page: Page) => page.locator('[data-connect-line]');
const lineRows = (page: Page) => lineOf(page).locator('.ib-cline-lines > p');
const config = (root: string) => savedConfig(join(root, 'data'));
const isPath = (path: string, method: string) => (request: Request) => request.method() === method && new URL(request.url()).pathname === path;

/**
 * Load the page and wait until the window has settled what this load shows: it reads the agents at load and once
 * more a moment later (the run that opened it may still be connecting), and the second read decides the connect
 * line and the note dialog. No fixed wait: the two reads' requests are counted.
 */
async function loadSettled(page: Page, load: () => Promise<unknown>): Promise<void> {
  let reads = 0;
  const count = (request: Request) => {
    if (isPath('/api/inbox/agents', 'GET')(request)) reads++;
  };
  page.on('requestfinished', count);
  try {
    await load();
    await expect(page.locator('.ib-main h1').first()).toBeVisible();
    await expect.poll(() => reads, { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
  } finally {
    page.off('requestfinished', count);
  }
  // The read's answer is rendered by the next frames.
  await animationsDone(page);
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
}

/** What the window's line is drawn from: the last run's report (said or not) and the notes written by themselves not said yet. */
async function agentsModel(page: Page): Promise<{ notes_auto?: { agent: string; path: string }[]; last_report: { seen?: boolean } | null }> {
  return page.evaluate(async () => (await fetch('/api/inbox/agents')).json());
}

async function newContext(browser: Browser) {
  return browser.newContext({ viewport: DESKTOP, deviceScaleFactor: 2, colorScheme: 'dark' });
}

test('plannotator inbox connects the agents found and writes their notes by itself; one quiet line says it once, never a dialog; Qwen Code is still asked', async ({ browser }) => {
  test.setTimeout(240_000);
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-inbox-agents-e2e-');
  const fake = createFakeAgents();
  fake.install('codex', 'gemini');
  mkdirSync(join(fake.home, '.codex'), { recursive: true });
  writeFileSync(join(fake.home, '.codex', 'AGENTS.md'), '# My rules\n\nBe brief.\n');
  // A blank override: Codex skips it and reads AGENTS.md, so that is where the note goes.
  writeFileSync(join(fake.home, '.codex', 'AGENTS.override.md'), '  \n');
  // Gemini CLI's memory section ("Save memory" appends under it): the note goes above it.
  mkdirSync(join(fake.home, '.gemini'), { recursive: true });
  writeFileSync(join(fake.home, '.gemini', 'GEMINI.md'), '# Mine\n\n## Gemini Added Memories\n- Likes short answers.\n');
  // Plannotator's Claude Code plugin: Claude Code loads the rules file, so it gets the note like the others.
  mkdirSync(join(fake.home, '.claude'), { recursive: true });
  writeFileSync(join(fake.home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'plannotator@plannotator': true } }));
  // The sound dialog is due (as after an update): it shows on the first load, and the line is no dialog to wait for it.
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(join(root, 'data', 'config.json'), JSON.stringify({ ...E2E_LAUNCH_OFF, inboxSound: { dialogDueFor: '0.0.0-dev' } }));
  // The first-run connect screen, not the tour's entry screen (inbox-tour.spec.ts proves that one).
  markTourDecided(join(root, 'data'));
  const env = envFor(fake, root);
  const run = (args: string[]) => spawnSync(binary, ['inbox', ...args], { env, cwd: root, encoding: 'utf8', timeout: 90_000 });
  const adds = () => fake.calls().filter((c) => c.args[1] === 'add').map((c) => c.name);
  const codexRules = join(fake.home, '.codex', 'AGENTS.md');
  const claudeRules = join(fake.home, '.claude', 'rules', 'plannotator-inbox.md');
  const context = await newContext(browser);
  try {
    const started = run(['--background']);
    expect(started.status, started.stderr).toBe(0);
    const url = started.stdout.trim();
    expect(adds()).toEqual([]);

    const person = run(['--no-open']);
    expect(person.status, person.stderr).toBe(0);
    expect(person.stderr).toContain('Connected Codex and Gemini CLI to the Inbox');
    expect(adds().sort()).toEqual(['codex', 'gemini']);
    // The run answers when its notes are written: nobody was asked.
    expect(readFileSync(codexRules, 'utf8').startsWith(`# My rules\n\nBe brief.\n\n${INBOX_NOTE_START}\n`)).toBe(true);
    expect(readFileSync(join(fake.home, '.codex', 'AGENTS.override.md'), 'utf8')).toBe('  \n');
    const gemini = readFileSync(join(fake.home, '.gemini', 'GEMINI.md'), 'utf8');
    expect(gemini.startsWith(`# Mine\n\n${INBOX_NOTE_START}\n`)).toBe(true);
    expect(gemini.indexOf('## Plannotator Inbox')).toBeLessThan(gemini.indexOf('## Gemini Added Memories'));
    expect(gemini.endsWith('## Gemini Added Memories\n- Likes short answers.\n')).toBe(true);
    expect(readFileSync(claudeRules, 'utf8')).toContain(INBOX_NOTE_START);
    expect([...config(root).inboxAgentNotes.asked].sort()).toEqual(['claude-code', 'codex', 'gemini']);

    const page = await context.newPage();
    const said = page.waitForRequest(isPath('/api/inbox/agents/seen', 'POST'), { timeout: 30_000 });
    await page.goto(url);
    const sound = page.locator('dialog[data-dialog="sound-intro"]');
    await expect(sound).toBeVisible();
    await sound.getByRole('button', { name: 'Keep it on' }).click();
    await expect(sound).toHaveCount(0);

    // The line: what the run connected, then the notes written by themselves; each name's tooltip is its file.
    const line = lineOf(page);
    await expect(line).toBeVisible({ timeout: 20_000 });
    await expect(lineRows(page)).toHaveCount(2);
    await expect(lineRows(page).first()).toHaveText('Connected Codex and Gemini CLI to the Inbox.');
    const notes = line.locator('[data-connect-notes]');
    await expect(notes).toContainText('Added the Inbox note to the instructions of Claude Code, Codex and Gemini CLI');
    const names = notes.locator('[data-note-agent]');
    await expect(names).toHaveText(['Claude Code', 'Codex', 'Gemini CLI']);
    expect(await names.evaluateAll((els) => els.map((el) => el.getAttribute('data-note-path')))).toEqual([
      '~/.claude/rules/plannotator-inbox.md',
      '~/.codex/AGENTS.md',
      '~/.gemini/GEMINI.md',
    ]);
    // Nothing to confirm: Got it is its only button.
    await expect(line.getByRole('button')).toHaveText(['Got it']);
    await shot(page, 'connect-line-01-first-run', ['desktop', 'narrow']);
    await names.nth(1).hover();
    await expect(page.locator('[data-pn-tooltip]')).toContainText('~/.codex/AGENTS.md');
    await shot(page, 'connect-line-02-path-tooltip');

    // Said at once: the Inbox's model has nothing left to say.
    await said;
    await expect
      .poll(async () => {
        const model = await agentsModel(page);
        return { notes: model.notes_auto ?? [], seen: model.last_report?.seen ?? false };
      })
      .toEqual({ notes: [], seen: true });
    expect(config(root).inboxAgentNotes.auto).toBeUndefined();
    // A line, never the note dialog: every agent shown has its note.
    await expect(dialogOf(page)).toHaveCount(0);
    await line.getByRole('button', { name: 'Got it' }).click();
    await expect(line).toHaveCount(0);

    // The next load is clear: no line, no dialog.
    await loadSettled(page, () => page.reload());
    await expect(lineOf(page)).toHaveCount(0);
    await expect(dialogOf(page)).toHaveCount(0);

    // Settings → Agents: the notes are on.
    await page.goto(`${url}#settings/agents`);
    const codex = page.locator('[data-agent="codex"]');
    await expect(codex.getByRole('switch', { name: 'Reaches the Inbox: Codex' })).toHaveAttribute('aria-checked', 'true');
    await expect(codex.getByRole('switch', { name: 'Note in its instructions: Codex' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('[data-agent="gemini"]').getByRole('switch', { name: 'Note in its instructions: Gemini CLI' })).toHaveAttribute('aria-checked', 'true');
    await shot(page, 'connect-line-03-settings-agents');

    // The person turns Codex's note off (the route Settings → Agents uses): it goes, and stays gone.
    const removed = await page.evaluate(async () => {
      const settings = await (await fetch('/api/inbox/settings')).json();
      const answer = await fetch('/api/inbox/agents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serverSession: settings.serverSession, agent: 'codex', note: false }) });
      return answer.status;
    });
    expect(removed).toBe(200);
    expect(readFileSync(codexRules, 'utf8')).toBe('# My rules\n\nBe brief.\n');
    await page.reload();
    await expect(codex.getByRole('switch', { name: 'Note in its instructions: Codex' })).toHaveAttribute('aria-checked', 'false');
    await page.goto(url);

    // A later run connects Qwen Code (installed since). Codex's note is not written back; Qwen's is not written by
    // itself (not proven to load it): the next load's line says the run, and the dialog asks about Qwen alone.
    fake.install('qwen');
    const later = run(['--no-open']);
    expect(later.status, later.stderr).toBe(0);
    expect(later.stderr).toContain('Connected Qwen Code to the Inbox (new on this computer).');
    expect(readFileSync(codexRules, 'utf8')).toBe('# My rules\n\nBe brief.\n');
    const qwenNote = join(fake.home, '.qwen', 'QWEN.md');
    expect(existsSync(qwenNote)).toBe(false);
    await loadSettled(page, () => page.reload());
    await expect(lineRows(page).first()).toHaveText('Connected Qwen Code to the Inbox (new on this computer).');
    await expect(lineOf(page).locator('[data-connect-notes]')).toHaveCount(0);
    const dialog = dialogOf(page);
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await expect(dialog.getByRole('heading', { name: 'Add the note to Qwen Code?' })).toBeVisible();
    await expect(rowsOf(page)).toHaveCount(1);
    await expect(dialog.locator('input[type="checkbox"]')).toHaveCount(0);
    await expect(rowsOf(page).locator('.ib-anote-path')).toHaveText('~/.qwen/QWEN.md');
    await expect(dialog.locator('[data-anote-primary]')).toHaveText('Add to Qwen Code');
    await shot(page, 'connect-line-04-qwen-asked', ['desktop', 'narrow']);
    await dialog.locator('[data-anote-primary]').click();
    await expect(dialog.getByRole('heading', { name: 'Added the note to Qwen Code' })).toBeVisible();
    await expect(rowsOf(page).locator('.ib-anote-st')).toHaveText('Created');
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toHaveCount(0);
    expect(readFileSync(qwenNote, 'utf8')).toContain(INBOX_NOTE_START);
    expect(config(root).inboxAgentNotes.asked).toContain('qwen');
    await loadSettled(page, () => page.reload());
    await expect(lineOf(page)).toHaveCount(0);
    await expect(dialogOf(page)).toHaveCount(0);

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
    await expect(rowsOf(page).locator('.ib-anote-st')).toHaveText('Copy yourself');
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
    await expect(cursorNoteRow).toContainText('Customize → Rules in Cursor · copy yourself');
    await expect(cursorNoteRow.getByRole('switch')).toHaveCount(0);
    await cursorSettings.getByRole('button', { name: 'Show note' }).click();
    await expect(cursorSettings.locator('.ib-agnote')).toContainText("Plannotator can't see, update or remove that copy.");
    await expect(cursorSettings.locator('.ib-agnote pre')).toContainText('## Plannotator Inbox');
    await expect(cursorSettings.locator('.ib-agnote pre')).not.toContainText('plannotator-inbox:start');
  } finally {
    await context.close().catch(() => {});
    await removeInboxScratch(root);
    fake.remove();
  }
});

test('stress: every proven agent at once, long and non-Latin paths: written by itself, one line at 1280 and 375', async ({ browser }) => {
  test.setTimeout(180_000);
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-inbox-agents-stress-');
  const fake = createFakeAgents();
  fake.install('codex', 'gemini', 'pi');
  const codexHome = join(fake.home, 'Library', 'Application Support', 'com.openai.codex', 'profiles', 'work-laptop-2026-q4');
  mkdirSync(codexHome, { recursive: true });
  // An override with text: Codex reads it instead of AGENTS.md, so the note goes there.
  writeFileSync(join(codexHome, 'AGENTS.override.md'), '# Work rules\n');
  mkdirSync(join(fake.home, '.gemini'), { recursive: true });
  const geminiFile = 'instructions-for-every-gemini-session-on-this-machine.md';
  writeFileSync(join(fake.home, '.gemini', 'settings.json'), JSON.stringify({ context: { fileName: geminiFile } }));
  const piDir = join(fake.home, 'ジョン・スミス', '.config', 'pi', 'agent');
  mkdirSync(piDir, { recursive: true });
  const claudeDir = join(fake.home, 'Documents', 'مشاريع', 'وكلاء', '.claude');
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({ enabledPlugins: { 'plannotator@plannotator': true } }));
  const openCodeDir = join(fake.home, '.config', 'opencode');
  mkdirSync(openCodeDir, { recursive: true });
  writeFileSync(join(openCodeDir, 'opencode.json'), JSON.stringify({ plugin: ['@plannotator/opencode'] }));
  // OpenCode's global AGENTS.md exists: it gets the note too.
  writeFileSync(join(openCodeDir, 'AGENTS.md'), '# OpenCode rules\n');
  markTourDecided(join(root, 'data'));
  const env = envFor(fake, root, { CODEX_HOME: codexHome, PI_CODING_AGENT_DIR: piDir, CLAUDE_CONFIG_DIR: claudeDir });
  const run = (args: string[]) => spawnSync(binary, ['inbox', ...args], { env, cwd: root, encoding: 'utf8', timeout: 90_000 });
  const context = await newContext(browser);
  try {
    const started = run(['--background']);
    expect(started.status, started.stderr).toBe(0);
    const person = run(['--no-open']);
    expect(person.status, person.stderr).toBe(0);
    expect(readFileSync(join(codexHome, 'AGENTS.override.md'), 'utf8').startsWith(`# Work rules\n\n${INBOX_NOTE_START}\n`)).toBe(true);
    expect(existsSync(join(codexHome, 'AGENTS.md'))).toBe(false);
    expect(readFileSync(join(fake.home, '.gemini', geminiFile), 'utf8')).toContain(INBOX_NOTE_START);
    expect(readFileSync(join(piDir, 'AGENTS.md'), 'utf8')).toContain(INBOX_NOTE_START);
    expect(readFileSync(join(openCodeDir, 'AGENTS.md'), 'utf8').startsWith(`# OpenCode rules\n\n${INBOX_NOTE_START}\n`)).toBe(true);
    expect(readFileSync(join(claudeDir, 'rules', 'plannotator-inbox.md'), 'utf8')).toContain(INBOX_NOTE_START);

    const page = await context.newPage();
    await loadSettled(page, () => page.goto(started.stdout.trim()));
    const line = lineOf(page);
    await expect(line).toBeVisible();
    // The order follows when each was written (some at the start, some after the run): the set is what matters.
    const paths = Object.fromEntries(
      await line.locator('[data-note-agent]').evaluateAll((els) => els.map((el) => [el.getAttribute('data-note-agent'), el.getAttribute('data-note-path')])),
    );
    expect(paths).toEqual({
      'claude-code': '~/Documents/مشاريع/وكلاء/.claude/rules/plannotator-inbox.md',
      codex: '~/Library/Application Support/com.openai.codex/profiles/work-laptop-2026-q4/AGENTS.override.md',
      gemini: `~/.gemini/${geminiFile}`,
      pi: '~/ジョン・スミス/.config/pi/agent/AGENTS.md',
      opencode: '~/.config/opencode/AGENTS.md',
    });
    // Never a dialog for them.
    await expect(dialogOf(page)).toHaveCount(0);
    // The paths live in tooltips: the line stays one quiet line, its button in view, at both widths. With no thread
    // yet this is the first-run screen, where the line is in the ask slot under Try it (inbox-foundation.md), below
    // five agents' Done list and the Left to do list: the screen scrolls to the line's top first, so what is proved
    // is that nothing pushes Got it out of the line or the window sideways.
    const gotIt = line.getByRole('button', { name: 'Got it' });
    const lineFits = async (width: number) => {
      await line.evaluate((el) => el.scrollIntoView({ block: 'start', inline: 'nearest' }));
      await expect(gotIt).toBeInViewport();
      const box = (await line.boundingBox())!;
      const button = (await gotIt.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(button.x).toBeGreaterThanOrEqual(box.x);
      expect(button.x + button.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
    };
    await lineFits(DESKTOP.width);
    await page.setViewportSize(NARROW);
    await lineFits(NARROW.width);
    await page.setViewportSize(DESKTOP);
    await shot(page, 'connect-line-05-stress', ['desktop', 'narrow']);
  } finally {
    await context.close().catch(() => {});
    await removeInboxScratch(root);
    fake.remove();
  }
});
