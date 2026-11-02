/**
 * Links inside an attached HTML page, proved in a real browser against the
 * compiled binary. Nothing is mocked: `plannotator inbox --background` runs
 * under a temp PLANNOTATOR_DATA_DIR and HOME, an agent sends through
 * `plannotator inbox mcp` (scripts/inbox-sim.ts) a message attaching
 * `site/SHEET.html` and one frame of the page, and Chromium opens the page.
 * Armed (Annotate, the default; no mode switch) a plain click on each link of
 * the page follows it, and a Cmd/Ctrl-click pins it for a comment: a sibling page that is
 * not attached opens read-only over the page with Back and Open in new tab,
 * and its own links follow; Back returns to the page; the attached frame
 * opens in the pane and the browser's Back returns to the page; an image
 * beside it that is not attached opens in the lightbox, loaded; a PDF says
 * why it does not open. Each linked page is a history entry: the browser's
 * Back, Escape and the band's Back step back one page. Beside the thread
 * and on a phone the same. On a phone (WebKit iPhone 15 and Chromium Pixel
 * 7) a tap on a link follows it and a press-and-hold opens a comment on it,
 * whose release follows nothing. Shift-click joins more elements, a link
 * among them, to one comment on the page, as in annotate.
 *
 * Screenshots (light and dark, desktop and phone) go to
 * PLANNOTATOR_HTML_LINKS_SHOTS when it is set.
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 */

import { chromium, devices, expect, test, webkit, type Browser, type Locator, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shots = process.env.PLANNOTATOR_HTML_LINKS_SHOTS ?? '';

/** A small PNG drawn here (a gradient, `width` × `height`), so the lightbox has something to show and to measure. */
function png(width: number, height: number, hue: [number, number, number]): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Buffer) => {
    let c = 0xffffffff;
    for (const b of bytes) c = table[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = y * (width * 3 + 1) + 1 + x * 3;
      const t = (x + y) / (width + height);
      rows[at] = Math.round(hue[0] * (0.4 + 0.6 * t));
      rows[at + 1] = Math.round(hue[1] * (0.4 + 0.6 * t));
      rows[at + 2] = Math.round(hue[2] * (0.4 + 0.6 * t));
    }
  }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

const STYLE =
  '<style>body{font:15px/1.5 system-ui;margin:32px;color:#222;background:#fafaf7}h1{font-size:22px}ul{padding-left:18px}li{margin:6px 0}a{color:#2563eb}@media (prefers-color-scheme:dark){body{background:#16171a;color:#ddd}a{color:#7aa2ff}}</style>';

const SHEET = `<!doctype html><html><head><meta charset="utf-8"><title>Contact sheet</title>${STYLE}</head><body>
<h1>Guided narrative: contact sheet</h1>
<p>Three directions. Each has a full page and frames.</p>
<ul>
<li><a href="A-story.html">A: Story page</a></li>
<li><a href="B-cards.html#pr1">B: Cards, at PR 1</a></li>
<li><a href="frames/A-1440-light.png">A frame, attached</a></li>
<li><a href="frames/B-1440-light.png">B frame, not attached</a></li>
<li><a href="brief.pdf">The brief (PDF)</a></li>
</ul>
<p><a href="#" class="btn">Save draft</a></p>
<ul>
</ul>
</body></html>`;

const PAGE = (title: string, extra = '') =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${STYLE}</head><body><h1>${title}</h1>${extra}<p style="margin-top:900px" id="pr1">PR 1 section</p><p><a href="SHEET.html">Back to the sheet</a></p></body></html>`;

async function shot(page: Page, name: string) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(shots, `${name}.png`) });
}

async function world() {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-inbox-htmllinks-e2e-');
  const dataDir = join(root, 'data');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const project = scratchProject(join(root, 'src'), 'research');
  const site = join(project, 'guided-narrative');
  mkdirSync(join(site, 'frames'), { recursive: true });
  writeFileSync(join(site, 'SHEET.html'), SHEET);
  writeFileSync(join(site, 'A-story.html'), PAGE('A: Story page', '<p><a href="B-cards.html">On to B</a></p>'));
  writeFileSync(join(site, 'B-cards.html'), PAGE('B: Cards'));
  writeFileSync(join(site, 'frames', 'A-1440-light.png'), png(480, 300, [80, 140, 255]));
  writeFileSync(join(site, 'frames', 'B-1440-light.png'), png(480, 300, [255, 150, 70]));
  writeFileSync(join(site, 'brief.pdf'), '%PDF-1.4\n');
  // A page whose own script clicks its link: that never follows it.
  writeFileSync(
    join(site, 'autoclick.html'),
    `<!doctype html><html><head><meta charset="utf-8"><title>Auto</title>${STYLE}</head><body><h1>Auto-click</h1><a id="go" href="B-cards.html">B</a><script>setTimeout(() => document.getElementById('go').click(), 300);</script></body></html>`,
  );
  const agent = await SimAgent.connect({ binary, env, name: 'Claude', host: 'claude-code' });
  const sent = await agent.send({
    project_path: project,
    subject: 'Guided narrative: three directions',
    attachments: ['guided-narrative/SHEET.html', 'guided-narrative/frames/A-1440-light.png', 'guided-narrative/autoclick.html'],
    body: 'The contact sheet links every page and frame.',
  });
  const ids = Object.fromEntries((sent.attachments as { id: string; name: string }[]).map((a) => [a.name, a.id]));
  return { root, url, agent, thread: sent.thread_id as string, ids };
}

/** The attached page opened from its tile (full screen), armed (Annotate, the default): a plain click on a link follows it. */
async function openSheet(page: Page, url: string, thread: string, sheet: string) {
  // From its tile, as the person opens it: HTML opens full screen.
  await page.goto(`${url}#thread=${thread}`);
  await page.locator(`button[data-attachment-id="${sheet}"]`).first().click();
  const pane = page.locator(`[data-attachment-pane="${sheet}"]`);
  await expect(pane).toBeVisible();
  await expect(pane).toHaveAttribute('data-full-view', '');
  const frame = page.frameLocator('.ib-htmlframe iframe');
  await expect(frame.locator('h1')).toHaveText('Guided narrative: contact sheet');
  // On a phone the pen starts off (approval "inbox-html-attachments-phone"): these tests are about Annotate, so it goes on.
  const interact = page.locator('[data-full-view-pen][aria-pressed="false"]');
  if (await interact.isVisible()) await interact.click();
  // No mode switch: the page stays in Annotate, where a plain click on a link follows it.
  await expect(page.getByRole('button', { name: 'Annotate mode' })).toBeVisible();
  return { pane, frame };
}

/**
 * A click with Shift held down first, as a person makes it: the composer over
 * the page lets the pointer through while Shift is held, once the pointer is
 * over the page (waited for here, so the press lands on the page, not the composer).
 */
async function shiftClick(page: Page, target: Locator) {
  const box = (await target.boundingBox())!;
  const x = box.x + Math.min(10, box.width / 2);
  const y = box.y + box.height / 2;
  await page.keyboard.down('Shift');
  await page.mouse.move(x, y);
  await expect.poll(() => page.evaluate(([px, py]) => document.elementFromPoint(px!, py!)?.tagName, [x, y])).toBe('IFRAME');
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.up('Shift');
}

test('shift-click joins more elements to one comment on an attached page, a link among them', async ({ browser }) => {
  const { root, url, agent, thread, ids } = await world();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const page = await context.newPage();
    const { frame } = await openSheet(page, url, thread, ids['SHEET.html']!);
    // A plain click pins the heading and opens the composer.
    await frame.getByRole('heading', { name: 'Guided narrative: contact sheet' }).click();
    const composer = page.locator('[data-comment-popover]');
    await expect(composer).toBeVisible();
    // Shift-click adds the paragraph, and a link (which a plain click would follow), to the same comment.
    // Held Shift, as a person holds it: the composer then lets the pointer through to the page under it.
    await shiftClick(page, frame.getByText('Three directions.'));
    await shiftClick(page, frame.getByRole('link', { name: 'A: Story page' }));
    await expect(page.locator('[data-target-chip]')).toHaveCount(3);
    await expect(page.locator('[data-linked-page]')).toHaveCount(0);
    await composer.locator('textarea').fill('These three read as one block.');
    await shot(page, 'shift-click-1-three-targets');
    await composer.locator('textarea').press('ControlOrMeta+Enter');
    await expect(composer).toHaveCount(0);
    // The saved annotation covers the heading and both extra elements.
    const extra = async () => {
      const res = await context.request.get(new URL(`/api/inbox/threads/${thread}/attachments`, url).href);
      const body = (await res.json()) as { annotations: { annotation: { htmlAdditionalTargets?: { text: string }[] } }[] };
      return body.annotations.map((a) => (a.annotation.htmlAdditionalTargets ?? []).length);
    };
    await expect.poll(extra).toEqual([2]);
    await shot(page, 'shift-click-2-saved');
    await context.close();
  } finally {
    await agent.close().catch(() => {});
    await removeInboxScratch(root);
  }
});

for (const scheme of ['light', 'dark'] as const) {
  test(`links in an attached page open: a sibling page, an attached frame, an image beside it, and a refusal (${scheme})`, async ({ browser }) => {
    const { root, url, agent, thread, ids } = await world();
    const context = await browser.newContext({ colorScheme: scheme });
    try {
      const page = await context.newPage();
      const { pane, frame } = await openSheet(page, url, thread, ids['SHEET.html']!);
      await shot(page, `1-attached-page-${scheme}`);

      // A sibling page that is not attached: read-only over the page, with Back and the reason.
      await frame.getByRole('link', { name: 'B: Cards, at PR 1' }).click();
      const linked = page.locator('[data-linked-page="B-cards.html"]');
      await expect(linked).toBeVisible();
      await expect(page.locator('[data-linked-note]')).toHaveText('B-cards.html is not attached, so comments are off.');
      await expect(page.locator('[data-linked-back]')).toHaveText(/Back to SHEET\.html/);
      await expect(page.locator('[data-linked-open-tab]')).toHaveAttribute('href', /^\/api\/html-assets\/[A-Za-z0-9_-]+\/B-cards\.html$/);
      const linkedFrame = page.frameLocator('.ib-linkedframe iframe');
      await expect(linkedFrame.locator('h1')).toHaveText('B: Cards');
      // In the route: one history entry per page.
      expect(new URLSearchParams(new URL(page.url()).hash.slice(1)).get('linked')).toBe('B-cards.html#pr1');
      // The fragment scrolled the page to its section.
      await expect.poll(() => linkedFrame.locator('#pr1').evaluate((el) => el.getBoundingClientRect().top < window.innerHeight)).toBe(true);
      // Focus on Back.
      expect(await page.locator('[data-linked-back]').evaluate((el) => el === document.activeElement)).toBe(true);
      await shot(page, `2-sibling-page-${scheme}`);
      // Open in new tab serves the page itself from its folder.
      const tab = await context.request.get(new URL((await page.locator('[data-linked-open-tab]').getAttribute('href'))!, url).href);
      expect(tab.status()).toBe(200);
      expect(await tab.text()).toContain('B: Cards');
      // The sibling's own link back to the attached page goes home.
      await linkedFrame.getByRole('link', { name: 'Back to the sheet' }).click();
      await expect(linked).toHaveCount(0);
      await expect(frame.locator('h1')).toHaveText('Guided narrative: contact sheet');

      // A sibling opened at its top: its heading starts below the floating band, never under it.
      await frame.getByRole('link', { name: 'A: Story page' }).click();
      await expect(page.locator('[data-linked-page="A-story.html"]')).toBeVisible();
      const storyFrame = page.frameLocator('.ib-linkedframe iframe');
      await expect(storyFrame.locator('h1')).toHaveText('A: Story page');
      const bandBottom = (await page.locator('.ib-linkband').boundingBox())!;
      const frameBox = (await page.locator('.ib-linkedframe iframe').boundingBox())!;
      const headingTop = await storyFrame.locator('h1').evaluate((el) => el.getBoundingClientRect().top);
      expect(frameBox.y + headingTop).toBeGreaterThan(bandBottom.y + bandBottom.height);
      await shot(page, `2b-sibling-page-top-${scheme}`);
      // Its own link to another sibling; then the browser's Back, Escape and Back step back one page each.
      await storyFrame.getByRole('link', { name: 'On to B' }).click();
      await expect(page.locator('[data-linked-page="B-cards.html"]')).toBeVisible();
      await expect(page.locator('[data-linked-back]')).toHaveText(/Back to A-story\.html/);
      await page.goBack();
      await expect(page.locator('[data-linked-page="A-story.html"]')).toBeVisible();
      await page.goForward();
      await expect(page.locator('[data-linked-page="B-cards.html"]')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.locator('[data-linked-page="A-story.html"]')).toBeVisible();
      await page.locator('[data-linked-back]').click();
      await expect(page.locator('[data-linked-page]')).toHaveCount(0);
      // Still full screen: Escape stepped back a page, not out of the file.
      await expect(pane).toHaveAttribute('data-full-view', '');

      // An image beside the page, not attached: the lightbox, loaded through the page's asset route.
      await frame.getByRole('link', { name: 'B frame, not attached' }).click();
      const lightbox = page.locator('[data-image-lightbox]');
      await expect(lightbox).toBeVisible();
      await expect.poll(() => lightbox.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(480);
      // Shown at its own size in the middle of the screen (the zoom stage fills the overlay, #2067).
      await expect
        .poll(() =>
          lightbox.locator('img').evaluate((img: HTMLImageElement) => {
            const r = img.getBoundingClientRect();
            return [Math.round(r.width), Math.round(r.left + r.width / 2 - innerWidth / 2), Math.round(r.top + r.height / 2 - innerHeight / 2)];
          }),
        )
        .toEqual([480, 0, 0]);
      await shot(page, `3-unattached-image-lightbox-${scheme}`);
      await page.keyboard.press('Escape');
      await expect(lightbox).toHaveCount(0);

      // Cmd-click (Ctrl-click off macOS) on a link while armed pins it for a comment and follows nothing.
      await frame.getByRole('link', { name: 'B: Cards, at PR 1' }).click({ modifiers: ['ControlOrMeta'] });
      const composer = page.locator('[data-comment-popover]');
      await expect(composer).toBeVisible();
      await expect(page.locator('[data-linked-page]')).toHaveCount(0);
      await shot(page, `3b-cmd-click-pins-link-${scheme}`);
      await page.keyboard.press('Escape');
      await expect(composer).toHaveCount(0);

      // A link that goes nowhere (href="#", the mocks' button): a plain click pins it, as any element.
      await frame.getByRole('link', { name: 'Save draft' }).click();
      await expect(composer).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(composer).toHaveCount(0);

      // No pin outline over a link a click follows, until Cmd/Ctrl is held.
      const box = frame.locator('[data-plannotator-pinpoint-box]');
      await frame.getByRole('heading', { name: 'Guided narrative: contact sheet' }).hover();
      await expect(box).toBeVisible();
      await frame.getByRole('link', { name: 'A: Story page' }).hover();
      await expect(box).toBeHidden();
      await page.keyboard.down('ControlOrMeta');
      await frame.getByRole('link', { name: 'A: Story page' }).hover({ position: { x: 4, y: 4 } });
      await expect(box).toBeVisible();
      await shot(page, `3c-modifier-shows-pin-outline-${scheme}`);
      await page.keyboard.up('ControlOrMeta');
      await frame.getByRole('link', { name: 'A: Story page' }).hover({ position: { x: 8, y: 6 } });
      await expect(box).toBeHidden();

      // A PDF beside it: a note says why, never silent.
      await frame.getByRole('link', { name: 'The brief (PDF)' }).click();
      const note = page.locator('[data-link-note="shown"]');
      await expect(note).toContainText('brief.pdf is not attached to this thread');
      await shot(page, `4-refusal-note-${scheme}`);

      // The attached frame opens in the pane, full screen kept, and the browser's Back returns to the page.
      await frame.getByRole('link', { name: 'A frame, attached' }).click();
      const image = page.locator(`[data-attachment-pane="${ids['A-1440-light.png']}"]`);
      await expect(image).toBeVisible();
      await expect(image).toHaveAttribute('data-full-view', '');
      await shot(page, `5-attachment-from-link-${scheme}`);
      await page.goBack();
      await expect(pane).toBeVisible();
    } finally {
      await agent.close().catch(() => {});
      await context.close().catch(() => {});
      await removeInboxScratch(root);
    }
  });
}

test('beside the thread: a sibling page opens over the page, Escape and the browser Back step back', async ({ browser }) => {
  const { root, url, agent, thread, ids } = await world();
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    // A deep link that names side by side opens the page beside the thread (one without `view` opens HTML full screen).
    await page.goto(`${url}#thread=${thread}&file=${ids['SHEET.html']}&view=side`);
    const pane = page.locator(`[data-attachment-pane="${ids['SHEET.html']}"]`);
    await expect(pane).toBeVisible();
    await expect(pane).not.toHaveAttribute('data-full-view', '');
    const frame = page.frameLocator('.ib-htmlframe iframe');
    await expect(frame.locator('h1')).toHaveText('Guided narrative: contact sheet');
    // Armed (no mode switch): a plain click follows the link.
    await frame.getByRole('link', { name: 'A: Story page' }).click();
    await expect(page.locator('[data-linked-page="A-story.html"]')).toBeVisible();
    // The band is a row above the page; the header's pen is gone (no comments here).
    await expect(page.locator('.ib-vhead').getByRole('button', { name: /Annotate mode|Interact mode/ })).toHaveCount(0);
    await shot(page, '9-beside-thread-sibling-page');
    await page.frameLocator('.ib-linkedframe iframe').getByRole('link', { name: 'On to B' }).click();
    await expect(page.locator('[data-linked-page="B-cards.html"]')).toBeVisible();
    await page.goBack();
    await expect(page.locator('[data-linked-page="A-story.html"]')).toBeVisible();
    // Escape with focus in the pane: one page back; the file stays open.
    await pane.focus();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-linked-page]')).toHaveCount(0);
    await expect(pane).toBeVisible();
  } finally {
    await agent.close().catch(() => {});
    await context.close().catch(() => {});
    await removeInboxScratch(root);
  }
});

test("a page's own script clicking its link never follows it", async ({ browser }) => {
  const { root, url, agent, thread, ids } = await world();
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`${url}#thread=${thread}`);
    await page.locator(`button[data-attachment-id="${ids['autoclick.html']}"]`).first().click();
    const frame = page.frameLocator('.ib-htmlframe iframe');
    await expect(frame.locator('h1')).toHaveText('Auto-click');
    // Its timer has fired (a.click() on its own link); nothing followed, nothing pushed.
    await page.waitForTimeout(1200);
    await expect(page.locator('[data-linked-page]')).toHaveCount(0);
    expect(new URL(page.url()).hash).not.toContain('linked=');
    // A person's click on the same link does follow it.
    await frame.getByRole('link', { name: 'B' }).click();
    await expect(page.locator('[data-linked-page="B-cards.html"]')).toBeVisible();
  } finally {
    await agent.close().catch(() => {});
    await context.close().catch(() => {});
    await removeInboxScratch(root);
  }
});

test('on a phone the same links open, with Back in reach', async ({ browser }) => {
  const { root, url, agent, thread, ids } = await world();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  try {
    const page = await context.newPage();
    const { frame } = await openSheet(page, url, thread, ids['SHEET.html']!);
    await shot(page, '6-phone-attached-page');
    await frame.getByRole('link', { name: 'B: Cards, at PR 1' }).click();
    await expect(page.locator('[data-linked-page="B-cards.html"]')).toBeVisible();
    const back = page.locator('[data-linked-back]');
    const box = (await back.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    await shot(page, '7-phone-sibling-page');
    // The phone's swipe back is the browser's Back: one page back, the file stays open.
    await page.goBack();
    await expect(page.locator('[data-linked-page]')).toHaveCount(0);
    await expect(page.locator(`[data-attachment-pane="${ids['SHEET.html']}"]`)).toBeVisible();
    await frame.getByRole('link', { name: 'B: Cards, at PR 1' }).click();
    await expect(page.locator('[data-linked-page="B-cards.html"]')).toBeVisible();
    await back.click();
    await expect(page.locator('[data-linked-page]')).toHaveCount(0);
    await frame.getByRole('link', { name: 'The brief (PDF)' }).click();
    await expect(page.locator('[data-link-note="shown"]')).toBeVisible();
    await shot(page, '8-phone-refusal-note');
  } finally {
    await agent.close().catch(() => {});
    await context.close().catch(() => {});
    await removeInboxScratch(root);
  }
});

/**
 * Press and hold a link inside the page's frame for `ms`, then lift. Chromium:
 * a real touch through the DevTools protocol (the browser's own gesture
 * handling runs, Android's long-press context menu included). WebKit has no
 * such channel, so the touch events are dispatched in the frame (what iOS
 * sends a page for a hold), and the click iOS may send on release after them.
 */
async function holdLink(page: Page, link: Locator, browserName: string, ms = 750) {
  const box = (await link.boundingBox())!;
  const x = box.x + Math.min(12, box.width / 2);
  const y = box.y + box.height / 2;
  if (browserName === 'chromium') {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await page.waitForTimeout(ms);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
    return;
  }
  await link.evaluate(async (el, hold) => {
    const r = el.getBoundingClientRect();
    const point = { identifier: 1, clientX: r.left + Math.min(12, r.width / 2), clientY: r.top + r.height / 2, target: el };
    const fire = (type: string, touches: unknown[]) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'touches', { value: touches });
      Object.defineProperty(event, 'changedTouches', { value: [point] });
      el.dispatchEvent(event);
      return event;
    };
    fire('touchstart', [point]);
    await new Promise((done) => setTimeout(done, hold));
    const end = fire('touchend', []);
    if (!end.defaultPrevented) el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: point.clientX, clientY: point.clientY }));
  }, ms);
}

for (const phone of [
  { name: 'iPhone 15 (WebKit)', device: devices['iPhone 15'], browserName: 'webkit' as const },
  { name: 'Pixel 7 (Chromium)', device: devices['Pixel 7'], browserName: 'chromium' as const },
]) {
  test(`on a phone, ${phone.name}: a tap on a link follows it, a press-and-hold opens a comment on it`, async () => {
    const { root, url, agent, thread, ids } = await world();
    // (WebKit launches without the config's Chromium flags, --use-mock-keychain and --password-store=basic, which Linux WebKit exits on.)
    const browser: Browser = phone.browserName === 'webkit' ? await webkit.launch({ args: [] }) : await chromium.launch();
    try {
      const context = await browser.newContext({ ...phone.device });
      const page = await context.newPage();
      const { frame } = await openSheet(page, url, thread, ids['SHEET.html']!);
      const link = frame.getByRole('link', { name: 'A: Story page' });
      // Armed, links lose iOS's callout so the hold is ours; their text stays selectable outside a hold.
      await link.tap();
      await expect(page.locator('[data-linked-page="A-story.html"]')).toBeVisible();
      await shot(page, `10-phone-tap-follows-${phone.browserName}`);
      await page.locator('[data-linked-back]').click();
      await expect(page.locator('[data-linked-page]')).toHaveCount(0);
      const style = await link.evaluate((el) => {
        const cs = getComputedStyle(el) as CSSStyleDeclaration & { webkitTouchCallout?: string; webkitUserSelect?: string };
        return {
          callout: cs.webkitTouchCallout ?? '',
          // iOS-only: desktop WebKit and Chromium do not know the property.
          calloutSupported: CSS.supports('-webkit-touch-callout', 'none'),
          calloutRule: [...document.querySelectorAll('style')].some((s) => /-webkit-touch-callout:\s*none/.test(s.textContent ?? '')),
          select: cs.userSelect || cs.webkitUserSelect || '',
        };
      });
      expect(style.select).not.toBe('none');
      expect(style.calloutRule).toBe(true);
      if (style.calloutSupported) expect(style.callout).toBe('none');
      // Press and hold: the comment composer opens on the link, and the release follows nothing.
      const before = page.url();
      await holdLink(page, link, phone.browserName);
      // A phone's comment is the bottom card's (approval "inbox-html-attachments-phone"), on the link.
      const composer = page.locator('[data-html-comment="compose"]');
      await expect(composer).toBeVisible();
      await expect(composer.locator('[data-html-comment-target]')).toHaveText('A: Story page');
      await page.waitForTimeout(600);
      await expect(page.locator('[data-linked-page]')).toHaveCount(0);
      expect(page.url()).toBe(before);
      await expect(frame.locator('[data-plannotator-pinpoint-box]')).toBeVisible();
      await shot(page, `11-phone-hold-opens-comment-${phone.browserName}`);
      await context.close();
    } finally {
      await browser.close().catch(() => {});
      await agent.close().catch(() => {});
      await removeInboxScratch(root);
    }
  });
}
