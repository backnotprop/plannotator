/**
 * Plannotator Inbox attachments (step 2), proved in a real browser against
 * the compiled binary. Nothing is mocked: `plannotator inbox --background`
 * runs under a temp PLANNOTATOR_DATA_DIR and HOME, agents attach files
 * through `plannotator inbox mcp` with the MCP SDK's stdio client
 * (scripts/inbox-sim.ts), the files are real files in scratch git projects,
 * and Chromium drives the window.
 *
 * Proves: the tiles at the foot of the thread; the markdown plan beside the
 * thread with Full screen, drawn in Plannotator's plan look (Grid by default,
 * Clean under the `plannotator-grid-enabled=false` cookie), a selection comment listed in the reply box's
 * annotations chip; the HTML prototype full screen with its relative image
 * resolved, its iframe loading the sibling page (never the Inbox, #1554), the
 * frame unable to read the Inbox API, a marker pinned on "Retry all"; a node
 * comment on a Mermaid diagram; the file edited on disk and the changed line,
 * with "Open the version it sent" showing the bytes sent; Send carrying the
 * picks and the annotations, read back by wait_for_reply; a path outside the
 * project, a symlink retargeted to a directory, `.env` and a request by path
 * each refused; delete thread removing its blobs and the store size falling.
 *
 * Build the binary first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 * PNGs of every proved state, light and dark at 1440 by 900, land in
 * .local/proof/attachments/ with a contact sheet.
 */

import { expect, test, type Browser, type BrowserContext, type FrameLocator, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, appendFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DEMO_MESSAGES, SimAgent, scratchProject } from '../../scripts/inbox-sim';

const repo = resolve(__dirname, '../..');
const builtBinary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'attachments');

const PLAN = [
  '# Retry worker for Stripe 409s',
  '',
  'Stripe answers 409 when a request with the same idempotency key is still in flight, or when it races another write to the same customer. Today the worker treats both as a failure and drops the charge.',
  '',
  '## What changes',
  '',
  '- The worker keeps the idempotency key it already sends and retries on 409, at most three times, 2, 4 and 8 seconds apart.',
  '- A charge that still conflicts goes to the dead-letter queue with the Stripe request id.',
  '- The admin retry view lists dead-lettered charges and retries them one by one.',
  '',
  '## Rollout',
  '',
  'Behind the `retry_409` flag, on for the test account first, then for every account after a day without a duplicate charge.',
  '',
  '```',
  'RETRY_409=on STRIPE_MODE=test bun run worker',
  '```',
  '',
  '## Not in this change',
  '',
  'Refund handling and the 402 path stay as they are.',
  '',
].join('\n');

const ADMIN_VIEW = `<!doctype html>
<html><head><meta charset="utf-8"><title>billing admin</title>
<link rel="stylesheet" href="admin.css">
</head><body>
<nav><b>billing admin</b> <a href="#">Charges</a> <a href="#">Customers</a> <a href="#">Retries</a></nav>
<main>
  <header><h1>Dead-lettered charges <small>40 waiting</small></h1>
  <button id="retry-all" class="pri">Retry all (40)</button>
  <img id="badge" src="img/badge.svg" alt="Stripe test mode" width="88" height="22"></header>
  <table><thead><tr><th>Customer</th><th>Amount</th><th>Stripe request</th><th>Attempts</th><th></th></tr></thead>
  <tbody>
    <tr><td>Halvorsen Bakery</td><td>$48.00</td><td><code>req_7Hq2LmA9</code></td><td>3</td><td><button>Retry</button></td></tr>
    <tr><td>Okafor Studio</td><td>$129.00</td><td><code>req_3KdP0xQe</code></td><td>3</td><td><button>Retry</button></td></tr>
    <tr><td>Ribeiro Tiles</td><td>$15.50</td><td><code>req_9TzW4nBc</code></td><td>3</td><td><button>Retry</button></td></tr>
  </tbody></table>
  <iframe id="detail" src="detail.html" title="Charge detail" width="420" height="90"></iframe>
  <p id="probe">probing</p>
</main>
<script>
  // The page tries to read the Inbox's own API: the sandboxed frame must not get it.
  fetch('/api/inbox/threads').then((r) => r.text()).then(
    (t) => { document.getElementById('probe').textContent = 'READ THE INBOX: ' + t.slice(0, 40); },
    () => { document.getElementById('probe').textContent = 'inbox api refused'; },
  );
</script>
</body></html>
`;
const ADMIN_CSS = `body{font:14px system-ui;margin:0;color:#18181b;background:#fafafa}nav{background:#111;color:#ddd;padding:14px 26px;display:flex;gap:22px}nav a{color:#aaa;text-decoration:none}main{padding:20px 26px}header{display:flex;align-items:center;gap:14px}h1{font-size:22px;margin:0 auto 0 0}small{font-size:13px;color:#71717a;font-weight:400}button{border:1px solid #d4d4d8;background:#fff;border-radius:6px;padding:6px 12px;font:inherit;font-weight:600}button.pri{background:#18342f;color:#fff;border-color:#18342f;padding:10px 16px}table{width:100%;border-collapse:collapse;margin:18px 0;background:#fff}th,td{text-align:left;padding:12px 14px;border-bottom:1px solid #e4e4e7}th{background:#f4f4f5;font-size:12.5px;color:#52525b}iframe{border:1px solid #e4e4e7;border-radius:6px;background:#fff}`;
const BADGE = `<svg xmlns="http://www.w3.org/2000/svg" width="88" height="22"><rect width="88" height="22" rx="5" fill="#635bff"/><text x="44" y="15" font-family="system-ui" font-size="11" fill="#fff" text-anchor="middle">test mode</text></svg>`;
const DETAIL = `<!doctype html><meta charset="utf-8"><body style="font:13px system-ui;margin:10px"><p id="detail-text">Charge detail from the attachment's own folder</p></body>`;
const FLOW = [
  'flowchart TD',
  '  A[Open the install page] --> B[Detect installed agents]',
  '  B --> C{More than one?}',
  '  C -- no --> D[Show its install line]',
  '  C -- yes --> E[Pick a host]',
  '  D --> F[Copy the command]',
  '  E --> F',
  '  F --> G[Run it in a terminal]',
  '  G --> H[Restart the agent]',
  '',
].join('\n');

interface World {
  root: string;
  dataDir: string;
  env: Record<string, string>;
  url: string;
  billing: string;
  docs: string;
  claude: SimAgent;
  opencode: SimAgent;
  context: BrowserContext;
  page: Page;
  errors: string[];
  threads: Record<string, string>;
  attachments: Record<string, string>;
}

let world: World;

async function shot(name: string): Promise<void> {
  const page = world.page;
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(proofDir, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

function writeContactSheet(): void {
  if (!existsSync(proofDir)) return;
  const names = [...new Set(readdirSync(proofDir).filter((f) => f.endsWith('-light.png')).map((f) => f.replace(/-light\.png$/, '')))].sort();
  const rows = names
    .map((n) => `<section><h2>${n}</h2><div class="pair"><img src="${n}-light.png" alt="${n} light"><img src="${n}-dark.png" alt="${n} dark"></div></section>`)
    .join('\n');
  writeFileSync(
    join(proofDir, 'index.html'),
    `<!doctype html><meta charset="utf-8"><title>Plannotator Inbox attachments: proof</title><style>body{font:14px system-ui;margin:24px;background:#e9eaee}h2{font-size:15px;margin:24px 0 8px}.pair{display:flex;gap:12px}.pair img{width:calc(50% - 6px);box-shadow:0 0 0 1px #0002;border-radius:6px}</style><h1>Plannotator Inbox attachments: every proved state, light and dark, 1440 by 900</h1>${rows}`,
  );
}

/** A request to the running Inbox the way a non-browser client makes it. */
function inboxFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(new URL(path, world.url), init);
}

/** The text of the HTML attachment's frame, and the frame inside it. */
function pageFrame(page: Page): FrameLocator {
  return page.frameLocator('[data-attachment-pane] iframe').first();
}

/** Plannotator's comment composer (CommentPopover), once it is open. */
function composer(page: Page) {
  return page.locator('textarea[data-pn-mobile-editable="true"]').last();
}

/** Drag-select `text` inside the open markdown document with the real mouse. */
async function selectText(page: Page, text: string): Promise<void> {
  const box = await page.evaluate((needle) => {
    const root = document.querySelector('[data-attachment-pane] .ib-docscroll');
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
  await page.mouse.move(box!.x1, box!.y1);
  await page.mouse.down();
  await page.mouse.move((box!.x1 + box!.x2) / 2, (box!.y1 + box!.y2) / 2, { steps: 6 });
  await page.mouse.move(box!.x2, box!.y2, { steps: 6 });
  await page.mouse.up();
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(builtBinary), `build the binary first: ${builtBinary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-att-')));
  const dataDir = join(root, 'data');
  const home = join(root, 'home');
  mkdirSync(home);
  const env = { PATH: process.env.PATH ?? '', HOME: home, PLANNOTATOR_DATA_DIR: dataDir };
  const started = spawnSync(builtBinary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const url = started.stdout.trim();
  const billing = scratchProject(join(root, 'src'), 'billing-svc');
  const docs = scratchProject(join(root, 'src'), 'docs-site');
  mkdirSync(join(billing, 'docs'));
  mkdirSync(join(billing, 'proto', 'img'), { recursive: true });
  writeFileSync(join(billing, 'docs', 'retry-plan.md'), PLAN);
  writeFileSync(join(billing, 'proto', 'admin-view.html'), ADMIN_VIEW);
  writeFileSync(join(billing, 'proto', 'admin.css'), ADMIN_CSS);
  writeFileSync(join(billing, 'proto', 'img', 'badge.svg'), BADGE);
  writeFileSync(join(billing, 'proto', 'detail.html'), DETAIL);
  writeFileSync(join(docs, 'install-flow.mmd'), FLOW);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('response', (response) => {
    if (response.status() >= 400) errors.push(`HTTP ${response.status()} ${new URL(response.url()).pathname}`);
  });
  world = {
    root,
    dataDir,
    env,
    url,
    billing,
    docs,
    claude: await SimAgent.connect({ binary: builtBinary, env, name: 'Claude Code', host: 'claude-code' }),
    opencode: await SimAgent.connect({ binary: builtBinary, env, name: 'OpenCode', host: 'opencode' }),
    context,
    page,
    errors,
    threads: {},
    attachments: {},
  };
});

test.afterAll(async () => {
  if (!world) return;
  await Promise.all([world.claude.close().catch(() => {}), world.opencode.close().catch(() => {})]);
  await world.context.close();
  try {
    const registry = JSON.parse(readFileSync(join(world.dataDir, 'inbox', 'inbox.json'), 'utf8')) as { pid: number };
    process.kill(registry.pid, 'SIGTERM');
  } catch {
    // Already gone.
  }
  rmSync(world.root, { recursive: true, force: true });
  writeContactSheet();
});

test('agents attach a markdown plan, an HTML prototype and a Mermaid diagram; blobs hold the bytes sent', async () => {
  const a = await world.claude.send({
    project_path: world.billing,
    body: DEMO_MESSAGES.stopped,
    attachments: ['docs/retry-plan.md', join(world.billing, 'proto', 'admin-view.html')],
  });
  const b = await world.opencode.send({ project_path: world.docs, body: DEMO_MESSAGES.holding, attachments: ['install-flow.mmd'] });
  world.threads = { billing: a.thread_id, docs: b.thread_id };
  expect(a.attachments.map((x: { name: string }) => x.name)).toEqual(['retry-plan.md', 'admin-view.html']);
  expect(a.attachments.map((x: { kind: string }) => x.kind)).toEqual(['markdown', 'html']);
  expect(b.attachments[0].kind).toBe('mermaid');
  world.attachments = { plan: a.attachments[0].id, html: a.attachments[1].id, flow: b.attachments[0].id };
  // The agent reads its attachments back on the message, by id.
  const thread = await world.claude.readThread(a.thread_id);
  expect(thread.messages[0].attachments[0].path).toBe(join(world.billing, 'docs', 'retry-plan.md'));
  // The sent version is a content-addressed blob of the exact bytes.
  const blobs = readdirSync(join(world.dataDir, 'inbox', 'blobs'));
  expect(blobs).toHaveLength(3);
  const sent = await inboxFetch(`/api/inbox/attachments/${world.attachments.plan}?version=sent`);
  expect(sent.status).toBe(200);
  expect(sent.headers.get('content-type')).toContain('text/plain');
  expect(await sent.text()).toBe(PLAN);
  // An HTML attachment's raw bytes are never served as a page on the Inbox's origin.
  const raw = await inboxFetch(`/api/inbox/attachments/${world.attachments.html}`);
  expect(raw.headers.get('content-type')).toContain('text/plain');
  expect(raw.headers.get('content-security-policy')).toBe('sandbox');
});

test('refused: a path outside the project, .env, a symlink retargeted to a directory, and a request by path', async () => {
  const outside = join(world.root, 'outside.md');
  writeFileSync(outside, '# not in the project\n');
  await expect(world.claude.send({ project_path: world.billing, body: 'One more file.', attachments: [outside] })).rejects.toThrow(
    /validation_error: attachments\[0\]: .*outside the project/,
  );
  await expect(world.claude.send({ project_path: world.billing, body: 'One more file.', attachments: ['../docs-site/install-flow.mmd'] })).rejects.toThrow(
    /outside the project/,
  );
  writeFileSync(join(world.billing, '.env'), 'SECRET=placeholder\n');
  await expect(world.claude.send({ project_path: world.billing, body: 'The env file.', attachments: ['.env'] })).rejects.toThrow(/\.env files are never attached/);
  // A symlink whose target is .env is refused by the target's name too.
  symlinkSync(join(world.billing, '.env'), join(world.billing, 'notes.md'));
  await expect(world.claude.send({ project_path: world.billing, body: 'Notes.', attachments: ['notes.md'] })).rejects.toThrow(/resolves to \.env/);
  // Nothing was written for a refused send: still three blobs, still two threads.
  expect(readdirSync(join(world.dataDir, 'inbox', 'blobs'))).toHaveLength(3);

  // A symlink is recorded by its target at send time ...
  writeFileSync(join(world.billing, 'plan-target.md'), '# The linked plan\n');
  symlinkSync(join(world.billing, 'plan-target.md'), join(world.billing, 'plan-link.md'));
  const linked = await world.claude.send({ project_path: world.billing, body: 'A linked plan.', thread: 'links', attachments: ['plan-link.md'] });
  const linkId = linked.attachments[0].id as string;
  expect(linked.attachments[0].path).toBe(join(world.billing, 'plan-target.md'));
  expect((await inboxFetch(`/api/inbox/attachments/${linkId}`)).status).toBe(200);
  // ... and once the link is retargeted to a directory the current file is refused; the sent version still opens.
  unlinkSync(join(world.billing, 'plan-link.md'));
  symlinkSync(join(world.billing, 'docs'), join(world.billing, 'plan-link.md'));
  const refused = await inboxFetch(`/api/inbox/attachments/${linkId}`);
  expect(refused.status).toBe(409);
  expect(((await refused.json()) as { code: string }).code).toBe('attachment_changed_type');
  expect(await (await inboxFetch(`/api/inbox/attachments/${linkId}?version=sent`)).text()).toBe('# The linked plan\n');
  // The target itself becoming a directory is refused the same way.
  unlinkSync(join(world.billing, 'plan-link.md'));
  symlinkSync(join(world.billing, 'plan-target.md'), join(world.billing, 'plan-link.md'));
  expect((await inboxFetch(`/api/inbox/attachments/${linkId}`)).status).toBe(200);
  unlinkSync(join(world.billing, 'plan-target.md'));
  mkdirSync(join(world.billing, 'plan-target.md'));
  expect((await inboxFetch(`/api/inbox/attachments/${linkId}`)).status).toBe(409);

  // There is no route that takes a path: by query, by an encoded path in the id slot, or an id that is not one.
  const byQuery = await inboxFetch(`/api/inbox/attachments?path=${encodeURIComponent(join(world.billing, 'docs', 'retry-plan.md'))}`);
  expect(byQuery.status).toBe(404);
  const byEncoded = await inboxFetch(`/api/inbox/attachments/${encodeURIComponent(join(world.billing, 'docs', 'retry-plan.md'))}`);
  expect(byEncoded.status).toBe(404);
  expect(await byEncoded.text()).not.toContain('Retry worker');
  const byTraversal = await inboxFetch(`/api/inbox/attachments/..%2F..%2Fetc%2Fpasswd`);
  expect(byTraversal.status).toBe(404);
  const unknown = await inboxFetch('/api/inbox/attachments/att_00000000000000000000000000');
  expect(unknown.status).toBe(404);
  // The links thread is not part of the rest of the proof.
  await inboxFetch(`/api/inbox/threads/${linked.thread_id}/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
});

test('the thread shows its attachments at the foot; the plan opens beside the thread with Full screen', async () => {
  const page = world.page;
  await page.goto(`${world.url}#thread=${world.threads.billing}`);
  const tiles = page.locator('.ib-att-t');
  await expect(tiles).toHaveCount(2);
  await expect(page.locator('.ib-attach-h')).toHaveText('2 attachments');
  await expect(tiles.nth(0)).toContainText('retry-plan.md');
  await expect(tiles.nth(0)).toContainText('Markdown');
  await expect(tiles.nth(1)).toContainText('HTML');
  await page.locator('.ib-pbody').evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await shot('2.1-attachments-at-the-foot');

  await page.getByRole('button', { name: 'Open retry-plan.md' }).click();
  const pane = page.locator(`[data-attachment-pane="${world.attachments.plan}"]`);
  await expect(pane).toBeVisible();
  await expect(pane.getByRole('button', { name: 'Full screen' })).toBeVisible();
  await expect(pane.locator('.ib-docscroll')).toContainText('Retry worker for Stripe 409s');
  // The list and the sidebar fold away; the thread stays beside the file.
  await expect(page.getByRole('complementary', { name: 'Inbox navigation' })).toBeHidden();
  await expect(page.locator('.ib-pane.ib-withfile')).toBeVisible();
  await expect(page.locator('[data-changed-line]')).toHaveCount(0);
  expect(page.url()).toContain(`file=${world.attachments.plan}`);
});

test("the plan follows Plannotator's look: Grid (the default) is the card on the grid paper, Clean the document edge to edge", async () => {
  const page = world.page;
  const pane = page.locator(`[data-attachment-pane="${world.attachments.plan}"]`);
  const scroll = pane.locator('.ib-docscroll');
  const article = scroll.locator('article');
  // No choice made: the registry's default, Grid (the store writes the default back as the cookie on first read), drawn with plan review's classes.
  const seeded = (await world.context.cookies()).find((c) => c.name === 'plannotator-grid-enabled');
  expect(seeded?.value ?? 'true').toBe('true');
  await expect(scroll).toHaveAttribute('data-look', 'grid');
  await expect(scroll).toHaveClass(/\bbg-grid\b/);
  await expect(article).toHaveClass(/\bshadow-xl\b/);
  await expect(article).toHaveClass(/\bborder\b/);
  await shot('2.1b-plan-look-grid');

  // The cookie Plannotator's Settings writes for "Clean": the same pane draws the flat document on the card colour.
  await world.context.addCookies([{ name: 'plannotator-grid-enabled', value: 'false', url: world.url }]);
  await page.reload();
  await expect(scroll).toHaveAttribute('data-look', 'clean');
  await expect(scroll).toHaveClass(/\bbg-card\b/);
  await expect(article).not.toHaveClass(/\bshadow-xl\b/);
  await expect(article).toContainText('Retry worker for Stripe 409s');
  const [scrollBg, articleBg] = await Promise.all([scroll, article].map((l) => l.evaluate((el) => getComputedStyle(el).backgroundColor)));
  expect(articleBg).toBe(scrollBg);
  await shot('2.1c-plan-look-clean');

  // Back to the default for the rest of the proof.
  await world.context.clearCookies({ name: 'plannotator-grid-enabled' });
  await page.reload();
  await expect(scroll).toHaveAttribute('data-look', 'grid');
});

test('a selection comment on the plan is saved and listed in the reply box chip', async () => {
  const page = world.page;
  const pane = page.locator(`[data-attachment-pane="${world.attachments.plan}"]`);
  await selectText(page, 'retries them one by one');
  await page.locator('button[title="Comment"]').click();
  await composer(page).fill('One by one is right. Keep Retry all out of v1.');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(pane.locator('.ib-apanel')).toContainText('One by one is right');

  await selectText(page, 'at most three times, 2, 4 and 8 seconds apart');
  await page.locator('button[title="Comment"]').click();
  await composer(page).fill('Does Stripe say how long a key stays in flight? If it can be longer than 14 seconds the third retry still collides.');
  await shot('2.2-selection-comment-beside-the-thread');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(pane.locator('.ib-apanel')).toContainText('Does Stripe say');

  // Stored per attachment and version, in the project's annotations.jsonl.
  const model = (await (await inboxFetch(`/api/inbox/threads/${world.threads.billing}/attachments`)).json()) as {
    annotations: { attachment_id: string; version: string; annotation: { originalText: string } }[];
  };
  expect(model.annotations.map((a) => a.annotation.originalText)).toEqual(['retries them one by one', 'at most three times, 2, 4 and 8 seconds apart']);
  expect(model.annotations.every((a) => a.attachment_id === world.attachments.plan && a.version === 'current')).toBe(true);

  await pane.getByRole('button', { name: 'Full screen' }).click();
  await expect(pane).toHaveClass(/ib-full/);
  await expect(pane.locator('[data-strip-chip]')).toHaveText('2 annotations');
  await shot('2.3-full-screen-annotation-mode');
  await pane.getByRole('button', { name: 'Exit full screen' }).click();
  await expect(pane).not.toHaveClass(/ib-full/);

  // The chip inside the reply box lists each annotation with its file, quote and comment.
  await page.getByRole('button', { name: 'Reply', exact: true }).click();
  const chip = page.locator('[data-annotations-chip]');
  await expect(chip).toHaveText('2 annotations');
  await chip.click();
  const pop = page.getByRole('dialog', { name: '2 annotations ride this reply' });
  await expect(pop.locator('[data-annotation-row]')).toHaveCount(2);
  await expect(pop.locator('[data-annotation-row]').first()).toContainText('retry-plan.md');
  await expect(pop.locator('[data-annotation-row]').first()).toContainText('"retries them one by one"');
  // A comment edits in place.
  await pop.locator('[data-annotation-row]').nth(1).getByRole('button', { name: 'Edit' }).click();
  await pop.getByRole('textbox', { name: 'Edit the comment' }).fill('Does Stripe say how long a key stays in flight? If it can be longer than 14 seconds the third retry still collides.');
  await pop.getByRole('button', { name: 'Save' }).click();
  await expect(pop.getByRole('textbox', { name: 'Edit the comment' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(pop).toBeHidden();
});

test('the HTML prototype opens full screen: its image and frame load from its folder, never the Inbox; a marker pins "Retry all"', async () => {
  const page = world.page;
  await page.getByRole('button', { name: 'Open admin-view.html' }).click();
  const pane = page.locator(`[data-attachment-pane="${world.attachments.html}"]`);
  await expect(pane).toBeVisible();
  // HTML opens in the annotation mode by default: full screen, Exit full screen offered.
  await expect(pane).toHaveClass(/ib-full/);
  await expect(pane.getByRole('button', { name: 'Exit full screen' })).toBeVisible();
  const frame = pageFrame(page);
  await expect(frame.locator('#retry-all')).toHaveText('Retry all (40)');
  // The relative image resolved against the file's own folder.
  await expect.poll(() => frame.locator('#badge').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(88);
  // The relative iframe loaded the sibling page from that folder, not the Inbox (#1554).
  const nested = frame.frameLocator('#detail');
  await expect(nested.locator('#detail-text')).toHaveText("Charge detail from the attachment's own folder");
  await expect(nested.locator('body')).not.toContainText('Inbox');
  // The page's script could not read the Inbox API from its sandboxed frame.
  await expect(frame.locator('#probe')).toHaveText('inbox api refused');

  // Pinpoint is armed: a click on the button pins a comment to it.
  await frame.locator('#retry-all').click();
  await composer(page).fill('Retry all should ask first. Forty charges at once is a lot to undo.');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(pane.locator('.ib-apanel')).toContainText('Retry all should ask first');
  const model = (await (await inboxFetch(`/api/inbox/threads/${world.threads.billing}/attachments`)).json()) as {
    annotations: { attachment_id: string; annotation: { htmlAnchor?: { tagName: string }; elementContext?: { tag: string } } }[];
  };
  const pin = model.annotations.find((a) => a.attachment_id === world.attachments.html)!;
  expect(pin.annotation.htmlAnchor?.tagName.toLowerCase()).toBe('button');
  await expect(pane.locator('[data-strip-chip]')).toHaveText('3 annotations');
  await shot('2.4-html-full-screen-marker-pinned');

  await pane.getByRole('button', { name: 'Exit full screen' }).click();
  await expect(pane).not.toHaveClass(/ib-full/);
  await pane.getByRole('button', { name: 'Close admin-view.html' }).click();
  await expect(pane).toHaveCount(0);
  expect(page.url()).not.toContain('file=');
});

test('a Mermaid diagram opens beside its thread and takes a node comment', async () => {
  const page = world.page;
  await page.goto(`${world.url}#thread=${world.threads.docs}`);
  await page.getByRole('button', { name: 'Open install-flow.mmd' }).click();
  const pane = page.locator(`[data-attachment-pane="${world.attachments.flow}"]`);
  await expect(pane).toBeVisible();
  await expect(pane).not.toHaveClass(/ib-full/);
  const node = pane.locator('svg g.node', { hasText: 'Detect installed agents' }).first();
  await expect(node).toBeVisible({ timeout: 30_000 });
  await node.click();
  const composer = pane.getByRole('textbox').last();
  await composer.fill('Detect first and ask only when two agents are installed.');
  await shot('2.5-diagram-node-comment');
  await pane.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(pane.locator('.ib-apanel')).toContainText('Detect first and ask only when two agents are installed.');
  const model = (await (await inboxFetch(`/api/inbox/threads/${world.threads.docs}/attachments`)).json()) as {
    annotations: { annotation: { diagramAnchor?: { kind: string; label: string } } }[];
  };
  expect(model.annotations[0]!.annotation.diagramAnchor?.kind).toBe('node');
  expect(model.annotations[0]!.annotation.diagramAnchor?.label).toBe('Detect installed agents');
  // The tile counts it; the reply box's chip lists it with the node it names.
  await pane.getByRole('button', { name: 'Close install-flow.mmd' }).click();
  await expect(page.locator('.ib-att-t')).toContainText('Mermaid, 1 annotation');
  await page.getByRole('button', { name: 'Reply', exact: true }).click();
  await page.locator('[data-annotations-chip]').click();
  await expect(page.locator('[data-annotation-row]')).toContainText('node');
  await shot('2.8-one-annotation-on-a-diagram');
  await page.keyboard.press('Escape');
});

test('the agent edits the plan on disk: the changed line, the annotations survive, and "Open the version it sent" shows the bytes sent', async () => {
  const page = world.page;
  appendFileSync(join(world.billing, 'docs', 'retry-plan.md'), '\n## Open questions\n\nHow long does Stripe keep a key in flight?\n');
  await page.goto(`${world.url}#thread=${world.threads.billing}`);
  await expect(page.locator('.ib-att-t').first()).toContainText('Changed since it was sent, edited');
  await page.getByRole('button', { name: 'Open retry-plan.md' }).click();
  const pane = page.locator(`[data-attachment-pane="${world.attachments.plan}"]`);
  const line = pane.locator('[data-changed-line]');
  await expect(line).toContainText('Changed since Claude Code sent it at');
  await expect(line).toContainText('Edited');
  await expect(pane.locator('.ib-docscroll')).toContainText('How long does Stripe keep a key in flight?');
  // Both comments still sit on their text in the edited file.
  await expect(pane.locator('.ib-apanel')).toContainText('One by one is right');
  await expect(pane.locator('.ib-apanel')).toContainText('Does Stripe say');
  await expect(pane.locator('.ib-apanel')).not.toContainText('Unanchored');
  await expect(pane.locator('.ib-docscroll mark, .ib-docscroll [data-highlight-id]').first()).toBeVisible();
  await shot('2.2-changed-line');

  await line.getByRole('button', { name: 'Open the version it sent' }).click();
  await expect(pane).toHaveAttribute('data-version', 'sent');
  await expect(pane.locator('[data-changed-line]')).toContainText('The version Claude Code sent at');
  await expect(pane.locator('.ib-docscroll')).toContainText('Refund handling and the 402 path stay as they are.');
  await expect(pane.locator('.ib-docscroll')).not.toContainText('How long does Stripe keep a key in flight?');
  expect(page.url()).toContain('v=sent');
  // Byte for byte: the sent version is the file as it was, the current one is the edit.
  expect(await (await inboxFetch(`/api/inbox/attachments/${world.attachments.plan}?version=sent`)).text()).toBe(PLAN);
  expect(await (await inboxFetch(`/api/inbox/attachments/${world.attachments.plan}`)).text()).toContain('## Open questions');
  await shot('2.2-the-version-it-sent');
  await pane.locator('[data-changed-line]').getByRole('button', { name: 'Open the file as it is now' }).click();
  await expect(pane).toHaveAttribute('data-version', 'current');
  await pane.getByRole('button', { name: 'Close retry-plan.md' }).click();
});

test('Send carries the picks and then the annotations as feedback; wait_for_reply returns both', async () => {
  const page = world.page;
  await page.getByRole('radio', { name: /Retry with the same idempotency key/ }).click();
  await page.getByRole('radio', { name: /^Yes/ }).click();
  await expect(page.locator('.ib-pfoot')).toContainText('Not sent');
  await page.getByRole('button', { name: 'Edit the reply' }).click();
  await expect(page.locator('[data-picks-chip]')).toHaveText('2 picks');
  const chip = page.locator('[data-annotations-chip]');
  await expect(chip).toHaveText('3 annotations');
  await shot('2.6-picks-and-annotations-ride-the-reply');
  await chip.click();
  const pop = page.getByRole('dialog', { name: '3 annotations ride this reply' });
  await expect(pop.locator('[data-annotation-row]')).toHaveCount(3);
  await expect(pop.locator('[data-annotation-row]').nth(2)).toContainText('admin-view.html');
  await expect(pop.locator('[data-annotation-row]').nth(2)).toContainText('button');
  await pop.locator('[data-annotation-row]').nth(1).getByRole('button', { name: 'Edit' }).click();
  await shot('2.7-the-annotations-chip-opens-them');
  await pop.getByRole('button', { name: 'Cancel' }).click();
  // The file name opens the file at that place.
  await pop.locator('[data-annotation-row]').nth(2).getByRole('button', { name: /admin-view\.html/ }).click();
  await expect(page.locator(`[data-attachment-pane="${world.attachments.html}"]`)).toBeVisible();
  expect(page.url()).toContain('at=');
  await page.locator(`[data-attachment-pane="${world.attachments.html}"]`).getByRole('button', { name: 'Write the reply' }).click();
  await expect(page.locator(`[data-attachment-pane="${world.attachments.html}"]`)).not.toHaveClass(/ib-full/);

  const waiting = world.claude.waitForReply(world.threads.billing, 40);
  await page.getByRole('textbox', { name: 'Reply to Claude Code' }).fill('Two notes on the files below.');
  await page.locator('.ib-pfoot').getByRole('button', { name: 'Send' }).click();
  const reply = await waiting;
  expect(reply.status).toBe('replied');
  const body = reply.reply.body as string;
  // The picks first ...
  expect(body).toContain('Answered 2 questions.');
  expect(body).toContain('Two notes on the files below.');
  expect(body).toContain('Retry with the same idempotency key');
  // ... then Plannotator's feedback text, one section per file.
  expect(body.indexOf('Feedback on the attached files')).toBeGreaterThan(body.indexOf('Retry with the same idempotency key'));
  expect(body).toContain('## docs/retry-plan.md');
  expect(body).toContain('One by one is right. Keep Retry all out of v1.');
  expect(body).toContain('at most three times, 2, 4 and 8 seconds apart');
  expect(body).toContain('## proto/admin-view.html');
  expect(body).toContain('Retry all should ask first. Forty charges at once is a lot to undo.');
  expect(body).toContain('button');
  // read_thread returns the same reply.
  const thread = await world.claude.readThread(world.threads.billing);
  expect(thread.messages.at(-1).body).toBe(body);
  // Sent annotations leave the chip and the tiles.
  await expect(page.locator('.ib-delivered')).toBeVisible();
  const after = (await (await inboxFetch(`/api/inbox/threads/${world.threads.billing}/attachments`)).json()) as { annotations: unknown[] };
  expect(after.annotations).toHaveLength(0);
  await page.locator(`[data-attachment-pane="${world.attachments.html}"]`).getByRole('button', { name: 'Close admin-view.html' }).click();
  await page.locator('.ib-pbody').evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await shot('2.6-sent-with-feedback');
});

test('Settings: the store size counts the sent files; delete thread removes its blobs and the size falls', async () => {
  const page = world.page;
  await page.goto(`${world.url}#settings`);
  // A fresh page, so the size read below is the store as it is now, not Settings as an earlier visit left it.
  await page.reload();
  const bytesOf = async () => Number(await page.locator('[data-store-bytes]').getAttribute('data-store-bytes'));
  await expect(page.locator('[data-store-bytes]')).toBeVisible();
  const before = await bytesOf();
  const blobsBefore = readdirSync(join(world.dataDir, 'inbox', 'blobs'));
  expect(blobsBefore).toHaveLength(3);
  // Open docs-site's row and delete its thread (the diagram's blob goes with it).
  await page.locator('[data-store-project="docs-site"] .ib-fold').click();
  const row = page.locator(`[data-store-thread="${world.threads.docs}"]`);
  await row.getByRole('button', { name: /Delete thread/ }).click();
  await expect(row.getByRole('button', { name: /click again to delete/ })).toHaveText('Delete? Click again');
  await shot('7.1-settings-delete-asks-once-more');
  await row.getByRole('button', { name: /click again to delete/ }).click();
  await expect(row).toHaveCount(0);
  await expect.poll(bytesOf).toBeLessThan(before);
  const blobsAfter = readdirSync(join(world.dataDir, 'inbox', 'blobs'));
  expect(blobsAfter).toHaveLength(2);
  const flowSha = (await world.claude.readThread(world.threads.billing)).messages[0].attachments.map((a: { sent_sha256: string }) => a.sent_sha256);
  expect(blobsAfter.sort()).toEqual([...flowSha].sort());
  expect((await inboxFetch(`/api/inbox/attachments/${world.attachments.flow}`)).status).toBe(404);
  await shot('7.1-settings-after-delete');

  // Delete project removes the rest: the billing project and its two blobs.
  await page.locator('[data-store-project="billing-svc"]').getByRole('button', { name: /Delete project/ }).click();
  await page.locator('[data-store-project="billing-svc"]').getByRole('button', { name: /click again to delete/ }).click();
  await expect(page.locator('[data-store-project="billing-svc"]')).toHaveCount(0);
  expect(readdirSync(join(world.dataDir, 'inbox', 'blobs'))).toHaveLength(0);
  expect(existsSync(join(world.dataDir, 'inbox', 'projects'))).toBe(true);
});

test('no page errors along the way', async () => {
  // The prototype's own probe of the Inbox API is refused by design (its CORS error and the failed load).
  const probe = (e: string) => /from origin 'null' has been blocked by CORS policy/.test(e) || e === 'Failed to load resource: net::ERR_FAILED';
  expect(world.errors.filter((e) => !probe(e))).toEqual([]);
});
