/**
 * The floating box over a file in full screen, on a phone (the owner's iPhone: "the floating box has mobile responsive
 * issues"), proved against the compiled binary on WebKit and Chromium, with a 1920 × 1080 image and an HTML page:
 *
 *  - The foot is one row at 320 and 390, the mic on: the "N comments" pill is one line inside its pill, the open
 *    questions chip beside it, nothing past the box. The mic used to take half the row's free room at every width,
 *    so this broke up to 430.
 *  - What yields is decided: the questions' words, then the comment count's word (its name stays whole), then "Open in
 *    thread" becomes "Thread". Only at text sizes the row cannot hold do the chips take their own row.
 *  - Every control in the box is 44 px to press, measured by hit test: the controls keep their size, an overlay
 *    takes the press.
 *  - A long agent's name is cut on one line, in the header and in "Sent to …".
 *  - The comments sheet covers the file: the box and its pill step aside from Write the reply.
 *  - A folded pill never lies under the toolbar: it shares the row when both fit, else it sits above (360 px overlapped by 24).
 *  - A desktop window's foot takes none of this.
 *
 * Voice is on but not ready in this sandbox, so the box also carries its note: the mic shows, dimmed, as it does on a
 * phone that cannot record. Build the binary first (see inbox.spec.ts).
 */

import { chromium, devices, expect, test, webkit, type Browser, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';
import { png } from './phone-touch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const LONG_NAME = 'Codex (northwind-industries-holdings platform reviewer)';

const question = (i: number) => ['', ':::question', `Decision ${i}: which way?`, '', '- [ ] Left', '- [ ] Right', ':::'];
const body = ['Three decisions.', ...[1, 2, 3].flatMap(question)].join('\n');

interface Thread {
  thread: string;
  ids: Record<string, string>;
}

let url = '';
let project = '';
let short: SimAgent;
let long: SimAgent;
let serverSession = '';
let threads = 0;

async function seed(agent: SimAgent, comments: number): Promise<Thread> {
  const n = ++threads;
  const sent = await agent.send({ project_path: project, subject: `Widget ${n}`, thread: `widget-${n}`, body, attachments: ['f/plan.md', 'f/shot.png', 'f/page.html'] });
  const thread = sent.thread_id as string;
  const model = (await (await fetch(new URL(`/api/inbox/threads/${thread}/attachments`, url))).json()) as { attachments: { id: string; name: string }[] };
  const ids = Object.fromEntries(model.attachments.map((a) => [a.name, a.id]));
  for (let i = 0; i < comments; i++) {
    const res = await fetch(new URL('/api/inbox/annotations', url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ attachment_id: ids['plan.md'], version: 'current', annotation: { id: `c-${n}-${i}`, type: 'COMMENT', text: `Thought ${i}`, originalText: 'some words', blockId: '', startOffset: 0, endOffset: 0, createdA: Date.now() } }),
    });
    expect(res.status).toBe(200);
  }
  return { thread, ids };
}

const fileUrl = (t: Thread, name: string) => `${url}#thread=${t.thread}&file=${t.ids[name]}&view=full`;
const card = (page: Page) => page.locator('[data-fcomp]');

/** What is wrong with the foot right now: a pill on two lines, its words past its box, a control past the box, two rows. */
async function footProblems(page: Page, oneRow = true): Promise<string[]> {
  return card(page).evaluate((root, oneRow) => {
    const out: string[] = [];
    const box = root.getBoundingClientRect();
    const foot = root.querySelector<HTMLElement>('[data-fcomp-foot]')!;
    // The words the eye sees: visually hidden text (clipped) is the name, not the row.
    const seen = (el: Element) => {
      const rects: DOMRect[] = [];
      const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let node = walk.nextNode(); node; node = walk.nextNode()) {
        if (!node.textContent!.trim() || getComputedStyle(node.parentElement!).clip !== 'auto') continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        rects.push(...range.getClientRects());
      }
      return rects.filter((r) => r.width > 0);
    };
    const controls = ['.ib-fcomp-clip', '[data-fcomp-comments]', '[data-fcomp-questions]', '[data-voice-mic]', '[data-fcomp-open-thread]'];
    const middles: number[] = [];
    for (const selector of controls) {
      const el = foot.querySelector<HTMLElement>(selector);
      if (!el) continue;
      const b = el.getBoundingClientRect();
      middles.push((b.top + b.bottom) / 2);
      if (b.left < box.left - 0.5 || b.right > box.right + 0.5) out.push(`${selector} sits past the box (${Math.round(b.left)}-${Math.round(b.right)} of ${Math.round(box.left)}-${Math.round(box.right)})`);
      const words = seen(el);
      if (new Set(words.map((r) => Math.round(r.top))).size > 1) out.push(`${selector} breaks onto two lines`);
      for (const r of words) if (r.top < b.top - 1 || r.bottom > b.bottom + 1 || r.left < b.left - 1 || r.right > b.right + 1) out.push(`${selector}: its words spill out of it`);
    }
    if (oneRow && Math.max(...middles) - Math.min(...middles) > 2) out.push(`the foot is not one row: ${middles.map(Math.round).join(', ')}`);
    if (document.documentElement.scrollWidth > innerWidth) out.push('the page scrolls sideways');
    return out;
  }, oneRow);
}

/** Controls whose press does not reach 44 px around their middle, by hit test (an overlay takes the press). */
async function shortTargets(page: Page, selectors: readonly string[]): Promise<string[]> {
  return card(page).evaluate((root, selectors) => {
    const out: string[] = [];
    for (const selector of selectors) {
      const el = root.querySelector<HTMLElement>(selector);
      if (!el) {
        out.push(`${selector} is missing`);
        continue;
      }
      const b = el.getBoundingClientRect();
      const x = (b.left + b.right) / 2;
      const y = (b.top + b.bottom) / 2;
      for (const [dx, dy] of [[0, -21.5], [0, 21.5], [-21.5, 0], [21.5, 0]] as const) {
        const hit = document.elementFromPoint(x + dx, y + dy);
        if (!hit || !(el === hit || el.contains(hit))) out.push(`${selector} at (${dx}, ${dy}) presses ${hit?.tagName}.${hit?.className}`);
      }
    }
    return out;
  }, selectors);
}

const FOOT_TARGETS = ['.ib-fcomp-clip', '[data-fcomp-comments]', '[data-fcomp-questions]', '[data-voice-mic]', '[data-fcomp-open-thread]'];
const TOP_TARGETS = ['[data-fcomp-mode="comment"]', '[data-fcomp-mode="reply"]', '[data-fcomp-minimize]', '[data-fcomp-send]'];

test.describe.configure({ mode: 'serial' });

let seeded: { two: Thread; twelve: Thread; longName: Thread };

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-inbox-floating-box-');
  const dataDir = join(root, 'data');
  const env = { PATH: process.env.PATH ?? '', PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_UPDATE_CHECK: '0', PLANNOTATOR_INBOX_NOTES: '0', PLANNOTATOR_TEST_SANDBOX: '1', NO_ANON_PING: '1' };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  url = started.stdout.trim();
  project = scratchProject(join(root, 'src'), 'widgets');
  mkdirSync(join(project, 'f'));
  writeFileSync(join(project, 'f', 'plan.md'), '# Plan\n\nsome words\n');
  writeFileSync(join(project, 'f', 'shot.png'), png(1920, 1080, [70, 130, 240]));
  writeFileSync(join(project, 'f', 'page.html'), '<!doctype html><meta charset="utf-8"><title>Page</title><h1>A page</h1><p>Some words.</p>');
  short = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  long = await SimAgent.connect({ binary, env, name: LONG_NAME, host: 'codex' });
  seeded = { two: await seed(short, 2), twelve: await seed(short, 12), longName: await seed(long, 12) };
  serverSession = ((await (await fetch(new URL('/api/inbox/settings', url))).json()) as { serverSession: string }).serverSession;
  const on = await fetch(new URL('/api/inbox/settings', url), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: new URL(url).origin }, body: JSON.stringify({ serverSession, voice: { on: true } }) });
  expect(on.status).toBe(200);
});

test.afterAll(async () => {
  try {
    await short?.close().catch(() => {});
    await long?.close().catch(() => {});
  } finally {
    await removeInboxScratch();
  }
});

const PHONES = [
  { name: 'WebKit', launch: () => webkit.launch({ args: [] }), device: devices['iPhone 15'] },
  { name: 'Chromium', launch: () => chromium.launch(), device: devices['Pixel 7'] },
];

for (const phone of PHONES) {
  test.describe(phone.name, () => {
    let browser: Browser;
    let page: Page;

    test.beforeAll(async () => {
      browser = await phone.launch();
      const { defaultBrowserType: _ignored, ...device } = phone.device;
      const context = await browser.newContext({ ...device, colorScheme: 'dark' });
      page = await context.newPage();
      await page.emulateMedia({ reducedMotion: 'reduce' });
    });

    test.afterAll(async () => {
      await browser?.close().catch(() => {});
    });

    for (const [width, height] of [[320, 568], [390, 844]] as const) {
      test(`${width} px, an image and a page: the foot is one row with the questions chip, every press 44 px`, async () => {
        await page.setViewportSize({ width, height });
        for (const t of [seeded.two, seeded.twelve]) {
          for (const file of ['shot.png', 'page.html']) {
            await page.goto('about:blank');
            await page.goto(fileUrl(t, file));
            if (file === 'page.html') {
              await page.locator('.ib-htmlframe iframe').waitFor();
              await page.locator('[data-fcomp-pill]').tap();
            }
            await card(page).waitFor();
            if (file === 'shot.png') await page.locator('[data-fcomp-mode="reply"]').tap();
            const where = `${width} px, ${file}, ${t === seeded.two ? 2 : 12} comments`;
            await expect(card(page).locator('[data-fcomp-questions]'), where).toBeVisible();
            await expect(card(page).locator('[data-voice-mic]'), where).toBeVisible();
            await expect.poll(() => footProblems(page), { message: where }).toEqual([]);
            expect(await shortTargets(page, FOOT_TARGETS), where).toEqual([]);
            expect(await shortTargets(page, file === 'shot.png' ? TOP_TARGETS : ['[data-fcomp-minimize]', '[data-fcomp-send]']), where).toEqual([]);
            // The pill's name is whole, however little of it shows; and the row chooses that over the link's words.
            await expect(card(page).locator('[data-fcomp-comments]'), where).toHaveAccessibleName(`${t === seeded.two ? 2 : 12} comments`);
            await expect(card(page).locator('[data-fcomp-open-thread]'), where).toHaveAccessibleName('Open in thread');
            await expect(card(page).locator('[data-fcomp-open-thread] .ib-fcomp-lo'), where).toHaveCSS('clip', 'auto');
          }
        }
      });
    }

    test('what yields: at 320 the pill is its icon and number, at 390 its words come back beside the bare count', async () => {
      await page.setViewportSize({ width: 320, height: 568 });
      await page.goto('about:blank');
      await page.goto(fileUrl(seeded.twelve, 'shot.png'));
      await card(page).waitFor();
      await page.locator('[data-fcomp-mode="reply"]').tap();
      const word = card(page).locator('[data-fcomp-comments] .ib-fcomp-w');
      await expect(word).not.toHaveCSS('clip', 'auto');
      await expect(card(page).locator('[data-fcomp-questions]')).toHaveText('3');
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(word).toHaveCSS('clip', 'auto');
      await expect(card(page).locator('[data-fcomp-questions]')).toHaveAttribute('aria-label', '3 open questions');
    });

    test('text at twice the size: the chips take a row of their own, and nothing leaves the box', async () => {
      await page.setViewportSize({ width: 320, height: 568 });
      await page.goto('about:blank');
      await page.goto(fileUrl(seeded.twelve, 'shot.png'));
      await card(page).waitFor();
      await page.locator('[data-fcomp-mode="reply"]').tap();
      await page.evaluate(() => document.documentElement.style.setProperty('--inbox-text-size', '28'));
      await expect.poll(() => footProblems(page, false)).toEqual([]);
      const [chip, q, clip, link] = await Promise.all(['[data-fcomp-comments]', '[data-fcomp-questions]', '.ib-fcomp-clip', '[data-fcomp-open-thread]'].map(async (s) => (await card(page).locator(s).boundingBox())!));
      expect(Math.abs(chip!.y + chip!.height / 2 - (q!.y + q!.height / 2))).toBeLessThanOrEqual(1);
      expect(chip!.y + chip!.height).toBeLessThanOrEqual(clip!.y + 1);
      expect(chip!.y + chip!.height).toBeLessThanOrEqual(link!.y + 1);
    });

    test('a long agent: its name is cut on one line, in the header and in “Sent to …”', async () => {
      await page.setViewportSize({ width: 320, height: 568 });
      await page.goto('about:blank');
      await page.goto(fileUrl(seeded.longName, 'page.html'));
      await page.locator('.ib-htmlframe iframe').waitFor();
      await page.locator('[data-fcomp-pill]').tap();
      await card(page).waitFor();
      const lines = (selector: string) =>
        card(page).locator(selector).evaluate((el) => {
          const range = document.createRange();
          range.selectNodeContents(el);
          return new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.bottom))).size;
        });
      const solo = (await card(page).locator('.ib-fcomp-solo').boundingBox())!;
      const box = (await card(page).boundingBox())!;
      expect(solo.height).toBeLessThanOrEqual(26);
      expect(solo.x + solo.width).toBeLessThanOrEqual(box.x + box.width);
      await card(page).locator('[data-fcomp-field] textarea').fill('Going left.');
      await card(page).locator('[data-fcomp-send]').tap();
      await expect(card(page).locator('[data-fcomp-sent]')).toBeVisible();
      expect(await lines('[data-fcomp-sent] .ib-fcomp-sentl')).toBe(1);
      const sent = (await card(page).locator('[data-fcomp-sent]').boundingBox())!;
      const link = (await card(page).locator('[data-fcomp-open-thread]').boundingBox())!;
      expect(sent.x + sent.width).toBeLessThanOrEqual(link.x);
      // The fit went with the chips: the link has its words.
      await expect(card(page).locator('[data-fcomp-foot]')).not.toHaveAttribute('data-fit', /.*/);
    });

    test('a folded pill and the toolbar never touch, from 320 to 430, with and without a draft', async () => {
      const t = await seed(short, 2);
      const clear = async (where: string, sharesRowAt: number | null, width: number) => {
        await page.setViewportSize({ width, height: 700 });
        await expect
          .poll(async () => {
            const [pill, bar] = await Promise.all([page.locator('[data-fcomp-pill]').boundingBox(), page.locator('[data-full-view-bar]').boundingBox()]);
            const apart = pill!.x + pill!.width <= bar!.x || pill!.y + pill!.height <= bar!.y;
            return apart && pill!.x >= 0 && pill!.y + pill!.height <= 700;
          }, { message: where })
          .toBe(true);
        const [pill, bar] = await Promise.all([page.locator('[data-fcomp-pill]').boundingBox(), page.locator('[data-full-view-bar]').boundingBox()]);
        if (sharesRowAt !== null && width >= sharesRowAt) expect(Math.abs(pill!.y + pill!.height - (bar!.y + bar!.height)), `${where}: on the toolbar's row`).toBeLessThanOrEqual(2);
      };
      await page.goto('about:blank');
      await page.goto(fileUrl(t, 'page.html'));
      await page.locator('.ib-htmlframe iframe').waitFor();
      await page.locator('[data-fcomp-pill]').waitFor();
      for (const width of [320, 360, 375, 390, 430]) await clear(`${width} px, no draft`, 390, width);
      await page.setViewportSize({ width: 390, height: 700 });
      await page.locator('[data-fcomp-pill]').tap();
      await card(page).locator('[data-fcomp-field] textarea').fill('Words wait here.');
      await card(page).locator('[data-fcomp-minimize]').tap();
      await page.locator('[data-full-view-handle]').tap();
      // The corner control brings the card back: this time the card's words fold into the pill of a fresh page.
      await page.goto('about:blank');
      await page.goto(fileUrl(t, 'page.html'));
      await page.locator('.ib-htmlframe iframe').waitFor();
      await expect(page.locator('[data-fcomp-pill]')).toContainText('Draft');
      for (const width of [320, 360, 390, 430]) await clear(`${width} px, a draft`, 430, width);
    });

    test('the comments sheet: the pill and the box step aside from Write the reply, and come back', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      for (const [file, standing] of [['page.html', '[data-fcomp-pill]'], ['shot.png', '[data-fcomp]']] as const) {
        await page.goto('about:blank');
        await page.goto(fileUrl(seeded.two, file));
        await page.locator(standing).waitFor();
        await page.locator('[data-full-view-bar] .ib-fvcount').tap();
        const write = page.locator('[data-full-view-foot]').getByRole('button', { name: 'Write the reply' });
        await write.waitFor();
        await expect(page.locator(standing)).toBeHidden();
        const free = await write.evaluate((el) => {
          const b = el.getBoundingClientRect();
          return [[b.left + 6, b.top + b.height / 2], [b.left + b.width / 2, b.top + b.height / 2], [b.right - 6, b.top + b.height / 2]].every(([x, y]) => el.contains(document.elementFromPoint(x!, y!)));
        });
        expect(free, file).toBe(true);
        await page.locator('.ib-sheet-h button').last().tap();
        await expect(page.locator(standing)).toBeVisible();
      }
    });
  });
}

test('a desktop window: the foot keeps its words and takes no phone fit', async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const page = await context.newPage();
    await page.goto(fileUrl(seeded.twelve, 'shot.png'));
    await card(page).waitFor();
    await page.locator('[data-fcomp-mode="reply"]').click();
    await expect(card(page).locator('[data-fcomp-foot]')).not.toHaveAttribute('data-fit', /.*/);
    await expect(card(page).locator('[data-fcomp-comments]')).toHaveText('12 comments');
    await expect(card(page).locator('[data-fcomp-open-thread]')).toHaveText('Open in thread');
    const chip = (await card(page).locator('[data-fcomp-comments]').boundingBox())!;
    expect(chip.height).toBe(22);
  } finally {
    await context.close();
  }
});
