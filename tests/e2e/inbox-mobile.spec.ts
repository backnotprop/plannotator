/**
 * The Inbox window on a phone (reached over the tailnet with `plannotator
 * inbox --tailscale`), proved in WebKit with the iPhone 15's descriptor and
 * in Chromium with the Pixel 7's, against the compiled binary under a temp
 * PLANNOTATOR_DATA_DIR. One screen at a time, like a mail app:
 *
 * - no screen scrolls sideways or draws past the window (the list, the
 *   project's list, a thread, an open file, the sheet, Settings);
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
import { NO_BROWSER } from '../helpers/no-browser';

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
  const env = { PATH: `${trap}:${process.env.PATH ?? ''}`, HOME: home, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9' };
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

/**
 * Controls whose hit area is shorter than a thumb (44 px): a tap 21 px above
 * or below the middle must still land on the control (or inside it). The
 * look may stay small; only where a tap lands is measured. Returns how many
 * were measured, so a test can tell "all fine" from "none found".
 */
async function shortHitAreas(page: Page, selector: string): Promise<{ measured: number; short: string[] }> {
  return page.locator(selector).evaluateAll((els) => {
    const short: string[] = [];
    let measured = 0;
    for (const el of els) {
      if (el.getBoundingClientRect().width === 0 || getComputedStyle(el).visibility === 'hidden') continue;
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
      const r = el.getBoundingClientRect();
      measured++;
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      for (const dy of [-21, 21]) {
        const hit = document.elementFromPoint(x, y + dy);
        if (!hit || !(hit === el || el.contains(hit))) {
          short.push(`${el.getAttribute('aria-label') ?? (el.textContent ?? '').trim().slice(0, 24)} (${Math.round(r.width)}x${Math.round(r.height)}): a tap ${dy} px from its middle lands on ${hit ? `${hit.tagName.toLowerCase()}.${[...hit.classList].slice(0, 2).join('.')}` : 'nothing'}`);
        }
      }
    }
    return { measured, short };
  });
}

const ROW_PARTS = '.ib-mk, .ib-agx, .ib-agplus, .ib-p, .ib-t, .ib-m2, .ib-pv, .ib-badge, .ib-c, .ib-att';

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
      expect(await overlaps(page, '.ib-fline.ib-is-open', '.ib-mk, .ib-fl-nm, .ib-fl-meta, .ib-fl-tm')).toEqual([]);
      const back = pane.getByRole('button', { name: 'Back to Inbox' });
      await expect(back).toBeVisible();
      await expect(back).toHaveText('Inbox');
      expect(await smallTargets(page, '[data-phone-back], .ib-phead .ib-iconbtn, .ib-pfoot .ib-btn')).toEqual([]);

      // A pick, then the reply box: 16 px text, above the foot's 44 px actions.
      await pane.getByText('Retry with the same idempotency key').click();
      await pane.locator('.ib-pfoot').getByRole('button', { name: 'Edit draft' }).click();
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
      await expect(pane.locator('button.ib-fline')).toHaveCount(0);
      expect(await sideways(page)).toEqual([]);
      expect(await overlaps(page, '.ib-fline.ib-is-open', '.ib-mk, .ib-fl-nm, .ib-fl-meta, .ib-fl-tm')).toEqual([]);
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
      // Full screen, the one mode (approval "inbox-one-fullscreen"): no header, one toolbar led by Back to the thread;
      // the comments wait behind its count.
      await expect(view.locator('.ib-vhead')).toHaveCount(0);
      await expect(view.getByRole('button', { name: 'Full screen' })).toHaveCount(0);
      await expect(view.locator('[data-full-view-bar]')).toBeVisible();
      await expect(view.locator('.ib-apanel')).toBeHidden();
      await shot(page, '7-file');
      expect(await sideways(page)).toEqual([]);
      expect(await overlaps(page, '[data-full-view-bar]', '.ib-fvb')).toEqual([]);
      expect(await smallTargets(page, '[data-full-view-bar] .ib-fvb')).toEqual([]);
      await view.locator('[data-full-view-comments]').click();
      const sheet = view.getByRole('region', { name: 'Comments' });
      await expect(sheet).toBeVisible();
      // A sheet up from the bottom edge, over the file.
      const sheetBox = (await sheet.boundingBox())!;
      const fileBox = (await view.locator(".ib-vbody").boundingBox())!;
      expect(Math.abs(sheetBox.y + sheetBox.height - (fileBox.y + fileBox.height))).toBeLessThan(2);
      expect(sheetBox.y).toBeGreaterThan(fileBox.y);
      expect(await smallTargets(page, '[data-full-view-foot] .ib-btn')).toEqual([]);
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
      // No stepper on a phone: the toolbar's pill opens every file of the thread, and a pick steps there (a replace, like a step).
      await view.locator('[data-full-view-bar] [data-full-view-position]').click();
      await page.getByRole('grid', { name: 'Files in this thread' }).getByRole('gridcell').nth(1).click();
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

    test("small controls keep their look and take a thumb: Skip it, the file's toolstrip, Global comment and Copy file", async () => {
      const page = await open();
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(`${world.url}#thread=${world.threads.stopped}`);
      const pane = page.locator('section.ib-pane');
      await expect(pane.getByRole('heading', { name: /Stripe 409/ })).toBeVisible();
      // One of the two questions picked: the reply box's chip offers Skip it for the other (approval "inbox-explicit-skip").
      await pane.getByText('Retry with the same idempotency key').click();
      await pane.locator('.ib-pfoot').getByRole('button', { name: 'Edit draft' }).click();
      const chip = pane.locator('.ib-skipchip').first();
      await expect(chip).toBeVisible();
      const skipButton = chip.getByRole('button', { name: /^Skip/ });
      // The look is unchanged (a 22 px button inside a 26 px chip); the tap lands on it 21 px above and below its middle.
      expect((await skipButton.boundingBox())!.height).toBeLessThan(30);
      const skip = await shortHitAreas(page, '.ib-skipchip button');
      expect(skip.measured).toBeGreaterThan(0);
      expect(skip.short).toEqual([]);
      await skipButton.click();
      await expect(chip.getByRole('button', { name: 'Keep open' })).toBeVisible();
      await pane.locator('.ib-pfoot').getByRole('button', { name: 'Cancel' }).click();

      // An open file: ui's toolstrip and the viewer's Global comment and Copy file.
      await page.goto(`${world.url}#thread=${world.threads.attach}`);
      await pane.locator('.ib-att-t', { hasText: 'retry-policy.md' }).click();
      const view = page.locator('section.ib-view');
      await expect(view.getByText('Failed refunds are retried with exponential backoff')).toBeVisible();
      const tools = await shortHitAreas(page, '.ib-phone .ib-toolstrip button, .ib-phone [data-sticky-actions] button');
      expect(tools.measured).toBeGreaterThanOrEqual(4);
      expect(tools.short).toEqual([]);
      // The keyboard's focus ring on a toolstrip button lies inside its clip (4 px out at the sides, 8 above and
      // below). Reached with Tab so the browser draws it; checked in Chromium (WebKit's Tab skips buttons by default).
      if (phone.browserName === 'chromium') {
        for (let i = 0; i < 60; i++) {
          if (await page.evaluate(() => !!document.activeElement?.closest('.ib-toolstrip'))) break;
          await page.keyboard.press('Tab');
        }
        const ring = await page.evaluate(() => {
          const el = document.activeElement!;
          const style = getComputedStyle(el);
          return { inStrip: !!el.closest('.ib-toolstrip'), visible: el.matches(':focus-visible'), style: style.outlineStyle, reach: parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset), clip: style.clipPath };
        });
        expect(ring.inStrip).toBe(true);
        expect(ring.visible).toBe(true);
        expect(ring.style).not.toBe('none');
        expect(ring.reach).toBeLessThanOrEqual(4);
        expect(ring.clip).toContain('-8px -4px');
        await shot(page, '13b-toolstrip-focus');
      }
      await shot(page, '13-file-targets');
    });

    test('the Mark read toast is one line with Undo, above the reply foot', async () => {
      const page = await open();
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(`${world.url}#thread=${world.threads.holding}`);
      const pane = page.locator('section.ib-pane');
      await expect(pane.getByRole('heading', { name: /Install page/ })).toBeVisible();
      const read = pane.locator('.ib-phead .ib-hbtn');
      await expect(read).toHaveAttribute('aria-pressed', 'false');
      await read.click();
      const toast = page.locator('[data-inbox-toast]');
      await expect(toast).toBeVisible();
      await expect(toast.getByRole('button', { name: 'Undo' })).toBeVisible();
      // A phone's short form: "Read", no Reply (the foot has it), no Z hint; Undo and the ×.
      await expect(toast.locator('.ib-tlead')).toHaveText('Read');
      await expect(toast.getByRole('button')).toHaveCount(2);
      await expect(toast.getByRole('button', { name: 'Dismiss' })).toBeVisible();
      await expect(toast.locator('kbd')).toHaveCount(0);
      await shot(page, '14-toast');
      const [toastBox, footBox, lines, undoTarget, closeTarget] = await Promise.all([
        toast.boundingBox(),
        pane.locator('.ib-pfoot').boundingBox(),
        // The text's line boxes: the lead and the detail sit on one baseline, so their tops lie within a
        // few pixels of each other (a wrapped second line would start a whole line lower).
        toast.locator('.ib-tsay').evaluate((el) => {
          const range = document.createRange();
          range.selectNodeContents(el);
          const tops = [...range.getClientRects()].map((r) => r.top);
          return Math.max(...tops) - Math.min(...tops) < 8 ? 1 : 2;
        }),
        // Undo's hit area: the button grown by its ::after box.
        toast.locator('[data-toast-undo]').evaluate((el) => {
          const box = el.getBoundingClientRect();
          const after = getComputedStyle(el, '::after');
          return Math.min(box.height - parseFloat(after.top) - parseFloat(after.bottom), box.width - parseFloat(after.left) - parseFloat(after.right));
        }),
        // The ×: 24 px drawn, a 44 px target.
        toast.locator('[data-toast-dismiss]').evaluate((el) => {
          const box = el.getBoundingClientRect();
          const after = getComputedStyle(el, '::after');
          return { drawn: Math.round(box.width), target: Math.min(box.height - parseFloat(after.top) - parseFloat(after.bottom), box.width - parseFloat(after.left) - parseFloat(after.right)) };
        }),
      ]);
      // One line (44 px, not the 171 px of three wrapped lines), clear of the foot.
      expect(toastBox!.height).toBeLessThanOrEqual(48);
      expect(lines).toBe(1);
      expect(undoTarget).toBeGreaterThanOrEqual(44);
      expect(closeTarget).toEqual({ drawn: 24, target: 44 });
      expect(toastBox!.y + toastBox!.height).toBeLessThanOrEqual(footBox!.y);
      // The thread's banner says the rest; Undo puts it back.
      await expect(pane.locator('[data-read-line]')).toBeVisible();
      await toast.getByRole('button', { name: 'Undo' }).click();
      await expect(read).toHaveAttribute('aria-pressed', 'false');

      // With the reply box open the foot is much taller: the toast still sits above it.
      await pane.locator('.ib-pfoot').getByRole('button', { name: /^(Reply|Edit draft)$/ }).click();
      await expect(pane.locator('.ib-pfoot textarea')).toBeVisible();
      await read.click();
      await expect(toast).toBeVisible();
      const [tallFoot, tallToast] = await Promise.all([pane.locator('.ib-pfoot').boundingBox(), toast.boundingBox()]);
      expect(tallFoot!.height).toBeGreaterThan(120);
      expect(tallToast!.y + tallToast!.height).toBeLessThanOrEqual(tallFoot!.y);
      await shot(page, '14b-toast-reply-open');
      await toast.getByRole('button', { name: 'Undo' }).click();
      await expect(read).toHaveAttribute('aria-pressed', 'false');

      // Undo and the × are 8 px apart and their 44 px targets meet in the middle: a tap 2 px past the Undo pill
      // is still Undo (the thread moves back); one 6 px past it is the × (the toast goes, the thread stays read).
      const tapPast = async (px: number) => {
        await read.click();
        await expect(read).toHaveAttribute('aria-pressed', 'true');
        await expect(toast).toBeVisible();
        const undoBox = (await toast.locator('[data-toast-undo]').boundingBox())!;
        await page.touchscreen.tap(undoBox.x + undoBox.width + px, undoBox.y + undoBox.height / 2);
      };
      await tapPast(2);
      await expect(read).toHaveAttribute('aria-pressed', 'false');
      await tapPast(6);
      await expect(toast).toHaveCount(0);
      await expect(read).toHaveAttribute('aria-pressed', 'true');
      await read.click();
      await expect(read).toHaveAttribute('aria-pressed', 'false');

      // Swipe it away with a finger (touch pointer events): a short drag springs back, one past 40% of its
      // width dismisses it, and its Undo goes with it (the thread stays read).
      const swipe = (distance: number) =>
        toast.evaluate(async (el, distance) => {
          const box = el.getBoundingClientRect();
          const y = box.top + box.height / 2;
          const x0 = box.left + 40;
          let t = performance.now();
          const fire = (type: string, x: number) => {
            t += 32;
            const event = new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 11, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y });
            Object.defineProperty(event, 'timeStamp', { value: t });
            el.querySelector('.ib-tsay')!.dispatchEvent(event);
          };
          fire('pointerdown', x0);
          const steps = 8;
          for (let i = 1; i <= steps; i++) {
            fire('pointermove', x0 + (distance * i) / steps);
            await new Promise((r) => requestAnimationFrame(r));
          }
          const mid = { translate: el.style.translate, opacity: el.style.opacity };
          fire('pointerup', x0 + distance);
          return mid;
        }, distance);
      await read.click();
      await expect(read).toHaveAttribute('aria-pressed', 'true');
      await expect(toast).toBeVisible();
      const short = await swipe(60);
      expect(short.translate).toBe('60px');
      await expect(toast).toBeVisible();
      await expect.poll(() => toast.evaluate((el) => el.style.translate)).toBe('');
      // (The short drag ran under reduced motion, which snaps back; this one slides out.)
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      const width = (await toast.boundingBox())!.width;
      await swipe(Math.round(width * 0.55));
      await expect(toast).toHaveCount(0);
      await expect(page.locator('[data-toast-ghost]')).toHaveCount(0);
      await expect(read).toHaveAttribute('aria-pressed', 'true');
      // Back for the tests after this one.
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await read.click();
      await expect(read).toHaveAttribute('aria-pressed', 'false');
    });

    test('Settings fits the window', async () => {
      const page = await open();
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(`${world.url}#settings`);
      await expect(page.locator('.ib-spage h1')).toHaveText('Settings');
      await shot(page, '9-settings');
      expect(await sideways(page)).toEqual([]);
    });
  });
}

for (const side of [
  { name: 'iPhone 15 landscape (WebKit)', device: devices['iPhone 15 landscape'], browserName: 'webkit' as const },
  { name: 'Pixel 7 landscape (Chromium)', device: devices['Pixel 7 landscape'], browserName: 'chromium' as const },
]) {
  test.describe(side.name, () => {
    const { defaultBrowserType: _browser, ...device } = side.device;
    test("an open file on its side: the toolbar's 44 px controls keep apart, and the comments sheet has the room", async () => {
      // (WebKit launches without the config's Chromium flags, which Linux WebKit exits on.)
      const browser = side.browserName === 'webkit' ? await webkit.launch({ args: [] }) : await chromium.launch();
      try {
        const page = await (await browser.newContext(device)).newPage();
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.goto(`${world.url}#thread=${world.threads.attach}`);
        await page.locator('section.ib-pane .ib-att-t', { hasText: 'retry-policy.md' }).click();
        const view = page.locator('section.ib-view');
        await expect(view.getByText('Failed refunds are retried with exponential backoff')).toBeVisible();
        // Full screen: no bar under the file, the file takes the window's height.
        await expect(view.locator('[data-view-foot]')).toHaveCount(0);
        expect(await sideways(page)).toEqual([]);
        expect(await overlaps(page, '[data-full-view-bar]', '.ib-fvb')).toEqual([]);
        expect(await smallTargets(page, '[data-full-view-bar] .ib-fvb')).toEqual([]);
        await view.locator('[data-full-view-comments]').click();
        const sheet = view.getByRole('region', { name: 'Comments' });
        await expect(sheet).toBeVisible();
        await page.screenshot({ path: join(proofDir, `${side.browserName}-15-landscape-comments.png`) });
        // The sheet's list (under its own title bar) shows well over the 55 px it had.
        const [sheetBox, headBox] = await Promise.all([sheet.boundingBox(), sheet.locator('.ib-sheet-h').boundingBox()]);
        expect(sheetBox!.height - headBox!.height).toBeGreaterThan(140);
      } finally {
        await browser.close();
      }
    });
  });
}

/**
 * Windows too narrow for the list beside the thread, but not phones: an iPad
 * in portrait (810 by 1080, touch) and a 900 px desktop window. The thread
 * covers the list (it would be squeezed to 200 to 290 px beside it), keeps
 * the desktop chrome, and leads with the way back to the list; an open file
 * covers the thread. Wide windows are the desktop layout as it was (the
 * desktop tests below, and a pixel comparison against main in the PR).
 */
for (const narrow of [
  { name: 'iPad portrait (WebKit)', browserName: 'webkit' as const, options: { ...devices['iPad (gen 7)'], viewport: { width: 810, height: 1080 } } },
  { name: '900 px desktop window (Chromium)', browserName: 'chromium' as const, options: { viewport: { width: 900, height: 800 } } },
]) {
  test.describe(narrow.name, () => {
    const { defaultBrowserType: _browser, ...options } = narrow.options as typeof narrow.options & { defaultBrowserType?: string };
    const tag = `${narrow.browserName}-narrow`;
    test('a thread covers the list with room to read, Back returns to the list, and a file covers the thread', async () => {
      const browser = narrow.browserName === 'webkit' ? await webkit.launch({ args: [] }) : await chromium.launch();
      try {
        const page = await (await browser.newContext(options)).newPage();
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.goto(world.url);
        // The desktop chrome: the docked sidebar and the wide rows (not a phone's).
        await expect(page.locator('.ib-lbody [data-thread-id]').first()).toBeVisible();
        await expect(page.locator('.ib-mrow')).toHaveCount(0);
        await expect(page.getByRole('complementary', { name: 'Inbox navigation' })).toBeVisible();
        await page.screenshot({ path: join(proofDir, `${tag}-1-list.png`) });

        await page.locator(`.ib-lbody [data-thread-id="${world.threads.stopped}"]`).click();
        const pane = page.locator('section.ib-pane');
        await expect(pane.getByRole('heading', { name: /Stripe 409/ })).toBeVisible();
        await expect(page.locator('.ib-listcol')).toBeHidden();
        const [paneBox, mainBox] = await Promise.all([pane.boundingBox(), page.locator('.ib-main').boundingBox()]);
        expect(paneBox!.width).toBeGreaterThanOrEqual(480);
        // The whole room the list had: .ib-main less its two 8 px gutters (the panes float on the ground).
        expect(Math.abs(paneBox!.width - (mainBox!.width - 16))).toBeLessThan(2);
        await page.screenshot({ path: join(proofDir, `${tag}-2-thread.png`) });
        expect(await sideways(page)).toEqual([]);
        expect(await overlaps(page, '.ib-fline.ib-is-open', '.ib-mk, .ib-fl-nm, .ib-fl-meta, .ib-fl-tm')).toEqual([]);
        expect(await overlaps(page, '.ib-phead', '.ib-pback, .ib-hbtn, .ib-phsubj[data-on], .ib-ptool')).toEqual([]);
        expect(await cardFits(page)).toEqual([]);
        // A pick: the foot gains "Draft · 1 pick" and the skip chip, and wraps rather than running past the pane.
        await pane.getByText('Retry with the same idempotency key').click();
        await expect(pane.locator('.ib-pfoot .ib-skipchip')).toBeVisible();
        const foot = await pane.locator('.ib-pfoot').evaluate((el) => {
          const box = el.getBoundingClientRect();
          return [...el.querySelectorAll('button, .ib-skipchip')].filter((b) => b.getBoundingClientRect().width > 0).map((b) => b.getBoundingClientRect().right - box.right).filter((past) => past > 1);
        });
        expect(foot).toEqual([]);
        // The desktop header, led by the way back (no phone header, no close beside it).
        const back = pane.getByRole('button', { name: 'Back to Inbox' });
        await expect(back).toBeVisible();
        await expect(pane.getByRole('button', { name: 'Close the thread' })).toHaveCount(0);
        await expect(page.locator('[data-phone-back]')).toHaveCount(0);
        await back.click();
        await expect(page.locator('.ib-listcol')).toBeVisible();
        await expect(pane).toHaveCount(0);
        // The thread covered the list, so ‹ Inbox was the browser's Back (an iPad's swipe back agrees with it):
        // Forward reopens the thread, and no entry was added.
        expect(await page.evaluate(() => window.location.hash)).toBe('');
        await page.goForward();
        await expect(pane.getByRole('heading', { name: /Stripe 409/ })).toBeVisible();

        // A file covers the thread, full screen, its toolbar led by Back to the thread.
        await page.evaluate((hash) => (window.location.hash = hash), `#thread=${world.threads.attach}`);
        await pane.locator('.ib-att-t', { hasText: 'retry-policy.md' }).click();
        const view = page.locator('section.ib-view');
        await expect(view.getByText('Failed refunds are retried with exponential backoff')).toBeVisible();
        await expect(pane).toBeHidden();
        const viewBox = (await view.boundingBox())!;
        expect(viewBox.x).toBeLessThan(1);
        expect(viewBox.width).toBeGreaterThan(page.viewportSize()!.width - 2);
        // Full screen is all the window can do here, so there is no Exit full screen: Back to the thread leads instead.
        await expect(view.getByRole('button', { name: /full screen/i })).toHaveCount(0);
        await expect(view.locator('[data-full-view-bar]')).toBeVisible();
        // The comments drawer docks beside the page (not a phone): the page narrows.
        await view.locator('[data-full-view-comments]').click();
        await expect(view.locator('.ib-apanel')).toBeVisible();
        const [drawerBox, docBox] = await Promise.all([view.locator('.ib-apanel').boundingBox(), view.locator('.ib-docarea').boundingBox()]);
        expect(docBox!.x + docBox!.width).toBeLessThanOrEqual(drawerBox!.x + 1);
        await page.screenshot({ path: join(proofDir, `${tag}-3-file.png`) });
        expect(await sideways(page)).toEqual([]);
        expect(await overlaps(page, '[data-full-view-bar]', '.ib-fvb')).toEqual([]);
        await view.locator('[data-full-view-comments]').click();
        await expect(view.locator('.ib-apanel')).toBeHidden();
        // Closing the file reopens the docked sidebar on a spring: the thread covers the list from the first
        // frame, never drawn squeezed beside it while the sidebar opens (motion on, so the spring runs).
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        type Sampled = { listFrames: boolean[]; listFrameAt: number[] };
        await page.evaluate(() => {
          const frames: boolean[] = [];
          const at: number[] = [];
          Object.assign(window, { listFrames: frames, listFrameAt: at });
          const start = performance.now();
          const tick = () => {
            const list = document.querySelector('.ib-listcol');
            frames.push(!!list && getComputedStyle(list).visibility !== 'hidden' && list.getBoundingClientRect().width > 0);
            at.push(performance.now() - start);
            if (at.at(-1)! < 900) requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
        await view.getByRole('button', { name: 'Back to the thread' }).click();
        await expect(view).toHaveCount(0);
        await expect(pane).toBeVisible();
        // The sampling covered the whole 900 ms window (a loaded runner draws fewer frames in it, not a shorter window).
        await expect.poll(() => page.evaluate(() => (window as unknown as Sampled).listFrameAt.at(-1) ?? 0), { timeout: 10_000 }).toBeGreaterThanOrEqual(900);
        const frames = await page.evaluate(() => (window as unknown as Sampled).listFrames);
        // Enough samples to land inside the ~540 ms spring itself.
        expect(frames.length).toBeGreaterThanOrEqual(5);
        expect(frames.filter(Boolean)).toEqual([]);
      } finally {
        await browser.close();
      }
    });
  });
}

test.describe('a desktop window', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test('long URLs, keys, tokens and IDs never scroll the thread sideways at desktop widths either', async ({ page }) => {
    // (Under about 1092 px the thread covers the list instead of being squeezed beside it: the narrow-window tests above.)
    for (const width of [1440, 1280, 1024, 900]) {
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

  test('a pick with a question left unanswered: the foot keeps Send and the skip chip whole at 1280 and 1440, by default and after Skip it (it ran past the pane in 0.28.16)', async ({ page }) => {
    for (const width of [1280, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${world.url}#thread=${world.threads.stopped}`);
      const pane = page.locator('section.ib-pane');
      await expect(pane.getByRole('heading', { name: /Stripe 409/ })).toBeVisible();
      // Beside the list, not stacked.
      await expect(page.locator('.ib-listcol.ib-narrow')).toBeVisible();
      await pane.getByText('Retry with the same idempotency key').click();
      const foot = pane.locator('.ib-pfoot');
      const chip = foot.locator('[data-skip-chip]');
      const send = foot.getByRole('button', { name: 'Send', exact: true });
      // The default (approval "inbox-explicit-skip"): the other question stays open; Skip it is offered.
      await expect(send).toBeVisible();
      await expect(chip).toHaveAttribute('data-skip-chip', 'keep');
      await expect(chip).toContainText('1 question stays open');
      const fits = async (toggle: ReturnType<typeof foot.getByRole>, label: string) => {
        await expect(toggle).toBeVisible();
        const [paneBox, footBox, sendBox, toggleBox, chipBox, notSent] = await Promise.all([
          pane.boundingBox(),
          foot.boundingBox(),
          send.boundingBox(),
          toggle.boundingBox(),
          foot.locator('.ib-skipchip').boundingBox(),
          foot.locator('[data-draft-foot]').boundingBox(),
        ]);
        const right = Math.min(paneBox!.x + paneBox!.width, width);
        for (const [name, box] of [['Send', sendBox], [label, toggleBox], ['the skip chip', chipBox]] as const) {
          expect(box!.x, `${name} at ${width}px`).toBeGreaterThanOrEqual(footBox!.x);
          expect(box!.x + box!.width, `${name} at ${width}px`).toBeLessThanOrEqual(right);
          expect(box!.y + box!.height, `${name} at ${width}px`).toBeLessThanOrEqual(footBox!.y + footBox!.height);
        }
        // "Draft · 1 pick" stays one line ("Not sent" was once squeezed to two).
        expect(notSent!.height, `at ${width}px`).toBeLessThan(24);
      };
      const skipIt = foot.getByRole('button', { name: 'Skip it' });
      await fits(skipIt, 'Skip it');
      // A tap on Skip it lands on it; the chip then says what the Send skips, and offers Keep open.
      await skipIt.click();
      await expect(chip).toHaveAttribute('data-skip-chip', 'skip');
      await expect(chip).toContainText('1 question will be skipped');
      const keep = foot.getByRole('button', { name: 'Keep open' });
      await fits(keep, 'Keep open');
      await page.screenshot({ path: join(proofDir, `desktop-${width}-foot.png`) });
      // Back to the default, for the next width.
      await keep.click();
      await expect(skipIt).toBeVisible();
    }
  });

  test('at 1000 px the thread covers the list: focus goes to ‹ Inbox and back to its row, and ‹ Inbox and Escape are the browser Back', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 800 });
    await page.goto(world.url);
    const row = page.locator(`.ib-lbody [data-thread-id="${world.threads.stopped}"]`);
    await row.click();
    const pane = page.locator('section.ib-pane');
    await expect(pane.getByRole('heading', { name: /Stripe 409/ })).toBeVisible();
    await expect(page.locator('.ib-listcol')).toBeHidden();
    // The row clicked is under the thread now: focus moves to the way back.
    const back = pane.locator('[data-stack-back]');
    await expect(back).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('.ib-listcol')).toBeVisible();
    await expect(pane).toHaveCount(0);
    // Back on the list, focus is on the row of the thread just closed.
    await expect(row).toBeFocused();
    // ‹ Inbox went back in history (no new entry): Forward reopens the thread.
    expect(await page.evaluate(() => window.location.hash)).toBe('');
    await page.goForward();
    await expect(pane.getByRole('heading', { name: /Stripe 409/ })).toBeVisible();
    // Escape is the same Back.
    await page.keyboard.press('Escape');
    await expect(page.locator('.ib-listcol')).toBeVisible();
    expect(await page.evaluate(() => window.location.hash)).toBe('');
    await page.goForward();
    await expect(pane.getByRole('heading', { name: /Stripe 409/ })).toBeVisible();
  });

  test('at 900 px, a window that shrinks into stacking with a list row focused never drops focus to the page', async ({ page }) => {
    const rowOf = (id: string) => page.locator(`.ib-lbody [data-thread-id="${id}"]`);
    const onPage = () => page.evaluate(() => document.activeElement === document.body);
    // The list alone: the row stays where it is, and keeps the focus.
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.goto(world.url);
    await rowOf(world.threads.holding).focus();
    await page.setViewportSize({ width: 900, height: 800 });
    await expect(rowOf(world.threads.holding)).toBeFocused();

    // A thread beside the list, focus on another row: shrinking puts the thread over the list and hides that
    // row, so focus goes to ‹ Inbox, and Back returns it to the row that had it.
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.evaluate((hash) => (window.location.hash = hash), `#thread=${world.threads.stopped}`);
    const pane = page.locator('section.ib-pane');
    await expect(pane.getByRole('heading', { name: /Stripe 409/ })).toBeVisible();
    await expect(page.locator('.ib-listcol')).toBeVisible();
    await rowOf(world.threads.holding).focus();
    await page.setViewportSize({ width: 900, height: 800 });
    await expect(page.locator('.ib-listcol')).toBeHidden();
    expect(await onPage()).toBe(false);
    await expect(pane.locator('[data-stack-back]')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('.ib-listcol')).toBeVisible();
    await expect(rowOf(world.threads.holding)).toBeFocused();

    // And back out: a stacked thread whose ‹ Inbox has focus, then a wider window, puts focus on its row beside it.
    await rowOf(world.threads.stopped).click();
    await expect(pane.locator('[data-stack-back]')).toBeFocused();
    await page.setViewportSize({ width: 1100, height: 800 });
    await expect(page.locator('.ib-listcol')).toBeVisible();
    expect(await onPage()).toBe(false);
    await expect(rowOf(world.threads.stopped)).toBeFocused();
  });

  test('an iPad on its side (1080 px) keeps the list beside a 444 px thread (the panes float in 8 px gutters)', async ({ page }) => {
    await page.setViewportSize({ width: 1080, height: 810 });
    await page.goto(`${world.url}#thread=${world.threads.stopped}`);
    const pane = page.locator('section.ib-pane');
    await expect(pane.getByRole('heading', { name: /Stripe 409/ })).toBeVisible();
    await expect(page.locator('.ib-listcol.ib-narrow')).toBeVisible();
    expect(Math.round((await pane.boundingBox())!.width)).toBe(1080 - 232 - 380 - 3 * 8);
    await expect(pane.getByRole('button', { name: 'Close the thread' })).toBeVisible();
    // Neither the thread nor a file stacks there.
    expect(await page.evaluate(() => document.querySelector('.pn-inbox')!.getAttribute('data-stack') ?? '')).not.toMatch(/thread|file/);
  });

  test('a window just wide enough keeps the list beside the thread, which keeps 480 px', async ({ page }) => {
    // 232 + 380 + 480 and the panes' three 8 px gutters.
    await page.setViewportSize({ width: 1116, height: 800 });
    await page.goto(`${world.url}#thread=${world.threads.stopped}`);
    const pane = page.locator('section.ib-pane');
    await expect(pane.getByRole('heading', { name: /Stripe 409/ })).toBeVisible();
    await expect(page.locator('.ib-listcol.ib-narrow')).toBeVisible();
    expect((await pane.boundingBox())!.width).toBeGreaterThanOrEqual(480);
    await expect(pane.getByRole('button', { name: 'Close the thread' })).toBeVisible();
    await expect(pane.getByRole('button', { name: 'Back to Inbox' })).toHaveCount(0);
    expect(await page.evaluate(() => document.querySelector('.pn-inbox')!.hasAttribute('data-stack'))).toBe(false);
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
