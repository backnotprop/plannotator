/**
 * Rename… on an agent's sidebar row, proved in a real browser against the compiled binary (temp data dir and HOME,
 * sandboxed agent PATH, no browser opened, nothing real asked).
 *
 *  1. A right-click on the row opens its menu with a project row's words: "Rename…", and "Reset name" once a name is
 *     given. Rename… turns the row into the project rename field holding its name; Escape cancels, Enter keeps it.
 *  2. The name shows on the row at once, in a second window without a reload (`event: agent-faces`), and after a
 *     reload (the Inbox keeps it in agent-faces.json, beside the agent's face).
 *  3. ⋯ opens the same menu; Reset name goes back to the agent's own name, everywhere.
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

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));

interface World {
  data: string;
  url: string;
  agents: SimAgent[];
  context: BrowserContext;
}
let world: World;

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
  const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  await agent.send({ project_path: project, subject: 'Invoice retries', thread: 'retries', body: ['Invoice retries: one decision waits on you.', '', ':::question', 'Ship it?', '', '- [ ] Yes', '- [ ] No', ':::'].join('\n') });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  world = { data, url: started.stdout.trim(), agents: [agent], context };
});

test.afterAll(async () => {
  try {
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

  // The menu at the pointer: Rename… alone, as a project with no name of its own.
  await agentRow(page).locator('.ib-proj').click({ button: 'right' });
  await expect(menuItems(page)).toHaveText(['Rename…']);
  await menuItems(page).first().click();
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
  await menuItems(page).first().click();
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
  await expect(menuItems(page)).toHaveText(['Rename…', 'Reset name']);
  await menuItems(page).nth(1).click();
  await expect(rowName(page)).toHaveText(own);
  await expect(rowName(other)).toHaveText(own);
  await other.close();
  await page.close();
});
