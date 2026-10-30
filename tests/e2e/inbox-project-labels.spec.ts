/**
 * The window's project names (owner's pick, 2026-10-29), in a real browser
 * against the compiled binary, with an agent writing through
 * `plannotator inbox mcp` (scripts/inbox-sim.ts):
 *
 *  - a project reads its folder's name; the parent is added only while
 *    another project on screen shares it ("plannotator · plannotator" while
 *    the old clone is listed, "plannotator" once it is archived), while the
 *    server's name, what agents read, keeps the parent;
 *  - a checkout in a `worktrees` folder (Workspaces' `<repo>/worktrees/main`)
 *    reads as its repository, in the sidebar, the rows and one project's
 *    list title.
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 * PNGs land in .local/proof/project-labels/.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'project-labels');

interface World {
  url: string;
  agent: SimAgent;
  context: BrowserContext;
  page: Page;
  errors: string[];
}

let world: World;

test.describe.configure({ mode: 'serial' });

const sidebarNames = (page: Page) => page.locator('.ib-projs .ib-name').allTextContents();
const rowNames = (page: Page) => page.locator('.ib-lbody .ib-p').allTextContents();
const projectRow = (page: Page, name: string) => page.locator('.ib-projrow', { has: page.locator('.ib-name', { hasText: new RegExp(`^${name}$`) }) });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-labels-e2e-');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: join(root, 'data'), PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const src = join(root, 'src');
  const projects = join(src, 'workspaces', 'projects');
  await agent.send({ project_path: scratchProject(join(src, 'plannotator'), 'plannotator'), subject: 'Rows read the folder name', thread: 'rows', body: 'Rows read the folder name now.' });
  await agent.send({ project_path: scratchProject(join(src, 'old'), 'plannotator'), subject: 'An old clone', thread: 'old', body: 'Left over from last month.' });
  for (const name of ['appnotes', 'workspaces', 'workspaces-cli']) {
    await agent.send({ project_path: scratchProject(join(projects, name, 'worktrees'), 'main'), subject: `${name} build`, thread: name, body: `The ${name} build is green.` });
  }
  world = { url: started.stdout.trim(), agent, context, page, errors };
});

test.afterAll(async () => {
  try {
    if (!world) return;
    await world.agent.close().catch(() => {});
    await world.context.close();
  } finally {
    await removeInboxScratch();
  }
});

test('a clash on screen adds the parent; archived, it goes, while agents keep the server name', async () => {
  const { page } = world;
  await page.goto(world.url);
  await expect(projectRow(page, 'plannotator · old')).toBeVisible();
  expect((await sidebarNames(page)).sort()).toEqual(['appnotes', 'plannotator · old', 'plannotator · plannotator', 'workspaces', 'workspaces-cli']);
  expect(new Set(await rowNames(page))).toEqual(new Set(['appnotes', 'plannotator · old', 'plannotator · plannotator', 'workspaces', 'workspaces-cli']));

  const old = projectRow(page, 'plannotator · old');
  await old.locator('.ib-proj').hover();
  await old.locator('.ib-pmore').click();
  await page.locator('[data-project-menu] [data-project-action="archive"]').click();
  await expect(old).toHaveCount(0);
  await page.reload();
  await expect(projectRow(page, 'plannotator')).toBeVisible();
  expect((await sidebarNames(page)).sort()).toEqual(['appnotes', 'plannotator', 'workspaces', 'workspaces-cli']);
  expect(new Set(await rowNames(page))).toEqual(new Set(['appnotes', 'plannotator', 'workspaces', 'workspaces-cli']));
  await page.screenshot({ path: join(proofDir, 'inbox.png') });

  // The server's name is unchanged: it still weighs the archived clone (what agents and search read).
  const served = await page.evaluate(async () => {
    const model = (await (await fetch('/api/inbox/threads')).json()) as { projects: { root: string; name: string }[] };
    return model.projects.map((p) => p.name).sort();
  });
  expect(served).toContain('plannotator · plannotator');
  expect(served).toContain('main · appnotes/worktrees');
  expect(world.errors).toEqual([]);
});

test("a lone Workspaces checkout's list is titled by its repository", async () => {
  const { page } = world;
  await projectRow(page, 'appnotes').locator('.ib-proj').click();
  await expect(page.locator('.ib-lhead h1')).toHaveText('appnotes');
  await page.screenshot({ path: join(proofDir, 'checkout-list.png') });
  expect(world.errors).toEqual([]);
});
