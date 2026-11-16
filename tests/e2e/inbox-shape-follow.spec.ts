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
 *  - a phone's open sheet: one row of controls that stays, the rule that decided it and what comes out; the rest opens on request, and a full sheet leaves no slice of the board;
 *  - one column beside a board: what decided it first, nothing on top of anything, the dock's every button on screen;
 *  - a path too long for its room keeps the stop on now in view, on the rail and on a phone;
 *  - a signature too long for its room gives way before the line that decided it, and what comes out stays on the card;
 *  - with a panel open the dock stays whole beside it, on a board with examples;
 *  - a window made only shorter lays out again;
 *  - the keys never fall to the page, and Esc stops following before it closes the board;
 *  - the board's status stays in view and clickable above the card.
 *
 * Build first: see inbox.spec.ts.
 */
import { devices, expect, test, type Browser, type Page } from './inbox-test';
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
  tag: 'left the thread after 9 s, past the 5 s it needs',
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
  checks: [check('gate.pageAge >= PAGE_AGE_MS', { saw: '240_000' }), check('need(gate.rows, now)', { constant: '2', decides: true })],
  output: out('mayClaim'),
  code: at(118),
};
const names = ['request.auth.tailnetIdentity.userLoginName', 'ownerConfig.tailnetGuestPolicy.allowSnoozeIntroClaims', 'saved.snoozeIntroFirstUseAt', 'saved.snoozeIntroSnoozedAt', 'saved.snoozeIntroShownAt', 'attemptsInThisBrowserSession', 'limiter.remainingClaimsForThisNode', 'release', 'now', 'overlay.open', 'session.kind'];
const LONG_STEP = {
  part: 'c',
  tag: 'guest, not the owner',
  text: 'The Inbox checks who is asking, and turns a guest away before it stamps anything, then tells the page why in words it can show to the person who asked',
  inputs: [{ name: 'mayClaim', value: 'true', from: { step: 2 } }, ...names.map((name, i) => ({ name, value: i % 2 ? `'${name}-${i}'` : String(i), from: at(200 + i, LONG) }))],
  signature: 'resolveClaimEligibilityForTailnetIdentity(request: AuthenticatedInboxRequest<ClaimBody>, saved: SnoozeIntroSaved | undefined, options: { now: Date; release: string; policy: TailnetGuestPolicy }): Promise<ClaimDecision>',
  checks: Array.from({ length: 12 }, (_, i) => (i === 9 ? check(`request.auth.tailnetIdentity.userLoginName === ownerConfig.ownerLoginName || ownerConfig.tailnetGuestPolicy.allowSnoozeIntroClaims || rule${i}(request, saved, options.policy)`, { decides: true }) : i < 9 ? check(`rule${i}(request, saved, options.policy)`) : { code: `rule${i}(request)`, result: 'not-reached' })).map((c, i) => (i === 9 ? { ...c, result: 'fail', saw: 'false', short: 'a guest, and guests may not claim' } : c)),
  output: { name: 'decision', value: "{ show: false, reason: 'tailnet-guest' }", type: 'ClaimDecision' },
  code: at(148, 'src/claimEligibility.ts'),
};
const steps = [SHORT, NORMAL, LONG_STEP, { ...SHORT, part: 'd', tag: 'nothing shows', text: 'Nothing shows for the guest', inputs: [{ name: 'decision.show', value: 'false', from: { step: 3 } }] }];
const parts = ['a', 'b', 'c', 'd'].map((p, i) => part(p, i + 1, box(20 + i * 220, 60, 190, 90), text(40 + i * 220, 110, `Part ${p}`))).join('');
const longWay = Array.from({ length: 12 }, (_, i) => ({ ...SHORT, part: 'abcd'[i % 4], tag: `stop ${i + 1}`, text: `Stop ${i + 1} on the long way` }));
// A real long signature: ten parameters, and one at the format's limit of 600 characters.
const TEN = 'decideEverything(request: AuthenticatedRequest<ClaimBody>, saved: Saved | undefined, now: Date, release: string, policy: GuestPolicy, node: NodeIdentity, session: SessionDescriptor, gate: Gate, rows: Row[], overlay: OverlayState): Promise<Decision>';
const AT_LIMIT = `atTheLimit(${Array.from({ length: 35 }, (_, i) => `param${i}: Type${i}`).join(', ')}): boolean`;
const threeChecks = [check('gate.open'), check('gate.rows.length > 0', { decides: true }), { code: 'rule(gate)', result: 'not-reached' }];
const wideSteps = [
  { ...SHORT, part: 'a', tag: 'ten', text: 'Ten parameters', signature: TEN, checks: threeChecks },
  { ...SHORT, part: 'b', tag: 'limit', text: 'A signature at the limit', signature: AT_LIMIT, checks: threeChecks },
];
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
        { name: 'Long signatures', title: 'Long signatures', steps: wideSteps },
      ],
    },
  },
  refs: [{ n: 1, kind: 'link', title: 'Reference 1', target: 'https://example.com/ref' }],
};

async function openBoard(browser: Browser, options: Parameters<Browser['newContext']>[0] = {}, shape = id) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options });
  await context.route((url) => !['127.0.0.1', 'localhost'].includes(url.hostname), (route) => route.abort());
  const page = await context.newPage();
  await page.goto(`${w.url}#thread=${w.threads.snooze}&shape=${shape}&view=how`);
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
  // The selected stop is marked by its row's band alone: no accent bar on its edge.
  expect(await page.locator('.shp-ex-rail .shp-ex-stop.on').evaluate((el) => getComputedStyle(el, '::before').content)).toBe('none');

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
  // Every number that steps the example is whole in the view: a long tag on the first part does not run past its edge.
  const inside = await page.evaluate(() => {
    const view = document.querySelector('.shp-view.v-how')!.getBoundingClientRect();
    // The drawing's frame clips 24 px outside itself.
    const frame = document.querySelector('.shp-view.v-how .shp-drawn')!.getBoundingClientRect();
    const left = Math.max(view.left, frame.left - 24);
    const right = Math.min(view.right, frame.right + 24);
    const tags = [...document.querySelectorAll('*')].flatMap((h) => [...(h.shadowRoot?.querySelectorAll('.shp-ex-tag') ?? [])]);
    return tags.length > 0 && tags.every((t) => {
      const r = t.getBoundingClientRect();
      return r.left >= left && r.right <= right;
    });
  });
  expect(inside).toBe(true);
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

for (const [size, viewport] of [['390', { width: 390, height: 844 }], ['320', { width: 320, height: 640 }]] as const) {
  test(`a phone at ${size}, open: one row of controls, the rule that decided it and what comes out; the rest opens where it belongs`, async ({ browser }) => {
    const { context, page } = await openBoard(browser, { ...phone, viewport, screen: viewport });
    await expect(page.locator('.shp-ex-card.phone')).toBeVisible();
    await page.getByRole('button', { name: 'Show more' }).click();
    await settle(page);
    const cur = page.locator('.shp-ex-io.cur');
    await expect(page.locator('.shp-ex-strip .shp-ex-stop')).toHaveCount(steps.length);

    // The stops, the arrows and the close are one row.
    const mid = async (s: string) => {
      const r = (await rect(page, s))!;
      return r.top + r.height / 2;
    };
    const row = await mid('.shp-ex-strip');
    for (const s of ['[aria-label="Next step"]', '[aria-label="Previous step"]', '[aria-label="Stop following"]']) expect(Math.abs((await mid(s)) - row)).toBeLessThanOrEqual(4);

    // A rule with something to say beside it: the value and the constant read on the next line, under the rule.
    await press(page, 'Next step');
    const line = cur.locator('.decides');
    await expect(line.locator('.cond')).not.toContainText('//');
    await expect(line.locator('.got')).toContainText('// 2');
    const [rule, got] = await line.evaluate((li) => [li.querySelector('.cond')!.getBoundingClientRect(), li.querySelector('.got .dec')!.getBoundingClientRect()].map((r) => ({ left: r.left, top: r.top, bottom: r.bottom })));
    expect(got!.top).toBeGreaterThanOrEqual(rule!.bottom - 2);
    expect(Math.abs(got!.left - rule!.left)).toBeLessThanOrEqual(2);

    // The long step, calm: of its twelve checks only the one that decided it, what comes out, and no signature or inputs.
    await press(page, 'Next step');
    // Its long sentence is whole: the sentence is the step.
    expect(await cur.page().locator('.shp-ex-text.cur .shp-ex-does').evaluate((p) => p.scrollHeight - p.clientHeight)).toBeLessThanOrEqual(0);
    await expect(cur.locator('.shp-ex-checks > li')).toHaveCount(1);
    await expect(cur.locator('.decides')).toHaveCount(1);
    await expect(cur.locator('.shp-ex-ret')).toBeVisible();
    await expect(cur.locator('.shp-ex-sig')).toHaveCount(0);
    await expect(cur.locator('.shp-ex-vars')).toHaveCount(0);

    // The rest opens where it belongs.
    await press(page, 'What happens');
    await expect(cur.locator('.shp-ex-checks > li')).toHaveCount(12);
    await expect(cur.locator('.shp-ex-sig')).toHaveCount(1);
    // A long function name breaks where its words meet, never mid-word.
    const midWord = await cur.locator('.shp-ex-sig').evaluate((sig) => {
      const walk = document.createTreeWalker(sig, NodeFilter.SHOW_TEXT);
      const found: string[] = [];
      let top = -1;
      let prev = '';
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        const chars = n.textContent ?? '';
        for (let i = 0; i < chars.length; i++) {
          const range = document.createRange();
          range.setStart(n, i);
          range.setEnd(n, i + 1);
          const at = range.getClientRects()[0]?.top;
          if (at === undefined) continue;
          if (top >= 0 && at > top + 4 && /[a-z]/.test(prev) && /[a-z]/.test(chars[i]!)) found.push(prev + chars[i]);
          top = at;
          prev = chars[i]!;
        }
      }
      return found;
    });
    expect(midWord).toEqual([]);
    await press(page, 'Goes in');
    await expect(cur.locator('.shp-ex-vars > li')).toHaveCount(12);

    // Full, the sheet owns the screen under the title: no slice of the board, nothing over the title, nothing off the side.
    await expect(page.locator('.shp-view.v-how')).toHaveCSS('opacity', '0');
    await expect(page.locator('.shp-view.v-how')).toHaveAttribute('inert', '');
    expect((await rect(page, '.shp-ex-card'))!.top).toBeGreaterThanOrEqual((await rect(page, '.shp-head'))!.bottom);
    expect(await page.locator('.shp-ex-in').evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
    expect((await rect(page, '[aria-label="Stop following"]'))!.right).toBeLessThanOrEqual(viewport.width);

    // The controls stay while it scrolls; a new step starts at its top, with its stop on screen.
    await page.locator('.shp-ex-in').evaluate((el) => el.scrollTo({ top: 400 }));
    await settle(page);
    const sheet = (await rect(page, '.shp-ex-in'))!;
    const strip = (await rect(page, '.shp-ex-strip'))!;
    expect(strip.top - sheet.top).toBeLessThanOrEqual(8);
    expect(strip.top).toBeGreaterThanOrEqual(sheet.top);
    await press(page, 'Next step');
    expect(await page.locator('.shp-ex-in').evaluate((el) => el.scrollTop)).toBe(0);
    const on = (await rect(page, '.shp-ex-stop.on'))!;
    expect(on.left).toBeGreaterThanOrEqual(0);
    expect(on.right).toBeLessThanOrEqual(viewport.width);

    // Folding comes back calm, the board back in view.
    await press(page, 'Hide inputs and outputs');
    await expect(page.locator('.shp-view.v-how')).toHaveCSS('opacity', '1');
    await press(page, 'Inputs and outputs');
    await expect(cur.locator('.shp-ex-sig')).toHaveCount(0);
    await context.close();
  });
}

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
    expect(await page.locator(room).evaluate((el) => el.scrollLeft + el.scrollTop)).toBe(0);
    for (let i = 1; i < longWay.length; i++) await press(page, 'Next step');
    await expect(page.locator('.shp-ex-stop.on')).toHaveAttribute('aria-label', 'Step 12: stop 12');
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

for (const height of [700, 900]) {
  test(`a signature too long for its room gives way at ${height} tall: the line that decided it and what comes out stay`, async ({ browser }) => {
    const { context, page } = await openBoard(browser, { viewport: { width: 1440, height } });
    await page.locator('.shp-ex-tabs button').nth(2).click();
    await settle(page);
    await press(page, 'Step through');
    await press(page, 'Inputs and outputs');
    for (const [i] of wideSteps.entries()) {
      if (i) await press(page, 'Next step');
      const scroller = (await rect(page, '.shp-ex-io.cur .shp-ex-scroll'))!;
      const deciding = (await rect(page, '.shp-ex-io.cur .decides'))!;
      expect(scroller.height).toBeGreaterThanOrEqual(deciding.height);
      expect(deciding.top).toBeGreaterThanOrEqual(scroller.top);
      expect(deciding.bottom).toBeLessThanOrEqual(scroller.bottom);
      const signature = page.locator('.shp-ex-io.cur .shp-ex-sig');
      const sig = (await rect(page, '.shp-ex-io.cur .shp-ex-sig'))!;
      expect(sig.height).toBeGreaterThanOrEqual(20);
      expect(sig.top).toBeGreaterThanOrEqual((await rect(page, '.shp-ex-ios'))!.top);
      expect(sig.bottom).toBeLessThanOrEqual(scroller.top + 1);
      // What does not fit is a scroll away; ten parameters fit a tall window whole.
      const hidden = await signature.evaluate((el) => el.scrollHeight - el.clientHeight);
      if (i === 1 || height === 700) expect(hidden).toBeGreaterThan(0);
      else expect(hidden).toBe(0);
      expect((await rect(page, '.shp-ex-io.cur .shp-ex-ret'))!.bottom).toBeLessThanOrEqual((await rect(page, '.shp-ex-skin'))!.bottom);
    }
    await context.close();
  });
}

test('with a panel open the dock stays whole beside it: this button gives up its words, and takes them back', async ({ browser }) => {
  const { context, page } = await openBoard(browser);
  const words = page.locator('[data-follow] .tl');
  await expect(words).toHaveCount(1);
  await page.locator('.shp-dock button[title="References"]').click();
  await settle(page);
  await expect(words).toHaveCount(0);
  const dock = (await rect(page, '.shp-dock'))!;
  expect(dock.left).toBeGreaterThanOrEqual((await rect(page, '.shp-root'))!.left);
  expect(dock.right).toBeLessThanOrEqual((await rect(page, '.shp-sidep'))!.left);
  await page.locator('.shp-dock button[title="References"]').click();
  await settle(page);
  await expect(words).toHaveCount(1);
  await context.close();
});

test('a window made only shorter lays out again: the board clears the card, and a phone hides a slice of it', async ({ browser }) => {
  const desk = await openBoard(browser, { viewport: { width: 1440, height: 1000 } });
  await press(desk.page, 'Inputs and outputs');
  await desk.page.setViewportSize({ width: 1440, height: 640 });
  await settle(desk.page);
  expect((await rect(desk.page, '.shp-view.v-how .shp-drawn-fit'))!.bottom).toBeLessThanOrEqual((await rect(desk.page, '.shp-ex-card'))!.top);
  await desk.context.close();

  const viewport = { width: 390, height: 844 };
  const small = await openBoard(browser, { ...phone, viewport, screen: viewport });
  await press(small.page, 'Show more');
  await expect(small.page.locator('.shp-view.v-how')).toHaveCSS('opacity', '1');
  await small.page.setViewportSize({ width: 390, height: 420 });
  await settle(small.page);
  await expect(small.page.locator('.shp-view.v-how')).toHaveCSS('opacity', '0');
  await small.context.close();
});

test('the keys never fall to the page, and Esc stops following before it closes the board', async ({ browser }) => {
  const { context, page } = await openBoard(browser);
  const focused = () => page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent?.trim() ?? '');
  const enter = async () => {
    await page.keyboard.press('Enter');
    await settle(page);
  };
  await page.getByRole('button', { name: 'All steps' }).focus();
  await enter();
  expect(await focused()).toBe('Step through');
  await enter();
  expect(await focused()).toBe('Next step');
  for (let i = 1; i < steps.length; i++) await enter();
  await expect(page.locator('.shp-ex-text.cur .shp-ex-count')).toHaveText('4 of 4');
  expect(await focused()).toBe('Previous step');

  // From the rail, the tab moves with the card and keeps the keys.
  await press(page, 'Inputs and outputs');
  await page.locator('.shp-ex-rail .shp-ex-tabs button').nth(1).focus();
  await enter();
  await expect(page.locator('.shp-ex-rail')).toHaveCount(0);
  expect(await focused()).toBe('The long way');

  await page.getByRole('button', { name: 'Stop following' }).focus();
  await enter();
  await expect(page.locator('.shp-ex-card:not(.leaving)')).toHaveCount(0);
  expect(await focused()).toBe('Follow an example');

  // Esc: the example goes first, with the keys back on the dock; the next one closes the board.
  await enter();
  await expect(page.locator('.shp-ex-card:not(.leaving)')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await settle(page);
  await expect(page.locator('.shp-ex-card:not(.leaving)')).toHaveCount(0);
  await expect(page.locator('.shp-root')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('.shp-root')).toHaveCount(0);
  await context.close();
});

test("the board's status stays in view and clickable above the card, on a desk and on a phone", async ({ browser }) => {
  const viewport = { width: 390, height: 844 };
  for (const [name, options] of [['desk', {}], ['phone', { ...phone, viewport, screen: viewport }]] as const) {
    const dir = join(w.root, 'boards', `follow-pill-${name}`);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'board.json');
    writeFileSync(file, JSON.stringify(board));
    const made = w.shape(['update', '--file', file, '--project', w.projects.plannotator!, '--thread', w.threads.snooze!]);
    expect(made.status, made.stderr).toBe(0);
    const pillId = (JSON.parse(made.stdout) as { id: string }).id;

    const { context, page } = await openBoard(browser, options, pillId);
    await press(page, name === 'phone' ? 'Show more' : 'Inputs and outputs');
    writeFileSync(file, JSON.stringify({ ...board, claim: 'Built, version two.' }));
    const again = w.shape(['update', '--file', file, '--project', w.projects.plannotator!, '--thread', w.threads.snooze!, '--id', pillId, '--base', '1']);
    expect(again.status, again.stderr).toBe(0);

    const pill = page.locator('.shp-pill');
    await expect(pill).toBeVisible();
    await settle(page);
    const at = (await rect(page, '.shp-pill'))!;
    expect(at.bottom).toBeLessThanOrEqual((await rect(page, '.shp-ex-skin'))!.top);
    const top = await page.evaluate(([x, y]) => !!document.elementFromPoint(x!, y!)?.closest('.shp-pill'), [at.left + at.width / 2, at.top + at.height / 2]);
    expect(top).toBe(true);
    await context.close();
  }
});

test('the status slides with the dock when a panel opens, never ahead of it', async ({ browser }) => {
  const dir = join(w.root, 'boards', 'follow-pill-slide');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'board.json');
  writeFileSync(file, JSON.stringify(board));
  const made = w.shape(['update', '--file', file, '--project', w.projects.plannotator!, '--thread', w.threads.snooze!]);
  expect(made.status, made.stderr).toBe(0);
  const pillId = (JSON.parse(made.stdout) as { id: string }).id;
  const { context, page } = await openBoard(browser, {}, pillId);
  writeFileSync(file, JSON.stringify({ ...board, claim: 'Built, version two.' }));
  const again = w.shape(['update', '--file', file, '--project', w.projects.plannotator!, '--thread', w.threads.snooze!, '--id', pillId, '--base', '1']);
  expect(again.status, again.stderr).toBe(0);
  await expect(page.locator('.shp-pill')).toBeVisible();
  await settle(page);
  // Every frame of the slide: where the dock's middle is, and how far the status is from it.
  const frames = await page.evaluate(async () => {
    const mid = (s: string) => {
      const r = document.querySelector(s)!.getBoundingClientRect();
      return r.left + r.width / 2;
    };
    const seen: [number, number][] = [[mid('.shp-dock'), 0]];
    document.querySelector<HTMLElement>('.shp-dock button[title="References"]')!.click();
    const until = performance.now() + 600;
    while (performance.now() < until) {
      await new Promise((r) => requestAnimationFrame(r));
      seen.push([mid('.shp-dock'), Math.abs(mid('.shp-pill') - mid('.shp-dock'))]);
    }
    return seen;
  });
  const docks = frames.map(([d]) => d);
  // The dock did slide, through frames in between ...
  const [from, to] = [docks[0]!, docks.at(-1)!];
  expect(Math.abs(to - from)).toBeGreaterThan(40);
  expect(docks.some((d) => Math.min(Math.abs(d - from), Math.abs(d - to)) > 8 && (d - from) * (to - d) > 0)).toBe(true);
  // ... and the status never left its side.
  expect(Math.max(...frames.map(([, gap]) => gap))).toBeLessThan(4);
  await context.close();
});

test("a number never covers the drawing's own words, like a frame's label, or another number", async ({ browser }) => {
  // A frame's label right where the second step's number would sit, on the top edge of its part.
  const label = text(250, 52, 'How · all must hold', { size: 13, mono: true, tone: 'soft' });
  const dir = join(w.root, 'boards', 'follow-label');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'board.json');
  writeFileSync(file, JSON.stringify({ ...board, views: { ...board.views, how: { ...svg(920, 220, parts + label), examples: [{ name: 'A guest leaves', title: 'A guest leaves a thread', steps }] } } }));
  const made = w.shape(['update', '--file', file, '--project', w.projects.plannotator!, '--thread', w.threads.snooze!]);
  expect(made.status, made.stderr).toBe(0);
  const viewport = { width: 390, height: 844 };
  for (const options of [{}, { ...phone, viewport, screen: viewport }]) {
    const { context, page } = await openBoard(browser, options, (JSON.parse(made.stdout) as { id: string }).id);
    const covered = await page.evaluate(() => {
      const root = [...document.querySelectorAll('*')].map((h) => h.shadowRoot).find((r) => r?.querySelector('.shp-ex-tag'))!;
      const layer = root.querySelector('.shp-ex-layer')!;
      const tags = [...root.querySelectorAll('.shp-ex-tag')].map((t) => t.getBoundingClientRect());
      const named = [...root.querySelectorAll('.shp-ex-tag')].map((t) => t.textContent!.trim());
      const words: { r: DOMRect; text: string }[] = [];
      const walk = document.createTreeWalker(layer.parentElement!, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        if (!n.textContent?.trim() || layer.contains(n)) continue;
        range.selectNodeContents(n);
        words.push(...[...range.getClientRects()].filter((r) => r.width && r.height).map((r) => ({ r, text: n.textContent!.trim() })));
      }
      const meets = (a: DOMRect, b: DOMRect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      return {
        words: words.length,
        onWords: tags.flatMap((t, i) => words.filter((w) => meets(t, w.r)).map((w) => `${named[i]} on ${w.text}`)),
        onTags: tags.flatMap((t, i) => tags.filter((u, j) => i !== j && meets(t, u)).map(() => named[i])),
      };
    });
    expect(covered.words).toBeGreaterThan(4);
    expect(covered.onWords, `at ${page.viewportSize()!.width}`).toEqual([]);
    // Four numbers in a row of 358 px have nowhere free to go: only the desk promises they never meet.
    if (page.viewportSize()!.width > 390) expect(covered.onTags).toEqual([]);
    await context.close();
  }
});
