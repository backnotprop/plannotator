/**
 * Combining projects (approval "project-combine"), in a real browser against
 * the compiled binary, with agents writing through `plannotator inbox mcp`
 * (scripts/inbox-sim.ts). The person's layout, as in DESIGN.md: "docs" and
 * "docs-site" are two repositories they see as one; acme, billing-svc and
 * ledger-api are each cloned twice; web-app and field-notes stand alone.
 *
 *  - the rename warning: Cancel changes nothing, Combine folds the two, the
 *    toast's Undo and its Z key split them, keyboard only;
 *  - one project everywhere: the sidebar, its list, the rows, search, a reload;
 *  - agents after the combine: a thread name in either folder is one thread, a
 *    retry from the other folder is the same send, and the folder's new threads
 *    and attachments stay its own;
 *  - an undo, later, restores everything, the messages sent since included;
 *  - the race and the recovery: a second window, two opposite combines at once,
 *    a killed Inbox;
 *  - Tidy's "Combine projects": strong signals, ticks, one Undo, not offered
 *    again after Undo;
 *  - a name that matches several projects, Settings' rule for Delete;
 *  - a phone.
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 * PNGs land in .local/proof/project-combine/ (1440×900 @2x, a phone 390×844 @3x).
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { inboxScratch, rememberInboxOf, removeInboxScratch, stopScratchInbox } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'project-combine');
const olderBinary = process.env.PLANNOTATOR_E2E_OLDER_BINARY;

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
}

function clone(parent: string, name: string, origin: string): string {
  const folder = scratchProject(parent, name);
  git(folder, 'remote', 'add', 'origin', origin);
  return folder;
}

interface World {
  url: string;
  env: Record<string, string>;
  dataDir: string;
  agent: SimAgent;
  context: BrowserContext;
  page: Page;
  errors: string[];
  folders: Record<'docs' | 'site', string>;
  ids: Record<'docs' | 'site' | 'acme' | 'acmeClone' | 'billing' | 'billingOld' | 'ledger' | 'ledgerOld', string>;
  threads: { docs: string; site: string };
}

let world: World;

test.describe.configure({ mode: 'serial' });

const row = (page: Page, name: string) => page.locator('.ib-projrow', { has: page.locator('.ib-name', { hasText: new RegExp(`^${name}$`) }) });
const sidebarNames = (page: Page) => page.locator('.ib-projs .ib-name').allTextContents();
const field = (page: Page) => page.locator('[data-project-name-field]');
const menu = (page: Page) => page.locator('[data-project-menu]');
const clash = (page: Page) => page.locator('[data-project-clash]');
const toast = (page: Page) => page.locator('.ib-toast');
const live = (page: Page) => page.locator('[data-inbox-live]');

async function colored(browser: Browser, url: string, scheme: 'light' | 'dark'): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: scheme });
  await context.addCookies([{ name: 'plannotator-theme', value: scheme, url }]);
  return context;
}

async function openRename(page: Page, name: string): Promise<void> {
  await row(page, name).locator('.ib-proj').click({ button: 'right' });
  await page.locator('[data-project-action="rename"]').click();
  await expect(field(page)).toBeFocused();
}

/** The thread's row names this project in the list. */
async function rowProject(page: Page, threadId: string): Promise<string> {
  return (await page.locator(`.ib-lbody [data-row="${threadId}"] .ib-p`).first().textContent())?.trim() ?? '';
}

const get = async (path: string) => (await fetch(`${world.url}${path}`)).json() as Promise<any>;
const session = async (): Promise<string> => (await get('/api/inbox/projects')).serverSession;
const combine = async (id: string, into: string | null, serverSession?: string) =>
  fetch(`${world.url}/api/inbox/projects/${id}/combine`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ into, serverSession: serverSession ?? (await session()) }),
  });
const threadBodies = async (id: string): Promise<string[]> => (await get(`/api/inbox/threads/${id}`)).thread.messages.map((message: { body: string }) => message.body);
const threadProjects = async (id: string): Promise<string[]> => (await get(`/api/inbox/threads/${id}`)).thread.messages.map((message: { project_id: string }) => message.project_id);
/** The project the Inbox lists the thread under. A folded section and the window's "1 new" line hide a row, not its project. */
const listedIn = async (id: string): Promise<string | undefined> =>
  (await get('/api/inbox/threads')).sections.flatMap((section: { threads: { thread_id: string; project: { name: string } }[] }) => section.threads).find((found: { thread_id: string }) => found.thread_id === id)?.project.name;

/** Starts an Inbox on the world's data after the last one stopped, with a new agent connection to it. */
async function startInbox(program: string): Promise<SimAgent> {
  const started = spawnSync(program, ['inbox', '--background'], { env: world.env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(world.dataDir);
  world.url = new URL(started.stdout.trim()).origin;
  await world.agent.close().catch(() => {});
  world.agent = await SimAgent.connect({ binary: program, env: world.env, name: 'Claude Code', host: 'claude-code' });
  return world.agent;
}

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-combine-e2e-');
  const dataDir = join(root, 'data');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const code = join(root, 'code');
  const docs = scratchProject(code, 'docs');
  const site = scratchProject(code, 'docs-site');
  const acme = clone(code, 'acme', 'https://github.com/acme/platform.git');
  const acmeClone = clone(join(root, 'workspaces', 'acme', 'worktrees'), 'main', 'https://github.com/acme/platform.git');
  const billing = clone(code, 'billing-svc', 'https://github.com/acme/billing.git');
  const billingOld = clone(join(root, 'old'), 'billing-svc', 'https://github.com/acme/billing.git');
  const ledger = clone(code, 'ledger-api', 'https://github.com/acme/ledger.git');
  const ledgerOld = clone(join(root, 'old'), 'ledger-api', 'https://github.com/acme/ledger.git');
  const web = scratchProject(code, 'web-app');
  const notes = scratchProject(code, 'field-notes');
  writeFileSync(join(site, 'landing.md'), '# Landing\n\nThe new landing page copy.\n');
  // The Board is something the person turns on: on here, for the cards a combine must give back.
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ inboxBoard: true }));
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  const url = new URL(started.stdout.trim()).origin;
  const context = await colored(browser, url, 'light');
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const inDocs = await agent.send({ project_path: docs, subject: 'Release notes drafted', thread: 'release', body: 'The heron release notes are drafted.' });
  const inSite = await agent.send({ project_path: site, subject: 'Landing page copy', thread: 'landing', body: 'The marlin landing copy is ready.' });
  const inAcme = await agent.send({ project_path: acme, subject: 'Search index rebuilt', thread: 'search', body: 'The search index is rebuilt.' });
  const inAcme2 = await agent.send({ project_path: acme, subject: 'Worker retries', thread: 'worker', body: 'The worker retries now.' });
  const inAcmeClone = await agent.send({ project_path: acmeClone, subject: 'Checkout page fixed', thread: 'checkout', body: 'The checkout page is fixed.' });
  const inBilling = await agent.send({ project_path: billing, subject: 'Invoices reconciled', thread: 'invoices', body: 'The October invoices are reconciled.' });
  const inBillingOld = await agent.send({ project_path: billingOld, subject: 'Old export kept', thread: 'export', body: 'The old export stays for now.' });
  const inLedger = await agent.send({ project_path: ledger, subject: 'Ledger totals match', thread: 'totals', body: 'The ledger totals match.' });
  const inLedgerOld = await agent.send({ project_path: ledgerOld, subject: 'Old ledger archived', thread: 'archive', body: 'The old ledger is archived.' });
  await agent.send({ project_path: web, subject: 'Sign-in page shipped', thread: 'signin', body: 'The sign-in page is live.' });
  await agent.send({ project_path: notes, subject: 'Interview notes filed', thread: 'notes', body: 'Three interviews are filed.' });
  expect(inAcme2.project.id).toBe(inAcme.project.id);
  world = {
    url,
    env,
    dataDir,
    agent,
    context,
    page,
    errors,
    folders: { docs, site },
    ids: {
      docs: inDocs.project.id,
      site: inSite.project.id,
      acme: inAcme.project.id,
      acmeClone: inAcmeClone.project.id,
      billing: inBilling.project.id,
      billingOld: inBillingOld.project.id,
      ledger: inLedger.project.id,
      ledgerOld: inLedgerOld.project.id,
    },
    threads: { docs: inDocs.thread_id as string, site: inSite.thread_id as string },
  };
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

test('the rename warning: Cancel changes nothing, Combine folds the two, Undo in the toast splits them', async () => {
  const { page, threads } = world;
  await page.goto(world.url);
  await expect.poll(() => sidebarNames(page)).toEqual(expect.arrayContaining(['docs', 'docs-site', 'web-app', 'field-notes']));

  await openRename(page, 'docs-site');
  // A free name has no warning, and the warning follows what is typed, whatever its case.
  await page.keyboard.type('docs-');
  await expect(clash(page)).toHaveCount(0);
  await field(page).fill('DOCS');
  await expect(clash(page)).toContainText('docs already exists. Combine them?');
  await field(page).fill('docs');
  await expect(clash(page)).toContainText('docs already exists. Combine them?');
  await expect(clash(page).getByRole('button')).toHaveText(['Cancel', 'Combine']);
  await expect(live(page)).toHaveText('docs already exists. Enter combines them, Escape cancels.');
  await page.mouse.move(900, 700);
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(proofDir, '01-rename-warning-light.png') });

  // Cancel: the field closes and nothing changed.
  await page.locator('[data-project-combine-cancel]').click();
  await expect(field(page)).toHaveCount(0);
  await expect(row(page, 'docs-site')).toBeVisible();
  expect((await get('/api/inbox/projects')).projects.some((project: { id: string }) => project.id === world.ids.site)).toBe(true);

  // Combine: one project with the threads of both, under the name typed.
  await openRename(page, 'docs-site');
  await page.keyboard.type('docs');
  await page.locator(`[data-project-combine="${world.ids.docs}"]`).click();
  await expect(toast(page)).toContainText('Combined into docs');
  await expect(row(page, 'docs-site')).toHaveCount(0);
  await expect(field(page)).toHaveCount(0);
  await expect(row(page, 'docs').locator('.ib-pmore')).toBeFocused();
  for (const id of [threads.docs, threads.site]) await expect.poll(() => rowProject(page, id)).toBe('docs');
  await page.mouse.move(900, 700);
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(proofDir, '02-after-combine-light.png') });

  await toast(page).getByRole('button', { name: 'Undo' }).click();
  await expect(row(page, 'docs-site')).toBeVisible();
  await expect(live(page)).toHaveText('Combine undone.');
  await expect.poll(() => rowProject(page, threads.site)).toBe('docs-site');
  await expect.poll(() => rowProject(page, threads.docs)).toBe('docs');
});

test('keyboard only: Enter combines, Escape cancels, Z undoes, focus lands on the project that stays', async () => {
  const { page } = world;
  const site = row(page, 'docs-site');
  await site.locator('.ib-proj').focus();
  await page.keyboard.press('Tab');
  await expect(site.locator('.ib-pmore')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-project-action="read"]')).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.locator('[data-project-action="rename"]')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(field(page)).toBeFocused();
  await page.keyboard.type('docs');
  await expect(clash(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(field(page)).toHaveCount(0);
  await expect(site.locator('.ib-pmore')).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(page.locator('[data-project-action="read"]')).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.locator('[data-project-action="rename"]')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(field(page)).toBeFocused();
  await page.keyboard.type('docs');
  await expect(clash(page)).toBeVisible();
  // Tab reaches Cancel and Combine without closing the field.
  await page.keyboard.press('Tab');
  await expect(page.locator('[data-project-combine-cancel]')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator(`[data-project-combine="${world.ids.docs}"]`)).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(field(page)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(toast(page)).toContainText('Combined into docs');
  await expect(row(page, 'docs').locator('.ib-pmore')).toBeFocused();

  await page.keyboard.press('z');
  await expect(row(page, 'docs-site')).toBeVisible();
  await expect(live(page)).toHaveText('Combine undone.');
});

test('one project everywhere: its list, the thread, search, the menu and a reload', async () => {
  const { page, threads, ids } = world;
  expect((await combine(ids.site, ids.docs)).status).toBe(200);
  await expect(row(page, 'docs-site')).toHaveCount(0);

  await row(page, 'docs').locator('.ib-proj').click();
  await expect(page.locator('.ib-lhead-tt')).toHaveText('docs');
  for (const id of [threads.docs, threads.site]) await expect(page.locator(`.ib-lbody [data-row="${id}"]`).first()).toBeVisible();

  // The thread from the combined folder reads the project that stays.
  await page.locator(`.ib-lbody [data-thread-id="${threads.site}"]`).click();
  await expect(page).toHaveURL(new RegExp(`thread=${threads.site}`));
  const open = await get(`/api/inbox/threads/${threads.site}`);
  expect(open.thread.project).toMatchObject({ id: ids.docs, name: 'docs' });
  expect(open.row.project).toMatchObject({ id: ids.docs, name: 'docs' });
  await expect(page.getByText('The marlin landing copy is ready.').first()).toBeVisible();

  // Search names it by the project that stays, and has one project row.
  await expect
    .poll(async () => {
      const answer = await get('/api/inbox/search?q=marlin');
      return answer.indexing ? null : Object.values(answer.groups as Record<string, { project?: { name: string } }[]>).flat().map((found) => found.project?.name);
    })
    .toEqual(['docs']);
  const projects = await get('/api/inbox/search?q=docs');
  expect(Object.values(projects.groups as Record<string, { type: string; name?: string }[]>).flat().filter((found) => found.type === 'project').map((found) => found.name)).toEqual(['docs']);

  // The ⋯ menu of a combined project is any project's: undoing later is the agent's, not the window's.
  await page.goto(world.url);
  await row(page, 'docs').locator('.ib-pmore').click({ force: true });
  await expect(menu(page).getByRole('menuitem')).toHaveText(['Mark all as read', 'Archive all', 'Rename…']);
  await page.keyboard.press('Escape');
  await expect.poll(() => rowProject(page, threads.docs)).toBe('docs');
});

test('an undo after the toast restores everything: the threads, the messages sent since, routing, attachments, the archive', async () => {
  const { page, agent, folders, ids, threads } = world;
  const serverSession = await session();

  // Sent after the combine. A name is one thread across both folders.
  const siteIntoDocs = await agent.send({ project_path: folders.site, thread: 'release', body: 'A kingfisher note from docs-site.' });
  const docsIntoSite = await agent.send({ project_path: folders.docs, thread: 'landing', body: 'A puffin note from docs.' });
  expect(siteIntoDocs.thread_id).toBe(threads.docs);
  expect(docsIntoSite.thread_id).toBe(threads.site);
  // A new thread from the combined folder, with a file of that folder, that the person answers.
  const siteNew = await agent.send({ project_path: folders.site, subject: 'Redesign plan', thread: 'redesign', body: 'The osprey redesign plan.', attachments: ['landing.md'] });
  const docsNew = await agent.send({ project_path: folders.docs, subject: 'Changelog', thread: 'changelog', body: 'The ibis changelog.' });
  // The other folder's retry of the same send is the same message.
  const retried = await agent.send({ project_path: folders.docs, subject: 'Redesign plan', body: 'A pelican retry.', idempotency_key: 'one-send' });
  const again = await agent.send({ project_path: folders.site, subject: 'Redesign plan', body: 'A pelican retry.', idempotency_key: 'one-send' });
  expect(again.message_id).toBe(retried.message_id);
  // The person answers it while the two are one.
  const replied = await fetch(`${world.url}/api/inbox/messages/${siteNew.message_id}/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ serverSession, idempotency_key: 'person-reply', words: 'Go ahead with the osprey plan.' }),
  });
  expect(replied.status).toBe(200);
  const before = {
    docs: await threadBodies(threads.docs),
    site: await threadBodies(threads.site),
    siteNew: await threadBodies(siteNew.thread_id),
    docsNew: await threadBodies(docsNew.thread_id),
  };
  expect(await listedIn(siteNew.thread_id)).toBe('docs');
  expect(await listedIn(docsNew.thread_id)).toBe('docs');

  expect((await combine(ids.site, null, serverSession)).status).toBe(200);
  await expect(row(page, 'docs-site')).toBeVisible();

  // Nothing lost, nothing moved: each thread has every message it had.
  expect(await threadBodies(threads.docs)).toEqual(before.docs);
  expect(await threadBodies(threads.site)).toEqual(before.site);
  expect(await threadBodies(siteNew.thread_id)).toEqual(before.siteNew);
  expect(await threadBodies(docsNew.thread_id)).toEqual(before.docsNew);
  expect(before.docs).toContain('A kingfisher note from docs-site.');
  expect(before.siteNew).toContain('The osprey redesign plan.');
  expect(before.siteNew.some((body) => body.includes('Go ahead with the osprey plan.'))).toBe(true);

  // Each thread goes back with the folder it started in, the ones started since the combine too.
  expect(await listedIn(siteNew.thread_id)).toBe('docs-site');
  expect(await listedIn(threads.site)).toBe('docs-site');
  expect(await listedIn(docsNew.thread_id)).toBe('docs');
  expect(await listedIn(threads.docs)).toBe('docs');
  // A thread is whole in one project: every message of it is in the folder it started in.
  expect(new Set(await threadProjects(threads.docs))).toEqual(new Set([ids.docs]));
  expect(new Set(await threadProjects(threads.site))).toEqual(new Set([ids.site]));
  expect(new Set(await threadProjects(siteNew.thread_id))).toEqual(new Set([ids.site]));
  // What it attached is still there, and still opens.
  const attached = (await get(`/api/inbox/threads/${siteNew.thread_id}`)).thread.messages[0].attachments[0];
  expect(attached.name ?? attached.path).toContain('landing.md');
  const file = await fetch(`${world.url}/api/inbox/attachments/${attached.id}`);
  expect(file.status).toBe(200);
  expect(await file.text()).toContain('The new landing page copy.');

  // Routing is per folder again: the name in the other folder is another thread.
  const siteAgain = await agent.send({ project_path: folders.site, thread: 'redesign', body: 'From its own folder.' });
  const docsAgain = await agent.send({ project_path: folders.docs, thread: 'redesign', body: 'A thread of its own.' });
  expect(siteAgain.thread_id).toBe(siteNew.thread_id);
  expect(docsAgain.thread_id).not.toBe(siteNew.thread_id);
  expect(docsAgain.project.id).toBe(ids.docs);
});

test('the race: a window filtered on the folded project follows it; two opposite combines cannot make a loop', async ({ browser }: { browser: Browser }) => {
  const { page, ids, threads } = world;
  const second = await colored(browser, world.url, 'light');
  const other = await second.newPage();
  const errors: string[] = [];
  other.on('pageerror', (error) => errors.push(error.message));
  await other.goto(`${world.url}/#project=${ids.site}`);
  await expect(other.locator('.ib-lhead-tt')).toHaveText('docs-site');

  await openRename(page, 'docs-site');
  await page.keyboard.type('docs');
  await page.keyboard.press('Enter');
  await expect(toast(page)).toContainText('Combined into docs');
  // The other window was on a project that is gone from the sidebar: it moves to the one that stays, and shows both.
  await expect(other.locator('.ib-lhead-tt')).toHaveText('docs');
  await expect(other).toHaveURL(new RegExp(`project=${ids.docs}`));
  await expect(other.locator(`.ib-lbody [data-row="${threads.site}"]`).first()).toBeVisible();
  await expect(other.locator(`.ib-lbody [data-row="${threads.docs}"]`).first()).toBeVisible();

  // Undo in the first window: the second shows both projects again, and stays where it is.
  await toast(page).getByRole('button', { name: 'Undo' }).click();
  await expect(row(other, 'docs-site')).toBeVisible();
  await expect(other.locator('.ib-lhead-tt')).toHaveText('docs');

  // Both ways at the same moment: one wins, and neither project is lost.
  const answers = await Promise.all([combine(ids.site, ids.docs), combine(ids.docs, ids.site)]);
  const statuses = answers.map((answer) => answer.status).sort();
  expect(statuses).toEqual([200, 422]);
  const shown = (await get('/api/inbox/projects')).projects.map((project: { id: string }) => project.id);
  expect(shown.filter((id: string) => id === ids.docs || id === ids.site)).toHaveLength(1);
  const rows = (await get('/api/inbox/threads')).sections.flatMap((section: { threads: { thread_id: string; project: { id: string } }[] }) => section.threads);
  expect(rows.some((found: { thread_id: string }) => found.thread_id === threads.docs)).toBe(true);
  expect(rows.some((found: { thread_id: string }) => found.thread_id === threads.site)).toBe(true);

  // Back to two, whichever won.
  for (const id of [ids.site, ids.docs]) expect((await combine(id, null)).status).toBe(200);
  await expect(row(page, 'docs-site')).toBeVisible();
  await expect(row(page, 'docs')).toBeVisible();
  // A stale tab's Combine is refused and changes nothing.
  expect((await combine(ids.site, ids.docs, 'an-older-inbox')).status).toBe(409);
  await expect(row(page, 'docs-site')).toBeVisible();
  expect(errors).toEqual([]);
  await second.close();
});

test('recovery: a killed Inbox comes back combined, and an undo still restores it', async () => {
  const { page, ids, threads, folders, dataDir } = world;
  expect((await combine(ids.site, ids.docs)).status).toBe(200);
  await expect(row(page, 'docs-site')).toHaveCount(0);
  await stopScratchInbox(dataDir, 'SIGKILL');

  const agent = await startInbox(binary);
  await page.goto(world.url);
  await expect(row(page, 'docs')).toBeVisible();
  await expect(row(page, 'docs-site')).toHaveCount(0);
  await expect.poll(() => rowProject(page, threads.site)).toBe('docs');

  // The agent's connection comes back too, and its folder is still the same project.
  const sent = await agent.send({ project_path: folders.site, subject: 'After the crash', thread: 'after-crash', body: 'Written after the restart.' });
  expect(sent.project.id).toBe(ids.site);
  expect(await listedIn(sent.thread_id)).toBe('docs');

  expect((await combine(ids.site, null)).status).toBe(200);
  await expect(row(page, 'docs-site')).toBeVisible();
  expect(await listedIn(sent.thread_id)).toBe('docs-site');
});

test('an older binary on a combined store: the two projects it always showed, nothing lost, and the combine still stands after', async () => {
  test.skip(!olderBinary, 'needs PLANNOTATOR_E2E_OLDER_BINARY, a binary from before combine');
  const { page, ids, threads, folders, dataDir } = world;
  expect((await combine(ids.site, ids.docs)).status).toBe(200);
  await stopScratchInbox(dataDir);

  // Named `plannotator`: only a process that reads as an Inbox can be stopped (tests/helpers/inbox-process.ts).
  const olderCopy = join(dirname(dataDir), 'older', 'plannotator');
  mkdirSync(dirname(olderCopy), { recursive: true });
  copyFileSync(resolve(olderBinary!), olderCopy);
  const older = await startInbox(olderCopy);
  const shown = (await get('/api/inbox/projects')).projects.map((project: { id: string }) => project.id);
  expect(shown).toEqual(expect.arrayContaining([ids.docs, ids.site]));
  const rows = (await get('/api/inbox/threads')).sections.flatMap((section: { threads: { thread_id: string; project: { id: string } }[] }) => section.threads);
  expect(rows.find((found: { thread_id: string }) => found.thread_id === threads.site)?.project.id).toBe(ids.site);
  expect(rows.find((found: { thread_id: string }) => found.thread_id === threads.docs)?.project.id).toBe(ids.docs);
  // It writes to the folder's project, as it always did.
  const sent = await older.send({ project_path: folders.site, subject: 'From an older binary', thread: 'older', body: 'Written by an older Inbox.' });
  expect(sent.project.id).toBe(ids.site);
  // The agent command, new, on the Inbox that is running, old: it says so instead of a bare 404.
  const refused = spawnSync(binary, ['inbox', 'projects', 'combine', ids.site, '--into', ids.docs], { env: world.env, encoding: 'utf8', timeout: 60_000 });
  expect(refused.status).toBe(1);
  expect(refused.stderr).toMatch(/^not_supported:/);
  await stopScratchInbox(dataDir);

  await startInbox(binary);
  await page.goto(world.url);
  await expect(row(page, 'docs')).toBeVisible();
  await expect(row(page, 'docs-site')).toHaveCount(0);
  expect(await listedIn(sent.thread_id)).toBe('docs');
  expect((await combine(ids.site, null)).status).toBe(200);
  await expect(row(page, 'docs-site')).toBeVisible();
  expect(await listedIn(sent.thread_id)).toBe('docs-site');
});

test('Tidy offers the clones: only what is ticked is combined, one Undo for all of it, and a pair undone is not offered again', async () => {
  const { page, ids } = world;
  const open = async () => {
    await page.locator('[data-tidy-menu]').first().click();
    await page.locator('[data-tidy-item]').click();
    await expect(page.locator('[data-tidy-popover]')).toBeVisible();
  };
  const offered = async () => (await get('/api/inbox/tidy?surface=list')).combine?.length ?? 0;
  await page.goto(world.url);
  // Three strong pairs, and nothing about docs and docs-site: they share no repository.
  await expect.poll(offered).toBe(3);
  await page.locator('[data-tidy-menu]').first().click();
  await expect(page.locator('[data-tidy-item]')).toContainText('3');
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(proofDir, '04-tidy-menu-light.png') });
  await page.locator('[data-tidy-item]').click();
  await expect(page.locator('[data-tidy-popover]')).toBeVisible();
  const acme = page.locator(`[data-tidy-combine="${ids.acme}"]`);
  const billing = page.locator(`[data-tidy-combine="${ids.billing}"], [data-tidy-combine="${ids.billingOld}"]`);
  await expect(page.locator('.ib-tidy-sub')).toHaveText('Combine projects');
  await expect(acme).toContainText('acme');
  await expect(acme).toContainText('2 folders, same repository');
  await expect(billing).toContainText('billing-svc');
  await expect(billing).toContainText('2 folders, same repository');
  await page.mouse.move(1200, 800);
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(proofDir, '05-tidy-suggests-light.png') });

  // Only what is ticked. A row left unticked is still offered next time.
  await acme.locator('input').uncheck();
  await billing.locator('input').uncheck();
  await page.locator('[data-tidy-go]').click();
  await expect(toast(page)).toContainText('Combined into ledger-api');
  await expect.poll(async () => (await sidebarNames(page)).filter((name) => name.startsWith('ledger-api'))).toHaveLength(1);
  expect((await sidebarNames(page)).filter((name) => name.startsWith('billing-svc'))).toHaveLength(2);
  expect(await offered()).toBe(2);
  // Undo says no to that pair: it stands apart again and is not offered.
  await toast(page).getByRole('button', { name: 'Undo' }).click();
  await expect.poll(async () => (await sidebarNames(page)).filter((name) => name.startsWith('ledger-api'))).toHaveLength(2);
  await expect.poll(offered).toBe(2);

  // Both ticked: one toast, one Undo for both.
  await open();
  await page.locator('[data-tidy-go]').click();
  await expect(toast(page)).toContainText('Combined 2 projects');
  await expect.poll(() => sidebarNames(page)).toEqual(expect.arrayContaining(['acme', 'docs', 'docs-site', 'web-app', 'field-notes']));
  expect((await sidebarNames(page)).filter((name) => name.startsWith('billing-svc'))).toHaveLength(1);
  await expect(row(page, 'acme · workspaces')).toHaveCount(0);
  await page.mouse.move(1200, 800);
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(proofDir, '06-after-tidy-light.png') });
  await toast(page).getByRole('button', { name: 'Undo' }).click();
  await expect(toast(page)).toHaveCount(0);
  await expect.poll(async () => (await sidebarNames(page)).filter((name) => name.startsWith('billing-svc'))).toHaveLength(2);
  await expect(row(page, 'acme · workspaces')).toBeVisible();

  // Nothing is left to offer: no number on Tidy, no group.
  await expect.poll(offered).toBe(0);
  await page.reload();
  await page.locator('[data-tidy-menu]').first().click();
  await expect(page.locator('[data-tidy-menu-popup]')).toBeVisible();
  await expect(page.locator('[data-tidy-item] .ib-pmi-n')).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('a name several projects match: a button each, and Enter does not choose', async () => {
  const { page } = world;
  // Two projects read "billing-svc · …".
  await expect.poll(async () => (await sidebarNames(page)).filter((name) => name.startsWith('billing-svc'))).toHaveLength(2);

  await openRename(page, 'web-app');
  await page.keyboard.type('billing-svc');
  await expect(clash(page)).toContainText('billing-svc matches 2 projects. Combine with one?');
  await expect(clash(page).getByRole('button')).toHaveCount(3);
  await page.keyboard.press('Enter');
  await expect(field(page)).toBeFocused();
  await expect(row(page, 'web-app')).toHaveCount(0); // The field stands in for the row while it is open.
  await expect(live(page)).toHaveText('billing-svc matches 2 projects. Pick one to combine with, or press Escape to cancel.');
  await page.mouse.move(900, 700);
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(proofDir, '07-rename-several-light.png') });
  await page.keyboard.press('Escape');
  await expect(row(page, 'web-app')).toBeVisible();
  expect((await get('/api/inbox/projects')).projects.filter((project: { combined?: unknown[] }) => (project.combined?.length ?? 0) > 0)).toEqual([]);

  // The whole label names one, and the toast says the name it will have: alone in its group, it loses the parent.
  await openRename(page, 'web-app');
  await page.keyboard.type('billing-svc · code');
  await expect(clash(page)).toContainText('already exists. Combine them?');
  await page.keyboard.press('Enter');
  await expect(toast(page).locator('text=Combined into billing-svc')).toHaveText(/^Combined into billing-svc$/);
  await toast(page).getByRole('button', { name: 'Undo' }).click();
  await expect(row(page, 'web-app')).toBeVisible();
});

test('Settings: each folder keeps its size and says what Delete does', async () => {
  const { page, ids } = world;
  expect((await combine(ids.site, ids.docs)).status).toBe(200);
  await page.goto(`${world.url}/#settings/storage`);
  await expect(page.locator('[data-settings-section="storage"]')).toBeVisible();
  await page.getByRole('button', { name: /more projects/ }).click();
  await expect(page.locator('.ib-store-note', { hasText: 'In docs' })).toBeVisible();
  await expect(page.locator('.ib-store-note', { hasText: 'Deleting it leaves docs-site, as its own project' })).toBeVisible();
  await page.mouse.move(1200, 800);
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(proofDir, '08-settings-storage-light.png') });
  expect((await combine(ids.site, null)).status).toBe(200);
  expect(world.errors).toEqual([]);
});

test('the agent command: a combine shows in an open window, and an undo from another session, after a restart, brings back the threads, the card and the name', async () => {
  const { page, ids, threads, folders, dataDir } = world;
  const projects = (args: string[], session: string, cwd: string) =>
    spawnSync(binary, ['inbox', 'projects', ...args], { cwd, env: { ...world.env, PLANNOTATOR_SESSION_TAG: `claude-code:${session}` }, encoding: 'utf8', timeout: 60_000 });
  await page.goto(world.url);
  const renamed = await fetch(`${world.url}/api/inbox/projects/${ids.site}/name`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serverSession: await session(), name: 'Marketing site' }) });
  expect(renamed.status).toBe(200);
  await expect(row(page, 'Marketing site')).toBeVisible();

  const combined = projects(['combine', ids.site, '--into', ids.docs], 'ses-combiner-0001', folders.site);
  expect(combined.stderr).toBe('');
  expect(combined.status).toBe(0);
  expect(combined.stdout).toContain(`Combined Marketing site into docs. To undo: plannotator inbox projects undo ${ids.site}`);
  // The window that was open follows, with nothing to reload.
  await expect(row(page, 'Marketing site')).toHaveCount(0);
  await expect.poll(() => rowProject(page, threads.site)).toBe('docs');
  const sent = await world.agent.send({ project_path: folders.site, subject: 'While combined', thread: 'while-combined', body: 'A note from the combined folder.' });
  const card = await world.agent.card({ op: 'create', title: 'Landing page', project_path: folders.site, thread_id: sent.message_id });
  expect(await listedIn(sent.thread_id)).toBe('docs');

  // Later: another Inbox process, another session, a folder that is neither project.
  await stopScratchInbox(dataDir);
  const undone = projects(['undo', ids.site], 'ses-undoer-0002', dirname(dataDir));
  expect(undone.stderr).toBe('');
  expect(undone.status).toBe(0);
  expect(undone.stdout).toBe('Marketing site is its own project again.\n');
  rememberInboxOf(dataDir);
  world.url = (JSON.parse(spawnSync(binary, ['inbox', 'status', '--json'], { env: world.env, encoding: 'utf8' }).stdout) as { url: string }).url.replace(/\/$/, '');
  await world.agent.close().catch(() => {});
  world.agent = await SimAgent.connect({ binary, env: world.env, name: 'Claude Code', host: 'claude-code' });

  await page.goto(world.url);
  await expect(row(page, 'Marketing site')).toBeVisible();
  await expect.poll(() => rowProject(page, threads.site)).toBe('Marketing site');
  expect(await listedIn(sent.thread_id)).toBe('Marketing site');
  expect(await threadBodies(sent.thread_id)).toContain('A note from the combined folder.');
  const listed = await world.agent.card({ op: 'list', project_path: folders.site, asked_by: 'anyone' });
  expect(listed.cards.map((found: { id: string }) => found.id)).toContain(card.card.id);

  const reset = await fetch(`${world.url}/api/inbox/projects/${ids.site}/name`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serverSession: await session(), name: null }) });
  expect(reset.status).toBe(200);
  await expect(row(page, 'docs-site')).toBeVisible();
});

test('dark: the warning and the toast', async ({ browser }: { browser: Browser }) => {
  const { ids } = world;
  const context = await colored(browser, world.url, 'dark');
  const page = await context.newPage();
  await page.goto(world.url);
  await openRename(page, 'docs-site');
  await page.keyboard.type('docs');
  await expect(clash(page)).toBeVisible();
  await page.mouse.move(900, 700);
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(proofDir, '01-rename-warning-dark.png') });
  await page.keyboard.press('Enter');
  await expect(toast(page)).toContainText('Combined into docs');
  await page.mouse.move(900, 700);
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(proofDir, '02-after-combine-dark.png') });
  expect((await combine(ids.site, null)).status).toBe(200);
  await context.close();
});

test('a phone: the warning in the navigation sheet, 44 px buttons, Combine closes the sheet, Undo in the toast', async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true, colorScheme: 'light' });
  await context.addCookies([{ name: 'plannotator-theme', value: 'light', url: world.url }]);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(world.url);
  await page.locator('[data-sidebar="trigger"]').first().tap();
  const site = row(page, 'docs-site');
  await expect(site.locator('.ib-pmore')).toHaveCSS('opacity', '1');
  await site.locator('.ib-pmore').tap();
  await page.locator('[data-project-action="rename"]').tap();
  await expect(field(page)).toBeFocused();
  await field(page).fill('docs');
  await expect(clash(page)).toContainText('docs already exists. Combine them?');
  const combineButton = page.locator(`[data-project-combine="${world.ids.docs}"]`);
  await expect(combineButton).toBeInViewport();
  for (const button of [combineButton, page.locator('[data-project-combine-cancel]')]) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(proofDir, '09-phone-rename-warning.png') });

  await combineButton.tap();
  await expect(toast(page)).toContainText('Combined into docs');
  await expect(page.locator('.ib-projs .ib-name', { hasText: /^docs-site$/ })).toHaveCount(0);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(proofDir, '10-phone-after-combine.png') });

  await toast(page).getByRole('button', { name: 'Undo' }).tap();
  await expect(live(page)).toHaveText('Combine undone.');
  expect((await get('/api/inbox/projects')).projects.some((project: { id: string }) => project.id === world.ids.site)).toBe(true);
  expect(errors).toEqual([]);
  await context.close();
});
