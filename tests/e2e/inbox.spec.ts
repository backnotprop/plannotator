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

function side(page: Page) {
  return page.getByRole('complementary', { name: 'Inbox navigation' });
}

async function rowOrder(page: Page): Promise<string[]> {
  return page.locator('.ib-lbody [data-thread-id]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-thread-id') ?? ''));
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(builtBinary), `build the binary first: ${builtBinary}`).toBe(true);
  mkdirSync(proofDir, { recursive: true });
  for (const file of readdirSync(proofDir)) if (file.endsWith('.png') || file === 'index.html') rmSync(join(proofDir, file));
  const root = inboxScratch('plannotator-inbox-e2e-');
  const binDir = join(root, 'a-long-install-directory-name-so-every-connect-command-has-to-wrap', 'bin');
  const binary = join(binDir, 'plannotator');
  mkdirSync(binDir, { recursive: true });
  copyFileSync(builtBinary, binary);
  chmodSync(binary, 0o755);
  const dataDir = join(root, 'data');
  const home = join(root, 'home');
  mkdirSync(home);
  const env = { PATH: `${binDir}:/usr/bin:/bin`, HOME: home, PLANNOTATOR_DATA_DIR: dataDir };
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

async function expectCodeUnclipped(page: Page): Promise<void> {
  const boxes = await page.locator('.ib-cbox pre:visible').evaluateAll((els) => els.map((el) => ({ text: el.textContent ?? '', scroll: el.scrollWidth, client: el.clientWidth })));
  expect(boxes.length).toBeGreaterThan(0);
  for (const box of boxes) expect(box.scroll, `clipped: ${box.text}`).toBeLessThanOrEqual(box.client);
}

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
  await expect(page.locator('dialog[data-dialog="agent-note"]')).toHaveCount(0);
  await expect(empty.getByRole('heading', { name: 'Try it', exact: true })).toBeVisible();
  await expect(empty.getByText('Send me a test message in my Plannotator Inbox.', { exact: true })).toBeVisible();
  await expect(page.getByText('Projects appear here when an agent writes from one.')).toBeVisible();

  const tater = page.locator('[data-sprite="tater-sidebar"]');
  const motion = () => tater.evaluate((el) => {
    const style = getComputedStyle(el);
    return `${style.animationName} ${style.animationDuration} ${style.animationTimingFunction} ${style.animationPlayState}`;
  });
  expect(await motion()).toBe('ib-tater-sidebar 3.5s steps(24) running');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect((await motion()).startsWith('none ')).toBe(true);
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  const step = empty.locator('.ib-cn');
  await expect(step.getByRole('heading', { name: 'Connect your first agent', exact: true })).toBeVisible();
  await expect(step.getByRole('radiogroup', { name: 'Your agent' }).getByRole('radio')).toHaveCount(3);
  const install = 'claude plugin marketplace add backnotprop/plannotator\nclaude plugin install plannotator@plannotator';
  await expect(step.locator('pre').first()).toHaveText(install);
  await step.getByRole('button', { name: 'Copy' }).first().click();
  await expect(step.getByRole('button', { name: 'Copied' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(install);
  const binary = realpathSync(world.binary);
  const mcp = step.getByRole('button', { name: 'Use MCP instead', exact: true });
  await expect(mcp).toHaveAttribute('aria-expanded', 'false');
  await mcp.click();
  await expect(step.locator('pre').nth(1)).toHaveText(`claude mcp add --scope user plannotator-inbox -- ${binary} inbox mcp`);
  expect(binary.startsWith('/') && binary.endsWith('/a-long-install-directory-name-so-every-connect-command-has-to-wrap/bin/plannotator')).toBe(true);
  await expectCodeUnclipped(page);
  await page.mouse.move(0, 0);
  await shot('1.2-first-run-first-step');

  await expect(empty.locator('[data-tour-again]')).toBeVisible();
  await expect(empty.locator('[data-tour-again]')).not.toHaveClass(/ib-tour-mark/);
  await expect(empty.locator('[data-tour-again]')).toHaveCSS('outline-style', 'none');
  const boxes = await empty.evaluate((el) =>
    [...el.children].filter((child) => !child.classList.contains('ib-sr')).map((child) => child.getBoundingClientRect()).map((r) => ({ top: r.top, bottom: r.bottom })),
  );
  const gaps = boxes.slice(1).map((box, i) => Math.round(box.top - boxes[i]!.bottom));
  expect(gaps.length).toBe(5);
  expect(new Set(gaps).size).toBe(1);
  await expect(empty.locator('[data-wake-note]')).toContainText('Claude Code, Pi and OpenCode 2');

  const byHand = empty.getByRole('button', { name: 'Another agent or editor', exact: true });
  await expect(byHand).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('tab', { name: 'Codex' })).toHaveCount(0);
  await byHand.click();
  await expect(byHand).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('tab', { name: 'Claude Code' })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'VS Code' })).toHaveAttribute('aria-selected', 'true');

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

  const list = await (await page.request.get(`${world.url}api/inbox/threads`)).json();
  expect(list.sections.map((s: { label: string }) => s.label)).toEqual([
    'Stopped on you',
    'Holding up work',
    'Waiting on you',
    'New since you looked',
    'Sent',
    'Quiet',
  ]);

  const notice = page.locator('[data-inbox-notice]');
  await expect.poll(async () => (await notice.count()) > 0 || (await page.locator('.ib-lbody [data-thread-id]').count()) === 3).toBe(true);
  if (await notice.count()) await notice.click();
  const stoppedRow = page.locator(`[data-section-id="stopped"] [data-thread-id="${stopped.thread_id}"]`);
  await expect(stoppedRow).toBeVisible();
  await expect(stoppedRow.locator('.ib-qn[data-wait-step="stop"] .ib-sr')).toHaveText('Stopped on you: 2 questions');
  await expect(stoppedRow).toContainText('2 questions');
  await expect(stoppedRow).toContainText('billing-svc');
  const holdingRow = page.locator(`[data-section-id="holding"] [data-thread-id="${holding.thread_id}"]`);
  await expect(holdingRow.locator('.ib-qn[data-wait-step="hold"]')).toHaveCount(1);
  const namedRow = page.locator(`[data-section-id="waiting"] [data-thread-id="${named.thread_id}"]`);
  await expect(namedRow.locator('.ib-title')).toHaveText('refund-webhooks');
  await expect(page.locator('.ib-band')).toHaveText([/^Stopped on you\s*1$/, /^Holding up work\s*1$/, /^Waiting on you\s*1$/]);
  await expect(side(page).getByRole('button', { name: /^Inbox/ })).toContainText('3');
  await expect(side(page).getByRole('button', { name: /^billing-svc(?: \d+)?$/ })).toContainText('2');
  await expect(side(page).getByRole('button', { name: /^docs-site(?: \d+)?$/ })).toContainText('1');
  await shot('1.1-list');
});

async function leftOf(page: Page, selector: string): Promise<number> {
  const box = await page.locator(selector).first().boundingBox();
  expect(box, `no box for ${selector}`).not.toBeNull();
  return Math.round(box!.x);
}

test('a project folder filters the list and the sections still apply', async () => {
  const { page } = world;
  const named = `.ib-row[data-thread-id="${world.threads.named}"]`;
  const stoppedRow = `.ib-row[data-thread-id="${world.threads.stopped}"]`;
  const labelLeft = await leftOf(page, `${named} .ib-ags`);
  expect(await leftOf(page, '.ib-band')).toBe(labelLeft - 12);
  const marksRight = await page.locator(`${named} .ib-ags`).evaluate((el) => el.getBoundingClientRect().right);
  const projectLeft = await page.locator(`${named} .ib-p`).evaluate((el) => el.getBoundingClientRect().left);
  expect(Math.abs(projectLeft - marksRight - 6)).toBeLessThanOrEqual(0.5);
  expect(await leftOf(page, `${named} .ib-p`)).toBeLessThan(await leftOf(page, `${named} .ib-subj`));

  await side(page).getByRole('button', { name: /^docs-site(?: \d+)?$/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'docs-site' })).toBeVisible();
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
  await expect(page.locator('.ib-row .ib-p')).toHaveCount(0);
  expect(await leftOf(page, `${named} .ib-ags`)).toBe(labelLeft);
  expect(await leftOf(page, `${stoppedRow} .ib-ags`)).toBe(labelLeft);
  for (const row of [named, stoppedRow]) {
    const gap = await page.locator(row).evaluate((r) => r.querySelector('.ib-subj')!.getBoundingClientRect().left - r.querySelector('.ib-ags')!.getBoundingClientRect().right);
    expect(Math.abs(gap - 6), `${row}: the title 6px after the marks`).toBeLessThanOrEqual(0.5);
  }
  await expect(page.locator('.ib-row .ib-subj :is(.ib-mk, .ib-badge)')).toHaveCount(0);
  const rightOf = async (sel: string) => Math.round((await page.locator(sel).boundingBox())!.x + (await page.locator(sel).boundingBox())!.width);
  for (const cell of ['.ib-cw', '.ib-bcol', '.ib-cq']) expect(await rightOf(`${named} ${cell}`)).toBe(await rightOf(`${stoppedRow} ${cell}`));
  expect(await rightOf(`${stoppedRow} .ib-cq .ib-qn`)).toBe(await rightOf(`${stoppedRow} .ib-cq`));
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
  await expect(page.locator(`.ib-nrow[data-thread-id="${world.threads.stopped}"]`)).toHaveAttribute('aria-current', 'true');

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
  await expect(page.locator('.ib-pfoot [data-draft-foot]')).toHaveText('Draft, 2 picks');
  await expect(page.locator('.ib-pfoot').getByRole('button', { name: 'Send' })).toBeVisible();
  await expect(page.locator('.ib-pfoot').getByRole('button', { name: 'Edit draft' })).toBeVisible();
  const row = page.locator(`.ib-nrow[data-thread-id="${world.threads.stopped}"]`);
  await expect(row).toHaveAttribute('data-section', 'new');
  await expect(row.locator('[data-draft-label]')).toHaveText('Draft');
  await expect(row).toHaveAccessibleName(/Draft · 2 picks/);
  await shot('3.1-answered-not-sent');

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
      await expect
        .poll(async () => {
          const first = await textGap();
          await page.waitForTimeout(150);
          return JSON.stringify(first) === JSON.stringify(await textGap());
        }, where)
        .toBe(true);
      const measured = await textGap();
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

test('Send carries the picks and the words, read_thread returns them, and the thread says Delivered', async () => {
  const { page } = world;
  const [claude] = world.agents;
  await page.locator('.ib-pfoot').getByRole('button', { name: 'Edit draft' }).click();
  const box = page.getByRole('textbox', { name: 'Reply to Claude Code' });
  await expect(box).toHaveValue('');
  await expect(page.locator('[data-reply-answers] [data-reply-answer]')).toHaveText([
    /Q1\s+Which way should the worker go on a Stripe 409\?\s+Retry with the same idempotency key/,
    /Q2\s+Ship the retry worker behind a flag\?\s+Yes/,
  ]);
  await expect(page.locator('[data-picks-chip]')).toHaveText('2 picks');
  await box.fill('Keep the flag on for the test account first.');
  await shot('2.6-reply-box');

  await page.locator('.ib-pfoot').getByRole('button', { name: 'Send' }).click();
  const answered = await claude!.nextReply(world.threads.stopped!, 50);
  expect(answered.body).toContain('Answered 2 questions.');
  expect(answered.body).toContain('Keep the flag on for the test account first.');
  expect(answered.body).toContain('Retry with the same idempotency key');
  const asked = await claude!.readThread(world.threads.stopped!);
  expect((asked.messages as { questions?: { state: string }[] }[]).flatMap((m) => m.questions ?? []).map((q) => q.state)).toEqual(['sent', 'sent']);

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
  await page.waitForTimeout(500);
  expect(await rowOrder(page)).toEqual(before);
  await expect(page.locator(`[data-thread-id="${news.thread_id}"]`)).toHaveCount(0);
  await shot('1.6-new-notice');

  await page.locator('[data-inbox-notice]').click();
  await expect(page.locator(`[data-section-id="new"] [data-thread-id="${news.thread_id}"]`)).toBeVisible();
  await expect(page.locator('[data-inbox-notice]')).toHaveCount(0);
});

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
  const tick = row.locator('.ib-tick');
  await expect(tick).toHaveAttribute('data-tick', 'saved');
  const before = await rowOrder(page);

  await claude2.readThread(world.threads.named!);
  await expect(row).toHaveAttribute('data-section', 'quiet');
  await expect(tick).toHaveAttribute('data-tick', 'delivered');
  expect(await rowOrder(page)).toEqual(before);
  await page.keyboard.press('Escape');
  await expect(pane).toHaveCount(0);
});

test('Settings: in sections; Settings → Agents switches apply to the next session, the picker for the rest, the store on disk', async () => {
  const { page } = world;
  mkdirSync(join(world.env.HOME!, '.claude'), { recursive: true });
  writeFileSync(join(world.env.HOME!, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'plannotator@plannotator': true } }));
  mkdirSync(join(world.env.HOME!, '.pi', 'agent'), { recursive: true });
  writeFileSync(join(world.env.HOME!, '.pi', 'agent', 'settings.json'), JSON.stringify({ packages: ['npm:@plannotator/pi-extension'] }));
  await side(page).getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'General', level: 1 })).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Settings sections' });
  await expect(nav.getByRole('link')).toHaveText(['General', 'Rows', 'Agents', 'Prompts', 'Devices', 'Machines', 'Accounts', 'Voice', 'Capabilities', 'Activity', 'Archived', 'Storage', 'About']);
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
  await expect(store.locator('[data-store-project="billing-svc"]').getByRole('button', { name: 'Delete from Inbox: billing-svc' })).toBeEnabled();

  await nav.getByRole('link', { name: 'Agents' }).click();
  await piSwitch.click();
  await expect(piSwitch).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByText("Pi's next session").first()).toBeVisible();
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
  await page.locator('[data-settings-back]').click();
  await expect(page).not.toHaveURL(/#settings/);
});

test("one project's list: three overlapping tiles, logos whole, with or without \"+N\", on one line, and the title 6px after each row's own tiles; at 780 and 768 every row keeps a readable title and its columns, and the tile holds on a hovered row", async () => {
  const { page } = world;
  const ops = scratchProject(join(world.root, 'src'), 'ops-console');
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
  const trio = await claudeA!.send({ project_path: ops, thread: 'three-agents', subject: 'Three agents, each twice or more', body: ask('Keep the icons in their column?') });
  for (const a of [claudeB, codexA, codexB, codexC, opencodeA, opencodeB]) await a!.send({ project_path: ops, reply_to: trio.thread_id, body: 'Here too.' });
  const plain = await claudeA!.send({ project_path: ops, thread: 'three-plain', subject: 'Three agents, one session each', body: ask('Three tiles?') });
  for (const a of [codexA, opencodeA]) await a!.send({ project_path: ops, reply_to: plain.thread_id, body: 'Joined.' });
  const solo = await claudeA!.send({ project_path: ops, thread: 'one-mark', subject: 'One agent', body: ask('One tile?') });
  const listRoute = '**/api/inbox/threads?archived=exclude*';
  await page.route(listRoute, async (route) => {
    const response = await route.fetch({ url: route.request().url().replace(/&since=[^&]*/, '') });
    const model = (await response.json()) as { sections: { threads: Record<string, unknown>[] }[] };
    for (const row of model.sections.flatMap((s) => s.threads)) {
      if (row.thread_id === trio.thread_id) row.answered_not_sent = true;
      if (row.thread_id === plain.thread_id) row.delivery = { kind: 'reply', state: 'queued', reason: 'working', send_now: false, message_id: 'msg_waiting', at: null, host: 'claude-code', name: 'Claude Code', waiting_since: new Date(Date.now() - 14 * 60_000).toISOString(), steerable: false, auto_send_at: null };
      if (row.thread_id === solo.thread_id) row.unsent = { reply_at: new Date().toISOString(), picks: 2, comments: 3 };
    }
    await route.fulfill({ response, json: model });
  });

  const answerNote = async () => {
    const note = page.locator('dialog[data-dialog="agent-note"]');
    await note.waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {});
    if (await note.isVisible()) {
      const notNow = note.locator('[data-anote-notnow]');
      if (await notNow.count()) await notNow.click();
      else await page.keyboard.press('Escape');
      await expect(note).toHaveCount(0);
    }
  };

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(world.url);
  await answerNote();
  await side(page).getByRole('button', { name: /^ops-console(?: \d+)?$/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'ops-console' })).toBeVisible();
  await expect(page.locator('.ib-lbody .ib-row')).toHaveCount(3);
  await expect(page.locator(`.ib-row[data-thread-id="${trio.thread_id}"] .ib-ags`)).toHaveAttribute('aria-label', '2 Claude Code sessions, 3 Codex sessions and 2 OpenCode sessions');
  await expect(page.locator(`.ib-row[data-thread-id="${trio.thread_id}"] .ib-atile`)).toHaveCount(3);
  await expect(page.locator(`.ib-row[data-thread-id="${trio.thread_id}"] .ib-agplus`)).toHaveText('+4');
  await expect(page.locator(`.ib-row[data-thread-id="${plain.thread_id}"] .ib-agplus`)).toHaveCount(0);
  const overlaps = (id: string) =>
    page.locator(`.ib-row[data-thread-id="${id}"] .ib-ags`).evaluate((run) => {
      const tiles = [...run.querySelectorAll('.ib-atile')];
      const plus = run.querySelector(':scope > .ib-agplus')?.getBoundingClientRect() ?? null;
      return {
        tiles: tiles.map((m) => ({ left: m.getBoundingClientRect().left, right: m.getBoundingClientRect().right })),
        cut: tiles.some((m) => getComputedStyle(m).maskImage !== 'none'),
        whole: tiles.map((t) => {
          const logo = t.querySelector('.ib-mk')!.getBoundingClientRect();
          return document.elementFromPoint(logo.right - 0.5, (logo.top + logo.bottom) / 2)?.closest('.ib-atile') === t;
        }),
        plusLeft: plus?.left ?? null,
        last: run.lastElementChild!.classList.contains('ib-agplus'),
      };
    });
  const expectOverlap = (run: Awaited<ReturnType<typeof overlaps>>, where: string, plus: boolean) => {
    for (let i = 1; i < run.tiles.length; i++) {
      expect(run.tiles[i - 1]!.right - run.tiles[i]!.left, `${where}: tile ${i} over the one before it`).toBeCloseTo(5, 1);
    }
    expect(run.cut, `${where}: a tile is cut`).toBe(false);
    expect(run.whole, `${where}: every logo whole`).toEqual(run.tiles.map(() => true));
    expect(run.last, `${where}: "+N" ends the run`).toBe(plus);
    if (plus) expect(run.plusLeft!, `${where}: "+N" after the tiles`).toBeGreaterThanOrEqual(run.tiles.at(-1)!.right);
  };
  expectOverlap(await overlaps(trio.thread_id), 'three tiles and "+4"', true);
  expectOverlap(await overlaps(plain.thread_id), 'three tiles', false);
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
          drawn: marks.querySelectorAll('.ib-atile').length,
          drift: Math.max(...parts.map((b) => (b.top + b.bottom) / 2)) - Math.min(...parts.map((b) => (b.top + b.bottom) / 2)),
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
    for (const r of rows.filter((row) => row.id !== solo.thread_id)) {
      const where = `row ${r.id} at ${width}`;
      expect(r.drawn, where).toBe(3);
      expect(r.drift, `${where}: the run must stay on one line`).toBeLessThanOrEqual(1);
      expect(Math.abs(r.titleLeft - r.marksRight - 6), `${where}: the title 6px after the tiles`).toBeLessThanOrEqual(0.5);
      expect(r.marksRight, `${where}: the marks leave their cell`).toBeLessThanOrEqual(r.fromRight + 0.5);
      expect(r.marksTop, where).toBeGreaterThanOrEqual(r.rowTop);
      expect(r.marksBottom, where).toBeLessThanOrEqual(r.rowBottom);
    }
  }
  const waitPill = page.locator(`.ib-row[data-thread-id="${plain.thread_id}"] [data-undelivered]`);
  await expect(waitPill).toBeVisible();
  expect(await waitPill.locator('.ib-bwt').evaluate((t) => t.scrollWidth > t.clientWidth + 0.5), 'the pill is cut at 1000').toBe(false);
  const narrowRows = async (label: string) => {
    for (const width of [780, 768]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(150);
      const rows = await page.locator('.ib-lbody .ib-row').evaluateAll((els) =>
        els.map((r) => {
          const box = (sel: string) => r.querySelector(sel)!.getBoundingClientRect();
          const parts = [...r.querySelector('.ib-ags')!.children].map((c) => c.getBoundingClientRect());
          const words = r.querySelector('.ib-cw > .ib-c')?.getBoundingClientRect() ?? null;
          const staying = r.querySelector('.ib-cw :is(.ib-cst, .ib-draft-l)');
          const pill = r.querySelector('.ib-cw [data-undelivered]');
          return {
            id: (r as HTMLElement).dataset.threadId,
            counts: box('.ib-cq').right,
            time: box('.ib-t').right,
            inner: r.getBoundingClientRect().right - parseFloat(getComputedStyle(r).paddingRight),
            title: box('.ib-subj').width,
            spill: r.scrollWidth - r.clientWidth,
            drift: Math.max(...parts.map((b) => (b.top + b.bottom) / 2)) - Math.min(...parts.map((b) => (b.top + b.bottom) / 2)),
            wordsIn: words ? words.left >= box('.ib-cw').left - 0.5 && words.left >= box('.ib-subj').right && words.right <= box('.ib-bcol').left : null,
            staying: staying ? { text: staying.textContent, cut: staying.scrollWidth > staying.clientWidth + 0.5 } : null,
            wordsWidth: box('.ib-cw').width,
            pillShown: pill ? getComputedStyle(pill).display !== 'none' : null,
            pillSpoken: pill ? (r.querySelector('.ib-cw .ib-sr')?.textContent ?? '') : null,
            clock: pill ? r.querySelector('.ib-t [data-tick="queued"]') !== null : null,
            marksTop: Math.min(...[...r.querySelector('.ib-ags')!.children].map((c) => c.getBoundingClientRect().top)),
            marksBottom: Math.max(...[...r.querySelector('.ib-ags')!.children].map((c) => c.getBoundingClientRect().bottom)),
            rowTop: r.getBoundingClientRect().top,
            rowBottom: r.getBoundingClientRect().bottom,
          };
        }),
      );
      expect(rows.length, `${label} at ${width}`).toBe(3);
      for (const r of rows) {
        const where = `${label}, row ${r.id} at ${width}`;
        expect(Math.abs(r.counts - rows[0]!.counts), `${where}: the counts move`).toBeLessThanOrEqual(0.5);
        expect(Math.abs(r.time - rows[0]!.time), `${where}: the time moves`).toBeLessThanOrEqual(0.5);
        expect(r.time, `${where}: the time runs past the row`).toBeLessThanOrEqual(r.inner + 0.5);
        expect(r.spill, `${where}: the row spills`).toBeLessThanOrEqual(0);
        expect(r.title, `${where}: the title collapsed`).toBeGreaterThanOrEqual(r.staying ? 55.5 : 95.5);
        expect(r.drift, `${where}: the run must stay on one line`).toBeLessThanOrEqual(1);
        expect(r.wordsIn, `${where}: the words leave their column`).toBe(true);
        if (r.staying) expect(r.staying.cut, `${where}: "${r.staying.text}" is cut`).toBe(false);
        if (r.staying?.text === 'Draft') expect(r.title, `${where}: the title gave up more than "Draft" needs`).toBeGreaterThanOrEqual(95.5);
        expect(r.marksTop, where).toBeGreaterThanOrEqual(r.rowTop);
        expect(r.marksBottom, where).toBeLessThanOrEqual(r.rowBottom);
      }
      expect(rows.filter((r) => r.staying).map((r) => r.staying!.text).sort(), `${label} at ${width}`).toEqual(['Answered', 'Draft']);
      const waiting = rows.find((r) => r.id === plain.thread_id)!;
      expect(waiting.pillShown, `${label} at ${width}: the pill at ${waiting.wordsWidth}px`).toBe(waiting.wordsWidth > 72);
      expect(waiting.clock, `${label} at ${width}: the clock`).toBe(true);
      expect(waiting.pillSpoken, `${label} at ${width}: the spoken words`).toMatch(/^Undelivered 1[345] min$/);
    }
  };
  await narrowRows('no pin');
  const health = (await (await fetch(new URL('/api/inbox/health', world.url))).json()) as { serverSession: string };
  const pin = async (pinned: boolean) => {
    const res = await fetch(new URL(`/api/inbox/threads/${solo.thread_id}/pin`, world.url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pinned, serverSession: health.serverSession }) });
    expect(res.ok, `pin ${pinned}: ${res.status}`).toBe(true);
  };
  await pin(true);
  await expect(page.locator('.ib-listcol.ib-pincol')).toHaveCount(1);
  await narrowRows('the pin column');
  await expect(waitPill).toBeHidden();
  await page.locator(`.ib-row[data-thread-id="${plain.thread_id}"] .ib-cw .ib-cwords`).hover({ timeout: 10_000 });
  await expect(page.locator('[data-pn-tooltip]:not([data-closed])')).toContainText(/Undelivered 1[345] min/);
  await page.mouse.move(5, 5);
  for (const [width, sidebarWidth, wide] of [[1000, 448, true], [1000, 520, false], [900, 448, false], [900, 520, false], [768, 520, false]] as const) {
    await page.context().addCookies([{ name: 'plannotator-inbox-sidebar-width', value: String(sidebarWidth), url: world.url }]);
    await page.setViewportSize({ width, height: 900 });
    await page.reload();
    await expect(page.locator('.ib-listcol.ib-noproj')).toHaveCount(1);
    await expect(page.locator(`.ib-lbody ${wide ? '.ib-row' : '.ib-nrow'}`)).toHaveCount(3);
    const where = `window ${width}, sidebar ${sidebarWidth}`;
    const rows = await page.locator('.ib-lbody [data-thread-id]').evaluateAll((els) =>
      els.map((r) => {
        const words = r.querySelector(':is(.ib-cwords .ib-cst, .ib-cwords .ib-draft-l)');
        return {
          words: words?.textContent ?? null,
          cut: words ? words.scrollWidth > words.clientWidth + 0.5 : null,
          blob: [...r.querySelectorAll('[data-undelivered]')].some((p) => getComputedStyle(p).display !== 'none' && p.getBoundingClientRect().width < 60),
          spill: r.scrollWidth - r.clientWidth,
          timeRight: r.querySelector('.ib-t')!.getBoundingClientRect().right,
          right: r.getBoundingClientRect().right,
        };
      }),
    );
    expect(rows.map((r) => r.words).filter(Boolean).sort(), where).toEqual(['Answered', 'Draft']);
    for (const r of rows) {
      expect(r.cut ?? false, `${where}: "${r.words}" is cut`).toBe(false);
      expect(r.blob, `${where}: a pill too small to read`).toBe(false);
      expect(r.spill, `${where}: the row spills`).toBeLessThanOrEqual(0);
      expect(r.timeRight, `${where}: the time runs off the row`).toBeLessThanOrEqual(r.right + 0.5);
    }
  }
  await answerNote();
  await page.locator(`.ib-nrow[data-thread-id="${trio.thread_id}"]`).click({ timeout: 10_000 });
  await expect(page.locator('section.ib-pane')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('section.ib-pane')).toHaveCount(0);
  await expect(page.locator('.ib-lbody .ib-nrow')).toHaveCount(3);
  await expect(page.locator('.ib-lbody .ib-row')).toHaveCount(0);
  await page.context().clearCookies({ name: 'plannotator-inbox-sidebar-width' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();
  await expect(page.locator('.ib-lbody .ib-row')).toHaveCount(3);
  await answerNote();
  await pin(false);
  await expect(page.locator('.ib-listcol.ib-pincol')).toHaveCount(0);
  await page.unroute(listRoute);
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    const row = page.locator(`.ib-row[data-thread-id="${solo.thread_id}"]`);
    await row.locator('.ib-title').hover({ timeout: 10_000 });
    const contrast = () =>
      row.evaluate((r) => {
        const c = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
        const paint = (color: string) => {
          c.fillStyle = color;
          c.fillRect(0, 0, 1, 1);
          const [red, green, blue] = [...c.getImageData(0, 0, 1, 1).data].map((v) => v / 255);
          const linear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
          return 0.2126 * linear(red!) + 0.7152 * linear(green!) + 0.0722 * linear(blue!);
        };
        paint(getComputedStyle(r.closest('.ib-listcol')!).getPropertyValue('--card'));
        const pill = paint(getComputedStyle(r, '::before').backgroundColor);
        const tile = paint(getComputedStyle(r.querySelector('.ib-atile')!).backgroundColor);
        return (Math.max(pill, tile) + 0.05) / (Math.min(pill, tile) + 0.05);
      });
    await expect.poll(contrast, { message: `${colorScheme}: the tile on a hovered row` }).toBeGreaterThanOrEqual(1.15);
  }
  await page.mouse.move(5, 5);
  await page.emulateMedia({ colorScheme: 'light' });
  await shot('1.3-project-filter-agents');
  await side(page).getByRole('button', { name: /^Inbox/ }).click();
  for (const id of [trio.thread_id, plain.thread_id]) {
    const row = page.locator(`.ib-row[data-thread-id="${id}"]`);
    await expect(row.locator('.ib-p')).toHaveText('ops-console');
    const gap = await row.evaluate((r) => r.querySelector('.ib-p')!.getBoundingClientRect().left - r.querySelector('.ib-ags')!.getBoundingClientRect().right);
    expect(Math.abs(gap - 6), `row ${id}: the project 6px after three tiles`).toBeLessThanOrEqual(0.5);
  }
  expectOverlap(await overlaps(trio.thread_id), 'every project, three tiles and "+4"', true);
});

test('no page errors and no CSP refusals along the way', async () => {
  expect(world.errors).toEqual([]);
});

test('the Update button follows health ("ready"), and pressing it brings the new binary up', async () => {
  test.setTimeout(200_000);
  const { page } = world;
  const before = registry();
  const real = `${world.binary}.real`;
  renameSync(world.binary, real);
  writeFileSync(world.binary, '#!/bin/sh\necho "plannotator 9.9.9"\n', { mode: 0o755 });
  const button = page.locator('.ib-upd[data-update-state="ready"]');
  await expect(button).toBeVisible({ timeout: 90_000 });
  await expect(button.getByRole('button', { name: 'Update to 9.9.9', exact: true })).toBeVisible();
  await shot('1.6-restart-to-update');

  renameSync(real, world.binary);
  await button.getByRole('button', { name: 'Update to 9.9.9', exact: true }).click();
  await expect.poll(() => registry().serverSession, { timeout: 60_000 }).not.toBe(before.serverSession);
  const after = registry();
  expect(after.pid).not.toBe(before.pid);
  expect(after.port).toBe(before.port);
  await expect(page.locator(`[data-thread-id="${world.threads.holding}"]`)).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.ib-upd')).toHaveCount(0);
});
