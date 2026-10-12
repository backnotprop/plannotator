/**
 * The Inbox window on a phone (reached over the tailnet with `plannotator
 * inbox --tailscale`), proved in WebKit with the iPhone 15's descriptor and
 * in Chromium with the Pixel 7's, against the compiled binary under a temp
 * PLANNOTATOR_DATA_DIR. One screen at a time, like a mail app:
 *
 * - no screen scrolls sideways or draws past the window (the list, the
 *   project's list, a thread, an open file, the sheet, Decisions, Settings);
 * - the list's rows and the thread's headers hold their parts without one
 *   box over another (the report: the time and the agent's mark overlapped);
 * - the primary actions are at least 44 px and the reply box is 16 px text,
 *   so iOS never zooms the page when it takes focus;
 * - a row opens the thread over the whole window, Back (or the browser's
 *   own back, the iOS swipe) returns to the list where it was scrolled, and
 *   a file opens over the thread with Back to it.
 *
 * And a desktop window keeps its two panes. Build the binary first (see
 * inbox.spec.ts), then `bun run test:e2e:inbox`. PNGs land in
 * .local/proof/mobile/.
 */

import { chromium, devices, expect, test, webkit, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { DEMO_MESSAGES, SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'mobile');

interface World {
  root: string;
  dataDir: string;
  url: string;
  billing: string;
  threads: { stopped: string; long: string; attach: string; holding: string; tokens: string };
  agents: SimAgent[];
}

let world: World;

const LONG_URL =
  'https://hooks.example.com/stripe/v1/refunds/reconcile/billing-svc/production/us-east-1/account-0001-placeholder-0002-placeholder-0003?sig=9f8e7d6c5b4a3928170615243342516071829304a5b6c7d8e9f0&replay=true';
// (Made-up strings, nothing like a real key: a secret scanner must never mistake them for one.)
const LONG_KEY = `example_key_${'a1B2c3D4e5F6g7H8'.repeat(5)}`;
const LONG_TOKEN = `example_token_${'0123456789abcdef'.repeat(6)}`;
const LONG_ID = `idem_01HZX9QW3E5R7T9Y1U3I5O7P9A1S3D5F7G9H1J3K5L7Z9X1C3V5B7N9M1Q3W5E7R9T1Y3U5I7O9P1A3S5D7F9G1H3J5K7L9`;

/** The question card and its eyebrow's tags stay inside the thread's column. */
async function cardFits(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const body = document.querySelector('section.ib-pane .ib-pbody')!.getBoundingClientRect();
    for (const card of document.querySelectorAll('section.ib-pane [data-question-key]')) {
      const box = card.getBoundingClientRect();
      if (box.right > body.right + 1) out.push(`the card ends at ${Math.round(box.right)}, past the column at ${Math.round(body.right)}`);
      for (const part of card.querySelectorAll('*')) {
        const r = part.getBoundingClientRect();
        if (r.width === 0) continue;
        if (r.right > box.right + 1) out.push(`${part.tagName.toLowerCase()} "${(part.textContent ?? '').trim().slice(0, 30)}" leaves the card (${Math.round(r.right)} > ${Math.round(box.right)})`);
      }
    }
    return out;
  });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-mobile-e2e-');
  const dataDir = join(root, 'data');
  const home = join(root, 'home');
  const trap = join(root, 'trap');
  mkdirSync(home);
  mkdirSync(trap);
  // Nothing here may reach the real tailscale CLI.
  writeFileSync(join(trap, 'tailscale'), '#!/bin/sh\necho "inbox-mobile: tailscale must not run" >&2\nexit 97\n');
  chmodSync(join(trap, 'tailscale'), 0o755);
  const env = { PATH: `${trap}:${process.env.PATH ?? ''}`, HOME: home, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: 'none', PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9' };
  expect(env.PLANNOTATOR_DATA_DIR.startsWith(root)).toBe(true);
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const port = () => (JSON.parse(readFileSync(join(dataDir, 'inbox', 'inbox.json'), 'utf8')) as { port: number }).port;

  const billing = scratchProject(join(root, 'src'), 'billing-svc');
  const docs = scratchProject(join(root, 'src'), 'payments-reconciliation-service-v2');
  mkdirSync(join(billing, 'docs'));
  writeFileSync(join(billing, 'docs', 'retry-policy.md'), '# Retry policy\n\nFailed refunds are retried with exponential backoff, five times at most.\n');
  writeFileSync(join(billing, 'docs', 'on-call.md'), '# On-call\n\nThe on-call is paged once per refund, not once per attempt.\n');
  // One agent session per thread: a session's unnamed messages join its own thread.
  const agents: SimAgent[] = [];
  const agent = async (name: string, host: string) => {
    const made = await SimAgent.connect({ binary, env, name, host });
    agents.push(made);
    return made;
  };
  const pi = await agent('Pi', 'pi');
  const long = await pi.send({
    project_path: docs,
    thread: 'nightly-reconciliation-of-stripe-payouts-against-the-ledger',
    subject: 'Nightly reconciliation: payouts that do not match the ledger and what to do with them',
    body: 'Starting the nightly reconciliation work. I will post progress here.',
  });
  let last = long.message_id as string;
  for (let i = 1; i <= 3; i++) {
    const reply = await fetch(`http://127.0.0.1:${port()}/api/inbox/messages/${last}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idempotency_key: `mobile-${i}`, words: `Keep going, and tell me when batch ${i} matches.`, questions: [] }),
    });
    expect(reply.status).toBe(200);
    last = (await pi.send({ project_path: docs, reply_to: last, body: `Batch ${i} done: ${120 * i} payouts checked, ${i} mismatches, all timing.` })).message_id as string;
  }
  const attach = await (await agent('Claude Code', 'claude-code')).send({
    project_path: billing,
    subject: 'The retry policy, written down',
    body: 'The policy is attached.',
    attachments: ['docs/retry-policy.md', 'docs/on-call.md'],
  });
  const holding = await (await agent('OpenCode', 'opencode')).send({ project_path: docs, subject: 'Install page: detect the installed agents or ask the reader which one they use', body: DEMO_MESSAGES.holding });
  // What an agent pastes: a long URL, a key in inline code, a bare token, and a choice that is one long ID.
  const tokens = await (await agent('Claude Code', 'claude-code')).send({
    project_path: billing,
    subject: 'Webhook URL and key rotation',
    body: [
      `The webhook endpoint is ${LONG_URL}`,
      '',
      `Rotate the key \`${LONG_KEY}\` before Friday.`,
      '',
      `Raw token: ${LONG_TOKEN}`,
      '',
      ':::question',
      'Which idempotency key format should the retry worker use?',
      'Stopped: the retry worker cannot ship without this.',
      'Holds up: the retry worker; the admin retry view; the nightly export.',
      '',
      `- [ ] ${LONG_ID}`,
      '- [ ] A random UUID per attempt',
      ':::',
    ].join('\n'),
  });
  const stopped = await (await agent('Claude Code', 'claude-code')).send({
    project_path: billing,
    subject: 'Stripe 409 on the retry worker: which way should it go before I ship it',
    body: DEMO_MESSAGES.stopped,
  });
  // Enough rows that the list scrolls on a phone.
  for (let i = 1; i <= 10; i++) await (await agent("OpenCode", "opencode")).send({ project_path: docs, subject: `Docs build ${i} finished`, body: DEMO_MESSAGES.news });
  world = {
    root,
    dataDir,
    url,
    billing,
    threads: { stopped: stopped.thread_id as string, long: long.thread_id as string, attach: attach.thread_id as string, holding: holding.thread_id as string, tokens: tokens.thread_id as string },
    agents,
  };
});

test.afterAll(async () => {
  try {
    if (world) await Promise.all(world.agents.map((a) => a.close().catch(() => {})));
  } finally {
    // Stops only the Inbox this spec provably started, even when beforeAll failed half way (inbox-scratch.ts).
    await removeInboxScratch();
  }
});

/** What sticks out sideways: the page itself, any box past the window, any container that scrolls sideways. */
async function sideways(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const W = window.innerWidth;
    const out: string[] = [];
    const scroller = document.scrollingElement!;
    if (scroller.scrollWidth > W + 1) out.push(`the page is ${scroller.scrollWidth}px wide in a ${W}px window`);
    const name = (el: Element) => `${el.tagName.toLowerCase()}.${[...el.classList].slice(0, 2).join('.')}`;
    for (const el of document.querySelectorAll('.pn-inbox *')) {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      // A code block may scroll its own long lines; nothing else scrolls sideways.
      if (el.closest('pre, code, table, [data-code-view], .ib-cmd')) continue;
      if ((style.overflowX === 'auto' || style.overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) {
        out.push(`${name(el)} scrolls sideways (${el.scrollWidth} in ${el.clientWidth})`);
      }
    }
    for (const el of document.querySelectorAll('.ib-listcol, section.ib-pane, .ib-view, .ib-dpage, .ib-spage, .ib-phead, .ib-lhead, .ib-pfoot, .ib-vhead')) {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0) continue;
      if (r.left < -1 || r.right > W + 1) out.push(`${name(el)} spans ${Math.round(r.left)} to ${Math.round(r.right)} in a ${W}px window`);
    }
    return out;
  });
}

/** Pairs of parts drawn over each other inside each row or header matched by `selector`, and parts cut off by it. */
async function overlaps(page: Page, selector: string, parts: string): Promise<string[]> {
  return page.evaluate(
    ({ selector, parts }) => {
      const out: string[] = [];
      for (const row of document.querySelectorAll(selector)) {
        const style = getComputedStyle(row);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const box = row.getBoundingClientRect();
        if (box.width === 0) continue;
        const items = [...row.querySelectorAll(parts)].filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
        });
        const label = (el: Element) => `${[...el.classList].join('.') || el.tagName.toLowerCase()} "${(el.textContent ?? '').trim().slice(0, 24)}"`;
        for (const el of items) {
          const r = el.getBoundingClientRect();
          if (r.left < box.left - 1 || r.right > box.right + 1) out.push(`${label(el)} leaves its row`);
        }
        for (let i = 0; i < items.length; i++) {
          for (let j = i + 1; j < items.length; j++) {
            const a = items[i]!;
            const b = items[j]!;
            if (a.contains(b) || b.contains(a)) continue;
            const ra = a.getBoundingClientRect();
            const rb = b.getBoundingClientRect();
            const x = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
            const y = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
            if (x > 1 && y > 1) out.push(`${label(a)} over ${label(b)}`);
          }
        }
      }
      return out;
    },
    { selector, parts },
  );
}

/** The primary actions on screen smaller than a thumb (44 by 44). */
async function smallTargets(page: Page, selector: string): Promise<string[]> {
  return page.locator(selector).evaluateAll((els) =>
    els
      .filter((el) => getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden')
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && (r.width < 44 || r.height < 44))
      .map(({ el, r }) => `${el.getAttribute('aria-label') ?? (el.textContent ?? '').trim().slice(0, 24)} is ${Math.round(r.width)}x${Math.round(r.height)}`),
  );
}

const ROW_PARTS = '.ib-mk, .ib-p, .ib-t, .ib-m2, .ib-badge, .ib-key, .ib-c, .ib-att';

for (const phone of [
  { name: 'iPhone 15 (WebKit)', device: devices['iPhone 15'], browserName: 'webkit' as const },
  { name: 'Pixel 7 (Chromium)', device: devices['Pixel 7'], browserName: 'chromium' as const },
]) {
  test.describe(phone.name, () => {
    // The descriptor's context options (viewport, scale, touch, mobile, user agent); its browser is launched below.
    const { defaultBrowserType: _browser, ...device } = phone.device;
    let browser: Browser | null = null;
    let contexts: BrowserContext[] = [];
    // A describe group cannot pick a browser through test.use (it forces a new worker), so it launches its own.
    test.beforeAll(async () => {
      // The config's launch options are Chromium flags (--use-mock-keychain, --password-store=basic), and the
      // runner applies them to every launch. WebKit on Linux exits on flags it does not know, so it launches with none.
      browser = phone.browserName === 'webkit' ? await webkit.launch({ args: [] }) : await chromium.launch();
    });
    test.afterEach(async () => {
      await Promise.all(contexts.map((c) => c.close()));
      contexts = [];
    });
    test.afterAll(async () => {
      await browser?.close();
    });
    async function open(): Promise<Page> {
      const context = await browser!.newContext(device);
      contexts.push(context);
      return context.newPage();
    }
    const tag = phone.browserName;

    async function shot(page: Page, name: string): Promise<void> {
      await page.waitForTimeout(250);
      await page.screenshot({ path: join(proofDir, `${tag}-${name}.png`) });
    }

    test('the list: mail rows, nothing sideways, nothing over anything, a thumb-sized trigger', async () => {
      const page = await open();
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(world.url);
      await expect(page.locator('.ib-mrow').first()).toBeVisible();
      await shot(page, '1-list');
      expect(await sideways(page)).toEqual([]);
      expect(await overlaps(page, '.ib-mrow', ROW_PARTS)).toEqual([]);
      // Each row: who and when on the first line, the subject under it, the time at the right edge.
      const row = page.locator(`.ib-mrow[data-thread-id="${world.threads.stopped}"]`);
      await expect(row.locator('.ib-m2')).toHaveText('Stripe 409 on the retry worker: which way should it go before I ship it');
      const [rowBox, timeBox, subjectBox] = await Promise.all([row.boundingBox(), row.locator('.ib-t').boundingBox(), row.locator('.ib-m2').boundingBox()]);
      expect(timeBox!.x + timeBox!.width).toBeGreaterThan(rowBox!.x + rowBox!.width - 24);
      expect(subjectBox!.y).toBeGreaterThan(timeBox!.y);
      expect(await smallTargets(page, '.ib-mrow, .ib-lhead .ib-sb-trigger')).toEqual([]);

      // One project's list: the same rows (the wide row's columns once left the subject no room).
      await page.goto(`${world.url}#project=${(await page.evaluate(() => fetch('/api/inbox/projects').then((r) => r.json()))).projects.find((p: { name: string }) => p.name === 'billing-svc').id}`);
      await expect(page.locator('.ib-lhead h1')).toHaveText('billing-svc');
      await expect(page.locator('.ib-mrow').first()).toBeVisible();
      await expect(page.locator('.ib-row')).toHaveCount(0);
      await shot(page, '2-project');
      expect(await sideways(page)).toEqual([]);
      expect(await overlaps(page, '.ib-mrow, .ib-lhead', `${ROW_PARTS}, h1, .ib-sb-trigger`)).toEqual([]);

      // The navigation is a sheet.
      await page.locator('.ib-lhead .ib-sb-trigger').click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await shot(page, '3-sheet');
      expect(await smallTargets(page, '[role="dialog"] .ib-nav, [role="dialog"] .ib-proj')).toEqual([]);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
    });

    test('a thread takes the window, Back and the browser back return to the list where it was', async () => {
      const page = await open();
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(world.url);
      const list = page.locator('.ib-lbody');
      await expect(page.locator('.ib-mrow').first()).toBeVisible();
      for (const id of [world.threads.stopped, world.threads.tokens, world.threads.holding]) await expect(page.locator(`.ib-mrow[data-thread-id="${id}"]`)).toBeVisible();
      const pane = page.locator('section.ib-pane');
      // Scrolled down to a row whose section opening it does not change, it opens its thread; Back returns to the list scrolled where it was.
      const holdingRow = page.locator(`.ib-mrow[data-thread-id="${world.threads.holding}"]`);
      await holdingRow.evaluate((row) => {
        const el = row.closest(".ib-lbody")!;
        el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top - 48;
      });
      const scrolled = await list.evaluate((el) => el.scrollTop);
      expect(scrolled).toBeGreaterThan(0);
      await holdingRow.click();
      await expect(pane).toBeVisible();
      await expect(page.locator('.ib-listcol')).toBeHidden();
      await page.locator('[data-phone-back]').click();
      await expect(page.locator('.ib-listcol')).toBeVisible();
      expect(await list.evaluate((el) => el.scrollTop)).toBe(scrolled);
      expect(await page.evaluate(() => window.location.hash)).toBe('');

      await list.evaluate((el) => el.scrollTo({ top: 0 }));
      await page.locator(`.ib-mrow[data-thread-id="${world.threads.stopped}"]`).click();
      await expect(pane.getByRole('heading', { name: /Stripe 409/ })).toBeVisible();
      // One screen: the thread spans the window and the list is gone from view.
      const viewport = page.viewportSize()!;
      const paneBox = (await pane.boundingBox())!;
      expect(paneBox.x).toBeLessThan(1);
      expect(paneBox.width).toBeGreaterThan(viewport.width - 2);
      await expect(page.locator(".ib-listcol")).toBeHidden();
      await shot(page, '4-thread');
      expect(await sideways(page)).toEqual([]);
      expect(await overlaps(page, '.ib-phead', '.ib-pback, .ib-phsubj[data-on], .ib-iconbtn, .ib-ptool')).toEqual([]);
      expect(await overlaps(page, '.ib-sender', '.ib-mk, .ib-whobox, .ib-tm')).toEqual([]);
      const back = pane.getByRole('button', { name: 'Back to Inbox' });
      await expect(back).toBeVisible();
      await expect(back).toHaveText('Inbox');
      expect(await smallTargets(page, '[data-phone-back], .ib-phead .ib-iconbtn, .ib-pfoot .ib-btn')).toEqual([]);

      // A pick, then the reply box: 16 px text, above the foot's 44 px actions.
      await pane.getByText('Retry with the same idempotency key').click();
      await pane.locator('.ib-pfoot').getByRole('button', { name: 'Edit the reply' }).click();
      const box = pane.getByRole('textbox', { name: 'Reply to Claude Code' });
      await expect(box).toBeVisible();
      expect(await box.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
      await shot(page, '5-reply');
      expect(await sideways(page)).toEqual([]);
      expect(await smallTargets(page, '.ib-pfoot .ib-btn')).toEqual([]);
      await pane.locator('.ib-pfoot').getByRole('button', { name: 'Cancel' }).click();

      // Back: the list, and the address of the list (the history is the stack it looks like).
      await back.click();
      await expect(page.locator('.ib-listcol')).toBeVisible();
      await expect(pane).toHaveCount(0);
      expect(await page.evaluate(() => window.location.hash)).toBe('');

      // The browser's own back (the iOS swipe, Android's back) does the same.
      // (A thread with an open question: the ones read without one are folded under Quiet by now.)
      await page.locator(`.ib-mrow[data-thread-id="${world.threads.holding}"]`).click();
      await expect(page.locator('section.ib-pane')).toBeVisible();
      await page.goBack();
      await expect(page.locator('.ib-listcol')).toBeVisible();
      await expect(page.locator('section.ib-pane')).toHaveCount(0);
    });

    test('a long thread folds on a phone without a line running past the window', async () => {
      const page = await open();
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(`${world.url}#thread=${world.threads.long}`);
      const pane = page.locator('section.ib-pane');
      await expect(pane.locator('.ib-fline').first()).toBeVisible();
      await shot(page, '6-long');
      expect(await sideways(page)).toEqual([]);
      expect(await overlaps(page, '.ib-fline', '.ib-mk, .ib-fl-nm, .ib-fl-sn, .ib-fl-tm, .ib-fl-chip')).toEqual([]);
      await pane.locator('[data-expand-all]').click();
      await expect(pane.locator('.ib-fline')).toHaveCount(0);
      expect(await sideways(page)).toEqual([]);
      expect(await overlaps(page, '.ib-sender', '.ib-mk, .ib-whobox, .ib-tm')).toEqual([]);
    });

    test('a file opens over the thread, its comments are a sheet, and Back returns to the thread', async () => {
      const page = await open();
      // Motion on: the thread slides in when it opens over the list, and not again when the file over it closes.
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.goto(world.url);
      await expect(page.locator('.ib-mrow').first()).toBeVisible();
      await page.evaluate((id) => (window.location.hash = `#thread=${id}`), world.threads.attach);
      const pane = page.locator('section.ib-pane');
      await expect(pane.getByRole('heading', { name: 'The retry policy, written down' })).toBeVisible();
      const slides = (el: Element) => el.getAnimations().filter((a) => (a as CSSAnimation).animationName === 'ib-push').length;
      expect(await pane.evaluate(slides)).toBe(1);
      await page.waitForTimeout(400);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await pane.locator('.ib-att-t', { hasText: 'retry-policy.md' }).click();
      const view = page.locator('section.ib-view');
      await expect(view.getByText('Failed refunds are retried with exponential backoff')).toBeVisible();
      const viewport = page.viewportSize()!;
      const viewBox = (await view.boundingBox())!;
      expect(viewBox.x).toBeLessThan(1);
      expect(viewBox.width).toBeGreaterThan(viewport.width - 2);
      await expect(pane).toBeHidden();
      // The desktop's Full screen and close give way to Back; the annotations panel waits behind Comments.
      await expect(view.getByRole('button', { name: 'Full screen' })).toHaveCount(0);
      await expect(view.locator('.ib-apanel')).toBeHidden();
      await shot(page, '7-file');
      expect(await sideways(page)).toEqual([]);
      expect(await overlaps(page, '.ib-vhead', '.ib-pback, .ib-fn, .ib-btn')).toEqual([]);
      expect(await smallTargets(page, '.ib-vhead [data-phone-back], .ib-vhead .ib-btn, .ib-vfoot .ib-btn')).toEqual([]);
      await view.locator('[data-annotations-sheet]').click();
      const sheet = view.getByRole('region', { name: 'Comments' });
      await expect(sheet).toBeVisible();
      // A sheet up from the bar under the file, over the file, under the header.
      const sheetBox = (await sheet.boundingBox())!;
      const fileBox = (await view.locator(".ib-vbody").boundingBox())!;
      expect(Math.abs(sheetBox.y + sheetBox.height - (fileBox.y + fileBox.height))).toBeLessThan(2);
      expect(sheetBox.y).toBeGreaterThan((await view.locator('.ib-vhead').boundingBox())!.height);
      await shot(page, '8-file-comments');
      expect(await sideways(page)).toEqual([]);
      await sheet.getByRole('button', { name: 'Close the comments' }).click();
      await expect(sheet).toBeHidden();
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await view.getByRole('button', { name: 'Back to the thread' }).click();
      await expect(page.locator('section.ib-view')).toHaveCount(0);
      await expect(pane).toBeVisible();
      expect(await pane.evaluate(slides)).toBe(0);
      expect(await page.evaluate(() => window.location.hash)).toBe(`#thread=${world.threads.attach}`);
    });

    test('stepping to the next file keeps Back one press to the thread, then one to the list', async () => {
      const page = await open();
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(world.url);
      await expect(page.locator('.ib-mrow').first()).toBeVisible();
      // Opened from the list (a push), then a file (a push), then the next file (a replace).
      await page.evaluate((id) => (window.location.hash = `#thread=${id}`), world.threads.attach);
      const pane = page.locator('section.ib-pane');
      await expect(pane.getByRole('heading', { name: 'The retry policy, written down' })).toBeVisible();
      await pane.locator('.ib-att-t', { hasText: 'retry-policy.md' }).click();
      const view = page.locator('section.ib-view');
      await expect(view.getByText('Failed refunds are retried with exponential backoff')).toBeVisible();
      await view.getByRole('button', { name: /^Next attachment/ }).click();
      await expect(view.getByText('The on-call is paged once per refund')).toBeVisible();
      expect(await page.evaluate(() => (window.history.state as { ibFrom?: string } | null)?.ibFrom)).toBe(`#thread=${world.threads.attach}`);
      await view.getByRole('button', { name: 'Back to the thread' }).click();
      await expect(page.locator('section.ib-view')).toHaveCount(0);
      await expect(pane).toBeVisible();
      expect(await page.evaluate(() => window.location.hash)).toBe(`#thread=${world.threads.attach}`);
      await pane.getByRole('button', { name: 'Back to Inbox' }).click();
      await expect(page.locator('.ib-listcol')).toBeVisible();
      expect(await page.evaluate(() => window.location.hash)).toBe('');
    });

    test("a long URL, a key, a bare token and an option that is one long ID wrap: nothing scrolls sideways, the card and its tags fit, down to an iPhone SE", async () => {
      const page = await open();
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(`${world.url}#thread=${world.threads.tokens}`);
      const pane = page.locator('section.ib-pane');
      await expect(pane.getByRole('heading', { name: 'Webhook URL and key rotation' })).toBeVisible();
      await expect(pane.getByText(LONG_ID)).toBeVisible();
      await shot(page, '11-long-tokens');
      expect(await sideways(page)).toEqual([]);
      expect(await cardFits(page)).toEqual([]);
      // The iPhone SE's 320 px.
      await page.setViewportSize({ width: 320, height: 568 });
      await page.waitForTimeout(200);
      await shot(page, '12-long-tokens-se');
      expect(await sideways(page)).toEqual([]);
      expect(await cardFits(page)).toEqual([]);
    });

    test('a double tap on Back, or two Escapes, go back once and stay in the Inbox', async () => {
      const page = await open();
      await page.goto(world.url);
      const pane = page.locator('section.ib-pane');
      const inbox = new URL(world.url).origin;
      for (const leave of ['double tap', 'two escapes'] as const) {
        await page.locator(`.ib-mrow[data-thread-id="${world.threads.holding}"]`).click();
        await expect(pane).toBeVisible();
        if (leave === 'double tap') await page.locator('[data-phone-back]').dblclick();
        else {
          await page.keyboard.press('Escape');
          await page.keyboard.press('Escape');
        }
        await page.waitForTimeout(600);
        // Still the Inbox (one Back, not two out of it), on its list.
        expect(new URL(page.url()).origin, leave).toBe(inbox);
        await expect(page.locator('.ib-listcol')).toBeVisible();
        await expect(pane).toHaveCount(0);
        // A second tap that lands after the list is back hits the list's menu button, which opens the navigation: close it.
        if (await page.getByRole('dialog').isVisible()) await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog')).toHaveCount(0);
      }
    });

    test('a pinch-zoom to 2x is the person reading closer, not a keyboard: the window keeps its height', async () => {
      test.skip(phone.browserName !== 'chromium', "page scale is set through Chromium's DevTools protocol");
      const page = await open();
      await page.goto(`${world.url}#thread=${world.threads.stopped}`);
      await expect(page.locator('section.ib-pane')).toBeVisible();
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2 });
      await page.waitForTimeout(400);
      const state = await page.evaluate(() => ({
        scale: window.visualViewport!.scale,
        covered: window.innerHeight - window.visualViewport!.height,
        vvh: document.documentElement.style.getPropertyValue('--ib-vvh'),
        height: document.querySelector('.pn-inbox')!.getBoundingClientRect().height,
        innerHeight: window.innerHeight,
      }));
      expect(state.scale).toBeCloseTo(2);
      // Half the window is out of the zoomed view, which the keyboard rule once took for a keyboard.
      expect(state.covered).toBeGreaterThan(80);
      expect(state.vvh).toBe('');
      expect(state.height).toBe(state.innerHeight);
    });

    test('Decisions and Settings fit the window', async () => {
      const page = await open();
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(`${world.url}#settings`);
      await expect(page.locator('.ib-spage h1')).toHaveText('Settings');
      await shot(page, '9-settings');
      expect(await sideways(page)).toEqual([]);
      await page.goto(`${world.url}#decisions=`);
      await expect(page.locator('.ib-dh h1')).toHaveText('Decisions');
      await shot(page, '10-decisions');
      expect(await sideways(page)).toEqual([]);
    });
  });
}

test.describe('a desktop window', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test('long URLs, keys, tokens and IDs never scroll the thread sideways at desktop widths either', async ({ page }) => {
    // (Narrower desktop windows squeeze the thread beside the docked sidebar and list: a known follow-up.)
    for (const width of [1440, 1280, 1024]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${world.url}#thread=${world.threads.tokens}`);
      await expect(page.locator('section.ib-pane').getByText(LONG_ID)).toBeVisible();
      expect(await sideways(page), `at ${width}px`).toEqual([]);
      expect(await cardFits(page), `at ${width}px`).toEqual([]);
    }
  });
  test("closing a thread is a new history entry, as it always was: the browser's Back reopens it", async ({ page }) => {
    await page.goto(world.url);
    await page.locator(`.ib-lbody [data-thread-id="${world.threads.holding}"]`).click();
    const pane = page.locator('section.ib-pane');
    await expect(pane).toBeVisible();
    await pane.getByRole('button', { name: 'Close the thread' }).click();
    await expect(pane).toHaveCount(0);
    await page.goBack();
    await expect(pane).toBeVisible();
    expect(await page.evaluate(() => window.location.hash)).toBe(`#thread=${world.threads.holding}`);
  });

  test('keeps the list beside the thread, with its close and no Back', async ({ page }) => {
    await page.goto(`${world.url}#thread=${world.threads.stopped}`);
    const pane = page.locator('section.ib-pane');
    await expect(pane.getByRole('heading', { name: /Stripe 409/ })).toBeVisible();
    await expect(page.locator('.ib-listcol.ib-narrow')).toBeVisible();
    expect((await page.locator('.ib-listcol').boundingBox())!.width).toBe(380);
    await expect(pane.getByRole('button', { name: 'Close the thread' })).toBeVisible();
    await expect(page.locator('[data-phone-back]')).toHaveCount(0);
    await expect(page.locator('.ib-mrow')).toHaveCount(0);
    await expect(page.locator('.ib-nrow').first()).toBeVisible();
  });
});
