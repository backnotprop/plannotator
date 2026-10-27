/**
 * Comments on part of an image (#2100, approval "image-region-comments",
 * variant C), proved in Chromium against the compiled binary, in annotate and
 * in plan review: in the image viewer Region turns a drag into a box, the
 * comment box opens beside it, Save adds a comment whose box is drawn on the
 * image, Region stays on, Escape goes back to Move, the count opens a drawer
 * whose card zooms to the box, the comment lists in the document's panel,
 * survives a reload through the draft, and reaches the agent with the image as
 * written, its line, and the box in the image's own pixels. On a phone the
 * switch sits at the bottom and one finger draws.
 *
 * Every CLI runs under a temp PLANNOTATOR_DATA_DIR and HOME, opens no browser,
 * and is closed by this test. Screenshots go to PLANNOTATOR_IMAGE_REGION_SHOTS
 * when it is set. Build the binary first (see inbox.spec.ts), then
 * `bun run test:e2e:inbox`.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shots = process.env.PLANNOTATOR_IMAGE_REGION_SHOTS ?? '';

test.use({ actionTimeout: 15_000 });

async function shot(page: Page, name: string) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(shots, `${name}.png`) });
}

/** A status sheet like the approval's mock, 1832 × 726 CSS px rendered at 2×: 3664 × 1452 image pixels. */
const SHEET = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;font:15px system-ui,sans-serif;background:#faf9f6;color:#18181b;padding:40px 56px}
h1{margin:0 0 4px;font-size:30px}p{margin:0 0 30px;color:#52525b}
.grid{display:grid;grid-template-columns:150px repeat(5,180px) 160px;gap:16px;align-items:center}
.h{font-size:12px;letter-spacing:.12em;color:#71717a;text-align:center;font-weight:600}
.chip{border-radius:10px;padding:12px 16px;font-weight:600;font-size:18px}.chip small{display:block;font:11px ui-monospace,monospace;opacity:.7;margin-top:4px}
.legend{grid-row:2/span 2;grid-column:7;border:1px solid #e4e4e7;border-radius:10px;padding:12px;font-size:13px;line-height:1.9;background:#fff}
</style><h1>Job status colors</h1><p>v1.8 (before) vs v2.0 (after) · chip fill, text and dot tokens</p>
<div class="grid"><span></span><span class="h">QUEUED</span><span class="h">RUNNING</span><span class="h">PAUSED</span><span class="h">FAILED</span><span class="h">DONE</span><span></span>
<b>After · v2.0</b><span class="chip" style="background:#e8eaf0">● Queued<small>#E8EAF0</small></span><span class="chip" style="background:#dbeafe;color:#1d4ed8">● Running<small>#DBEAFE</small></span><span class="chip" style="background:#fde4c3;color:#b45309">● Paused<small>#FDE4C3</small></span><span class="chip" style="background:#fee2e2;color:#b91c1c">● Failed<small>#FEE2E2</small></span><span class="chip" style="background:#d1fae5;color:#047857">● Done<small>#D1FAE5</small></span>
<div class="legend"><b>Legend</b><br>■ Queued<br>■ Running<br>■ Paused<br>■ Failed<br>■ Done<br>■ Blocked</div>
<b>Before · v1.8</b><span class="chip" style="background:#eef0f4">● Queued<small>#EEF0F4</small></span><span class="chip" style="background:#e0e7ff;color:#4338ca">● Running<small>#E0E7FF</small></span><span class="chip" style="background:#e5e7eb">● Paused<small>#E5E7EB</small></span><span class="chip" style="background:#fecaca;color:#991b1b">● Failed<small>#FECACA</small></span><span class="chip" style="background:#bbf7d0;color:#166534">● Done<small>#BBF7D0</small></span>
</div>`;

async function sheetPng(browser: Browser): Promise<Buffer> {
  const maker = await browser.newContext({ viewport: { width: 1832, height: 726 }, deviceScaleFactor: 2 });
  const page = await maker.newPage();
  await page.setContent(SHEET);
  const bytes = await page.screenshot();
  await maker.close();
  return bytes;
}

const DOC = (src: string) =>
  [
    '# Status colors for v2.0',
    '',
    'We are moving every job status to the new token set. Paused jobs keep their slot in the queue.',
    '',
    '## Status sheet',
    '',
    'The sheet below is exported from Figma at 2×.',
    `![Job status colors, before and after](${src})`,
    '',
    '## Rollout',
    '',
    'Ship behind a flag, then remove the v1.8 palette.',
    '',
  ].join('\n');

interface Session {
  url: string;
  child: ChildProcess;
  stdout: () => string;
  close: () => Promise<void>;
}

/** A CLI session in a scratch folder: `annotate <doc>`, or plan review (`plannotator` reading a PermissionRequest on stdin). */
async function start(kind: 'annotate' | 'plan', browser: Browser): Promise<Session & { root: string }> {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-image-regions-e2e-');
  const dataDir = join(root, 'data');
  mkdirSync(join(root, 'figures'), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(root, 'figures', 'status-colors.png'), await sheetPng(browser));
  const readyFile = join(root, 'ready.jsonl');
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_READY_FILE: readyFile,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_BROWSER,
    PLANNOTATOR_SKIP_BROWSER_OPEN: '1',
    PLANNOTATOR_REMOTE: '0',
    PLANNOTATOR_INBOX_CONNECT: '0',
  };
  let out = '';
  let child: ChildProcess;
  if (kind === 'annotate') {
    const doc = join(root, 'PLAN.md');
    writeFileSync(doc, DOC('figures/status-colors.png'));
    child = spawn(binary, ['annotate', doc], { env, cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
  } else {
    child = spawn(binary, [], { env, cwd: root, stdio: ['pipe', 'pipe', 'ignore'] });
    child.stdin!.end(
      JSON.stringify({
        session_id: 'e2e',
        transcript_path: join(root, 'transcript.jsonl'),
        cwd: root,
        permission_mode: 'plan',
        hook_event_name: 'PermissionRequest',
        tool_name: 'ExitPlanMode',
        tool_input: { plan: DOC(join(root, 'figures', 'status-colors.png')) },
      }),
    );
  }
  child.stdout!.on('data', (chunk) => {
    out += String(chunk);
  });
  await expect.poll(() => (existsSync(readyFile) ? readFileSync(readyFile, 'utf8') : ''), { timeout: 30_000 }).toContain('"url"');
  const url = (JSON.parse(readFileSync(readyFile, 'utf8').trim().split('\n')[0]!) as { url: string }).url;
  const close = async () => {
    await fetch(new URL('/api/exit', url), { method: 'POST' }).catch(() => {});
    if (child.exitCode === null) {
      await new Promise((done) => {
        const timer = setTimeout(done, 5_000);
        child.once('exit', () => {
          clearTimeout(timer);
          done(undefined);
        });
      });
      // inbox-guard: own child (the CLI this test spawned, never an Inbox)
      if (child.exitCode === null) child.kill('SIGTERM');
    }
    await removeInboxScratch(root);
  };
  return { url, child, root, stdout: () => out, close };
}

async function open(browser: Browser, url: string, options: Parameters<Browser['newContext']>[0] = {}): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options });
  await context.addCookies(
    [
      ['plannotator-theme', options.colorScheme === 'dark' ? 'dark' : 'light'],
      ['plannotator-plan-look-choice-resolved', 'true'],
      ['plannotator-announce-tui-herdr-seen', '1'],
      ['plannotator-announce-inbox-seen', '1'],
      ['plannotator-announce-ask-session-seen', '1'],
      ['plannotator-announce-agent-tool-seen', '1'],
      ['plannotator-permission-mode-configured', 'true'],
    ].map(([name, value]) => ({ name: name!, value: value!, url })),
  );
  const page = await context.newPage();
  await page.goto(url);
  return { context, page };
}

/** The viewer's stage, and where an image pixel is on screen now. */
async function stageGeometry(page: Page) {
  const img = page.locator('[data-image-lightbox] [data-lightbox-image]');
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(3664);
  const box = (await img.boundingBox())!;
  const scale = box.width / 3664;
  return { at: (x: number, y: number) => ({ x: box.x + x * scale, y: box.y + y * scale }), scale };
}

/** Drag a box over image pixels (x0, y0) to (x1, y1) with the mouse. */
async function drawBox(page: Page, from: [number, number], to: [number, number], mid?: () => Promise<void>) {
  const { at } = await stageGeometry(page);
  const a = at(...from);
  const b = at(...to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
  await page.mouse.move(b.x, b.y, { steps: 4 });
  if (mid) await mid();
  await page.mouse.up();
}

test('annotate: draw a box, comment, see it drawn and listed, zoom to it from the drawer, survive a reload, reach the agent', async ({ browser }) => {
  const session = await start('annotate', browser);
  try {
    for (const scheme of ['light', 'dark'] as const) {
      const { context, page } = await open(browser, session.url, { colorScheme: scheme });
      if (scheme === 'dark') {
        // The draft from the light run comes back: restore it.
        await page.getByRole('button', { name: 'Restore' }).click();
      }
      await page.locator('article img.cursor-zoom-in').click();
      const viewer = page.locator('[data-image-lightbox]');
      await expect(viewer).toBeVisible();
      const region = viewer.getByRole('radio', { name: 'Region' });
      const move = viewer.getByRole('radio', { name: 'Move' });
      await expect(viewer.getByRole('radiogroup', { name: 'Image tool' })).toBeVisible();
      await expect(move).toHaveAttribute('aria-checked', 'true');
      // The radio group moves with the arrows, as a segmented control.
      await move.focus();
      await page.keyboard.press('ArrowRight');
      await expect(region).toHaveAttribute('aria-checked', 'true');
      await expect(region).toBeFocused();

      const before = scheme === 'light' ? 0 : 1;
      await expect(viewer.locator('[data-region-count]')).toHaveText(String(before));
      // Light: the "paused" chip; dark: the Legend (image pixels at 2×).
      const target: [[number, number], [number, number]] = scheme === 'light' ? [[1240, 300], [1660, 470]] : [[2380, 290], [2750, 730]];
      await drawBox(page, target[0], target[1], async () => {
        await expect(viewer.locator('[data-region-draft]')).toBeVisible();
        await expect(viewer.locator('[data-region-size]')).toHaveText(/^\d+ × \d+$/);
        await shot(page, `desk-drawing-${scheme}`);
      });
      const composer = page.locator('[data-comment-popover]');
      await expect(composer).toBeVisible();
      await expect(composer).toContainText(`Region ${before + 1} · `);
      // Beside the box, not over it.
      const pendingBox = (await viewer.locator('[data-region-pending]').boundingBox())!;
      const composerBox = (await composer.boundingBox())!;
      expect(composerBox.x >= pendingBox.x + pendingBox.width || composerBox.x + composerBox.width <= pendingBox.x).toBe(true);
      const text = scheme === 'light' ? 'The paused chip should be grey, not orange.' : 'The legend still lists Blocked; we removed that state in v2.0.';
      await composer.locator('textarea').fill(text);
      await shot(page, `desk-composer-${scheme}`);
      // The draft autosave is debounced: wait for it to land, so the next
      // session's Restore finds it (it is not flushed when the page closes).
      const draftSaved = page.waitForResponse((r) => r.url().endsWith('/api/draft') && r.request().method() === 'POST' && r.ok() && (r.request().postData() ?? '').includes(text));
      await composer.getByRole('button', { name: 'Save' }).click();
      await draftSaved;
      await expect(composer).toBeHidden();
      await expect(viewer.locator('[data-region-count]')).toHaveText(String(before + 1));
      await expect(viewer.locator('[data-region-box]')).toHaveCount(before + 1);
      // Region stays on; Escape goes back to Move and leaves the viewer open.
      await expect(region).toHaveAttribute('aria-checked', 'true');
      await viewer.locator('[data-lightbox-stage]').focus();
      await page.keyboard.press('Escape');
      await expect(move).toHaveAttribute('aria-checked', 'true');
      await expect(viewer).toBeVisible();
      await shot(page, `desk-saved-${scheme}`);

      // The count opens the drawer; a card zooms to its box and rings it.
      await viewer.locator('[data-region-count]').click();
      const drawer = viewer.locator('[data-region-drawer]');
      await expect(drawer).toBeVisible();
      await expect(drawer.locator('[data-annotation-id]')).toHaveCount(before + 1);
      const card = drawer.locator('[data-annotation-id]').last();
      await expect(card).toContainText('status-colors.png');
      await expect(card).toContainText('line 8');
      const zoomBefore = await viewer.locator('[data-lightbox-zoom]').textContent();
      await card.click();
      await expect(viewer.locator('[data-region-selected]')).toHaveCount(1);
      await expect.poll(() => viewer.locator('[data-lightbox-zoom]').textContent()).not.toBe(zoomBefore);
      await shot(page, `desk-drawer-${scheme}`);
      // Escape from the drawer closes it, then the viewer.
      await card.focus();
      await page.keyboard.press('Escape');
      await expect(drawer).toBeHidden();
      await page.keyboard.press('Escape');
      await expect(viewer).toBeHidden();

      // Listed in the document's panel like any comment, with the region's details.
      const panelCard = page.locator('[data-annotation-panel] [data-annotation-region]');
      await expect(panelCard).toHaveCount(before + 1);
      await context.close();
    }

    // What the agent receives: the export modal's annotations tab.
    const { context, page } = await open(browser, session.url);
    await page.getByRole('button', { name: 'Restore' }).click();
    await page.getByRole('button', { name: 'Options' }).click();
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await page.getByRole('button', { name: /^Annotations/ }).click();
    const output = page.locator('pre').filter({ hasText: 'Region:' });
    await expect(output).toContainText('Feedback on a region of the image figures/status-colors.png');
    await expect(output).toContainText('Image: figures/status-colors.png (line 8)');
    await expect(output).toContainText(/Region: x=\d+ y=\d+ w=\d+ h=\d+ \(of 3664×1452\)/);
    await expect(output).toContainText('> The paused chip should be grey, not orange.');
    await shot(page, 'desk-export-light');
    await context.close();
  } finally {
    await session.close();
  }
});

test('plan review: a region comment reaches the agent when feedback is sent', async ({ browser }) => {
  const session = await start('plan', browser);
  try {
    const { context, page } = await open(browser, session.url);
    await page.locator('article img.cursor-zoom-in').click();
    const viewer = page.locator('[data-image-lightbox]');
    await viewer.getByRole('radio', { name: 'Region' }).click();
    await drawBox(page, [1240, 300], [1660, 470]);
    const composer = page.locator('[data-comment-popover]');
    await composer.locator('textarea').fill('Grey, not orange.');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
    await expect(viewer.locator('[data-region-box]')).toHaveCount(1);
    await viewer.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Send Feedback' }).first().click();
    await expect.poll(() => session.stdout(), { timeout: 15_000 }).toContain('Region: x=');
    const out = session.stdout();
    expect(out).toContain('Feedback on a region of the image');
    expect(out).toContain('status-colors.png (line 8)');
    expect(out).toContain('(of 3664×1452)');
    expect(out).toContain('Grey, not orange.');
    await context.close();
  } finally {
    await session.close();
  }
});

test('phone: the switch sits at the bottom, one finger draws, the composer and the drawer are sheets', async ({ browser }) => {
  for (const scheme of ['light', 'dark'] as const) {
    const session = await start('annotate', browser);
    try {
      const { context, page } = await open(browser, session.url, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: scheme });
      await page.locator('article img.cursor-zoom-in').click();
      const viewer = page.locator('[data-image-lightbox]');
      const strip = viewer.locator('[data-region-strip]');
      await expect(strip).toBeVisible();
      const stripBox = (await strip.boundingBox())!;
      const stageBox = (await viewer.locator('[data-lightbox-stage]').boundingBox())!;
      // At the bottom of the stage, in thumb reach.
      expect(stripBox.y).toBeGreaterThan(stageBox.y + stageBox.height / 2);
      await viewer.getByRole('radio', { name: 'Region' }).tap();
      await expect(viewer.locator('[data-region-hint]')).toHaveText('One finger draws · two fingers move the image');
      // In Region a tap beside the image does not close the viewer (in Move it does, #2067).
      await page.touchscreen.tap(stageBox.x + stageBox.width / 2, stageBox.y + 90);
      await page.waitForTimeout(400);
      await expect(viewer).toBeVisible();
      // One finger, through the DevTools protocol (a real touch, pointerType "touch").
      const { at } = await stageGeometry(page);
      const a = at(scheme === 'light' ? 1240 : 2400, 300);
      const b = at(scheme === 'light' ? 1700 : 3000, 900);
      const cdp = await context.newCDPSession(page);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: a.x, y: a.y }] });
      for (let i = 1; i <= 6; i += 1) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: a.x + ((b.x - a.x) * i) / 6, y: a.y + ((b.y - a.y) * i) / 6 }] });
      }
      await expect(viewer.locator('[data-region-draft]')).toBeVisible();
      await shot(page, `phone-draw-${scheme}`);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      const composer = page.locator('[data-comment-popover]');
      await expect(composer).toBeVisible();
      await composer.locator('textarea').fill(scheme === 'light' ? 'Paused should read as waiting.' : 'Done is too saturated.');
      await shot(page, `phone-composer-${scheme}`);
      await composer.getByRole('button', { name: 'Save' }).click();
      await expect(viewer.locator('[data-region-box]')).toHaveCount(1);
      await viewer.locator('[data-region-count]').tap();
      await expect(viewer.locator('[data-region-drawer]')).toBeVisible();
      await viewer.locator('[data-region-drawer] [data-annotation-id]').first().tap();
      await expect(viewer.locator('[data-region-selected]')).toHaveCount(1);
      await shot(page, `phone-drawer-${scheme}`);
      await context.close();
    } finally {
      await session.close();
    }
  }
});
