import { chromium, devices, expect, test, webkit, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';
import { agentCliCalls, writeAgentCliStubs } from './agent-cli-stubs';
import { finger } from './phone-touch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const OPS_SHOTS = '/Users/ramos/plannotator/.ops/shots/decision-mode-build';
const proofDir = resolve(
  process.env.PLANNOTATOR_DECISION_SHOTS ?? (existsSync(dirname(dirname(OPS_SHOTS))) ? OPS_SHOTS : join(repo, '.local/proof/decision-mode')),
);

const q = (prompt: string, choices: string[], extra: string[] = [], kind = 'question') =>
  [`:::${kind}`, prompt, '', ...extra, ...(extra.length ? [''] : []), ...choices.map((c) => `- [ ] ${c}`), ':::'].join('\n');

function mockPng(width = 240, height = 360, accent: [number, number, number] = [91, 63, 230]): Buffer {
  const table = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = table[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const edge = x < 12 || x >= width - 12 || y < 12 || y >= height - 12;
      const header = y >= 24 && y < 44 && x >= 28 && x < 150;
      const row = (y - 64) % 46 < 30 && y >= 64 && y < 250 && x >= 28 && x < width - 28;
      const pay = y >= height - 70 && y < height - 34 && x >= 28 && x < width - 28;
      const rgb = edge ? [200, 204, 214] : pay ? accent : header ? [24, 24, 30] : row ? [236, 238, 244] : [255, 255, 255];
      raw.set(rgb, y * (width * 3 + 1) + 1 + x * 3);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

interface World {
  root: string;
  dataDir: string;
  stubs: string;
  env: Record<string, string>;
  url: string;
  claude: SimAgent;
  codex: SimAgent;
  pi: SimAgent;
  billing: string;
  web: string;
  context: BrowserContext;
  page: Page;
  errors: string[];
}
let world: World;
let stripeThread = '';

function port(): number {
  return (JSON.parse(readFileSync(join(world.dataDir, 'inbox', 'inbox.json'), 'utf8')) as { port: number }).port;
}

async function shot(page: Page, name: string): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(proofDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

const card = (page: Page) => page.locator('[data-decision-mode] [data-decision-card]');
const promptOf = (page: Page) => page.locator('[data-decision-mode] [data-decision-prompt]');

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-decide-e2e-');
  const dataDir = join(root, 'data');
  const stubs = writeAgentCliStubs(join(root, 'agent-clis'));
  const env = { PATH: `${stubs}:${process.env.PATH ?? ''}`, HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_TEST_SANDBOX: root };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const billing = scratchProject(join(root, 'src'), 'billing-svc');
  const web = scratchProject(join(root, 'src'), 'web');
  mkdirSync(join(web, 'design'), { recursive: true });
  writeFileSync(join(web, 'design', 'drawer-b.png'), mockPng());
  mkdirSync(join(billing, 'design'), { recursive: true });
  writeFileSync(join(billing, 'design', 'drawer-b.png'), mockPng());
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const codex = await SimAgent.connect({ binary, env, name: 'Codex', host: 'codex' });
  const pi = await SimAgent.connect({ binary, env, name: 'Pi', host: 'pi' });
  world = { root, dataDir, stubs, env, url, claude, codex, pi, billing, web, context, page, errors };
  await fetch(`http://127.0.0.1:${port()}/api/inbox/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notifications: { dismissed: true } }) });
});

test.afterAll(async () => {
  try {
    if (!world) return;
    for (const agent of [world.claude, world.codex, world.pi]) await agent.close().catch(() => {});
    await world.context.close();
  } finally {
    await removeInboxScratch();
  }
});

test('off by default: nothing of decision mode until Settings → Capabilities → Experimental turns it on', async () => {
  const { page, url, claude, codex, pi } = world;
  const asked = await claude.send(
    {
      project_path: world.billing,
      subject: 'Stripe 409 retries',
      body: `Two calls before the refund worker ships.\n\n${q('Which way should the worker go on a Stripe 409?', ['Retry with the same key — Stripe charges once per key', "Fail to the dead-letter queue — today's behavior", 'Retry with a new key — fastest, can refund twice'], ['Stopped: the refund worker cannot ship without this.', '', 'Recommended: Retry with the same key'])}\n\n${q('Page on-call after 5 tries?', ['Yes, page on-call — about 2 pages a week', 'No, a daily digest — seen next morning'])}`,
    },
    { wakes: true },
  );
  await codex.send({ project_path: world.billing, reply_to: asked.message_id, body: `B tested best on small phones.\n\n${q('Ship drawer B to all of checkout?', ['Yes, ship B — the total stays next to Pay', 'No, keep A'], ['![Drawer B](design/drawer-b.png)', '', 'Holds up: the 4.2 release'])}` }, { wakes: true });
  stripeThread = asked.thread_id;
  await pi.send({ project_path: world.billing, reply_to: asked.message_id, body: q('Which exports should the ledger keep?', ['CSV', 'Parquet', 'JSON lines'], ['Recommended: CSV, Parquet'], 'question-multi') }, { wakes: true });

  await page.goto(url);
  await expect(page.locator('[data-inbox-nav]')).toBeVisible();
  await expect(page.locator('[data-decide-nav]')).toHaveCount(0);
  await expect(page.locator('[data-decide-head]')).toHaveCount(0);
  expect((await fetch(`http://127.0.0.1:${port()}/api/inbox/decisions`)).status).toBe(404);

  await page.goto(`${url}#settings/capabilities`);
  const group = page.locator('[data-settings-experimental]');
  await expect(group).toBeVisible();
  await expect(group).toContainText('Decision mode');
  const sw = group.getByRole('switch', { name: 'Decision mode' });
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  await group.scrollIntoViewIfNeeded();
  await shot(page, 'settings-experimental');
  await sw.click();
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  await expect
    .poll(() => {
      try {
        return JSON.parse(readFileSync(join(world.dataDir, 'config.json'), 'utf8')).experimental;
      } catch {
        return undefined;
      }
    })
    .toEqual({ decisionMode: true });

  await page.goto(url);
  await expect(page.locator('[data-thread-id]', { hasText: 'Stripe 409 retries' }).first()).toBeVisible();
  await expect(page.locator('[data-decide-nav]')).toHaveCount(0);
  await expect(page.locator('[data-decide-head]')).toHaveCount(0);
  await page.locator('[data-thread-id]', { hasText: 'Stripe 409 retries' }).first().click();
  await page.locator('section.ib-pane [data-open-questions]').click();
  await expect(page.locator('[data-thread-decide]')).toHaveText('Decide these 4');
  await shot(page, 'entry-points');
});

async function decideIn(page: Page, threadId: string): Promise<void> {
  await page.goto(`${world.url}#thread=${threadId}`);
  await expect(page.locator('section.ib-pane [data-open-questions]')).toBeVisible();
  if (!(await page.locator('[data-open-questions-list]').isVisible())) await page.locator('section.ib-pane [data-open-questions]').click();
  await page.locator('[data-thread-decide]').click();
  await expect(page.locator('[data-decision-mode]')).toBeVisible();
}

test('the queue: Stopped first, a pick saves at once, the session replies once after its Hold, a replaced question swaps in, the end', async () => {
  const { page, claude, codex } = world;
  await decideIn(page, stripeThread);
  const dialog = page.locator('[data-decision-mode]');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Decide', exact: true })).toBeVisible();
  await expect(promptOf(page)).toHaveText('Which way should the worker go on a Stripe 409?');
  await expect(dialog.locator('[data-decision-stopped]')).toContainText('the refund worker cannot ship without this.');
  await expect(dialog.locator('[data-decision-head]')).toContainText('1 of 4 · 3 agents waiting');
  expect(await dialog.locator('[title]').count()).toBe(0);
  await shot(page, 'queue-stopped');

  await card(page).locator('.ib-dm-choice', { hasText: 'Retry with the same key' }).click();
  await expect(promptOf(page)).toHaveText('Page on-call after 5 tries?');
  await shot(page, 'queue-two-way');
  await card(page).locator('.ib-dm-choice', { hasText: 'Yes, page on-call' }).click();
  const hold = dialog.locator('[data-decision-hold]');
  await expect(hold).toContainText(/Sending in \d s · Hold/);
  await shot(page, 'queue-hold');
  await expect(dialog.locator('[data-decision-chip-state]').first()).toHaveText(/Sending|Queued|Saved|Delivered|Working|Replied/, { timeout: 15_000 });

  await expect(promptOf(page)).toHaveText('Ship drawer B to all of checkout?');
  await expect(card(page).locator('[data-decision-pictures] img')).toBeVisible();
  await shot(page, 'queue-picture');
  const list = (await (await fetch(`http://127.0.0.1:${port()}/api/inbox/decisions`)).json()) as { decisions: { id: string; message: { id: string }; thread: { id: string }; question: { prompt: string } }[] };
  const codexDecision = list.decisions.find((d) => d.question.prompt === 'Ship drawer B to all of checkout?')!;
  await codex.send({ project_path: world.billing, reply_to: codexDecision.message.id, supersedes: [codexDecision.id], body: q('Ship drawer B to checkout on Thursday, behind the 4.2 flag?', ['Yes, Thursday', 'No, wait for QA']) }, { wakes: true });
  await expect(dialog.locator('[data-decision-replaced]')).toContainText('Codex replaced this question just now.');
  await expect(promptOf(page)).toHaveText('Ship drawer B to checkout on Thursday, behind the 4.2 flag?');
  await shot(page, 'queue-replaced');
  await card(page).locator('.ib-dm-choice', { hasText: 'Yes, Thursday' }).click();

  await expect(promptOf(page)).toHaveText('Which exports should the ledger keep?');
  await expect(card(page).locator('[data-decision-answer]')).toHaveText('Answer with 2');
  await shot(page, 'queue-multi');
  await card(page).locator('[data-decision-answer]').click();
  await expect(dialog.locator('[data-decision-end]')).toBeVisible();
  await expect(dialog.locator('[data-decision-end]')).toContainText('Nothing waits on you');
  await expect.poll(async () => ((await (await fetch(`http://127.0.0.1:${port()}/api/inbox/decisions`)).json()) as { decisions: unknown[] }).decisions.length, { timeout: 20_000 }).toBe(0);
  await expect(dialog.locator('[data-decision-end-row] .ib-dm-endstate').first()).toHaveText(/Delivered|Sending|Queued|Saved|Working|Replied|Nothing to send/);

  const threads = (await (await fetch(`http://127.0.0.1:${port()}/api/inbox/threads`)).json()) as { sections: { threads: { thread_id: string; subject: string | null }[] }[] };
  const claudeThread = threads.sections.flatMap((s) => s.threads).find((t) => t.subject === 'Stripe 409 retries')!;
  const thread = (await (await fetch(`http://127.0.0.1:${port()}/api/inbox/threads/${claudeThread.thread_id}`)).json()) as { thread: { messages: { author: { kind: string }; body: string }[] } };
  const replies = thread.thread.messages.filter((m) => m.author.kind === 'person');
  expect(replies).toHaveLength(3);
  const claudes = replies.filter((m) => m.body.includes('Retry with the same key'));
  expect(claudes).toHaveLength(1);
  expect(claudes[0]!.body).toContain('Yes, page on-call');
  expect(JSON.stringify(await claude.readThread(claudeThread.thread_id))).toContain('Yes, page on-call');
  await claude.send({ project_path: world.billing, reply_to: claudeThread.thread_id, body: 'Retrying 409s with the same key now; paging on-call after 5 tries.' }, { wakes: true });
  await expect(dialog.locator('[data-decision-end-row] .ib-dm-endstate').first()).toHaveText('Replied');
  await shot(page, 'end');
  await dialog.locator('[data-decision-back]').click();
  await expect(dialog).toBeHidden();
  expect(world.errors).toEqual([]);
});

const REFUNDS_SUBJECT = 'Refund emails for partial refunds, the JPY rounding rule and the finance export before 4.2 ships';

test('a phone (WebKit, iPhone 15): the card is a full-screen column with 44 px targets', async () => {
  const { claude, pi } = world;
  const refunds = await claude.send({ project_path: world.billing, thread: 'refund-emails', subject: REFUNDS_SUBJECT, body: q('Send the partial-refund email?', ['Yes, send it', 'No, not yet'], ['Stopped: the email job waits on this.']) }, { wakes: true });
  await pi.send({ project_path: world.billing, reply_to: refunds.message_id, body: q('Round half-even or half-up for JPY refunds?', ['Half-even — matches Stripe', 'Half-up — what finance does today']) }, { wakes: true });
  expect(refunds.thread_id).not.toBe(stripeThread);
  const own = await webkit.launch({ args: [] });
  try {
    for (const scheme of ['dark', 'light'] as const) {
      const context = await own.newContext({ ...devices['iPhone 15'], colorScheme: scheme, reducedMotion: 'reduce' });
      const page = await context.newPage();
      await page.goto(world.url);
      await decideIn(page, refunds.thread_id);
      const dialog = page.locator('[data-decision-mode]');
      await expect(promptOf(page)).toHaveText('Send the partial-refund email?');
      const box = await dialog.boundingBox();
      const viewport = page.viewportSize()!;
      expect(Math.round(box!.width)).toBe(viewport.width);
      for (const target of await card(page).locator('.ib-dm-choice, .ib-dm-lnk, .ib-dm-open').all()) {
        const b = await target.boundingBox();
        if (b) expect(b.height).toBeGreaterThanOrEqual(44);
      }
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(proofDir, `phone-card-${scheme}.png`) });
      if (scheme === 'dark') {
        await card(page).locator('[data-decision-open-thread]').tap();
        const pill = page.locator('[data-decision-pill]');
        await expect(pill).toBeVisible();
        const foot = page.locator('section.ib-pane .ib-pfoot');
        await expect(foot).toBeVisible();
        await expect
          .poll(async () => {
            const [p, f] = [await pill.boundingBox(), await foot.boundingBox()];
            return p && f ? Math.round(p.y + p.height) <= Math.round(f.y) : false;
          })
          .toBe(true);
        await page.screenshot({ path: join(proofDir, `phone-pill-${scheme}.png`) });
        await page.evaluate((id) => {
          location.hash = `thread=${id}`;
        }, stripeThread);
        const named = pill.locator('[data-decision-pill-thread]');
        await expect(named).toBeVisible();
        const viewport2 = page.viewportSize()!;
        const p = (await pill.boundingBox())!;
        expect(p.x).toBeGreaterThanOrEqual(8);
        expect(p.x + p.width).toBeLessThanOrEqual(viewport2.width - 8);
        expect(await named.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
        await expect(pill).toContainText('left');
        const resume = (await pill.locator('[data-decision-resume]').boundingBox())!;
        expect(resume.x + resume.width).toBeLessThanOrEqual(p.x + p.width);
        await page.screenshot({ path: join(proofDir, `phone-pill-named-${scheme}.png`) });
        await page.locator('[data-decision-resume]').tap();
        await expect(dialog).toBeVisible();
      }
      if (scheme === 'light') {
        await card(page).locator('.ib-dm-choice', { hasText: 'Yes, send it' }).tap();
        await expect(promptOf(page)).toHaveText('Round half-even or half-up for JPY refunds?');
        await page.screenshot({ path: join(proofDir, `phone-next-${scheme}.png`) });
        await dialog.locator('[data-decision-close]').tap();
        await expect(dialog.locator('[data-decision-confirm]')).toBeVisible();
        await page.screenshot({ path: join(proofDir, `phone-close-${scheme}.png`) });
        await dialog.locator('[data-decision-keep-draft]').tap();
        await expect(dialog).toBeHidden();
      }
      await context.close();
    }
  } finally {
    await own.close();
  }
});

async function goToCard(page: Page, prompt: string): Promise<void> {
  const dialog = page.locator('[data-decision-mode]');
  await dialog.locator('[data-decision-overview]').click();
  await dialog.locator('.ib-dm-allrow', { hasText: prompt }).click();
  await expect(promptOf(page)).toHaveText(prompt);
}

async function stateOf(prompt: string): Promise<{ state: string; selected: string[] } | null> {
  const threads = (await (await fetch(`http://127.0.0.1:${port()}/api/inbox/threads`)).json()) as { sections: { threads: { thread_id: string }[] }[] };
  for (const row of threads.sections.flatMap((s) => s.threads)) {
    const model = (await (await fetch(`http://127.0.0.1:${port()}/api/inbox/threads/${row.thread_id}`)).json()) as { thread: { messages: { questions?: { prompt: string; state: string; answer: { selected: string[] } | null }[] }[] } };
    const found = model.thread.messages.flatMap((m) => m.questions ?? []).find((q) => q.prompt === prompt);
    if (found) return { state: found.state, selected: found.answer?.selected ?? [] };
  }
  return null;
}

test('the contract lines: picture tiles (the picture answers, its zoom never does), Stakes and Why, and a one-way pick that asks once more', async () => {
  const { page, claude, codex } = world;
  const DRAWERS = 'Which checkout drawer should ship?';
  const INVOICES = 'Delete the 3 duplicate invoices in the legacy billing system now?';
  const accents: Record<string, [number, number, number]> = { a: [224, 112, 56], b: [91, 63, 230], c: [36, 150, 104] };
  for (const [name, accent] of Object.entries(accents)) writeFileSync(join(world.web, 'design', `drawer-${name}.png`), mockPng(240, 360, accent));
  const drawers = await claude.send(
    {
      project_path: world.web,
      subject: 'Checkout drawer for 4.2',
      body: [
        'Three drawer options for 4.2. All pass the accessibility checks.',
        '',
        ':::question',
        DRAWERS,
        'Stakes: ships to all of checkout on Thursday; changing it later costs a week of QA.',
        'Holds up: the 4.2 release',
        '',
        '- [ ] A · Total on top — ![Drawer A](design/drawer-a.png) closest to today',
        '- [ ] B · Total pinned with Pay — ![Drawer B](design/drawer-b.png) the total never scrolls away',
        '- [ ] C · Three steps — ![Drawer C](design/drawer-c.png) most room, one more tap',
        '',
        'Recommended: B · Total pinned with Pay',
        '',
        'Why: on a 320 px screen only B keeps the total next to the button.',
        ':::',
      ].join('\n'),
    },
    { wakes: true },
  );
  await codex.send(
    {
      project_path: world.web,
      reply_to: drawers.message_id,
      body: [
        ':::question',
        INVOICES,
        'Stakes: they inflate this month’s revenue report by €1,840 until they’re gone.',
        'Reversible: no — deleted invoices cannot be restored.',
        '',
        'The duplicates are in `invoices/legacy` and match their originals line for line.',
        '',
        '- [ ] Delete now — the report is right today',
        '- [ ] Wait for month-end close — finance deletes them with the close',
        '',
        'Recommended: Wait for month-end close',
        ':::',
      ].join('\n'),
    },
    { wakes: true },
  );

  const own = await webkit.launch({ args: [] });
  try {
    for (const scheme of ['light', 'dark'] as const) {
      const context = await own.newContext({ ...devices['iPhone 15'], colorScheme: scheme, reducedMotion: 'reduce' });
      const phone = await context.newPage();
      await phone.goto(world.url);
      await decideIn(phone, drawers.thread_id);
      await goToCard(phone, DRAWERS);
      const tiles = card(phone).locator('[data-decision-tiles] [data-question-tile]');
      await expect(tiles).toHaveCount(3);
      const [first, second] = [await tiles.nth(0).boundingBox(), await tiles.nth(1).boundingBox()];
      expect(Math.round(first!.y)).toBe(Math.round(second!.y));
      await tiles.nth(0).scrollIntoViewIfNeeded();
      await phone.waitForTimeout(300);
      await phone.screenshot({ path: join(proofDir, `contract-phone-tiles-${scheme}.png`) });
      await goToCard(phone, INVOICES);
      const del = card(phone).locator('.ib-dm-choice', { hasText: 'Delete now' });
      const [a, b] = [await del.boundingBox(), await card(phone).locator('.ib-dm-choice', { hasText: 'Wait for month-end close' }).boundingBox()];
      const words = await del.locator('.ib-dm-chd').boundingBox();
      expect(words!.y + words!.height).toBeLessThanOrEqual(a!.y + a!.height);
      expect(a!.y + a!.height).toBeLessThanOrEqual(b!.y);
      await del.tap();
      const step = card(phone).locator('[data-decision-confirm-pick]');
      await expect(step).toBeInViewport();
      for (const button of await step.locator('.ib-btn').all()) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await phone.waitForTimeout(300);
      await phone.screenshot({ path: join(proofDir, `contract-phone-confirm-${scheme}.png`) });
      await card(phone).locator('[data-decision-confirm-cancel]').tap();
      await expect(step).toHaveCount(0);
      await context.close();
    }
  } finally {
    await own.close();
  }
  expect((await stateOf(INVOICES))?.state).toBe('open');

  const real = await chromium.launch();
  try {
    const { defaultBrowserType: _ignored, ...pixel } = devices['Pixel 7'];
    const context = await real.newContext({ ...pixel, colorScheme: 'light' });
    const phone = await context.newPage();
    await phone.goto(world.url);
    await decideIn(phone, drawers.thread_id);
    await goToCard(phone, DRAWERS);
    await card(phone).locator('[data-decision-tiles] [data-question-tile]').nth(0).locator('[data-question-zoom]').tap();
    const viewer = phone.locator('[data-image-lightbox]');
    await expect(viewer.locator('[data-lightbox-count]')).toHaveText('1 of 3');
    await expect(viewer).toHaveAttribute('aria-label', 'A · Total on top, image 1 of 3');
    const swipeArea = viewer.locator('[data-lightbox-swipe]');
    const box = (await swipeArea.boundingBox())!;
    const at = { x: box.x + box.width * 0.75, y: box.y + box.height * 0.45 };
    const touch = await finger(phone, 'chromium');
    const header = viewer.locator('[data-lightbox-count]');
    const headerBefore = await header.boundingBox();
    await touch.down(at.x, at.y, -box.width * 0.15, 0);
    expect(await viewer.locator('[data-lightbox-track]').evaluate((el) => (el as HTMLElement).style.transform)).toMatch(/^translateX\(-\d/);
    expect(await swipeArea.evaluate((el) => (el as HTMLElement).style.transform)).toBe('');
    expect(await header.boundingBox()).toEqual(headerBefore);
    await touch.up();
    await phone.waitForTimeout(400);
    await expect(viewer.locator('[data-lightbox-count]')).toHaveText('1 of 3');
    await touch.down(at.x, at.y, -box.width * 0.3, 0, 3);
    await touch.up();
    await touch.down(at.x, at.y, -box.width * 0.3, 0, 3);
    await touch.up();
    await expect(viewer.locator('[data-lightbox-count]')).toHaveText('3 of 3');
    await expect(viewer).toHaveAttribute('aria-label', 'C · Three steps, image 3 of 3');
    await phone.waitForTimeout(400);
    await touch.down(box.x + box.width / 2, box.y + box.height * 0.3, 0, box.height * 0.4);
    await touch.up();
    await expect(viewer).toHaveCount(0);
    await expect(phone.locator('[data-decision-mode]')).toBeVisible();
    await context.close();
  } finally {
    await real.close();
  }
  expect((await stateOf(DRAWERS))?.state).toBe('open');

  await page.goto(world.url);
  await decideIn(page, drawers.thread_id);
  const dialog = page.locator('[data-decision-mode]');
  await goToCard(page, DRAWERS);
  await expect(card(page).locator('[data-decision-stakes]')).toHaveText('Ships to all of checkout on Thursday; changing it later costs a week of QA.');
  await expect(card(page).locator('[data-decision-why]')).toHaveText('Why Claude Code recommends it: On a 320 px screen only B keeps the total next to the button.');
  const tiles = card(page).locator('[data-decision-tiles] [data-question-tile]');
  await expect(tiles).toHaveCount(3);
  for (let i = 0; i < 3; i++) await expect.poll(() => tiles.nth(i).locator('[data-question-picture]').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  await expect(card(page).locator('[data-decision-pictures]')).toHaveCount(0);
  expect(await dialog.locator('[title]').count()).toBe(0);
  await shot(page, 'contract-tiles');

  await tiles.nth(2).locator('[data-question-zoom]').click();
  await expect(page.locator('[data-image-lightbox]')).toBeVisible();
  await shot(page, 'contract-zoom');
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-image-lightbox]')).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(promptOf(page)).toHaveText(DRAWERS);
  expect((await stateOf(DRAWERS))?.state).toBe('open');

  await tiles.nth(1).locator('[data-question-picture]').click();
  await expect(page.locator('[data-image-lightbox]')).toHaveCount(0);
  await expect.poll(async () => (await stateOf(DRAWERS))?.selected).toEqual(['B · Total pinned with Pay']);

  await goToCard(page, INVOICES);
  await expect(card(page).locator('[data-decision-one-way]')).toContainText('One-way');
  await expect(card(page).locator('[data-decision-irreversible]')).toHaveCount(0);
  await expect(card(page).locator('[data-decision-stakes]')).toContainText('€1,840');
  await shot(page, 'contract-one-way');
  await card(page).locator('.ib-dm-choice', { hasText: 'Delete now' }).click();
  const confirm = card(page).locator('[data-decision-confirm-pick]');
  await expect(confirm).toContainText("Delete now? Can't be undone: deleted invoices cannot be restored.");
  await expect(card(page).locator('[data-decision-confirm-cancel]')).toBeFocused();
  await shot(page, 'contract-confirm');
  await card(page).locator('[data-decision-confirm-cancel]').click();
  await expect(confirm).toHaveCount(0);
  expect((await stateOf(INVOICES))?.state).toBe('open');
  await card(page).locator('.ib-dm-choice', { hasText: 'Wait for month-end close' }).click();
  await expect(confirm).toContainText('Wait for month-end close?');
  await card(page).locator('[data-decision-confirm-cancel]').click();
  expect((await stateOf(INVOICES))?.state).toBe('open');
  await card(page).locator('.ib-dm-choice', { hasText: 'Delete now' }).click();
  await card(page).locator('[data-decision-confirm-yes]').click();
  await expect.poll(async () => (await stateOf(INVOICES))?.selected).toEqual(['Delete now']);

  await dialog.locator('[data-decision-close]').click();
  const keep = dialog.locator('[data-decision-keep-draft]');
  if (await keep.isVisible().catch(() => false)) await keep.click();
  await expect(dialog).toBeHidden();
  expect(world.errors).toEqual([]);
});

test('the Codex session it answered is never woken through a codex CLI: none is looked up or run', async () => {
  const thread = (await (await fetch(`http://127.0.0.1:${port()}/api/inbox/threads/${stripeThread}`)).json()) as { thread?: { messages: { author: { kind: string }; body: string }[] } };
  const answered = thread.thread?.messages.some((m) => m.author.kind === 'person' && m.body.includes('Yes, Thursday')) ?? false;
  expect(answered, "Codex's question was answered (run this with the queue test)").toBe(true);
  expect(agentCliCalls(world.stubs)).toEqual([]);
});
