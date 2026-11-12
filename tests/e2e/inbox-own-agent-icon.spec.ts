import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { E2E_LAUNCH_OFF, inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shots = process.env.PLANNOTATOR_OWN_ICON_SHOTS ? resolve(process.env.PLANNOTATOR_OWN_ICON_SHOTS) : null;

const svg = (body: string, viewBox = '0 0 100 100') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body}</svg>`;
const PICTURES = {
  wide: svg('<rect width="400" height="100" rx="18" fill="#2563eb"/><text x="200" y="72" font-size="64" font-weight="700" text-anchor="middle" fill="#fff" font-family="Arial">ACME</text>', '0 0 400 100'),
  tall: svg('<rect x="0" width="100" height="400" rx="24" fill="#16a34a"/><circle cx="50" cy="70" r="30" fill="#facc15"/><circle cx="50" cy="200" r="30" fill="#facc15"/><circle cx="50" cy="330" r="30" fill="#facc15"/>', '0 0 100 400'),
  transparent: svg('<path d="M18 40 L28 10 L42 32 Z M82 40 L72 10 L58 32 Z" fill="#f97316"/><circle cx="50" cy="56" r="38" fill="#f97316"/><ellipse cx="50" cy="68" rx="24" ry="18" fill="#fff"/><circle cx="38" cy="52" r="4" fill="#111"/><circle cx="62" cy="52" r="4" fill="#111"/>'),
  spinner: svg(
    '<style>@keyframes turn{to{transform:rotate(360deg)}}.arm{transform-origin:50px 50px;animation:turn 1.6s linear infinite}</style><circle cx="50" cy="50" r="44" fill="#7c3aed"/><g class="arm"><rect x="46" y="8" width="8" height="42" rx="4" fill="#fde047"/></g><circle cx="50" cy="50" r="8" fill="#fff"><animate attributeName="r" values="8;18;8" dur="1.2s" repeatCount="indefinite"/></circle>',
  ),
  hostile: svg(
    "<script>fetch('/__script__');document.title='ran'</script><image href=\"http://example.invalid/external.png\" width=\"100\" height=\"100\"/><foreignObject width=\"100\" height=\"100\"><div xmlns=\"http://www.w3.org/1999/xhtml\"><img src=\"http://example.invalid/fo.png\"/></div></foreignObject><rect width=\"100\" height=\"100\" rx=\"18\" fill=\"#0d9488\"/>",
  ).replace('<svg ', "<svg onload=\"fetch('/__onload__')\" "),
};

const GIF = join(repo, 'packages/server/fixtures/agent-icons/anim.gif');

interface World {
  root: string;
  url: string;
  agents: SimAgent[];
  context: BrowserContext;
  page: Page;
  threads: Record<string, string>;
  files: Record<string, string>;
  outside: string[];
}
let world: World;

const AGENTS = [
  { key: 'wide', name: 'Claude Code', host: 'claude-code', subject: 'Pricing page copy' },
  { key: 'tall', name: 'Codex', host: 'codex', subject: 'Release 0.28.62' },
  { key: 'spinner', name: 'Pi', host: 'pi', subject: 'Docs: Inbox guide' },
  { key: 'gif', name: 'OpenCode', host: 'opencode', subject: 'Scratch: CSV import' },
  { key: 'hostile', name: 'Gemini CLI', host: 'gemini-cli', subject: 'Hostile picture' },
  { key: 'transparent', name: 'Claude Code', host: 'claude-code', subject: 'Agent icons brief' },
  { key: 'photo', name: 'Codex', host: 'codex', subject: 'Brand site hero' },
] as const;

async function shot(page: Page, name: string, target?: Locator): Promise<void> {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.waitForTimeout(250);
  if (target) await target.screenshot({ path: join(shots, `${name}.png`) });
  else await page.screenshot({ path: join(shots, `${name}.png`) });
}

const sidebarMark = (page: Page, agentId: string) => page.locator(`[data-agent-icon="${agentId}"]`);

async function rowBoxes(page: Page) {
  return page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll<HTMLElement>('[data-thread-id]')].map((row) => [
        row.dataset.threadId,
        {
          h: +row.getBoundingClientRect().height.toFixed(2),
          tiles: [...row.querySelectorAll('.ib-atile')].map((t) => {
            const r = t.getBoundingClientRect();
            return `${r.width.toFixed(2)}x${r.height.toFixed(2)}`;
          }),
        },
      ]),
    ),
  );
}

async function agentIds(page: Page): Promise<string[]> {
  const marks = await page.locator('.ib-sbagent').evaluateAll((rows) => rows.map((row) => ({ id: row.querySelector('[data-agent-icon]')?.getAttribute('data-agent-icon') ?? '', label: (row.querySelector('.ib-proj') as HTMLElement | null)?.innerText ?? '' })));
  return AGENTS.map((a) => {
    const found = marks.find((m) => m.label.split('\n')[0]!.trim() === a.key);
    if (!found) throw new Error(`no sidebar mark for ${a.name}: ${JSON.stringify(marks)}`);
    return found.id;
  });
}

async function openOwn(page: Page, agentId: string): Promise<Locator> {
  await sidebarMark(page, agentId).focus();
  await page.keyboard.press('Enter');
  const place = page.locator('.am-fan[data-open] [data-face-choice="own"]');
  await expect(place).toBeVisible();
  await expect(place).toHaveAttribute('aria-label', 'Your own…');
  await place.click();
  const panel = page.locator('dialog[data-dialog="agent-icon"][open]');
  await expect(panel).toBeVisible();
  return panel;
}

async function upload(page: Page, agentId: string, file: string): Promise<void> {
  const panel = await openOwn(page, agentId);
  const chooser = page.waitForEvent('filechooser');
  await panel.locator('.am-own-up').click();
  await (await chooser).setFiles(file);
  await expect(page.locator('dialog[data-dialog="agent-icon"][open]')).toHaveCount(0);
  await expect(sidebarMark(page, agentId).locator('[data-agent-mark]')).toHaveAttribute('data-face', /^own:[0-9a-f]{64}$/);
  expect(await sidebarMark(page, agentId).locator('img[data-own]').evaluate((img) => [(img as HTMLElement).offsetWidth, (img as HTMLElement).offsetHeight])).toEqual([24, 24]);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-inbox-own-agent-icon-e2e-');
  const data = join(root, 'data');
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, 'config.json'), JSON.stringify({ ...E2E_LAUNCH_OFF, inboxBoard: true, inboxBoardIntro: { shownAt: new Date().toISOString() } }));
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    PLANNOTATOR_DATA_DIR: data,
    PLANNOTATOR_TEST_SANDBOX: '1',
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  const project = scratchProject(join(root, 'src'), 'plannotator');
  const pictures = join(root, 'pictures');
  mkdirSync(pictures, { recursive: true });
  const files: Record<string, string> = {};
  for (const [key, body] of Object.entries(PICTURES)) writeFileSync((files[key] = join(pictures, `${key}.svg`)), body);
  files.gif = GIF;
  files.photo = join(repo, 'packages/server/fixtures/agent-icons/still.png');
  for (const [key, name] of [['transparent', 'transparent.png'], ['photo', 'photo.jpg']] as const) {
    const from = process.env.PLANNOTATOR_OWN_ICON_PICTURES ? join(process.env.PLANNOTATOR_OWN_ICON_PICTURES, name) : '';
    if (from && existsSync(from)) files[key] = from;
  }
  const agents: SimAgent[] = [];
  const threads: Record<string, string> = {};
  const firsts: Record<string, string> = {};
  for (const a of AGENTS) {
    const agent = await SimAgent.connect({ binary, env, name: a.name, host: a.host });
    agents.push(agent);
    const sent = await agent.send({ project_path: project, subject: a.subject, thread: a.key, body: [`${a.subject}: one decision waits on you.`, '', ':::question', 'Ship it?', '', '- [ ] Yes', '- [ ] No', ':::'].join('\n') });
    threads[a.key] = sent.thread_id as string;
    await agent.card({ op: 'create', project_path: project, title: a.subject, column: 'in_progress', thread_id: sent.thread_id });
    firsts[a.key] = sent.message_id as string;
  }
  const helper = await SimAgent.connect({ binary, env, name: 'Helper', host: 'claude-code' });
  agents.push(helper);
  const helped = await helper.send({ project_path: project, reply_to: firsts.wide, body: 'I can take the copy edits too.' });
  await agents[0]!.send({ project_path: project, reply_to: helped.message_id as string, body: [':::question', 'Ship the copy today?', '', '- [ ] Yes', '- [ ] No', ':::'].join('\n') });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  world = { root, url: started.stdout.trim(), agents, context, page, threads, files, outside: [] };
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.protocol === 'blob:') return;
    if (url.host !== new URL(world.url).host || url.pathname.startsWith('/__')) world.outside.push(request.url());
  });
});

test.afterAll(async () => {
  try {
    if (!world) return;
    for (const agent of world.agents) await agent.close().catch(() => {});
    await world.context.close();
  } finally {
    await removeInboxScratch();
  }
});

test('"Your own…" takes a file, a drop and a paste; each shows on its agent everywhere, and no row changes size', async () => {
  const { page } = world;
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(world.url);
  await expect(page.locator(`[data-thread-id="${world.threads.wide}"]`).first()).toBeVisible();
  if ((await page.locator('[data-agent-icon]').count()) === 0) await page.getByRole('button', { name: 'Agents', exact: true }).click();
  await expect.poll(() => page.locator('[data-agent-icon]').count()).toBeGreaterThanOrEqual(AGENTS.length);
  const ids = await agentIds(page);
  const before = await rowBoxes(page);

  await sidebarMark(page, ids[0]!).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.am-fan[data-open] [data-face-choice="own"]')).toBeVisible();
  await page.locator('.am-fan[data-open] [data-face-choice="own"]').focus();
  await shot(page, 'picker-your-own-light');
  await page.keyboard.press('Enter');
  await expect(page.locator('dialog[data-dialog="agent-icon"][open]')).toBeVisible();
  await shot(page, 'panel-empty-light');
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog[data-dialog="agent-icon"][open]')).toHaveCount(0);

  const order = ids.map((id, i) => ({ id, key: AGENTS[i]!.key }));
  const byKey = Object.fromEntries(order.map((o) => [o.key, o.id]));
  await upload(page, byKey.wide!, world.files.wide!);
  await upload(page, byKey.tall!, world.files.tall!);
  await upload(page, byKey.spinner!, world.files.spinner!);
  await upload(page, byKey.transparent!, world.files.transparent!);
  await upload(page, byKey.photo!, world.files.photo!);

  const dropPanel = await openOwn(page, byKey.gif!);
  const gifBytes = [...(await import('node:fs')).readFileSync(world.files.gif!)];
  await dropPanel.evaluate((el, bytes) => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array(bytes)], 'counter.gif', { type: 'image/gif' }));
    el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }));
    el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
  }, gifBytes);
  await expect(sidebarMark(page, byKey.gif!).locator('[data-agent-mark]')).toHaveAttribute('data-face', /^own:/);

  await openOwn(page, byKey.hostile!);
  await page.evaluate((text) => {
    const data = new DataTransfer();
    data.items.add(new File([text], 'hostile.svg', { type: 'image/svg+xml' }));
    document.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  }, PICTURES.hostile);
  await expect(sidebarMark(page, byKey.hostile!).locator('[data-agent-mark]')).toHaveAttribute('data-face', /^own:/);

  for (const { key, id } of order) {
    const face = await sidebarMark(page, id).locator('[data-agent-mark]').getAttribute('data-face');
    const hash = face!.slice(4);
    await expect(sidebarMark(page, id).locator(`img[data-own="${face}"]`)).toHaveAttribute('src', `/api/inbox/agent-icons/${hash}`);
    const row = page.locator(`[data-thread-id="${world.threads[key]}"]`).first();
    await expect(row.locator(`.ib-own img[src="/api/inbox/agent-icons/${hash}?still=1"]`).first()).toBeVisible();
  }
  expect(await rowBoxes(page)).toEqual(before);
  await openOwn(page, byKey.transparent!);
  await shot(page, 'panel-pictures-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, 'panel-pictures-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog[data-dialog="agent-icon"][open]')).toHaveCount(0);
  await page.mouse.move(1000, 850);
  await shot(page, 'list-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, 'list-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  await page.locator(`[data-thread-id="${world.threads.wide}"]`).first().click();
  const hash = (await sidebarMark(page, byKey.wide!).locator('[data-agent-mark]').getAttribute('data-face'))!.slice(4);
  await expect.poll(() => page.locator(`.ib-own img[src="/api/inbox/agent-icons/${hash}?still=1"]`).count()).toBeGreaterThanOrEqual(3);
  await page.keyboard.press('r');
  await expect(page.locator(`.ib-rto .ib-own img[src="/api/inbox/agent-icons/${hash}?still=1"]`)).toBeVisible();
  await shot(page, 'thread-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, 'thread-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  await page.evaluate(() => (location.hash = '#board'));
  for (const { id } of order) {
    const face = await sidebarMark(page, id).locator('[data-agent-mark]').getAttribute('data-face');
    await expect(page.locator(`.ib-own img[src="/api/inbox/agent-icons/${face!.slice(4)}?still=1"]`).first()).toBeVisible();
  }
  await shot(page, 'board-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, 'board-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.evaluate(() => (location.hash = ''));
});

test('a phone photo over 512 KB is shrunk in the window, its proportions kept, and sent quickly on a poor link', async () => {
  test.setTimeout(120_000);
  const { page, context } = world;
  const photo = join(world.root, 'pictures', 'phone-photo.jpg');
  const base64 = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 2400;
    canvas.height = 1800;
    const ctx = canvas.getContext('2d')!;
    const data = ctx.createImageData(canvas.width, canvas.height);
    for (let i = 0; i < data.data.length; i++) data.data[i] = i % 4 === 3 ? 255 : (Math.random() * 256) | 0;
    ctx.putImageData(data, 0, 0);
    const blob = await new Promise<Blob>((done) => canvas.toBlob((b) => done(b!), 'image/jpeg', 0.95));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let out = '';
    for (let at = 0; at < bytes.length; at += 0x8000) out += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
    return btoa(out);
  });
  writeFileSync(photo, Buffer.from(base64, 'base64'));
  expect(statSync(photo).size).toBeGreaterThan(2 * 1024 * 1024);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 400, downloadThroughput: 50_000, uploadThroughput: 50_000 });
  try {
    const id = (await agentIds(page))[1]!;
    const before = await sidebarMark(page, id).locator('[data-agent-mark]').getAttribute('data-face');
    const panel = await openOwn(page, id);
    const chooser = page.waitForEvent('filechooser');
    await panel.locator('.am-own-up').click();
    const started = Date.now();
    await (await chooser).setFiles(photo);
    await expect(page.locator('dialog[data-dialog="agent-icon"][open]')).toHaveCount(0, { timeout: 20_000 });
    expect(Date.now() - started).toBeLessThan(20_000);
    await expect(sidebarMark(page, id).locator('[data-agent-mark]')).not.toHaveAttribute('data-face', before ?? '');
    const face = (await sidebarMark(page, id).locator('[data-agent-mark]').getAttribute('data-face'))!;
    expect(face).toMatch(/^own:[0-9a-f]{64}$/);
    const kept = await page.evaluate(async (hash) => {
      const blob = await (await fetch(`/api/inbox/agent-icons/${hash}`)).blob();
      const img = new Image();
      img.src = URL.createObjectURL(blob);
      await img.decode();
      return { size: blob.size, type: blob.type, width: img.naturalWidth, height: img.naturalHeight };
    }, face.slice(4));
    expect(kept).toMatchObject({ type: 'image/jpeg', width: 256, height: 192 });
    expect(kept.size).toBeLessThan(512 * 1024);
  } finally {
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await cdp.detach();
  }
});

test('a picture is shown as uploaded: its own shape, scaled to fit the tile, nothing cropped, no tile colour', async () => {
  const { page } = world;
  const ids = await agentIds(page);
  const fits = await page.evaluate((rowAgents) => {
    const out: { where: string; box: string; drawn: string; natural: string; fit: string; ground: string }[] = [];
    for (const img of document.querySelectorAll<HTMLImageElement>('.ib-own > img, img[data-own]')) {
      if (!img.complete || !img.naturalWidth || !img.offsetParent) continue;
      const box = img.getBoundingClientRect();
      const tile = img.closest('.ib-atile, .ib-mk, .am') as HTMLElement;
      const ground = [img.parentElement!, img.parentElement!.parentElement!].map((el) => getComputedStyle(el).backgroundColor).find((c) => !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) ?? 'transparent';
      out.push({ where: tile.className, box: `${box.width}x${box.height}`, drawn: `${img.width}x${img.height}`, natural: `${img.naturalWidth}x${img.naturalHeight}`, fit: getComputedStyle(img).objectFit, ground });
    }
    return { out, rowAgents };
  }, ids);
  expect(fits.out.length).toBeGreaterThan(5);
  for (const f of fits.out) {
    expect(f.fit).toBe('contain');
    const [w, h] = f.box.split('x').map(Number);
    expect(Math.abs(w! - h!)).toBeLessThan(0.5);
    expect(f.ground).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
  }
});

test('a GIF and a moving SVG move in the sidebar only; their row copy is one frame; reduced motion stills the sidebar', async () => {
  const { page } = world;
  const ids = await agentIds(page);
  const byKey = Object.fromEntries(AGENTS.map((a, i) => [a.key, ids[i]!]));
  const pause = () => page.evaluate(() => document.getAnimations().forEach((a) => a.pause()));
  const frames = async (target: Locator, n = 6, gap = 230) => {
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      await pause();
      out.push((await target.screenshot({ animations: 'allow' })).toString('base64'));
      if (shots) writeFileSync(join(shots, `frames-${await target.evaluate((el) => (el as HTMLElement).dataset.shotName ?? 'x')}-${i}.png`), Buffer.from(out.at(-1)!, 'base64'));
      await page.waitForTimeout(gap);
    }
    return new Set(out).size;
  };
  for (const key of ['gif', 'spinner'] as const) {
    const side = sidebarMark(page, byKey[key]!);
    await side.evaluate((el, name) => ((el as HTMLElement).dataset.shotName = `${name}-sidebar`), key);
    const row = page.locator(`[data-thread-id="${world.threads[key]}"] .ib-atile`).first();
    await row.evaluate((el, name) => ((el as HTMLElement).dataset.shotName = `${name}-row`), key);
    expect(await frames(side)).toBeGreaterThan(1);
    expect(await frames(row)).toBe(1);
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const key of ['gif', 'spinner'] as const) {
    const side = sidebarMark(page, byKey[key]!);
    await expect(side.locator('img[data-own]')).toHaveAttribute('src', /\?still=1$/);
    await side.evaluate((el, name) => ((el as HTMLElement).dataset.shotName = `${name}-sidebar-reduced`), key);
    await page.waitForTimeout(300);
    expect(await frames(side)).toBe(1);
  }
  await page.emulateMedia({ reducedMotion: 'no-preference' });
});

test('a hostile SVG is drawn and nothing in it runs: no request leaves, the title is untouched', async () => {
  const { page } = world;
  const ids = await agentIds(page);
  const hostile = sidebarMark(page, ids[AGENTS.findIndex((a) => a.key === 'hostile')]!);
  await expect(hostile.locator('img[data-own]')).toBeVisible();
  expect(await hostile.locator('img[data-own]').evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await page.waitForTimeout(500);
  expect(world.outside).toEqual([]);
  expect(await page.title()).not.toBe('ran');
});

test('the marks’ own life moves the picture from outside: its layers animate, and it leans toward the pointer', async () => {
  const { page } = world;
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const ids = await agentIds(page);
  const mark = sidebarMark(page, ids[0]!);
  const box = (await mark.boundingBox())!;
  const running = await mark.evaluate((el) => {
    const face = el.querySelector('.am-f-own:not([hidden])')!;
    return face.getAnimations({ subtree: true }).filter((a) => a.playState === 'running').length;
  });
  expect(running).toBeGreaterThan(0);
  const look = () => mark.evaluate((el) => getComputedStyle(el.querySelector('.am-look')!).transform);
  await page.mouse.move(box.x + 200, box.y - 120);
  await page.waitForTimeout(900);
  const leaning = await look();
  expect(leaning).not.toBe('none');
  expect(leaning).not.toBe('matrix(1, 0, 0, 1, 0, 0)');
});

test('phone: the picture on the list and the sidebar, at phone size', async () => {
  const { page } = world;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(world.url);
  await expect(page.locator(`[data-thread-id="${world.threads.wide}"] .ib-own img`).first()).toBeVisible();
  await shot(page, 'phone-list-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, 'phone-list-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 1440, height: 900 });
});

test('every size a picture is drawn at, for each test picture (shots only)', async () => {
  test.skip(!shots, 'pictures only');
  const { page } = world;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.goto(world.url);
  await expect.poll(() => page.locator('[data-agent-icon]').count()).toBeGreaterThanOrEqual(AGENTS.length);
  const ids = await agentIds(page);
  for (const [i, a] of AGENTS.entries()) {
    const id = ids[i]!;
    await sidebarMark(page, id).evaluate((el) => el.scrollIntoView());
    await shot(page, `size-${a.key}-sidebar24`, sidebarMark(page, id));
    const row = page.locator(`[data-thread-id="${world.threads[a.key]}"]`).first();
    await shot(page, `size-${a.key}-row20`, row.locator('.ib-atile').first());
    await row.click();
    await shot(page, `size-${a.key}-author`, page.locator(`.ib-own.ib-big img[src*="${(await sidebarMark(page, id).locator('[data-agent-mark]').getAttribute('data-face'))!.slice(4)}"]`).first().locator('..'));
    await page.keyboard.press('r');
    const pill = page.locator('.ib-rto:visible');
    if (await pill.count()) await shot(page, `size-${a.key}-to-pill`, pill.first());
    await page.keyboard.press('Escape');
  }
  await page.evaluate(() => (location.hash = '#board'));
  for (const a of AGENTS) await shot(page, `size-${a.key}-board16`, page.locator('.ib-bc-who').filter({ has: page.locator('.ib-own') }).nth(AGENTS.length - 1 - AGENTS.indexOf(a)));
  await page.emulateMedia({ reducedMotion: 'no-preference' });
});
