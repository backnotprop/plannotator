/**
 * The risk bars (approval "review-risk-bars"), proved in a real browser against the compiled binary, with a temp
 * PLANNOTATOR_DATA_DIR. `gh` and `pi` are fakes first on a PATH with no agents on it: nothing reaches a forge, no real
 * agent runs. The fake `pi` answers each PR's judgment with its places, through the whole road (the strict parse, the
 * file, the window).
 *
 * Proved: a High PR's review marks each named file once in the tree, a clear gap before its icon, without moving the
 * row, and each named range once in the diff, on its first line at the column's right edge; a Medium PR the same with
 * two filled bars; a Low PR nothing. The diff's mark (a button named "High risk: <reason>", the person's rule before the reason when the place named one) never covers code: on lines
 * long enough to reach the edge, split and unified, old and new sides, scrolling sideways or wrapped. No row under the
 * code says the reason (q-070bc2a3): the bars' card does, on hover, keyboard focus or a press (pinned), and the header's
 * "N places" opens each place's card in turn; a pinned card closes when its bars scroll out of the diff; the card moves nothing in the diff and is not cut by the column. A phone's
 * tap opens it inside the screen. A marked file at the tree's root keeps its mark inside its row. The bars' tone keeps
 * 3:1 against the tree and both diff line colours, light and dark (written to contrast.json). Made-up people and code
 * only.
 *
 * Shots land in PLANNOTATOR_E2E_PROOF_DIR/review-risk-bars:
 *   01-high-card-dark.png, 02-medium-card-dark.png, 03-closeup-tree-light.png, 03-closeup-diff-card-light.png,
 *   04-low-no-marks-dark.png, 05-long-line-split-card-dark.png, 06-long-line-unified-card-dark.png,
 *   07-root-file-tree-dark.png, 08-phone-card-dark.png, 09-scrolled-away-no-card-dark.png.
 */
import { expect, test, type BrowserContext, type Locator, type Page } from './inbox-test';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { NO_BROWSER } from '../helpers/no-browser';
import { markTourDecided } from '../helpers/tour-decided';
import { inboxScratch, rememberInboxOf, removeInboxScratch } from './inbox-scratch';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const proofDir = join(resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? join(repo, '.local/proof')), 'review-risk-bars');

const REPO = 'tully-labs/billing-svc';
const keyOf = (n: number) => `github.com/${REPO}#${n}`;
const RULES = 'Anything in billing or charges.\nAnything that changes permissions.';

const fileDiff = (path: string, hunk: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${hunk}`;
const CLIENT_LIMITS = Array.from({ length: 80 }, (_, i) => `   limit${i + 1}: ${(i + 1) * 10},`);
const PATCHES: Record<number, string> = {
  601: [
    fileDiff(
      'src/charges/retry.ts',
      [
        '@@ -18,7 +18,9 @@ export async function retryCharge(charge: Charge) {',
        '   const attempts = [1, 5, 30];',
        '   for (const wait of attempts) {',
        '     await sleep(wait * MINUTE);',
        '-    const result = await client.charge(charge);',
        '+    const first = await client.charge(charge);',
        '+    const second = await client.charge({ ...charge, retry: true });',
        '+    const result = second.ok ? second : first;',
        '     if (result.ok) return result;',
        '   }',
        "   log.warn('charge failed', charge.id);",
        '',
      ].join('\n'),
    ),
    fileDiff(
      'src/charges/client.ts',
      // Long enough that its marked line scrolls out of the diff (the card closes then).
      ['@@ -6,85 +6,85 @@ export const client = {', "   base: 'https://pay.example.test',", '   timeoutMs: 10_000,', '-  idempotent: true,', '+  idempotent: false,', '   retries: 0,', ...CLIENT_LIMITS, ' };', ''].join('\n'),
    ),
    fileDiff('docs/retries.md', ['@@ -1,3 +1,4 @@', ' # Retries', ' ', '-A failed charge is tried three more times.', '+A failed charge is tried three more times,', '+twice each time.', ''].join('\n')),
  ].join(''),
  602: [
    fileDiff(
      'src/receipts/send.ts',
      [
        '@@ -1,4 +1,7 @@',
        " import { mailer } from '../mail';",
        "+import { client } from '../charges/client';",
        ' ',
        ' export async function sendReceipt(order: Order) {',
        '+  const charge = await client.lookup(order.chargeId);',
        '+  if (!charge.ok) return;',
        '   await mailer.send(order.email, receiptFor(order));',
        '',
      ].join('\n'),
    ),
    fileDiff('src/checkout/done.ts', ['@@ -12,3 +12,4 @@ export function finishCheckout(order: Order) {', '   saveOrder(order);', '+  void sendReceipt(order);', '   return order.id;', ' }', ''].join('\n')),
  ].join(''),
  603: fileDiff('README.md', ['@@ -1,2 +1,2 @@', ' # Billing service', '-Teh service that charges cards.', '+The service that charges cards.', ''].join('\n')),
  // Lines far longer than a column, at the repository's root, beside an unmarked root file.
  604: [
    fileDiff(
      'charges.ts',
      [
        '@@ -1,3 +1,4 @@',
        " import { client } from './src/charges/client';",
        `-export const request = (order: Order) => client.post('/v1/charges', { amount: order.total, currency: order.currency, customer: order.customerId, description: 'Order ' + order.id, metadata: { source: 'checkout' } });`,
        `+export const request = (order: Order) => client.post('/v1/charges', { amount: order.total, currency: order.currency, customer: order.customerId, description: 'Order ' + order.id + ' for ' + order.email, idempotencyKey: order.id, metadata: { source: 'checkout', retried: 'yes' } });`,
        ' export const short = 1;',
        '+export const tiny = 2;',
        '',
      ].join('\n'),
    ),
    fileDiff('CHANGELOG.md', ['@@ -1,2 +1,3 @@', ' # Changes', ' ', '+- Charges carry an idempotency key.', ''].join('\n')),
  ].join(''),
};

const VERDICTS: Record<string, unknown> = {
  'Retry failed charges twice': {
    risk: 'high',
    why: 'It charges a card a second time on every retry.',
    where: [
      { file: 'src/charges/retry.ts', side: 'new', lines: [21, 23], rule: 'Anything in billing or charges.', why: 'Each retry charges the card twice.' },
      { file: 'src/charges/client.ts', side: 'old', lines: [8, 8], why: 'Charges stop being idempotent.' },
    ],
  },
  'Send a receipt after checkout': {
    risk: 'medium',
    why: 'The receipt now reads the charge client.',
    where: [{ file: 'src/receipts/send.ts', side: 'new', lines: [5, 6], why: 'It looks the charge up before sending.' }],
  },
  'Fix a typo in the README': { risk: 'low', why: 'Only the README wording changes.' },
  'Send the idempotency key': {
    risk: 'medium',
    why: 'The charge request changes shape.',
    where: [
      { file: 'charges.ts', side: 'new', lines: [2, 2], why: 'The request now carries a key.' },
      { file: 'charges.ts', side: 'old', lines: [2, 2], why: 'The old request had none.' },
      { file: 'charges.ts', side: 'new', lines: [4, 4], why: 'A new export.' },
    ],
  },
};

const AUTHORS: Record<number, string> = { 601: 'charlie-dunn', 602: 'bob-tully', 603: 'charlie-dunn', 604: 'bob-tully' };
const TITLES: Record<number, string> = { 601: 'Retry failed charges twice', 602: 'Send a receipt after checkout', 603: 'Fix a typo in the README', 604: 'Send the idempotency key' };

function ghPull(number: number) {
  return {
    number,
    title: TITLES[number],
    url: `https://github.com/${REPO}/pull/${number}`,
    state: 'OPEN',
    isDraft: false,
    updatedAt: new Date(Date.now() - (number - 600) * 7 * 60_000).toISOString(),
    mergedAt: null,
    baseRefName: 'main',
    headRefName: `b${number}`,
    headRefOid: String(number).padStart(40, '0'),
    additions: 6,
    deletions: 2,
    changedFiles: 2,
    reviewDecision: 'REVIEW_REQUIRED',
    repository: { nameWithOwner: REPO },
    headRepository: { nameWithOwner: REPO },
    author: { login: AUTHORS[number] },
    reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', login: 'ada-novak' } }] },
    latestReviews: { nodes: [] },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
  };
}

/** A fake gh: the list, each PR's patch (`pr-<n>.patch`), its head. */
function writeGh(dir: string) {
  const gh = [
    '#!/bin/sh',
    `dir='${dir}'`,
    'if [ "$1" = auth ] && [ "$2" = status ]; then',
    '  echo \'{"hosts":{"github.com":[{"login":"ada-novak","active":true,"state":"success","tokenSource":"keyring"}]}}\'; exit 0',
    'fi',
    'if [ "$1" = api ] && [ "$2" = graphql ]; then cat "$dir/gh-pulls.json"; exit 0; fi',
    'if [ "$1" = api ] && [ "$2" = --hostname ] && [ "$5" = --jq ]; then case "$6" in *tojson*) printf \'{"sha":"%040d","body":null}\\n\' "${4##*/}";; *) printf "%040d\\n" "${4##*/}";; esac; exit 0; fi',
    'if [ "$1" = api ] && [ "$2" = --hostname ] && [ -f "$dir/pr-${4##*/}.patch" ]; then cat "$dir/pr-${4##*/}.patch"; exit 0; fi',
    'exit 1',
    '',
  ].join('\n');
  writeFileSync(join(dir, 'gh'), gh);
  chmodSync(join(dir, 'gh'), 0o755);
  for (const [n, patch] of Object.entries(PATCHES)) writeFileSync(join(dir, `pr-${n}.patch`), patch);
  writeFileSync(join(dir, 'gh-pulls.json'), JSON.stringify({ data: { viewer: { login: 'ada-novak' }, requested: { nodes: [601, 602, 603, 604].map(ghPull) }, authored: { nodes: [] }, merged: { nodes: [] } } }));
}

/** A fake pi speaking Pi's RPC: the answer comes from the prompt's title. */
function writePi(dir: string) {
  const script = `
const verdicts = ${JSON.stringify(VERDICTS)};
if (process.argv.includes('--version')) { console.log('0.90.0'); process.exit(0); }
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.type === 'get_available_models') {
    send({ type: 'response', id: m.id, command: m.type, success: true, data: { models: [{ provider: 'anthropic', id: 'claude-sonnet-5', name: 'Sonnet 5' }] } });
    return;
  }
  send({ type: 'response', id: m.id, command: m.type, success: true, data: {} });
  if (m.type === 'prompt') {
    const title = /^Title: (.*)$/m.exec(m.message)?.[1] ?? '';
    const verdict = verdicts[title];
    send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: verdict ? JSON.stringify(verdict) : 'no idea' }] } });
    send({ type: 'agent_end' });
  }
});
`;
  writeFileSync(join(dir, 'pi.cjs'), script);
  writeFileSync(join(dir, 'pi'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(dir, 'pi.cjs'))} "$@"\n`);
  chmodSync(join(dir, 'pi'), 0o755);
}

let context: BrowserContext;
let page: Page;
let url = '';
let agent: SimAgent;

const row = (n: number) => page.locator(`[data-pulls-row="${keyOf(n)}"]`);
const treeMarks = () => page.locator('[data-review-files] [data-item-part-id="risk"]');
/** The diff's marked lines (a mark is a button, the line's last child), as `<file> <column> <line number>`. */
async function diffMarks(scope: Locator): Promise<string[]> {
  return scope.locator('[data-host-line-mark]').evaluateAll((marks) =>
    marks.map((mark) => {
      const line = mark.parentElement!;
      const host = (line.getRootNode() as ShadowRoot).host;
      const file = host?.closest('[data-guide-file-shell]')?.getAttribute('data-guide-file-shell');
      const column = line.closest('[data-additions]') ? 'additions' : line.closest('[data-deletions]') ? 'deletions' : 'unified';
      return `${file} ${column} ${line.getAttribute('data-line')}`;
    }),
  );
}

/** A marked line: its file, its column (`additions`, `deletions`, `unified`), its number, and in unified its kind. */
type LineRef = { file: string; column: 'additions' | 'deletions' | 'unified'; line: number; type?: string };
const lineSelector = (ref: LineRef) => `[data-guide-file-shell="${ref.file}"] [data-${ref.column}] [data-line="${ref.line}"]${ref.type ? `[data-line-type="${ref.type}"]` : ''}`;
/** A marked line's bars: the button at its end. */
const barsOf = (review: Locator, ref: LineRef) => review.locator(`${lineSelector(ref)} > [data-host-line-mark]`).first();
/** The bars' card (one at a time). */
const riskCard = () => page.locator('.ib-riskcard');

/** A marked line's geometry, in the page's coordinates: its box, its text's boxes, the column's visible box, colours. */
async function lineGeometry(review: Locator, ref: LineRef) {
  const el = review.locator(lineSelector(ref)).first();
  return el.evaluate((node) => {
    const rect = (r: DOMRect) => ({ x: r.x, y: r.y, width: r.width, height: r.height });
    // The code's ink: each character that draws something (a space at a wrap hangs past the line's edge, unseen).
    const text: ReturnType<typeof rect>[] = [];
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      const value = t.nodeValue ?? '';
      for (let i = 0; i < value.length; i++) {
        if (/\s/.test(value[i]!)) continue;
        const range = document.createRange();
        range.setStart(t, i);
        range.setEnd(t, i + 1);
        const r = range.getBoundingClientRect();
        if (r.width > 0) text.push(rect(r));
      }
    }
    const code = node.closest('[data-code]') as HTMLElement;
    const codeRect = code.getBoundingClientRect();
    const wrap = node.closest('pre')?.getAttribute('data-overflow') === 'wrap';
    const style = getComputedStyle(node);
    const button = node.querySelector<HTMLElement>(':scope > [data-host-line-mark]');
    return {
      mark: button ? rect(button.getBoundingClientRect()) : undefined,
      line: rect(node.getBoundingClientRect()),
      text,
      // What the reader sees of the column: the scrolling box, or (wrapped, where the column has no box) the line.
      visibleRight: wrap ? node.getBoundingClientRect().right : codeRect.right,
      wrap,
      lineHeight: parseFloat(style.lineHeight),
      lineBg: style.backgroundColor,
      markBg: button ? getComputedStyle(button).backgroundColor : '',
      scroll: { left: code.scrollLeft, width: code.scrollWidth, client: code.clientWidth },
    };
  });
}

/** Scrolls a file's column (all of its `[data-code]` boxes) sideways. */
async function scrollColumns(review: Locator, file: string, to: 'start' | 'end') {
  await review.locator(`[data-guide-file-shell="${file}"] [data-code]`).evaluateAll((codes, end) => {
    for (const code of codes as HTMLElement[]) code.scrollLeft = end ? code.scrollWidth : 0;
  }, to === 'end');
  await page.waitForTimeout(120);
}

/**
 * The mark never covers code. It sits at the column's visible right edge, one line tall, on the line's first row.
 * Wrapped: no text box reaches it. Scrolling sideways: it is filled with the line's own (opaque) colour over whatever
 * would run under it, as the column's edge is; scrolled to the end, the line's last character sits clear of it; and a
 * line that ends before it (`short`) is clear of it as it is.
 */
/**
 * A file into view; one taller than the window by its top (the diff draws a file's lines as they come into view, so
 * a tall file centred may not draw its first lines).
 */
async function shellTop(review: Locator, file: string) {
  const shell = review.locator(`[data-guide-file-shell="${file}"]`);
  await shell.scrollIntoViewIfNeeded();
  await shell.evaluate((el) => {
    if (el.getBoundingClientRect().height > window.innerHeight) el.scrollIntoView({ block: 'start', inline: 'nearest' });
  });
}

async function expectNoOverlap(review: Locator, ref: LineRef, opts: { long: boolean }) {
  const { file } = ref;
  // The diff may draw a file's lines again as it comes into view: take the line once it holds still.
  let g!: Awaited<ReturnType<typeof lineGeometry>>;
  await expect(async () => {
    // Into view by the file (a line's own scroll would also move the column sideways), the column at its start.
    await shellTop(review, file);
    await expect(review.locator(lineSelector(ref)).first()).toBeInViewport({ timeout: 2000 });
    await scrollColumns(review, file, 'start');
    g = await lineGeometry(review, ref);
    expect(g.mark, `${JSON.stringify(ref)} has a mark`).toBeTruthy();
  }).toPass({ timeout: 15_000 });
  const mark = g.mark!;
  expect(Math.abs(mark.x + mark.width - g.visibleRight)).toBeLessThanOrEqual(1.5);
  expect(Math.abs(mark.y - g.line.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(mark.height - g.lineHeight)).toBeLessThanOrEqual(1);
  const textRight = () => Math.max(...g.text.map((r) => r.x + r.width));
  if (g.wrap) {
    // Every row of the wrapped text ends before the mark.
    for (const r of g.text) expect(r.x + r.width, `wrapped text row ends before the mark`).toBeLessThanOrEqual(mark.x + 1);
    if (opts.long) expect(new Set(g.text.map((r) => Math.round(r.y))).size).toBeGreaterThan(1);
    return;
  }
  // Opaque, in the line's own colour: what runs under it does not show through.
  expect(g.markBg).toBe(g.lineBg);
  expect(g.markBg).not.toMatch(/rgba\(.*,\s*0\)|transparent/);
  if (!opts.long) {
    expect(textRight()).toBeLessThanOrEqual(mark.x + 1);
    return;
  }
  expect(textRight()).toBeGreaterThan(mark.x); // it does reach the edge, the case this proves
  // The line's own column to its end (split columns scroll together: the other one would hold this one back).
  await review.locator(lineSelector(ref)).first().evaluate((node) => {
    const code = node.closest('[data-code]') as HTMLElement;
    code.scrollLeft = code.scrollWidth;
  });
  await page.waitForTimeout(150);
  const end = await lineGeometry(review, ref);
  expect(end.scroll.left + end.scroll.client, 'the column is at its end').toBeGreaterThanOrEqual(end.scroll.width - 1);
  const endMark = end.mark!;
  // Within 1px is "where the mark begins" (its bars start 6px further in).
  expect(Math.max(...end.text.map((r) => r.x + r.width)), 'scrolled to the end, the last character is clear of the mark').toBeLessThanOrEqual(endMark.x + 1);
  expect(Math.abs(endMark.x + endMark.width - end.visibleRight)).toBeLessThanOrEqual(1.5);
  await scrollColumns(review, file, 'start');
}

/**
 * The bars' card, opened by a press on `ref`'s bars: it says `words`, is pinned, lies wholly on the screen and on top
 * (no column cuts it), and nothing in the diff moved for it (the line under the marked one is where it was).
 */
async function openCard(review: Locator, ref: LineRef, words: string[]) {
  const bars = barsOf(review, ref);
  await bars.scrollIntoViewIfNeeded();
  const before = (await review.locator(lineSelector(ref)).first().boundingBox())!;
  const shell = (await review.locator(`[data-guide-file-shell="${ref.file}"]`).boundingBox())!;
  await bars.click();
  await expect(riskCard()).toBeVisible();
  await expect(riskCard()).toHaveAttribute('data-risk-card-pinned', '');
  for (const w of words) await expect(riskCard()).toContainText(w);
  await expect(riskCard()).toBeInViewport({ ratio: 1 });
  // Past its opening fade.
  await page.waitForTimeout(250);
  const box = (await riskCard().boundingBox())!;
  const view = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(view.width);
  // On top: what draws at the card's centre is the card.
  expect(await page.evaluate(([x, y]) => !!document.elementFromPoint(x!, y!)?.closest('.ib-riskcard'), [box.x + box.width / 2, box.y + box.height / 2])).toBe(true);
  // Nothing moved: the line and its file are where they were.
  const after = (await review.locator(lineSelector(ref)).first().boundingBox())!;
  const shellAfter = (await review.locator(`[data-guide-file-shell="${ref.file}"]`).boundingBox())!;
  expect(after).toEqual(before);
  expect(shellAfter.height).toBe(shell.height);
}

async function openReview(n: number): Promise<Locator> {
  await page.goto(url);
  await page.locator('[data-pulls-nav]').click();
  // Ranked: a closed row shows only High's mark inline; every level is on the row itself.
  await expect(row(n)).toHaveAttribute('data-pulls-risk', /^(high|medium|low)$/, { timeout: 30_000 });
  await row(n).click();
  await page.locator('[data-pulls-open-diff]').click();
  const review = page.locator(`[data-pull-review="${keyOf(n)}"]`);
  await expect(review).toBeVisible();
  await expect(review.locator('[data-review-files] [data-type="item"]').first()).toBeVisible({ timeout: 20_000 });
  return review;
}

async function scheme(value: 'light' | 'dark') {
  await page.emulateMedia({ colorScheme: value, reducedMotion: 'reduce' });
  await page.waitForTimeout(350);
}

/** The tree row of a file (its path as the tree names it ends with its name). */
const treeRow = (name: string) => page.locator(`[data-review-files] [data-type="item"][data-item-path$="${name}"]`);

/** The mark lies over the indent left of the icon, a clear gap before it, inside its row, and the icon and name are
 *  where an unmarked row's are (same depth). */
async function expectBeforeIcon(marked: string, unmarked: string) {
  const mark = (await treeRow(marked).locator('[data-item-part-id="risk"] svg').boundingBox())!;
  const rowBox = (await treeRow(marked).boundingBox())!;
  const icon = (await treeRow(marked).locator('[data-item-section="icon"]').boundingBox())!;
  const otherIcon = (await treeRow(unmarked).locator('[data-item-section="icon"]').boundingBox())!;
  const name = (await treeRow(marked).locator('[data-item-section="content"]').boundingBox())!;
  const otherName = (await treeRow(unmarked).locator('[data-item-section="content"]').boundingBox())!;
  // The bars: 10 × 12, then a 4–6px gap to the icon.
  expect(Math.round(mark.width)).toBe(10);
  expect(Math.round(mark.height)).toBe(12);
  const gap = icon.x - (mark.x + mark.width);
  expect(gap).toBeGreaterThanOrEqual(4);
  expect(gap).toBeLessThanOrEqual(6.5);
  // Inside its own row (at the tree's root too).
  expect(mark.x).toBeGreaterThanOrEqual(rowBox.x);
  // No row moves: icon and name start where an unmarked row's do (same depth).
  expect(Math.abs(icon.x - otherIcon.x)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(name.x - otherName.x)).toBeLessThanOrEqual(0.5);
}

/** The diff's mark sits on the named range's first line (its column), at the column's right edge, over no code. */
async function expectOnLine(review: Locator, ref: LineRef) {
  await expectNoOverlap(review, ref, { long: false });
  await expect(barsOf(review, ref)).toHaveAttribute('aria-label', /^(High|Medium) risk( · your rule “[^”]+”)?: /);
}

/** sRGB of any CSS colour, and WCAG's contrast ratio of two. */
async function contrast(fg: string, bg: string): Promise<number> {
  return page.evaluate(
    ([a, b]) => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      const rgb = (color: string) => {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = '#000';
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 1, 1);
        return [...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)];
      };
      const lum = (c: number[]) => {
        const [r, g, bl] = c.map((v) => {
          const s = v / 255;
          return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
      };
      const [l1, l2] = [lum(rgb(a)), lum(rgb(b))].sort((x, y) => y - x);
      return Math.round(((l1! + 0.05) / (l2! + 0.05)) * 100) / 100;
    },
    [fg, bg] as const,
  );
}

/** The tone the marks are drawn in (the tree mark's colour), and the backgrounds they sit on, resolved. */
async function markColours(review: Locator, file: string) {
  const tone = await page.locator('[data-review-files] [data-item-part-id="risk"]').first().evaluate((el) => getComputedStyle(el).color);
  const treeBg = await page.locator('[data-review-files] [data-type="item"]').first().evaluate((el) => {
    for (let node: Element | null = el; node; node = node.parentElement ?? ((node.getRootNode() as ShadowRoot).host ?? null)) {
      const bg = getComputedStyle(node).backgroundColor;
      if (bg && !/rgba\(.*,\s*0\)$/.test(bg) && bg !== 'transparent') return bg;
    }
    return getComputedStyle(document.body).backgroundColor;
  });
  const lineBg = (column: string, line: number) => review.locator(`[data-guide-file-shell="${file}"] [data-${column}] [data-line="${line}"]`).first().evaluate((el) => getComputedStyle(el).backgroundColor);
  return { tone, treeBg, added: await lineBg('additions', 2), removed: await lineBg('deletions', 2) };
}

test.describe.configure({ mode: 'serial' });
test.use({ actionTimeout: 20_000 });

test.beforeAll(async ({ browser }) => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const root = inboxScratch('plannotator-inbox-risk-bars-e2e-');
  const dataDir = join(root, 'data');
  markTourDecided(dataDir);
  const fakes = join(root, 'fakes');
  mkdirSync(fakes, { recursive: true });
  writeGh(fakes);
  writePi(fakes);
  const project = scratchProject(join(root, 'src'), 'billing-svc');
  spawnSync('git', ['remote', 'add', 'origin', `https://github.com/${REPO}.git`], { cwd: project, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  for (const dir of ['claude', 'codex', 'xdg', 'home']) mkdirSync(join(root, dir), { recursive: true });
  const env = {
    PATH: `${fakes}:/usr/bin:/bin`,
    PLANNOTATOR_TEST_LAUNCH_PATH: `${fakes}:/usr/bin:/bin`,
    HOME: join(root, 'home'),
    PLANNOTATOR_RELAY_URL: 'http://127.0.0.1:9',
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_ANON_PING: '1',
    PLANNOTATOR_INBOX_NOTES: '0',
    PLANNOTATOR_TEST_SANDBOX: '1',
    TMPDIR: tmpdir(),
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    CODEX_HOME: join(root, 'codex'),
    XDG_CONFIG_HOME: join(root, 'xdg'),
  };
  const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
  expect(started.status, started.stderr).toBe(0);
  rememberInboxOf(dataDir);
  url = started.stdout.trim();
  expect(new URL(url).port).not.toBe('59812');
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', deviceScaleFactor: 2 });
  page = await context.newPage();
  agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  await agent.send({ project_path: project, thread: 'charges', subject: 'Retry failed charges', body: 'Opened the retries.' });
  const on = await page.request.post(`${url}api/inbox/settings`, { data: { code_review: { on: true } } });
  expect(on.status()).toBe(200);
  const saved = await page.request.post(`${url}api/inbox/pulls/risk`, { data: { rules: RULES, provider: 'pi-sdk', model: null } });
  expect(saved.status()).toBe(200);
});

test.afterAll(async () => {
  try {
    await agent?.close().catch(() => {});
    await context?.close();
  } finally {
    await removeInboxScratch();
  }
});

test('a High PR: once on each named file in the tree, once on each named range in the diff', async () => {
  const review = await openReview(601);
  await expect(review.locator('[data-pull-risk="high"]')).toBeVisible();
  // The judgments came back with High's and Medium's places through the strict parse and the file; Low's with none.
  const places = async () => {
    const answer = (await (await page.request.get(`${url}api/inbox/pulls/risk`)).json()) as { judgments: Record<string, { level: string; where?: unknown[] }> };
    return [601, 602, 603, 604].map((n) => `${answer.judgments[keyOf(n)]?.level ?? '-'} ${answer.judgments[keyOf(n)]?.where?.length ?? 0}`);
  };
  await expect.poll(places, { timeout: 30_000 }).toEqual(['high 2', 'medium 1', 'low 0', 'medium 3']);

  await expect(treeMarks()).toHaveCount(2);
  await expect(treeRow('retry.ts').locator('[data-item-part-id="risk"]')).toHaveAttribute('title', 'High risk');
  await expect(treeRow('client.ts').locator('[data-item-part-id="risk"]')).toHaveCount(1);
  await expect(treeRow('retries.md').locator('[data-item-part-id="risk"]')).toHaveCount(0);
  await expectBeforeIcon('retry.ts', 'retries.md');
  // Once per named range, nothing a third time (nothing beside the counts or in a header).
  await expect.poll(() => diffMarks(review).then((m) => m.sort())).toEqual(['src/charges/client.ts deletions 8', 'src/charges/retry.ts additions 21']);
  const retry: LineRef = { file: 'src/charges/retry.ts', column: 'additions', line: 21 };
  const client: LineRef = { file: 'src/charges/client.ts', column: 'deletions', line: 8 };
  await expectOnLine(review, retry);
  await expectOnLine(review, client);
  // The header's level stays as it was.
  await expect(review.locator('[data-pull-risk="high"]')).toHaveText(/High/);

  // No row under the code says the reason (q-070bc2a3): the bars are a button that says it, and its card shows it.
  await expect(review.locator('[data-context-note-row], .ib-ctxn-line')).toHaveCount(0);
  await expect(review.getByRole('button', { name: 'High risk · your rule “Anything in billing or charges.”: Each retry charges the card twice.' })).toHaveCount(1);
  await expect(review.getByRole('button', { name: 'High risk: Charges stop being idempotent.' })).toHaveCount(1);
  await scheme('dark');

  // Hover: the card opens; the pointer leaving closes it.
  await barsOf(review, retry).scrollIntoViewIfNeeded();
  await barsOf(review, retry).hover();
  await expect(riskCard()).toBeVisible();
  for (const w of ['Risk', 'High', 'your rule “Anything in billing or charges.”', 'Each retry charges the card twice.']) await expect(riskCard()).toContainText(w);
  await page.mouse.move(4, 450);
  await expect(riskCard()).toHaveCount(0);
  // Keyboard focus: the card opens; Escape closes it and the review stays.
  await shellTop(review, 'src/charges/client.ts');
  await barsOf(review, client).focus();
  await expect(riskCard()).toContainText('Charges stop being idempotent.');
  await page.keyboard.press('Escape');
  await expect(riskCard()).toHaveCount(0);
  await expect(review).toBeVisible();
  // A press pins it (it stays when the pointer leaves); a second press, and a press outside, close it.
  await openCard(review, retry, ['Each retry charges the card twice.']);
  await page.mouse.move(4, 450);
  await page.waitForTimeout(700);
  await expect(riskCard()).toBeVisible();
  await barsOf(review, retry).click();
  await expect(riskCard()).toHaveCount(0);
  await barsOf(review, retry).click();
  await expect(riskCard()).toBeVisible();
  const tree = (await page.locator('[data-review-files]').boundingBox())!;
  await page.mouse.click(tree.x + tree.width / 2, tree.y + tree.height - 24);
  await expect(riskCard()).toHaveCount(0);

  // The header's places stepper opens each place's card in turn, one at a time.
  const stepper = review.locator('[data-pull-risk-places]');
  await expect(stepper).toHaveText('2 places');
  await stepper.click();
  await expect(riskCard()).toContainText('Each retry charges the card twice.');
  await expect(riskCard()).toBeInViewport();
  await stepper.click();
  await expect(riskCard()).toContainText('Charges stop being idempotent.');
  await expect(riskCard()).toHaveCount(1);
  await expect(riskCard()).toBeInViewport();
  await page.keyboard.press('Escape');
  await expect(riskCard()).toHaveCount(0);

  // A pinned card whose bars scroll out of the diff closes (it never floats over the header or the rail); scrolled
  // back, the bars show no card until asked.
  await openCard(review, client, ['Charges stop being idempotent.']);
  await expect(barsOf(review, client)).toHaveAttribute('aria-expanded', 'true');
  const code = (await review.locator('[data-guide-file-shell="src/charges/client.ts"]').boundingBox())!;
  await page.mouse.move(code.x + 80, Math.min(code.y + code.height, page.viewportSize()!.height) - 40);
  await page.mouse.wheel(0, 4000);
  // Out of view (or no longer drawn: the diff may let a line far out of view go).
  await expect
    .poll(() => barsOf(review, client).evaluateAll((els) => els.every((el) => { const r = el.getBoundingClientRect(); return r.bottom <= 0 || r.top >= window.innerHeight; })))
    .toBe(true);
  await expect(riskCard()).toHaveCount(0);
  await page.screenshot({ path: join(proofDir, '09-scrolled-away-no-card-dark.png') });
  await shellTop(review, 'src/charges/client.ts');
  await expect(barsOf(review, client)).toBeInViewport();
  await page.waitForTimeout(700);
  await expect(riskCard()).toHaveCount(0);
  await expect(barsOf(review, client)).toHaveAttribute('aria-expanded', 'false');

  await review.locator('[data-guide-file-shell="src/charges/retry.ts"]').scrollIntoViewIfNeeded();
  await openCard(review, retry, ['Each retry charges the card twice.']);
  await page.screenshot({ path: join(proofDir, '01-high-card-dark.png') });
  await page.keyboard.press('Escape');
});

test('a Medium PR: two filled bars, on its one named file and its one range', async () => {
  const review = await openReview(602);
  await expect(treeMarks()).toHaveCount(1);
  await expect(treeRow('send.ts').locator('[data-item-part-id="risk"]')).toHaveAttribute('title', 'Medium risk');
  await expect(treeRow('done.ts').locator('[data-item-part-id="risk"]')).toHaveCount(0);
  await expect.poll(() => diffMarks(review)).toEqual(['src/receipts/send.ts additions 5']);
  // The line the first build drew its mark over: now the mark sits at the edge, filled with the line's colour.
  await expectNoOverlap(review, { file: 'src/receipts/send.ts', column: 'additions', line: 5 }, { long: true });
  await expect(review.getByRole('button', { name: 'Medium risk: It looks the charge up before sending.' })).toHaveCount(1);
  await scheme('dark');
  await openCard(review, { file: 'src/receipts/send.ts', column: 'additions', line: 5 }, ['Medium', 'It looks the charge up before sending.']);
  await expect(riskCard()).toHaveAttribute('data-risk-card', 'medium');
  await page.screenshot({ path: join(proofDir, '02-medium-card-dark.png') });
  await page.keyboard.press('Escape');
});

test('light theme close-ups of both marks', async () => {
  const review = await openReview(601);
  await scheme('light');
  const rowBox = (await treeRow('retry.ts').boundingBox())!;
  const name = (await treeRow('retry.ts').locator('[data-item-section="content"]').boundingBox())!;
  await page.screenshot({ path: join(proofDir, '03-closeup-tree-light.png'), clip: { x: rowBox.x, y: rowBox.y - 4, width: name.x + name.width + 12 - rowBox.x, height: rowBox.height + 8 } });
  // A new theme draws the code again (its highlighting comes back): take the line once it holds still.
  const ref: LineRef = { file: 'src/charges/retry.ts', column: 'additions', line: 21 };
  let g!: Awaited<ReturnType<typeof lineGeometry>>;
  await expect(async () => {
    await review.locator('[data-guide-file-shell="src/charges/retry.ts"]').scrollIntoViewIfNeeded();
    await expect(review.locator(lineSelector(ref)).first()).toBeInViewport({ timeout: 2000 });
    g = await lineGeometry(review, ref);
  }).toPass({ timeout: 15_000 });
  await page.waitForTimeout(300);
  await openCard(review, ref, ['Each retry charges the card twice.']);
  g = await lineGeometry(review, ref);
  const card = (await riskCard().boundingBox())!;
  const left = Math.min(card.x, g.visibleRight - 240) - 12;
  const top = g.line.y - g.lineHeight;
  await page.screenshot({
    path: join(proofDir, '03-closeup-diff-card-light.png'),
    clip: { x: left, y: top, width: g.visibleRight + 12 - left, height: Math.max(card.y + card.height, g.line.y + g.lineHeight * 2) + 12 - top },
  });
  await page.keyboard.press('Escape');
});

test('a Low PR: no marks anywhere', async () => {
  const review = await openReview(603);
  await expect(review.locator('[data-pull-risk="low"]')).toBeVisible();
  await expect(review.locator('[data-guide-file-shell="README.md"]')).toBeVisible();
  await expect(treeMarks()).toHaveCount(0);
  expect(await diffMarks(review)).toEqual([]);
  await expect(review.locator('[data-pull-risk-places]')).toHaveCount(0);
  await scheme('dark');
  await page.screenshot({ path: join(proofDir, '04-low-no-marks-dark.png') });
});

test('long lines: split, unified and wrapped, old and new sides, the mark covers no code; a root file keeps its mark in its row', async () => {
  const setLook = async (style: 'split' | 'unified', overflow: 'scroll' | 'wrap') => {
    await context.addCookies([
      { name: 'plannotator-diff-style', value: style, url },
      { name: 'plannotator-diff-overflow', value: overflow, url },
    ]);
  };
  const contrastSeen: Record<string, number> = {};
  try {
    // Split, scrolling sideways.
    let review = await openReview(604);
    await scheme('dark');
    await expect.poll(() => diffMarks(review).then((m) => m.sort())).toEqual(['charges.ts additions 2', 'charges.ts additions 4', 'charges.ts deletions 2']);
    await expectNoOverlap(review, { file: 'charges.ts', column: 'additions', line: 2 }, { long: true });
    await expectNoOverlap(review, { file: 'charges.ts', column: 'deletions', line: 2 }, { long: true });
    await expectNoOverlap(review, { file: 'charges.ts', column: 'additions', line: 4 }, { long: false });
    // The tree: the marked root file's mark stays inside its row; marked and unmarked root rows line up.
    await expectBeforeIcon('charges.ts', 'CHANGELOG.md');
    // Contrast of the bars' tone (3:1, non-text) on the tree and both line colours, dark then light.
    for (const theme of ['dark', 'light'] as const) {
      await scheme(theme);
      let c!: Awaited<ReturnType<typeof markColours>>;
      await expect(async () => {
        c = await markColours(review, 'charges.ts');
      }).toPass({ timeout: 15_000 });
      for (const [on, bg] of Object.entries({ tree: c.treeBg, added: c.added, removed: c.removed })) {
        const ratio = await contrast(c.tone, bg);
        contrastSeen[`${theme} ${on}`] = ratio;
        expect(ratio, `${theme}: tone ${c.tone} on ${on} ${bg}`).toBeGreaterThanOrEqual(3);
      }
    }
    await scheme('dark');
    await review.locator('[data-guide-file-shell="charges.ts"]').scrollIntoViewIfNeeded();
    // The card on a long line's bars: at the column's right edge, wholly on screen, not cut by the column.
    await openCard(review, { file: 'charges.ts', column: 'additions', line: 2 }, ['Medium', 'The request now carries a key.']);
    await page.screenshot({ path: join(proofDir, '05-long-line-split-card-dark.png') });
    await page.keyboard.press('Escape');
    const tree = (await treeRow('charges.ts').boundingBox())!;
    const other = (await treeRow('CHANGELOG.md').boundingBox())!;
    const top = Math.min(tree.y, other.y) - 34;
    await page.screenshot({ path: join(proofDir, '07-root-file-tree-dark.png'), clip: { x: tree.x - 12, y: Math.max(0, top), width: Math.min(300, tree.width + 24), height: Math.max(tree.y, other.y) + tree.height + 12 - Math.max(0, top) } });

    // Unified, scrolling sideways.
    await setLook('unified', 'scroll');
    review = await openReview(604);
    await scheme('dark');
    await expect.poll(() => diffMarks(review).then((m) => m.sort())).toEqual(['charges.ts unified 2', 'charges.ts unified 2', 'charges.ts unified 4']);
    // The old and new line 2 share a number in unified: told apart by the line's kind.
    for (const [type, line, long] of [['change-deletion', 2, true], ['change-addition', 2, true], ['change-addition', 4, false]] as const) {
      await expectNoOverlap(review, { file: 'charges.ts', column: 'unified', line, type }, { long });
    }
    await review.locator('[data-guide-file-shell="charges.ts"]').scrollIntoViewIfNeeded();
    await openCard(review, { file: 'charges.ts', column: 'unified', line: 2, type: 'change-deletion' }, ['The old request had none.']);
    await page.screenshot({ path: join(proofDir, '06-long-line-unified-card-dark.png') });
    await page.keyboard.press('Escape');

    // Wrapped, split and unified: the text wraps before the mark.
    for (const style of ['split', 'unified'] as const) {
      await setLook(style, 'wrap');
      review = await openReview(604);
      await expect(review.locator('[data-guide-file-shell="charges.ts"] pre[data-overflow="wrap"]').first()).toBeAttached();
      if (style === 'split') {
        await expectNoOverlap(review, { file: 'charges.ts', column: 'additions', line: 2 }, { long: true });
        await expectNoOverlap(review, { file: 'charges.ts', column: 'deletions', line: 2 }, { long: true });
      } else {
        await expectNoOverlap(review, { file: 'charges.ts', column: 'unified', line: 2, type: 'change-addition' }, { long: true });
        await expectNoOverlap(review, { file: 'charges.ts', column: 'unified', line: 2, type: 'change-deletion' }, { long: true });
      }
    }
  } finally {
    writeFileSync(join(proofDir, 'contrast.json'), `${JSON.stringify(contrastSeen, null, 2)}\n`);
    await setLook('split', 'scroll');
  }
});

test('a phone: a tap on the bars opens the card, inside the screen', async ({ browser }) => {
  // The Medium PR's review, at its own address, on a phone.
  await openReview(602);
  await expect(page.locator(`[data-pull-review="${keyOf(602)}"]`)).toBeVisible();
  const hash = await page.evaluate(() => location.hash);
  expect(hash).toContain('layer=');
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark', hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  try {
    const tab = await phone.newPage();
    await tab.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await tab.goto(`${url}${hash}`);
    const bars = tab.locator(`[data-pull-review="${keyOf(602)}"] [data-host-line-mark]`).first();
    await expect(bars).toBeAttached({ timeout: 30_000 });
    await expect(bars).toHaveAttribute('aria-label', 'Medium risk: It looks the charge up before sending.');
    await bars.scrollIntoViewIfNeeded();
    await bars.tap();
    const card = tab.locator('.ib-riskcard');
    await expect(card).toContainText('It looks the charge up before sending.');
    await expect(card).toBeInViewport({ ratio: 1 });
    await tab.waitForTimeout(250);
    const box = (await card.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    await tab.screenshot({ path: join(proofDir, '08-phone-card-dark.png') });
  } finally {
    await phone.close();
  }
});
