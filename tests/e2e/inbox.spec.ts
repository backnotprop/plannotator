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

import { markTourDecided } from '../helpers/tour-decided';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DEMO_MESSAGES, SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';

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
  // Only this spec's own captures: attachments and guided reviews keep theirs in proof/attachments/ and proof/guides/.
  mkdirSync(proofDir, { recursive: true });
  for (const file of readdirSync(proofDir)) if (file.endsWith('.png') || file === 'index.html') rmSync(join(proofDir, file));
  const root = inboxScratch('plannotator-inbox-e2e-');
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
  // PATH: this world's own bin and the system's tools, never the agents installed on the machine running the
  // spec (the first-run screen speaks about the agents it finds: none here). No test sandbox: Settings → Agents
  // reads the Claude Code setup this spec writes under HOME, which the sandbox's agent home would hide.
  const env = { PATH: `${binDir}:/usr/bin:/bin`, HOME: home, PLANNOTATOR_DATA_DIR: dataDir };
  // The first-run connect screen, not the tour's entry screen (inbox-tour.spec.ts proves that one).
  markTourDecided(dataDir);
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
  try {
    if (!world) return;
    await Promise.all(world.agents.map((a) => a.close().catch(() => {})));
    await world.context.close();
    writeContactSheet();
  } finally {
    // Every Inbox this spec started, then its folders (inbox-scratch.ts).
    await removeInboxScratch();
  }
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

test('first run, nothing found: the first step offers Claude Code, Pi or OpenCode (install command to copy, MCP folded), then Try it, then every other agent folded', async () => {
  const { page, url } = world;
  await page.goto(url);
  const empty = page.locator('[data-inbox-empty]');
  await expect(page.getByRole('heading', { name: 'No agent has written yet', exact: true })).toBeVisible();
  // An Inbox an agent started (--background) connected nothing, and this scratch home has no agent: no note dialog.
  await expect(page.locator('dialog[data-dialog="agent-note"]')).toHaveCount(0);
  await expect(empty.getByRole('heading', { name: 'Try it', exact: true })).toBeVisible();
  await expect(empty.getByText('Send me a test message in my Plannotator Inbox.', { exact: true })).toBeVisible();
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

  // One next step (inbox-connect-next-step, variant C): Plannotator's own connections first.
  const step = empty.locator('.ib-cn');
  await expect(step.getByRole('heading', { name: 'Connect your first agent', exact: true })).toBeVisible();
  await expect(step.getByRole('radiogroup', { name: 'Your agent' }).getByRole('radio')).toHaveCount(3);
  const install = 'claude plugin marketplace add backnotprop/plannotator\nclaude plugin install plannotator@plannotator';
  await expect(step.locator('pre').first()).toHaveText(install);
  await step.getByRole('button', { name: 'Copy' }).first().click();
  await expect(step.getByRole('button', { name: 'Copied' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(install);
  // MCP stays one fold away, with Claude Code's user-scope command naming the binary by its absolute path.
  const binary = realpathSync(world.binary);
  const mcp = step.getByRole('button', { name: 'Use MCP instead', exact: true });
  await expect(mcp).toHaveAttribute('aria-expanded', 'false');
  await mcp.click();
  await expect(step.locator('pre').nth(1)).toHaveText(`claude mcp add --scope user plannotator-inbox -- ${binary} inbox mcp`);
  expect(binary.startsWith('/') && binary.endsWith('/a-long-install-directory-name-so-every-connect-command-has-to-wrap/bin/plannotator')).toBe(true);
  await expectCodeUnclipped(page);
  await page.mouse.move(0, 0);
  await shot('1.2-first-run-first-step');

  // One rhythm: the same gap between the heading, the step, the line saying which agents a reply wakes, Try it, the fold and the tour's quiet line
  // (the tour was decided before this Inbox started: "Take the 2-minute tour" ends the screen).
  await expect(empty.locator('[data-tour-again]')).toBeVisible();
  const boxes = await empty.evaluate((el) =>
    [...el.children].filter((child) => !child.classList.contains('ib-sr')).map((child) => child.getBoundingClientRect()).map((r) => ({ top: r.top, bottom: r.bottom })),
  );
  const gaps = boxes.slice(1).map((box, i) => Math.round(box.top - boxes[i]!.bottom));
  expect(gaps.length).toBe(5);
  expect(new Set(gaps).size).toBe(1);
  await expect(empty.locator('[data-wake-note]')).toContainText('Claude Code, Pi and OpenCode 2');

  // Every other agent or editor, folded at the end: the picker without Plannotator's three hosts.
  const byHand = empty.getByRole('button', { name: 'Another agent or editor', exact: true });
  await expect(byHand).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('tab', { name: 'Codex' })).toHaveCount(0);
  await byHand.click();
  await expect(byHand).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('tab', { name: 'Claude Code' })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'VS Code' })).toHaveAttribute('aria-selected', 'true');

  // Codex: the command with Copy, one note, the folded Another way, no eyebrow repeating the name.
  const codex = page.getByRole('tab', { name: 'Codex' });
  await codex.click();
  await expect(codex).toHaveAttribute('aria-selected', 'true');
  const command = `codex mcp add plannotator-inbox -- ${binary} inbox mcp`;
  const panel = page.getByRole('tabpanel', { name: 'Codex' });
  await expect(panel.locator('pre')).toHaveText(command);
  await expect(panel.locator('p')).toHaveText(['Also adds it to the Codex app and the IDE extension. Restart them after. With Codex 0.149 or later, your replies come back into the Codex thread by themselves.']);
  await expect(panel.getByText('Another way', { exact: false })).toBeVisible();
  await expect(panel.getByText('Codex', { exact: true })).toHaveCount(0);
  await shot('1.3-first-run-codex');
  await panel.getByRole('button', { name: 'Copy' }).click();
  await expect(panel.getByRole('button', { name: 'Copied' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(command);

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
    'New since you looked',
    'Sent',
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
  // The thread's name is the row's title (approval "list-rows-mail-icons").
  await expect(namedRow.locator('.ib-title')).toHaveText('refund-webhooks');
  await expect(page.locator('.ib-band')).toHaveText([/^Stopped on you\s*1$/, /^Holding up work\s*1$/, /^Waiting on you\s*1$/]);
  await expect(side(page).getByRole('button', { name: /^Inbox/ })).toContainText('3');
  await expect(side(page).getByRole('button', { name: /^billing-svc(?: \d+)?$/ })).toContainText('2');
  await expect(side(page).getByRole('button', { name: /^docs-site(?: \d+)?$/ })).toContainText('1');
  await shot('1.1-list');
});

/** A row cell's left edge, in px. */
async function leftOf(page: Page, selector: string): Promise<number> {
  const box = await page.locator(selector).first().boundingBox();
  expect(box, `no box for ${selector}`).not.toBeNull();
  return Math.round(box!.x);
}

test('a project folder filters the list and the sections still apply', async () => {
  const { page } = world;
  // Every project: the row starts with the project label, the agents' marks right after it, in the same column.
  const named = `.ib-row[data-thread-id="${world.threads.named}"]`;
  const stoppedRow = `.ib-row[data-thread-id="${world.threads.stopped}"]`;
  const labelLeft = await leftOf(page, `${named} .ib-p`);
  expect(await leftOf(page, '.ib-band')).toBe(labelLeft - 12);
  const labelRight = await page.locator(`${named} .ib-p`).evaluate((el) => el.getBoundingClientRect().right);
  expect(await leftOf(page, `${named} .ib-ags`)).toBeGreaterThan(labelRight);
  expect(await leftOf(page, `${named} .ib-ags`)).toBeLessThan(await leftOf(page, `${named} .ib-subj`));

  await side(page).getByRole('button', { name: /^docs-site(?: \d+)?$/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'docs-site' })).toBeVisible();
  // The header shows the name alone; the folder is the second line of the title's tooltip.
  await expect(page.locator('.ib-lhead .ib-path')).toHaveCount(0);
  await expect(page.locator('.ib-lhead')).not.toContainText('/');
  await page.getByRole('heading', { level: 1, name: 'docs-site' }).hover();
  await expect(page.locator('[data-project-tip] .ib-tip-path')).toHaveText(/docs-site$/);
  await page.mouse.move(5, 5);
  await expect(page.locator('.ib-lbody [data-thread-id]')).toHaveCount(1);
  await expect(page.locator('.ib-band')).toHaveText([/^Holding up work\s*1$/]);

  await side(page).getByRole('button', { name: /^billing-svc(?: \d+)?$/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'billing-svc' })).toBeVisible();
  await expect(page.locator('.ib-band')).toHaveText([/^Stopped on you\s*1$/, /^Waiting on you\s*1$/]);
  // One project: no project label. The agents' marks start the row where the
  // label did (approval "list-rows-mail-icons"), and the title cell starts on one
  // left edge for every row, badge or not. The badge and the count have their own
  // columns before the time, each on one right edge for every row.
  await expect(page.locator('.ib-row .ib-p')).toHaveCount(0);
  expect(await leftOf(page, `${named} .ib-ags`)).toBe(labelLeft);
  expect(await leftOf(page, `${stoppedRow} .ib-ags`)).toBe(labelLeft);
  expect(await leftOf(page, `${stoppedRow} .ib-subj`)).toBe(await leftOf(page, `${named} .ib-subj`));
  await expect(page.locator('.ib-row .ib-subj :is(.ib-mk, .ib-badge)')).toHaveCount(0);
  const rightOf = async (sel: string) => Math.round((await page.locator(sel).boundingBox())!.x + (await page.locator(sel).boundingBox())!.width);
  for (const cell of ['.ib-cw', '.ib-bcol', '.ib-cq']) expect(await rightOf(`${named} ${cell}`)).toBe(await rightOf(`${stoppedRow} ${cell}`));
  expect(await rightOf(`${stoppedRow} .ib-bcol .ib-badge`)).toBe(await rightOf(`${stoppedRow} .ib-bcol`));
  expect(await rightOf(`${named} .ib-cq`)).toBeLessThanOrEqual(await leftOf(page, `${named} .ib-t`));
  await shot('1.2-project-filter');
  await side(page).getByRole('button', { name: /^Inbox/ }).click();
  await expect(page.locator('.ib-lbody [data-thread-id]')).toHaveCount(3);
});

test('a row opens the thread as an email with the question cards, and no decision tag', async () => {
  const { page } = world;
  await page.locator(`[data-thread-id="${world.threads.stopped}"]`).click();
  const pane = page.locator('section.ib-pane');
  await expect(pane.getByRole('heading', { name: 'Which way should the worker go on a Stripe 409?' })).toBeVisible();
  await expect(pane.locator('.ib-who').first()).toHaveText('Claude Code');
  await expect(pane.locator('.ib-fl-meta').first()).toHaveText('in billing-svc · to you');
  await expect(pane.getByText('Question 1 of 2')).toBeVisible();
  await expect(pane.getByText('Question 2 of 2')).toBeVisible();
  await expect(pane.getByText('Waiting on this answer')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`#thread=${world.threads.stopped}$`));
  // Opening is a look: the row is no longer new to the person.
  await expect(page.locator(`.ib-nrow[data-thread-id="${world.threads.stopped}"]`)).toHaveAttribute('aria-current', 'true');

  // Decisions were removed (2026-10): no card carries a decision tag, switch or row.
  await expect(pane.locator('[data-question-decision], [data-question-decision-tag], [data-question-decision-toggle], [data-question-decision-row]')).toHaveCount(0);
  await expect(side(page).getByRole('button', { name: /Decisions/ })).toHaveCount(0);
  await shot('2.1-thread');
});

test('a pick is saved at once and the agent reads it through read_thread', async () => {
  const { page } = world;
  const [claude] = world.agents;
  const pane = page.locator('section.ib-pane');
  await pane.getByText('Retry with the same idempotency key', { exact: true }).click();
  await expect(pane.getByText(/^Picked \d{1,2}:\d{2} [AP]M · in your draft$/)).toBeVisible();
  await expect
    .poll(async () => {
      const thread = await claude!.readThread(world.threads.stopped!);
      const q = thread.messages[0].questions[0];
      return `${q.state}:${q.answer?.selected?.join('|')}`;
    })
    .toBe('picked:Retry with the same idempotency key');

  await pane.getByText('Yes', { exact: true }).click();
  await expect(pane.getByText(/^Picked .* · in your draft$/)).toHaveCount(2);
  // "Draft" replaces "Not sent" (approval "inbox-reply-drafts").
  await expect(page.locator('.ib-pfoot [data-draft-foot]')).toHaveText('Draft, 2 picks');
  await expect(page.locator('.ib-pfoot').getByRole('button', { name: 'Send' })).toBeVisible();
  await expect(page.locator('.ib-pfoot').getByRole('button', { name: 'Edit draft' })).toBeVisible();
  // Answered, not sent: it waits only for Send. The row says "Draft" (approval "inbox-row-byline", option A), and
  // "Draft · 2 picks" in its name.
  const row = page.locator(`.ib-nrow[data-thread-id="${world.threads.stopped}"]`);
  await expect(row).toHaveAttribute('data-section', 'new');
  await expect(row.locator('[data-draft-label]')).toHaveText('Draft');
  await expect(row).toHaveAccessibleName(/Draft · 2 picks/);
  await shot('3.1-answered-not-sent');

  // The row's draft words (a wide row's words column) must end before the time's
  // begins: in every project and in one,
  // at full and narrower widths (every project below 900px of list draws the
  // two-line row, whose count ends line 2 instead, inside the line). Measured on the text itself (a
  // Range), since overflowing text spills past its cell's box.
  const wide = page.locator(`.ib-lbody [data-thread-id="${world.threads.stopped}"]`);
  const textGap = () =>
    wide.evaluate((el) => {
      const rect = (cell: Element) => {
        const range = document.createRange();
        range.selectNodeContents(cell);
        return range.getBoundingClientRect();
      };
      const count = rect(el.querySelector('.ib-c .ib-cs')!);
      const time = rect(el.querySelector('.ib-t')!);
      // A three-line row's count ends line 3 (approval "list-rows-mail-icons"), under the time: it must end inside that line.
      const l2 = el.querySelector('.ib-l3');
      const lineEnd = l2 ? Math.round(l2.getBoundingClientRect().right - count.right) : null;
      return { shape: el.className.split(' ')[0], list: document.querySelector('.ib-lbody')!.clientWidth, text: el.querySelector('.ib-c .ib-cs')!.textContent, full: el.querySelector('.ib-c')!.getAttribute('data-count-words'), gap: time.left - count.right, sameLine: Math.abs(count.top - time.top) < 4, lineEnd, last: l2 ? l2.lastElementChild === el.querySelector('.ib-c') : null };
    });
  for (const [folder, narrowShape] of [[/^Inbox/, 'ib-nrow'], [/^billing-svc(?: \d+)?$/, 'ib-row']] as const) {
    await side(page).getByRole('button', { name: folder }).click();
    for (const width of [1440, 1000, 820]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(wide).toBeVisible();
      const where = `at ${width}px (${folder})`;
      if (width === 1440) await expect.poll(async () => (await textGap()).shape, where).toBe('ib-row');
      if (width === 820) await expect.poll(async () => (await textGap()).shape, where).toBe(narrowShape);
      // The folder click closes the thread and the list re-renders (and may
      // switch between the wide and the two-line row): measure once the row's
      // shape and gap hold still, at every width.
      await expect
        .poll(async () => {
          const first = await textGap();
          await page.waitForTimeout(150);
          return JSON.stringify(first) === JSON.stringify(await textGap());
        }, where)
        .toBe(true);
      const measured = await textGap();
      // A wide row in a list of 1150px or more draws the full words (the owner, 2026-10-29); a two-line row, and one
      // project's wide row in a narrower list, "Draft" (option A).
      expect(measured.text).toBe(measured.shape === 'ib-row' && measured.list >= 1150 ? 'Draft · 2 picks' : 'Draft');
      expect(measured.full).toBe('Draft · 2 picks');
      if (measured.shape === 'ib-row') {
        expect(measured.sameLine).toBe(true);
        expect(measured.gap, `count runs into the time ${where}`).toBeGreaterThanOrEqual(8);
      } else {
        expect(measured.sameLine, `the count sits on line 2 ${where}`).toBe(false);
        expect(measured.last, `the count ends line 2 ${where}`).toBe(true);
        expect(measured.lineEnd!, `the count runs past line 2 ${where}`).toBeGreaterThanOrEqual(0);
      }
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await side(page).getByRole('button', { name: /^Inbox/ }).click();
  await wide.click();
  await expect(page.locator('.ib-pfoot').getByRole('button', { name: 'Edit draft' })).toBeVisible();
});

test('Send carries the picks and the words, wait_for_reply returns them, and the thread says Delivered', async () => {
  const { page } = world;
  const [claude] = world.agents;
  await page.locator('.ib-pfoot').getByRole('button', { name: 'Edit draft' }).click();
  const box = page.getByRole('textbox', { name: 'Reply to Claude Code' });
  // The picks are listed in the box, never written into the words.
  await expect(box).toHaveValue('');
  await expect(page.locator('[data-reply-answers] [data-reply-answer]')).toHaveText([
    /Q1\s+Which way should the worker go on a Stripe 409\?\s+Retry with the same idempotency key/,
    /Q2\s+Ship the retry worker behind a flag\?\s+Yes/,
  ]);
  await expect(page.locator('[data-picks-chip]')).toHaveText('2 picks');
  await box.fill('Keep the flag on for the test account first.');
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
  // Leaving the thread is an action: rows the person's own writes held in place take their places now. Let that land first.
  await expect
    .poll(async () => {
      const first = await rowOrder(page);
      await page.waitForTimeout(250);
      return JSON.stringify(first) === JSON.stringify(await rowOrder(page));
    })
    .toBe(true);
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
  await expect(pane.getByText(/^Picked \d{1,2}:\d{2} [AP]M · in your draft$/)).toBeVisible();
  await page.locator('.ib-pfoot').getByRole('button', { name: 'Send' }).click();
  const row = page.locator(`.ib-lbody [data-thread-id="${world.threads.named}"]`);
  await expect(row).toHaveAttribute('data-section', 'sent');
  // The delivery glyph (approval "inbox-row-delivery"): saved, an agent reads it later.
  const tick = row.locator('.ib-tick');
  await expect(tick).toHaveAttribute('data-tick', 'saved');
  const before = await rowOrder(page);

  // The agent reads the reply (as a wake's delivery or wait_for_reply would): the server lists the thread as Quiet.
  await claude2.readThread(world.threads.named!);
  await expect(row).toHaveAttribute('data-section', 'quiet');
  await expect(tick).toHaveAttribute('data-tick', 'delivered');
  expect(await rowOrder(page)).toEqual(before);
  await page.keyboard.press('Escape');
  await expect(pane).toHaveCount(0);
});

test('Settings: in sections; Settings → Agents switches apply to the next session, the picker for the rest, the store on disk', async () => {
  const { page } = world;
  // Plannotator's Claude Code plugin and Pi extension in this world's scratch home: both are found, each with its tool switch.
  mkdirSync(join(world.env.HOME!, '.claude'), { recursive: true });
  writeFileSync(join(world.env.HOME!, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'plannotator@plannotator': true } }));
  mkdirSync(join(world.env.HOME!, '.pi', 'agent'), { recursive: true });
  writeFileSync(join(world.env.HOME!, '.pi', 'agent', 'settings.json'), JSON.stringify({ packages: ['npm:@plannotator/pi-extension'] }));
  await side(page).getByRole('button', { name: 'Settings' }).click();
  // A focused page (design of record inbox-settings-tabs): General first, the section nav beside it.
  await expect(page.getByRole('heading', { name: 'General', level: 1 })).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Settings sections' });
  await expect(nav.getByRole('link')).toHaveText(['General', 'Agents', 'Prompts', 'Devices', 'Capabilities', 'Archived', 'Storage', 'About']);
  await nav.getByRole('link', { name: 'Agents' }).click();
  await expect(page).toHaveURL(/#settings\/agents$/);
  await expect(nav.getByRole('link', { name: 'Agents' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('heading', { name: 'Agents', level: 1 })).toBeFocused();
  const claudeSwitch = page.getByRole('switch', { name: 'Reaches the Inbox: Claude Code' });
  const piSwitch = page.getByRole('switch', { name: 'Reaches the Inbox: Pi' });
  await expect(claudeSwitch).toHaveAttribute('aria-checked', 'true');
  await expect(piSwitch).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByRole('switch', { name: 'Reminder at session start: Pi' })).toBeDisabled();
  await expect(page.getByText("A change applies to that agent's next session; sessions already running keep what they started with.")).toBeVisible();
  // Phones stay hidden until the iPhone app ships (PLANNOTATOR_INBOX_PHONES is unset here): no block, no mention.
  await expect(page.locator('[data-settings-phones]')).toHaveCount(0);
  await expect(page.getByText('Phones reach it only on a path you turn on below.')).toHaveCount(0);

  const binary = realpathSync(world.binary);
  await page.getByRole('button', { name: /^Not found on this computer/ }).click();
  await page.getByRole('tab', { name: 'Other MCP client' }).click();
  const other = page.getByRole('tabpanel', { name: 'Other MCP client' });
  await expect(other.locator('pre').nth(0)).toHaveText(`${binary} inbox mcp`);
  await expect(other.locator('pre').nth(1)).toHaveText(`http://127.0.0.1:${registry().port}/mcp`);
  await expectCodeUnclipped(page);

  await shot('7.1-settings');
  await nav.getByRole('link', { name: 'Storage' }).click();
  const store = page.locator('.ib-stbl');
  await expect(store.locator('[data-store-project="billing-svc"]')).toContainText('2 threads');
  await expect(store.locator('[data-store-project="docs-site"]')).toContainText('2 threads');
  // Delete thread and delete project are live since step 2 (proved in inbox-attachments.spec.ts).
  await expect(store.getByRole('button', { name: /Delete project/ }).first()).toBeEnabled();

  await nav.getByRole('link', { name: 'Agents' }).click();
  await piSwitch.click();
  await expect(piSwitch).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByText("Pi's next session").first()).toBeVisible();
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
  await nav.getByRole('link', { name: 'Storage' }).click();
  await shot('7.2-settings-storage');
  // The sidebar slid away for Settings; "← Inbox" is the way back.
  await page.locator('[data-settings-back]').click();
  await expect(page).not.toHaveURL(/#settings/);
});

// Late, in a project of its own, so its threads change no count above (review of #2374, finding 1).
test("one project's list: three agents with ×N stay in the marks' column and end before the title, at its widest and narrowest", async () => {
  const { page } = world;
  const ops = scratchProject(join(world.root, 'src'), 'ops-console');
  // Hosts this spec has already seen: a host new to it brings the agent-note dialog, over the Update test below.
  const [claudeA, claudeB, codexA, codexB, codexC, opencodeA, opencodeB] = [
    await agent('Claude Code', 'claude-code'),
    await agent('Claude Code', 'claude-code'),
    await agent('Codex', 'codex'),
    await agent('Codex', 'codex'),
    await agent('Codex', 'codex'),
    await agent('OpenCode', 'opencode'),
    await agent('OpenCode', 'opencode'),
  ];
  const ask = (prompt: string) => [':::question', prompt, '', '- [ ] Yes', '- [ ] No', ':::'].join('\n');
  // Three hosts, each with "×N" (Claude Code ×2, Codex ×3, OpenCode ×2): the widest run of three marks.
  const trio = await claudeA!.send({ project_path: ops, thread: 'three-agents', subject: 'Three agents, each twice or more', body: ask('Keep the icons in their column?') });
  for (const a of [claudeB, codexA, codexB, codexC, opencodeA, opencodeB]) await a!.send({ project_path: ops, reply_to: trio.thread_id, body: 'Here too.' });
  // Three hosts, one session each: the common run.
  const plain = await claudeA!.send({ project_path: ops, thread: 'three-plain', subject: 'Three agents, one session each', body: ask('Three bare marks?') });
  for (const a of [codexA, opencodeA]) await a!.send({ project_path: ops, reply_to: plain.thread_id, body: 'Joined.' });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(world.url);
  await side(page).getByRole('button', { name: /^ops-console(?: \d+)?$/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'ops-console' })).toBeVisible();
  await expect(page.locator('.ib-lbody .ib-row')).toHaveCount(2);
  await expect(page.locator(`.ib-row[data-thread-id="${trio.thread_id}"] .ib-ags`)).toHaveAttribute('aria-label', '2 Claude Code sessions, 3 Codex sessions and 2 OpenCode sessions');
  await expect(page.locator(`.ib-row[data-thread-id="${trio.thread_id}"] .ib-agx`)).toHaveText(['×2', '×3', '×2']);
  // 1440: the column's widest (112 px), the runs on one line. 1000: its narrowest (80 px), the runs wrap inside it.
  for (const width of [1440, 1000]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(150);
    const rows = await page.locator('.ib-lbody .ib-row').evaluateAll((els) =>
      els.map((r) => {
        const from = r.querySelector('.ib-from')!.getBoundingClientRect();
        const marks = r.querySelector('.ib-ags')!;
        const parts = [...marks.children].map((c) => c.getBoundingClientRect());
        const box = r.getBoundingClientRect();
        return {
          id: (r as HTMLElement).dataset.threadId,
          drawn: marks.querySelectorAll(':scope > .ib-ag').length,
          lines: new Set(parts.map((b) => Math.round(b.top))).size,
          marksRight: Math.max(...parts.map((b) => b.right)),
          marksTop: Math.min(...parts.map((b) => b.top)),
          marksBottom: Math.max(...parts.map((b) => b.bottom)),
          rowTop: box.top,
          rowBottom: box.bottom,
          fromRight: from.right,
          titleLeft: r.querySelector('.ib-subj')!.getBoundingClientRect().left,
        };
      }),
    );
    for (const r of rows) {
      const where = `row ${r.id} at ${width}`;
      expect(r.drawn, where).toBe(3);
      if (width === 1440) expect(r.lines, `${where}: the run wraps at the column's widest`).toBe(1);
      // Every mark and "×N" ends inside the marks' column (wrapping there when the run is wider), before the
      // title starts; none spills out of the row.
      expect(r.marksRight, `${where}: the marks run into the title`).toBeLessThanOrEqual(r.titleLeft);
      expect(r.marksRight, `${where}: the marks leave their column`).toBeLessThanOrEqual(r.fromRight + 0.5);
      expect(r.marksTop, where).toBeGreaterThanOrEqual(r.rowTop);
      expect(r.marksBottom, where).toBeLessThanOrEqual(r.rowBottom);
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  // These sessions bring the agent-note dialog on this load (docs/agent-guides/inbox-foundation.md, asked once per
  // agent): answer it "Not now", or it opens again over the Update test below.
  const note = page.locator('dialog[data-dialog="agent-note"]');
  await note.waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {});
  if (await note.isVisible()) {
    const notNow = note.locator('[data-anote-notnow]');
    if (await notNow.count()) await notNow.click();
    else await page.keyboard.press('Escape');
    await expect(note).toHaveCount(0);
  }
  await shot('1.3-project-filter-agents');
  await side(page).getByRole('button', { name: /^Inbox/ }).click();
});

// Before the restart, whose gap (the old Inbox gone, the new one not yet up)
// the page's health polls see as refused connections, by design.
test('no page errors and no CSP refusals along the way', async () => {
  expect(world.errors).toEqual([]);
});

test('the Update button follows health ("ready"), and pressing it brings the new binary up', async () => {
  test.setTimeout(200_000);
  const { page } = world;
  const before = registry();
  // install.sh renames a new binary over the running one; this stand-in answers --version.
  const real = `${world.binary}.real`;
  renameSync(world.binary, real);
  writeFileSync(world.binary, '#!/bin/sh\necho "plannotator 9.9.9"\n', { mode: 0o755 });
  // The health tick (60 s) stats the file, sees it changed, and asks it.
  const button = page.locator('.ib-upd[data-update-state="ready"]');
  await expect(button).toBeVisible({ timeout: 90_000 });
  await expect(button.getByRole('button', { name: 'Update to 9.9.9', exact: true })).toBeVisible();
  await shot('1.6-restart-to-update');

  // The real binary goes back on disk, then Restart starts it in this one's place.
  renameSync(real, world.binary);
  await button.getByRole('button', { name: 'Update to 9.9.9', exact: true }).click();
  await expect.poll(() => registry().serverSession, { timeout: 60_000 }).not.toBe(before.serverSession);
  const after = registry();
  expect(after.pid).not.toBe(before.pid);
  expect(after.port).toBe(before.port);
  // The page reloaded onto the new Inbox: the same store (the holding row, unfolded; named is Quiet now), the update line gone.
  await expect(page.locator(`[data-thread-id="${world.threads.holding}"]`)).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.ib-upd')).toHaveCount(0);
});
