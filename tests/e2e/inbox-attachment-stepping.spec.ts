/**
 * Stepping through a thread's attachments without leaving the viewer (design
 * record "inbox-attachment-stepping", v2, not in this repo), proved in a real
 * browser against the compiled binary. Nothing is mocked: `plannotator inbox
 * --background` runs under a temp PLANNOTATOR_DATA_DIR and HOME with a
 * tailscale trap first on PATH; one agent sends two messages carrying five
 * files of five kinds (markdown, HTML, Mermaid, a PNG the browser takes, a
 * PDF) through `plannotator inbox mcp`; Chromium drives the window.
 *
 * Proves: the bar under the file says "1 of 5 · SCOPE.md" and the header
 * drops the name; `]` and the › button step in thread order across the two
 * messages, keeping full screen and replacing the route; › greys at the end,
 * keeps focus, and says "Last attachment in this thread"; the list opens
 * upward, grouped by message, and jumps; inside the HTML page a plain `]`
 * steps while armed (Annotate) and does nothing in Interact or in the page's
 * text field; a typed image comment raises the question row, Keep writing
 * returns to it and "Save it and go on" saves it and steps; one Back returns
 * to the thread.
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-attachment-stepping.spec.ts`.
 * PNGs, light and dark, land in PLANNOTATOR_E2E_SHOTS_DIR (default .local/proof/attachment-stepping).
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';

const repo = resolve(__dirname, '../..');
const builtBinary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shotsDir = resolve(process.env.PLANNOTATOR_E2E_SHOTS_DIR ?? join(repo, '.local/proof/attachment-stepping'));

const SCOPE = [
  '# Checkout redesign: scope',
  '',
  'storefront, drafted by Claude.',
  '',
  ...Array.from({ length: 14 }, (_, i) => [
    `## Part ${i + 1}`,
    '',
    `One page from cart to paid, on a phone first. Part ${i + 1} keeps the total, the refund line and the pay button on screen without scrolling at 390 px. Payment retries stop after five attempts, with backoff from 2 to 30 seconds.`,
    '',
  ]).flat(),
].join('\n');

const CHECKOUT = `<!doctype html><meta charset="utf-8"><title>Checkout</title><style>
body{margin:0;font:16px system-ui,sans-serif;background:#f5f4f0;color:#18181b}
header{display:flex;justify-content:space-between;padding:18px 28px;background:#fff;border-bottom:1px solid #e4e4e7}
main{max-width:640px;margin:24px auto;display:flex;flex-direction:column;gap:16px}
.card{background:#fff;border-radius:12px;padding:20px}
.row{display:flex;justify-content:space-between;margin:6px 0}
input{width:100%;box-sizing:border-box;padding:10px;border:1px solid #d4d4d8;border-radius:8px;font:inherit}
button{width:100%;padding:14px;border:0;border-radius:10px;background:#312e81;color:#fff;font:600 17px system-ui}
</style><header><b>Checkout</b><span>Step 2 of 3</span></header>
<main><div class="card"><div class="row"><span>Field notebook, A5 · Qty 2</span><b>$36.00</b></div><div class="row"><span>Shipping</span><span>$6.00</span></div><div class="row"><b>Total</b><b>$42.00</b></div></div>
<div class="card"><label for="promo">Promo code</label><input id="promo" placeholder="Type here: [ and ] stay in the field"></div>
<div class="card"><button id="pay">Pay now</button></div></main>`;

const STATES = `stateDiagram-v2
  [*] --> Pending
  Pending --> Attempt
  Attempt --> Succeeded: ok
  Attempt --> Failed: declined
  Failed --> Attempt: backoff 2-30 s
  Failed --> Exhausted: 5th try
`;

const PDF = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length 44 >> stream
BT /F1 18 Tf 24 70 Td (Refund policy) Tj ET
endstream endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
trailer << /Root 1 0 R >>
%%EOF
`;

interface World {
  root: string;
  dataDir: string;
  url: string;
  project: string;
  claude: SimAgent;
  context: BrowserContext;
  page: Page;
  errors: string[];
  threadId: string;
  ids: Record<string, string>;
}

let world: World;

async function shot(name: string): Promise<void> {
  const page = world.page;
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(350);
    await page.screenshot({ path: join(shotsDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

const pane = () => world.page.locator('[data-attachment-pane]');
const label = () => world.page.locator('[data-step-label]');
const nextButton = () => world.page.locator('[data-step-next]');
const htmlFrame = () => world.page.frameLocator('[data-attachment-pane] iframe').first();

/** "2 of 5, checkout-flow.html": the open file as the stepper names it. */
async function expectAt(position: number, name: string): Promise<void> {
  await expect(label()).toHaveAttribute('aria-label', `${position} of 5, ${name}. Show all attachments`);
  await expect(pane()).toHaveAttribute('data-attachment-pane', world.ids[name]!);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(builtBinary), `build the binary first: ${builtBinary}`).toBe(true);
  rmSync(shotsDir, { recursive: true, force: true });
  mkdirSync(shotsDir, { recursive: true });
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-stepping-')));
  const dataDir = join(root, 'data');
  const home = join(root, 'home');
  const trap = join(root, 'trap');
  mkdirSync(home);
  mkdirSync(trap);
  // Nothing here may reach the real tailscale CLI.
  writeFileSync(join(trap, 'tailscale'), '#!/bin/sh\necho "inbox-attachment-stepping: tailscale must not run" >&2\nexit 97\n');
  chmodSync(join(trap, 'tailscale'), 0o755);
  const env = { PATH: `${trap}:${process.env.PATH ?? ''}`, HOME: home, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9' };
  const started = spawnSync(builtBinary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();

  const project = scratchProject(join(root, 'src'), 'storefront');
  mkdirSync(join(project, 'docs'));
  mkdirSync(join(project, 'proto'));
  mkdirSync(join(project, 'shots'));
  writeFileSync(join(project, 'docs', 'SCOPE.md'), SCOPE);
  writeFileSync(join(project, 'proto', 'checkout-flow.html'), CHECKOUT);
  writeFileSync(join(project, 'docs', 'retry-states.mmd'), STATES);
  writeFileSync(join(project, 'docs', 'refund-policy.pdf'), PDF);
  // A real phone screenshot, taken by the browser.
  const maker = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  const makerPage = await maker.newPage();
  await makerPage.setContent(CHECKOUT);
  writeFileSync(join(project, 'shots', 'checkout-mobile.png'), await makerPage.screenshot());
  await maker.close();

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => {
    if (response.status() >= 400) errors.push(`HTTP ${response.status()} ${new URL(response.url()).pathname}`);
  });
  world = {
    root,
    dataDir,
    url,
    project,
    claude: await SimAgent.connect({ binary: builtBinary, env, name: 'Claude', host: 'claude-code' }),
    context,
    page,
    errors,
    threadId: '',
    ids: {},
  };
});

test.afterAll(async () => {
  if (!world) return;
  await world.claude.close().catch(() => {});
  await world.context.close();
  try {
    const registry = JSON.parse(readFileSync(join(world.dataDir, 'inbox', 'inbox.json'), 'utf8')) as { pid: number };
    process.kill(registry.pid, 'SIGTERM');
  } catch {
    // Already gone.
  }
  rmSync(world.root, { recursive: true, force: true });
});

test('one agent sends five files of five kinds across two messages of one thread', async () => {
  const first = await world.claude.send({
    project_path: world.project,
    subject: 'Checkout redesign: scope, flow and the refund policy',
    body: 'Here is the scope for the checkout redesign, the new flow as a page you can click through, and the retry states for the payment call.',
    attachments: ['docs/SCOPE.md', 'proto/checkout-flow.html', 'docs/retry-states.mmd'],
  });
  const second = await world.claude.send({
    project_path: world.project,
    body: 'The phone checkout at 390 px is below, and the refund policy PDF the "See policy" link opens.',
    attachments: ['shots/checkout-mobile.png', 'docs/refund-policy.pdf'],
  });
  expect(second.thread_id).toBe(first.thread_id);
  world.threadId = first.thread_id;
  for (const a of [...first.attachments, ...second.attachments] as { name: string; id: string }[]) world.ids[a.name] = a.id;
  expect(Object.keys(world.ids)).toEqual(['SCOPE.md', 'checkout-flow.html', 'retry-states.mmd', 'checkout-mobile.png', 'refund-policy.pdf']);
});

test('beside the thread: "1 of 5 · SCOPE.md" in the bar, the name gone from the header, the tile marked Open beside', async () => {
  const page = world.page;
  await page.goto(`${world.url}#thread=${world.threadId}`);
  await page.getByRole('button', { name: 'Open SCOPE.md' }).click();
  await expect(pane()).toBeVisible();
  await expect(pane()).not.toHaveClass(/ib-full/);
  await expectAt(1, 'SCOPE.md');
  await expect(page.locator('[data-step-name]')).toHaveText('SCOPE.md');
  await expect(pane().locator('[data-header-name]')).toHaveCount(0);
  await expect(pane()).toHaveAttribute('aria-label', 'SCOPE.md, attachment 1 of 5');
  await expect(page.locator('[data-step-prev]')).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByRole('navigation', { name: 'Attachments in this thread' })).toBeVisible();
  const tile = page.locator(`.ib-att-t[data-attachment-id="${world.ids['SCOPE.md']}"]`);
  await expect(tile).toHaveAttribute('aria-current', 'true');
  await expect(tile).toContainText('Open beside');
  // The bar is a row of the pane under the file, never over it.
  const geometry = await page.evaluate(() => {
    const body = document.querySelector('[data-attachment-pane] .ib-vbody')!.getBoundingClientRect();
    const bar = document.querySelector('[data-view-foot]')!.getBoundingClientRect();
    return { bodyBottom: body.bottom, barTop: bar.top };
  });
  expect(geometry.barTop).toBeGreaterThanOrEqual(geometry.bodyBottom - 0.5);
  await shot('01-side-markdown');
});

test('] and › step in thread order, keep full screen, and replace the route; inside the HTML page ] steps only while armed', async () => {
  const page = world.page;
  await pane().getByRole('button', { name: 'Full screen' }).click();
  await expect(pane()).toHaveClass(/ib-full/);
  await pane().focus();
  const historyBefore = await page.evaluate(() => history.length);
  await page.keyboard.press(']');
  await expectAt(2, 'checkout-flow.html');
  await expect(pane()).toHaveClass(/ib-full/);
  expect(page.url()).toContain(`file=${world.ids['checkout-flow.html']}`);
  expect(await page.evaluate(() => history.length)).toBe(historyBefore);
  await expect(htmlFrame().locator('#pay')).toHaveText('Pay now');
  await shot('02-full-html');

  // The page's text field keeps [ and ], armed or not.
  // (A click would pin the field while armed: focus it the way Tab would.)
  await htmlFrame().locator('#promo').evaluate((el) => (el as HTMLElement).focus());
  await page.keyboard.type('a]b[');
  await expect(htmlFrame().locator('#promo')).toHaveValue('a]b[');
  await expectAt(2, 'checkout-flow.html');

  // Armed (Annotate): a plain ] pressed in the page steps.
  await expect(pane().locator('[data-html-annotate-toggle]')).toHaveAttribute('aria-pressed', 'true');
  await htmlFrame().locator('header').evaluate((el) => {
    el.setAttribute('tabindex', '-1');
    (el as HTMLElement).focus();
  });
  await page.keyboard.press(']');
  await expectAt(3, 'retry-states.mmd');

  // Back to the page, then Interact: ] belongs to the page, nothing steps.
  await page.keyboard.press('[');
  await expectAt(2, 'checkout-flow.html');
  await expect(htmlFrame().locator('#pay')).toHaveText('Pay now');
  await pane().locator('[data-html-annotate-toggle]').click();
  await expect(pane().locator('[data-html-annotate-toggle]')).toHaveAttribute('aria-pressed', 'false');
  await htmlFrame().locator('header').evaluate((el) => {
    el.setAttribute('tabindex', '-1');
    (el as HTMLElement).focus();
  });
  await page.keyboard.press(']');
  await page.waitForTimeout(400);
  await expectAt(2, 'checkout-flow.html');

  // The › button steps on to the end, focus staying on it.
  await nextButton().click();
  await expectAt(3, 'retry-states.mmd');
  await nextButton().click();
  await expectAt(4, 'checkout-mobile.png');
  await nextButton().click();
  await expectAt(5, 'refund-policy.pdf');
  await expect(pane().locator('[data-download-card]')).toBeVisible();
  await expect(nextButton()).toHaveAttribute('aria-disabled', 'true');
  await expect(nextButton()).toHaveAttribute('aria-label', 'Next attachment');
  // aria-disabled, not disabled: it keeps focus, and Enter on it says where you are.
  await nextButton().press('Enter');
  await expect(page.locator('[data-step-end-note]')).toHaveText('Last attachment in this thread');
  await expectAt(5, 'refund-policy.pdf');
  await expect(nextButton()).toBeFocused();
  await page.keyboard.press(']');
  await expectAt(5, 'refund-policy.pdf');
  await expect(page.locator('[data-step-live]')).toContainText('Last attachment in this thread');
  await shot('03-end');
});

test('the list opens upward, grouped by message, and jumps; focus returns to the label', async () => {
  const page = world.page;
  await label().click();
  const list = page.getByRole('menu', { name: 'Attachments in this thread' });
  await expect(list).toBeVisible();
  await expect(list.getByRole('menuitemradio')).toHaveCount(5);
  await expect(list.locator('.ib-stepgroup')).toHaveCount(2);
  await expect(list.getByRole('menuitemradio', { checked: true })).toContainText('refund-policy.pdf');
  const placement = await page.evaluate(() => {
    const menu = document.querySelector('[data-step-list]')!.getBoundingClientRect();
    const bar = document.querySelector('[data-view-foot]')!.getBoundingClientRect();
    return { menuBottom: menu.bottom, barTop: bar.top };
  });
  expect(placement.menuBottom).toBeLessThanOrEqual(placement.barTop);
  await shot('04-list-open');
  await list.getByRole('menuitemradio', { name: /SCOPE\.md/ }).click();
  await expectAt(1, 'SCOPE.md');
  await expect(list).toBeHidden();
  await expect(label()).toBeFocused();
  await expect(page.locator('[data-step-live]')).toHaveText(/^1 of 5, SCOPE\.md, Markdown, from Claude's \d{1,2}:\d{2} [AP]M message$/);
});

test('a file read before opens where it was left: scroll is kept per file until the pane closes', async () => {
  const page = world.page;
  await expectAt(1, 'SCOPE.md');
  const scroller = pane().locator('.ib-docscroll');
  await scroller.evaluate((el) => {
    el.scrollTop = 600;
  });
  await pane().focus();
  await page.keyboard.press(']');
  await expectAt(2, 'checkout-flow.html');
  await page.keyboard.press('[');
  await expectAt(1, 'SCOPE.md');
  await expect.poll(() => pane().locator('.ib-docscroll').evaluate((el) => el.scrollTop)).toBeGreaterThan(560);
});

test('a typed image comment asks before stepping: Keep writing returns to it, Save it and go on saves it and steps', async () => {
  const page = world.page;
  await label().click();
  await page.getByRole('menuitemradio', { name: /checkout-mobile\.png/ }).click();
  await expectAt(4, 'checkout-mobile.png');
  const box = pane().getByRole('textbox', { name: 'Comment on checkout-mobile.png' });
  await box.fill('The Pay button sits under the fold on an iPhone SE. Move it up?');
  await nextButton().click();
  const guard = page.locator('[data-step-guard]');
  await expect(guard).toBeVisible();
  await expect(guard).toContainText('Your comment on checkout-mobile.png is not saved yet.');
  await expect(guard.getByRole('button', { name: 'Discard and go to refund-policy.pdf' })).toBeVisible();
  await expect(guard.getByRole('button', { name: 'Save it and go on' })).toBeFocused();
  await expectAt(4, 'checkout-mobile.png');
  // ] does nothing while the question row is open.
  await page.keyboard.press(']');
  await expectAt(4, 'checkout-mobile.png');
  await shot('05-guard');
  await guard.getByRole('button', { name: 'Keep writing' }).click();
  await expect(guard).toHaveCount(0);
  await expect(box).toBeFocused();
  await expect(box).toHaveValue('The Pay button sits under the fold on an iPhone SE. Move it up?');

  await nextButton().click();
  await page.locator('[data-step-guard]').getByRole('button', { name: 'Save it and go on' }).click();
  await expectAt(5, 'refund-policy.pdf');
  await expect
    .poll(async () => {
      const model = (await (await fetch(new URL(`/api/inbox/threads/${world.threadId}/attachments`, world.url))).json()) as {
        annotations: { attachment_id: string; annotation: { text?: string } }[];
      };
      return model.annotations.filter((a) => a.attachment_id === world.ids['checkout-mobile.png']).map((a) => a.annotation.text);
    })
    .toEqual(['The Pay button sits under the fold on an iPhone SE. Move it up?']);
  // Back on the image: its comment box is empty, not the last file's words.
  await page.locator('[data-step-prev]').click();
  await expectAt(4, 'checkout-mobile.png');
  await expect(pane().getByRole('textbox', { name: 'Comment on checkout-mobile.png' })).toHaveValue('');
});

test('one Back returns to the thread, however many files were stepped through', async () => {
  const page = world.page;
  await page.goBack();
  await expect(pane()).toHaveCount(0);
  expect(page.url()).not.toContain('file=');
  expect(page.url()).toContain(`thread=${world.threadId}`);
});

test('a phone: Previous / "1 of 5" / Next, the list across the width', async () => {
  const page = world.page;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${world.url}#thread=${world.threadId}`);
  await page.getByRole('button', { name: 'Open checkout-flow.html' }).click();
  await expect(pane()).toHaveClass(/ib-full/);
  await expect(page.getByRole('button', { name: 'Next attachment: retry-states.mmd' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Previous attachment: SCOPE.md' })).toBeVisible();
  await shot('06-phone-html');
  await label().click();
  await shot('07-phone-list');
  await page.keyboard.press('Escape');
  await expect(label()).toBeFocused();
  await page.setViewportSize({ width: 1440, height: 900 });
});

test('no page errors along the way', async () => {
  expect(world.errors).toEqual([]);
});
