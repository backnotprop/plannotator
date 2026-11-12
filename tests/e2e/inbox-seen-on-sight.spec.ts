import { devices, expect, test, webkit, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'seen-on-sight');

const DWELL_MS = 1000;

const LONG = ['The refund pipeline, step by step.', ...Array.from({ length: 40 }, (_, i) => `Step ${i + 1}: the worker reads the event, checks the idempotency key, and writes the ledger row.`)].join('\n\n');
const QUESTION = [':::question', 'Retry a refund on a Stripe 409?', '', '- [ ] Yes, with the same key', '- [ ] No, dead-letter it', ':::'].join('\n');

type Key = 'end' | 'up' | 'pill' | 'short' | 'unseen' | 'seen' | 'phoneSeen' | 'phoneUnseen' | 'phoneSheet' | 'other';

interface World {
  url: string;
  agent: SimAgent;
  projects: Record<Key, { path: string; id: string; thread: string; root: string }>;
}

let world: World;
let sheetFile = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-seen-on-sight-e2e-');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: join(root, 'data'), PLANNOTATOR_BROWSER: NO_BROWSER };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const projects = {} as World['projects'];
  const bodies: Record<Key, string> = {
    end: 'The refund webhook is wired.',
    up: LONG,
    pill: 'The refund webhook is wired.',
    short: 'The refund webhook is wired.',
    unseen: LONG,
    seen: 'The refund webhook is wired.',
    phoneSeen: 'The refund webhook is wired.',
    phoneUnseen: LONG,
    phoneSheet: `${LONG}\n\n:::question\nShould retries go to the dead-letter queue?\n\n- [ ] Yes\n- [ ] No\n:::`,
    other: 'Unrelated.',
  };
  for (const key of ['end', 'up', 'pill', 'short', 'unseen', 'seen', 'phoneSeen', 'phoneUnseen', 'phoneSheet'] as const) {
    const path = scratchProject(join(root, 'src'), `billing-${key}`);
    if (key === 'phoneSheet') writeFileSync(join(path, 'refund-notes.md'), '# Refund notes\n\nRetries reuse the idempotency key.\n');
    const attachments = key === 'phoneSheet' ? { attachments: ['refund-notes.md'] } : {};
    const sent = await agent.send({ project_path: path, subject: `Refund events (${key})`, body: bodies[key], agent_session: `ses_${key}`, ...attachments } as Parameters<SimAgent['send']>[0]);
    projects[key] = { path, id: '', thread: String(sent.thread_id), root: String(sent.message_id) };
    if (key === 'phoneSheet') sheetFile = String((sent.attachments as { id: string }[])[0]!.id);
  }
  projects.other = { path: scratchProject(join(root, 'src'), 'docs-other'), id: '', thread: '', root: '' };
  const url = started.stdout.trim().replace(/\/$/, '');
  const list = (await (await fetch(`${url}/api/inbox/projects`)).json()) as { projects: { id: string; root: string }[] };
  for (const project of Object.values(projects)) project.id = list.projects.find((p) => p.root === project.path)?.id ?? '';
  for (let i = 1; i <= 12; i++) {
    const saved = await fetch(`${url}/api/inbox/annotations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attachment_id: sheetFile, version: 'current', annotation: { id: `ann-sheet-${i}`, type: 'COMMENT', text: `Note ${i}: name the queue the retries go to.`, originalText: 'Retries reuse the idempotency key.', blockId: 'block-1', startOffset: 0, endOffset: 0, createdA: i } }),
    });
    expect(saved.status).toBe(200);
  }
  world = { url, agent, projects };
});

test.afterAll(async () => {
  try {
    await world?.agent.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

const row = (page: Page, id: string) => page.locator(`.ib-listcol .ib-lbody [data-thread-id="${id}"]`);
const isBold = (page: Page, id: string) => row(page, id).evaluate((r) => r.classList.contains('ib-u'));
const sectionOf = (page: Page, id: string) =>
  row(page, id).evaluateAll((rows) => rows[0]?.closest('[data-section-id]')?.getAttribute('data-section-id') ?? null);
const rowsOf = (page: Page) => page.locator('.ib-listcol .ib-lbody [data-thread-id]').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-thread-id')!));
async function storeRow(threadId: string): Promise<{ section: string; unseen: number; unread: boolean }> {
  const answer = (await (await fetch(`${world.url}/api/inbox/threads/${threadId}`)).json()) as { row: { section: string; unseen: number; unread: boolean } };
  return answer.row;
}
const reply = (key: Key, body: string) => world.agent.send({ project_path: world.projects[key].path, reply_to: world.projects[key].root, body });
const noticeText = (page: Page) => page.locator('[data-inbox-notice]').evaluateAll((n) => n.map((e) => e.textContent ?? '').join(' '));

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(proofDir, `${name}.png`) });
}

async function openRow(page: Page, key: Key, tap = false): Promise<void> {
  const id = world.projects[key].thread;
  if (tap) await row(page, id).tap();
  else await row(page, id).click();
  await expect(page.locator('section.ib-pane')).toBeVisible();
  if (key !== 'phoneSheet') await expect.poll(() => isBold(page, id)).toBe(false);
  await expect.poll(async () => (await storeRow(id)).unseen).toBe(0);
}

async function inFront(page: Page): Promise<void> {
  await page.bringToFront();
  await expect.poll(() => page.evaluate(() => document.visibilityState === 'visible' && document.hasFocus())).toBe(true);
}

test('desktop, at the end of the thread: the arrival scrolls into view, the row bolds in place, and a second later it is seen', async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  try {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${world.url}/`);
    await inFront(page);
    const id = world.projects.end.thread;
    await expect(row(page, id)).toBeVisible();
    await openRow(page, 'end');
    const order = await rowsOf(page);
    const section = await sectionOf(page, id);

    const arrived = await reply('end', 'Retries are on: three attempts, then the dead-letter queue.');
    await world.agent.send({ project_path: world.projects.other.path, subject: 'Docs deploy', body: 'The docs deploy finished.', agent_session: 'ses_other' } as Parameters<SimAgent['send']>[0]);
    const article = page.locator(`[data-message-article="${arrived.message_id}"]`);
    await expect(article).toBeVisible();
    await expect(page.locator('[data-fold-live]')).toHaveText('New message from Claude Code');
    await expect.poll(() => isBold(page, id)).toBe(true);
    expect(await rowsOf(page)).toEqual(order);
    expect(await sectionOf(page, id)).toBe(section);
    expect((await storeRow(id)).unseen).toBe(1);
    await expect(page.locator('[data-inbox-notice]')).toContainText('1 new in docs-other');
    expect(await noticeText(page)).not.toContain('billing-end');
    await shot(page, '01-desktop-arrived-bold');
    const box = await article.evaluate((a) => {
      const body = a.closest('.ib-pbody')!.getBoundingClientRect();
      const r = a.getBoundingClientRect();
      return { top: r.top, viewBottom: body.bottom };
    });
    expect(box.top).toBeLessThan(box.viewBottom - 100);

    const t0 = Date.now();
    await expect.poll(async () => (await storeRow(id)).unseen, { timeout: 5000 }).toBe(0);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(DWELL_MS - 400);
    await expect.poll(() => isBold(page, id)).toBe(false);
    expect(await rowsOf(page)).toEqual(order);
    expect(await sectionOf(page, id)).toBe(section);
    await expect(page.locator('[data-new-pill]')).toHaveAttribute('data-off', '');
    await shot(page, '02-desktop-seen-unbold');
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('desktop, scrolled up: nothing moves, the pill says 1 new, the store keeps it unseen until it is on screen', async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  try {
    const page = await context.newPage();
    await page.goto(`${world.url}/`);
    await inFront(page);
    const id = world.projects.up.thread;
    await openRow(page, 'up');
    const body = page.locator('section.ib-pane .ib-pbody');
    await body.evaluate((b) => (b.scrollTop = 0));
    const arrived = await reply('up', 'One more: the 409 path retries with the same key.');
    await expect.poll(() => isBold(page, id)).toBe(true);
    const pill = page.locator('[data-new-pill]');
    await expect(pill).not.toHaveAttribute('data-off', '');
    await expect(pill).toHaveText('1 new');
    expect(await body.evaluate((b) => b.scrollTop)).toBe(0);
    await page.waitForTimeout(DWELL_MS + 800);
    expect((await storeRow(id)).unseen).toBe(1);
    expect(await isBold(page, id)).toBe(true);
    await shot(page, '03-desktop-scrolled-up-pill');

    await pill.click();
    await expect(page.locator(`[data-message-article="${arrived.message_id}"]`)).toBeInViewport();
    await expect.poll(async () => (await storeRow(id)).unseen, { timeout: 6000 }).toBe(0);
    await expect.poll(() => isBold(page, id)).toBe(false);
    await expect(pill).toHaveAttribute('data-off', '');
    await shot(page, '04-desktop-pill-clicked-seen');
  } finally {
    await context.close();
  }
});

test('desktop, new messages below at the open and an arrival: the pill counts the arrival alone, and one click lands on it', async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  try {
    const id = world.projects.pill.thread;
    const first = await reply('pill', LONG);
    await reply('pill', LONG);
    const page = await context.newPage();
    await page.goto(`${world.url}/`);
    await inFront(page);
    await openRow(page, 'pill');
    await expect(page.locator(`[data-message-article="${first.message_id}"]`)).toBeInViewport();
    const arrived = await reply('pill', 'One more: the 409 path retries with the same key.');
    const pill = page.locator('[data-new-pill]');
    await expect(pill).not.toHaveAttribute('data-off', '');
    await expect(pill).toHaveText('1 new');
    await shot(page, '06a-desktop-pill-arrival-only');
    await pill.click();
    await expect(page.locator(`[data-message-article="${arrived.message_id}"]`)).toBeInViewport();
    await expect.poll(async () => (await storeRow(id)).unseen, { timeout: 6000 }).toBe(0);
    await expect(pill).toHaveAttribute('data-off', '');

    const body = page.locator('section.ib-pane .ib-pbody');
    for (let y = await body.evaluate((b) => b.scrollTop); y > 0; y -= 300) {
      await body.evaluate((b, top) => (b.scrollTop = top), Math.max(0, y - 300));
      await page.waitForTimeout(40);
      await expect(pill).toHaveAttribute('data-off', '');
    }
    expect(await body.evaluate((b) => b.scrollTop)).toBe(0);
    await page.waitForTimeout(300);
    await expect(pill).toHaveAttribute('data-off', '');
    await shot(page, '06b-desktop-pill-stays-off-scrolled-up');
  } finally {
    await context.close();
  }
});

test('desktop, read with another app in front: the reply on screen leaves the pill, and scrolling up never brings it back', async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  try {
    const page = await context.newPage();
    await page.goto(`${world.url}/`);
    await inFront(page);
    const id = world.projects.short.thread;
    const first = await reply('short', LONG);
    await openRow(page, 'short');
    const body = page.locator('section.ib-pane .ib-pbody');
    await body.evaluate((b) => (b.scrollTop = b.scrollHeight));
    await page.evaluate(() => {
      Document.prototype.hasFocus = () => false;
      window.dispatchEvent(new Event('blur'));
    });
    const arrived = await reply('short', 'Ok, merged.');
    const pill = page.locator('[data-new-pill]');
    await expect(page.locator(`[data-message-article="${arrived.message_id}"]`)).toBeInViewport();
    await expect(pill).toHaveAttribute('data-off', '');
    await page.waitForTimeout(DWELL_MS + 500);
    expect((await storeRow(id)).unseen).toBe(1);
    for (let y = await body.evaluate((b) => b.scrollTop); y > 0; y -= 300) {
      await body.evaluate((b, top) => (b.scrollTop = top), Math.max(0, y - 300));
      await page.waitForTimeout(40);
      await expect(pill).toHaveAttribute('data-off', '');
    }
    await expect(page.locator(`[data-message-article="${first.message_id}"]`)).toBeVisible();
    await shot(page, '06c-desktop-read-in-background-scrolled-up');
  } finally {
    await context.close();
  }
});

test('desktop, closed before seeing it: the row settles unread in Waiting; closed after seeing it: Quiet', async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  try {
    const page = await context.newPage();
    await page.goto(`${world.url}/`);
    await inFront(page);

    const unseen = world.projects.unseen.thread;
    await openRow(page, 'unseen');
    await page.locator('section.ib-pane .ib-pbody').evaluate((b) => (b.scrollTop = 0));
    await reply('unseen', QUESTION);
    await expect.poll(() => isBold(page, unseen)).toBe(true);
    expect(await noticeText(page)).not.toContain('billing-unseen');
    await page.keyboard.press('Escape');
    await expect(page.locator('section.ib-pane')).toHaveCount(0);
    await expect.poll(() => sectionOf(page, unseen)).toBe('waiting');
    expect(await isBold(page, unseen)).toBe(true);
    expect((await storeRow(unseen)).unseen).toBe(1);
    expect(await noticeText(page)).not.toContain('billing-unseen');
    await shot(page, '05-desktop-closed-unseen-waiting');

    const seen = world.projects.seen.thread;
    await openRow(page, 'seen');
    await reply('seen', 'Retries are on.');
    await expect.poll(() => isBold(page, seen)).toBe(true);
    await expect.poll(() => isBold(page, seen), { timeout: 5000 }).toBe(false);
    await page.keyboard.press('Escape');
    await expect(page.locator('section.ib-pane')).toHaveCount(0);
    await expect.poll(() => sectionOf(page, seen)).toBeNull();
    expect((await storeRow(seen)).section).toBe('quiet');
    await shot(page, '06-desktop-closed-seen-quiet');
  } finally {
    await context.close();
  }
});

test('phone (WebKit, iPhone 15): seen on sight with the same rule; Back shows it unbolded in place, or unread in Waiting', async () => {
  let own: Browser | null = null;
  let context: BrowserContext | null = null;
  try {
    own = await webkit.launch({ args: [] });
    context = await own.newContext({ ...devices['iPhone 15'], colorScheme: 'dark' });
    const page = await context.newPage();
    await page.goto(`${world.url}/`);
    await inFront(page);

    const seen = world.projects.phoneSeen.thread;
    await expect(row(page, seen)).toBeVisible();
    await openRow(page, 'phoneSeen', true);
    const section = await sectionOf(page, seen);
    const arrived = await reply('phoneSeen', 'Retries are on: three attempts.');
    await expect(page.locator(`[data-message-article="${arrived.message_id}"]`)).toBeVisible();
    await shot(page, '07-phone-arrived');
    await expect.poll(async () => (await storeRow(seen)).unseen, { timeout: 5000 }).toBe(0);
    await page.locator('section.ib-pane [data-phone-back]').click();
    await expect(page.locator('section.ib-pane')).toHaveCount(0);
    expect(await sectionOf(page, seen)).toBe(section);
    expect(await isBold(page, seen)).toBe(false);
    await shot(page, '08-phone-back-seen');

    const unseen = world.projects.phoneUnseen.thread;
    await openRow(page, 'phoneUnseen', true);
    await page.locator('section.ib-pane .ib-pbody').evaluate((b) => (b.scrollTop = 0));
    await reply('phoneUnseen', QUESTION);
    await expect(page.locator('[data-new-pill]')).toHaveText('1 new');
    await page.locator('section.ib-pane [data-phone-back]').click();
    await expect(page.locator('section.ib-pane')).toHaveCount(0);
    await expect.poll(() => sectionOf(page, unseen)).toBe('waiting');
    expect(await isBold(page, unseen)).toBe(true);
    await shot(page, '09-phone-back-unseen-waiting');
  } finally {
    await context?.close();
    await own?.close();
  }
});

test('phone (WebKit, iPhone 15): an arrival under the annotations sheet is not seen until the sheet closes', async () => {
  let own: Browser | null = null;
  let context: BrowserContext | null = null;
  try {
    own = await webkit.launch({ args: [] });
    context = await own.newContext({ ...devices['iPhone 15'], colorScheme: 'dark' });
    const page = await context.newPage();
    await page.goto(`${world.url}/`);
    await inFront(page);

    const id = world.projects.phoneSheet.thread;
    await expect(row(page, id)).toBeVisible();
    await openRow(page, 'phoneSheet', true);
    const body = page.locator('section.ib-pane .ib-pbody');
    await body.evaluate((b) => (b.scrollTop = b.scrollHeight));
    await page.locator('section.ib-pane .ib-pfoot').getByRole('button', { name: /^Reply$|Edit draft$/ }).tap();
    await page.locator('section.ib-pane [data-foot-summary]').tap();
    await page.getByRole('dialog', { name: 'Goes with this reply' }).getByRole('button', { name: 'Review comments' }).tap();
    const sheet = page.locator('.ib-annpop');
    await expect(sheet).toBeVisible();
    await body.evaluate((b) => (b.scrollTop = b.scrollHeight));
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

    const arrived = await reply('phoneSheet', 'Retries are on: three attempts, then the dead-letter queue.');
    const article = page.locator(`[data-message-article="${arrived.message_id}"]`);
    await expect(article).toHaveCount(1);
    await expect.poll(async () => (await storeRow(id)).unseen).toBe(1);
    const scrollTop = () => body.evaluate((b) => b.scrollTop);
    await expect
      .poll(async () => {
        const before = await scrollTop();
        await page.waitForTimeout(200);
        return before === (await scrollTop());
      })
      .toBe(true);
    await page.waitForTimeout(DWELL_MS + 1200);
    expect((await storeRow(id)).unseen).toBe(1);
    await article.evaluate((a) => {
      const body = a.closest('.ib-pbody') as HTMLElement;
      const sheetTop = document.querySelector('.ib-annpop')!.getBoundingClientRect().top;
      const headTop = (a.querySelector('.ib-fline') ?? a).getBoundingClientRect().top;
      if (headTop < sheetTop + 16) body.scrollTop -= sheetTop + 16 - headTop;
    });
    const under = await article.evaluate((a) => {
      const view = a.closest('.ib-pbody')!.getBoundingClientRect();
      const r = (a.querySelector('.ib-fline') ?? a).getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + 8);
      return { inView: r.top >= view.top && r.bottom <= view.bottom, covered: hit !== null && hit.closest('.ib-annpop') !== null };
    });
    expect(under).toEqual({ inView: true, covered: true });
    await shot(page, '10-phone-arrival-under-sheet');
    await page.waitForTimeout(DWELL_MS + 1200);
    expect((await storeRow(id)).unseen).toBe(1);

    await body.dispatchEvent('mousedown');
    await expect(sheet).toHaveCount(0);
    await body.evaluate((b) => (b.scrollTop = b.scrollHeight));
    await expect.poll(async () => (await storeRow(id)).unseen, { timeout: 6000 }).toBe(0);
    await shot(page, '11-phone-sheet-closed-seen');
  } finally {
    await context?.close();
    await own?.close();
  }
});
