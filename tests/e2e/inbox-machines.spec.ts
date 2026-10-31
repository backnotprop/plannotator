/**
 * Linked machines, the window (docs/agent-guides/inbox-machines.md), proved in
 * a real browser against three compiled Inboxes on loopback: Studio (the
 * window's), MacBook and Mini. Each runs `plannotator inbox --background` in
 * its own scratch HOME and PLANNOTATOR_DATA_DIR, with PLANNOTATOR_TEST_SANDBOX
 * (so a loopback address stands in for the tailnet), Connect, the update check
 * and Phones off, and every outside URL pointed at a closed port. MacBook and
 * Mini get a `tailscale` stand-in that records a call and fails; Studio gets
 * tests/e2e/fake-tailscale.ts, so its link code carries an address for the
 * screenshot. The machines link through the real CLI pairing
 * (`link --offer`, then `link <code> --address --back`), as #2375's server
 * e2e does. Agents are SimAgent over each machine's own `inbox mcp`.
 *
 * What is proved, in order:
 *  1. Never linked: no machine label, no Machines section, no away line and
 *     no "Hide offline machines"; Settings → Machines says none is linked.
 *  2. Linked: the merged list labels another machine's rows like the project
 *     label ("billing-svc · MacBook"), this machine's not; Machines in the
 *     sidebar; a thread from another machine says "On MacBook". A fresh load
 *     of that thread (a reload, a new tab) opens it; after a restart with
 *     MacBook asleep, it waits for MacBook's list (never "deleted") and
 *     opens once MacBook is back.
 *  3. Answering MacBook's thread from Studio wakes MacBook's agent.
 *  4. MacBook asleep: its rows greyed under "MacBook asleep since …"; an
 *     answer is held ("Will send when MacBook is back", never delivered), and
 *     still shows after a reload while the thread cannot open; then it lands
 *     once when MacBook is back, and its agent gets it.
 *  5. The sidebar filter, and Hide offline machines.
 *  6. Unlink in Settings → Machines (Mini asleep: it is told at its next contact).
 *  7. The sidebar's Machines section goes with the last link: unlinked from
 *     MacBook's side, then (linked again) from Studio's Settings.
 *
 * Screenshots (light and dark at 1440×900, phone at 390) land in
 * PLANNOTATOR_MACHINES_SHOTS, else .local/proof/link-machines-window/.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { fakeTailscale } from './fake-tailscale';
import { inboxScratch, rememberInboxOf, removeInboxScratch, stopScratchInbox } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shots = resolve(process.env.PLANNOTATOR_MACHINES_SHOTS ?? join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'link-machines-window'));
const CLOSED = 'http://127.0.0.1:9';
/** A question, so its thread waits on the person (it stays in "Waiting on you" after it is opened). */
const ask = (line: string, choices: string[]) => [line, '', ':::question', line, '', ...choices.map((c) => `- [ ] ${c}`), ':::'].join('\n');

interface Machine {
  name: string;
  root: string;
  dataDir: string;
  env: Record<string, string>;
  code: string;
  id: string;
  url: string;
  /** The stand-in's call log (MacBook, Mini): Tailscale is never called for real. */
  calls: string | null;
}

let studio: Machine;
let macbook: Machine;
let mini: Machine;
let context: BrowserContext;
let page: Page;
const errors: string[] = [];
const agents: SimAgent[] = [];

function machine(name: string, fake: 'tailscale' | 'stand-in'): Machine {
  const root = inboxScratch(`plannotator-machines-window-${name.toLowerCase()}-`);
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  let calls: string | null = null;
  if (fake === 'tailscale') fakeTailscale(bin);
  else {
    calls = join(root, 'tailscale-calls.txt');
    writeFileSync(join(bin, 'tailscale'), `#!/bin/sh\necho "tailscale $*" >> '${calls}'\nexit 1\n`);
    chmodSync(join(bin, 'tailscale'), 0o755);
  }
  const dataDir = join(root, 'data');
  // PATH: the stand-in first, then git for the scratch projects; never a real tailscale.
  const env = {
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: root,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_TEST_SANDBOX: root,
    PLANNOTATOR_BROWSER: NO_BROWSER,
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
  return { name, root, dataDir, env, code: join(root, 'code'), id: '', url: '', calls };
}

function cli(m: Machine, ...args: string[]): { status: number; out: string; err: string } {
  const run = spawnSync(binary, ['inbox', ...args], { env: m.env, cwd: m.root, encoding: 'utf8', timeout: 60_000 });
  return { status: run.status ?? -1, out: run.stdout ?? '', err: run.stderr ?? '' };
}

function start(m: Machine): void {
  const run = cli(m, '--background');
  rememberInboxOf(m.dataDir);
  expect(run.status, run.err).toBe(0);
  m.url = run.out.trim();
}

const base = (m: Machine) => `http://127.0.0.1:${(JSON.parse(readFileSync(join(m.dataDir, 'inbox', 'inbox.json'), 'utf8')) as { port: number }).port}`;

async function json<T>(m: Machine, path: string): Promise<T> {
  return (await (await fetch(`${base(m)}${path}`)).json()) as T;
}

const stateOf = async (m: Machine, other: Machine) => (await json<{ machines: { id: string; state: string }[] }>(m, '/api/inbox/machines')).machines.find((x) => x.id === other.id)?.state;

/** Link `from` to `to` as the person does on the command line: the code on `to`, pasted on `from`. */
function link(from: Machine, to: Machine): void {
  const offered = cli(to, 'link', '--offer');
  expect(offered.status, offered.err).toBe(0);
  const linked = cli(from, 'link', offered.out.trim(), '--address', base(to), '--back', base(from));
  expect(linked.status, linked.err).toBe(0);
  expect(linked.out).toContain('both ways');
}

async function agentOn(m: Machine): Promise<SimAgent> {
  const agent = await SimAgent.connect({ binary, env: m.env, name: 'Claude Code', host: 'claude-code', cwd: m.root });
  agents.push(agent);
  return agent;
}

async function shot(name: string, target: Page = page): Promise<void> {
  // The notifications band (headless Chrome reports them blocked) is not what these pictures are about.
  const band = target.getByRole('region', { name: 'Desktop notifications' }).getByRole('button', { name: 'Hide' });
  if (await band.isVisible().catch(() => false)) await band.click();
  await target.mouse.move(1, 1);
  for (const scheme of ['light', 'dark'] as const) {
    await target.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await target.waitForTimeout(250);
    await target.screenshot({ path: join(shots, `${name}-${scheme}.png`) });
  }
  await target.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

/** The same screen on a phone at 390 px, light. */
async function phoneShot(name: string, hash: string): Promise<void> {
  const phone = await page.context().browser()!.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'light' });
  try {
    await phone.grantPermissions(['notifications'], { origin: new URL(studio.url).origin });
    const p = await phone.newPage();
    await p.goto(`${studio.url}${hash}`);
    await p.waitForTimeout(1_200);
    const band = p.getByRole('region', { name: 'Desktop notifications' }).getByRole('button', { name: 'Hide' });
    if (await band.isVisible().catch(() => false)) await band.click();
    await p.emulateMedia({ reducedMotion: 'reduce' });
    await p.screenshot({ path: join(shots, `${name}-phone.png`) });
  } finally {
    await phone.close();
  }
}

const row = (threadId: string) => page.locator(`.ib-lbody [data-thread-id="${threadId}"]`);
const label = (threadId: string) => row(threadId).locator('.ib-p').first();

async function menuHasHideOffline(): Promise<boolean> {
  await page.locator('[data-tidy-menu]').first().click();
  await expect(page.locator('[data-tidy-menu-popup]')).toBeVisible();
  const found = (await page.locator('[data-hide-offline-machines]').count()) > 0;
  await page.keyboard.press('Escape');
  return found;
}

async function reply(words: string): Promise<void> {
  const pane = page.locator('section.ib-pane');
  await pane.locator('.ib-pfoot').getByRole('button', { name: 'Reply', exact: true }).click();
  await pane.getByRole('textbox', { name: /Reply to Claude Code/ }).fill(words);
  await page.keyboard.press('ControlOrMeta+Enter');
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  mkdirSync(shots, { recursive: true });
  studio = machine('Studio', 'tailscale');
  macbook = machine('MacBook', 'stand-in');
  mini = machine('Mini', 'stand-in');
  for (const m of [studio, macbook, mini]) {
    start(m);
    m.id = (await json<{ inbox_id: string }>(m, '/api/inbox/health')).inbox_id;
  }
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  await context.grantPermissions(['notifications'], { origin: new URL(studio.url).origin });
  page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
});

test.afterAll(async () => {
  try {
    for (const agent of agents) await agent.close().catch(() => {});
    await context?.close();
    // Nothing here may touch the system's Tailscale.
    for (const m of [macbook, mini]) if (m?.calls) expect(existsSync(m.calls)).toBe(false);
  } finally {
    await removeInboxScratch();
  }
});

let ownThread = '';
let macThread = '';
let macMessage = '';
let macHeldThread = '';
let macWaiting = '';
let miniThread = '';

test('1. never linked: no machine label, no Machines section, no away line, no "Hide offline machines"', async () => {
  const agent = await agentOn(studio);
  const sent = await agent.send({ project_path: scratchProject(studio.code, 'billing-svc'), subject: 'Refund webhook: retry or alert on a 409?', body: ask('Retry the 409 with the same key, or alert?', ['Retry', 'Alert']) });
  ownThread = sent.thread_id as string;
  await agent.send({ project_path: scratchProject(studio.code, 'web-app'), subject: 'Dark mode tokens are in', body: 'Swapped the hard-coded greys for tokens. Nothing for you to do.' });

  await page.goto(studio.url);
  await expect(row(ownThread)).toBeVisible();
  await expect(label(ownThread)).toHaveText('billing-svc');
  await expect(page.locator('[data-machines-section]')).toHaveCount(0);
  await expect(page.locator('[data-machine-away]')).toHaveCount(0);
  await expect(page.locator('.ib-lbody [data-away]')).toHaveCount(0);
  expect(await menuHasHideOffline()).toBe(false);
  await row(ownThread).click();
  await expect(page.locator('section.ib-pane .ib-subject')).toHaveText('Refund webhook: retry or alert on a 409?');
  await expect(page.locator('[data-thread-machine]')).toHaveCount(0);

  // Settings → Machines is where the first link starts; it says none is linked.
  await page.goto(`${studio.url}#settings/machines`);
  await expect(page.locator('[data-machine-start] .ib-l')).toHaveText('No machine linked yet');
  await expect(page.locator('[data-machine-row]')).toHaveCount(0);
});

test('2. the link flow: this machine\'s code, and the form for another\'s', async () => {
  await page.goto(`${studio.url}#settings/machines`);
  await page.locator('[data-machine-offer-start]').click();
  const offer = page.locator('[data-machine-offer]');
  await expect(offer.locator('pre')).toContainText('plannotator://link?v=1&id=');
  await expect(offer).toContainText('e2e-mac.tail0000.ts.net');
  await shot('05-link-code');

  // MacBook's code, pasted in Studio's form (the CLI links below: a loopback way back has no window field).
  const code = cli(macbook, 'link', '--offer').out.trim();
  await page.locator('[data-machine-link]').click();
  await page.locator('[data-machine-link-code]').fill(code);
  await shot('06-link-form');
  await page.locator('[data-machine-link-form]').getByRole('button', { name: 'Cancel' }).click();

  link(studio, macbook);
  link(studio, mini);
  await expect(page.locator('[data-machine-row]')).toHaveCount(2);
  await expect(page.locator(`[data-machine-row="${macbook.id}"] .ib-desc`)).toContainText('Online');
});

test('2b. the merged list labels another machine\'s rows like the project label; a thread from it says which machine', async () => {
  const onMac = await agentOn(macbook);
  const macProject = scratchProject(macbook.code, 'billing-svc');
  const sent = await onMac.send({ project_path: macProject, subject: 'Ledger export: keep the CSV columns stable?', body: 'Finance imports the CSV by column position. Keep the order fixed and append new columns at the end?' }, { wakes: true });
  macThread = sent.thread_id as string;
  macMessage = sent.message_id as string;
  const held = await onMac.send({ project_path: scratchProject(macbook.code, 'ledger'), subject: 'Nightly reconcile is slow', body: 'The nightly reconcile takes 40 minutes. Split it per account, or index first?' }, { wakes: true });
  macHeldThread = held.thread_id as string;
  macWaiting = (await onMac.send({ project_path: scratchProject(macbook.code, 'stripe-sync'), subject: 'Stripe API version: pin or follow?', body: ask('Pin the Stripe API version, or follow the latest?', ['Pin', 'Follow']) })).thread_id as string;
  const onMini = await agentOn(mini);
  miniThread = (await onMini.send({ project_path: scratchProject(mini.code, 'infra'), subject: 'Rotate the staging certs this week?', body: ask('Staging certs expire in nine days. Rotate them Thursday?', ['Thursday', 'Next week']) })).thread_id as string;

  await page.goto(studio.url);
  await expect(row(macThread)).toBeVisible();
  await expect(row(macWaiting)).toBeVisible();
  await expect(row(miniThread)).toBeVisible();
  // The same folder name on two machines is two machines, not a clash.
  await expect(label(ownThread)).toHaveText('billing-svc');
  await expect(label(macThread)).toHaveText('billing-svc · MacBook');
  await expect(label(miniThread)).toHaveText('infra · Mini');
  const machinesSection = page.locator('[data-machines-section]');
  await expect(machinesSection.locator('[data-machine] .ib-name')).toHaveText(['Studio', 'MacBook', 'Mini']);
  await shot('01-merged-list');
  await phoneShot('01-merged-list', '');

  await row(macThread).click();
  const pane = page.locator('section.ib-pane');
  await expect(pane.locator('.ib-subject')).toHaveText('Ledger export: keep the CSV columns stable?');
  await expect(pane.locator('[data-thread-machine]')).toHaveText('On MacBook');
  await shot('02-thread-other-machine');
  await phoneShot('02-thread-other-machine', `#thread=${macThread}`);
});

test("2c. a fresh load of another machine's thread opens it: a reload, and a new tab", async () => {
  const subject = 'Ledger export: keep the CSV columns stable?';
  await page.goto(`${studio.url}#thread=${macThread}`);
  await page.reload();
  await expect(page.locator('section.ib-pane .ib-subject')).toHaveText(subject);
  await expect(page.locator('section.ib-pane [data-thread-machine]')).toHaveText('On MacBook');
  await expect(page.locator('[data-thread-wait="missing"]')).toHaveCount(0);
  const tab = await context.newPage();
  try {
    await tab.goto(`${studio.url}#thread=${macThread}`);
    await expect(tab.locator('section.ib-pane .ib-subject')).toHaveText(subject);
    await expect(tab.locator('[data-thread-wait="missing"]')).toHaveCount(0);
  } finally {
    await tab.close();
  }
});

test("2d. right after Studio restarts with MacBook asleep, a reload of MacBook's thread waits for MacBook's list: never \"deleted\"", async () => {
  const subject = 'Ledger export: keep the CSV columns stable?';
  await page.goto(`${studio.url}#thread=${macThread}`);
  await expect(page.locator('section.ib-pane .ib-subject')).toHaveText(subject);
  // MacBook sleeps, then Studio restarts (an update does the same): Studio's merged list has no MacBook rows, and gets
  // none until MacBook is back, so the reloaded window cannot tell whose thread this is.
  await stopScratchInbox(macbook.dataDir);
  await stopScratchInbox(studio.dataDir);
  start(studio);
  await page.goto(`${studio.url}#thread=${macThread}`);
  await page.reload();
  const wait = page.locator('[data-thread-wait="failed"]');
  await expect(wait).toBeVisible({ timeout: 20_000 });
  await expect(wait.locator('[data-thread-wait-unlisted]')).toHaveText('Waiting for MacBook: this thread may be there.');
  // Read again on its schedule (a 404 each time), and never "may have been deleted".
  for (let i = 0; i < 6; i++) {
    await expect(page.locator('[data-thread-wait="missing"]')).toHaveCount(0);
    await page.waitForTimeout(500);
  }
  await expect(wait).toBeVisible();
  // MacBook is back: its list names the thread, and it opens.
  start(macbook);
  await expect(page.locator('section.ib-pane .ib-subject')).toHaveText(subject, { timeout: 45_000 });
  await expect(page.locator('section.ib-pane [data-thread-machine]')).toHaveText('On MacBook');
  await expect(page.locator('[data-thread-wait="missing"]')).toHaveCount(0);
  await expect.poll(() => stateOf(studio, macbook), { timeout: 45_000 }).toBe('online');
});

test("3. answering MacBook's thread from Studio wakes MacBook's agent", async () => {
  const onMac = await agentOn(macbook);
  const waiting = onMac.waitForReply(macThread, 45);
  await page.goto(`${studio.url}#thread=${macThread}`);
  await expect(page.locator('section.ib-pane .ib-subject')).toHaveText('Ledger export: keep the CSV columns stable?');
  await reply('Keep the order fixed. Append new columns at the end.');
  const woke = await waiting;
  expect(woke.status).toBe('replied');
  expect((woke.reply as { body: string }).body).toContain('Keep the order fixed.');
  // One reply on MacBook, shown in Studio's thread.
  const there = await json<{ thread: { messages: { id: string; author: { kind: string } }[] } }>(macbook, `/api/inbox/threads/${macThread}`);
  expect(there.thread.messages.filter((m) => m.author.kind === 'person')).toHaveLength(1);
  await expect(page.locator('section.ib-pane article[data-author="person"]')).toHaveCount(1);
  expect(macMessage).not.toBe('');
});

test('4. MacBook asleep: greyed rows under "MacBook asleep since"; an answer waits to send, then lands once when it is back', async () => {
  await page.goto(`${studio.url}#thread=${macHeldThread}`);
  const pane = page.locator('section.ib-pane');
  await expect(pane.locator('.ib-subject')).toHaveText('Nightly reconcile is slow');

  await stopScratchInbox(macbook.dataDir);
  await expect.poll(() => stateOf(studio, macbook), { timeout: 30_000 }).toBe('offline');
  const away = page.locator(`[data-machine-away="${macbook.id}"]`);
  await expect(away).toContainText('MacBook asleep since', { timeout: 20_000 });
  await expect(row(macWaiting)).toHaveAttribute('data-away', '');
  await expect(row(ownThread)).not.toHaveAttribute('data-away', '');
  await expect(pane.locator('[data-thread-machine]')).toContainText('MacBook asleep since');

  await reply('Split it per account first; index after if it is still slow.');
  const held = pane.locator('[data-outbox]');
  await expect(held.locator('[data-outbox-line]')).toHaveText('Will send when MacBook is back');
  await expect(held.locator('.ib-held-words')).toHaveText('Split it per account first; index after if it is still slow.');
  await expect(pane).not.toContainText(/Delivered/);
  await shot('03-asleep-held');
  await phoneShot('03-asleep', '');

  // Back to the list, then a fresh load of the thread: it cannot open while MacBook sleeps, and the answer still
  // shows there, waiting.
  await page.goto(studio.url);
  await page.goto(`${studio.url}#thread=${macHeldThread}`);
  await page.reload();
  await expect(page.locator('[data-thread-wait-away]')).toContainText('MacBook asleep since', { timeout: 20_000 });
  const waiting = page.locator('[data-thread-wait-held] [data-outbox]');
  await expect(waiting.locator('.ib-held-words')).toHaveText('Split it per account first; index after if it is still slow.');
  await expect(waiting.locator('[data-outbox-line]')).toHaveText('Will send when MacBook is back');
  // The away line is on screen above it (it fades in after a short wait), not only in the DOM.
  await expect(page.locator('.ib-pwait-line')).toHaveCSS('opacity', '1');
  await shot('07-asleep-held-reload');
  await phoneShot('07-asleep-held-reload', `#thread=${macHeldThread}`);

  // MacBook is back: the answer is sent once, the waiting line goes, the thread opens with the reply in it.
  start(macbook);
  await expect.poll(() => stateOf(studio, macbook), { timeout: 45_000 }).toBe('online');
  await expect(page.locator('[data-thread-wait-held]')).toHaveCount(0, { timeout: 30_000 });
  await expect(pane.locator('.ib-subject')).toHaveText('Nightly reconcile is slow', { timeout: 30_000 });
  await expect(held).toHaveCount(0, { timeout: 30_000 });
  await expect(away).toHaveCount(0);
  await expect(pane.locator('article[data-author="person"]')).toHaveCount(1, { timeout: 15_000 });
  const there = await json<{ thread: { messages: { author: { kind: string }; body: string }[] } }>(macbook, `/api/inbox/threads/${macHeldThread}`);
  const replies = there.thread.messages.filter((m) => m.author.kind === 'person');
  expect(replies).toHaveLength(1);
  expect(replies[0]!.body).toContain('Split it per account first');
  // MacBook's agent, back after the restart, gets the answer that waited.
  const back = await agentOn(macbook);
  const woke = await back.waitForReply(macHeldThread, 15);
  expect(woke.status).toBe('replied');
});

test('4b. a pick for MacBook while it sleeps says it is waiting, stays picked, and is saved there when MacBook is back', async () => {
  await page.goto(`${studio.url}#thread=${macWaiting}`);
  const pane = page.locator('section.ib-pane');
  await expect(pane.locator('.ib-subject')).toHaveText('Stripe API version: pin or follow?');
  await stopScratchInbox(macbook.dataDir);
  await expect.poll(() => stateOf(studio, macbook), { timeout: 30_000 }).toBe('offline');
  await pane.getByRole('radio', { name: /^Pin/ }).click();
  await expect(page.locator('.ib-toast')).toContainText('Waiting for MacBook: this applies when MacBook is back.');
  await expect(pane.getByRole('radio', { name: /^Pin/ })).toBeChecked();
  start(macbook);
  await expect.poll(() => stateOf(studio, macbook), { timeout: 45_000 }).toBe('online');
  await expect
    .poll(async () => {
      const there = await json<{ thread: { messages: { questions?: { answer: unknown }[] }[] } }>(macbook, `/api/inbox/threads/${macWaiting}`);
      return there.thread.messages.some((m) => (m.questions ?? []).some((q) => q.answer !== null && q.answer !== undefined));
    }, { timeout: 30_000 })
    .toBe(true);
  await expect(pane.getByRole('radio', { name: /^Pin/ })).toBeChecked();
});

test('5. the Machines filter, and Hide offline machines', async () => {
  // A fresh question on MacBook: it waits on the person, so its row stays in view.
  const onMac = await agentOn(macbook);
  const macAsk = (await onMac.send({ project_path: scratchProject(macbook.code, 'retry-worker'), subject: 'Feature flag for the new retry worker?', body: ask('Ship the retry worker behind a flag?', ['Behind a flag', 'Straight on']) })).thread_id as string;
  await page.goto(studio.url);
  await expect(row(macAsk)).toBeVisible();
  await expect(row(miniThread)).toBeVisible();
  const machines = page.locator('[data-machines-section]');
  await machines.locator(`[data-machine="${macbook.id}"]`).click();
  await expect(page).toHaveURL(new RegExp(`#machine=${macbook.id}`));
  await expect(row(macAsk)).toBeVisible();
  await expect(row(ownThread)).toHaveCount(0);
  await expect(row(miniThread)).toHaveCount(0);
  // One machine's list drops the machine from its labels, as one project's list drops the project.
  await expect(label(macAsk)).toHaveText('retry-worker');
  await expect(machines.locator(`[data-machine="${macbook.id}"]`)).toHaveAttribute('aria-current', 'page');
  await page.locator('.ib-nav-inbox').click();
  await expect(row(ownThread)).toBeVisible();

  await stopScratchInbox(mini.dataDir);
  await expect(page.locator(`[data-machine-away="${mini.id}"]`)).toContainText('Mini asleep since', { timeout: 30_000 });
  await expect(row(miniThread)).toHaveAttribute('data-away', '');
  await page.locator('[data-tidy-menu]').first().click();
  await page.locator('[data-hide-offline-machines]').click();
  await expect(row(miniThread)).toHaveCount(0);
  await expect(row(macAsk)).toBeVisible();
  await expect(row(ownThread)).toBeVisible();
  // The choice is this browser's: it holds across a reload, and turns off again.
  await page.reload();
  await expect(row(ownThread)).toBeVisible();
  await expect(row(miniThread)).toHaveCount(0);
  await page.locator('[data-tidy-menu]').first().click();
  await expect(page.locator('[data-hide-offline-machines]')).toHaveAttribute('aria-checked', 'true');
  await page.locator('[data-hide-offline-machines]').click();
  await expect(row(miniThread)).toBeVisible();
});

test('6. Settings → Machines: each machine with its state and version; Unlink asks twice and removes it', async () => {
  await page.goto(`${studio.url}#settings/machines`);
  const macRow = page.locator(`[data-machine-row="${macbook.id}"]`);
  const miniRow = page.locator(`[data-machine-row="${mini.id}"]`);
  await expect(macRow.locator('.ib-desc')).toHaveText(/^Online · Plannotator /);
  await expect(miniRow.locator('.ib-desc')).toHaveText(/^Asleep · last seen /);
  await shot('04-settings-machines');
  await phoneShot('04-settings-machines', '#settings/machines');

  const unlink = miniRow.getByRole('button', { name: 'Unlink Mini' });
  await unlink.click();
  await expect(miniRow.locator('.ib-del-l')).toHaveText('Unlink? Click again');
  await miniRow.locator('.ib-del-l').click();
  await expect(miniRow).toHaveCount(0);
  await expect(macRow).toBeVisible();
  // Mini sleeps, so it could not be told: it drops the link the next time it is in touch, and the page says so.
  await expect(page.locator('[data-machine-unlinked]')).toContainText('Mini could not be reached');
  const left = await json<{ machines: { id: string }[] }>(studio, '/api/inbox/machines');
  expect(left.machines.map((m) => m.id)).not.toContain(mini.id);

  await page.goto(studio.url);
  await expect(row(ownThread)).toBeVisible();
  await expect(row(miniThread)).toHaveCount(0);
  await expect(page.locator('[data-machines-section] [data-machine] .ib-name')).toHaveText(['Studio', 'MacBook']);
  expect(errors).toEqual([]);
});

test('7. the sidebar Machines section goes with the last link: unlinked from the other side, then from here', async () => {
  const section = page.locator('[data-machines-section]');
  await page.goto(studio.url);
  await expect(label(macWaiting)).toHaveText('stripe-sync · MacBook');
  await expect(section).toBeVisible();

  // MacBook unlinks Studio on its own side: Studio's window drops the section and MacBook's rows, no reload.
  const run = cli(macbook, 'unlink', studio.id);
  expect(run.status, run.err).toBe(0);
  await expect(section).toHaveCount(0, { timeout: 15_000 });
  await expect(row(macWaiting)).toHaveCount(0);
  await expect(label(ownThread)).toHaveText('billing-svc');
  await expect(page.locator('.ib-lbody [data-away]')).toHaveCount(0);
  expect(await menuHasHideOffline()).toBe(false);

  // Linked again, then the last link unlinked here in Settings: the section goes again, with every label.
  link(studio, macbook);
  await expect(section).toBeVisible({ timeout: 15_000 });
  await expect(label(macWaiting)).toHaveText('stripe-sync · MacBook', { timeout: 15_000 });
  await page.goto(`${studio.url}#settings/machines`);
  const macRow = page.locator(`[data-machine-row="${macbook.id}"]`);
  await macRow.locator('.ib-del-l').click();
  await expect(macRow.locator('.ib-del-l')).toHaveText('Unlink? Click again');
  await macRow.locator('.ib-del-l').click();
  await expect(macRow).toHaveCount(0);
  await expect(page.locator('[data-machine-start] .ib-l')).toHaveText('No machine linked yet');
  await page.goto(studio.url);
  await expect(row(ownThread)).toBeVisible();
  await expect(section).toHaveCount(0);
  await expect(row(macWaiting)).toHaveCount(0);
  await expect(label(ownThread)).toHaveText('billing-svc');
  await expect(page.locator('.ib-lbody [data-away]')).toHaveCount(0);
  expect(errors).toEqual([]);
});
