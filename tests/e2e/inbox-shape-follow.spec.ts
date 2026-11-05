/**
 * Follow an example's card in a real browser, on the compiled binary: what
 * only real layout can show. The example is invented, and its long step sits at
 * the format's limits (12 inputs, 12 checks).
 *
 * What it proves:
 *  - a normal row reads on one line with its file name whole; a cut name has no gap before ":line";
 *  - stepping never moves the board, the arrows or the path, and a short step in a tall example ends the card under it;
 *  - the long step keeps its signature and its deciding line in view;
 *  - folded, the arrows and the picture still step;
 *  - a phone keeps the path: every stop, the one on now in view, at the top of the sheet while it scrolls;
 *  - one column beside a board: what decided it first, nothing on top of anything, the dock's every button on screen;
 *  - a path too long for its room keeps the stop on now in view, on the rail and on a phone.
 *
 * Build first: see inbox.spec.ts.
 */
import { devices, expect, test, type Browser, type Page } from '@playwright/test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { removeInboxScratch } from './inbox-scratch';
import { seedShapeWorld, type ShapeWorld } from './inbox-shape-seed';
// @ts-expect-error the kit is plain JavaScript, with no types
import { box, part, svg, text } from '../../packages/core/shape-kit.mjs';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const { defaultBrowserType: _phoneBrowser, ...phone } = devices['iPhone 15'];
let w: ShapeWorld;
let id: string;

const HOME = 'src/snoozeIntro.ts';
const LONG = 'src/tailnet/inbox-tailnet-guest-policy-middleware-for-claims.ts';
const at = (line: number, path = HOME) => ({ path, line });
const out = (name: string, value = 'true') => ({ name, value, type: 'boolean' });
const check = (code: string, more = {}) => ({ code, saw: 'true', result: 'pass', ...more });

const SHORT = {
  part: 'a',
  tag: 'left after 9 s',
  text: 'You leave the thread',
  inputs: [{ name: 'visit.at', value: '12:00:00', from: at(163) }],
  signature: 'leaveCounts(visit: Visit): boolean',
  checks: [check('now - visit.at >= READ_MS', { constant: '5_000', saw: '9_000', decides: true })],
  output: out('moment'),
  code: at(80),
};
const NORMAL = {
  part: 'b',
  tag: 'all hold',
  text: 'The page checks its own rules',
  inputs: [
    { name: 'settled', value: 'true', from: { step: 1 } },
    { name: 'gate.pageAge', value: '240_000', reading: '4 min', from: at(196) },
    { name: 'gate.rows.length', value: '6', from: at(105) },
    { name: 'readAndLeft', value: '2', reading: 'rows', from: at(27, 'src/snoozeIntroRows.ts') },
  ],
  signature: 'mayClaim(gate: Gate, now: Date): boolean',
  checks: [check('gate.pageAge >= PAGE_AGE_MS', { saw: '240_000' }), check('need(gate.rows, now)', { decides: true })],
  output: out('mayClaim'),
  code: at(118),
};
const names = ['request.auth.tailnetIdentity.userLoginName', 'ownerConfig.tailnetGuestPolicy.allowSnoozeIntroClaims', 'saved.snoozeIntroFirstUseAt', 'saved.snoozeIntroSnoozedAt', 'saved.snoozeIntroShownAt', 'attemptsInThisBrowserSession', 'limiter.remainingClaimsForThisNode', 'release', 'now', 'overlay.open', 'session.kind'];
const LONG_STEP = {
  part: 'c',
  tag: 'guest, not the owner',
  text: 'The Inbox checks who is asking, and turns a guest away before it stamps anything',
  inputs: [{ name: 'mayClaim', value: 'true', from: { step: 2 } }, ...names.map((name, i) => ({ name, value: i % 2 ? `'${name}-${i}'` : String(i), from: at(200 + i, LONG) }))],
  signature: 'resolveClaimEligibilityForTailnetIdentity(request: AuthenticatedInboxRequest<ClaimBody>, saved: SnoozeIntroSaved | undefined, options: { now: Date; release: string; policy: TailnetGuestPolicy }): Promise<ClaimDecision>',
  checks: Array.from({ length: 12 }, (_, i) => (i === 9 ? check(`request.auth.tailnetIdentity.userLoginName === ownerConfig.ownerLoginName || ownerConfig.tailnetGuestPolicy.allowSnoozeIntroClaims || rule${i}(request, saved, options.policy)`, { decides: true }) : i < 9 ? check(`rule${i}(request, saved, options.policy)`) : { code: `rule${i}(request)`, result: 'not-reached' })).map((c, i) => (i === 9 ? { ...c, result: 'fail', saw: 'false', short: 'a guest, and guests may not claim' } : c)),
  output: { name: 'decision', value: "{ show: false, reason: 'tailnet-guest' }", type: 'ClaimDecision' },
  code: at(148, 'src/claimEligibility.ts'),
};
const steps = [SHORT, NORMAL, LONG_STEP, { ...SHORT, part: 'd', tag: 'nothing shows', text: 'Nothing shows for the guest', inputs: [{ name: 'decision.show', value: 'false', from: { step: 3 } }] }];
const parts = ['a', 'b', 'c', 'd'].map((p, i) => part(p, i + 1, box(20 + i * 220, 60, 190, 90), text(40 + i * 220, 110, `Part ${p}`))).join('');
const longWay = Array.from({ length: 12 }, (_, i) => ({ ...SHORT, part: 'abcd'[i % 4], tag: `stop ${i + 1}`, text: `Stop ${i + 1} on the long way` }));
const board = {
  title: 'Follow one example',
  claim: 'Built. Nothing waits on you.',
  // Every view and a reference, so the dock is as wide as it gets.
  views: {
    picture: { html: '<p>The picture</p>', css: '' },
    know: 'What to know.[^1]',
    how: {
      ...svg(920, 220, parts),
      examples: [
        { name: 'A guest leaves', title: 'A guest leaves a thread', steps },
        { name: 'The long way', title: 'The long way round', steps: longWay },
      ],
    },
  },
  refs: [{ n: 1, kind: 'link', title: 'Reference 1', target: 'https://example.com/ref' }],
};

async function openBoard(browser: Browser, options: Parameters<Browser['newContext']>[0] = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options });
  await context.route((url) => !['127.0.0.1', 'localhost'].includes(url.hostname), (route) => route.abort());
  const page = await context.newPage();
  await page.goto(`${w.url}#thread=${w.threads.snooze}&shape=${id}&view=how`);
  await page.locator('.shp-dock button[title="How it works"]').click();
  await page.locator('[data-follow]').click();
  await page.getByRole('button', { name: 'Step through' }).click();
  await settle(page);
  return { context, page };
}
const settle = (page: Page) => page.waitForTimeout(420);
const press = async (page: Page, name: string) => {
  await page.getByRole('button', { name, exact: true }).first().click();
  await settle(page);
};
const rect = (page: Page, selector: string) =>
  page.evaluate((s) => {
    const r = document.querySelector(s)?.getBoundingClientRect();
    return r ? { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom), width: Math.round(r.width), height: Math.round(r.height) } : null;
  }, selector);

test.beforeAll(async () => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  w = await seedShapeWorld({ binary, shape: true, boards: 'none' });
  const dir = join(w.root, 'boards', 'follow');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'board.json'), JSON.stringify(board));
  const r = w.shape(['update', '--file', join(dir, 'board.json'), '--project', w.projects.plannotator!, '--thread', w.threads.snooze!]);
  expect(r.status, r.stderr).toBe(0);
  id = (JSON.parse(r.stdout) as { id: string }).id;
});
test.afterAll(async () => {
  for (const agent of w?.agents ?? []) await agent.close().catch(() => {});
  await removeInboxScratch();
});

test('the path: rows read on one line, stepping moves nothing, a short step ends the card under it', async ({ browser }) => {
  const { context, page } = await openBoard(browser);
  // Opening goes straight to the rail: the one-column strip must not flash on the way.
  await page.evaluate(() => {
    const seen = window as unknown as { stripSeen?: boolean };
    new MutationObserver(() => {
      if (document.querySelector('.shp-ex-strip')) seen.stripSeen = true;
    }).observe(document.body, { childList: true, subtree: true });
  });
  await press(page, 'Inputs and outputs');
  await expect(page.locator('.shp-ex-rail .shp-ex-stop')).toHaveCount(steps.length);
  expect(await page.evaluate(() => (window as unknown as { stripSeen?: boolean }).stripSeen ?? false)).toBe(false);

  const held = () => Promise.all([rect(page, '.shp-view.v-how .shp-drawn-fit'), rect(page, '.shp-ex-rail .shp-ex-stop'), rect(page, '[aria-label="Next step"]'), rect(page, '.shp-ex-card')]);
  const first = await held();
  expect(first.every(Boolean)).toBe(true);

  // A short step: the surface ends under it, and everything it shows is on the surface.
  const short = (await rect(page, '.shp-ex-skin'))!;
  const card = (await rect(page, '.shp-ex-card'))!;
  expect(card.height - short.height).toBeGreaterThanOrEqual(96);
  for (const part of ['.shp-ex-io.cur .shp-ex-ret', '.shp-ex-rail .shp-ex-note', '.shp-ex-rail .shp-ex-stop:last-child']) expect((await rect(page, part))!.bottom).toBeLessThanOrEqual(short.bottom);

  // A normal step: the row and its file name whole, on one line.
  await press(page, 'Next step');
  expect(await held()).toEqual(first);
  const row = page.locator('.shp-ex-io.cur .shp-ex-vars > li', { hasText: 'readAndLeft' });
  await expect(row).not.toHaveClass(/tall/);
  await expect(row.locator('.shp-ex-src')).toHaveText('snoozeIntroRows.ts:27');
  const tops = await row.evaluate((li) => [...li.children].map((c) => Math.round(c.getBoundingClientRect().top)));
  expect(Math.max(...tops) - Math.min(...tops)).toBeLessThanOrEqual(5);

  // The long step: the whole surface again, the signature and the deciding line both in view.
  await press(page, 'Next step');
  expect(await held()).toEqual(first);
  expect((await rect(page, '.shp-ex-skin'))!.height).toBe(card.height);
  const scroller = (await rect(page, '.shp-ex-io.cur .shp-ex-scroll'))!;
  const deciding = (await rect(page, '.shp-ex-io.cur .decides'))!;
  expect(deciding.top).toBeGreaterThanOrEqual(scroller.top);
  expect(deciding.bottom).toBeLessThanOrEqual(scroller.bottom);
  const signature = (await rect(page, '.shp-ex-io.cur .shp-ex-sig'))!;
  expect(signature.bottom).toBeLessThanOrEqual(scroller.top + 1);
  expect(signature.top).toBeGreaterThanOrEqual((await rect(page, '.shp-ex-ios'))!.top);

  // A cut file name meets its line: every character it shows fits, so no gap opens before ":line".
  const cut = page.locator('.shp-ex-io.cur .shp-ex-vars .shp-ex-src .f').first();
  await expect(cut).toHaveText(/…$/);
  expect(await cut.evaluate((f) => f.closest<HTMLElement>('.shp-ex-src')!.title)).toContain('inbox-tailnet-guest-policy-middleware-for-claims.ts');
  const gap = await cut.evaluate((f) => f.nextElementSibling!.getBoundingClientRect().left - f.getBoundingClientRect().left - f.scrollWidth);
  expect(Math.abs(gap)).toBeLessThanOrEqual(1);

  await press(page, 'Next step');
  expect(await held()).toEqual(first);
  await context.close();
});

test('folded: a small card with no path, and the arrows still step', async ({ browser }) => {
  const { context, page } = await openBoard(browser);
  await press(page, 'Inputs and outputs');
  const opened = (await rect(page, '.shp-ex-card'))!;
  await press(page, 'Hide inputs and outputs');
  await expect(page.locator('.shp-ex-rail')).toHaveCount(0);
  const folded = (await rect(page, '.shp-ex-card'))!;
  expect(folded.width).toBeLessThanOrEqual(640);
  expect(folded.height).toBeLessThan(opened.height);
  // The surface is the whole card again: no cut is left over from the short step it was opened on.
  expect((await rect(page, '.shp-ex-skin'))!.height).toBe(folded.height);
  await press(page, 'Next step');
  await expect(page.locator('.shp-ex-text.cur .shp-ex-count')).toHaveText('2 of 4');
  await press(page, 'All steps');
  await expect(page.locator('.shp-ex-text.cur.all')).toHaveCount(1);
  await context.close();
});

test('a phone keeps the path: every stop, the one on now in view, at the top of the sheet', async ({ browser }) => {
  const { context, page } = await openBoard(browser, phone);
  await expect(page.locator('.shp-ex-card.phone')).toBeVisible();
  await page.getByRole('button', { name: 'Show more' }).click();
  await settle(page);
  await expect(page.locator('.shp-ex-strip .shp-ex-stop')).toHaveCount(steps.length);
  const shortSheet = (await rect(page, '.shp-ex-card'))!.height;

  await press(page, 'Next step');
  await press(page, 'Next step');
  // The long step: taller sheet than the short one (each step sizes it), and the path stays while it scrolls.
  expect((await rect(page, '.shp-ex-card'))!.height).toBeGreaterThan(shortSheet);
  await page.locator('.shp-ex-in').evaluate((el) => el.scrollTo({ top: 400 }));
  await settle(page);
  const sheet = (await rect(page, '.shp-ex-in'))!;
  const strip = (await rect(page, '.shp-ex-strip'))!;
  expect(Math.abs(strip.top - sheet.top)).toBeLessThanOrEqual(1);
  // A new step starts at the sheet's top, and its stop is on screen.
  await press(page, 'Next step');
  expect(await page.locator('.shp-ex-in').evaluate((el) => el.scrollTop)).toBe(0);
  const on = (await rect(page, '.shp-ex-stop.on'))!;
  expect(on.left).toBeGreaterThanOrEqual(0);
  expect(on.right).toBeLessThanOrEqual(page.viewportSize()!.width);
  await context.close();
});

test('one column beside a board: what decided it first, nothing on top of anything, the whole dock on screen', async ({ browser }) => {
  const { context, page } = await openBoard(browser, { viewport: { width: 1060, height: 800 } });
  await press(page, 'Inputs and outputs');
  await expect(page.locator('.shp-ex-card.narrow')).toBeVisible();
  await expect(page.locator('.shp-ex-strip .shp-ex-stop')).toHaveCount(steps.length);
  await press(page, 'Next step');
  await press(page, 'Next step');
  const io = (await rect(page, '.shp-ex-io.cur'))!;
  const deciding = (await rect(page, '.shp-ex-io.cur .decides'))!;
  expect(deciding.top).toBeGreaterThanOrEqual(io.top);
  expect(deciding.bottom).toBeLessThanOrEqual(io.bottom);
  expect((await rect(page, '.shp-ex-io.cur .shp-ex-col.in'))!.top).toBeGreaterThanOrEqual((await rect(page, '.shp-ex-io.cur .shp-ex-col.fn'))!.bottom);
  expect(io.bottom).toBeLessThanOrEqual((await rect(page, '.shp-ex-skin'))!.bottom);
  const right = (await rect(page, '.shp-root'))!.right;
  const lastInDock = await page.locator('.shp-dock > *').last().evaluate((el) => el.getBoundingClientRect().right);
  expect(lastInDock).toBeLessThanOrEqual(right);
  await context.close();
});

test('a path too long for its room keeps the stop on now in view, on the rail and on a phone', async ({ browser }) => {
  for (const [options, room] of [[{}, '.shp-ex-rail .shp-ex-stops'], [phone, '.shp-ex-strip']] as const) {
    const { context, page } = await openBoard(browser, options);
    await page.locator('.shp-ex-tabs button').nth(1).click();
    await settle(page);
    const through = page.getByRole('button', { name: 'Step through' });
    if (await through.count()) await press(page, 'Step through');
    await press(page, options === phone ? 'Show more' : 'Inputs and outputs');
    await expect(page.locator(`${room} .shp-ex-stop`)).toHaveCount(longWay.length);
    for (let i = 1; i < longWay.length; i++) await press(page, 'Next step');
    await expect(page.locator('.shp-ex-stop.on')).toContainText('stop 12');
    // The room scrolls: the last stop is only in it because the path followed.
    const on = (await rect(page, '.shp-ex-stop.on'))!;
    const box = (await rect(page, room))!;
    expect(on.top).toBeGreaterThanOrEqual(box.top);
    expect(on.bottom).toBeLessThanOrEqual(box.bottom);
    expect(on.left).toBeGreaterThanOrEqual(box.left);
    expect(on.right).toBeLessThanOrEqual(box.right);
    await context.close();
  }
});
