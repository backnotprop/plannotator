/**
 * Remote launch in the window (approval "remote-launch", the picker's A): two compiled Inboxes, "MacBook" and
 * "Mac mini", each in its own scratch HOME and data dir under the test sandbox (Phones, Connect, notes and the update
 * check off, no browser), linked both ways through the real CLI pairing over loopback. Launch is on in both, and each
 * finds only its own fake `claude` (tests/helpers/fake-claude, through PLANNOTATOR_TEST_LAUNCH_PATH). A `tailscale`
 * stand-in fails any call.
 *
 * Driven through MacBook's real window:
 *  1. New message → New Claude Code session → the folder menu groups the projects by machine, billing-svc under both;
 *     picking Mac mini's infra makes To read "in infra · Mac mini"; Send starts the agent on Mac mini (its fake gets
 *     `--bg` in its own folder) and MacBook's fake starts nothing.
 *  2. Mac mini stopped: its last read still lists its projects ("Mac mini · asleep"); Send reads "Start when Mac mini
 *     is back" with the note; the Send is held, the toast says Claude Code starts on Mac mini when it's back, and
 *     Cancel takes it back (the outbox entry `cancelled`, nothing started).
 *
 * `RL_PICKER_SHOTS` saves the pictures (default /tmp/remote-launch-picker/build), 1440×900 and a 390 phone, light.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { installFakeClaude, type FakeClaude } from '../helpers/fake-claude';
import { inboxScratch, rememberInboxOf, removeInboxScratch, stopScratchInbox } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shots = resolve(process.env.RL_PICKER_SHOTS ?? '/tmp/remote-launch-picker/build');
const CLOSED = 'http://127.0.0.1:9';

interface Machine {
  name: string;
  root: string;
  dataDir: string;
  env: Record<string, string>;
  fake: FakeClaude;
  calls: string;
  id: string;
  url: string;
  projects: Record<string, string>;
}

function machine(name: string): Machine {
  const root = inboxScratch(`rl-pick-${name.replace(/\W/g, '').toLowerCase()}-`);
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const calls = join(root, 'tailscale-calls.txt');
  writeFileSync(join(bin, 'tailscale'), `#!/bin/sh\necho "tailscale $*" >> '${calls}'\nexit 1\n`);
  chmodSync(join(bin, 'tailscale'), 0o755);
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  const fake = installFakeClaude({ bin: join(root, 'fakes'), state: join(root, 'fake-claude'), config: { workMs: 60_000, hold: true } });
  // Launch on, and Plannotator's Claude Code plugin on in the sandbox's own agent home (launch needs its mod).
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ inboxLaunch: { enabled: true } }));
  markTourDecided(dataDir);
  mkdirSync(join(dataDir, 'agents-home', '.claude'), { recursive: true });
  writeFileSync(join(dataDir, 'agents-home', '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'plannotator@plannotator': true } }));
  const env = {
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: root,
    SHELL: fake.shell,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_TEST_SANDBOX: root,
    PLANNOTATOR_TEST_LAUNCH_PATH: `${join(root, 'fakes')}:/usr/bin:/bin`,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_BROWSER: '1',
    NO_ANON_PING: '1',
    PLANNOTATOR_MACHINE_NAME: name,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_INBOX_PHONES: '0',
    PLANNOTATOR_INBOX_NOTES: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_RELAY_URL: CLOSED,
    PLANNOTATOR_UPDATE_API_URL: `${CLOSED}/releases/latest`,
    PLANNOTATOR_INSTALL_SCRIPT_URL: `${CLOSED}/install.sh`,
    PLANNOTATOR_RELEASE_DOWNLOAD_URL: `${CLOSED}/download`,
    PLANNOTATOR_FEEDBACK_URL: `${CLOSED}/feedback`,
  };
  return { name, root, dataDir, env, fake, calls, id: '', url: '', projects: {} };
}

const cli = (m: Machine, ...args: string[]) => {
  const run = spawnSync(binary, ['inbox', ...args], { env: m.env, cwd: m.root, encoding: 'utf8', timeout: 60_000 });
  return { status: run.status ?? -1, out: run.stdout ?? '', err: run.stderr ?? '' };
};
const base = (m: Machine) => `http://127.0.0.1:${(JSON.parse(readFileSync(join(m.dataDir, 'inbox', 'inbox.json'), 'utf8')) as { port: number }).port}`;
const getJson = async (m: Machine, path: string) => (await (await fetch(`${base(m)}${path}`)).json()) as Record<string, any>;
const stateOf = async (m: Machine, other: Machine) => ((await getJson(m, '/api/inbox/machines')).machines as { id: string; state: string }[]).find((x) => x.id === other.id)?.state ?? null;

async function waitFor(what: string, check: () => Promise<boolean> | boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

function link(from: Machine, to: Machine): void {
  const offered = cli(to, 'link', '--offer');
  expect(offered.status, offered.err).toBe(0);
  const linked = cli(from, 'link', offered.out.trim(), '--address', base(to), '--back', base(from));
  expect(linked.status, linked.err).toBe(0);
}

/** An agent writes from `folder` (a git repository), so the folder is one of this machine's projects; trusted there. */
async function projectOn(m: Machine, name: string, body: string): Promise<string> {
  const folder = join(m.root, 'code', name);
  mkdirSync(folder, { recursive: true });
  spawnSync('/usr/bin/git', ['init', '-q'], { cwd: folder, env: { PATH: '/usr/bin:/bin', HOME: m.root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  const root = realpathSync(folder);
  const response = await fetch(`${base(m)}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'send_message', arguments: { body, project_path: root, agent_session: `ses-${m.name.replace(/\W/g, '')}-${name}`, agent_host: 'claude-code' } } }),
  });
  expect(response.status).toBe(200);
  await response.text();
  m.projects[name] = root;
  const trusted = Object.fromEntries(Object.values(m.projects).map((p) => [p, { hasTrustDialogAccepted: true }]));
  writeFileSync(join(m.dataDir, 'agents-home', '.claude.json'), JSON.stringify({ projects: trusted }));
  return root;
}

async function shot(page: Page, name: string): Promise<void> {
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(shots, `${name}.png`) });
}

let macbook: Machine;
let mini: Machine;
const contexts: BrowserContext[] = [];
const errors: string[] = [];

test.describe.configure({ mode: 'serial' });
// A step that cannot happen fails where it is, not at the test's end.
test.use({ actionTimeout: 20_000 });

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  mkdirSync(shots, { recursive: true });
  macbook = machine('MacBook');
  mini = machine('Mac mini');
  for (const m of [macbook, mini]) {
    const run = cli(m, '--background');
    rememberInboxOf(m.dataDir);
    expect(run.status, run.err).toBe(0);
    m.url = run.out.trim();
    m.id = (await getJson(m, '/api/inbox/health')).inbox_id;
    await fetch(`${base(m)}/api/inbox/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notifications: { dismissed: true } }) });
  }
  await projectOn(macbook, 'web-app', 'Swapped the hard-coded greys for tokens. Nothing for you to do.');
  await projectOn(macbook, 'billing-svc', 'The refund webhook tests pass again.');
  await projectOn(mini, 'billing-svc', 'Retry the 409 with the same key, or alert?');
  await projectOn(mini, 'infra', 'Rotated the staging certs. They are good for 90 days.');
  link(macbook, mini);
  await waitFor('MacBook sees Mac mini online', async () => (await stateOf(macbook, mini)) === 'online');
  await waitFor("MacBook's list holds Mac mini's rows", async () => JSON.stringify(await getJson(macbook, '/api/inbox/threads?machines=1')).includes('Rotated the staging certs'));
});

test.afterAll(async () => {
  try {
    for (const context of contexts) await context.close().catch(() => {});
    for (const m of [macbook, mini]) {
      m?.fake.stopAll();
      // Nothing here may change the system's Tailscale.
      if (m) expect(existsSync(m.calls)).toBe(false);
    }
  } finally {
    await removeInboxScratch();
  }
});

async function window(browser: Browser, phone: boolean): Promise<Page> {
  const context = phone
    ? await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: 'light' })
    : await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light' });
  contexts.push(context);
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(macbook.url);
  await expect(page.locator('[data-open-compose]:visible').first()).toBeVisible();
  return page;
}

const dialog = (page: Page) => page.locator('dialog[data-compose]');

/** New message → To → New Claude Code session → words → the folder menu, open once Mac mini's group is in. */
async function openFolderMenu(page: Page, words: string, wantGroup: string): Promise<void> {
  // The one-time "Add the note to Claude Code?" dialog may open once compose has closed: not what this is about.
  const note = page.locator('[data-dialog="agent-note"]');
  if (await note.isVisible().catch(() => false)) await note.getByRole('button', { name: 'Not now' }).click();
  await page.locator('[data-open-compose]:visible').first().click();
  const d = dialog(page);
  await expect(d).toBeVisible();
  await d.getByRole('textbox', { name: 'Message' }).fill(words);
  await d.getByRole('textbox', { name: 'Thread name' }).fill('Staging certs');
  await d.locator('[data-compose-to]').click();
  await d.locator('[data-compose-start="claude-code"]').click();
  // Mac mini's read lands on its own; the menu shows it once it is in.
  await expect
    .poll(async () => {
      await d.locator('[data-compose-folder]').click();
      const has = await page.locator(`[data-compose-folder-group="${mini.id}"]`).filter({ hasText: wantGroup }).count();
      if (!has) await page.keyboard.press('Escape');
      return has;
    }, { timeout: 20_000 })
    .toBe(1);
}

test('1. the folder menu groups projects by machine; a Mac mini project starts Claude Code on Mac mini', async ({ browser }) => {
  const page = await window(browser, false);
  const phone = await window(browser, true);
  // The phone first, so both windows have read Mac mini while it is awake.
  await openFolderMenu(phone, 'The staging certs expire in a week. Rotate them and update the three cron jobs that read them.', 'Mac mini');
  await shot(phone, 'menu-390');
  await phone.locator(`[data-compose-folder-option][data-compose-folder-machine="${mini.id}"]`).filter({ hasText: 'infra' }).click();
  await shot(phone, 'to-line-390');
  await phone.locator('[data-compose-cancel]').click();
  await dialog(phone).locator('[data-compose-discard]').click();

  await openFolderMenu(page, 'The staging certs expire in a week. Rotate them and update the three cron jobs that read them.', 'Mac mini');
  const groups = page.locator('[data-compose-folder-group]');
  await expect(groups).toHaveText(['MacBook · this computer', 'Mac mini']);
  // billing-svc is on both machines: it shows under each.
  await expect(page.locator('[data-compose-folder-option]').filter({ hasText: 'billing-svc' })).toHaveCount(2);
  await shot(page, 'menu-1440');
  await page.locator(`[data-compose-folder-option][data-compose-folder-machine="${mini.id}"]`).filter({ hasText: 'infra' }).click();
  const folder = dialog(page).locator('[data-compose-folder]');
  await expect(folder.locator('bdi').first()).toHaveText('infra');
  await expect(folder.locator(`[data-compose-machine="${mini.id}"]`)).toHaveText('· Mac mini');
  await shot(page, 'to-line-1440');

  const here = macbook.fake.starts().length;
  const answer = page.waitForResponse((r) => r.url().endsWith(`/api/inbox/m/${mini.id}/messages`) && r.request().method() === 'POST');
  await dialog(page).locator('[data-compose-send]').click();
  expect((await answer).status()).toBe(200);
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.locator('.ib-toast')).toContainText('in infra · Mac mini');
  await waitFor('--bg on Mac mini in its own infra folder', () => mini.fake.starts().some((s) => s.cwd === mini.projects.infra && s.argv.includes('--bg')));
  expect(macbook.fake.starts().length).toBe(here);
  await shot(page, 'sent-1440');
});

test("2. Mac mini asleep: Send waits for it, the toast says so, and Cancel takes it back", async () => {
  const [desktop, phone] = contexts.map((c) => c.pages()[0]!);
  const startsBefore = mini.fake.starts().length;
  await stopScratchInbox(mini.dataDir);
  await waitFor('MacBook sees Mac mini asleep', async () => (await stateOf(macbook, mini)) === 'offline');

  // The phone: the asleep compose (no Send).
  await openFolderMenu(phone!, 'Rotate the staging database password and update the three cron jobs that read it.', 'asleep');
  await phone!.locator(`[data-compose-folder-option][data-compose-folder-machine="${mini.id}"]`).filter({ hasText: 'infra' }).click();
  await expect(dialog(phone!).locator('[data-compose-send]')).toContainText('Start when Mac mini is back');
  await shot(phone!, 'asleep-390');

  const page = desktop!;
  // The earlier "Starting Claude Code" toast is not this picture's.
  await page.locator('.ib-toast [data-toast-dismiss]').click({ timeout: 2000 }).catch(() => {});
  await openFolderMenu(page, 'Rotate the staging database password and update the three cron jobs that read it.', 'asleep');
  // The person started an agent on Mac mini last: its group leads, its last project first.
  await expect(page.locator('[data-compose-folder-group]')).toHaveText(['Mac mini · asleep', 'MacBook · this computer']);
  await expect(page.locator('[data-compose-folder-option]').first()).toContainText('infra · you started it here last');
  await shot(page, 'menu-asleep-1440');
  await page.locator(`[data-compose-folder-option][data-compose-folder-machine="${mini.id}"]`).filter({ hasText: 'infra' }).click();
  const d = dialog(page);
  await expect(d.locator('[data-compose-send]')).toContainText('Start when Mac mini is back');
  await expect(d.locator('[data-compose-note="asleep"]')).toContainText("Your message waits here, and Claude Code starts on Mac mini when it's back. You can cancel it until then.");
  await shot(page, 'asleep-1440');

  const held = page.waitForResponse((r) => r.url().endsWith(`/api/inbox/m/${mini.id}/messages`) && r.request().method() === 'POST');
  await d.locator('[data-compose-send]').click();
  expect((await held).status()).toBe(202);
  await expect(d).toHaveCount(0);
  const toast = page.locator('.ib-toast');
  await expect(toast).toContainText("Claude Code starts on Mac mini when it's back");
  await shot(page, 'toast-1440');
  const cancel = page.waitForResponse((r) => /\/api\/inbox\/outbox\/[^/]+\/cancel$/.test(r.url()));
  await toast.locator('[data-toast-action]').click();
  expect((await cancel).status()).toBe(200);
  await expect(page.locator('.ib-toast')).toContainText('Cancelled. Nothing was sent; your words are in Drafts.');
  await shot(page, 'cancelled-1440');
  const outbox = await getJson(macbook, '/api/inbox/outbox');
  expect((outbox.waiting as unknown[]).length).toBe(0);
  expect(mini.fake.starts().length).toBe(startsBefore);
  expect(errors).toEqual([]);
});
