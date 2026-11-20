/**
 * Marking up a thread's files on a phone (the 2026-11-19 phone audit), proved against the compiled binary under a
 * temp data dir, in Chromium as a touch phone (393 × 852 at 3×, and 320 px wide), with real fingers through the
 * DevTools protocol:
 * - Mark up on a panorama (2400 × 576) opens a drawing screen the picture fills (not an 85vw preview: the panorama was about 334 × 80 px), a
 *   third of the area tall from its left; one finger draws, two fingers pinch it closer, and a stroke made zoomed
 *   lands under the finger (the kept drawing has red where the finger went, in the picture's own pixels).
 * - "Added to your reply" sits above the full-screen Comment / Reply card, never over its tabs.
 * - The end of a Markdown file scrolls clear of the full-screen bar.
 * - A reply with a pin on an HTML page: the person's sent reply shows the comment and no selector, path or box; the
 *   text the agent gets keeps them.
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-phone-annotate.spec.ts`.
 * PNGs land in PLANNOTATOR_PHONE_ANNOTATE_SHOTS (default .local/proof/phone-annotate).
 */

import { chromium, expect, test, type Browser, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';
import { pinch, png } from './phone-touch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shots = resolve(process.env.PLANNOTATOR_PHONE_ANNOTATE_SHOTS ?? join(repo, '.local/proof/phone-annotate'));

const RFC = [
  '# RFC 0042: Content-addressed blob cache for CI',
  '',
  ...Array.from({ length: 12 }, (_, i) => [`## Part ${i + 1}`, '', `Part ${i + 1} of the proposal: runners keep a local LRU in front of a regional bucket, and uploads are deduplicated before they are sent.`, '']).flat(),
  '```',
  'job ──▶ local LRU ──miss──▶ regional bucket',
  '         ▲                        │',
  '         └──── write-through ◀────┘',
  '```',
  '',
  'The last line of the file.',
].join('\n');

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Canary</title>
<style>body{font:16px/1.5 system-ui;margin:24px;background:#0d1117;color:#e6edf3}.card{border:1px solid #30363d;border-radius:12px;padding:16px;margin:12px 0}.big{font:700 40px system-ui}.warn{color:#d29922}</style></head>
<body><h1>Canary rollout</h1><section class="card"><h2>p99 latency</h2><div class="big warn">412 ms</div><p>baseline 305 ms</p></section></body></html>`;

async function world() {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-inbox-phone-annotate-');
  const dataDir = join(root, 'data');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9', PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const project = scratchProject(join(root, 'src'), 'ingest');
  const dir = join(project, 'files');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'flame.png'), png(2400, 576, [60, 130, 240]));
  writeFileSync(join(dir, 'rfc.md'), RFC);
  writeFileSync(join(dir, 'canary.html'), PAGE);
  const agent = await SimAgent.connect({ binary, env, name: 'Claude', host: 'claude-code' });
  const send = async (subject: string, name: string) => {
    const sent = await agent.send({ project_path: project, subject, attachments: [`files/${name}`], body: `${subject}: have a look.` });
    return { thread: sent.thread_id as string, file: (sent.attachments as { id: string }[])[0]!.id };
  };
  const picture = await send('p99 regression in ingest-worker', 'flame.png');
  const doc = await send('RFC 0042', 'rfc.md');
  const html = await send('Canary dashboard', 'canary.html');
  return { root, url, agent, picture, doc, html };
}

async function phonePage(browser: Browser, width: number, scheme: 'light' | 'dark') {
  const context = await browser.newContext({ viewport: { width, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: scheme });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  return { context, page, errors };
}

async function shot(page: Page, name: string) {
  mkdirSync(shots, { recursive: true });
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(shots, `${name}.png`) });
}

/** One real finger along `points` (the DevTools protocol). */
async function stroke(page: Page, points: [number, number][]) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: points[0]![0], y: points[0]![1] }] });
  for (const [x, y] of points.slice(1)) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

const line = (x0: number, y0: number, x1: number, y1: number, n = 16): [number, number][] => Array.from({ length: n + 1 }, (_, i) => [x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n]);

for (const width of [393, 320])
  for (const scheme of ['light', 'dark'] as const)
    test(`a phone ${width} px, ${scheme}: Mark up on a panorama draws zoomed under the finger, and the toast keeps off the card's tabs`, async () => {
      const w = await world();
      const browser = await chromium.launch();
      try {
        const { page, errors } = await phonePage(browser, width, scheme);
        await page.goto(`${w.url}#thread=${w.picture.thread}&file=${w.picture.file}`);
        const img = page.locator('[data-image-zoom-stage] img');
        await expect(img).toBeVisible();
        await page.waitForTimeout(500);
        await shot(page, `pano-${width}-${scheme}`);

        await page.locator('[data-markup-open]').first().tap();
        const area = page.locator('[data-pn-image-annotator-area]');
        await expect(area).toBeVisible();
        const content = page.locator('[data-pn-image-annotator-content]');
        await page.waitForTimeout(400);
        const areaBox = (await area.boundingBox())!;
        const opened = (await content.boundingBox())!;
        // On a phone the viewer shows the panorama whole, so it opens a third of the area tall from its left: far taller than the old 80 px preview.
        expect(opened.height).toBeGreaterThan(areaBox.height / 3 - 4);
        expect(Math.abs(opened.x - areaBox.x)).toBeLessThan(2);
        await shot(page, `drawing-opened-${width}-${scheme}`);

        // Two fingers pinch it closer about the area's middle.
        const mid = { x: areaBox.x + areaBox.width / 2, y: areaBox.y + areaBox.height / 2 };
        await pinch(page, [{ x: mid.x - 20, y: mid.y }, { x: mid.x + 20, y: mid.y }], [{ x: mid.x - 50, y: mid.y }, { x: mid.x + 50, y: mid.y }]);
        await page.waitForTimeout(300);
        const zoomed = (await content.boundingBox())!;
        expect(zoomed.width).toBeGreaterThan(opened.width * 2);
        // One finger draws a short line through the middle: where it lands, in the picture's own pixels.
        const at = { x: (mid.x - zoomed.x) / zoomed.width, y: (mid.y - zoomed.y) / zoomed.height };
        await stroke(page, line(mid.x - 30, mid.y, mid.x + 30, mid.y));
        await shot(page, `drawing-zoomed-stroke-${width}-${scheme}`);
        await page.locator('[data-pn-image-annotator-toolbar] button[aria-label="Save"]').tap();

        // The kept drawing: red under where the finger went (the blue gradient picture has none of its own).
        const kept = page.locator('[data-markup-kept] img').first();
        await expect(kept).toBeVisible();
        const red = await kept.evaluate(async (el: HTMLImageElement, p) => {
          const pic = new Image();
          pic.src = el.src;
          await pic.decode();
          const c = document.createElement('canvas');
          c.width = pic.naturalWidth;
          c.height = pic.naturalHeight;
          const ctx = c.getContext('2d')!;
          ctx.drawImage(pic, 0, 0);
          // A 7 × 7 window on the finger's point: the line is about 2 picture pixels wide at this zoom, so one pixel
          // can be only partly covered (red blended into the blue); a stroke that missed is far outside the window.
          const x0 = Math.max(0, Math.floor(p.x * c.width) - 3);
          const y0 = Math.max(0, Math.floor(p.y * c.height) - 3);
          const data = ctx.getImageData(x0, y0, 7, 7).data;
          for (let i = 0; i < data.length; i += 4) if (data[i]! > 200 && data[i + 1]! < 110 && data[i + 2]! < 110) return true;
          return false;
        }, at);
        expect(red, 'the stroke lands under the finger at this zoom').toBe(true);

        // "Added to your reply" above the card, never over its tabs.
        const toast = page.locator('[data-inbox-toast]');
        await expect(toast).toBeVisible();
        const toastBox = (await toast.boundingBox())!;
        // The card's two tabs, Comment and Reply (radios in a radiogroup).
        const tabs = page.locator('[data-fcomp] [data-fcomp-mode]');
        await expect(tabs).toHaveCount(2);
        for (const tab of await tabs.all()) {
          const tabBox = (await tab.boundingBox())!;
          expect(toastBox.y + toastBox.height).toBeLessThanOrEqual(tabBox.y);
        }
        await shot(page, `drawing-added-${width}-${scheme}`);
        expect(errors).toEqual([]);
      } finally {
        await browser.close().catch(() => {});
        await w.agent.close().catch(() => {});
        await removeInboxScratch(w.root);
      }
    });

for (const width of [393, 320])
test(`a phone ${width} px: a Markdown file's tools clear its Contents button, and its end scrolls clear of the full-screen bar`, async () => {
  const w = await world();
  const browser = await chromium.launch();
  try {
    const { page } = await phonePage(browser, width, 'light');
    await page.goto(`${w.url}#thread=${w.doc.thread}&file=${w.doc.file}`);
    const scroller = page.locator('[data-attachment-pane] .ib-docscroll');
    await expect(scroller).toBeVisible();
    // The toolstrip ends before the Contents button starts (at 320 px the labelled strip ran under it).
    const strip = (await page.locator('[data-attachment-pane] .ib-toolstrip').boundingBox())!;
    const contents = (await page.locator('[data-attachment-pane] .ib-contents-open').boundingBox())!;
    expect(strip.x + strip.width).toBeLessThanOrEqual(contents.x);
    await scroller.evaluate((el) => (el.scrollTop = el.scrollHeight));
    await page.waitForTimeout(300);
    const last = page.locator('[data-attachment-pane] p', { hasText: 'The last line of the file.' });
    const lastBox = (await last.boundingBox())!;
    const barBox = (await page.locator('[data-full-view-bar]').boundingBox())!;
    expect(lastBox.y + lastBox.height).toBeLessThanOrEqual(barBox.y);
    await shot(page, `markdown-end-${width}`);
  } finally {
    await browser.close().catch(() => {});
    await w.agent.close().catch(() => {});
    await removeInboxScratch(w.root);
  }
});

test("a phone: a reply with a pin on an HTML page reads as the comment; the agent's text keeps the element's details", async () => {
  const w = await world();
  const browser = await chromium.launch();
  try {
    const { page } = await phonePage(browser, 393, 'light');
    await page.goto(`${w.url}#thread=${w.html.thread}&file=${w.html.file}`);
    await page.locator('[data-full-view-bar] button[aria-pressed]').first().tap();
    await page.frameLocator('[data-attachment-pane] iframe').locator('.big.warn').tap({ force: true });
    const field = page.locator('[data-attachment-pane] .ib-htmlcomment textarea').first();
    await field.fill('Make this amber band explicit.');
    await page.locator('[data-html-comment-save]').tap();
    await page.locator('[data-full-view-exit="back"]').tap();
    await page.getByRole('button', { name: /^Reply/ }).last().tap();
    await page.locator('textarea:visible').last().fill('One change on the p99 card.');
    await page.locator('[data-reply-send]:visible').last().tap();
    const sent = page.locator('[data-reply-feedback]').last();
    await expect(sent).toContainText('Make this amber band explicit.');
    await expect(sent).not.toContainText('div.big.warn');
    await expect(sent).not.toContainText('viewport');
    await shot(page, 'html-sent-393');
    // The stored text, what the agent reads, keeps the element's details.
    const stored = await page.evaluate(async (thread) => {
      const r = await fetch(`/api/inbox/threads/${thread}`);
      const d = await r.json();
      const messages = (d.messages ?? d.thread?.messages) as { author: { kind: string }; body: string }[];
      return messages.filter((m) => m.author.kind === 'person').map((m) => m.body).join('\n');
    }, w.html.thread);
    expect(stored).toContain('- **selector** `div.big.warn`');
    expect(stored).toContain('````html');
  } finally {
    await browser.close().catch(() => {});
    await w.agent.close().catch(() => {});
    await removeInboxScratch(w.root);
  }
});
