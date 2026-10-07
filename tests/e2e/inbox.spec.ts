/**
 * The Plannotator Inbox window, proved in a real browser against the compiled
 * binary. Nothing is mocked: the binary runs `plannotator inbox --background`
 * under a temp PLANNOTATOR_DATA_DIR (and HOME), agents write through
 * `plannotator inbox mcp` with the MCP SDK's stdio client (scripts/inbox-sim.ts),
 * and Chromium drives the window the person sees.
 *
 * Build first (the same flags release.yml compiles with):
 *
 *   bun run --cwd apps/review build && bun run build:hook && \
 *     bun build apps/hook/server/index.ts --compile --no-compile-autoload-bunfig \
 *     --define '__CLI_VERSION__="0.0.0-dev"' --outfile .local/plannotator
 *   bun run test:e2e:inbox
 *
 * PLANNOTATOR_E2E_BINARY names another binary; PNGs of every proved state, in
 * light and dark at 1440 by 900, land in .local/proof/ (PLANNOTATOR_E2E_PROOF_DIR)
 * with a contact sheet.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DEMO_MESSAGES, SimAgent, scratchProject } from '../../scripts/inbox-sim';

const repo = resolve(__dirname, '../..');
const builtBinary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof'));

interface World {
  root: string;
  binary: string;
  dataDir: string;
  env: Record<string, string>;
  url: string;
  billing: string;
  docs: string;
  agents: SimAgent[];
  context: BrowserContext;
  page: Page;
  errors: string[];
  threads: Record<string, string>;
}

let world: World;

function registry(): { pid: number; port: number; serverSession: string; url: string } {
  return JSON.parse(readFileSync(join(world.dataDir, 'inbox', 'inbox.json'), 'utf8'));
}

function stopInbox(): void {
  try {
    process.kill(registry().pid, 'SIGTERM');
  } catch {
    // Already gone.
  }
}

/**
 * One PNG per proved state, light then dark, at 1440 by 900. Taken under
 * reduced motion, so the Tater mark sits on its first frame as the record draws it.
 */
async function shot(name: string): Promise<void> {
  const page = world.page;
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(proofDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

async function agent(name: string, host: string): Promise<SimAgent> {
  const sim = await SimAgent.connect({ binary: world.binary, env: world.env, name, host });
  world.agents.push(sim);
  return sim;
}

/** The sidebar: Inbox, the project folders, Settings. */
function side(page: Page) {
  return page.getByRole('complementary', { name: 'Inbox navigation' });
}

/** The thread ids of the list's rows, top to bottom. */
async function rowOrder(page: Page): Promise<string[]> {
  return page.locator('.ib-lbody [data-thread-id]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-thread-id') ?? ''));
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(builtBinary), `build the binary first: ${builtBinary}`).toBe(true);
  // Only this spec's own captures: decisions, attachments and guided reviews keep theirs in proof/decisions/, proof/attachments/ and proof/guides/.
  mkdirSync(proofDir, { recursive: true });
  for (const file of readdirSync(proofDir)) if (file.endsWith('.png') || file === 'index.html') rmSync(join(proofDir, file));
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-e2e-')));
  // A copy the restart proof can replace on disk, as install.sh does.
  // A long directory name of our own, so the code boxes must wrap the command on any runner.
  const binDir = join(root, 'a-long-install-directory-name-so-every-connect-command-has-to-wrap', 'bin');
  const binary = join(binDir, 'plannotator');
  mkdirSync(binDir, { recursive: true });
  copyFileSync(builtBinary, binary);
  chmodSync(binary, 0o755);
  const dataDir = join(root, 'data');
  const home = join(root, 'home');
  mkdirSync(home);
  const env = { PATH: process.env.PATH ?? '', HOME: home, PLANNOTATOR_DATA_DIR: dataDir };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  expect(url).toMatch(/^http:\/\/localhost:\d+\/$/);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(url).origin });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  world = {
    root,
    binary,
    dataDir,
    env,
    url,
    billing: scratchProject(join(root, 'src'), 'billing-svc'),
    docs: scratchProject(join(root, 'src'), 'docs-site'),
    agents: [],
    context,
    page,
    errors,
    threads: {},
  };
});

test.afterAll(async () => {
  if (!world) return;
  await Promise.all(world.agents.map((a) => a.close().catch(() => {})));
  await world.context.close();
  stopInbox();
  rmSync(world.root, { recursive: true, force: true });
  writeContactSheet();
});

function writeContactSheet(): void {
  const names = [...new Set(readdirSync(proofDir).filter((f) => f.endsWith('-light.png')).map((f) => f.replace(/-light\.png$/, '')))].sort();
  const rows = names
    .map((n) => `<section><h2>${n}</h2><div class="pair"><img src="${n}-light.png" alt="${n} light"><img src="${n}-dark.png" alt="${n} dark"></div></section>`)
    .join('\n');
  writeFileSync(
    join(proofDir, 'index.html'),
    `<!doctype html><meta charset="utf-8"><title>Plannotator Inbox window: proof</title><style>body{font:14px system-ui;margin:24px;background:#e9eaee}h2{font-size:15px;margin:24px 0 8px}.pair{display:flex;gap:12px}.pair img{width:calc(50% - 6px);box-shadow:0 0 0 1px #0002;border-radius:6px}</style><h1>Plannotator Inbox window: every proved state, light and dark, 1440 by 900</h1>${rows}`,
  );
}

/** Every visible code box shows its whole text: wrapped, never clipped or scrolled under Copy. */
async function expectCodeUnclipped(page: Page): Promise<void> {
  const boxes = await page.locator('.ib-cbox pre:visible').evaluateAll((els) => els.map((el) => ({ text: el.textContent ?? '', scroll: el.scrollWidth, client: el.clientWidth })));
  expect(boxes.length).toBeGreaterThan(0);
  for (const box of boxes) expect(box.scroll, `clipped: ${box.text}`).toBeLessThanOrEqual(box.client);
}

/** Every heading and label the first run shows: headings, host names, tabs, buttons, links, file paths. */
async function firstRunLabels(page: Page): Promise<string[]> {
  return page
    .locator('[data-inbox-empty]')
    .locator('h1, h2, h3, [role="tab"], button, a, .ib-clab')
    .evaluateAll((els) => els.map((el) => (el.textContent ?? '').trim()));
}

test('first run: the three connections, Use MCP instead below the row, the harness picker, Copy copies the command', async () => {
  const { page, url } = world;
  await page.goto(url);
  const empty = page.locator('[data-inbox-empty]');
  await expect(page.getByRole('heading', { name: 'No agent has written yet', exact: true })).toBeVisible();
  const lines = {
    'claude-code': ['Claude Code', "Plannotator's mod writes here. Nothing to install."],
    pi: ['Pi', "Plannotator's extension writes here. Nothing to install."],
    opencode: ['OpenCode', "Plannotator's plugin writes here. Nothing to install."],
  } as const;
  for (const [host, [name, line]] of Object.entries(lines)) {
    const card = page.locator(`[data-host="${host}"]`);
    await expect(card.getByRole('heading', { name, exact: true })).toBeVisible();
    await expect(card.locator('p')).toHaveText(line);
    await expect(card.getByRole('button', { name: 'Use MCP instead', exact: true })).toHaveAttribute('aria-expanded', 'false');
  }
  await expect(empty.getByRole('heading', { name: 'Other agents', exact: true })).toBeVisible();
  await expect(empty.getByText('Add the Inbox as a local MCP server.', { exact: true })).toBeVisible();
  await expect(page.getByText('Projects appear here when an agent writes from one.')).toBeVisible();

  // The Tater mark is Workspaces' sprite: 24 frames over 3.5 s, its first frame under reduced motion.
  const tater = page.locator('[data-sprite="tater-sidebar"]');
  const motion = () => tater.evaluate((el) => {
    const style = getComputedStyle(el);
    return `${style.animationName} ${style.animationDuration} ${style.animationTimingFunction} ${style.animationPlayState}`;
  });
  expect(await motion()).toBe('ib-tater-sidebar 3.5s steps(24) running');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect((await motion()).startsWith('none ')).toBe(true);
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  // Codex is selected: the command with Copy, one note, the folded Another way, no eyebrow repeating the name.
  const binary = realpathSync(world.binary);
  const codex = page.getByRole('tab', { name: 'Codex' });
  await expect(codex).toHaveAttribute('aria-selected', 'true');
  const command = `codex mcp add plannotator-inbox -- ${binary} inbox mcp`;
  const panel = page.getByRole('tabpanel', { name: 'Codex' });
  await expect(panel.locator('pre')).toHaveText(command);
  await expect(panel.locator('p')).toHaveText(['Also adds it to the Codex app and the IDE extension. Restart them after.']);
  await expect(panel.getByText('Another way', { exact: false })).toBeVisible();
  await expect(panel.getByText('Codex', { exact: true })).toHaveCount(0);
  await shot('1.3-first-run-codex');
  await panel.getByRole('button', { name: 'Copy' }).click();
  await expect(panel.getByRole('button', { name: 'Copied' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(command);

  // One rhythm: the same gap between the heading, the cards, Other agents and the tabs.
  const boxes = await empty.evaluate((el) => [...el.children].map((child) => child.getBoundingClientRect()).map((r) => ({ top: r.top, bottom: r.bottom })));
  const gaps = boxes.slice(1).map((box, i) => Math.round(box.top - boxes[i]!.bottom));
  expect(gaps.length).toBe(3);
  expect(new Set(gaps).size).toBe(1);

  // The cards are one height, and "Use MCP instead" opens the command below the row without making its card taller.
  const cards = page.locator('.ib-hcard');
  const heights = async () => (await cards.evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().height))));
  const before = await heights();
  expect(new Set(before).size).toBe(1);
  const claudeLink = page.locator('[data-host="claude-code"]').getByRole('button', { name: 'Use MCP instead', exact: true });
  await claudeLink.click();
  await expect(claudeLink).toHaveAttribute('aria-expanded', 'true');
  const reveal = page.locator('.ib-hreveal');
  await expect(reveal.locator('pre')).toHaveText(`claude mcp add --scope user plannotator-inbox -- ${binary} inbox mcp`);
  expect(await heights()).toEqual(before);
  const rowBottom = Math.max(...(await cards.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().bottom))));
  expect((await reveal.boundingBox())!.y).toBeGreaterThanOrEqual(rowBottom);
  // The reveal above names the binary this test started by its absolute path, under a directory name long enough to wrap on any runner.
  expect(binary.startsWith('/') && binary.endsWith('/a-long-install-directory-name-so-every-connect-command-has-to-wrap/bin/plannotator')).toBe(true);
  await expectCodeUnclipped(page);
  await expect(panel.getByRole('button', { name: 'Copy', exact: true })).toBeVisible();
  await page.mouse.move(0, 0);
  await shot('1.3-first-run-claude-code');

  // One reveal at a time; the same link closes it.
  await page.locator('[data-host="pi"]').getByRole('button', { name: 'Use MCP instead', exact: true }).click();
  await expect(reveal.locator('pre')).toHaveText(`pi mcp add plannotator-inbox -- ${binary} inbox mcp`);
  await expect(claudeLink).toHaveAttribute('aria-expanded', 'false');
  expect(await heights()).toEqual(before);
  await page.locator('[data-host="pi"]').getByRole('button', { name: 'Use MCP instead', exact: true }).click();
  await expect(reveal).toHaveCount(0);

  // Headers carry no comma: every heading and label, on every tab.
  for (const tab of await page.getByRole('tab').all()) {
    await tab.click();
    const panelNow = page.getByRole('tabpanel');
    expect(await panelNow.locator('p.ib-cnote').count(), 'one short note per tab').toBeLessThanOrEqual(1);
    for (const label of await firstRunLabels(page)) expect(label, `a heading or label with a comma: ${label}`).not.toContain(',');
  }

  await page.getByRole('tab', { name: 'Cursor' }).click();
  const link = page.getByRole('link', { name: 'Add to Cursor' });
  const href = (await link.getAttribute('href')) ?? '';
  expect(href.startsWith('cursor://anysphere.cursor-deeplink/mcp/install?name=plannotator-inbox&config=')).toBe(true);
  const config = JSON.parse(Buffer.from(decodeURIComponent(href.split('config=')[1]!), 'base64').toString('utf8'));
  expect(config).toEqual({ command: binary, args: ['inbox', 'mcp'] });
  await shot('1.4-first-run-cursor');

  await page.getByRole('tab', { name: 'Claude app' }).click();
  const claudeApp = page.getByRole('tabpanel', { name: 'Claude app' });
  const json = JSON.parse((await claudeApp.locator('pre').textContent()) ?? '{}');
  // The one note: merge, not replace; and the claude.ai connectors trap.
  await expect(claudeApp.locator('p.ib-cnote')).toHaveText(
    'Merge it into mcpServers in Claude > Settings > Developer > Edit Config, then quit and reopen Claude. claude.ai connectors cannot reach this computer.',
  );
  expect(json.mcpServers['plannotator-inbox']).toEqual({ command: binary, args: ['inbox', 'mcp'] });
  await shot('1.5-first-run-claude-app');
  await page.getByRole('tab', { name: 'Codex' }).click();
});

test('agents write three threads in two projects; the rows land in the six sections with their badges', async () => {
  const { page } = world;
  const claude = await agent('Claude Code', 'claude-code');
  const opencode = await agent('OpenCode', 'opencode');
  const claude2 = await agent('Claude Code', 'claude-code');
  const stopped = await claude.send({ project_path: world.billing, body: DEMO_MESSAGES.stopped });
  const holding = await opencode.send({ project_path: world.docs, body: DEMO_MESSAGES.holding });
  const named = await claude2.send({ project_path: world.billing, body: DEMO_MESSAGES.named, thread: 'refund-webhooks' });
  expect(named.thread_name).toBe('refund-webhooks');
  world.threads = { stopped: stopped.thread_id, holding: holding.thread_id, named: named.thread_id };

  // The server answers all six sections, in the approved order.
  const list = await (await page.request.get(`${world.url}api/inbox/threads`)).json();
  expect(list.sections.map((s: { label: string }) => s.label)).toEqual([
    'Stopped on you',
    'Holding up work',
    'Waiting on you',
    'Sent',
    'New since you looked',
    'Quiet',
  ]);

  // The window had nothing on screen, so the rows come in without a Show. The
  // three sends are separate events: when the first lands alone, the list puts
  // it on screen and holds the rest behind "N new" (held order, proved below),
  // so the rows on screen are the ones before the notice plus the ones it holds.
  const notice = page.locator('[data-inbox-notice]');
  await expect.poll(async () => (await notice.count()) > 0 || (await page.locator('.ib-lbody [data-thread-id]').count()) === 3).toBe(true);
  if (await notice.count()) await notice.click();
  const stoppedRow = page.locator(`[data-section-id="stopped"] [data-thread-id="${stopped.thread_id}"]`);
  await expect(stoppedRow).toBeVisible();
  await expect(stoppedRow.locator('.ib-badge')).toHaveText('Stopped');
  await expect(stoppedRow).toContainText('2 questions');
  await expect(stoppedRow).toContainText('billing-svc');
  const holdingRow = page.locator(`[data-section-id="holding"] [data-thread-id="${holding.thread_id}"]`);
  await expect(holdingRow.locator('.ib-badge')).toHaveText('Holds up 3');
  const namedRow = page.locator(`[data-section-id="waiting"] [data-thread-id="${named.thread_id}"]`);
  await expect(namedRow.locator('.ib-key')).toHaveText('refund-webhooks');
  await expect(page.locator('.ib-band')).toHaveText([/^Stopped on you\s*1$/, /^Holding up work\s*1$/, /^Waiting on you\s*1$/]);
  await expect(side(page).getByRole('button', { name: /^Inbox/ })).toContainText('3');
  await expect(side(page).getByRole('button', { name: /^billing-svc/ })).toContainText('2');
  await expect(side(page).getByRole('button', { name: /^docs-site/ })).toContainText('1');
  await shot('1.1-list');
});

test('a project folder filters the list and the sections still apply', async () => {
  const { page } = world;
  await side(page).getByRole('button', { name: /^docs-site/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'docs-site' })).toBeVisible();
  await expect(page.locator('.ib-path')).toHaveText(new RegExp(`docs-site$`));
  await expect(page.locator('.ib-lbody [data-thread-id]')).toHaveCount(1);
  await expect(page.locator('.ib-band')).toHaveText([/^Holding up work\s*1$/]);

  await side(page).getByRole('button', { name: /^billing-svc/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'billing-svc' })).toBeVisible();
  await expect(page.locator('.ib-band')).toHaveText([/^Stopped on you\s*1$/, /^Waiting on you\s*1$/]);
  await expect(page.locator('.ib-row .ib-p').first()).toBeHidden();
  await shot('1.2-project-filter');
  await side(page).getByRole('button', { name: /^Inbox/ }).click();
  await expect(page.locator('.ib-lbody [data-thread-id]')).toHaveCount(3);
});

test('a row opens the thread as an email with the question cards; the decision tag toggles', async () => {
  const { page } = world;
  await page.locator(`[data-thread-id="${world.threads.stopped}"]`).click();
  const pane = page.locator('section.ib-pane');
  await expect(pane.getByRole('heading', { name: 'Which way should the worker go on a Stripe 409?' })).toBeVisible();
  await expect(pane.locator('.ib-who').first()).toHaveText('Claude Code in billing-svc');
  await expect(pane.getByText('Question 1 of 2')).toBeVisible();
  await expect(pane.getByText('Question 2 of 2')).toBeVisible();
  await expect(pane.getByText('Waiting on this answer')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`#thread=${world.threads.stopped}$`));
  // Opening is a look: the row is no longer new to the person.
  await expect(page.locator(`.ib-nrow[data-thread-id="${world.threads.stopped}"]`)).toHaveAttribute('aria-current', 'true');

  // The tag is on every question (ui 0.52.1, questionDecisionScope "any"):
  // on where the block says `Decision: when answered`, off on the other. Its
  // diamond is the switch; its words open the decision card (inbox-decisions.spec.ts).
  const tags = pane.getByRole('button', { name: 'Record as a decision', exact: true });
  await expect(tags).toHaveCount(2);
  await expect(tags.nth(0)).toHaveAttribute('aria-pressed', 'true');
  await expect(tags.nth(1)).toHaveAttribute('aria-pressed', 'false');
  await expect(pane.getByText('Answering this records a decision')).toHaveCount(1);
  await shot('2.1-thread');

  await tags.nth(0).click();
  await tags.nth(1).click();
  await expect(tags.nth(0)).toHaveAttribute('aria-pressed', 'false');
  await expect(tags.nth(1)).toHaveAttribute('aria-pressed', 'true');
  await expect(pane.getByText('Answering this records a decision')).toHaveCount(1);
  // Kept on the question record (step 3), so a reload reads it back.
  await page.reload();
  const after = page.locator('section.ib-pane').getByRole('button', { name: 'Record as a decision', exact: true });
  await expect(after.nth(0)).toHaveAttribute('aria-pressed', 'false');
  await expect(after.nth(1)).toHaveAttribute('aria-pressed', 'true');
  await shot('3.1-decision-tag-switched');
  await after.nth(0).click();
  await after.nth(1).click();
  await expect(after.nth(0)).toHaveAttribute('aria-pressed', 'true');
  await expect(after.nth(1)).toHaveAttribute('aria-pressed', 'false');
});

test('a pick is saved at once and the agent reads it through read_thread', async () => {
  const { page } = world;
  const [claude] = world.agents;
  const pane = page.locator('section.ib-pane');
  await pane.getByText('Retry with the same idempotency key', { exact: true }).click();
  await expect(pane.getByText(/^Picked \d{1,2}:\d{2} [AP]M, not sent$/)).toBeVisible();
  await expect
    .poll(async () => {
      const thread = await claude!.readThread(world.threads.stopped!);
      const q = thread.messages[0].questions[0];
      return `${q.state}:${q.answer?.selected?.join('|')}`;
    })
    .toBe('picked:Retry with the same idempotency key');

  await pane.getByText('Yes', { exact: true }).click();
  await expect(pane.getByText(/^Picked .*, not sent$/)).toHaveCount(2);
  await expect(page.locator('.ib-pfoot .ib-st')).toHaveText('Not sent');
  await expect(page.locator('.ib-pfoot').getByRole('button', { name: 'Send' })).toBeVisible();
  await expect(page.locator('.ib-pfoot').getByRole('button', { name: 'Edit the reply' })).toBeVisible();
  // Answered, not sent: it waits only for Send.
  const row = page.locator(`.ib-nrow[data-thread-id="${world.threads.stopped}"]`);
  await expect(row).toHaveAttribute('data-section', 'new');
  await expect(row).toContainText('Answered, not sent');
  await shot('3.1-answered-not-sent');
});

test('Send carries the picks and the words, wait_for_reply returns them, and the thread says Delivered', async () => {
  const { page } = world;
  const [claude] = world.agents;
  await page.locator('.ib-pfoot').getByRole('button', { name: 'Edit the reply' }).click();
  const box = page.getByRole('textbox', { name: 'Reply to Claude Code' });
  await expect(box).toHaveValue(
    'Which way should the worker go on a Stripe 409: Retry with the same idempotency key. Ship the retry worker behind a flag: Yes.',
  );
  await expect(page.locator('[data-picks-chip]')).toHaveText('2 picks');
  await box.fill(`${await box.inputValue()} Keep the flag on for the test account first.`);
  await shot('2.6-reply-box');

  const reply = claude!.waitForReply(world.threads.stopped!, 50);
  await page.locator('.ib-pfoot').getByRole('button', { name: 'Send' }).click();
  const answered = await reply;
  expect(answered.status).toBe('replied');
  expect(answered.reply.body).toContain('Answered 2 questions.');
  expect(answered.reply.body).toContain('Keep the flag on for the test account first.');
  expect(answered.reply.body).toContain('Retry with the same idempotency key');
  expect(answered.questions.map((q: { state: string }) => q.state)).toEqual(['sent', 'sent']);

  const pane = page.locator('section.ib-pane');
  await expect(pane.locator('.ib-delivered')).toHaveAttribute('data-delivery', 'delivered');
  await expect(pane.locator('.ib-delivered')).toHaveText(/^Delivered to Claude Code, \d{1,2}:\d{2} [AP]M$/);
  await expect(pane.getByText(/^Sent \d{1,2}:\d{2} [AP]M$/)).toHaveCount(2);
  await expect(page.locator('.ib-pfoot').getByRole('button', { name: 'Reply', exact: true })).toBeVisible();
  await shot('2.x-sent-delivered');
});

test('"N new" waits behind the notice, and the list moves only on an action', async () => {
  const { page } = world;
  await page.keyboard.press('Escape');
  await expect(page.locator('section.ib-pane')).toHaveCount(0);
  const before = await rowOrder(page);
  const codex = await agent('Codex', 'codex');
  const news = await codex.send({ project_path: world.docs, body: DEMO_MESSAGES.news });
  await expect(page.locator('[data-inbox-notice]')).toContainText('1 new in docs-site');
  // Held: nothing moved, and the new thread is not on screen yet.
  await page.waitForTimeout(500);
  expect(await rowOrder(page)).toEqual(before);
  await expect(page.locator(`[data-thread-id="${news.thread_id}"]`)).toHaveCount(0);
  await shot('1.6-new-notice');

  await page.locator('[data-inbox-notice]').click();
  await expect(page.locator(`[data-section-id="new"] [data-thread-id="${news.thread_id}"]`)).toBeVisible();
  await expect(page.locator('[data-inbox-notice]')).toHaveCount(0);
});

// The failure this guards: the held list kept a row's whole state, so after the
// agent had the reply the row still said "Sent · Saved for <agent>" until a
// reload, while the thread beside it had moved on.
test("a Sent row follows the agent's read in place, without an action: its state changes, the order does not", async () => {
  const { page } = world;
  const claude2 = world.agents[2]!;
  await page.locator(`[data-thread-id="${world.threads.named}"]`).click();
  const pane = page.locator('section.ib-pane');
  await pane.getByText('Trust the webhook', { exact: true }).click();
  await expect(pane.getByText(/^Picked \d{1,2}:\d{2} [AP]M, not sent$/)).toBeVisible();
  await page.locator('.ib-pfoot').getByRole('button', { name: 'Send' }).click();
  const row = page.locator(`.ib-lbody [data-thread-id="${world.threads.named}"]`);
  await expect(row).toHaveAttribute('data-section', 'sent');
  await expect(row).toContainText('Saved for Claude Code');
  const before = await rowOrder(page);

  // The agent reads the reply (as a wake's delivery or wait_for_reply would): the server lists the thread as Quiet.
  await claude2.readThread(world.threads.named!);
  await expect(row).toHaveAttribute('data-section', 'quiet');
  await expect(row).not.toContainText('Saved for');
  expect(await rowOrder(page)).toEqual(before);
  await page.keyboard.press('Escape');
  await expect(pane).toHaveCount(0);
});

test('Settings: the agent tool knob applies to the next session, the compact picker, the store on disk', async () => {
  const { page } = world;
  await side(page).getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  const claudeSwitch = page.getByRole('switch', { name: 'The Inbox tool in Claude Code' });
  const piSwitch = page.getByRole('switch', { name: 'The Inbox tool in Pi' });
  await expect(claudeSwitch).toHaveAttribute('aria-checked', 'true');
  await expect(piSwitch).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByRole('switch', { name: 'The Inbox tool in OpenCode' })).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByText('Applies to the next session. Sessions already running keep what they started with.')).toBeVisible();

  const binary = realpathSync(world.binary);
  const other = page.getByRole('tabpanel', { name: 'Other MCP client' });
  await expect(other.locator('pre').nth(0)).toHaveText(`${binary} inbox mcp`);
  await expect(other.locator('pre').nth(1)).toHaveText(`http://127.0.0.1:${registry().port}/mcp`);
  await expectCodeUnclipped(page);

  const store = page.locator('.ib-stbl');
  await expect(store.locator('[data-store-project="billing-svc"]')).toContainText('2 threads');
  await expect(store.locator('[data-store-project="docs-site"]')).toContainText('2 threads');
  // Delete thread and delete project are live since step 2 (proved in inbox-attachments.spec.ts).
  await expect(store.getByRole('button', { name: /Delete project/ }).first()).toBeEnabled();
  await shot('7.1-settings');

  await piSwitch.click();
  await expect(piSwitch).toHaveAttribute('aria-checked', 'true');
  // The switch moves at the click; the save lands when the POST answers.
  await expect
    .poll(() => {
      try {
        return JSON.parse(readFileSync(join(world.dataDir, 'config.json'), 'utf8')).inboxTool;
      } catch {
        return null;
      }
    })
    .toEqual({ pi: true });
  await page.locator('.ib-spage').evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await shot('7.2-settings-storage');
  await side(page).getByRole('button', { name: /^Inbox/ }).click();
});

// Before the restart, whose gap (the old Inbox gone, the new one not yet up)
// the page's health polls see as refused connections, by design.
test('no page errors and no CSP refusals along the way', async () => {
  expect(world.errors).toEqual([]);
});

test('"A new version is ready, Restart" follows health, and Restart brings the new binary up', async () => {
  test.setTimeout(200_000);
  const { page } = world;
  const before = registry();
  // install.sh renames a new binary over the running one; this stand-in answers --version.
  const real = `${world.binary}.real`;
  renameSync(world.binary, real);
  writeFileSync(world.binary, '#!/bin/sh\necho "plannotator 9.9.9"\n', { mode: 0o755 });
  // The health tick (60 s) stats the file, sees it changed, and asks it.
  await expect(page.locator('.ib-restart')).toBeVisible({ timeout: 90_000 });
  await expect(page.locator('.ib-restart')).toContainText('A new version is ready');
  await shot('1.6-restart-to-update');

  // The real binary goes back on disk, then Restart starts it in this one's place.
  renameSync(real, world.binary);
  await page.locator('.ib-restart').getByRole('button', { name: 'Restart' }).click();
  await expect.poll(() => registry().serverSession, { timeout: 60_000 }).not.toBe(before.serverSession);
  const after = registry();
  expect(after.pid).not.toBe(before.pid);
  expect(after.port).toBe(before.port);
  // The page reloaded onto the new Inbox: the same store (the holding row, unfolded; named is Quiet now), the update line gone.
  await expect(page.locator(`[data-thread-id="${world.threads.holding}"]`)).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.ib-restart')).toHaveCount(0);
});
