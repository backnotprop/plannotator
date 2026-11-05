/**
 * The star a list row shows, with real clicks and taps against the compiled binary: a press unstars without opening the
 * thread or marking it read, a double press included; the reach goes by the pointer's type, not the window's width; the
 * star does nothing on hover. And when it pops: once, not after a reload, not for a star from elsewhere, not under
 * reduced motion, not for a star that failed.
 *
 * Under a temp HOME and PLANNOTATOR_DATA_DIR; agents write through `plannotator inbox mcp`.
 * `bunx playwright test -c tests/e2e/playwright.config.ts inbox-row-star.spec.ts`.
 */
import { devices, expect, test, webkit, type Browser, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const question = (text: string) => [':::question', text, '', '- [ ] Yes', '- [ ] No', ':::'].join('\n');

let url = '';
let agents: SimAgent[] = [];
const ids: Record<'a' | 'b' | 'c' | 'd', string> = { a: '', b: '', c: '', d: '' };

test.describe.configure({ mode: 'serial' });

const row = (page: Page, id: string) => page.locator(`.ib-lbody [data-thread-id="${id}"]`);
const star = (page: Page, id: string) => row(page, id).locator('[data-pin-mark]');
const threadOpen = (page: Page) => page.evaluate(() => location.hash.includes('thread='));

async function setPin(page: Page, id: string, value: boolean) {
  await page.evaluate(
    async ([threadId, on]) => {
      const list = (await (await fetch('/api/inbox/threads?archived=exclude')).json()) as { serverSession: string };
      const res = await fetch(`/api/inbox/threads/${threadId}/pin`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serverSession: list.serverSession, pinned: on }) });
      if (!res.ok) throw new Error(`pin ${res.status}`);
    },
    [id, value] as const,
  );
}

const serverPins = (page: Page) =>
  page.evaluate(async () => {
    const list = (await (await fetch('/api/inbox/threads?archived=exclude')).json()) as { pins?: { thread_id: string }[] };
    return (list.pins ?? []).map((pin) => pin.thread_id);
  });

const serverUnread = (page: Page, id: string) =>
  page.evaluate(async (threadId) => {
    const list = (await (await fetch('/api/inbox/threads?archived=exclude')).json()) as { sections: { threads: { thread_id: string; unread: boolean; unseen: number }[] }[] };
    const found = list.sections.flatMap((section) => section.threads).find((thread) => thread.thread_id === threadId)!;
    return [found.unread, found.unseen];
  }, id);

/** The page with only these threads starred, freshly loaded. */
async function load(page: Page, starred: string[], selector = '.ib-lbody [data-thread-id]') {
  await page.goto(url);
  await page.locator(selector).first().waitFor();
  for (const id of await serverPins(page)) await setPin(page, id, false);
  for (const id of starred) await setPin(page, id, true);
  await page.reload();
  await page.locator(selector).first().waitFor();
  for (const id of starred) await expect(star(page, id)).toBeVisible();
}

/** Counts every start of the pop, on the row's star and the sidebar's. */
const COUNT_POPS = () => {
  (window as unknown as { __pops: string[] }).__pops = [];
  document.addEventListener('animationstart', (event) => {
    if (event.animationName.includes('ib-star-pop')) (window as unknown as { __pops: string[] }).__pops.push((event.target as Element).closest('[data-pin-mark]') ? 'row' : 'sidebar');
  }, true);
};
const pops = (page: Page) => page.evaluate(() => (window as unknown as { __pops: string[] }).__pops);

async function starFromRowMenu(page: Page, id: string) {
  await row(page, id).click({ button: 'right' });
  await page.locator('[data-row-action="pin"]').click();
}

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-inbox-row-star-e2e-');
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: join(root, 'data'), PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_UPDATE_CHECK: '0' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  url = started.stdout.trim();
  const src = join(root, 'src');
  const claude = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  const pi = await SimAgent.connect({ binary, env, name: 'Pi', host: 'pi' });
  const codex = await SimAgent.connect({ binary, env, name: 'Codex', host: 'codex' });
  const opencode = await SimAgent.connect({ binary, env, name: 'OpenCode', host: 'opencode' });
  agents = [claude, pi, codex, opencode];
  ids.a = (await claude.send({ project_path: scratchProject(src, 'relay'), subject: 'Which APNs environment for TestFlight builds?', body: question('Sandbox?') })).thread_id as string;
  ids.b = (await pi.send({ project_path: scratchProject(src, 'pando'), subject: 'Default diff style for guided reviews', body: question('Split?') })).thread_id as string;
  ids.c = (await codex.send({ project_path: scratchProject(src, 'billing'), subject: 'VAT rounding between invoice and receipt', body: question('Per line?') })).thread_id as string;
  ids.d = (await opencode.send({ project_path: scratchProject(src, 'workspaces'), subject: 'Webhook retries: cap the backoff', body: question('An hour?') })).thread_id as string;
});

test.afterAll(async () => {
  try {
    for (const agent of agents) await agent.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

test.describe('a mouse', () => {
  test('a click on the star unstars, opens nothing and marks nothing read; the toast and Z work', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await load(page, [ids.a]);
    const before = await serverUnread(page, ids.a);
    const posts: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().includes('/threads/')) posts.push(new URL(request.url()).pathname.split('/').pop()!);
    });
    await star(page, ids.a).click();
    await expect(page.locator('[data-inbox-toast]')).toContainText('Unstarred');
    await expect(star(page, ids.a)).toHaveCount(0);
    expect(await serverPins(page)).toEqual([]);
    expect(await threadOpen(page)).toBe(false);
    expect(posts).toEqual(['pin']);
    expect(await serverUnread(page, ids.a)).toEqual(before);
    await page.keyboard.press('z');
    await expect(star(page, ids.a)).toBeVisible();
    await context.close();
  });

  for (const gap of [40, 300]) {
    test(`a double click ${gap} ms apart is one unstar and does not open the thread`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await context.newPage();
      await load(page, [ids.b]);
      const before = await serverUnread(page, ids.b);
      const posts: string[] = [];
      page.on('request', (request) => {
        if (request.method() === 'POST' && request.url().includes('/threads/')) posts.push(new URL(request.url()).pathname.split('/').pop()!);
      });
      const box = (await star(page, ids.b).boundingBox())!;
      const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
      await page.mouse.click(x, y);
      await page.waitForTimeout(gap);
      await page.mouse.click(x, y);
      await expect(page.locator('[data-inbox-toast]')).toContainText('Unstarred');
      await page.waitForTimeout(500);
      expect(await threadOpen(page)).toBe(false);
      expect(posts).toEqual(['pin']);
      expect(await serverUnread(page, ids.b)).toEqual(before);
      await context.close();
    });
  }

  test("a slow double click, 500 ms apart and counted as one by the system, is one unstar and does not open the thread", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await load(page, [ids.b]);
    const before = await serverUnread(page, ids.b);
    const box = (await star(page, ids.b).boundingBox())!;
    const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
    await page.mouse.click(x, y);
    await page.waitForTimeout(500);
    await page.mouse.click(x, y, { clickCount: 2 });
    await page.waitForTimeout(500);
    expect(await threadOpen(page)).toBe(false);
    expect(await serverPins(page)).toEqual([]);
    expect(await serverUnread(page, ids.b)).toEqual(before);
    await context.close();
  });

  test('after a press on the star, a later click and a click elsewhere on the row both open the thread', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await load(page, [ids.c]);
    const box = (await star(page, ids.c).boundingBox())!;
    const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
    await page.mouse.click(x, y);
    await expect(star(page, ids.c)).toHaveCount(0);
    await page.waitForTimeout(600);
    await page.mouse.click(x, y);
    await expect.poll(() => threadOpen(page)).toBe(true);
    await load(page, [ids.c]);
    const again = (await star(page, ids.c).boundingBox())!;
    const rowBox = (await row(page, ids.c).boundingBox())!;
    await page.mouse.click(again.x + again.width / 2, again.y + again.height / 2);
    await page.mouse.click(rowBox.x + 200, rowBox.y + rowBox.height / 2);
    await expect.poll(() => threadOpen(page)).toBe(true);
    await context.close();
  });

  test('on hover: no star on an unstarred row, and a star looks as it does at rest, with no tooltip and no growth', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await load(page, [ids.a]);
    await row(page, ids.b).hover();
    await page.waitForTimeout(300);
    await expect(row(page, ids.b).locator('.ib-pinmark')).toHaveCount(0);
    const icon = star(page, ids.a).locator('svg');
    const rest = await icon.boundingBox();
    await star(page, ids.a).hover();
    await page.waitForTimeout(900);
    expect(await icon.boundingBox()).toEqual(rest);
    await expect(page.getByText('Unstar thread', { exact: true })).toHaveCount(0);
    await context.close();
  });

  test('the reach goes by the pointer: a mouse at a phone width gets 7 px, not the touch target', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 760, height: 900 } });
    const page = await context.newPage();
    await load(page, [ids.d], '.ib-mrow');
    const box = (await star(page, ids.d).boundingBox())!;
    // 9 px above the star: inside a touch's reach, outside a mouse's. The thread opens.
    await page.mouse.click(box.x + box.width / 2, box.y - 9);
    await expect.poll(() => threadOpen(page)).toBe(true);
    expect(await serverPins(page)).toEqual([ids.d]);
    await load(page, [ids.d], '.ib-mrow');
    const again = (await star(page, ids.d).boundingBox())!;
    await page.mouse.click(again.x + again.width / 2, again.y - 6);
    await expect(star(page, ids.d)).toHaveCount(0);
    expect(await threadOpen(page)).toBe(false);
    await context.close();
  });
});

test.describe('the pop', () => {
  test('plays once on the row and once in the sidebar when this window stars; not after a reload', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript(COUNT_POPS);
    const page = await context.newPage();
    await load(page, []);
    await starFromRowMenu(page, ids.a);
    await expect(star(page, ids.a)).toBeVisible();
    await page.waitForTimeout(2000);
    // The list redraws for another reason, past the moment: nothing plays again.
    await setPin(page, ids.b, true);
    await expect(star(page, ids.b)).toBeVisible();
    await page.waitForTimeout(500);
    expect((await pops(page)).sort()).toEqual(['row', 'sidebar']);
    await starFromRowMenu(page, ids.c);
    await expect(star(page, ids.c)).toBeVisible();
    await page.reload();
    await expect(star(page, ids.c)).toBeVisible();
    await page.waitForTimeout(500);
    expect(await pops(page)).toEqual([]);
    await context.close();
  });

  test('not when the star came from elsewhere', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript(COUNT_POPS);
    const page = await context.newPage();
    await load(page, []);
    const other = await context.newPage();
    await other.goto(url);
    await setPin(other, ids.a, true);
    await expect(star(page, ids.a)).toBeVisible();
    await page.waitForTimeout(500);
    expect(await pops(page)).toEqual([]);
    await context.close();
  });

  test('not under reduced motion', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    await context.addInitScript(COUNT_POPS);
    const page = await context.newPage();
    await load(page, []);
    await starFromRowMenu(page, ids.a);
    await expect(star(page, ids.a)).toBeVisible();
    await page.waitForTimeout(600);
    expect(await pops(page)).toEqual([]);
    await context.close();
  });

  test('not for a star that failed: the sidebar star already there stays still', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript(COUNT_POPS);
    const page = await context.newPage();
    await load(page, [ids.a]);
    await page.route(`**/api/inbox/threads/${ids.b}/pin`, (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"nope"}' }));
    await starFromRowMenu(page, ids.b);
    await page.waitForTimeout(500);
    // Something redraws the sidebar inside the moment.
    await setPin(page, ids.c, true);
    await expect(star(page, ids.c)).toBeVisible();
    await page.waitForTimeout(400);
    expect(await pops(page)).toEqual([]);
    await context.close();
  });
});

test.describe('a phone', () => {
  let phone: Browser | null = null;
  test.beforeAll(async () => {
    phone = await webkit.launch();
  });
  test.afterAll(async () => {
    await phone?.close();
  });

  test('a tap beside the star unstars inside the 45 px target; past it the thread opens; a double tap never opens', async () => {
    const context = await phone!.newContext({ ...devices['iPhone 13'] });
    const page = await context.newPage();
    await load(page, [ids.a], '.ib-mrow');
    let box = (await star(page, ids.a).boundingBox())!;
    let [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
    await page.touchscreen.tap(x, y - 21);
    await expect(page.locator('[data-inbox-toast]')).toContainText('Unstarred');
    expect(await threadOpen(page)).toBe(false);

    // A double tap.
    await load(page, [ids.a], '.ib-mrow');
    box = (await star(page, ids.a).boundingBox())!;
    [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
    await page.touchscreen.tap(x, y);
    await page.waitForTimeout(120);
    await page.touchscreen.tap(x, y);
    await expect(page.locator('[data-inbox-toast]')).toContainText('Unstarred');
    await page.waitForTimeout(500);
    expect(await threadOpen(page)).toBe(false);
    expect(await serverPins(page)).toEqual([]);

    // Past the target: the row.
    await load(page, [ids.a], '.ib-mrow');
    box = (await star(page, ids.a).boundingBox())!;
    await page.touchscreen.tap(box.x - 24, box.y + box.height / 2);
    await expect.poll(() => threadOpen(page)).toBe(true);
    expect(await serverPins(page)).toEqual([ids.a]);

    // An unstarred row has no star and opens.
    await load(page, [ids.a], '.ib-mrow');
    await expect(row(page, ids.b).locator('.ib-pinmark')).toHaveCount(0);
    await context.close();
  });
});
