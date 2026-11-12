import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { inboxScratch, removeInboxScratch } from './inbox-scratch';
import { forgetFileViewChoice } from './file-view';

const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? '.local/plannotator');
const shots = process.env.PLANNOTATOR_CONTENTS_SHOTS ?? '';
const HEADINGS = ['Refund worker plan', 'Context', 'Design', 'Idempotency keys', 'Rollout', 'Risks'];
const plan = [
  '# Refund worker plan',
  'Move refunds to a background worker.',
  '## Context',
  '| Step | Owner |\n| --- | --- |\n| Shadow week | billing |\n| Switch | billing |',
  ...Array.from({ length: 12 }, (_, i) => `Context paragraph ${i + 1}: refunds run inline in the admin request today.`),
  '## Design',
  ...Array.from({ length: 12 }, (_, i) => `Design paragraph ${i + 1}: a worker claims each job and calls Stripe.`),
  '### Idempotency keys',
  'One key per charge and request.',
  '## Rollout',
  ...Array.from({ length: 12 }, (_, i) => `Rollout paragraph ${i + 1}: a shadow week before the switch.`),
  '## Risks',
  ...Array.from({ length: 30 }, (_, i) => `Risk paragraph ${i + 1}: Stripe rate limits and a slow dead-letter queue.`),
].join('\n\n');

async function shot(page: Page, name: string): Promise<void> {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  const size = page.viewportSize()!;
  await page.mouse.move(size.width - 60, size.height - 120);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(shots, `${name}.png`) });
}

async function withPlan(
  browser: Browser,
  viewport: { width: number; height: number },
  view: 'side' | 'full',
  run: (page: Page, pane: Locator) => Promise<void>,
  colorScheme: 'light' | 'dark' = 'light',
  text = plan,
): Promise<void> {
  const root = inboxScratch('plannotator-contents-');
  const home = join(root, 'home');
  mkdirSync(home);
  const env = {
    PATH: process.env.PATH ?? '', HOME: home, PLANNOTATOR_DATA_DIR: join(root, 'data'),
    PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9', PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_INBOX_TAILSCALE: '0', PLANNOTATOR_INBOX_PHONES: '0',
    PLANNOTATOR_UPDATE_CHECK: '0', PLANNOTATOR_INBOX_NOTES: '0',
  };
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce', colorScheme });
  let agent: SimAgent | undefined;
  try {
    const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
    expect(started.status, started.stderr).toBe(0);
    const url = started.stdout.trim();
    const project = scratchProject(join(root, 'src'), 'billing');
    writeFileSync(join(project, 'refund-plan.md'), text);
    agent = await SimAgent.connect({ binary, env, name: 'Claude', host: 'claude-code' });
    const sent = await agent.send({ project_path: project, subject: 'Refund worker plan', body: 'The plan is attached.', attachments: ['refund-plan.md'] });
    const model = await (await fetch(new URL(`/api/inbox/threads/${sent.thread_id}/attachments`, url))).json() as { attachments: { id: string }[] };
    const page = await context.newPage();
    await page.goto(`${url}#thread=${sent.thread_id}&file=${model.attachments[0]!.id}&view=${view}`);
    const pane = page.locator('[data-attachment-pane]');
    await expect(pane.locator('[data-doc-text-root]')).toContainText('Refund worker plan');
    await run(page, pane);
    await forgetFileViewChoice(page);
  } finally {
    try {
      await agent?.close();
      await context.close();
    } finally {
      await removeInboxScratch(root);
    }
  }
}

async function railParts(pane: Locator) {
  const rail = pane.locator('nav[aria-label="Document contents"]');
  await expect(rail).toBeVisible();
  const ticks = rail.locator('[data-contents-index]');
  const lane = (await ticks.first().boundingBox())!;
  const column = (await pane.locator('.ib-docscroll [data-doc-text-root]').boundingBox())!;
  const scroller = pane.locator('.ib-docscroll');
  const page = (await scroller.boundingBox())!;
  return { rail, ticks, lane, column, scroller, page };
}

for (const layout of ['side', 'full'] as const) {
  const viewport = layout === 'side' ? { width: 1680, height: 1000 } : { width: 1440, height: 900 };
  test(`${layout}: the rail sits in the page's right gutter; a tick opens Contents; a pick scrolls there and is marked`, async ({ browser }) => {
    await withPlan(browser, viewport, layout, async (page, pane) => {
      const { rail, ticks, lane, column, scroller, page: pageBox } = await railParts(pane);
      expect(await ticks.count()).toBe(HEADINGS.length);
      expect(Math.round(lane.x - (column.x + column.width))).toBe(24);
      expect(lane.x + lane.width).toBeLessThanOrEqual(pageBox.x + pageBox.width);
      await expect(pane.locator('.ib-apanel nav[aria-label="Document contents"], .ib-apanel [data-contents]')).toHaveCount(0);
      await expect(pane.locator('[data-contents-open], [data-contents-show]')).toHaveCount(0);
      const railBox = (await rail.boundingBox())!;
      expect(Math.abs(railBox.y + railBox.height / 2 - (pageBox.y + pageBox.height / 2))).toBeLessThan(2);
      const strip = (await pane.locator('.ib-toolstrip').boundingBox())!;
      expect(strip.x + strip.width).toBeLessThan(lane.x);
      await expect(ticks.first()).toHaveAttribute('aria-current', 'location');
      if (layout === 'side') {
        await shot(page, 'final-side-1680-light');
      } else {
        await shot(page, 'final-full-1440-light');
      }

      await ticks.nth(4).click();
      await expect(rail).toHaveAttribute('data-revealed', '');
      await expect(rail.locator('.pn-contents-rail-label')).toHaveText(HEADINGS);
      await expect(rail.getByRole('button', { name: 'Go to Refund worker plan / Design / Idempotency keys' })).toBeVisible();
      if (layout === 'side') await shot(page, 'final-side-1680-open-light');

      await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(0);
      await rail.getByRole('button', { name: 'Go to Refund worker plan / Rollout' }).click();
      await expect.poll(async () => {
        const heading = (await pane.locator('#rollout').boundingBox())!;
        return heading.y >= pageBox.y && heading.y < pageBox.y + pageBox.height / 2;
      }).toBe(true);
      await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
      await expect(rail.locator('[aria-current="location"] .pn-contents-rail-label')).toHaveText('Rollout');

      await page.keyboard.press('Escape');
      await expect(rail).not.toHaveAttribute('data-revealed', '');
      if (layout === 'full') {
        await expect(pane).toHaveClass(/\bib-fullview\b/);
        await page.locator('[data-full-view-comments]').click();
        const drawer = (await pane.locator('[data-comments-drawer="open"]').boundingBox())!;
        await expect.poll(async () => {
          if ((await rail.count()) === 0 || !(await rail.isVisible())) return 'yielded';
          const tick = await rail.locator('[data-contents-index]').first().boundingBox();
          return tick && tick.x + tick.width <= drawer.x ? 'clear' : 'under';
        }).not.toBe('under');
      }
    });
  });
}

async function columnOf(pane: Locator) {
  const column = (await pane.locator('.ib-docscroll [data-doc-text-root]').boundingBox())!;
  const content = await pane.locator('.ib-docscroll').evaluate((el) => {
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const left = box.left + el.clientLeft + parseFloat(style.paddingLeft);
    return { left, width: el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) };
  });
  return { column, content };
}

function todaysColumn(content: { left: number; width: number }) {
  const width = Math.min(640, content.width);
  return { left: content.left + (content.width - width) / 2, width };
}

for (const [width, height, scheme] of [[1440, 900, 'light'], [1440, 900, 'dark'], [1512, 982, 'light']] as const) {
  test(`side by side at ${width}, ${scheme}: the column narrows on its right, its left edge kept, and the rail shows beside it`, async ({ browser }) => {
    await withPlan(browser, { width, height }, 'side', async (page, pane) => {
      const { ticks, lane } = await railParts(pane);
      expect(await ticks.count()).toBe(HEADINGS.length);
      await expect(pane.locator('[data-contents-open], [data-contents-show]')).toHaveCount(0);
      const { column, content } = await columnOf(pane);
      const today = todaysColumn(content);
      expect(Math.abs(column.x - today.left)).toBeLessThan(1);
      expect(column.width).toBeLessThan(today.width);
      expect(lane.x).toBeGreaterThanOrEqual(column.x + column.width + 23);
      const pageBox = (await pane.locator('.ib-docscroll').boundingBox())!;
      expect(lane.x + lane.width).toBeLessThanOrEqual(pageBox.x + pageBox.width);
      const covered = await page.evaluate(() => [...document.querySelectorAll('.pn-contents-rail [data-contents-index]')].some((tick) => {
        const box = tick.getBoundingClientRect();
        const el = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return !el?.closest('.pn-contents-rail');
      }));
      expect(covered).toBe(false);
      console.log(`side ${width}: text column ${Math.round(column.width)} px (today ${Math.round(today.width)} px), left ${Math.round(column.x)}`);
      await shot(page, `final-side-${width}-${scheme}`);
    }, scheme);
  });
}

test('side by side at 1440: Hide then Show, focus following each; reloaded with the rail hidden, Show is offered and works', async ({ browser }) => {
  await withPlan(browser, { width: 1440, height: 900 }, 'side', async (page, pane) => {
    const { rail, ticks } = await railParts(pane);
    const show = pane.locator('[data-contents-show]');
    await ticks.first().click();
    await expect(rail).toHaveAttribute('data-revealed', '');
    await rail.locator('[data-contents-hide]').focus();
    await page.keyboard.press('Enter');
    await expect(rail).toHaveCount(0);
    await page.waitForTimeout(500);
    await expect(show).toBeVisible();
    await expect(show).toBeFocused();
    await expect(pane.locator('[data-contents-open]')).toHaveCount(0);

    await page.keyboard.press('Enter');
    await expect(rail).toBeVisible();
    await expect(rail.locator('[data-contents-index][aria-current="location"]')).toBeFocused();
    await expect(show).toHaveCount(0);

    await rail.locator('[data-contents-index]').first().click();
    await rail.locator('[data-contents-hide]').click();
    await expect(show).toBeVisible();
    await page.reload();
    await expect(pane.locator('[data-doc-text-root]')).toContainText('Refund worker plan');
    await page.waitForTimeout(500);
    await expect(show).toBeVisible();
    await expect(pane.locator('[data-contents-open], nav[aria-label="Document contents"]')).toHaveCount(0);
    await show.click();
    await expect(rail).toBeVisible();
    await expect(rail.locator('[data-contents-index][aria-current="location"]')).toBeFocused();
  });
});

test('side by side at 1440: a file without a rail keeps today\'s column', async ({ browser }) => {
  const short = '# Refund worker plan\n\nMove refunds to a background worker.\n\n## Context\n\nInline today.\n\n## Design\n\nA worker.\n';
  await withPlan(browser, { width: 1440, height: 900 }, 'side', async (page, pane) => {
    await page.waitForTimeout(1_000);
    await expect(pane.locator('nav[aria-label="Document contents"], [data-contents-open], [data-contents-show]')).toHaveCount(0);
    const { column, content } = await columnOf(pane);
    const today = todaysColumn(content);
    expect(Math.abs(column.x - today.left)).toBeLessThan(1);
    expect(Math.abs(column.width - today.width)).toBeLessThan(1);
  }, 'light', short);
});

test('full screen at 880 (a gutter under 68 px): the rail yields and the Contents button opens the sheet', async ({ browser }) => {
  await withPlan(browser, { width: 880, height: 900 }, 'full', async (page, pane) => {
    const open = pane.locator('[data-contents-open]');
    await expect(open).toBeVisible();
    await expect(pane.locator('nav[aria-label="Document contents"]')).toHaveCount(0);
    await shot(page, 'final-narrow-fallback-light');
    await open.click();
    const sheet = page.locator('[data-contents="sheet"][role="dialog"]');
    await expect(sheet).toBeVisible();
    expect(await sheet.locator('nav[aria-label="Table of contents"] button').allTextContents()).toEqual(HEADINGS);
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    const strip = pane.locator('.ib-toolstrip');
    await expect(strip).toBeVisible();
    await page.locator('[data-full-view-hide]').click();
    await expect(page.locator('[data-full-view-dock]')).toHaveAttribute('data-bar', 'tucked');
    await expect(open).toBeHidden();
    await expect(strip).toBeHidden();
    await page.locator('[data-full-view-handle]').click();
    await expect(page.locator('[data-full-view-dock]')).toHaveAttribute('data-bar', 'pinned');
    await expect(open).toBeVisible();
    await expect(strip).toBeVisible();
  });
});

test('phone: the sheet opened mid-document marks the section being read; 44 px rows; Escape closes it to the button', async ({ browser }) => {
  await withPlan(browser, { width: 390, height: 844 }, 'full', async (page, pane) => {
    const scroller = pane.locator('.ib-docscroll');
    await expect(pane.locator('nav[aria-label="Document contents"]')).toHaveCount(0);
    await scroller.evaluate((el) => {
      const design = el.querySelector<HTMLElement>('#design')!;
      el.scrollTop += design.getBoundingClientRect().top - el.getBoundingClientRect().top + 300;
    });
    const open = pane.locator('[data-contents-open]');
    await open.click();
    const sheet = page.locator('[data-contents="sheet"][role="dialog"]');
    await expect(sheet).toBeVisible();
    await expect(sheet.locator('nav button[aria-current="location"]')).toHaveText('Design');
    await shot(page, 'final-phone-sheet-light');

    for (const row of await sheet.locator('nav button').all()) {
      expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    expect(await sheet.locator('nav button').first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(15);

    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    await expect(open).toBeFocused();
    await expect(pane).toHaveClass(/\bib-fullview\b/);
  });
});

test('side by side: a table popout covers the rail, which is neither on top nor clickable while it is open', async ({ browser }) => {
  await withPlan(browser, { width: 1680, height: 1000 }, 'side', async (page, pane) => {
    const { rail, ticks, scroller } = await railParts(pane);
    const tick = (await ticks.nth(2).boundingBox())!;
    const point = { x: tick.x + tick.width / 2, y: tick.y + tick.height / 2 };
    await pane.locator('.ib-docscroll table tr').first().hover();
    await page.getByTitle('Expand table').first().click();
    const popout = page.locator('[data-popout]');
    await expect(popout).toBeVisible();

    const onTop = await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      return { inRail: !!el?.closest('.pn-contents-rail'), inPopout: !!el?.closest('[data-popout]') };
    }, point);
    expect(onTop.inRail).toBe(false);
    expect(onTop.inPopout).toBe(true);
    await expect(rail).toBeHidden();
    const before = await scroller.evaluate((el) => el.scrollTop);
    expect(await ticks.nth(2).click({ trial: true, timeout: 1_000 }).then(() => 'clickable', () => 'not clickable')).toBe('not clickable');
    await expect(rail).not.toHaveAttribute('data-revealed', '');
    expect(await scroller.evaluate((el) => el.scrollTop)).toBe(before);

    await page.keyboard.press('Escape');
    await expect(popout).toHaveCount(0);
    await expect(rail).toBeVisible();
  });
});

async function startPlanReview(): Promise<{ url: string; close: () => Promise<void> }> {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  const root = inboxScratch('plannotator-contents-plan-');
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  const readyFile = join(root, 'ready.jsonl');
  const env = {
    PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_READY_FILE: readyFile,
    PLANNOTATOR_BROWSER: NO_BROWSER, NO_BROWSER, PLANNOTATOR_SKIP_BROWSER_OPEN: '1', PLANNOTATOR_REMOTE: '0',
    PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_UPDATE_CHECK: '0',
  };
  const child: ChildProcess = spawn(binary, [], { env, cwd: root, stdio: ['pipe', 'ignore', 'ignore'] });
  child.stdin!.end(
    JSON.stringify({
      session_id: 'e2e', transcript_path: join(root, 'transcript.jsonl'), cwd: root, permission_mode: 'plan',
      hook_event_name: 'PermissionRequest', tool_name: 'ExitPlanMode', tool_input: { plan },
    }),
  );
  await expect.poll(() => (existsSync(readyFile) ? readFileSync(readyFile, 'utf8') : ''), { timeout: 30_000 }).toContain('"url"');
  const url = (JSON.parse(readFileSync(readyFile, 'utf8').trim().split('\n')[0]!) as { url: string }).url;
  return {
    url,
    close: async () => {
      if (child.exitCode === null) {
        await fetch(new URL('/api/deny', url), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ feedback: 'e2e teardown', planSave: { enabled: false } }),
        }).catch(() => {});
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
    },
  };
}

test('plan review is unchanged: its Contents list, and no rail', async ({ browser }) => {
  const session = await startPlanReview();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  try {
    await context.addCookies(
      [
        ['plannotator-theme', 'light'],
        ['plannotator-plan-look-choice-resolved', 'true'],
        ['plannotator-announce-tui-herdr-seen', '1'],
        ['plannotator-announce-inbox-seen', '1'],
        ['plannotator-announce-ask-session-seen', '1'],
        ['plannotator-announce-agent-tool-seen', '1'],
        ['plannotator-permission-mode-configured', 'true'],
      ].map(([name, value]) => ({ name: name!, value: value!, url: session.url })),
    );
    const page = await context.newPage();
    await page.goto(session.url);
    await expect(page.locator('#rollout')).toHaveCount(1);
    await expect(page.locator('nav[aria-label="Table of contents"]').first()).toBeVisible();
    await page.waitForTimeout(2_500);
    await expect(page.locator('nav[aria-label="Document contents"], .pn-contents-rail')).toHaveCount(0);
    await shot(page, 'final-plan-review-unchanged-light');
  } finally {
    await context.close();
    await session.close();
  }
});
