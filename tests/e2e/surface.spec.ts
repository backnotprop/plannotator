/**
 * The surface (PLAN step S1; adr/implementation/inbox-mobile.md section 5),
 * proved in WebKit, the engine a phone's WKWebView is. Nothing is mocked:
 * the built single file (apps/hook/dist/surface.html) opens from a file URL
 * as the main frame, as the app loads it; `plannotator inbox --background`
 * from the compiled binary runs under a temp PLANNOTATOR_DATA_DIR; agents
 * write a markdown plan, an HTML page and a Mermaid diagram, and a guided
 * review, through `plannotator inbox mcp` (scripts/inbox-sim.ts).
 *
 * The harness here plays the shell: it fetches every byte through the
 * Inbox's window routes (the device door is P1's), rewrites the HTML page's
 * base onto the asset scheme, hands everything over the bridge
 * (`window.plannotatorSurface.receive`), saves what the surface drafts
 * through the window's annotation and tick routes, and answers with
 * `commit_annotation`. `window.webkit.messageHandlers.plannotatorSurface`
 * exists in every frame, as WKWebView injects it, and records the frame each
 * message came from; the shell takes the main frame's only.
 *
 * Proves: ready; a text selection becomes a draft with its quote, saved and
 * drawn; a pinpoint tap opens the composer with its block; an HTML pin with
 * its label and selector steps to its parent and back to its child, saved
 * and drawn; Interact hands the click to the page and Annotate takes it
 * back; a diagram node draft; a guided review's sections, a tick, Continue,
 * one section with Reviewed, the ticks on the message in the store; theme
 * and text size; the agent's HTML frame cannot reach the bridge; with
 * `connect-src 'none'` a fetch from the surface fails; another bridge
 * version is refused.
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 * PNGs light and dark at 393 by 852 (3x) land in .local/proof/surface/.
 */

import { expect, test, type Browser, type BrowserContext, type Frame, type FrameLocator, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURE_V1_LOCAL } from '../../packages/core/guide-format-fixtures';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';

// WebKit, without the Chromium-only launch flags the config sets for the window's specs.
test.use({ browserName: 'webkit', launchOptions: {} });

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const surfaceFile = join(repo, 'apps/hook/dist/surface.html');
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'surface');

const PLAN = [
  '# Retry worker for Stripe 409s',
  '',
  'Stripe answers 409 when a request with the same idempotency key is still in flight, or when it races another write to the same customer. Today the worker treats both as a failure and drops the charge.',
  '',
  '## What changes',
  '',
  '- The worker keeps the idempotency key it already sends and retries on 409, at most three times, 2, 4 and 8 seconds apart.',
  '- A charge that still conflicts after the third try goes to the dead-letter queue with its request id.',
  '- The admin retry view retries them one by one.',
  '',
  '## Rollout',
  '',
  'Behind the `retry_409` flag, on for the test account first, then for every account after a day without a duplicate charge. See [the Stripe docs](https://docs.stripe.com/error-low-level#idempotency).',
  '',
].join('\n');

/** The record's "Low Tide" ticket page: a page of real craft, self-contained. Its script is the agent's: it tries every way out of its frame. */
const TICKET_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Low Tide · Rooftop Sessions Vol. 7</title>
<style>
  :root { --ink: #15102a; --sun1: #ff9f43; --sun2: #ff4f6d; --lime: #b6f84a; --violet: #7b5cff; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.4 -apple-system, system-ui, sans-serif; color: #fff7ec; background: var(--ink); }
  .hero { position: relative; height: 330px; overflow: hidden; background: linear-gradient(180deg, #2a1650 0%, #4a1e5c 55%, #15102a 100%); }
  .sun { position: absolute; right: -40px; top: 40px; width: 260px; height: 260px; border-radius: 50%;
    background: repeating-linear-gradient(180deg, transparent 0 128px, var(--ink) 128px 136px, transparent 136px 150px, var(--ink) 150px 156px, transparent 156px 168px, var(--ink) 168px 172px),
                linear-gradient(180deg, var(--sun1), var(--sun2)); }
  h1 { position: absolute; left: 22px; top: 30px; margin: 0; font-size: 96px; line-height: .86; font-weight: 900; letter-spacing: -3px; color: #fff3e3; }
  .vol { position: absolute; left: 24px; bottom: 34px; font-weight: 800; letter-spacing: 6px; font-size: 13px; color: var(--lime); }
  .wave { position: absolute; left: 0; right: 0; bottom: 0; height: 30px; background: radial-gradient(60px 18px at 30px 0, transparent 60%, var(--violet) 62%) repeat-x; background-size: 120px 30px; opacity: .8; }
  main { padding: 20px 18px 40px; }
  .chips { display: flex; gap: 8px; flex-wrap: wrap; }
  .chip { padding: 8px 14px; border-radius: 999px; border: 1px solid #ffffff2e; font-weight: 700; }
  .chip.on { background: var(--lime); color: var(--ink); border-color: transparent; }
  h2 { margin: 26px 0 12px; font-size: 13px; letter-spacing: 4px; color: #b9a8ff; }
  .tiers { display: flex; gap: 10px; overflow-x: auto; }
  .tier { flex: 0 0 150px; padding: 14px; border-radius: 18px; border: 1px solid #ffffff1f; background: #ffffff08; }
  .tier b { display: block; font-size: 30px; margin: 4px 0; }
  .tier.sold { opacity: .5; } .tier.sold b { text-decoration: line-through; }
  .tier.pick { background: linear-gradient(135deg, var(--violet), #e1488f); border: 0; }
  .cta { display: flex; align-items: center; gap: 12px; margin-top: 18px; }
  .btnx { flex: 1; padding: 18px 0; border: 0; border-radius: 999px; font: 800 20px -apple-system, system-ui, sans-serif; color: var(--ink); background: var(--lime); box-shadow: 0 0 0 4px #15102a, 0 0 0 7px #2ad4d4; }
  .faces span { display: inline-block; width: 34px; height: 34px; border-radius: 50%; margin-left: -10px; border: 3px solid var(--ink); }
  .lineup li { padding: 10px 0; border-bottom: 1px solid #ffffff14; list-style: none; }
  .lineup { padding: 0; margin: 0; }
  #probe { margin-top: 24px; font: 12px ui-monospace, monospace; color: #9b8fc7; }
</style></head>
<body>
<header class="hero"><div class="sun"></div><h1>LOW<br>TIDE</h1><div class="vol">ROOFTOP SESSIONS · VOL. 7</div><div class="wave"></div></header>
<main>
  <div class="chips"><span class="chip on">Sat 18 Oct · 21:00</span><span class="chip">Pier 9 Rooftop</span><span class="chip">Lisbon</span></div>
  <h2>TICKETS</h2>
  <div class="tiers">
    <div class="tier sold">Early bird<b>€18</b>Sold out</div>
    <div class="tier pick">General<b>€24</b>212 left</div>
    <div class="tier">Late entry<b>€30</b>After 23:00</div>
  </div>
  <div class="cta"><button class="btnx" id="buy"><span>Get tickets · €24</span></button>
    <div class="faces"><span style="background:#ff8a4c"></span><span style="background:#7b5cff"></span><span style="background:#2ed392"></span></div></div>
  <h2>LINEUP</h2>
  <ul class="lineup"><li>Mira Okafor · sunset set</li><li>Jonas Ribeiro · live</li><li>Halvorsen b2b Tiles</li></ul>
  <p><a id="venue" href="https://lowtide.example/venue">The venue</a></p>
  <p id="probe">probing</p>
  <p id="forged"></p>
</main>
<script>
  // The page's own behavior: Interact must reach it.
  document.getElementById('buy').addEventListener('click', function () { this.firstElementChild.textContent = 'Added · €24'; });
  // An agent's page tries every way to the shell and the network.
  var out = [];
  try { parent.plannotatorSurface.receive({ v: 1, type: 'remove_annotation', id: 'x' }); out.push('receive: reached'); }
  catch (e) { out.push('receive: ' + e.name); }
  try { window.top.webkit.messageHandlers.plannotatorSurface.postMessage({ v: 1, type: 'link', href: 'https://evil.example/top' }); out.push('top webkit: reached'); }
  catch (e) { out.push('top webkit: ' + e.name); }
  try { window.webkit.messageHandlers.plannotatorSurface.postMessage({ v: 1, type: 'link', href: 'https://evil.example/own' }); out.push('own webkit: posted'); }
  catch (e) { out.push('own webkit: ' + e.name); }
  parent.postMessage({ v: 1, type: 'link', href: 'https://evil.example/relay' }, '*');
  out.push('relay: posted');
  // The viewer's own frame protocol, forged by the page with no tap.
  parent.postMessage({ type: 'plannotator-bridge-link-click', href: 'https://evil.example/forged' }, '*');
  parent.postMessage({ type: 'plannotator-bridge-link-click', href: 'mailto:evil@evil.example' }, '*');
  document.getElementById('forged').textContent = 'forged';
  fetch('http://127.0.0.1:1/').then(function () { out.push('fetch: reached'); }, function () { out.push('fetch: refused'); }).then(function () {
    document.getElementById('probe').textContent = out.join(' | ');
  });
</script>
</body></html>
`;

const FLOW = [
  'flowchart TD',
  '  A[Open the install page] --> B[Detect installed agents]',
  '  B --> C{More than one?}',
  '  C -- no --> D[Show its install line]',
  '  C -- yes --> E[Pick a host]',
  '  D --> F[Copy the command]',
  '  E --> F',
  '  F --> G[Run it in a terminal]',
  '',
].join('\n');

interface ShellMessage {
  main: boolean;
  frameUrl: string;
  message: Record<string, any>;
}

interface World {
  root: string;
  dataDir: string;
  url: string;
  agents: SimAgent[];
  context: BrowserContext;
  page: Page;
  errors: string[];
  inbox: ShellMessage[];
  attachments: { plan: any; ticket: any; flow: any };
  guide: { thread_id: string; message_id: string };
}

let world: World;

// ─── The shell ───

async function send(message: Record<string, unknown>): Promise<void> {
  await world.page.evaluate((m) => (window as any).plannotatorSurface.receive(m), { v: 1, ...message });
}

/** The next main-frame message of `type` after `from` (an index into the shell's inbox). */
async function next(type: string, from: number, timeout = 15_000): Promise<Record<string, any>> {
  let found: ShellMessage | undefined;
  await expect
    .poll(() => (found = world.inbox.slice(from).find((m) => m.main && m.message.type === type)), { timeout, message: `a "${type}" message` })
    .toBeTruthy();
  return found!.message;
}

const mark = () => world.inbox.length;

async function inboxJson(path: string, init?: { method: string; body: unknown }): Promise<any> {
  const response = await fetch(new URL(path, world.url), init ? { method: init.method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body) } : undefined);
  expect(response.ok, `${path}: ${response.status}`).toBe(true);
  return response.json();
}

/** What the shell does to open a file: read its view through the door (here, the window's route) and hand it over. */
async function openAttachment(attachment: any): Promise<void> {
  const view = await inboxJson(`/api/inbox/attachments/${attachment.id}/view`);
  const html = view.html === null ? null : String(view.html).replace(/<base href="\/api\/html-assets\/([^"/]+)\//, '<base href="plannotator-asset://inbox/api/html-assets/$1/');
  const thread = await inboxJson(`/api/inbox/threads/${view.attachment.message_id}/attachments`);
  await send({
    type: 'open_attachment',
    attachment: view.attachment,
    version: view.version,
    text: view.text,
    html,
    annotations: thread.annotations.filter((r: any) => r.attachment_id === attachment.id),
    focus: null,
  });
}

/** The shell's comment sheet: the person's words into the draft, saved through the door, committed back. */
async function saveDraft(draft: Record<string, unknown>, attachmentId: string, words: string): Promise<any> {
  const saved = await inboxJson('/api/inbox/annotations', { method: 'POST', body: { attachment_id: attachmentId, version: 'current', annotation: { ...draft, text: words } } });
  await send({ type: 'commit_annotation', annotation: saved.annotation });
  return saved.annotation;
}

async function appearance(theme: 'light' | 'dark', textScale = 1): Promise<void> {
  await send({ type: 'set_appearance', theme, text_scale: textScale });
}

async function shot(name: string): Promise<void> {
  for (const theme of ['light', 'dark'] as const) {
    await appearance(theme);
    // Theme colours transition; the picture waits for them to settle.
    await world.page.waitForTimeout(2000);
    await world.page.screenshot({ path: join(proofDir, `${name}-${theme}.png`) });
  }
  await appearance('light');
}

function ticketFrame(): FrameLocator {
  return world.page.frameLocator('[data-surface-attachment] iframe').first();
}

/** Wait for the frame's bridge to arm pins (1) or stand down (0); a failure says what the frame and the page reported. */
async function armed(frame: FrameLocator, count: 0 | 1): Promise<void> {
  try {
    await expect(frame.locator('body[data-plannotator-pinpoint-cursor]')).toHaveCount(count);
  } catch (error) {
    const state = await htmlFrame()
      .evaluate(() => ({
        ready: document.readyState,
        bridge: typeof (window as any).__plannotatorBridgeInternals,
        body: document.body ? [...document.body.attributes].map((a) => a.name) : null,
        probe: document.getElementById('probe')?.textContent,
      }))
      .catch((e) => String(e));
    throw new Error(`the frame's bridge did not ${count ? 'arm' : 'stand down'}: ${JSON.stringify(state)}; page errors: ${JSON.stringify(world.errors)}; frames: ${world.page.frames().map((f) => f.url()).join(', ')}`, { cause: error });
  }
}

function htmlFrame(): Frame {
  const frame = world.page.frames().find((f) => f !== world.page.mainFrame());
  expect(frame, 'the HTML page frame').toBeTruthy();
  return frame!;
}

/** Drag-select `text` inside the open document with the real mouse. */
async function selectText(text: string): Promise<void> {
  const box = await world.page.evaluate((needle) => {
    const root = document.querySelector('[data-surface-attachment] [data-print-region="article"]');
    if (!root) return null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent?.indexOf(needle) ?? -1;
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      const rects = [...range.getClientRects()];
      const first = rects[0]!;
      const last = rects[rects.length - 1]!;
      return { x1: first.left + 1, y1: first.top + first.height / 2, x2: last.right - 1, y2: last.top + last.height / 2 };
    }
    return null;
  }, text);
  expect(box, `"${text}" is on screen`).not.toBeNull();
  await world.page.mouse.move(box!.x1, box!.y1);
  await world.page.mouse.down();
  await world.page.mouse.move((box!.x1 + box!.x2) / 2, (box!.y1 + box!.y2) / 2, { steps: 6 });
  await world.page.mouse.move(box!.x2, box!.y2, { steps: 6 });
  await world.page.mouse.up();
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  expect(existsSync(surfaceFile), `build the surface first (build:hook): ${surfaceFile}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-surface-')));
  const dataDir = join(root, 'data');
  const home = join(root, 'home');
  mkdirSync(home);
  const env = { PATH: process.env.PATH ?? '', HOME: home, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: 'none' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();

  const billing = scratchProject(join(root, 'src'), 'billing-svc');
  const checkout = scratchProject(join(root, 'src'), 'checkout-web');
  const docs = scratchProject(join(root, 'src'), 'docs-site');
  const ledger = scratchProject(join(root, 'src'), 'ledger');
  writeFileSync(join(billing, 'retry-plan.md'), PLAN);
  writeFileSync(join(checkout, 'ticket-page.html'), TICKET_PAGE);
  writeFileSync(join(docs, 'install-flow.mmd'), FLOW);
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const codex = await SimAgent.connect({ binary, env, name: 'Codex', host: 'codex' });
  const opencode = await SimAgent.connect({ binary, env, name: 'OpenCode', host: 'opencode' });
  const pi = await SimAgent.connect({ binary, env, name: 'Pi', host: 'pi' });
  const plan = await claude.send({ project_path: billing, body: 'The retry plan is attached. Comment on anything that looks wrong.', attachments: ['retry-plan.md'] });
  const ticket = await codex.send({ project_path: checkout, body: 'The ticket page is ready for a look.', attachments: ['ticket-page.html'] });
  const flow = await opencode.send({ project_path: docs, body: 'The install flow, as a diagram.', attachments: ['install-flow.mmd'] });
  const guide = await pi.submitGuide({
    project_path: ledger,
    snapshot: FIXTURE_V1_LOCAL,
    subject: 'A guided review of the refresh change.',
    body: 'Read it in order; mark each section when you are done.',
  });

  // An iPhone 15's screen: 393 by 852 points at 3x.
  const context = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, colorScheme: 'light' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !/Content Security Policy|Refused to/.test(message.text())) errors.push(message.text());
  });
  const inbox: ShellMessage[] = [];
  // The shell's message handler, as WKWebView injects it: in every frame, telling the shell which frame posted.
  await page.exposeBinding('__surfaceShellPost', ({ frame }, message: Record<string, any>) => {
    inbox.push({ main: frame === page.mainFrame(), frameUrl: frame.url(), message });
  });
  await page.addInitScript(() => {
    const post = (message: unknown) => (window as any).__surfaceShellPost(message);
    (window as any).webkit = { messageHandlers: { plannotatorSurface: { postMessage: post } } };
  });
  world = {
    root,
    dataDir,
    url,
    agents: [claude, codex, opencode, pi],
    context,
    page,
    errors,
    inbox,
    attachments: { plan: plan.attachments[0], ticket: ticket.attachments[0], flow: flow.attachments[0] },
    guide: { thread_id: guide.thread_id, message_id: guide.message_id },
  };
});

test.afterAll(async () => {
  if (!world) return;
  await Promise.all(world.agents.map((a) => a.close().catch(() => {})));
  await world.context.close();
  try {
    const registry = JSON.parse(readFileSync(join(world.dataDir, 'inbox', 'inbox.json'), 'utf8')) as { pid: number };
    process.kill(registry.pid, 'SIGTERM');
  } catch {
    // Already gone.
  }
  rmSync(world.root, { recursive: true, force: true });
  if (!existsSync(proofDir)) return;
  const names = [...new Set(readdirSync(proofDir).filter((f) => f.endsWith('-light.png')).map((f) => f.replace(/-light\.png$/, '')))].sort();
  writeFileSync(
    join(proofDir, 'index.html'),
    `<!doctype html><meta charset="utf-8"><title>Plannotator surface: proof</title><style>body{font:14px system-ui;margin:24px;background:#e9eaee}h2{font-size:15px;margin:24px 0 8px}.pair{display:flex;gap:16px}.pair img{width:393px;box-shadow:0 0 0 1px #0002;border-radius:18px}</style><h1>The surface in WebKit: every proved state, light and dark, 393 by 852</h1>${names
      .map((n) => `<section><h2>${n}</h2><div class="pair"><img src="${n}-light.png" alt="${n} light"><img src="${n}-dark.png" alt="${n} dark"></div></section>`)
      .join('\n')}`,
  );
});

test('the surface loads from a file URL and says ready on the bridge', async () => {
  const from = mark();
  await world.page.goto(pathToFileURL(surfaceFile).href);
  const ready = await next('ready', from);
  expect(ready).toMatchObject({ v: 1, type: 'ready', bridge: 1 });
  expect(typeof ready.build).toBe('string');
  await appearance('light');
  // A message in another bridge version is refused, never acted on.
  const before = mark();
  await world.page.evaluate(() => (window as any).plannotatorSurface.receive({ v: 2, type: 'set_mode', mode: 'interact' }));
  expect(await next('error', before)).toMatchObject({ code: 'bridge_version' });
});

test('with connect-src none a fetch from the surface fails', async () => {
  const outcome = await world.page.evaluate(async (inbox) => {
    try {
      await fetch(new URL('/api/inbox/health', inbox).href);
      return 'reached';
    } catch (error) {
      return `refused: ${(error as Error).name}`;
    }
  }, world.url);
  expect(outcome).toBe('refused: TypeError');
});

test('markdown: a selection becomes a draft with its quote; saved, it is drawn; a pinpoint tap opens the composer', async () => {
  const { page } = world;
  const plan = world.attachments.plan;
  await openAttachment(plan);
  await expect(page.locator('[data-surface-attachment] h1')).toHaveText('Retry worker for Stripe 409s');
  await expect(page.locator('.sf-toolstrip button[aria-pressed]')).toHaveCount(4);
  await shot('01-markdown');

  const quote = 'at most three times, 2, 4 and 8 seconds apart';
  let from = mark();
  await selectText(quote);
  const selection = await next('selection', from);
  expect(selection.quote).toBe(quote);
  expect(selection.draft).toMatchObject({ type: 'COMMENT', text: '', originalText: quote });
  expect(typeof selection.draft.startMeta).toBe('object');
  await shot('02-markdown-selection');

  // A press elsewhere puts the selection down: the shell hears it cleared, the pending mark goes.
  from = mark();
  await page.locator('[data-surface-attachment] h2', { hasText: 'Rollout' }).click();
  expect(await next('selection', from)).toMatchObject({ quote: null, draft: null });
  await expect(page.locator(`[data-surface-attachment] [data-highlight-id="${selection.draft.id}"]`)).toHaveCount(0);
  from = mark();
  await selectText(quote);
  const again = await next('selection', from);
  expect(again.quote).toBe(quote);

  // Comment in the edit menu: the shell's sheet writes the words and the door saves them.
  const words = 'Does Stripe say how long a key stays in flight?';
  const saved = await saveDraft(again.draft, plan.id, words);
  expect(saved).toMatchObject({ attachment_id: plan.id, version: 'current', annotation: { id: again.draft.id, text: words, originalText: quote } });
  const markEl = page.locator(`[data-surface-attachment] [data-highlight-id="${again.draft.id}"]`).first();
  await expect(markEl).toBeVisible();
  await expect(markEl).toHaveClass(/comment/);
  // A tap on the saved mark tells the shell which one (Edit and Remove are its).
  from = mark();
  await markEl.click();
  expect(await next('annotation', from)).toMatchObject({ id: again.draft.id });
  await shot('03-markdown-saved');

  // Pinpoint: a tap on a block opens the composer at once, with the block's text.
  await page.locator('.sf-toolstrip button', { hasText: 'Pinpoint' }).click();
  from = mark();
  await page.locator('[data-surface-attachment] p', { hasText: 'Stripe answers 409' }).click();
  const draft = await next('draft', from);
  expect(draft.target.kind).toBe('block');
  expect(draft.draft.originalText).toContain('Stripe answers 409 when a request');
  expect(draft.target.label).toMatch(/^Stripe answers 409/);
  // The sheet's Cancel: the pending highlight goes, the saved one stays.
  await send({ type: 'remove_annotation', id: draft.draft.id });
  await expect(page.locator(`[data-surface-attachment] [data-highlight-id="${draft.draft.id}"]`)).toHaveCount(0);
  await expect(markEl).toBeVisible();

  // A link in the content goes to the shell for the system browser.
  await page.locator('.sf-toolstrip button', { hasText: 'Select' }).click();
  from = mark();
  await page.locator('[data-surface-attachment] a', { hasText: 'the Stripe docs' }).click();
  expect(await next('link', from)).toMatchObject({ href: 'https://docs.stripe.com/error-low-level#idempotency' });
  expect(page.url()).toContain('surface.html');
});

test('HTML: a pin steps to its parent and back to its child, is saved and drawn; Interact and Annotate switch', async () => {
  const { page } = world;
  const ticket = world.attachments.ticket;
  const from0 = mark();
  await openAttachment(ticket);
  const frame = ticketFrame();
  await expect(frame.locator('h1')).toContainText('LOW');
  await send({ type: 'set_mode', mode: 'annotate' });
  // The frame's bridge is ready and armed for pins (it marks the page's body).
  await armed(frame, 1);

  let from = mark();
  await frame.locator('#buy span').click();
  const pin = await next('pin', from);
  expect(pin.target.label).toBeTruthy();
  expect(pin.target.selector).toBeTruthy();
  expect(pin.draft).toMatchObject({ type: 'COMMENT', text: '', originalText: 'Get tickets · €24' });
  expect(pin.draft.htmlAnchor.selector).toBe(pin.target.selector);
  const first = pin.target.selector as string;

  from = mark();
  await send({ type: 'step_pin', direction: 'parent' });
  const parent = await next('pin', from);
  expect(parent.target.selector).not.toBe(first);
  expect(parent.draft.htmlAnchor.tagName.toLowerCase()).toBe('button');
  expect(parent.target.label).toBe('Button');

  from = mark();
  await send({ type: 'step_pin', direction: 'parent' });
  const grand = await next('pin', from);
  expect(grand.draft.htmlAnchor.tagName.toLowerCase()).toBe('div');

  from = mark();
  await send({ type: 'step_pin', direction: 'child' });
  const back = await next('pin', from);
  expect(back.target.selector).toBe(parent.target.selector);
  await shot('04-html-pin');

  const saved = await saveDraft(back.draft, ticket.id, 'Show the booking fee in this price, not at checkout.');
  expect(saved.annotation.htmlAnchor.tagName.toLowerCase()).toBe('button');
  await expect(frame.locator('[data-plannotator-marker]').first()).toBeVisible();
  await shot('05-html-saved');

  // Interact: the click reaches the page; no pin goes to the shell.
  await send({ type: 'set_mode', mode: 'interact' });
  await armed(frame, 0);
  from = mark();
  await frame.locator('.tier.pick').click();
  // The saved marker sits on the button's top right; the press lands on its left.
  await frame.locator('#buy').click({ position: { x: 40, y: 24 } });
  await expect(frame.locator('#buy span')).toHaveText('Added · €24');
  await page.waitForTimeout(400);
  expect(world.inbox.slice(from).filter((m) => m.main && m.message.type === 'pin')).toEqual([]);
  // Annotate again: the next tap pins.
  await send({ type: 'set_mode', mode: 'annotate' });
  await armed(frame, 1);
  from = mark();
  await frame.locator('.chip.on').click();
  expect((await next('pin', from)).draft.originalText).toBe('Sat 18 Oct · 21:00');
  void from0;
});

test("the agent's HTML frame cannot reach the bridge", async () => {
  const frame = ticketFrame();
  // The page's own report of every way out it tried (see TICKET_PAGE).
  await expect(frame.locator('#probe')).toContainText('fetch:');
  const probe = (await frame.locator('#probe').textContent()) ?? '';
  expect(probe).toContain('receive: SecurityError');
  expect(probe).toContain('top webkit: SecurityError');
  expect(probe).toContain('fetch: refused');
  // What it posted on its own frame's handler arrives marked as another frame, which the shell drops...
  const fromFrame = world.inbox.filter((m) => m.message.href === 'https://evil.example/own');
  expect(fromFrame.length).toBeGreaterThan(0);
  expect(fromFrame.every((m) => !m.main)).toBe(true);
  // ...and nothing it did came out of the main frame: no relay, no forged message, no link.
  expect(world.inbox.filter((m) => m.main && String(m.message.href ?? '').includes('evil.example'))).toEqual([]);
  expect(world.inbox.filter((m) => m.main && m.message.type === 'error')).toEqual([expect.objectContaining({ message: expect.objectContaining({ code: 'bridge_version' }) })]);
  expect(htmlFrame().url()).not.toContain('surface.html');

  // The viewer's link message forged by the page's script at load: no `link`. The
  // surface never forwards a link from an agent's page; the shell decides that
  // navigation itself (contract section 5), so a real tap there sends none
  // either. The markdown test proves a link in the surface's own document goes out.
  await expect(frame.locator('#forged')).toHaveText('forged');
  await send({ type: 'set_mode', mode: 'interact' });
  await armed(frame, 0);
  await frame.locator('#venue').click();
  await send({ type: 'set_mode', mode: 'annotate' });
  await world.page.waitForTimeout(300);
  expect(world.inbox.filter((m) => m.main && m.message.type === 'link' && !String(m.message.href).startsWith('https://docs.stripe.com'))).toEqual([]);
});

test('diagram: a tap on a node drafts a comment on it; saved, its badge shows', async () => {
  const { page } = world;
  const flow = world.attachments.flow;
  await openAttachment(flow);
  const node = page.locator('[data-surface-attachment] svg g.node', { hasText: 'Pick a host' }).first();
  await expect(node).toBeVisible({ timeout: 30_000 });
  const from = mark();
  await node.click();
  const draft = await next('draft', from);
  expect(draft.target).toEqual({ kind: 'node', label: 'Pick a host (node E)' });
  expect(draft.draft).toMatchObject({ type: 'COMMENT', text: '', originalText: 'Pick a host', diagramAnchor: { kind: 'node', id: 'E' } });
  await shot('06-diagram-node');
  const saved = await saveDraft(draft.draft, flow.id, 'Name the hosts with their marks here, not a bare list.');
  expect(saved.annotation.diagramAnchor).toMatchObject({ kind: 'node', id: 'E' });
  await expect(page.locator('[data-surface-attachment] [data-diagram-badge], [data-surface-attachment] [data-diagram-comment-badge]').first()).toBeVisible();
  await shot('07-diagram-saved');
});

test('a guided review: sections, a tick, Continue, one section with Reviewed; the ticks reach the store', async () => {
  const { page } = world;
  const answer = await inboxJson(`/api/inbox/messages/${world.guide.message_id}/guide`);
  await send({ type: 'open_guide', message_id: world.guide.message_id, guide: answer.guide, snapshot: answer.snapshot, reviewed: null });
  await expect(page.locator('.sf-gtitle')).toHaveText('Auth token refresh');
  await expect(page.locator('.sf-gsection')).toHaveCount(2);
  await shot('08-guide-sections');

  const saveTicks = async (reviewed: boolean[]) =>
    inboxJson(`/api/inbox/messages/${world.guide.message_id}/guide/reviewed`, { method: 'POST', body: { reviewed } });

  // The snapshot came with its first section reviewed: Continue offers the second.
  await expect(page.locator('.sf-gtickbtn').first()).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.sf-gcontinue')).toContainText('Continue with 02');
  let from = mark();
  await page.locator('.sf-gtickbtn').first().click();
  const untick = await next('reviewed', from);
  expect(untick).toMatchObject({ message_id: world.guide.message_id, reviewed: [false, false] });
  await expect(page.locator('.sf-gcontinue')).toContainText('Continue with 01');
  from = mark();
  await page.locator('.sf-gtickbtn').first().click();
  const tick = await next('reviewed', from);
  expect(tick.reviewed).toEqual([true, false]);
  await saveTicks(tick.reviewed);
  await expect(page.locator('.sf-gcontinue')).toContainText('Continue with 02');

  from = mark();
  await page.locator('.sf-gcontinue').click();
  expect(await next('section', from)).toMatchObject({ message_id: world.guide.message_id, section: 1, sections: 2 });
  await expect(page.locator('[data-section-page="1"]')).toBeVisible();
  await expect(page.locator('[data-section-page="1"] .sf-gnavbtn', { hasText: '01' })).toBeVisible();
  await shot('09-guide-section');

  from = mark();
  await page.locator('.sf-greviewed').click();
  const second = await next('reviewed', from);
  expect(second.reviewed).toEqual([true, true]);
  await saveTicks(second.reviewed);

  // The shell's back button: the sections again, both ticked.
  await send({ type: 'open_section', section: null });
  await expect(page.locator('.sf-gtickbtn[aria-pressed="true"]')).toHaveCount(2);
  const thread = await inboxJson(`/api/inbox/threads/${world.guide.thread_id}`);
  const message = thread.thread.messages.find((m: any) => m.id === world.guide.message_id);
  expect(message.guide_reviewed).toEqual([true, true]);
});

test('theme and text size apply as the shell sends them', async () => {
  const { page } = world;
  await openAttachment(world.attachments.plan);
  const paragraph = page.locator('[data-surface-attachment] p', { hasText: 'Stripe answers 409' });
  await appearance('light', 1);
  await expect(page.locator('html')).toHaveClass(/light/);
  const base = (await paragraph.boundingBox())!;
  await appearance('dark', 1.6);
  // Plannotator's palettes are dark unless the root says light.
  await expect(page.locator('html')).not.toHaveClass(/light/);
  const bigger = (await paragraph.boundingBox())!;
  // Larger text reflows the same paragraph onto more, taller lines.
  expect(bigger.height).toBeGreaterThan(base.height * 1.5);
  // The toolstrip stays on top of the larger text: each button is what a tap at its centre hits.
  const covered = await page.evaluate(() =>
    [...document.querySelectorAll('.sf-toolstrip button')].filter((button) => {
      const r = button.getBoundingClientRect();
      return !button.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
    }).length,
  );
  expect(covered).toBe(0);
  const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.waitForTimeout(2000);
  await page.screenshot({ path: join(proofDir, '10-text-size-dark.png') });
  await appearance('light', 1.6);
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe(background);
  await page.waitForTimeout(2000);
  await page.screenshot({ path: join(proofDir, '10-text-size-light.png') });
  await appearance('light', 1);
  expect(world.errors).toEqual([]);
});
