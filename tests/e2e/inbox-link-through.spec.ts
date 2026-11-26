/**
 * Link two computers through a third ("Link two computers through a third" in docs/agent-guides/inbox-machines.md),
 * in a real browser against three compiled Inboxes on loopback. Studio is linked to Laptop and to Mini through the
 * real CLI pairing; Laptop and Mini are not linked to each other.
 *
 *  1. Studio's Settings → Machines offers "Laptop and Mini" with Link; Laptop's offers "Mini · through Studio".
 *  2. One click on Link in Studio's window: Laptop and Mini hold a direct link to each other, both ways, as a link
 *     by hand makes it; the rows go, and Mini is an ordinary linked row on Laptop. Studio keeps none of their tokens.
 *  3. On Laptop, in its own agent's thread, `@` lists Mini's agent ("Claude Code (Mini)"), and Send wakes it on Mini.
 *
 * Pictures (whole window; 1440×900 and 390×844; light and dark) land in PLANNOTATOR_LINK_THROUGH_SHOTS, else
 * .local/proof/link-through/ (CI keeps .local/proof/ as the shard's "inbox-window-proof" artifact).
 * Build the binary first (see inbox.spec.ts).
 */

import { expect, test, type Browser, type BrowserContext, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';
import type { InboxReplyCommand } from '../../packages/shared/inbox/connection';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shots = resolve(process.env.PLANNOTATOR_LINK_THROUGH_SHOTS ?? join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'link-through'));
const CLOSED = 'http://127.0.0.1:9';
/** Mini's Claude Code session. */
const MINI_AGENT = '5c2e8a1d-3b4f-4e60-9a71-82c3d4e5f6a7';

interface Machine {
  name: string;
  dataDir: string;
  root: string;
  env: Record<string, string>;
  id: string;
  url: string;
}

let studio: Machine;
let laptop: Machine;
let mini: Machine;
let context: BrowserContext;
let page: Page;
const errors: string[] = [];
const agents: SimAgent[] = [];
const pollers: Poller[] = [];

function machine(name: string): Machine {
  const root = inboxScratch(`plannotator-link-through-${name.toLowerCase()}-`);
  const path = join(root, 'bin');
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'tailscale'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(path, 'tailscale'), 0o755);
  const dataDir = join(root, 'data');
  mkdirSync(join(root, 'tmp'), { recursive: true });
  return {
    name,
    root,
    dataDir,
    id: '',
    url: '',
    env: {
      PATH: `${path}:/usr/bin:/bin`,
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
      PLANNOTATOR_RELAY_URL: CLOSED,
      PLANNOTATOR_UPDATE_API_URL: `${CLOSED}/releases/latest`,
      PLANNOTATOR_INSTALL_SCRIPT_URL: `${CLOSED}/install.sh`,
      PLANNOTATOR_RELEASE_DOWNLOAD_URL: `${CLOSED}/download`,
      PLANNOTATOR_FEEDBACK_URL: `${CLOSED}/feedback`,
    },
  };
}

const cli = (m: Machine, ...args: string[]) => {
  const run = spawnSync(binary, ['inbox', ...args], { env: m.env, cwd: m.root, encoding: 'utf8', timeout: 60_000 });
  return { status: run.status ?? -1, out: run.stdout ?? '', err: run.stderr ?? '' };
};
const registry = (m: Machine) => JSON.parse(readFileSync(join(m.dataDir, 'inbox', 'inbox.json'), 'utf8')) as { port: number; token: string };
const base = (m: Machine) => `http://127.0.0.1:${registry(m).port}`;
const read = async <T>(m: Machine, path: string): Promise<T> => (await (await fetch(`${base(m)}${path}`)).json()) as T;
type MachineRow = { id: string; state: string; both_ways: boolean; marks?: string[]; self: boolean; link_through?: { pairs: unknown[]; through: { id: string }[] } };
const machinesOf = async (viewer: Machine) => (await read<{ machines: MachineRow[] }>(viewer, '/api/inbox/machines')).machines;
const rowOf = async (viewer: Machine, other: Machine) => (await machinesOf(viewer)).find((x) => x.id === other.id);
const marksOf = async (viewer: Machine, other: Machine) => (await rowOf(viewer, other))?.marks ?? [];
const linksFile = (m: Machine) => JSON.parse(readFileSync(join(m.dataDir, 'inbox', 'machines.json'), 'utf8')) as { links: { id: string; token: string }[] };

async function start(m: Machine): Promise<void> {
  const run = cli(m, '--background');
  rememberInboxOf(m.dataDir);
  expect(run.status, run.err).toBe(0);
  m.url = run.out.trim();
  await expect.poll(async () => (m.id = (await read<{ inbox_id: string }>(m, '/api/inbox/health').catch(() => ({ inbox_id: '' }))).inbox_id), { timeout: 15_000 }).not.toBe('');
}

/** A link by hand, as the person makes it: `to`'s code, pasted on `from`. */
function link(from: Machine, to: Machine): void {
  const offered = cli(to, 'link', '--offer');
  expect(offered.status, offered.err).toBe(0);
  const linked = cli(from, 'link', offered.out.trim(), '--address', base(to), '--back', base(from));
  expect(linked.status, linked.err).toBe(0);
}

/** A live agent's connection on `m`: it polls its own Inbox's bridge with tags on and keeps every command it is handed. */
class Poller {
  readonly commands: InboxReplyCommand[] = [];
  private stopped = true;
  private loop: Promise<void> = Promise.resolve();
  constructor(
    readonly m: Machine,
    readonly session: string,
    readonly host: string,
    readonly project: string,
  ) {
    pollers.push(this);
  }
  private async bridge(path: string, body: Record<string, unknown>): Promise<Response> {
    const { port, token } = registry(this.m);
    return fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  }
  start(): void {
    this.stopped = false;
    this.loop = (async () => {
      while (!this.stopped) {
        try {
          const answer = await this.bridge('/api/inbox/bridge/poll', { session: this.session, host: this.host, waitMs: 2_000, tags: true, project_path: this.project });
          const { commands = [] } = answer.ok ? ((await answer.json()) as { commands?: InboxReplyCommand[] }) : {};
          for (const command of commands) {
            if (this.commands.some((c) => c.id === command.id)) continue;
            this.commands.push(command);
            await this.bridge('/api/inbox/bridge/event', { session: this.session, host: this.host, type: 'delivered', id: command.id });
          }
          if (!answer.ok) await new Promise((done) => setTimeout(done, 300));
        } catch {
          await new Promise((done) => setTimeout(done, 300));
        }
      }
    })();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    await this.loop;
  }
}

async function quiet(target: Page): Promise<void> {
  // The notifications band (headless Chrome reports them blocked) is not what these pictures are about.
  const band = target.getByRole('region', { name: 'Desktop notifications' }).getByRole('button', { name: 'Hide' });
  if (await band.isVisible().catch(() => false)) await band.click();
  await target.mouse.move(1, 1).catch(() => {});
  await target.evaluate(() => Promise.all(document.getAnimations().filter((m) => m.effect?.getTiming().iterations !== Infinity).map((m) => m.finished.catch(() => {}))));
}

/** The whole window, light then dark. */
async function shot(target: Page, name: string): Promise<void> {
  await quiet(target);
  for (const scheme of ['light', 'dark'] as const) {
    await target.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await target.waitForTimeout(250);
    await target.screenshot({ path: join(shots, `${name}-${scheme}.png`) });
  }
  await target.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

/** The same screen on a phone at 390 px, light and dark: `ready` brings it to what the picture shows. */
async function phoneShot(browser: Browser, m: Machine, hash: string, name: string, ready: (p: Page) => Promise<void>): Promise<void> {
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'light' });
  try {
    const p = await phone.newPage();
    p.on('pageerror', (error) => errors.push(error.message));
    await p.goto(`${m.url}${hash}`);
    await ready(p);
    await shot(p, `${name}-phone`);
  } finally {
    await phone.close();
  }
}

/** Open a thread on `m` and its reply box, empty. */
async function openReply(on: Page, m: Machine, threadId: string) {
  await on.goto(`${m.url}#thread=${threadId}`);
  const pane = on.locator('section.ib-pane');
  await expect(pane.locator('h2.ib-subject')).toBeVisible({ timeout: 20_000 });
  const box = pane.getByRole('textbox', { name: /^Reply to/ });
  const reply = pane.locator('.ib-pfoot').getByRole('button', { name: /^Reply$|Edit draft$/ });
  for (let attempt = 0; attempt < 10 && !(await box.isVisible()); attempt += 1) await reply.click({ timeout: 1_000 }).catch(() => {});
  await expect(box).toBeVisible();
  await box.fill('');
  return box;
}

/** Type `@` until Mini's agent is listed (Laptop reads Mini's agents a moment after the link). */
async function tagList(on: Page, box: ReturnType<Page['getByRole']>) {
  await expect(async () => {
    await box.fill('');
    await box.pressSequentially('@');
    await expect(on.locator(`[data-tag-option="${MINI_AGENT}"]`)).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 45_000 });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  mkdirSync(shots, { recursive: true });
  studio = machine('Studio');
  laptop = machine('Laptop');
  mini = machine('Mini');
  await start(studio);
  await start(laptop);
  await start(mini);
  link(studio, laptop);
  link(studio, mini);
  for (const [viewer, other] of [[studio, laptop], [studio, mini], [laptop, studio], [mini, studio]] as const) {
    await expect.poll(() => marksOf(viewer, other), { timeout: 30_000 }).toContain('link-through');
  }
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
});

test.afterAll(async () => {
  try {
    for (const poller of pollers) await poller.stop().catch(() => {});
    for (const agent of agents) await agent.close().catch(() => {});
    await context?.close();
  } finally {
    await removeInboxScratch();
  }
});

test('1. Studio offers "Laptop and Mini"; Laptop offers "Mini · through Studio"', async ({ browser }: { browser: Browser }) => {
  test.setTimeout(180_000);
  // Studio's: the two are linked to it, not to each other.
  await page.goto(`${studio.url}#settings/machines`);
  const pair = page.locator('[data-link-through^="pair:"]');
  await expect(pair).toHaveCount(1, { timeout: 30_000 });
  await expect(pair.locator('.ib-l')).toHaveText('Laptop and Mini');
  await expect(pair.locator('.ib-desc')).toHaveText('Linked here, not to each other');
  await expect(pair.locator('button')).toHaveCount(1);
  await shot(page, '01-offer-on-studio');
  await phoneShot(browser, studio, '#settings/machines', '01-offer-on-studio', async (p) => {
    await expect(p.locator('[data-link-through^="pair:"] .ib-l')).toHaveText('Laptop and Mini', { timeout: 30_000 });
  });

  // Laptop's: Mini, reached through Studio.
  await page.goto(`${laptop.url}#settings/machines`);
  const through = page.locator(`[data-link-through="through:${mini.id}"]`);
  await expect(through.locator('.ib-l')).toHaveText('Mini · through Studio', { timeout: 30_000 });
  await expect(through.locator('.ib-desc')).toHaveText('Linked to Studio, not to this computer');
  await shot(page, '02-through-on-laptop');
  await phoneShot(browser, laptop, '#settings/machines', '02-through-on-laptop', async (p) => {
    await expect(p.locator(`[data-link-through="through:${mini.id}"] .ib-l`)).toHaveText('Mini · through Studio', { timeout: 30_000 });
  });
  expect(errors).toEqual([]);
});

test('2. One click on Studio: Laptop and Mini are linked directly, both ways, and the rows go', async ({ browser }: { browser: Browser }) => {
  test.setTimeout(180_000);
  await page.goto(`${studio.url}#settings/machines`);
  const pair = page.locator('[data-link-through^="pair:"]');
  await pair.locator('[data-link-through-link]').click();
  await expect.poll(async () => (await rowOf(laptop, mini))?.state, { timeout: 60_000 }).toBe('online');
  await expect.poll(async () => (await rowOf(mini, laptop))?.state, { timeout: 60_000 }).toBe('online');
  // A link both ways, as one made by hand.
  expect((await rowOf(laptop, mini))?.both_ways).toBe(true);
  expect((await rowOf(mini, laptop))?.both_ways).toBe(true);
  // Studio keeps none of their tokens: they were minted at each other's doors.
  const laptopToMini = linksFile(laptop).links.find((l) => l.id === mini.id)!.token;
  const miniToLaptop = linksFile(mini).links.find((l) => l.id === laptop.id)!.token;
  for (const file of ['machines.json', 'link-through.json']) {
    const path = join(studio.dataDir, 'inbox', file);
    const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
    expect(text).not.toContain(laptopToMini);
    expect(text).not.toContain(miniToLaptop);
  }
  expect(linksFile(studio).links.map((l) => l.id).sort()).toEqual([laptop.id, mini.id].sort());
  // The rows go on every computer.
  await expect(pair).toHaveCount(0, { timeout: 30_000 });
  await expect.poll(async () => (await machinesOf(laptop)).find((m) => m.self)?.link_through?.through.length, { timeout: 30_000 }).toBe(0);
  await expect.poll(async () => (await machinesOf(mini)).find((m) => m.self)?.link_through?.through.length, { timeout: 30_000 }).toBe(0);
  await page.goto(`${laptop.url}#settings/machines`);
  await expect(page.locator(`[data-machine-row="${mini.id}"]`)).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-link-through]')).toHaveCount(0);
  await shot(page, '03-linked-on-laptop');
  await phoneShot(browser, laptop, '#settings/machines', '03-linked-on-laptop', async (p) => {
    await expect(p.locator(`[data-machine-row="${mini.id}"]`)).toBeVisible({ timeout: 30_000 });
  });
  expect(errors).toEqual([]);
});

test('3. On Laptop, @ lists Mini’s agent, and Send wakes it on Mini', async ({ browser }: { browser: Browser }) => {
  test.setTimeout(240_000);
  await expect.poll(() => marksOf(laptop, mini), { timeout: 30_000 }).toContain('tag-across');
  // Laptop's own agent's thread; Mini's Claude Code polls in "api".
  const owner = await SimAgent.connect({ binary, env: laptop.env, name: 'Claude Code', host: 'claude-code', cwd: laptop.root });
  agents.push(owner);
  const web = scratchProject(join(laptop.root, 'code'), 'web');
  const thread = (await owner.send({ project_path: web, subject: 'Checkout timeout for Bob Tully', body: 'The checkout call times out after 30 s. Is the api side slow?' })).thread_id as string;
  const far = new Poller(mini, MINI_AGENT, 'claude-code', scratchProject(join(mini.root, 'code'), 'api'));
  far.start();

  const box = await openReply(page, laptop, thread);
  await tagList(page, box);
  const option = page.locator(`[data-tag-option="${MINI_AGENT}"]`);
  await expect(option).toContainText('Claude Code (Mini)');
  await expect(option).toContainText('api · Mini');
  await shot(page, '04-tag-list-on-laptop');
  await phoneShot(browser, laptop, `#thread=${thread}`, '04-tag-list-on-laptop', async (p) => {
    const small = await openReply(p, laptop, thread);
    await tagList(p, small);
  });

  // Pick it and Send: Mini's Inbox hands its agent the tagged wake for Laptop's thread.
  await box.fill('');
  await box.pressSequentially('Can the api answer sooner? @');
  await expect(option).toBeVisible();
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('ArrowDown');
    if ((await page.locator('[data-tag-option][aria-selected="true"]').getAttribute('data-tag-option')) === MINI_AGENT) break;
  }
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-tag-picker]')).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect.poll(() => far.commands.some((c) => c.thread_id === thread), { timeout: 60_000 }).toBe(true);
  expect(far.commands.find((c) => c.thread_id === thread)!.tagged).toBeTruthy();
  expect(errors).toEqual([]);
});
