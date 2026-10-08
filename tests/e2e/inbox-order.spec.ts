/**
 * The list's order inside a section (owner ruling 2026-10-08): newest first,
 * by the thread's latest message, in every section. Proved in a real browser
 * against the compiled binary: three agents (Pi, then OpenCode, then Claude
 * Code) each ask a question through `plannotator inbox mcp` with the MCP
 * SDK's stdio client (scripts/inbox-sim.ts), and "Waiting on you" reads
 * Claude Code, OpenCode, Pi. A reply to Pi's question moves its row to Sent;
 * a newer agent message waits behind "N new" and, once shown, sits at the top
 * of its section.
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 * PNGs light and dark at 1440 by 900 land in .local/proof/order/.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'order');

const question = (prompt: string) => [':::question', prompt, '', '- [ ] Yes', '- [ ] No', ':::'].join('\n');

interface World {
  root: string;
  dataDir: string;
  url: string;
  ledger: string;
  opencodeMessage: string;
  agents: SimAgent[];
  context: BrowserContext;
  page: Page;
  errors: string[];
  threads: { pi: string; opencode: string; claude: string };
}

let world: World;

async function shot(name: string): Promise<void> {
  const page = world.page;
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(proofDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

/** A section's thread ids, top to bottom. */
async function sectionOrder(page: Page, section: string): Promise<string[]> {
  return page
    .locator(`[data-section-id="${section}"] [data-thread-id]`)
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-thread-id') ?? ''));
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-order-e2e-')));
  const dataDir = join(root, 'data');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: 'none' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  const ledger = scratchProject(join(root, 'src'), 'ledger');
  const pi = await SimAgent.connect({ binary, env, name: 'Pi', host: 'pi' });
  const opencode = await SimAgent.connect({ binary, env, name: 'OpenCode', host: 'opencode' });
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  // In order A, B, C, a few ms apart so each has its own time.
  const a = await pi.send({ project_path: ledger, subject: 'Keep the CSV header row?', body: question('Keep the CSV header row?') });
  await new Promise((r) => setTimeout(r, 20));
  const b = await opencode.send({ project_path: ledger, subject: 'Ship the export behind a flag?', body: question('Ship the export behind a flag?') });
  await new Promise((r) => setTimeout(r, 20));
  const c = await claude.send({ project_path: ledger, subject: 'Rerun the March ledger?', body: question('Rerun the March ledger?') });
  world = {
    root,
    dataDir,
    url,
    ledger,
    opencodeMessage: b.message_id,
    agents: [pi, opencode, claude],
    context,
    page,
    errors,
    threads: { pi: a.thread_id, opencode: b.thread_id, claude: c.thread_id },
  };
});

test.afterAll(async () => {
  if (!world) return;
  await Promise.all(world.agents.map((a) => a.close().catch(() => {})));
  await world.context.close();
  try {
    process.kill(JSON.parse(readFileSync(join(world.dataDir, 'inbox', 'inbox.json'), 'utf8')).pid, 'SIGTERM');
  } catch {
    // Already gone.
  }
  rmSync(world.root, { recursive: true, force: true });
});

test('three agents ask in order A, B, C: "Waiting on you" reads C, B, A', async () => {
  const { page, threads } = world;
  await page.goto(world.url);
  await expect(page.locator('[data-section-id="waiting"] [data-thread-id]')).toHaveCount(3);
  expect(await sectionOrder(page, 'waiting')).toEqual([threads.claude, threads.opencode, threads.pi]);
  await expect(page.locator('.ib-band')).toHaveText([/^Waiting on you\s*3$/]);
  await shot('1-waiting-newest-first');
});

test("a reply to A moves A to Sent; Waiting keeps C, B", async () => {
  const { page, threads } = world;
  await page.locator(`[data-thread-id="${threads.pi}"]`).click();
  const pane = page.locator('section.ib-pane');
  await expect(pane.getByRole('heading', { name: 'Keep the CSV header row?' })).toBeVisible();
  await pane.getByText('Yes', { exact: true }).click();
  await expect(pane.getByText(/^Picked \d{1,2}:\d{2} [AP]M, not sent$/)).toBeVisible();
  await page.locator('.ib-pfoot').getByRole('button', { name: 'Send' }).click();
  const row = page.locator(`.ib-lbody [data-thread-id="${threads.pi}"]`);
  await expect(row).toHaveAttribute('data-section', 'sent');
  await expect(row).toContainText('Saved for Pi');
  expect(await sectionOrder(page, 'waiting')).toEqual([threads.claude, threads.opencode]);
  expect(await sectionOrder(page, 'sent')).toEqual([threads.pi]);
  await shot('2-reply-moves-a-to-sent');
  await page.keyboard.press('Escape');
  await expect(pane).toHaveCount(0);
});

test('a newer agent message waits behind "N new"; shown, its row is first in its section; no page errors', async () => {
  const { page, threads } = world;
  const [, opencode] = world.agents;
  const before = await sectionOrder(page, 'waiting');
  await opencode!.send({ project_path: world.ledger, reply_to: world.opencodeMessage, body: question('Also gzip the file?') });
  // The held rule (PR 1772): the order on screen waits for an action.
  await expect(page.locator('[data-inbox-notice]')).toContainText('1 new in ledger');
  expect(await sectionOrder(page, 'waiting')).toEqual(before);
  await page.locator('[data-inbox-notice]').click();
  await expect.poll(() => sectionOrder(page, 'waiting')).toEqual([threads.opencode, threads.claude]);
  await shot('3-newer-message-first');
  expect(world.errors).toEqual([]);
});
