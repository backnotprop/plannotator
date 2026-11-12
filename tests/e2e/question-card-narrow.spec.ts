import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SimAgent, scratchProject } from '../../scripts/inbox-sim';
import { E2E_LAUNCH_OFF, inboxScratch, removeInboxScratch } from './inbox-scratch';
import { NO_BROWSER } from '../helpers/no-browser';

const repo = resolve(__dirname, '../..');
const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? join(repo, '.local/plannotator'));
const shotsDir = process.env.QUESTION_CARD_SHOTS ? resolve(process.env.QUESTION_CARD_SHOTS) : '';
const prefix = process.env.QUESTION_CARD_SHOT_PREFIX ?? 'after';
const check = prefix === 'before' ? expect.soft : expect;

test.use({ actionTimeout: 15_000 });
test.describe.configure({ mode: prefix === 'before' ? 'default' : 'serial' });

const DOC = [
  '# Invoice rounding',
  '',
  'We round once today. Four calls before the change ships.',
  '',
  ':::question',
  'Which rounding should ship?',
  '',
  '- [ ] Once per invoice, after tax',
  '- [ ] Each line, then add them',
  'Recommended: Once per invoice, after tax',
  ':::',
  '',
  ':::question',
  'Where should the retry worker send a job that fails five times in a row?',
  '',
  '- [ ] Keep it in the main queue with a longer back-off between attempts — retries stay invisible to on-call',
  '- [ ] Move it to the dead-letter queue and page on-call — someone sees it within the hour',
  '- [ ] Drop it',
  'Recommended: Move it to the dead-letter queue and page on-call',
  ':::',
  '',
  ':::question-multi',
  'Which exports should the ledger keep?',
  '',
  '- [ ] CSV',
  '- [ ] Parquet',
  '- [ ] JSON lines',
  'Recommended: CSV, Parquet',
  ':::',
  '',
  ':::question',
  'What should the release note call the change?',
  '',
  'Recommended: Invoices now round once, after tax',
  ':::',
  '',
].join('\n');

const CARD = 'fieldset[data-question-key]';

async function footerProblems(page: Page, options: { scope?: string; minTarget?: number; oneRow?: boolean; order?: boolean } = {}): Promise<string[]> {
  return page.evaluate(({ scope, card, minTarget, oneRow, order }) => {
    const out: string[] = [];
    const textLines = (el: Element): Set<number> => {
      const tops = new Set<number>();
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.trim()) continue;
        const holder = node.parentElement!.getBoundingClientRect();
        if (holder.width <= 1 || holder.height <= 1) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const r of range.getClientRects()) if (r.width > 1 && r.height > 1) tops.add(Math.round(r.top + r.height / 2));
      }
      return tops;
    };
    const root = scope ? document.querySelector(scope) : document;
    if (!root) return [`no ${scope}`];
    const rtl = getComputedStyle(document.documentElement).direction === 'rtl';
    root.querySelectorAll<HTMLElement>(card).forEach((fieldset, n) => {
      const foot = fieldset.querySelector<HTMLElement>(':scope > div.border-t');
      if (!foot || fieldset.getBoundingClientRect().width === 0) return;
      const cardBox = fieldset.getBoundingClientRect();
      const boxes: DOMRect[] = [];
      for (const button of foot.querySelectorAll<HTMLButtonElement>('button')) {
        const name = `card ${n + 1} "${button.textContent?.trim()}"`;
        if (button.getClientRects().length === 0) {
          out.push(`${name} is not drawn`);
          continue;
        }
        const lines = textLines(button);
        if (lines.size > 1) out.push(`${name} wraps onto ${lines.size} lines`);
        const box = button.getBoundingClientRect();
        if (getComputedStyle(button).textOverflow !== 'ellipsis') {
          const range = document.createRange();
          range.selectNodeContents(button);
          const words = [...range.getClientRects()].filter((r) => r.width > 1 && r.height > 1);
          if (words.some((r) => r.left < box.left - 1 || r.right > box.right + 1)) out.push(`${name} overflows its button`);
        }
        if (box.right > cardBox.right + 1 || box.left < cardBox.left - 1) out.push(`${name} sits outside the card`);
        if (minTarget) {
          const before = getComputedStyle(button, '::before');
          const hit = before.content !== 'none' && before.position === 'absolute'
            ? { w: Math.max(box.width, parseFloat(before.width) || 0), h: Math.max(box.height, parseFloat(before.height) || 0) }
            : { w: box.width, h: box.height };
          if (hit.h < minTarget - 0.5 || hit.w < minTarget - 0.5) out.push(`${name}: a ${Math.round(hit.w)} × ${Math.round(hit.h)} px target, under ${minTarget}`);
        }
        boxes.push(box);
      }
      for (let i = 1; order && i < boxes.length; i++) {
        const a = boxes[i - 1]!;
        const b = boxes[i]!;
        const sameRow = b.top < a.bottom - 2 && b.bottom > a.top + 2;
        const inOrder = sameRow ? (rtl ? b.right <= a.left + 1 : b.left >= a.right - 1) : b.top >= a.bottom - 2;
        if (!inOrder) out.push(`card ${n + 1}: button ${i + 1} is drawn before button ${i}`);
      }
      const parts: HTMLElement[] = [];
      const collect = (el: HTMLElement) => {
        for (const child of el.children as HTMLCollectionOf<HTMLElement>) {
          if (getComputedStyle(child).display === 'contents') collect(child);
          else if (child.getClientRects().length) parts.push(child);
        }
      };
      collect(foot);
      const rects = parts.map((p) => p.getBoundingClientRect());
      const fs = getComputedStyle(foot);
      const room = foot.clientWidth - parseFloat(fs.paddingLeft) - parseFloat(fs.paddingRight);
      const need = rects.reduce((sum, r) => sum + r.width, 0) + (parseFloat(fs.columnGap) || 0) * Math.max(0, rects.length - 1);
      const first = rects[0];
      const split = !!first && rects.some((b) => Math.abs(b.top + b.height / 2 - (first.top + first.height / 2)) > first.height / 2);
      if (split && (oneRow || need <= room - 0.5)) out.push(`card ${n + 1}: the footer takes more than one row (its parts need ${Math.round(need)} of ${Math.round(room)} px)`);
    });
    return out;
  }, { scope: options.scope ?? null, card: CARD, minTarget: options.minTarget ?? 0, oneRow: options.oneRow ?? false, order: options.order ?? true });
}

async function tagProblems(page: Page): Promise<string[]> {
  return page.evaluate((card) => {
    const out: string[] = [];
    document.querySelectorAll<HTMLElement>(`${card} label[data-question-option] [data-question-tag="rec"]`).forEach((tag) => {
      const row = tag.closest('label')!.getBoundingClientRect();
      const box = tag.getBoundingClientRect();
      if (box.height > 24) out.push(`a Recommended tag is ${Math.round(box.height)} px tall`);
      if (box.right > row.right + 1) out.push('a Recommended tag runs past its row');
    });
    return out;
  }, CARD);
}

async function tapProblems(page: Page, scope = 'body'): Promise<string[]> {
  const out: string[] = [];
  const count = await page.locator(`${scope} ${CARD}`).count();
  for (let n = 0; n < count; n++) {
    await page.locator(`${scope} ${CARD}`).nth(n).locator(':scope > div.border-t').evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(50);
    out.push(...(await page.evaluate(({ scope, card, n }) => {
      const problems: string[] = [];
      const fieldset = document.querySelectorAll<HTMLElement>(`${scope} ${card}`)[n]!;
      const foot = fieldset.querySelector<HTMLElement>(':scope > div.border-t');
      if (!foot) return problems;
      const buttons = [...foot.querySelectorAll<HTMLButtonElement>('button')].filter((b) => b.getClientRects().length > 0);
      const name = (b: Element | null) => (b ? `"${b.textContent?.trim()}"` : 'nothing');
      for (const button of buttons) {
        const r = button.getBoundingClientRect();
        const radius = Math.min(parseFloat(getComputedStyle(button).borderTopLeftRadius) || 0, r.width / 2, r.height / 2);
        const drawn = (x: number, y: number) => {
          const cx = Math.min(Math.max(x, r.left + radius), r.right - radius);
          const cy = Math.min(Math.max(y, r.top + radius), r.bottom - radius);
          return Math.hypot(x - cx, y - cy) <= radius - 1;
        };
        const wrong = new Map<string, number>();
        for (let y = r.top + 1; y < r.bottom - 1; y += 2) {
          for (let x = r.left + 1; x < r.right - 1; x += 2) {
            if (!drawn(x, y)) continue;
            const hit = document.elementFromPoint(x, y)?.closest('button') ?? null;
            if (hit !== button) wrong.set(name(hit), (wrong.get(name(hit)) ?? 0) + 1);
          }
        }
        for (const [other, points] of wrong) problems.push(`card ${n + 1}: ${points} points inside ${name(button)} reach ${other}`);
      }
      let stolen = 0;
      for (const part of fieldset.children) {
        if (part === foot) continue;
        const r = part.getBoundingClientRect();
        for (let y = Math.max(r.top, 0) + 1; y < r.bottom - 1; y += 2) {
          for (let x = r.left + 1; x < r.right - 1; x += 2) {
            const hit = document.elementFromPoint(x, y)?.closest('button');
            if (hit && buttons.includes(hit as HTMLButtonElement)) stolen += 1;
          }
        }
      }
      if (stolen) problems.push(`card ${n + 1}: ${stolen} points on the card's content reach a footer button`);
      return problems;
    }, { scope, card: CARD, n })));
  }
  return out;
}

async function cardWidth(page: Page, width: number | null, scope = 'body'): Promise<void> {
  await page.evaluate(({ width, scope, card }) => {
    document.querySelectorAll<HTMLElement>(`${scope} ${card}`).forEach((el) => {
      el.style.width = width === null ? '' : `${width}px`;
    });
  }, { width, scope, card: CARD });
  await page.waitForTimeout(60);
}

async function shot(page: Page, name: string, target?: string): Promise<void> {
  if (!shotsDir) return;
  mkdirSync(shotsDir, { recursive: true });
  await page.waitForTimeout(250);
  const path = join(shotsDir, `${prefix}-${name}.png`);
  if (target) await page.locator(target).first().screenshot({ path });
  else await page.screenshot({ path });
}

const SCHEMES = ['light', 'dark'] as const;

async function scheme(page: Page, url: string, value: 'light' | 'dark'): Promise<void> {
  await page.context().addCookies([{ name: 'plannotator-theme', value, url }]);
  await page.emulateMedia({ colorScheme: value, reducedMotion: 'reduce' });
}

async function quietCookies(context: BrowserContext, url: string): Promise<void> {
  await context.addCookies(
    [
      ['plannotator-plan-look-choice-resolved', 'true'],
      ['plannotator-announce-tui-herdr-seen', '1'],
      ['plannotator-announce-ask-session-seen', '1'],
      ['plannotator-announce-agent-tool-seen', '1'],
      ['plannotator-announce-inbox-seen', '1'],
      ['plannotator-permission-mode-configured', 'true'],
    ].map(([name, value]) => ({ name: name!, value: value!, url })),
  );
}

async function reload(page: Page): Promise<void> {
  await page.reload();
  await expect(page.locator(CARD)).toHaveCount(4);
  const dismiss = page.getByRole('dialog').getByRole('button', { name: 'Dismiss' });
  if (await dismiss.waitFor({ timeout: 2_000 }).then(() => true, () => false)) await dismiss.click();
}

interface Session {
  url: string;
  close: () => Promise<void>;
}

async function startReview(kind: 'annotate' | 'plan'): Promise<Session> {
  const root = inboxScratch(`plannotator-question-card-${kind}-`);
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  const readyFile = join(root, 'ready.jsonl');
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: root,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_READY_FILE: readyFile,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    NO_BROWSER,
    PLANNOTATOR_SKIP_BROWSER_OPEN: '1',
    PLANNOTATOR_REMOTE: '0',
    PLANNOTATOR_INBOX_CONNECT: '0',
    PLANNOTATOR_UPDATE_CHECK: '0',
  };
  let child: ChildProcess;
  if (kind === 'annotate') {
    const doc = join(root, 'QUESTIONS.md');
    writeFileSync(doc, DOC);
    child = spawn(binary, ['annotate', doc], { env, cwd: root, stdio: ['ignore', 'ignore', 'ignore'] });
  } else {
    child = spawn(binary, [], { env, cwd: root, stdio: ['pipe', 'ignore', 'ignore'] });
    child.stdin!.end(
      JSON.stringify({
        session_id: 'e2e',
        transcript_path: join(root, 'transcript.jsonl'),
        cwd: root,
        permission_mode: 'plan',
        hook_event_name: 'PermissionRequest',
        tool_name: 'ExitPlanMode',
        tool_input: { plan: DOC },
      }),
    );
  }
  await expect.poll(() => (existsSync(readyFile) ? readFileSync(readyFile, 'utf8') : ''), { timeout: 30_000 }).toContain('"url"');
  const url = (JSON.parse(readFileSync(readyFile, 'utf8').trim().split('\n')[0]!) as { url: string }).url;
  const close = async () => {
    await fetch(new URL('/api/exit', url), { method: 'POST' }).catch(() => {});
    if (child.exitCode === null) {
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
  };
  return { url, close };
}

async function openReview(browser: Browser, session: Session, options: Parameters<Browser['newContext']>[0] = {}): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options });
  await quietCookies(context, session.url);
  const page = await context.newPage();
  await scheme(page, session.url, 'light');
  await page.goto(session.url);
  await expect(page.locator(CARD)).toHaveCount(4);
  return { context, page };
}

test.beforeAll(() => {
  expect(existsSync(binary), `build the binary first: ${binary}`).toBe(true);
});

test.afterAll(async () => {
  await removeInboxScratch();
});

test('annotate: at every column width the footer buttons keep their words on one line, in order, inside the card; a wide card keeps one row', async ({ browser }) => {
  const session = await startReview('annotate');
  try {
    const { context, page } = await openReview(browser, session);
    for (const width of [200, 240, 280, 300, 320, 360, 400, 480, 560, 720]) {
      await cardWidth(page, width);
      check(await footerProblems(page, { oneRow: width >= 300 }), `cards ${width} px wide`).toEqual([]);
      check(await tagProblems(page), `cards ${width} px wide`).toEqual([]);
    }
    const first = page.locator(CARD).first();
    const third = page.locator(CARD).nth(2);
    for (const width of [280, 720]) {
      await cardWidth(page, width);
      const steps: [string, () => Promise<void>][] = [
        ['a note open', () => first.getByRole('button', { name: 'Add note' }).click()],
        ['a card skipped', () => third.getByRole('button', { name: 'Skip' }).click()],
        ['a choice picked', () => page.locator(CARD).nth(1).locator('label[data-question-option]').last().click()],
        ['Accept recommended', () => third.getByRole('button', { name: 'Unskip' }).click().then(() => third.getByRole('button', { name: 'Accept recommended' }).click())],
        ['Other typed', () => page.locator(CARD).nth(1).getByRole('textbox', { name: /^Other answer/ }).fill('Retry once, then dead-letter it')],
        ['the note closed', () => first.getByRole('button', { name: 'Hide note' }).click()],
      ];
      for (const [what, step] of steps) {
        await step();
        await page.waitForTimeout(60);
        check(await footerProblems(page, { oneRow: width >= 480 }), `cards ${width} px wide, after ${what}`).toEqual([]);
      }
      await reload(page);
      await cardWidth(page, width);
    }
    {
      const touch = await openReview(browser, session, { hasTouch: true });
      expect(await touch.page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
      await touch.page.getByRole('dialog').getByRole('button', { name: 'Dismiss' }).click({ timeout: 2_000 }).catch(() => {});
      for (const note of ['closed', 'open'] as const) {
        if (note === 'open') {
          for (let n = 0; n < 4; n++) await touch.page.locator(CARD).nth(n).getByRole('button', { name: 'Add note' }).click();
        }
        for (const width of [200, 262, 280, 320]) {
          await cardWidth(touch.page, width);
          check(await tapProblems(touch.page), `touch, cards ${width} px wide, the note ${note}`).toEqual([]);
          await touch.page.locator(CARD).first().scrollIntoViewIfNeeded();
          await shot(touch.page, `annotate-touch-${width}-note-${note}-light`, `${CARD} >> nth=0`);
        }
      }
      await touch.context.close();
    }

    await cardWidth(page, 160);
    check(await footerProblems(page), 'cards 160 px wide').toEqual([]);
    await expect(page.locator(CARD).nth(1).getByRole('button', { name: 'Accept recommended', exact: true })).toHaveCount(1);

    for (const value of SCHEMES) {
      await scheme(page, session.url, value);
      await reload(page);
      for (const width of [360, 480, 560, 720, null]) {
        await cardWidth(page, width);
        const tag = width === null ? 'wide' : String(width);
        await shot(page, `annotate-card-${tag}-${value}`, `${CARD} >> nth=0`);
        await shot(page, `annotate-long-${tag}-${value}`, `${CARD} >> nth=1`);
      }
      await cardWidth(page, 280);
      await shot(page, `annotate-card-280-${value}`, `${CARD} >> nth=0`);
      await cardWidth(page, null);
    }

    await scheme(page, session.url, 'light');
    await reload(page);
    await page.evaluate(() => document.documentElement.setAttribute('dir', 'rtl'));
    for (const width of [280, 560]) {
      await cardWidth(page, width);
      check(await footerProblems(page, { oneRow: width >= 480 }), `right to left, ${width} px`).toEqual([]);
      await shot(page, `annotate-rtl-${width}-light`, `${CARD} >> nth=0`);
    }
    if (prefix !== 'before') {
      await cardWidth(page, 560);
      const ends = await page.locator(CARD).first().evaluate((card) => {
        const box = card.getBoundingClientRect();
        const accept = [...card.querySelectorAll('button')].find((b) => b.textContent === 'Accept recommended')!.getBoundingClientRect();
        return { cardLeft: box.left, acceptLeft: accept.left };
      });
      expect(ends.acceptLeft - ends.cardLeft).toBeLessThan(24);
    }
    await context.close();
  } finally {
    await session.close();
  }
});

test('plan review: wide, narrow windows, 200% zoom and phones; a footer that fits keeps one row; on a phone each footer button has a 44 px target', async ({ browser }) => {
  const session = await startReview('plan');
  try {
    for (const value of SCHEMES) {
      const { context, page } = await openReview(browser, session, { colorScheme: value });
      await scheme(page, session.url, value);
      await page.reload();
      await expect(page.locator(CARD)).toHaveCount(4);
      for (const width of [1440, 1024, 768, 360]) {
        await page.setViewportSize({ width, height: 900 });
        await page.waitForTimeout(200);
        check(await footerProblems(page), `plan review at ${width} px`).toEqual([]);
        await page.locator(CARD).first().scrollIntoViewIfNeeded();
        await shot(page, `plan-${width}-${value}`, `${CARD} >> nth=0`);
      }
      await context.close();
      const zoomed = await openReview(browser, session, { viewport: { width: 720, height: 450 }, deviceScaleFactor: 2, colorScheme: value });
      await scheme(zoomed.page, session.url, value);
      await zoomed.page.reload();
      await expect(zoomed.page.locator(CARD)).toHaveCount(4);
      check(await footerProblems(zoomed.page), 'plan review at 200% zoom').toEqual([]);
      await zoomed.page.locator(CARD).first().scrollIntoViewIfNeeded();
      await shot(zoomed.page, `plan-zoom200-${value}`, `${CARD} >> nth=0`);
      await zoomed.context.close();
      for (const width of [360, 375, 390]) {
        const phone = await openReview(browser, session, { viewport: { width, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: value });
        await scheme(phone.page, session.url, value);
        await phone.page.reload();
        await expect(phone.page.locator(CARD)).toHaveCount(4);
        check(await footerProblems(phone.page, { minTarget: 44, oneRow: true }), `plan review on a ${width} px phone`).toEqual([]);
        check(await tagProblems(phone.page), `plan review on a ${width} px phone`).toEqual([]);
        await phone.page.locator(CARD).first().scrollIntoViewIfNeeded();
        await shot(phone.page, `plan-phone-${width}-${value}`, `${CARD} >> nth=0`);
        await shot(phone.page, `plan-phone-${width}-long-${value}`, `${CARD} >> nth=1`);
        await phone.context.close();
      }
    }
  } finally {
    await session.close();
  }
});

test('the Inbox: a thread full width, beside a file, on a phone, and the Decide dialog', async ({ browser }) => {
  const root = inboxScratch('plannotator-question-card-inbox-');
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ ...E2E_LAUNCH_OFF, experimental: { decisionMode: true } }));
  const env = { PATH: process.env.PATH ?? '', HOME: root, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_BROWSER: NO_BROWSER, PLANNOTATOR_INBOX_CONNECT: '0', PLANNOTATOR_UPDATE_CHECK: '0' };
  let agent: SimAgent | null = null;
  try {
    const started = spawnSync(binary, ['inbox', '--background'], { env, encoding: 'utf8', timeout: 60_000 });
    expect(started.status, started.stderr).toBe(0);
    const url = started.stdout.trim();
    const project = scratchProject(join(root, 'src'), 'billing');
    mkdirSync(join(project, 'docs'), { recursive: true });
    writeFileSync(join(project, 'docs', 'rounding.md'), '# Rounding\n\nOnce per invoice, after tax, is what the ledger does today.\n');
    agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
    const sent = await agent.send({ project_path: project, subject: 'Invoice rounding', body: DOC, attachments: ['docs/rounding.md'] });
    const threadId = sent.thread_id as string;
    let fileId: string | undefined;

    for (const value of SCHEMES) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: value });
      const page = await context.newPage();
      await page.emulateMedia({ colorScheme: value, reducedMotion: 'reduce' });
      const pane = 'section.ib-pane';
      await page.goto(`${url}#thread=${threadId}`);
      await expect(page.locator(`${pane} ${CARD}`)).toHaveCount(4);
      if (!fileId) {
        const thread = await page.evaluate(async (id) => (await (await fetch(`/api/inbox/threads/${id}`)).json()).thread, threadId);
        fileId = (thread.messages[0].attachments as { id: string; name: string }[]).find((a) => a.name === 'rounding.md')?.id;
        expect(fileId).toBeTruthy();
      }
      check(await footerProblems(page, { scope: pane }), 'Inbox thread, full width').toEqual([]);
      await page.locator(`${pane} ${CARD}`).first().scrollIntoViewIfNeeded();
      await shot(page, `inbox-full-${value}`, `${pane} ${CARD} >> nth=0`);
      for (const width of [300, 280]) {
        await cardWidth(page, width, pane);
        check(await footerProblems(page, { scope: pane, oneRow: width >= 300, order: false }), `Inbox thread, cards ${width} px wide`).toEqual([]);
        await page.locator(`${pane} ${CARD}`).first().scrollIntoViewIfNeeded();
        await shot(page, `inbox-card-${width}-${value}`, `${pane} ${CARD} >> nth=0`);
      }
      await cardWidth(page, null, pane);
      {
        const tablet = await browser.newContext({ viewport: { width: 1024, height: 768 }, hasTouch: true, colorScheme: value });
        const t = await tablet.newPage();
        await t.emulateMedia({ colorScheme: value, reducedMotion: 'reduce' });
        await t.goto(`${url}#thread=${threadId}`);
        await expect(t.locator(`${pane} ${CARD}`)).toHaveCount(4);
        expect(await t.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
        for (const width of [200, 262, 280]) {
          await cardWidth(t, width, pane);
          check(await tapProblems(t, pane), `Inbox on a tablet, cards ${width} px wide`).toEqual([]);
        }
        await tablet.close();
      }
      if (fileId) {
        for (const width of [1440, 1100]) {
          await page.setViewportSize({ width, height: 900 });
          await page.goto(`${url}#thread=${threadId}&file=${fileId}&view=side`);
          await expect(page.locator('[data-attachment-pane]')).toBeVisible();
          await page.waitForTimeout(300);
          check(await footerProblems(page, { scope: pane }), `Inbox thread beside a file at ${width} px`).toEqual([]);
          await page.locator(`${pane} ${CARD}`).first().scrollIntoViewIfNeeded();
          await shot(page, `inbox-side-${width}-${value}`, `${pane} ${CARD} >> nth=0`);
        }
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${url}#thread=${threadId}`);
      await page.locator(`${pane} [data-open-questions]`).click();
      await page.locator('[data-thread-decide]').click();
      await expect(page.locator('[data-decision-mode]')).toBeVisible();
      for (const width of [1440, 720]) {
        await page.setViewportSize({ width, height: 900 });
        await page.waitForTimeout(300);
        check(await decideProblems(page), `Decide at ${width} px`).toEqual([]);
        await shot(page, `decide-${width}-${value}`);
      }
      await context.close();

      const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: value });
      const p = await phone.newPage();
      await p.emulateMedia({ colorScheme: value, reducedMotion: 'reduce' });
      await p.goto(`${url}#thread=${threadId}`);
      await expect(p.locator(`${pane} ${CARD}`)).toHaveCount(4);
      check(await footerProblems(p, { scope: pane, minTarget: 44 }), 'Inbox thread on a phone').toEqual([]);
      await p.locator(`${pane} ${CARD}`).first().scrollIntoViewIfNeeded();
      await shot(p, `inbox-phone-390-${value}`, `${pane} ${CARD} >> nth=0`);
      await shot(p, `inbox-phone-390-long-${value}`, `${pane} ${CARD} >> nth=1`);
      await p.locator(`${pane} [data-open-questions]`).click();
      await p.locator('[data-thread-decide]').click();
      await expect(p.locator('[data-decision-mode]')).toBeVisible();
      await p.waitForTimeout(300);
      check(await decideProblems(p), 'Decide on a phone').toEqual([]);
      await shot(p, `decide-phone-390-${value}`);
      await phone.close();
    }
  } finally {
    await agent?.close().catch(() => {});
    await removeInboxScratch(root);
  }
});

async function decideProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const textLines = (el: Element): Set<number> => {
      const tops = new Set<number>();
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.trim()) continue;
        const holder = node.parentElement!.getBoundingClientRect();
        if (holder.width <= 1 || holder.height <= 1) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const r of range.getClientRects()) if (r.width > 1 && r.height > 1) tops.add(Math.round(r.top + r.height / 2));
      }
      return tops;
    };
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-decision-mode] .ib-dm-more button')) {
      if (button.getBoundingClientRect().width === 0) continue;
      const lines = textLines(button);
      if (lines.size > 1) out.push(`"${button.textContent?.trim()}" wraps onto ${lines.size} lines`);
    }
    for (const rec of document.querySelectorAll<HTMLElement>('[data-decision-mode] .ib-dm-choice .ib-dm-rec')) {
      const label = rec.parentElement!.querySelector<HTMLElement>('.ib-dm-chl');
      if (!label) continue;
      const lineHeight = parseFloat(getComputedStyle(label).lineHeight) || 20;
      const tooNarrow = label.getBoundingClientRect().width < 120 && label.getBoundingClientRect().height > lineHeight * 2.5;
      if (tooNarrow) out.push(`"${label.textContent?.trim()}" is squeezed beside its Recommended tag`);
    }
    return out;
  });
}
