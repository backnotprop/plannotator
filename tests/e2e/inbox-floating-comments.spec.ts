/**
 * Full screen's comments float over the page and move with the other floating tools (the owner's call, 2026-11-05),
 * proved in Chromium against the compiled binary. `plannotator inbox --background` runs under a temp PLANNOTATOR_DATA_DIR and
 * HOME; one agent sends a pricing page and a checkout screenshot, the person comments and replies, the agent sends new
 * versions, and the person comments again (so the panel lists current and earlier comments).
 *
 * Proves, on a desktop:
 *  - the count opens the panel over the page's right side: the page keeps its whole width, the toolbar does not move;
 *  - » (the top bar's Hide tools) and the reply card's ⌄ (the bottom bar's) each take the panel away with the tools,
 *    and the corner control brings it back open;
 *  - the panel closes by its × and the count, and on its own when full screen ends or another file opens, but stays
 *    open (focus on the card) when a comment on another file is picked in it;
 *  - a comment picked in the panel whose mark is under it scrolls the page so the mark shows below the panel;
 *  - at 1280 px the reply card moves left so it never runs under the panel;
 *  - a 390 px phone keeps the bottom sheet.
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-floating-comments.spec.ts`.
 * PNGs land in PLANNOTATOR_E2E_SHOTS_DIR (default .local/proof/floating-comments); with PLANNOTATOR_E2E_VIDEO_DIR
 * set, the walk-through test also records a video there.
 */

import { devices, expect, test, type Browser, type BrowserContext, type Frame, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const builtBinary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shotsDir = resolve(process.env.PLANNOTATOR_E2E_SHOTS_DIR ?? join(repo, '.local/proof/floating-comments'));
const videoDir = process.env.PLANNOTATOR_E2E_VIDEO_DIR ? resolve(process.env.PLANNOTATOR_E2E_VIDEO_DIR) : null;

const QUOTES = [
  ['We closed the month in two days instead of nine.', 'A finance lead at a design studio'],
  ['Receipts match themselves now. I stopped chasing people.', 'An office manager at a clinic'],
  ['Our accountant reads the same numbers we do.', 'A founder of a coffee roaster'],
  ['The bank sync has not missed a night.', 'A controller at a logistics firm'],
];

/** The pricing page, first or second version. A band far down the page ends at its right edge. */
function pricing(v: 1 | 2): string {
  const head = v === 2 ? 'Your bank, synced. Your receipts, filed.' : 'Bookkeeping that runs itself';
  const sub = v === 2 ? 'Ledger pulls transactions from 11,000 banks every night and matches each receipt you forward.' : 'The finance platform for growing teams.';
  const plan = (name: string, month: number, feats: string[], hot = false) =>
    `<div class="plan${hot ? ' hot' : ''}"><h3>${name}</h3><div class="price"><b>$${month}</b> / seat / month</div><ul>${feats.map((f) => `<li>${f}</li>`).join('')}</ul><a class="cta${hot ? '' : ' ghost'}">${hot ? 'Start free trial' : `Choose ${name}`}</a></div>`;
  const faq = [
    ['Is my data secure?', 'Bank links are read only, and everything is encrypted at rest.'],
    ['Can I cancel any time?', 'Yes. Plans are monthly and you can stop whenever you like.'],
    ['Do you support multiple currencies?', 'Yes, 40 of them, converted at the day\'s rate.'],
    ['How long is the trial?', 'Fourteen days, with every feature of Team.'],
    ['Can my accountant join?', 'Yes, as a read-only member at no cost.'],
  ];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Ledger pricing</title><style>
*{box-sizing:border-box} body{margin:0;font:16px/1.5 system-ui,sans-serif;color:#1d2433;background:#f6f7fb}
nav{display:flex;align-items:center;gap:28px;padding:18px 48px;background:#fff;border-bottom:1px solid #e6e9f0} nav b{font-size:18px} nav span{color:#5b6477;font-size:14px}
header{text-align:center;padding:64px 24px 36px} h1{font-size:44px;line-height:1.1;margin:0 0 14px} header p{color:#5b6477;font-size:18px;margin:0 auto;max-width:560px}
.plans{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;max-width:980px;margin:0 auto;padding:0 24px}
.plan{background:#fff;border:1px solid #e3e7ef;border-radius:14px;padding:24px} .plan.hot{border-color:#2f6df6}
.plan h3{margin:0 0 6px;font-size:18px} .price{color:#5b6477} .price b{font-size:32px;color:#1d2433}
ul{padding:0;margin:16px 0 20px;list-style:none} li{padding:5px 0;border-top:1px solid #f0f2f6;font-size:14px}
.cta{display:block;text-align:center;border-radius:9px;padding:11px;font-weight:600;background:#2f6df6;color:#fff} .cta.ghost{background:#eef2fb;color:#2f6df6}
section.faq{max-width:760px;margin:56px auto 64px;padding:0 24px} details{background:#fff;border:1px solid #e3e7ef;border-radius:10px;padding:14px 16px;margin-bottom:10px} summary{font-weight:600}
footer,.band{display:flex;justify-content:space-between;align-items:center;padding:28px 48px;border-top:1px solid #e6e9f0;color:#5b6477;font-size:14px} .band{background:#fff;border-bottom:1px solid #e6e9f0}
.quotes{display:grid;gap:18px;max-width:760px;margin:48px auto;padding:0 24px} blockquote{margin:0;background:#fff;border:1px solid #e3e7ef;border-radius:12px;padding:22px 24px} blockquote p{margin:0 0 10px;font-size:18px} cite{color:#5b6477;font-style:normal;font-size:14px}
</style></head><body>
<nav><b>Ledger</b><span>Product</span><span>Pricing</span><span>Customers</span></nav>
<header><h1>${head}</h1><p>${sub}</p></header>
<div class="plans">${plan('Starter', 12, ['1 bank account', 'Receipt inbox', 'Monthly reports'])}${plan('Team', v === 2 ? 18 : 24, ['Unlimited bank accounts', 'Receipt matching', 'Roles and approvals', 'Priority support'], true)}${plan('Scale', 39, ['Everything in Team', 'Multi-entity', 'SSO and audit log'])}</div>
<section class="faq"><h2>Questions</h2>${faq.map(([q, a]) => `<details open><summary>${q}</summary><p>${a}</p></details>`).join('')}</section>
<div class="band"><span>Teams of 50 and more</span><span id="sales">Talk to sales about yearly plans</span></div>
<section class="quotes">${QUOTES.map(([q, who]) => `<blockquote><p>${q}</p><cite>${who}</cite></blockquote>`).join('')}</section>
<footer><span>Ledger, 2026</span><span>Privacy</span></footer>
</body></html>`;
}

/** The checkout screen, drawn once in the browser and saved as a PNG. */
const CHECKOUT = (v: 1 | 2) => `<!doctype html><meta charset="utf-8"><style>
body{margin:0;font:15px/1.45 system-ui,sans-serif;background:#eef1f6;color:#1d2433}
main{padding:36px 48px} h1{font-size:26px;margin:0 0 20px} .card{background:#fff;border-radius:12px;padding:22px;margin-bottom:16px;box-shadow:0 1px 2px rgba(0,0,0,.06)}
.row{display:flex;justify-content:space-between;padding:8px 0;border-top:1px solid #f0f2f6} .pay{display:inline-block;background:#2f6df6;color:#fff;border-radius:8px;padding:12px 20px;font-weight:600}
</style><main><h1>Checkout</h1><div class="card"><div class="row"><span>Team plan, 5 seats</span><b>$${v === 2 ? 90 : 120}</b></div><div class="row"><span>Tax</span><b>$9</b></div>${v === 2 ? '<div class="row"><span>Promo code</span><span>Add</span></div>' : ''}</div><span class="pay">Pay</span></main>`;

const comment = (id: string, quote: string, text: string) => ({ id, blockId: '', startOffset: 0, endOffset: 0, type: 'COMMENT', text, originalText: quote, createdA: Date.now() });
const imageComment = (id: string, name: string, text: string) => ({ id, blockId: 'image', startOffset: 0, endOffset: 0, type: 'COMMENT', text, originalText: name, createdA: Date.now() });

const SHORTS = [
  'Headline is too long for the phone.', 'Drop the word growing.', 'Team should be the default plan.', 'Tighten this line.', 'Can the yearly toggle sit above the cards?',
  'This button says Choose, the others say Start. Pick one.', 'Reduce the gap under the nav.', 'Show a real customer name here.', 'The feature lists do not line up across cards.',
  'Say what happens after the trial ends.', 'Move the SSO line to the top of its list.', 'The questions heading feels loud.', 'Answer in one sentence, not two.', 'Add the refund question.',
  'Is this the same blue as the app?', 'Say how many banks we support.', 'This reads like legal copy.', 'Link to the security page.', 'Good, keep it.', 'Same note as before on the button words.',
  'The nav links are hard to see.', 'Yearly price still needs the seat count.', 'Cut this list to three items.', 'Say who the Starter plan is for.', 'Make the trial length clear.',
  'Currency line can go in the questions.', 'Is the Scale price final?', 'Show the discount as a percentage too.', 'Footer links are missing.', 'Say where sales are based.',
];
const QUOTES_V1 = ['Bookkeeping that runs itself', '$24', 'Choose Starter', 'Is my data secure?', 'Receipt inbox'];

interface Thread {
  thread: string;
  files: Record<string, string>;
}
interface World {
  url: string;
  project: string;
  agent: SimAgent;
  two: Thread;
  many: Thread;
}
let world: World;

async function post(path: string, body: object): Promise<void> {
  const res = await fetch(new URL(path, world.url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  expect(res.status, path).toBe(200);
}
const save = (attachment: string, annotation: object) => post('/api/inbox/annotations', { attachment_id: attachment, version: 'current', annotation });
async function filesOf(thread: string, message: string): Promise<Record<string, string>> {
  const model = (await (await fetch(new URL(`/api/inbox/threads/${thread}/attachments`, world.url))).json()) as { attachments: { id: string; name: string; message_id: string }[] };
  return Object.fromEntries(model.attachments.filter((a) => a.message_id === message).map((a) => [a.name, a.id]));
}
async function reply(message: string, key: string, ids: string[]): Promise<void> {
  await post(`/api/inbox/messages/${message}/reply`, { idempotency_key: key, words: 'Notes below.', feedback: 'Notes below.', annotation_ids: ids });
}

async function drawCheckout(browser: Browser, v: 1 | 2): Promise<void> {
  const maker = await browser.newContext({ viewport: { width: 900, height: 560 }, deviceScaleFactor: 1 });
  const page = await maker.newPage();
  await page.setContent(CHECKOUT(v));
  writeFileSync(join(world.project, 'design', 'checkout.png'), await page.screenshot());
  await maker.close();
}

/** A page and a screenshot: three comments on each sent, new versions, two current comments on each. */
async function pricingThread(browser: Browser): Promise<Thread> {
  writeFileSync(join(world.project, 'site', 'pricing.html'), pricing(1));
  await drawCheckout(browser, 1);
  const files = ['site/pricing.html', 'design/checkout.png'];
  const first = await world.agent.send({ project_path: world.project, subject: 'Pricing page and checkout', thread: 'pricing', body: 'The first pass at the pricing page and the checkout screen.', attachments: files });
  const v1 = await filesOf(first.thread_id, first.message_id);
  await save(v1['pricing.html']!, comment('h1', 'Bookkeeping that runs itself', 'The headline promises too much. Say what it does.'));
  await save(v1['pricing.html']!, comment('h2', '$24', 'Show the yearly price under the monthly one.'));
  await save(v1['pricing.html']!, comment('h3', 'Is my data secure?', 'Move the security question to the top.'));
  await save(v1['checkout.png']!, imageComment('i1', 'checkout.png', '$24 a seat feels high next to the summary.'));
  await save(v1['checkout.png']!, imageComment('i2', 'checkout.png', 'Where does a promo code go?'));
  await save(v1['checkout.png']!, imageComment('i3', 'checkout.png', 'The total should say it includes tax.'));
  await reply(first.message_id, 'pricing-r1', ['h1', 'h2', 'h3', 'i1', 'i2', 'i3']);
  writeFileSync(join(world.project, 'site', 'pricing.html'), pricing(2));
  await drawCheckout(browser, 2);
  const second = await world.agent.send({ project_path: world.project, thread: 'pricing', reply_to: first.message_id, body: 'Updated both after your notes.', attachments: files });
  const v2 = await filesOf(first.thread_id, second.message_id);
  await save(v2['pricing.html']!, comment('c1', 'Your bank, synced. Your receipts, filed.', 'Much clearer. Keep this one.'));
  await save(v2['pricing.html']!, comment('c2', 'Talk to sales about yearly plans', 'Say who sales can help, and when.'));
  await save(v2['checkout.png']!, imageComment('c3', 'checkout.png', 'Good. The promo field can be smaller.'));
  await save(v2['checkout.png']!, imageComment('c4', 'checkout.png', 'Should Pay say the amount with tax?'));
  return { thread: first.thread_id, files: v2 };
}

/** One page with 30 earlier comments over two replies, and two current ones. */
async function longThread(): Promise<Thread> {
  writeFileSync(join(world.project, 'site', 'welcome.html'), pricing(1));
  const s1 = await world.agent.send({ project_path: world.project, subject: 'Welcome page', thread: 'welcome', body: 'First pass at the welcome page.', attachments: ['site/welcome.html'] });
  const a1 = (await filesOf(s1.thread_id, s1.message_id))['welcome.html']!;
  const r1 = SHORTS.slice(0, 19).map((_, i) => `w1-${i}`);
  for (const [i, id] of r1.entries()) await save(a1, comment(id, QUOTES_V1[i % QUOTES_V1.length]!, SHORTS[i]!));
  await reply(s1.message_id, 'welcome-r1', r1);
  const s2 = await world.agent.send({ project_path: world.project, thread: 'welcome', reply_to: s1.message_id, body: 'Second pass.', attachments: ['site/welcome.html'] });
  const a2 = (await filesOf(s1.thread_id, s2.message_id))['welcome.html']!;
  const r2 = SHORTS.slice(19).map((_, i) => `w2-${i}`);
  for (const [i, id] of r2.entries()) await save(a2, comment(id, QUOTES_V1[i % QUOTES_V1.length]!, SHORTS[19 + i]!));
  await reply(s2.message_id, 'welcome-r2', r2);
  writeFileSync(join(world.project, 'site', 'welcome.html'), pricing(2));
  const s3 = await world.agent.send({ project_path: world.project, thread: 'welcome', reply_to: s2.message_id, body: 'Third pass, with your notes in.', attachments: ['site/welcome.html'] });
  const a3 = (await filesOf(s1.thread_id, s3.message_id))['welcome.html']!;
  await save(a3, comment('w3-0', 'Your bank, synced. Your receipts, filed.', 'Much clearer. Keep this one.'));
  await save(a3, comment('w3-1', '$18', 'Now the Team price looks too close to Starter.'));
  return { thread: s1.thread_id, files: { 'welcome.html': a3 } };
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  expect(existsSync(builtBinary), `build the binary first: ${builtBinary}`).toBe(true);
  mkdirSync(shotsDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-floating-comments-');
  const dataDir = join(root, 'data');
  const home = join(root, 'home');
  const trap = join(root, 'trap');
  mkdirSync(home);
  mkdirSync(trap);
  // Nothing here may reach the real tailscale CLI.
  writeFileSync(join(trap, 'tailscale'), '#!/bin/sh\necho "inbox-floating-comments: tailscale must not run" >&2\nexit 97\n');
  chmodSync(join(trap, 'tailscale'), 0o755);
  const env = {
    PATH: `${trap}:${process.env.PATH ?? ''}`,
    HOME: home,
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    CODEX_HOME: join(root, 'codex'),
    OPENCODE_CONFIG_DIR: join(root, 'opencode'),
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
    PLANNOTATOR_FEEDBACK_URL: 'http://127.0.0.1:9/feedback',
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_BROWSER,
    NO_ANON_PING: '1',
    PLANNOTATOR_TEST_SANDBOX: '1',
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_INBOX_TAILSCALE: '0',
    PLANNOTATOR_INBOX_PHONES: '0',
    PLANNOTATOR_INBOX_NOTES: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
  };
  const started = spawnSync(builtBinary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  const url = started.stdout.trim();
  expect(new URL(url).port).not.toBe('59812');
  const project = scratchProject(join(root, 'src'), 'ledger-app');
  mkdirSync(join(project, 'site'));
  mkdirSync(join(project, 'design'));
  world = { url, project, agent: await SimAgent.connect({ binary: builtBinary, env, name: 'Claude Code', host: 'claude-code' }), two: { thread: '', files: {} }, many: { thread: '', files: {} } };
  world.two = await pricingThread(browser);
  world.many = await longThread();
});

test.afterAll(async () => {
  try {
    await world?.agent.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

const fullUrl = (t: Thread, name: string) => `${world.url}#thread=${t.thread}&file=${t.files[name]}&view=full`;
const pane = (page: Page) => page.locator('[data-attachment-pane]');
const panel = (page: Page) => pane(page).locator('.ib-apanel');
const count = (page: Page) => page.locator('[data-full-view-bar] [data-full-view-comments]');
const handle = (page: Page) => page.locator('[data-full-view-handle]');
const box = async (page: Page, selector: string) => page.locator(selector).first().boundingBox();
/** The panel's box once its slide-in or its way back from the corner has ended. */
async function panelAtRest(page: Page) {
  await expect(panel(page)).toBeVisible();
  await expect.poll(() => panel(page).evaluate((el) => el.getAnimations().filter((a) => a.playState === 'running').length)).toBe(0);
  return (await panel(page).boundingBox())!;
}

async function open(context: BrowserContext, t: Thread, name: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(fullUrl(t, name));
  await expect(pane(page)).toHaveAttribute('data-full-view', '');
  await expect(count(page)).toBeVisible();
  return page;
}

/** The page's frame (the HTML file, served by the Inbox at /api/inbox/pages/<id>). */
const isPageFrame = (f: Frame) => /\/api\/inbox\/pages\/[0-9a-f]+$/.test(f.url());
async function pageFrame(page: Page): Promise<Frame> {
  await expect.poll(() => page.frames().some(isPageFrame)).toBe(true);
  return page.frames().find(isPageFrame)!;
}

/** A comment's mark on the HTML page, in the window's coordinates. */
async function markBox(page: Page, id: string): Promise<{ left: number; top: number; right: number; bottom: number } | null> {
  const frame = await pageFrame(page);
  const at = (await pane(page).locator('iframe').first().boundingBox())!;
  const r = await frame.evaluate((id) => {
    const found: Element[] = [];
    const walk = (root: Document | ShadowRoot) => {
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) walk(el.shadowRoot);
        if (el.getAttribute('data-annotation-id') === id) found.push(el);
      }
    };
    walk(document);
    const rects = found.map((el) => el.getBoundingClientRect()).filter((b) => b.width > 0 && b.height > 0);
    if (!rects.length) return null;
    return { left: Math.min(...rects.map((b) => b.left)), top: Math.min(...rects.map((b) => b.top)), right: Math.max(...rects.map((b) => b.right)), bottom: Math.max(...rects.map((b) => b.bottom)) };
  }, id);
  return r && { left: r.left + at.x, top: r.top + at.y, right: r.right + at.x, bottom: r.bottom + at.y };
}

const overlaps = (a: { left: number; top: number; right: number; bottom: number }, b: { x: number; y: number; width: number; height: number }) =>
  a.left < b.x + b.width && a.right > b.x && a.top < b.y + b.height && a.bottom > b.y;

async function shot(page: Page, name: string, schemes: ('light' | 'dark')[] = ['light']): Promise<void> {
  for (const scheme of schemes) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(shotsDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

test('the panel floats over the page: the page keeps its width and the toolbar stays put; × and the count close it', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await open(context, world.two, 'pricing.html');
  const frameBefore = (await pane(page).locator('iframe').first().boundingBox())!;
  const barBefore = (await box(page, '[data-full-view-bar]'))!;
  await shot(page, 'html-1440-closed', ['light', 'dark']);

  await count(page).click();
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).locator('[data-earlier-row]')).toBeVisible();
  const frameAfter = (await pane(page).locator('iframe').first().boundingBox())!;
  expect(frameAfter.width).toBe(frameBefore.width);
  expect(frameAfter.width).toBe(1440);
  expect((await box(page, '[data-full-view-bar]'))!.x).toBe(barBefore.x);
  // At rest (it slides in 12 px): 12 px from the window's right edge.
  await expect.poll(async () => { const b = (await panel(page).boundingBox())!; return b.x + b.width; }).toBe(1440 - 12);
  const p = await panelAtRest(page);
  expect(p.y).toBeGreaterThanOrEqual(barBefore.y + barBefore.height);
  // Its foot is as it was.
  await expect(panel(page).locator('[data-full-view-foot]')).toContainText('are on other files');
  await expect(panel(page).getByRole('button', { name: 'Write the reply' })).toBeVisible();
  // The reply card is clear of it.
  const card = (await box(page, '[data-fcomp]'))!;
  expect(card.x + card.width).toBeLessThanOrEqual(p.x);
  // Open with the earlier comments showing too.
  const earlier = panel(page).locator('[data-earlier-row]');
  if ((await earlier.getAttribute('aria-expanded')) === 'false') await earlier.click();
  await expect(panel(page).locator('[data-earlier-comment]')).toHaveCount(3);
  await page.mouse.move(40, 650);
  await shot(page, 'html-1440-open', ['light', 'dark']);

  await panel(page).getByRole('button', { name: 'Close the comments' }).click();
  await expect(panel(page)).toBeHidden();
  await shot(page, 'html-1440-closed-by-x', ['light', 'dark']);
  await count(page).click();
  await expect(panel(page)).toBeVisible();
  await count(page).click();
  await expect(panel(page)).toBeHidden();
  await context.close();
});

test('putting the top bar or the reply card away takes the panel with them; the corner control brings it back open', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await open(context, world.two, 'pricing.html');
  await count(page).click();
  await expect(panel(page)).toBeVisible();
  // The top bar's » Hide tools.
  await page.locator('[data-full-view-hide]').click();
  await expect(pane(page)).toHaveAttribute('data-tools', 'tucked');
  await expect(panel(page)).toBeHidden();
  await page.mouse.move(40, 650);
  await shot(page, 'html-1440-top-bar-away', ['light', 'dark']);
  await handle(page).click();
  await expect(panel(page)).toBeVisible();
  await expect(page.locator('[data-full-view-bar]')).toBeVisible();
  // The bottom bar's ⌄ (the reply card's minimize).
  await page.locator('[data-fcomp] [data-fcomp-minimize]').click();
  await expect(pane(page)).toHaveAttribute('data-tools', 'tucked');
  await expect(panel(page)).toBeHidden();
  await expect(page.locator('[data-full-view-bar]')).toBeHidden();
  await page.mouse.move(40, 650);
  await shot(page, 'html-1440-bottom-bar-away', ['light', 'dark']);
  await handle(page).click();
  await expect(panel(page)).toBeVisible();
  await context.close();
});

test('the panel closes on its own when full screen ends or another file opens', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await open(context, world.two, 'pricing.html');
  await count(page).click();
  await expect(panel(page)).toBeVisible();
  // Another file of the thread (`]`, from the window): full screen stays, the panel goes.
  await pane(page).focus();
  await page.keyboard.press(']');
  await expect(pane(page)).toHaveAttribute('data-attachment-pane', world.two.files['checkout.png']!);
  await expect(pane(page)).toHaveAttribute('data-full-view', '');
  await expect(panel(page)).toBeHidden();
  // Full screen ends (Side by side), and starts again: the panel stays closed.
  await count(page).click();
  await expect(panel(page)).toBeVisible();
  await page.locator('[data-full-view-exit="exit"]').click();
  await expect(pane(page)).not.toHaveAttribute('data-full-view', '');
  await pane(page).locator('.ib-vhead [data-full-screen-toggle]').click();
  await expect(pane(page)).toHaveAttribute('data-full-view', '');
  await expect(panel(page)).toBeHidden();
  await context.close();
});

test('a comment on another file picked in the panel opens that file with the panel still open, focus on its card', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await open(context, world.two, 'pricing.html');
  await count(page).click();
  await panelAtRest(page);
  // The panel lists every file's comments: c3 is on the checkout screen.
  await panel(page).locator('[data-annotation-id="c3"]').first().click();
  await expect(pane(page)).toHaveAttribute('data-attachment-pane', world.two.files['checkout.png']!);
  await expect(pane(page)).toHaveAttribute('data-full-view', '');
  await expect(panel(page)).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest('.ib-apanel [data-annotation-id]')?.getAttribute('data-annotation-id') ?? null)).toBe('c3');
  await context.close();
});

test('a picked comment whose mark is under the panel scrolls the page so the mark shows below it', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await open(context, world.two, 'pricing.html');
  await count(page).click();
  const p = await panelAtRest(page);
  // Bring the mark under the panel first, as the page's own scroll would (marks are drawn only on screen).
  const frame = await pageFrame(page);
  await expect.poll(() => frame.evaluate(() => !!document.getElementById('sales'))).toBe(true);
  await frame.evaluate(() => document.getElementById('sales')!.scrollIntoView({ block: 'center' }));
  await expect.poll(async () => { const mark = await markBox(page, 'c2'); return mark !== null && overlaps(mark, p); }).toBe(true);
  await panel(page).locator('[data-annotation-id="c2"]').first().click();
  await expect.poll(async () => {
    const mark = await markBox(page, 'c2');
    return mark !== null && !overlaps(mark, (await panel(page).boundingBox())!) && mark.bottom <= 900;
  }).toBe(true);
  await context.close();
});

test('an image at 1440, and HTML at 1280 with the reply card clear of the panel', async ({ browser }) => {
  const wide = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const image = await open(wide, world.two, 'checkout.png');
  await count(image).click();
  await expect(panel(image)).toBeVisible();
  const imgCard = (await box(image, '[data-fcomp]'))!;
  expect(imgCard.x + imgCard.width).toBeLessThanOrEqual((await panelAtRest(image)).x);
  await image.mouse.move(40, 650);
  await shot(image, 'image-1440-open');
  await wide.close();

  const narrow = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await open(narrow, world.two, 'pricing.html');
  const centred = (await box(page, '[data-fcomp]'))!;
  await count(page).click();
  await expect(panel(page)).toBeVisible();
  const p = await panelAtRest(page);
  const card = (await box(page, '[data-fcomp]'))!;
  // Centred it would come within 12 px of the panel (round 3's card is 600 px, #2846): it moves left, keeping its width.
  expect(centred.x + centred.width).toBeGreaterThan(p.x - 12);
  expect(card.x).toBeLessThan(centred.x);
  expect(card.x + card.width).toBeLessThanOrEqual(p.x - 12);
  expect(card.width).toBe(centred.width);
  await page.mouse.move(40, 650);
  await shot(page, 'html-1280-open');
  await narrow.close();
});

test('a long list (30 earlier comments) scrolls inside the panel, which stops at the window foot', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await open(context, world.many, 'welcome.html');
  await count(page).click();
  await expect(panel(page)).toBeVisible();
  const row = panel(page).locator('[data-earlier-row]');
  if ((await row.getAttribute('aria-expanded')) === 'false') await row.click();
  await expect(panel(page).locator('[data-earlier-comment]')).toHaveCount(30);
  const p = await panelAtRest(page);
  expect(p.y + p.height).toBeLessThanOrEqual(900 - 12);
  await page.mouse.move(40, 650);
  await shot(page, 'html-1440-long-list');
  await context.close();
});

test('a phone keeps the bottom sheet', async ({ browser }) => {
  const { defaultBrowserType: _, ...phone } = devices['iPhone 13'];
  const context = await browser.newContext({ ...phone, viewport: { width: 390, height: 844 } });
  const page = await open(context, world.two, 'pricing.html');
  await count(page).click();
  await expect(pane(page)).toHaveClass(/ib-panel-open/);
  await expect(pane(page)).not.toHaveClass(/ib-drawer/);
  const p = await panelAtRest(page);
  expect(p.x).toBe(0);
  expect(p.width).toBe(390);
  await shot(page, 'phone-390-sheet');
  await context.close();
});

test('the walk: open, put the top bar away and back, pick a covered comment, leave full screen', async ({ browser }) => {
  test.skip(!videoDir, 'set PLANNOTATOR_E2E_VIDEO_DIR to record it');
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: videoDir!, size: { width: 1440, height: 900 } } });
  const page = await open(context, world.two, 'pricing.html');
  const frame = await pageFrame(page);
  await expect.poll(() => frame.evaluate(() => !!document.getElementById('sales'))).toBe(true);
  await frame.evaluate(() => document.getElementById('sales')!.scrollIntoView({ block: 'center' }));
  await page.mouse.move(700, 450);
  await page.waitForTimeout(900);
  await count(page).hover();
  await page.waitForTimeout(300);
  await count(page).click();
  await page.waitForTimeout(1200);
  await page.locator('[data-full-view-hide]').hover();
  await page.waitForTimeout(300);
  await page.locator('[data-full-view-hide]').click();
  await page.waitForTimeout(1200);
  await handle(page).hover();
  await page.waitForTimeout(300);
  await handle(page).click();
  await page.waitForTimeout(1200);
  const card = panel(page).locator('[data-annotation-id="c2"]').first();
  await card.hover();
  await page.waitForTimeout(500);
  await card.click();
  await page.waitForTimeout(1600);
  await page.locator('[data-full-view-close]').hover();
  await page.waitForTimeout(400);
  await page.locator('[data-full-view-close]').click();
  await page.waitForTimeout(1500);
  await context.close();
});
