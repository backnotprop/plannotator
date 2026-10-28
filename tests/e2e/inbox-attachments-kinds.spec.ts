/**
 * Attachments of any kind (images, PDFs, other files, code from anywhere),
 * proved in a real browser against the compiled binary. Nothing is mocked:
 * `plannotator inbox --background` runs under a temp PLANNOTATOR_DATA_DIR and
 * HOME with a tailscale trap first on PATH; an agent attaches real files
 * through `plannotator inbox mcp` (scripts/inbox-sim.ts); the screenshots it
 * attaches are real PNGs Chromium takes of a settings page (desktop, and a
 * tall phone page); Chromium drives the window.
 *
 * Proves: an image shows inline in the message AND as a tile with its
 * thumbnail, both loaded from its image route; a file from outside the
 * project (a screenshot tool's folder) attaches by its absolute path; a PDF
 * and a zip are Download links with attachment headers, and the download
 * carries the bytes sent; the image opens beside the thread, is marked up
 * with Plannotator's image annotator and commented; a code file opens in the
 * code view and takes a line comment; Send carries both, and the agent reads
 * the image comment with its marked-up copy's path, and the code comment with
 * its lines. A Graphviz (.dot) attachment renders as a diagram in the pane:
 * the engine compiles WebAssembly, which the window's CSP must allow
 * ('wasm-unsafe-eval'), and no CSP violation is logged.
 *
 * Build the binary first (see inbox.spec.ts), then
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-attachments-kinds.spec.ts`.
 * PNGs land in PLANNOTATOR_E2E_SHOTS_DIR (default .local/proof/attachments-kinds).
 */

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const builtBinary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shotsDir = resolve(process.env.PLANNOTATOR_E2E_SHOTS_DIR ?? join(repo, '.local/proof/attachments-kinds'));

const SETTINGS_PAGE = (width: number) => `<!doctype html><meta charset="utf-8"><style>
body{margin:0;font:15px system-ui,-apple-system,sans-serif;color:#18181b;background:#f4f4f5}
nav{background:#111827;color:#e5e7eb;padding:14px 24px;display:flex;gap:20px;font-size:14px}nav b{color:#fff}
main{max-width:${width > 500 ? 760 : 360}px;margin:0 auto;padding:22px}
h1{font-size:22px;margin:0 0 4px}p.sub{color:#71717a;margin:0 0 18px}
.card{background:#fff;border:1px solid #e4e4e7;border-radius:12px;padding:18px 20px;margin-bottom:16px}
.row{display:flex;justify-content:space-between;align-items:center;padding:12px 0;border-bottom:1px solid #f1f1f3}.row:last-child{border:0}
label{font-weight:600}small{display:block;color:#71717a;font-weight:400;margin-top:2px}
input{border:1px solid #d4d4d8;border-radius:7px;padding:8px 10px;font:inherit;width:${width > 500 ? 140 : 90}px}
.note{background:#fef3c7;color:#92400e;border-radius:8px;padding:10px 12px;margin-top:10px}
.pay{display:inline-block;margin-top:14px;background:#4f46e5;color:#fff;border-radius:8px;padding:10px 18px;font-weight:600}
table{width:100%;border-collapse:collapse}td{padding:10px 4px;border-bottom:1px solid #f1f1f3}td:last-child{text-align:right;color:#52525b}
</style><nav><b>Larkspur Billing</b><span>Customers</span><span>Refunds</span><span>Reports</span></nav>
<main><h1>Retry policy</h1><p class="sub">Failed refunds are retried with exponential backoff.</p>
<div class="card"><div class="row"><label>Maximum attempts<small>Then the refund is marked failed</small></label><input value="5"></div>
<div class="row"><label>First delay<small>Doubles after each attempt</small></label><input value="30 seconds"></div>
<div class="row"><label>Alert the on-call after<small>Posts to #billing-alerts</small></label><input value="Attempt 3"></div>
<div class="note">The on-call is paged once per refund, not once per attempt.</div><span class="pay">Save policy</span></div>
<div class="card"><b>Recent failures</b><table>
<tr><td>rf_8KQ2m1 Ostrava Coffee Co.</td><td>$184.20</td></tr><tr><td>rf_8KP9x4 Hallam &amp; Reyes</td><td>$1,240.00</td></tr>
<tr><td>rf_8KP3c7 Mirela Tanase</td><td>$39.99</td></tr><tr><td>rf_8KN0d2 Pinecrest Dental</td><td>$612.75</td></tr>
<tr><td>rf_8KM7a9 Okafor Studio</td><td>$129.00</td></tr><tr><td>rf_8KL1b4 Ribeiro Tiles</td><td>$15.50</td></tr></table></div>
<div class="card"><b>Audit log</b><table><tr><td>Policy saved by Dana</td><td>4:02 PM</td></tr><tr><td>Max attempts 3 → 5</td><td>4:01 PM</td></tr><tr><td>Alert moved to attempt 3</td><td>3:58 PM</td></tr></table></div>
</main>`;

const STATES_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="300" viewBox="0 0 640 300" font-family="system-ui" font-size="13">
<rect width="640" height="300" fill="#ffffff"/><text x="20" y="30" font-weight="600">Refund states and the retry worker</text>
<g stroke="#334155" fill="#eef2ff"><rect x="30" y="130" width="100" height="36" rx="6"/><rect x="230" y="130" width="100" height="36" rx="6" fill="#fef9c3"/><rect x="460" y="60" width="130" height="36" rx="6" fill="#dcfce7"/><rect x="460" y="130" width="130" height="36" rx="6"/><rect x="460" y="200" width="130" height="36" rx="6" fill="#fee2e2"/></g>
<g text-anchor="middle"><text x="80" y="153">created</text><text x="280" y="153">pending</text><text x="525" y="83">succeeded</text><text x="525" y="153">requires_action</text><text x="525" y="223">failed</text></g>
<g stroke="#64748b" fill="none" stroke-width="1.5"><path d="M130 148h96"/><path d="M330 140l126-62"/><path d="M330 148h126"/><path d="M330 156l126 62"/><path d="M460 230 Q 300 290 285 170"/></g>
<script>document.title = 'svg script ran'</script></svg>`;

/** A one-page PDF: enough for a viewer to open, and `%PDF-` for the sniffer. */
const PDF = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length 52 >> stream
BT /F1 18 Tf 24 70 Td (Payments API: refunds) Tj ET
endstream endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
trailer << /Root 1 0 R >>
%%EOF
`;

const WORKER = `// Retries failed refunds with exponential backoff.
import { refunds } from './store.mjs';

export const MAX_ATTEMPTS = 5;
export const FIRST_DELAY_MS = 30_000;

export async function retryRefund(id, attempt = 1) {
  const refund = await refunds.get(id);
  if (refund.state !== 'failed') return refund;
  if (attempt > MAX_ATTEMPTS) return refunds.markFailed(id);
  await sleep(FIRST_DELAY_MS * 2 ** (attempt - 1));
  return retryRefund(id, attempt + 1);
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
`;

/** The retry worker's states as Graphviz, rendered by @viz-js/viz (WebAssembly). */
const RETRY_DOT = `digraph refund_retry {
  rankdir=LR;
  created -> pending;
  pending -> succeeded;
  pending -> retry_wait [label="failed"];
  retry_wait -> pending [label="backoff"];
  retry_wait -> marked_failed [label="attempt > 5"];
}
`;

interface World {
  root: string;
  dataDir: string;
  url: string;
  billing: string;
  outsidePng: string;
  claude: SimAgent;
  context: BrowserContext;
  page: Page;
  errors: string[];
  /** Console messages about the Content Security Policy (a blocked WebAssembly compile is one). */
  csp: string[];
  threadId: string;
  ids: Record<string, string>;
  zipBytes: Buffer;
}

let world: World;

async function shot(name: string): Promise<void> {
  const page = world.page;
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(shotsDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

/** Every image under `selector` has loaded with real pixels. */
async function imagesLoaded(page: Page, selector: string): Promise<number> {
  await page.waitForFunction(
    (sel) => {
      const images = [...document.querySelectorAll<HTMLImageElement>(sel)];
      return images.length > 0 && images.every((img) => img.complete && img.naturalWidth > 0);
    },
    selector,
    { timeout: 15_000 },
  );
  return page.locator(selector).count();
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(builtBinary), `build the binary first: ${builtBinary}`).toBe(true);
  rmSync(shotsDir, { recursive: true, force: true });
  mkdirSync(shotsDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-kinds-');
  const dataDir = join(root, 'data');
  const home = join(root, 'home');
  const trap = join(root, 'trap');
  mkdirSync(home);
  mkdirSync(trap);
  // Nothing here may reach the real tailscale CLI.
  writeFileSync(join(trap, 'tailscale'), '#!/bin/sh\necho "inbox-attachments-kinds: tailscale must not run" >&2\nexit 97\n');
  chmodSync(join(trap, 'tailscale'), 0o755);
  const env = { PATH: `${trap}:${process.env.PATH ?? ''}`, HOME: home, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9' };
  const started = spawnSync(builtBinary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();

  // Real screenshots, taken by the browser: a desktop page and a tall phone page.
  const billing = scratchProject(join(root, 'src'), 'billing-svc');
  mkdirSync(join(billing, 'shots'));
  mkdirSync(join(billing, 'docs'));
  mkdirSync(join(billing, 'workers'));
  const maker = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const makerPage = await maker.newPage();
  await makerPage.setContent(SETTINGS_PAGE(1280));
  writeFileSync(join(billing, 'shots', 'retry-policy-desktop.png'), await makerPage.screenshot());
  await makerPage.setViewportSize({ width: 390, height: 844 });
  await makerPage.setContent(SETTINGS_PAGE(390));
  writeFileSync(join(billing, 'shots', 'retry-policy-phone.png'), await makerPage.screenshot({ fullPage: true }));
  await maker.close();
  writeFileSync(join(billing, 'docs', 'refund-states.svg'), STATES_SVG);
  writeFileSync(join(billing, 'docs', 'payments-api-refunds.pdf'), PDF);
  writeFileSync(join(billing, 'workers', 'retry-worker.mjs'), WORKER);
  writeFileSync(join(billing, 'docs', 'refund-retry.dot'), RETRY_DOT);
  const zipBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00, ...Array.from({ length: 64 }, (_, i) => (i * 37) & 0xff)]);
  writeFileSync(join(billing, 'refund-fixtures.zip'), zipBytes);
  // A screenshot tool's own folder, outside the project.
  const outsideDir = join(root, 'Screenshots');
  mkdirSync(outsideDir);
  const outsidePng = join(outsideDir, 'Screen Shot 2026-10-10 at 4.12.png');
  writeFileSync(outsidePng, readFileSync(join(billing, 'shots', 'retry-policy-desktop.png')));

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', acceptDownloads: true });
  const page = await context.newPage();
  const errors: string[] = [];
  const csp: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (/Content Security Policy|wasm-unsafe-eval|unsafe-eval/i.test(message.text())) csp.push(message.text());
  });
  page.on('response', (response) => {
    if (response.status() >= 400) errors.push(`HTTP ${response.status()} ${new URL(response.url()).pathname}`);
  });
  world = {
    root,
    dataDir,
    url,
    billing,
    outsidePng,
    claude: await SimAgent.connect({ binary: builtBinary, env, name: 'Claude Code', host: 'claude-code' }),
    context,
    page,
    errors,
    csp,
    threadId: '',
    ids: {},
    zipBytes,
  };
});

test.afterAll(async () => {
  try {
    if (!world) return;
    await world.claude.close().catch(() => {});
    await world.context.close();
  } finally {
    // Every Inbox this spec started, then its folders (inbox-scratch.ts).
    await removeInboxScratch();
  }
});

test('an agent attaches screenshots (one from outside the project), an SVG, a PDF, a zip and a .mjs: each gets its kind', async () => {
  const sent = await world.claude.send({
    project_path: world.billing,
    subject: 'Refund retry settings: screenshots, the API notes, and the worker',
    body: 'I rebuilt the retry policy page. The desktop view and the whole phone page are below, with the state diagram the worker follows.\n\nTwo things to check: does the on-call note read well on a phone, and is `MAX_ATTEMPTS = 5` the right cap? The fixtures I tested with are in the zip.',
    attachments: [
      'shots/retry-policy-desktop.png',
      'shots/retry-policy-phone.png',
      'docs/refund-states.svg',
      'docs/payments-api-refunds.pdf',
      'workers/retry-worker.mjs',
      'refund-fixtures.zip',
      world.outsidePng,
    ],
  });
  world.threadId = sent.thread_id;
  const kinds = Object.fromEntries((sent.attachments as { name: string; kind: string; id: string; path: string }[]).map((a) => [a.name, a.kind]));
  expect(kinds).toEqual({
    'retry-policy-desktop.png': 'image',
    'retry-policy-phone.png': 'image',
    'refund-states.svg': 'image',
    'payments-api-refunds.pdf': 'pdf',
    'retry-worker.mjs': 'code',
    'refund-fixtures.zip': 'file',
    'Screen Shot 2026-10-10 at 4.12.png': 'image',
  });
  for (const a of sent.attachments as { name: string; id: string; path: string }[]) world.ids[a.name] = a.id;
  expect((sent.attachments as { path: string }[]).at(-1)!.path).toBe(world.outsidePng);
});

test('the thread shows the images inline and as tiles with thumbnails; the PDF and the zip are downloads', async () => {
  const page = world.page;
  await page.goto(`${world.url}#thread=${world.threadId}`);
  const gallery = page.locator('[data-image-gallery] [data-gallery-image]');
  await expect(gallery).toHaveCount(4);
  expect(await imagesLoaded(page, '[data-image-gallery] img')).toBe(4);
  // The same images as tiles, each with its thumbnail.
  expect(await imagesLoaded(page, '.ib-att-t .ib-thumb img')).toBe(4);
  // Every image comes from the attachment's own route, by id.
  const srcs = await page.locator('[data-image-gallery] img').evaluateAll((imgs) => imgs.map((img) => img.getAttribute('src')));
  expect(srcs.every((src) => /^\/api\/inbox\/attachments\/att_[0-9A-Z]+\/image$/.test(src ?? ''))).toBe(true);
  // An SVG drawn by <img> runs no script.
  expect(await page.title()).not.toContain('svg script ran');
  // Downloads, never opened in the window.
  const pdfTile = page.locator(`a[data-attachment-id="${world.ids['payments-api-refunds.pdf']}"]`);
  const zipTile = page.locator(`a[data-attachment-id="${world.ids['refund-fixtures.zip']}"]`);
  await expect(pdfTile).toHaveAttribute('download', 'payments-api-refunds.pdf');
  await expect(zipTile).toContainText('Download');
  await page.locator('.ib-pbody').evaluate((el) => el.scrollTo({ top: 0 }));
  await shot('1-thread-images-inline-and-tiles');
  await page.locator('.ib-pbody').evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await shot('2-thread-tiles');

  const pdfDownload = page.waitForEvent('download');
  await pdfTile.click();
  const pdf = await pdfDownload;
  expect(pdf.suggestedFilename()).toBe('payments-api-refunds.pdf');
  expect(readFileSync((await pdf.path())!, 'utf8')).toContain('%PDF-1.4');
  const zipDownload = page.waitForEvent('download');
  await zipTile.click();
  const zip = await zipDownload;
  expect(zip.suggestedFilename()).toBe('refund-fixtures.zip');
  expect(readFileSync((await zip.path())!).equals(world.zipBytes)).toBe(true);
  // The headers the page relies on.
  const head = await page.evaluate(async (id) => {
    const r = await fetch(`/api/inbox/attachments/${id}/download`);
    return { type: r.headers.get('content-type'), disposition: r.headers.get('content-disposition'), csp: r.headers.get('content-security-policy'), nosniff: r.headers.get('x-content-type-options') };
  }, world.ids['payments-api-refunds.pdf']);
  expect(head).toEqual({ type: 'application/pdf', disposition: `attachment; filename="payments-api-refunds.pdf"; filename*=UTF-8''payments-api-refunds.pdf`, csp: 'sandbox', nosniff: 'nosniff' });
});

test('an image opens beside the thread; it is marked up with the image annotator and commented', async () => {
  const page = world.page;
  await page.locator(`[data-gallery-image="${world.ids['retry-policy-phone.png']}"]`).click();
  const pane = page.locator(`[data-attachment-pane="${world.ids['retry-policy-phone.png']}"]`);
  await expect(pane).toBeVisible();
  expect(await imagesLoaded(page, '.ib-imgstage img')).toBe(1);
  await shot('3-image-beside-the-thread');

  await pane.getByRole('button', { name: 'Mark up' }).last().click();
  const stage = page.locator('[data-pn-image-annotator-stage] canvas').first();
  await expect(stage).toBeVisible();
  const box = (await stage.boundingBox())!;
  // A circle around the on-call note, then an arrow pointing at it.
  await page.locator('[data-pn-image-annotator-toolbar] button[title="Circle (3)"]').click();
  const at = (x: number, y: number) => ({ x: box.x + box.width * x, y: box.y + box.height * y });
  await page.mouse.move(at(0.05, 0.36).x, at(0.05, 0.36).y);
  await page.mouse.down();
  await page.mouse.move(at(0.5, 0.41).x, at(0.5, 0.41).y, { steps: 8 });
  await page.mouse.move(at(0.96, 0.46).x, at(0.96, 0.46).y, { steps: 8 });
  await page.mouse.up();
  await page.locator('[data-pn-image-annotator-toolbar] button[title="Arrow (2)"]').click();
  await page.mouse.move(at(0.8, 0.58).x, at(0.8, 0.58).y);
  await page.mouse.down();
  await page.mouse.move(at(0.66, 0.47).x, at(0.66, 0.47).y, { steps: 8 });
  await page.mouse.up();
  await shot('4-image-annotator');
  await page.keyboard.press('Enter');
  await expect(pane.locator('[data-image-composer] [data-markup-kept] img')).toBeVisible();
  await pane.getByRole('textbox', { name: 'A note with your drawing on retry-policy-phone.png' }).fill('The on-call note wraps onto three lines on a phone. Can it sit under the field instead?');
  await shot('5-image-comment-with-markup');
  await pane.getByRole('button', { name: 'Add note', exact: true }).click();
  await expect(pane.locator('.ib-apanel')).toContainText('The on-call note wraps');
  // Selecting the comment shows the marked-up copy on the stage.
  await pane.locator('.ib-apanel').getByText('The on-call note wraps').click();
  await expect(pane.locator('[data-showing-markup]')).toBeVisible();
  await shot('6-image-comment-selected-shows-markup');
});

test('the code file opens in the code view and takes a line comment', async () => {
  const page = world.page;
  await page.locator(`button[data-attachment-id="${world.ids['retry-worker.mjs']}"]`).click();
  const pane = page.locator(`[data-attachment-pane="${world.ids['retry-worker.mjs']}"]`);
  await expect(pane.locator('[data-code-view]')).toBeVisible();
  const line = pane.locator('[data-code-view] [data-line="4"]').first();
  await expect(line).toBeVisible();
  await line.click();
  await page.locator('[data-comment-popover] textarea[data-pn-mobile-editable="true"]').last().fill('Five attempts with doubling means the last retry waits eight minutes. Three is enough.');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(pane.locator('.ib-apanel')).toContainText('Three is enough');
  await shot('7-code-line-comment');
});

test('Send carries the image comment with its marked-up copy and the code comment with its lines; the agent reads both', async () => {
  const page = world.page;
  await page.locator('[data-attachment-pane]').getByRole('button', { name: /^Close / }).click();
  const waiting = world.claude.waitForReply(world.threadId, 40);
  await page.locator('.ib-pfoot').getByRole('button', { name: 'Edit draft' }).click();
  await expect(page.locator('[data-annotations-chip]')).toHaveText('2 annotations');
  await page.getByRole('textbox', { name: 'Reply to Claude Code' }).fill('Two notes, one on the phone shot and one on the worker.');
  await shot('8-reply-with-annotations');
  await page.locator('.ib-pfoot').getByRole('button', { name: 'Send' }).click();
  const reply = await waiting;
  expect(reply.status).toBe('replied');
  const body = reply.reply.body as string;
  expect(body).toContain('## shots/retry-policy-phone.png');
  expect(body).toContain('The on-call note wraps onto three lines');
  const markup = /- \[retry-policy-phone, marked up\] `([^`]+)`/.exec(body);
  expect(markup).not.toBeNull();
  // The agent can open the marked-up copy: a real PNG in the Inbox's data dir.
  expect(markup![1]!.startsWith(join(world.dataDir, 'inbox', 'markups'))).toBe(true);
  expect(readFileSync(markup![1]!).subarray(1, 4).toString()).toBe('PNG');
  expect(body).toContain('## workers/retry-worker.mjs');
  expect(body).toContain('(line 4) Feedback on: "export const MAX_ATTEMPTS = 5;"');
  expect(body).toContain('> Five attempts with doubling');
  expect(world.errors.filter((e) => !/HTTP 404 \/favicon/.test(e))).toEqual([]);
});

test('a Graphviz attachment renders as a diagram in the pane (WebAssembly is allowed by the window CSP)', async () => {
  const page = world.page;
  const sent = await world.claude.send({
    project_path: world.billing,
    subject: 'The retry worker as a graph',
    body: 'Here is the retry loop as a Graphviz diagram.',
    attachments: ['docs/refund-retry.dot'],
  });
  const dot = (sent.attachments as { name: string; kind: string; id: string }[])[0]!;
  expect(dot.kind).toBe('graphviz');
  await page.goto(`${world.url}#thread=${sent.thread_id}`);
  await page.locator(`button[data-attachment-id="${dot.id}"]`).click();
  const pane = page.locator(`[data-attachment-pane="${dot.id}"]`);
  await expect(pane).toBeVisible();
  // Graphviz names each node in its <title>: the file's own node ids are in the drawn svg.
  const svg = pane.locator('[data-diagram-svg] svg');
  await expect(svg).toBeVisible({ timeout: 30_000 });
  await expect(svg.locator('g.node title', { hasText: /^retry_wait$/ })).toHaveCount(1);
  await expect(svg.locator('g.node title', { hasText: /^marked_failed$/ })).toHaveCount(1);
  await shot('9-graphviz-diagram');
  expect(world.csp).toEqual([]);
  expect(world.errors.filter((e) => !/HTTP 404 \/favicon/.test(e))).toEqual([]);
});
