/**
 * The agents on this computer, proved in a real browser against the compiled
 * binary (the approved "inbox-agent-awareness" design). Fake agent CLIs on a
 * scratch PATH and a scratch HOME (tests/helpers/fake-agents.ts): the real
 * agent CLIs never run and the real home is never touched.
 *
 *  1. An agent starts the Inbox (`--background`): nothing is connected.
 *  2. The person runs `plannotator inbox`: it connects Codex and Gemini CLI
 *     and says so; the window's card says the same and asks once about the
 *     note, with each exact file; Add writes the notes and lists them.
 *  3. Gemini's switch goes off in Settings → Agents; a later run never adds
 *     it back, connects Amp (installed since) and says it once as new.
 *
 * PNGs land in /tmp/inbox-agent-awareness/. Build the binary first (see
 * inbox.spec.ts), then `bun run test:e2e:inbox`.
 */
import { expect, test, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createFakeAgents } from '../helpers/fake-agents';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shots = '/tmp/inbox-agent-awareness';

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(shots, { recursive: true });
  for (const scheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    // The window follows the OS scheme on the next frame.
    await page.waitForFunction((dark) => document.documentElement.classList.contains('dark') === dark, scheme === 'dark', { timeout: 1500 }).catch(() => {});
    await page.screenshot({ path: join(shots, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'dark' });
}

test('plannotator inbox connects the agents found; the card asks once about the note; a later run adds what is new', async ({ browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-inbox-agents-e2e-');
  const fake = createFakeAgents();
  fake.install('codex', 'gemini');
  mkdirSync(join(fake.home, '.codex'), { recursive: true });
  writeFileSync(join(fake.home, '.codex', 'AGENTS.md'), '# My rules\n\nBe brief.\n');
  const env = {
    ...fake.env,
    PLANNOTATOR_DATA_DIR: join(root, 'data'),
    PLANNOTATOR_BROWSER: 'none',
    PLANNOTATOR_SKIP_BROWSER_OPEN: '1',
    PLANNOTATOR_INBOX_CONNECT: '1',
    PLANNOTATOR_INBOX_PHONES: '0',
    PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
    PLANNOTATOR_UPDATE_API_URL: 'http://127.0.0.1:9/releases/latest',
    PLANNOTATOR_INSTALL_SCRIPT_URL: 'http://127.0.0.1:9/install.sh',
  };
  const run = (args: string[]) => spawnSync(binary, ['inbox', ...args], { env, cwd: root, encoding: 'utf8', timeout: 90_000 });
  const adds = () => fake.calls().filter((c) => c.args[1] === 'add').map((c) => c.name);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const started = run(['--background']);
    expect(started.status, started.stderr).toBe(0);
    const url = started.stdout.trim();
    expect(fake.calls()).toEqual([]);

    const person = run(['--no-open']);
    expect(person.status, person.stderr).toBe(0);
    expect(person.stderr).toContain('Connected Codex and Gemini CLI to the Inbox.');
    expect(adds().sort()).toEqual(['codex', 'gemini']);

    const page = await context.newPage();
    await page.goto(url);
    const card = page.locator('[data-agents-card]');
    await expect(card.locator('.ib-conn-head b')).toHaveText('Connected Codex and Gemini CLI to the Inbox.');
    await expect(card.getByRole('heading', { name: 'Tell them when to use it?' })).toBeVisible();
    const picks = card.locator('.ib-conn-picks li');
    await expect(picks).toHaveCount(2);
    await expect(picks.nth(0)).toContainText('~/.codex/AGENTS.md');
    await expect(picks.nth(0)).toContainText('adds a marked section');
    await expect(picks.nth(1)).toContainText('~/.gemini/GEMINI.md');
    await expect(picks.nth(1)).toContainText('will create');
    await shot(page, '01-first-open');
    await card.getByRole('button', { name: 'Show the note' }).click();
    await expect(card.locator('.ib-conn-note pre')).toContainText('<!-- plannotator-inbox:start v1');
    await shot(page, '02-note-preview');
    await card.getByRole('button', { name: 'Add to 2 files' }).click();
    await expect(card.locator('.ib-conn-done li').first()).toHaveText('Codex: Added a marked section to ~/.codex/AGENTS.md');
    await expect(card.locator('.ib-conn-done li').nth(1)).toHaveText('Gemini CLI: Created ~/.gemini/GEMINI.md');
    await shot(page, '03-after-add');
    expect(readFileSync(join(fake.home, '.codex', 'AGENTS.md'), 'utf8')).toMatch(/^# My rules\n\nBe brief\.\n\n<!-- plannotator-inbox:start v1 /);
    expect(readFileSync(join(fake.home, '.gemini', 'GEMINI.md'), 'utf8')).toContain('## Plannotator Inbox');

    // The person turns Gemini off (the same route Settings → Agents uses): its entry goes, and stays gone.
    const off = await page.evaluate(async () => {
      const settings = await (await fetch('/api/inbox/settings')).json();
      const answer = await fetch('/api/inbox/agents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serverSession: settings.serverSession, agent: 'gemini', reach: false }) });
      return answer.status;
    });
    expect(off).toBe(200);
    expect(JSON.parse(readFileSync(join(fake.home, '.gemini', 'settings.json'), 'utf8')).mcpServers).toEqual({});

    // Settings → Agents: Codex connected with its note, Gemini off (never re-added), the rest folded.
    await page.goto(`${url}#settings/agents`);
    const codex = page.locator('[data-agent="codex"]');
    await expect(codex.getByRole('switch', { name: 'Reaches the Inbox: Codex' })).toHaveAttribute('aria-checked', 'true');
    await expect(codex.getByRole('switch', { name: 'Note in its instructions: Codex' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('[data-agent="gemini"]').getByRole('switch', { name: 'Reaches the Inbox: Gemini CLI' })).toHaveAttribute('aria-checked', 'false');
    await shot(page, '05-settings-agents');
    await page.setViewportSize({ width: 390, height: 844 });
    await shot(page, '06-settings-agents-phone');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(url);

    fake.install('amp');
    const later = run(['--no-open']);
    expect(later.status, later.stderr).toBe(0);
    expect(later.stderr).toContain('Connected Amp to the Inbox (new on this computer).');
    expect(adds().sort()).toEqual(['amp', 'codex', 'gemini']);
    await page.reload();
    await expect(card.locator('.ib-conn-head b')).toHaveText('Connected Amp to the Inbox (new on this computer).');
    await expect(card.getByRole('heading', { name: 'Tell them when to use it?' })).toHaveCount(0);
    await shot(page, '04-later-run');
    await card.getByRole('button', { name: 'Close this notice' }).click();
    await expect(card).toHaveCount(0);
  } finally {
    await context.close().catch(() => {});
    await removeInboxScratch(root);
    fake.remove();
  }
});
