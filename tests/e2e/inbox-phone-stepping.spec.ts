import { chromium, devices, expect, test, webkit, type Browser, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';
import { finger, png } from './phone-touch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shots = resolve(process.env.PLANNOTATOR_PHONE_STEPPING_SHOTS ?? join(repo, '.local/proof/phone-stepping'));

const NOTES = [
  '# Checkout copy',
  '',
  'What every step of the new checkout says, in order.',
  '',
  ...Array.from({ length: 14 }, (_, i) => [`## Step ${i + 1}`, '', `Step ${i + 1} asks for one thing and says why. Keep the button label a verb, and keep the error next to the field it is about.`, '']).flat(),
].join('\n');

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Pay</title>
<style>body{font:16px/1.5 system-ui;margin:24px;color:#18181b;background:#fafaf7}button{width:100%;padding:14px;border:0;border-radius:10px;background:#2563eb;color:#fff;font:600 16px system-ui}.f{border:1px solid #d4d4d8;border-radius:8px;padding:12px;margin:10px 0;color:#71717a}@media (prefers-color-scheme:dark){body{background:#16171a;color:#ddd}}</style></head>
<body><h1>Pay for your order</h1><div class="f">Card number</div><div class="f">MM / YY</div><div class="f">CVC</div><button id="pay">Pay $48.00</button></body></html>`;

const CODE = [
  "import { schedule } from './queue';",
  '',
  '// The retry policy for failed refunds: exponential backoff, capped, with jitter so a burst of failures never retries in lockstep against the payment provider.',
  'export function nextDelay(attempt: number, base = 2_000, cap = 300_000, jitter = Math.random): number { return Math.min(cap, base * 2 ** attempt) * (0.5 + jitter() / 2); }',
  '',
  'export function retry(id: string, attempt: number) {',
  '  return schedule(id, nextDelay(attempt));',
  '}',
  '',
].join('\n');

const PDF = '%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n';

const NAMES = ['checkout.png', 'checkout-copy.md', 'pay.html', 'retry.ts', 'receipt.pdf'] as const;

async function world() {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-inbox-phone-stepping-');
  const dataDir = join(root, 'data');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const project = scratchProject(join(root, 'src'), 'shop');
  const dir = join(project, 'checkout');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'checkout.png'), png(780, 1600, [70, 130, 240]));
  writeFileSync(join(dir, 'checkout-copy.md'), NOTES);
  writeFileSync(join(dir, 'pay.html'), PAGE);
  writeFileSync(join(dir, 'retry.ts'), CODE);
  writeFileSync(join(dir, 'receipt.pdf'), PDF);
  for (let i = 1; i <= 8; i++) writeFileSync(join(dir, `note-${i}.txt`), `Note ${i} on the checkout.\n`);
  const agent = await SimAgent.connect({ binary, env, name: 'Claude', host: 'claude-code' });
  const sent = await agent.send({
    project_path: project,
    subject: 'Checkout: the screens and the copy',
    attachments: NAMES.map((n) => `checkout/${n}`),
    body: 'The new checkout, its copy, the pay page, the retry policy and the receipt.',
  });
  const ids = Object.fromEntries((sent.attachments as { id: string; name: string }[]).map((a) => [a.name, a.id])) as Record<string, string>;
  return { root, url, agent, project, thread: sent.thread_id as string, first: sent.message_id as string, ids };
}

const pane = (page: Page) => page.locator('[data-attachment-pane]');
const bar = (page: Page) => page.locator('[data-full-view-bar]');
const pill = (page: Page) => bar(page).locator('[data-full-view-position]');

async function shot(page: Page, name: string, scheme: 'light' | 'dark') {
  mkdirSync(shots, { recursive: true });
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(shots, `${name}-${scheme}.png`) });
}

for (const phone of [
  { name: 'iPhone 15 (WebKit)', device: devices['iPhone 15'], browserName: 'webkit' as const, schemes: ['light', 'dark'] as const },
  { name: 'Pixel 7 (Chromium)', device: devices['Pixel 7'], browserName: 'chromium' as const, schemes: ['light'] as const },
])
  for (const scheme of phone.schemes)
  test(`on a phone, ${phone.name}, ${scheme}: the pill opens every file in one tap, and a swipe steps where it can`, async () => {
    const { root, url, agent, project, thread, first, ids } = await world();
    const { defaultBrowserType: _ignored, ...device } = phone.device;
    const browser: Browser = phone.browserName === 'webkit' ? await webkit.launch({ args: [] }) : await chromium.launch();
    const tag = phone.browserName === 'webkit' ? 'iphone15' : 'pixel7';
    try {
      const context = await browser.newContext({ ...device, colorScheme: scheme });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(`${url}#thread=${thread}`);
      await page.locator(`[data-attachment-id="${ids['checkout.png']}"]`).first().click();
      await expect(pane(page)).toHaveAttribute('data-attachment-pane', ids['checkout.png']!);
      await expect(pane(page)).toHaveAttribute('data-full-view', '');

      await expect(pill(page)).toHaveAttribute('aria-label', '1/5: file 1 of 5, checkout.png. Show every file');
      await expect(pill(page)).toHaveText('1/5');
      const viewport = page.viewportSize()!;
      const box = (await pill(page).boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
      const barBox = (await bar(page).boundingBox())!;
      expect(barBox.x).toBeGreaterThanOrEqual(0);
      expect(barBox.x + barBox.width).toBeLessThanOrEqual(viewport.width);
      await shot(page, `${tag}-rest-image`, scheme);

      await pill(page).tap();
      const sheet = page.locator('[data-image-peek-sheet]');
      await expect(sheet).toBeVisible();
      await expect(pill(page)).toHaveAttribute('aria-expanded', 'true');
      await shot(page, `${tag}-sheet-from-pill`, scheme);
      await sheet.getByRole('gridcell', { name: /^checkout-copy\.md/ }).click();
      await expect(sheet).toBeHidden();
      await expect(pane(page)).toHaveAttribute('data-attachment-pane', ids['checkout-copy.md']!);
      await expect(pane(page).getByText('What every step of the new checkout says')).toBeVisible();
      await expect(pill(page)).toHaveAttribute('aria-label', '2/5: file 2 of 5, checkout-copy.md. Show every file');

      const touch = await finger(page, phone.browserName);
      const area = (await pane(page).locator('.ib-docarea').boundingBox())!;
      const mid = { x: area.x + area.width * 0.7, y: area.y + area.height * 0.45 };

      const scroller = pane(page).locator('.ib-docscroll').first();
      const before = await scroller.evaluate((el) => el.scrollTop);
      await touch.down(mid.x, mid.y, -8, -260);
      await touch.up();
      await page.waitForTimeout(400);
      await expect(pane(page)).toHaveAttribute('data-attachment-pane', ids['checkout-copy.md']!);
      await expect(page.locator('[data-file-swipe-card]')).toHaveCount(0);
      if (phone.browserName === 'chromium') expect(await scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(before);

      await touch.down(mid.x, mid.y, -area.width * 0.42, 6);
      const card = page.locator('[data-file-swipe-card="next"]');
      await expect(card).toBeVisible();
      await expect(card).toContainText('Next');
      await expect(card).toContainText('pay.html');
      expect(await pane(page).locator('.ib-docarea').evaluate((el) => (el as HTMLElement).style.transform)).toMatch(/^translateX\(-\d/);
      await shot(page, `${tag}-mid-swipe-markdown`, scheme);
      await touch.up();
      await expect(pane(page)).toHaveAttribute('data-attachment-pane', ids['pay.html']!);
      await expect(pill(page)).toHaveAttribute('aria-label', '3/5: file 3 of 5, pay.html. Show every file');
      await expect(page.locator('[data-step-live]')).toContainText('3 of 5, pay.html');

      const frame = page.frameLocator('.ib-htmlframe iframe');
      await expect(frame.locator('#pay')).toBeVisible();
      await page.waitForTimeout(300);
      await shot(page, `${tag}-html-page`, scheme);
      await expect(pane(page).locator('.ib-docarea')).toHaveAttribute('data-file-swipe', 'none');
      if (phone.browserName === 'chromium') {
        await touch.down(mid.x, mid.y, -area.width * 0.6, 0);
        await touch.up();
        await page.waitForTimeout(400);
        await expect(pane(page)).toHaveAttribute('data-attachment-pane', ids['pay.html']!);
      }

      await pill(page).tap();
      await expect(sheet).toBeVisible();
      const prevStep = sheet.locator('[data-peek-step-prev]');
      const nextStep = sheet.locator('[data-peek-step-next]');
      await expect(prevStep).toHaveAttribute('aria-label', 'Previous file: checkout-copy.md');
      await expect(nextStep).toHaveAttribute('aria-label', 'Next file: retry.ts');
      for (const button of [prevStep, nextStep]) {
        const b = (await button.boundingBox())!;
        expect(b.width).toBeGreaterThanOrEqual(44);
        expect(b.height).toBeGreaterThanOrEqual(44);
      }
      await shot(page, `${tag}-sheet-previous-next-html`, scheme);
      await nextStep.tap();
      await expect(sheet).toBeHidden();

      await expect(pane(page)).toHaveAttribute('data-attachment-pane', ids['retry.ts']!);
      await expect(pane(page).locator('[data-code-view]')).toBeVisible();
      await page.waitForTimeout(500);
      const code = (await pane(page).locator('[data-code-view]').boundingBox())!;
      const onCode = { x: code.x + code.width * 0.6, y: code.y + Math.min(120, code.height / 2) };
      await touch.down(onCode.x, onCode.y, -area.width * 0.6, 0);
      await touch.up();
      await page.waitForTimeout(500);
      await expect(pane(page)).toHaveAttribute('data-attachment-pane', ids['retry.ts']!);
      await pane(page).locator('[data-code-view]').evaluate((el) => {
        const walk = (n: Element | ShadowRoot) => {
          for (const child of n.querySelectorAll('*')) {
            child.scrollLeft = 0;
            if (child.shadowRoot) walk(child.shadowRoot);
          }
        };
        walk(el);
      });
      await touch.down(onCode.x - 120, onCode.y, area.width * 0.6, 0);
      await expect(page.locator('[data-file-swipe-card="previous"]')).toBeVisible();
      await touch.up();
      await expect(pane(page)).toHaveAttribute('data-attachment-pane', ids['pay.html']!);

      await pill(page).tap();
      await sheet.getByRole('gridcell', { name: /^receipt\.pdf/ }).click();
      await expect(pane(page)).toHaveAttribute('data-attachment-pane', ids['receipt.pdf']!);
      await expect(pane(page).locator('[data-download-card]')).toBeVisible();
      await touch.down(mid.x, mid.y, -area.width * 0.6, 0);
      await expect(page.locator('[data-file-swipe-card]')).toHaveCount(0);
      await touch.up();
      await expect(page.locator('[data-full-view-chip]')).toContainText('Last file in this thread');
      await expect(pane(page)).toHaveAttribute('data-attachment-pane', ids['receipt.pdf']!);
      await pill(page).tap();
      await expect(nextStep).toHaveAttribute('aria-disabled', 'true');
      await nextStep.tap({ force: true });
      await expect(sheet).toBeVisible();
      await expect(pane(page)).toHaveAttribute('data-attachment-pane', ids['receipt.pdf']!);
      await expect(page.locator('[data-step-live]')).toContainText('Last file in this thread');
      await page.locator('[data-peek-backdrop]').click({ position: { x: 20, y: 20 } });
      await expect(sheet).toBeHidden();

      await bar(page).locator('[data-full-view-hide]').tap();
      await expect(page.locator('[data-full-view-dock]')).toHaveAttribute('data-bar', 'tucked');
      await page.locator('[data-full-view-handle]').tap();
      await expect(page.locator('[data-full-view-dock]')).toHaveAttribute('data-bar', 'pinned');
      await expect(bar(page)).toBeVisible();

      expect(errors).toEqual([]);
      await context.close();

      const more = await agent.send({
        project_path: project,
        reply_to: first,
        subject: 'Checkout: notes',
        attachments: [...Array.from({ length: 8 }, (_, i) => `checkout/note-${i + 1}.txt`), 'checkout/pay.html'],
        body: 'Eight notes and the pay page again.',
      });
      expect(more.thread_id).toBe(thread);
      const page14 = (more.attachments as { id: string; name: string }[]).find((a) => a.name === 'pay.html')!.id;
      for (let i = 1; i <= 12; i++) {
        const saved = await fetch(`${url.replace(/\/$/, '')}/api/inbox/annotations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ attachment_id: page14, version: 'current', annotation: { id: `ann-pay-${i}`, type: 'COMMENT', text: `Note ${i}.`, originalText: 'Pay $48.00', blockId: 'block-1', startOffset: 0, endOffset: 0, createdA: i } }),
        });
        expect(saved.status).toBe(200);
      }
      const small = await browser.newContext({ ...device, colorScheme: scheme, viewport: { width: 320, height: 640 } });
      const narrowPage = await small.newPage();
      await narrowPage.goto(`${url}#thread=${thread}&file=${page14}`);
      await expect(pane(narrowPage)).toHaveAttribute('data-attachment-pane', page14);
      await expect(bar(narrowPage).locator('[data-full-view-pen]')).toBeVisible();
      await expect(pill(narrowPage)).toHaveText('14/14');
      await expect(bar(narrowPage).locator('[data-full-view-comments]')).toHaveText('12');
      await expect(pill(narrowPage)).toHaveAttribute('aria-label', '14/14: file 14 of 14, pay.html. Show every file');
      expect(await narrowPage.evaluate(() => window.innerWidth)).toBe(320);
      const narrow = (await bar(narrowPage).boundingBox())!;
      expect(narrow.x).toBeGreaterThanOrEqual(0);
      expect(narrow.x + narrow.width).toBeLessThanOrEqual(320);
      for (const control of await bar(narrowPage).locator('button').all()) expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await shot(narrowPage, `${tag}-320px-html`, scheme);
      await small.close();
    } finally {
      await browser.close().catch(() => {});
      await agent.close().catch(() => {});
      await removeInboxScratch(root);
    }
  });
