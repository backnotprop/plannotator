/**
 * Tag agents in a reply or a comment (approval "inbox-tag-agents", Lines
 * variant), proved in a real browser against the compiled binary.
 *
 * Nothing is mocked: the binary runs `plannotator inbox --background` under a
 * temp PLANNOTATOR_DATA_DIR and HOME; the mock's sample threads are written
 * through the Inbox's own /mcp, and live agent connections poll the bridge's
 * real doors as the Claude Code mod, Pi and OpenCode do, with the tags
 * capability (tests/helpers/inbox-tag-world.ts): Claude Code in billing-api
 * owns the threads, another Claude Code session works there too, one in
 * plannotator, Pi in infra (and a Pi on an older Plannotator, without the
 * capability), OpenCode in plannotator, and Codex reads the Inbox through MCP
 * only. The person's tags are typed in the window's own reply box and file
 * comment. The mod's, Pi's and OpenCode's own code doing the delivery is
 * apps/hook/hooks/mod/inbox.test.ts and packages/server/inbox-tags.test.ts.
 *
 * PNGs (desktop and phone, light and dark) land in .local/proof/tag-agents/,
 * or in PLANNOTATOR_TAG_SHOTS when it names a folder.
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { INBOX_TAGGED_INSTRUCTION, inboxAlsoTaggedLine, inboxWakeText } from '../../packages/shared/inbox/connection';
import { seedTagWorld, TAG_SESSIONS, type TagWorld } from '../helpers/inbox-tag-world';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = resolve(process.env.PLANNOTATOR_TAG_SHOTS ?? join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'tag-agents'));
const S = TAG_SESSIONS;

interface World {
  url: string;
  tags: TagWorld;
  context: BrowserContext;
  page: Page;
  errors: string[];
}
let world: World;

// Reduced motion: the thread slides over the list on a phone; a measurement mid-slide is not the layout.
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, reducedMotion: 'reduce' as const };

async function shot(page: Page, name: string, options: { clip?: { selector: string; pad?: number } } = {}): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(250);
    if (options.clip) {
      const box = (await page.locator(options.clip.selector).first().boundingBox())!;
      const pad = options.clip.pad ?? 16;
      const size = page.viewportSize()!;
      const x = Math.max(0, box.x - pad);
      const y = Math.max(0, box.y - pad);
      await page.screenshot({ path: join(proofDir, `${name}-${scheme}.png`), clip: { x, y, width: Math.min(size.width - x, box.width + pad * 2), height: Math.min(size.height - y, box.height + pad * 2) } });
    } else {
      await page.screenshot({ path: join(proofDir, `${name}-${scheme}.png`) });
    }
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

async function api<T>(path: string): Promise<T> {
  return (await (await fetch(`${world.url}${path}`)).json()) as T;
}
type Message = { id: string; body: string; tags?: { session: string; label?: string; wakes: boolean; delivery?: { at: string } | null }[]; delivery?: { at: string } | null };
async function messages(threadId: string): Promise<Message[]> {
  return (await api<{ thread: { messages: Message[] } }>(`/api/inbox/threads/${threadId}`)).thread.messages;
}
const connection = (session: string) => world.tags.connections.find((c) => c.session === session)!;

/** Open a thread and its reply box. */
async function openReply(page: Page, threadId: string): Promise<ReturnType<Page['locator']>> {
  await page.goto(`${world.url}#thread=${threadId}`);
  const pane = page.locator('section.ib-pane');
  await expect(pane.locator('h2.ib-subject')).toBeVisible();
  // Words an earlier test left are kept as the thread's reply draft, which reopens the box by
  // itself once read (approval "inbox-reply-drafts"); the read can land between the check and
  // the click, so a click that finds no Reply is tried again. The test starts from an empty box.
  const box = pane.getByRole('textbox', { name: /^Reply to/ });
  const reply = pane.locator('.ib-pfoot').getByRole('button', { name: /^(Reply|Edit draft)$/ });
  for (let attempt = 0; attempt < 10 && !(await box.isVisible()); attempt += 1) {
    await reply.click({ timeout: 1_000 }).catch(() => {});
  }
  await expect(box).toBeVisible();
  await box.fill('');
  return box;
}

/** The thread pane at rest: on a phone it comes in over the list; a measurement mid-way is not the layout. */
async function atRest(page: Page): Promise<void> {
  await expect(page.locator('section.ib-pane')).toBeVisible();
  await expect.poll(async () => Math.round((await page.locator('section.ib-pane').boundingBox())?.x ?? -1), { timeout: 10_000 }).toBe(0);
}

/** Type `@query`, arrow onto the row of `session`, and pick it. */
async function tag(page: Page, box: ReturnType<Page['locator']>, query: string, session: string): Promise<void> {
  await box.pressSequentially(`@${query}`);
  await expect(page.locator(`[data-tag-option="${session}"]`)).toBeVisible();
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('ArrowDown');
    if ((await page.locator('[data-tag-option][aria-selected="true"]').getAttribute('data-tag-option')) === session) break;
  }
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-tag-picker]')).toHaveCount(0);
  await page.waitForTimeout(80);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-tags-e2e-');
  const dataDir = join(root, 'data');
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_INBOX_TAILSCALE: '0',
    PLANNOTATOR_INBOX_PHONES: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_INBOX_NOTES: '0',
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  const url = started.stdout.trim().replace(/\/$/, '');
  const { token } = JSON.parse(readFileSync(join(dataDir, 'inbox', 'inbox.json'), 'utf8')) as { token: string };
  const tags = await seedTagWorld(url, token, join(root, 'projects'));
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  world = { url, tags, context, page, errors };
});

test.afterAll(async () => {
  try {
    if (!world) return;
    await world.tags.stop();
    await world.context.close();
  } finally {
    await removeInboxScratch();
  }
});

test('@ opens the live sessions grouped by agent (the owner first, MCP agents last); a pick is a chip with the one line of what Send does', async () => {
  const { page } = world;
  const box = await openReply(page, world.tags.ids.t1);
  await box.pressSequentially('Queue it, and cap retries at 5. @');
  const picker = page.locator('[data-tag-picker]');
  await expect(picker).toBeVisible();
  await expect(picker.locator('[role="group"]')).toHaveCount(4);
  expect(await picker.locator('[role="group"]').evaluateAll((gs) => gs.map((g) => g.getAttribute('data-tag-group')))).toEqual([
    'Claude Code',
    'Pi',
    'OpenCode',
    'Reads the Inbox, not woken',
  ]);
  await expect(picker.locator('[data-tag-option]').first()).toContainText('Owns this thread');
  await expect(page.locator(`[data-tag-option="${S.oldPi}"]`)).toContainText('Update Plannotator to tag this session');
  await expect(page.locator(`[data-tag-option="${S.codex}"]`)).toContainText('Not woken');
  // The field is the listbox's: nothing active until arrowed onto.
  await expect(box).toHaveAttribute('aria-controls', (await picker.getAttribute('id'))!);
  expect(await box.getAttribute('aria-activedescendant')).toBeNull();
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown');
  await expect(box).toHaveAttribute('aria-activedescendant', /option-3$/);
  await shot(page, '1-picker-desktop');

  // Pick Pi, then the other Claude Code session.
  await page.keyboard.press('Escape');
  await box.fill('Queue it, and cap retries at 5. ');
  await box.press('End');
  await tag(page, box, 'Claude', S.claudeTwo);
  await box.pressSequentially('please re-run the ledger tests against the queue. ');
  await tag(page, box, 'Pi', S.pi);
  await box.pressSequentially('raise the visibility timeout in infra/queue.tf to 30 s.');
  // One line under the box (approval "inbox-tag-handoff", A2): Send asks them; two agents can be added, not handed the thread.
  const line = page.locator('[data-tag-mode]');
  await expect(line.locator('[data-tag-mode-words]')).toHaveText('Asks Claude Code (another session) and Pi');
  await expect(line.locator('[data-tag-mode-to]')).toHaveText(['Add instead']);
  await expect(page.locator('[data-tag-notes]')).toHaveCount(0);
  await expect(page.locator('[data-tag-live]')).toContainText("Tagged Pi. It doesn't own this thread");
  await shot(page, '2-tagged-desktop');

  // An agent that reads the Inbox only: the line says so, and offers no switch.
  await box.fill('Queue it, and cap retries at 5. ');
  await box.press('End');
  await tag(page, box, 'Codex', S.codex);
  await box.pressSequentially('the runbook in docs-site needs the new dead-letter alert.');
  await expect(line.locator('[data-tag-mode-words]')).toHaveText("Asks Codex · Codex isn't woken: it sees your reply the next time it reads this thread");
  await expect(line.locator('[data-tag-mode-to]')).toHaveCount(0);
  await shot(page, '3-mcp-desktop');
  expect(world.errors).toEqual([]);
});

test('Send: the owner and every tagged session are handed the one reply, each with its own wake; the older Pi never is; a tagged read never swallows the owner', async () => {
  const { page } = world;
  const box = page.locator('section.ib-pane').getByRole('textbox', { name: /^Reply to/ });
  await box.fill('Queue it. ');
  await box.press('End');
  await tag(page, box, 'Pi', S.pi);
  await box.pressSequentially('raise the timeout. ');
  await tag(page, box, 'Codex', S.codex);
  await box.pressSequentially('add the alert.');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.locator('[data-tag-lines] > li')).toHaveCount(3);
  const sent = (await messages(world.tags.ids.t1)).at(-1)!;
  expect(sent.tags?.map((t) => [t.session, t.label, t.wakes])).toEqual([
    [S.pi, 'Pi', true],
    [S.codex, 'Codex', false],
  ]);
  // Pi (tagged) is handed it, with the tagged wake.
  await expect.poll(() => connection(S.pi).commands.some((c) => c.id === sent.id), { timeout: 15_000 }).toBe(true);
  const piCommand = connection(S.pi).commands.find((c) => c.id === sent.id)!;
  expect(piCommand.tagged).toEqual({ owner: 'Claude Code' });
  expect(inboxWakeText(piCommand).split('\n')[1]).toBe(INBOX_TAGGED_INSTRUCTION);
  // Pi reads the thread first, as told. The owner is still handed it, naming the others.
  const read = await fetch(`${world.url}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_thread', arguments: { thread_id: world.tags.ids.t1, agent_session: S.pi } } }),
  });
  expect(read.status).toBe(200);
  await expect.poll(() => connection(S.owner).commands.some((c) => c.id === sent.id), { timeout: 15_000 }).toBe(true);
  const ownerCommand = connection(S.owner).commands.find((c) => c.id === sent.id)!;
  expect(ownerCommand.also_tagged).toEqual(['Pi', 'Codex']);
  expect(inboxWakeText(ownerCommand).split('\n')[2]).toBe(inboxAlsoTaggedLine(['Pi', 'Codex']));
  // Nobody else is handed it: not the other sessions, never the Pi on an older Plannotator.
  await page.waitForTimeout(1_500);
  for (const other of [S.claudeTwo, S.claudeElsewhere, S.opencode, S.oldPi]) expect(connection(other).commands.some((c) => c.id === sent.id)).toBe(false);
  expect(await connection(S.owner).deliver(sent.id)).toBe(200);
  expect(await connection(S.pi).deliver(sent.id)).toBe(200);
  const delivered = (await messages(world.tags.ids.t1)).at(-1)!;
  expect(delivered.delivery).toBeTruthy();
  expect(delivered.tags?.[0]?.delivery).toBeTruthy();
});

/** Open the thread's file, select a passage, and write a comment that tags Pi (the composer left open). */
async function fileCommentTaggingPi(page: Page): Promise<void> {
  // By its deep link: once the thread has more messages, the one with the tile is folded.
  const files = await api<{ attachments: { id: string }[] }>(`/api/inbox/threads/${world.tags.ids.t1}/attachments`);
  await page.goto(`${world.url}#thread=${world.tags.ids.t1}&file=${files.attachments[0]!.id}`);
  await expect(page.locator('[data-attachment-pane] .ib-docscroll')).toBeVisible();
  // The passage's place once the layout stops moving: opening a file beside the thread hides the list and
  // springs the sidebar shut, so the pane slides and widens for a few hundred ms after it shows. Measured
  // mid-slide, the drag lands where the text no longer is (blank space selects nothing, no toolbar opens).
  const box = await page.evaluate(async (needle) => {
    const measure = () => {
      const root = document.querySelector('[data-attachment-pane] .ib-docscroll');
      if (!root) return null;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.textContent?.indexOf(needle) ?? -1;
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + needle.length);
        const rects = [...range.getClientRects()];
        return { x1: rects[0]!.left + 1, y1: rects[0]!.top + rects[0]!.height / 2, x2: rects.at(-1)!.right - 1, y2: rects.at(-1)!.top + rects.at(-1)!.height / 2 };
      }
      return null;
    };
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    const deadline = performance.now() + 10_000;
    let last = measure();
    // Still for ten frames in a row.
    for (let still = 0; still < 10 && performance.now() < deadline; ) {
      await frame();
      const next = measure();
      still = next && last && JSON.stringify(next) === JSON.stringify(last) ? still + 1 : 0;
      last = next;
    }
    return last;
  }, 'The handler acks Stripe within 2 s');
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x1, box!.y1);
  await page.mouse.down();
  await page.mouse.move(box!.x2, box!.y2, { steps: 8 });
  await page.mouse.up();
  // The toolbar opens on the selection; fail here, not after the whole test timeout, when it does not.
  const comment = page.locator('.annotation-toolbar button[aria-label="Comment"]');
  await expect(comment).toBeVisible();
  await comment.click();
  const composer = page.locator('[data-comment-popover] textarea[data-pn-mobile-editable="true"]').last();
  await composer.click();
  await composer.pressSequentially('@Pi');
  await expect(page.locator(`[data-mention-option="${S.pi}"]`)).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(100);
  await composer.pressSequentially('does a 30 s visibility timeout still let the handler ack within 2 s?');
  const notes = page.locator('[data-comment-popover] [data-tag-notes]');
  await expect(notes.locator('[data-tag-heads-up="non-owner"]')).toHaveText(
    "Pi doesn't own this thread. It gets this comment with your next Send, and a pointer to this thread.",
  );
}

test('a tag in a file comment: the composer offers agents with "Goes to" and the heads-up; the Send tags that agent and the export marks the comment', async () => {
  const { page } = world;
  await fileCommentTaggingPi(page);
  await shot(page, '4-file-comment-desktop');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('button', { name: 'Reply', exact: true }).first().click();
  const reply = page.getByRole('textbox', { name: /^Reply to/ });
  await reply.fill('See my comment on the design.');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect.poll(async () => (await messages(world.tags.ids.t1)).at(-1)!.body, { timeout: 15_000 }).toContain('Tagged Pi: this comment sends the reply to it too.');
  const sent = (await messages(world.tags.ids.t1)).at(-1)!;
  expect(sent.tags?.map((t) => t.session)).toEqual([S.pi]);
});

test('the sent reply shows one line per agent (Lines): delivered, queued with its own Send now, and saved for the MCP agent', async () => {
  const { page } = world;
  // The owner took its copy of the Dead-letter queue reply; Pi is working; Codex reads only.
  expect(await connection(S.owner).deliver(world.tags.ids.r2)).toBe(200);
  await page.goto(`${world.url}#thread=${world.tags.ids.t2}`);
  const lines = page.locator('[data-tag-lines] > li');
  await expect(lines).toHaveCount(3);
  await expect(lines.nth(0)).toHaveAttribute('data-delivery', 'delivered');
  await expect(lines.nth(0)).toContainText(/^Delivered to Claude Code, /);
  await expect(lines.nth(1)).toHaveAttribute('data-delivery', 'queued');
  await expect(lines.nth(1)).toContainText(/Undelivered(?: \d+ min)? · Pi is working · goes in by itself in /);
  await expect(lines.nth(1).locator('[data-send-now]')).toBeVisible();
  await expect(lines.nth(2)).toContainText('Saved for Codex. It sees it the next time it reads this thread.');
  await expect(page.locator('[data-tagged-names]')).toHaveText(' · tagged Pi, Codex');
  // Each tag chip in the sent words carries its agent's mark over the `@` (the approved shot 5).
  const marks = page.locator('article.ib-message[data-author="person"] [data-tag-marks] .ib-tg-mark');
  await expect(marks).toHaveCount(2);
  for (const mark of await marks.all()) {
    const box = (await mark.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(10);
    expect(box.width).toBeLessThanOrEqual(14);
  }
  await shot(page, '5-sent-lines-desktop', { clip: { selector: 'article.ib-message[data-author="person"]' } });
  // Pi's own Send now hands Pi its copy with `now`.
  await lines.nth(1).locator('[data-send-now]').click();
  await expect.poll(() => connection(S.pi).commands.find((c) => c.id === world.tags.ids.r2)?.now, { timeout: 15_000 }).toBe(true);
  await expect(page.locator('.ib-lbody [data-thread-id="' + world.tags.ids.t2 + '"]').first()).toContainText('1 of 3 delivered · Pi queued');
});

test('the thread head and the row show the agents in the thread, overlapping', async () => {
  const { page } = world;
  await page.goto(`${world.url}#thread=${world.tags.ids.t3}`);
  const head = page.locator('[data-thread-participants]');
  await expect(head).toHaveText('Claude Code and Pi');
  await expect(head.locator('[data-tag-stack]')).toHaveAttribute('data-tag-stack', '2');
  await shot(page, '6-thread-head-desktop', { clip: { selector: '.ib-pbody > .ib-tmeta[data-thread-meta]', pad: 40 } });
  const row = page.locator(`.ib-lbody [data-thread-id="${world.tags.ids.t3}"]`).first();
  await expect(row.locator('[data-tag-stack]')).toHaveAttribute('data-tag-stack', '2');
  await shot(page, '7-list-row-desktop', { clip: { selector: `.ib-lbody [data-thread-id="${world.tags.ids.t2}"]`, pad: 24 } });
  await shot(page, '7-list-desktop');
});

test('a phone-width window: a tag in a file comment, on the full-screen file (a mouse selects the text; touch selection is the system menu)', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
  try {
    const page = await context.newPage();
    await fileCommentTaggingPi(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    for (const el of await page.locator('[data-comment-popover] [data-tag-notes] *').all()) {
      const rect = await el.boundingBox();
      if (rect) expect(rect.x + rect.width).toBeLessThanOrEqual(390.5);
    }
    await shot(page, '4-file-comment-phone');
  } finally {
    await context.close();
  }
});

test('on a phone: 44 px rows in the picker, the line and lines inside 320 px, and the same states', async ({ browser }) => {
  for (const width of [390, 320]) {
    const context = await browser.newContext({ ...PHONE, viewport: { width, height: 844 } });
    try {
      const page = await context.newPage();
      const name = width === 390 ? 'phone' : 'phone-320';
      const box = await openReply(page, world.tags.ids.t1);
      await box.pressSequentially('Queue it. @');
      const options = page.locator('[data-tag-option]');
      await expect(options.first()).toBeVisible();
      for (const height of await options.evaluateAll((os) => os.map((o) => o.getBoundingClientRect().height))) expect(height).toBeGreaterThanOrEqual(44);
      const fits = async () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
      expect(await fits()).toBe(true);
      if (width === 390) await shot(page, `1-picker-${name}`);
      await page.keyboard.press('Escape');
      await box.fill('Queue it. ');
      await box.press('End');
      await tag(page, box, 'Pi', S.pi);
      await box.pressSequentially('raise it. ');
      await tag(page, box, 'Codex', S.codex);
      await box.pressSequentially('add the alert.');
      await expect(page.locator('[data-tag-mode-words]')).toContainText('Asks Pi and Codex');
      for (const el of await page.locator('[data-tag-mode], [data-tag-mode] *').all()) {
        const rect = await el.boundingBox();
        if (rect) expect(rect.x + rect.width).toBeLessThanOrEqual(width + 0.5);
      }
      expect(await fits()).toBe(true);
      await shot(page, `2-tagged-${name}`);
      if (width === 390) {
        // An agent that cannot be woken, alone: no switch.
        await box.fill('Queue it. ');
        await box.press('End');
        await tag(page, box, 'Codex', S.codex);
        await box.pressSequentially('the runbook needs the alert.');
        await expect(page.locator('[data-tag-mode-words]')).toContainText("Codex isn't woken");
        await expect(page.locator('[data-tag-mode-to]')).toHaveCount(0);
        await shot(page, `3-mcp-${name}`);
      }
      await page.goto(`${world.url}#thread=${world.tags.ids.t2}`);
      await atRest(page);
      await expect(page.locator('[data-tag-lines] > li')).toHaveCount(3);
      for (const el of await page.locator('[data-tag-lines] > li *').all()) {
        const rect = await el.boundingBox();
        const chain = await el.evaluate((e) => {
          const out: string[] = [];
          for (let n: Element | null = e; n && n !== document.body; n = n.parentElement) {
            const r = n.getBoundingClientRect();
            out.push(`${n.tagName}.${(n.getAttribute('class') ?? '').slice(0, 30)}[${Math.round(r.left)}..${Math.round(r.right)}]`);
          }
          return out.join(' < ');
        });
        if (rect) expect(rect.x + rect.width, chain).toBeLessThanOrEqual(width + 0.5);
      }
      expect(await fits()).toBe(true);
      await shot(page, `5-sent-lines-${name}`);
      await page.goto(`${world.url}#thread=${world.tags.ids.t3}`);
      await atRest(page);
      await expect(page.locator('[data-thread-participants]')).toBeVisible();
      expect(await fits()).toBe(true);
      await shot(page, `6-thread-head-${name}`);
      await page.goto(world.url);
      await expect(page.locator(`[data-thread-id="${world.tags.ids.t2}"]`).first()).toBeVisible();
      expect(await fits()).toBe(true);
      await shot(page, `7-list-${name}`);
    } finally {
      await context.close();
    }
  }
});
