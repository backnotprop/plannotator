/**
 * Update on a linked machine (approval "inbox-machine-update"), proved in a real browser against compiled Inboxes on
 * loopback, linked through the real CLI pairing. Studio is the window's. Mini runs the same code stamped older and is
 * installed where the install script puts it, so it owns its copy. A local stand-in plays GitHub and the install
 * script; the stand-in installer only ever touches Mini's scratch HOME.
 *
 *  1. The word beside a machine that is behind, in the sidebar and in Settings: a press opens the dialog, not the filter.
 *  2. Asleep: the word stays, the dialog says so, and there is nothing to press.
 *  3. An install that exits 0 and changes nothing says so; a failed one says why, with the log as `~/…`.
 *  4. Try Again, end to end, with an install script that runs on after it swaps the binary: Updating, Restarting, Updated,
 *     never Restart, and the link and its threads survive.
 *  5. An older machine, when PLANNOTATOR_E2E_OLDER_BINARY names a real release from before the route: the by-hand
 *     dialog; Snooze says why and opens it; the dialog's full-path line works in a shell with no PATH to it, the way
 *     `ssh host 'command'` runs; then the word goes and Snooze works, with no reload.
 *
 * Every step fails if the "Tell your agents" dialog shows. Builds its own two stamped binaries; the Inbox's dist must be
 * built first (see inbox.spec.ts).
 */

import { expect, test, type Browser, type BrowserContext, type Page } from './inbox-test';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, rememberInboxOf, removeInboxScratch, stopScratchInbox } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const older = process.env.PLANNOTATOR_E2E_OLDER_BINARY ? resolve(process.env.PLANNOTATOR_E2E_OLDER_BINARY) : null;
const NEW = (JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as { version: string }).version;
const BEHIND = '0.28.40';
const CLOSED = 'http://127.0.0.1:9';

/** A stand-in for install.sh that only replaces $HOME/.local/bin/plannotator, as told by a file in that scratch HOME. */
const INSTALLER = `#!/bin/bash
REPO="backnotprop/plannotator"
sleep "$(cat "$HOME/installer-sleep" 2>/dev/null || echo 0)"
case "$(cat "$HOME/installer-mode" 2>/dev/null || echo ok)" in
  fail) echo "curl: (22) The requested URL returned error: 500"; exit 1 ;;
  same) exit 0 ;;
esac
cp "$(cat "$HOME/installer-binary")" "$HOME/.local/bin/plannotator.new"
mv -f "$HOME/.local/bin/plannotator.new" "$HOME/.local/bin/plannotator"
# What install.sh does after the swap: skills, plugins, downloads.
sleep "$(cat "$HOME/installer-tail" 2>/dev/null || echo 0)"
`;

interface Machine {
  name: string;
  root: string;
  dataDir: string;
  installed: string;
  env: Record<string, string>;
  id: string;
}

let builds: string;
let studio: Machine;
let mini: Machine;
let mirror: Server;
let mirrorUrl = '';
let context: BrowserContext;
let page: Page;
const agents: SimAgent[] = [];
const errors: string[] = [];

function build(version: string, name: string): string {
  const out = join(builds, name);
  const run = spawnSync('bun', ['build', 'apps/hook/server/index.ts', '--compile', '--define', `__CLI_VERSION__="${version}"`, '--outfile', out], { cwd: repo, encoding: 'utf8', timeout: 180_000 });
  expect(run.status, run.stderr).toBe(0);
  return out;
}

function machine(name: string, bin: string): Machine {
  const root = inboxScratch(`plannotator-machine-update-${name.toLowerCase()}-`);
  for (const dir of ['bin', 'tmp', '.local/bin']) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, 'bin', 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(root, 'bin', 'tailscale'), 0o755);
  const installed = join(root, '.local/bin/plannotator');
  copyFileSync(bin, installed);
  chmodSync(installed, 0o755);
  writeFileSync(join(root, 'installer-binary'), join(builds, 'new'));
  const dataDir = join(root, 'data');
  return {
    name,
    root,
    dataDir,
    installed,
    id: '',
    env: {
      PATH: `${join(root, 'bin')}:/usr/bin:/bin`,
      HOME: root,
      TMPDIR: join(root, 'tmp'),
      PLANNOTATOR_DATA_DIR: dataDir,
      PLANNOTATOR_TEST_SANDBOX: root,
      PLANNOTATOR_BROWSER: NO_BROWSER,
      PLANNOTATOR_MACHINE_NAME: name,
      PLANNOTATOR_INBOX_CONNECT: '0',
      PLANNOTATOR_INBOX_PHONES: '0',
      PLANNOTATOR_INBOX_NOTES: '0',
      PLANNOTATOR_UPDATE_CHECK: '0',
      NO_ANON_PING: '1',
      PLANNOTATOR_MINIMAL: '1',
      PLANNOTATOR_SKIP_SEM_INSTALL: '1',
      PLANNOTATOR_SKIP_AGENT_TERMINAL_INSTALL: '1',
      PLANNOTATOR_RELAY_URL: CLOSED,
      PLANNOTATOR_FEEDBACK_URL: `${CLOSED}/feedback`,
      PLANNOTATOR_UPDATE_API_URL: `${mirrorUrl}/api/latest`,
      PLANNOTATOR_INSTALL_SCRIPT_URL: `${mirrorUrl}/install.sh`,
      PLANNOTATOR_RELEASE_DOWNLOAD_URL: `${mirrorUrl}/dl`,
    },
  };
}

const cli = (m: Machine, ...args: string[]) => {
  const run = spawnSync(m.installed, ['inbox', ...args], { env: m.env, cwd: m.root, encoding: 'utf8', timeout: 60_000 });
  return { status: run.status ?? -1, out: run.stdout ?? '', err: run.stderr ?? '' };
};
const registry = (m: Machine) => JSON.parse(readFileSync(join(m.dataDir, 'inbox', 'inbox.json'), 'utf8')) as { port: number; pid: number };
const base = (m: Machine) => `http://127.0.0.1:${registry(m).port}`;
const read = async <T>(m: Machine, path: string): Promise<T> => (await (await fetch(`${base(m)}${path}`)).json()) as T;

async function start(m: Machine): Promise<void> {
  const run = cli(m, '--background');
  rememberInboxOf(m.dataDir);
  expect(run.status, run.err).toBe(0);
  await expect.poll(async () => (m.id = (await read<{ inbox_id: string }>(m, '/api/inbox/health').catch(() => ({ inbox_id: '' }))).inbox_id), { timeout: 15_000 }).not.toBe('');
}

function link(from: Machine, to: Machine): void {
  const offered = cli(to, 'link', '--offer');
  expect(offered.status, offered.err).toBe(0);
  const linked = cli(from, 'link', offered.out.trim(), '--address', base(to), '--back', base(from));
  expect(linked.status, linked.err).toBe(0);
}

const rowOf = async (other: Machine) => (await read<{ machines: { id: string; state: string; version: string | null; update: { phase: string } | null }[] }>(studio, '/api/inbox/machines')).machines.find((m) => m.id === other.id);
const dlg = (name: string) => page.locator(`[data-dialog="${name}"]`);
const word = (m: Machine) => page.locator('.ib-mside').filter({ has: page.locator(`[data-machine="${m.id}"]`) }).locator('.ib-mthing');
const installer = (m: Machine, mode: string, sleep = 0) => {
  writeFileSync(join(m.root, 'installer-mode'), mode);
  writeFileSync(join(m.root, 'installer-sleep'), String(sleep));
};

async function asked(m: Machine, subject: string): Promise<string> {
  const agent = await SimAgent.connect({ binary: m.installed, env: m.env, name: 'Claude Code', host: 'claude-code', cwd: m.root });
  agents.push(agent);
  const body = [subject, '', ':::question', subject, '', '- [ ] Yes', '- [ ] No', ':::'].join('\n');
  return (await agent.send({ project_path: scratchProject(join(m.root, 'code'), 'billing-svc'), subject, body })).thread_id as string;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  test.setTimeout(420_000);
  builds = inboxScratch('plannotator-machine-update-builds-');
  mirror = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/install.sh') return void res.end(INSTALLER);
    if (path.endsWith('.sha256')) return void res.end(`${'e'.repeat(64)}  ${path.split('/').pop()!.replace('.sha256', '')}\n`);
    if (path.startsWith('/api')) {
      res.setHeader('content-type', 'application/json');
      return void res.end(JSON.stringify({ tag_name: `v${NEW}`, body: '', html_url: `${mirrorUrl}/release`, published_at: '2026-11-01T00:00:00Z' }));
    }
    res.statusCode = 404;
    res.end('not found');
  });
  await new Promise<void>((done) => mirror.listen(0, '127.0.0.1', done));
  mirrorUrl = `http://127.0.0.1:${(mirror.address() as AddressInfo).port}`;

  const current = build(NEW, 'new');
  const behind = build(BEHIND, 'behind');
  studio = machine('Studio', current);
  mini = machine('Mini', behind);
  for (const m of [studio, mini]) await start(m);
  link(studio, mini);
  await expect.poll(async () => (await rowOf(mini))?.update?.phase, { timeout: 20_000 }).toBe('behind');
  // An agent waiting on each machine: the sidebar names a machine (and shows its word) only while agents show from
  // more than one machine.
  await asked(studio, 'Which region for the new bucket');
  await asked(mini, 'Which queue for the retries');

  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  await context.grantPermissions(['notifications'], { origin: base(studio) });
  page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base(studio));
});

test.afterEach(async () => {
  await expect(page.getByText('Tell your agents', { exact: false })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test.afterAll(async () => {
  try {
    for (const agent of agents) await agent.close().catch(() => {});
    await context?.close();
    await new Promise((done) => (mirror ? mirror.close(done) : done(null)));
  } finally {
    await removeInboxScratch();
  }
});

test('1. the word beside a machine that is behind opens the dialog, in the sidebar and in Settings, and never filters', async () => {
  await expect(word(mini)).toHaveText('Update');
  const hash = await page.evaluate(() => location.hash);
  await word(mini).click();
  const dialog = dlg('machine-update');
  await expect(dialog.getByRole('heading')).toContainText(`Update Mini to ${NEW}`);
  expect(await page.evaluate(() => location.hash)).toBe(hash);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  // Cancel changed nothing there.
  expect((await rowOf(mini))?.update?.phase).toBe('behind');

  await page.goto(`${base(studio)}/#settings/machines`);
  await page.locator('[data-machine-update="update"]').click();
  await expect(dlg('machine-update')).toBeVisible();
  await dlg('machine-update').getByRole('button', { name: 'Cancel' }).click();
  await page.goto(`${base(studio)}/#`);
});

test('2. asleep: the word stays, the dialog says so, and there is nothing to press', async () => {
  await stopScratchInbox(mini.dataDir);
  await expect.poll(async () => (await rowOf(mini))?.state, { timeout: 20_000 }).toBe('offline');
  await expect(word(mini)).toHaveText('Update');
  await word(mini).click();
  const dialog = dlg('machine-update-asleep');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-machine-update-now]')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Close' }).click();
  await start(mini);
  await expect.poll(async () => (await rowOf(mini))?.state, { timeout: 30_000 }).toBe('online');
});

test('3. an install that exits 0 and changes nothing says so; a failed one says why, and no name crosses', async () => {
  installer(mini, 'same');
  await word(mini).click();
  await dlg('machine-update').locator('[data-machine-update-now]').click();
  const unchanged = dlg('machine-update-unchanged');
  await expect(unchanged).toBeVisible({ timeout: 30_000 });
  await expect(unchanged).toContainText(`still on ${BEHIND}`);
  await expect(word(mini)).toHaveText('Failed');
  expect(readFileSync(mini.installed).length).toBe(readFileSync(join(builds, 'behind')).length);

  installer(mini, 'fail');
  await unchanged.getByRole('button', { name: 'Try Again' }).click();
  const failed = dlg('failed');
  await expect(failed).toBeVisible({ timeout: 30_000 });
  await expect(failed).toContainText('on Mini');
  await expect(failed.locator('.ib-cmd code').first()).toHaveText(/^~\//);
  expect(await failed.textContent()).not.toContain(mini.root);
  // Nor anywhere in what that machine's answer brought here.
  expect(await (await fetch(`${base(studio)}/api/inbox/machines/${mini.id}/update`)).text()).not.toContain(mini.root);
});

test('4. Try Again, end to end, with an install that runs on after the swap: Updating, Restarting, Updated, never Restart; the link and its threads survive', async () => {
  const thread = await asked(mini, 'Which backup window');
  const pid = registry(mini).pid;
  installer(mini, 'ok', 3);
  writeFileSync(join(mini.root, 'installer-tail'), '8');
  // Everything the word and the dialog said from the press on, in order, by the frame.
  await page.evaluate((id) => {
    const seen: string[] = [];
    (window as unknown as { machineFlow: string[] }).machineFlow = seen;
    const look = () => {
      const word = [...document.querySelectorAll('.ib-mside')].find((row) => row.querySelector(`[data-machine="${id}"]`))?.querySelector('.ib-mthing')?.textContent ?? '';
      const open = document.querySelector('[data-dialog]');
      const line = `${word} | ${open?.getAttribute('data-dialog') ?? ''} | ${open?.querySelector('h2')?.textContent?.trim() ?? ''}`;
      if (seen[seen.length - 1] !== line) seen.push(line);
      requestAnimationFrame(look);
    };
    look();
  }, mini.id);
  await dlg('failed').getByRole('button', { name: 'Try Again' }).click();
  await expect(dlg('machine-update-progress')).toContainText('Updating Mini', { timeout: 15_000 });
  await expect(word(mini)).toHaveText('Updating');
  // It follows the machine, in the same dialog, to the end.
  await expect(dlg('machine-update-done')).toContainText(`Mini is on ${NEW}`, { timeout: 90_000 });
  await expect(word(mini)).toHaveText('Updated');
  const flow = await page.evaluate(() => (window as unknown as { machineFlow: string[] }).machineFlow);
  const words = flow.map((line) => line.split(' | ')[0]!).filter((said, i, all) => said !== all[i - 1]);
  expect(words, flow.join('\n')).toEqual(['Failed', 'Updating', 'Restarting', 'Updated']);
  expect(flow.filter((line) => line.includes('machine-update-ready') || line.includes('Restart the Inbox')), flow.join('\n')).toEqual([]);
  expect(flow.some((line) => line.includes('machine-update-progress') && line.includes(`Mini is restarting on ${NEW}`)), flow.join('\n')).toBe(true);
  expect(registry(mini).pid).not.toBe(pid);
  expect((await read<{ version: string }>(mini, '/api/inbox/health')).version).toBe(NEW);
  expect(spawnSync(mini.installed, ['--version'], { env: mini.env, encoding: 'utf8' }).stdout).toContain(NEW);
  await dlg('machine-update-done').getByRole('button', { name: 'Done' }).click();
  await expect.poll(async () => (await rowOf(mini))?.state, { timeout: 20_000 }).toBe('online');
  await page.reload();
  await expect(page.locator(`.ib-lbody [data-thread-id="${thread}"]`)).toBeVisible({ timeout: 20_000 });
});

test("5. an older machine: by hand this once; Snooze says why and opens it; the dialog's full path works with no PATH to it; then the word goes and Snooze works", async () => {
  test.skip(!older, 'PLANNOTATOR_E2E_OLDER_BINARY names a real release from before this route');
  const old = machine('Attic', older!);
  await start(old);
  link(studio, old);
  await expect.poll(async () => (await rowOf(old))?.update?.phase, { timeout: 20_000 }).toBe('behind');
  const thread = await asked(old, 'Attic disk is full');
  await page.reload();
  const row = page.locator(`.ib-lbody [data-thread-id="${thread}"]`);
  await expect(row).toBeVisible({ timeout: 20_000 });

  // The word, on a machine that cannot take the press.
  await expect(word(old)).toHaveText('Update');
  await word(old).click();
  const dialog = dlg('machine-update-too-old');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-machine-update-now]')).toHaveCount(0);
  await expect(dialog).not.toContainText('Snooze');
  await dialog.getByRole('button', { name: 'Close' }).click();

  // Snooze stays on its row and opens the same dialog, with why.
  await row.click({ button: 'right' });
  await page.locator(`[data-row-menu="${thread}"] [data-snooze-blocked]`).click();
  await expect(dialog).toContainText('Snooze needs a newer Plannotator on Attic');
  const lines = await dialog.locator('.ib-cmd code').allTextContents();
  expect(lines).toHaveLength(3);
  await dialog.getByRole('button', { name: 'Close' }).click();

  // That line, exactly as drawn, where `plannotator` is not on PATH: what `ssh host 'command'` runs on a stock shell.
  const shellEnv = { ...old.env, PATH: '/usr/bin:/bin', PLANNOTATOR_TEST_SANDBOX: old.root };
  expect(spawnSync('/bin/bash', ['-c', 'command -v plannotator'], { env: shellEnv }).status).not.toBe(0);
  // Not spawnSync: the stand-in for GitHub answers from this process.
  const ran = await new Promise<{ status: number | null; out: string }>((done) => {
    const child = spawn('/bin/bash', ['-c', lines[1]!], { env: shellEnv, cwd: old.root });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (out += chunk));
    child.on('close', (status) => done({ status, out }));
  });
  expect(ran.status, ran.out).toBe(0);
  await expect.poll(async () => (await read<{ version: string }>(old, '/api/inbox/health').catch(() => ({ version: '' }))).version, { timeout: 60_000 }).toBe(NEW);

  // Nothing to update now, and the real Snooze is back with no reload.
  await expect.poll(async () => (await rowOf(old))?.update ?? null, { timeout: 30_000 }).toBeNull();
  await expect(word(old)).toHaveCount(0);
  await row.click({ button: 'right' });
  const menu = page.locator(`[data-row-menu="${thread}"]`);
  await expect(menu.locator('[data-row-action="snooze"]')).toBeVisible();
  await expect(menu.locator('[data-snooze-blocked]')).toHaveCount(0);
  await page.keyboard.press('Escape');
});
