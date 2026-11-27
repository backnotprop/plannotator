/**
 * Rename… on an agent's sidebar row, proved in a real browser against the compiled binary (temp data dir and HOME,
 * sandboxed agent PATH, no browser opened, nothing real asked).
 *
 *  1. A right-click on the row opens its menu with a project row's words: "Rename…", and "Reset name" once a name is
 *     given. Rename… turns the row into the project rename field holding its name; Escape cancels, Enter keeps it.
 *  2. The name shows on the row at once, in a second window without a reload (`event: agent-faces`), and after a
 *     reload (the Inbox keeps it in agent-faces.json, beside the agent's face).
 *  3. ⋯ opens the same menu; Reset name goes back to the agent's own name, everywhere.
 *  4. New message…, first on the menu of a live agent: New message opens with that agent in To and the cursor in the
 *     message.
 *
 * The agent writes through `plannotator inbox mcp` as a session that polls the bridge, as the mod does: a session
 * heard only over MCP is not live (To does not list it), so its menu has no New message….
 *
 * Build the binary first (see inbox.spec.ts).
 */
import { expect, test, type Browser, type BrowserContext, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { E2E_LAUNCH_OFF, inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';
import { INBOX_BRIDGE_POLL_PATH } from '../../packages/shared/inbox/connection';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const SESSION = 'ses-retry-worker';

interface World {
  data: string;
  url: string;
  agents: SimAgent[];
  context: BrowserContext;
}
let world: World;
/** Stopped after the tests, whether or not the setup finished. */
let live: { stop: () => Promise<void> } | null = null;

/** The session's bridge long-poll, held and renewed until stopped (the mod's), so it is live. */
function poll(data: string, projectPath: string): { stop: () => Promise<void> } {
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      const { port, token } = JSON.parse(readFileSync(join(data, 'inbox', 'inbox.json'), 'utf8')) as { port: number; token: string };
      const response = await fetch(`http://127.0.0.1:${port}${INBOX_BRIDGE_POLL_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ session: SESSION, host: 'claude-code', project_path: projectPath, busy: false, waitMs: 500 }),
      }).catch(() => null);
      await response?.text().catch(() => '');
    }
  })();
  return {
    stop: async () => {
      stopped = true;
      await loop;
    },
  };
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-inbox-agent-rename-e2e-');
  const data = join(root, 'data');
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, 'config.json'), JSON.stringify({ ...E2E_LAUNCH_OFF }));
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
    PLANNOTATOR_DATA_DIR: data,
    PLANNOTATOR_TEST_SANDBOX: '1',
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const project = scratchProject(join(root, 'src'), 'billing-svc');
  live = poll(data, project);
  const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  await agent.send({ project_path: project, agent_session: SESSION, subject: 'Invoice retries', thread: 'retries', body: ['Invoice retries: one decision waits on you.', '', ':::question', 'Ship it?', '', '- [ ] Yes', '- [ ] No', ':::'].join('\n') } as Parameters<SimAgent['send']>[0]);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  world = { data, url: started.stdout.trim(), agents: [agent], context };
});

test.afterAll(async () => {
  try {
    await live?.stop();
    if (!world) return;
    for (const agent of world.agents) await agent.close().catch(() => {});
    await world.context.close();
  } finally {
    await removeInboxScratch();
  }
});

const agentRow = (page: Page) => page.locator('.ib-sbagent').first();
const rowName = (page: Page) => agentRow(page).locator('.ib-proj .ib-name');
const menuItems = (page: Page) => page.locator('[data-agent-menu] [role="menuitem"]');

async function open(page: Page): Promise<string> {
  await page.goto(world.url);
  await expect(page.locator('.ib-main h1').first()).toBeVisible();
  if ((await page.locator('.ib-sbagent').count()) === 0) await page.getByRole('button', { name: 'Agents', exact: true }).click();
  await expect(agentRow(page)).toBeVisible();
  return rowName(page).innerText();
}

test('a right-click renames an agent with the project field; the name shows in another window, after a reload, and Reset name takes it back', async () => {
  test.setTimeout(120_000);
  const page = await world.context.newPage();
  const own = await open(page);
  expect(own.trim().length).toBeGreaterThan(0);

  // The menu at the pointer: New message… (a live agent), then Rename… alone, as a project with no name of its own.
  await agentRow(page).locator('.ib-proj').click({ button: 'right' });
  await expect(menuItems(page)).toHaveText(['New message…', 'Rename…']);
  await page.locator('[data-agent-menu] [data-agent-action="rename"]').click();
  const field = agentRow(page).locator('input.ib-proj-rename');
  await expect(field).toBeFocused();
  await expect(field).toHaveValue(own);
  await expect(field).toHaveAttribute('placeholder', own);
  // Escape cancels.
  await field.fill('Not kept');
  await page.keyboard.press('Escape');
  await expect(field).toHaveCount(0);
  await expect(rowName(page)).toHaveText(own);

  // Enter keeps it.
  await agentRow(page).locator('.ib-proj').click({ button: 'right' });
  await page.locator('[data-agent-menu] [data-agent-action="rename"]').click();
  await agentRow(page).locator('input.ib-proj-rename').fill('Retry worker');
  const other = await world.context.newPage();
  await open(other);
  await page.keyboard.press('Enter');
  await expect(rowName(page)).toHaveText('Retry worker');
  await expect(agentRow(page).locator('[data-agent-more]')).toBeFocused();
  // Another window hears it, no reload.
  await expect(rowName(other)).toHaveText('Retry worker');
  // The Inbox keeps it beside the agent's face.
  const kept = JSON.parse(readFileSync(join(world.data, 'inbox', 'agent-faces.json'), 'utf8')) as { faces: Record<string, { name?: string }> };
  expect(Object.values(kept.faces).map((entry) => entry.name)).toEqual(['Retry worker']);
  await page.reload();
  await expect(rowName(page)).toHaveText('Retry worker');

  // ⋯ opens the same menu, now with Reset name.
  await agentRow(page).hover();
  await agentRow(page).locator('[data-agent-more]').click();
  await expect(menuItems(page)).toHaveText(['New message…', 'Rename…', 'Reset name']);
  await page.locator('[data-agent-menu] [data-agent-action="reset"]').click();
  await expect(rowName(page)).toHaveText(own);
  await expect(rowName(other)).toHaveText(own);
  await other.close();
  await page.close();
});

test("a right-click's New message… opens New message with that agent in To and the cursor in the message", async () => {
  const page = await world.context.newPage();
  await open(page);
  const session = await agentRow(page).getAttribute('data-sidebar-agent');
  await agentRow(page).locator('.ib-proj').click({ button: 'right' });
  await expect(menuItems(page).first()).toHaveText('New message…');
  await page.locator('[data-agent-menu] [data-agent-action="message"]').click();
  const dialog = page.locator('dialog[data-compose]');
  await expect(dialog.locator(`[data-compose-to="${session}"]`)).toBeVisible();
  await expect(dialog.locator('textarea').first()).toBeFocused();
  // Empty: Escape keeps nothing.
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await page.close();
});
