/**
 * LV-24..27: the live verifier's guards for a list and a thread that load in pages (stage 3, plan B5 row 1). Today
 * the window holds every row and every message, so each passes where today's behaviour is right; once rows past the
 * loaded edge and messages behind stubs are fetched on demand, each fails if paging breaks what the person sees.
 *
 * LV-24 A thread opened from a link, its row deep in Quiet (past a first page's 200 Quiet rows on the big stores):
 *       it opens, and J / K reach the rows the server's order puts next to it.
 * LV-25 Scrolled deep in a long list, a new thread arrives: "N new" counts it, nothing on screen moves, Show brings it.
 * LV-26 A snooze made elsewhere runs out: the row comes back on another device by itself (its clock, no action).
 * LV-27 A 300-message thread opens, and its "Show 20 earlier" unfolds more messages.
 */
import type { Page } from '@playwright/test';

/** A first list page's Quiet rows (plan B1: `limit` default 200). A row past this index is past the loaded edge. */
export const FIRST_PAGE_QUIET = 200;
/** How deep LV-24 reaches into Quiet: well past the edge where the store has that many Quiet rows. */
const DEEP_INDEX = 1000;

export interface DeepDeps {
  /** The list window for LV-24 and LV-25: Quiet is opened on it (its own browser context keeps that choice). */
  L: Page;
  /** The other device for LV-26 (left on the list). */
  C: Page;
  /** The window that opens the long thread (LV-27). */
  A: Page;
  /** Load the page afresh at this address suffix (LV-24's link), or null: change the address in place (a slow link). */
  freshLoad: ((p: Page, hash: string) => Promise<void>) | null;
  budgetMs: number;
  /** LV-27: how long a 300-message thread may take to open. */
  longOpenMs: number;
  log: (s: string) => void;
  check: (id: string, title: string, fn: () => Promise<{ pass: boolean; ms?: number | null; detail?: unknown }>) => Promise<void>;
  add: (name: string, unit: 'ms' | 'count' | 'bytes', x: number) => void;
  get: (path: string) => Promise<any>;
  post: (path: string, body: unknown) => Promise<{ status: number; text: string }>;
  listPath: string;
  newThread: (key: string, body: string) => Promise<string>;
  threads: { snz: string; long: string };
  arm: (page: Page, key: string, cond: string, timeout?: number) => Promise<void>;
  landed: (page: Page, key: string, t0: number, timeout?: number) => Promise<number>;
  traffic: { between: (t0: number, t1: number, pages?: string[]) => { count: number; bytes: number } };
  /** The traffic name of A (LV-27's requests). */
  aName: string;
  rowSel: (id: string) => string;
  paneSel: (id: string) => string;
  toList: (p: Page) => Promise<void>;
  showNews: (p: Page) => Promise<void>;
}

const pause = (ms: number) => new Promise((d) => setTimeout(d, ms));
const routeThread = (p: Page) => p.evaluate(() => decodeURIComponent(/thread=([^&]+)/.exec(location.hash)?.[1] ?? '') || null);
const noticeCount = `(() => { const n = document.querySelector('[data-inbox-notice] .ib-notice-n')?.textContent ?? ''; return parseInt(n, 10) || 0; })()`;

/** Open the Quiet group on `p` (closed by default; the choice is a cookie, so a reload keeps it open). */
async function openQuiet(p: Page): Promise<number> {
  const band = p.locator('.ib-group[data-section-id="quiet"] button.ib-band');
  if ((await band.count()) === 0) return 0;
  if ((await band.first().getAttribute('aria-expanded')) !== 'true') await band.first().click();
  await p.waitForSelector('.ib-group[data-section-id="quiet"] [data-thread-id]', { timeout: 120_000 }).catch(() => {});
  return p.evaluate(() => document.querySelectorAll('.ib-group[data-section-id="quiet"] [data-thread-id]').length);
}

/** The list's scroller (the nearest scrolling box around the rows). */
const scroller = `(() => { let e = document.querySelector('.ib-lbody'); while (e && !(e.scrollHeight > e.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(e).overflowY))) e = e.parentElement; return e; })()`;

export async function runDeepChecks(d: DeepDeps): Promise<void> {
  const { L, C, A, budgetMs, check, get, post, arm, landed, rowSel, paneSel } = d;

  d.log('deep: LV-24');
  await check('LV-24', 'A thread opened from a link, its row deep in Quiet (past the loaded edge), opens; J and K reach its neighbours in list order', async () => {
    const quietDrawn = await openQuiet(L);
    const model = await get(d.listPath);
    const quiet: string[] = (model.sections ?? []).find((s: any) => s.id === 'quiet')?.threads.map((r: any) => r.thread_id) ?? [];
    if (quiet.length < 3) return { pass: false, detail: { quiet: quiet.length, why: 'fewer than 3 Quiet rows' } };
    const index = Math.max(1, Math.min(quiet.length - 2, DEEP_INDEX));
    const id = quiet[index]!;
    const t0 = Date.now();
    if (d.freshLoad) await d.freshLoad(L, `#thread=${encodeURIComponent(id)}`);
    else await L.evaluate((id) => (location.hash = `#thread=${encodeURIComponent(id)}`), id);
    const opened = await L.waitForSelector(`${paneSel(id)} [data-message-article]`, { timeout: 120_000 }).then(
      () => Date.now() - t0,
      () => -1,
    );
    const rowShown = await L.waitForSelector(rowSel(id), { timeout: 60_000 }).then(
      () => true,
      () => false,
    );
    await pause(500);
    const steps: { key: string; want: string; got: string | null; ms: number }[] = [];
    for (const [key, want] of [['j', quiet[index + 1]!], ['k', id], ['k', quiet[index - 1]!]] as const) {
      const from = await routeThread(L);
      await L.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
      const t = Date.now();
      await L.keyboard.press(key);
      let got: string | null = from;
      for (const end = Date.now() + 10_000; Date.now() < end && got === from; ) {
        await pause(30);
        got = await routeThread(L);
      }
      steps.push({ key, want, got: got === from ? null : got, ms: Date.now() - t });
      await L.waitForSelector(`${paneSel(want)} [data-message-article]`, { timeout: 30_000 }).catch(() => {});
    }
    const keysOk = steps.every((s) => s.got === s.want);
    d.add('deepLinkOpen', 'ms', opened);
    return { pass: opened >= 0 && rowShown && keysOk, ms: opened, detail: { index, quietRows: quiet.length, quietDrawn, pastLoadedEdge: index >= FIRST_PAGE_QUIET, rowShown, steps } };
  });

  d.log('deep: LV-25');
  await check('LV-25', 'Scrolled deep in the list, a new thread arrives: "N new" counts it, nothing on screen moves, Show brings it in', async () => {
    await d.toList(L);
    await d.showNews(L);
    await openQuiet(L);
    const scrolled = await L.evaluate(`(() => { const s = ${scroller}; if (!s) return { px: 0, of: 0 }; s.scrollTop = s.scrollHeight; return { px: Math.round(s.scrollTop), of: s.scrollHeight }; })()`);
    await pause(1000);
    // The row in the middle of the list's view: it must not move when the news arrives.
    await L.evaluate(() => {
      const rows = [...document.querySelectorAll('.ib-lbody [data-thread-id]')] as HTMLElement[];
      const mid = window.innerHeight / 2;
      document.querySelector('[data-lv-deep]')?.removeAttribute('data-lv-deep');
      (rows.find((r) => r.getBoundingClientRect().top <= mid && r.getBoundingClientRect().bottom >= mid) ?? rows[rows.length - 1])?.setAttribute('data-lv-deep', '');
    });
    const top = () => L.evaluate(() => (document.querySelector('[data-lv-deep]') as HTMLElement | null)?.getBoundingClientRect().top ?? null);
    const before = await top();
    const countBefore = (await L.evaluate(noticeCount)) as number;
    await arm(L, 'n25', `return ${noticeCount} > ${countBefore}`);
    const t0 = Date.now();
    const id = await d.newThread('deep', 'A new thread while the list is scrolled deep.');
    const ms = await landed(L, 'n25', t0);
    await pause(600);
    const countAfter = (await L.evaluate(noticeCount)) as number;
    const after = await top();
    const shownEarly = (await L.$(rowSel(id))) !== null;
    await L.locator('[data-inbox-notice]').first().click().catch(() => {});
    const brought = await L.waitForSelector(rowSel(id), { timeout: 5000 }).then(
      () => true,
      () => false,
    );
    const steady = before !== null && after !== null && Math.abs(after - before) < 2;
    return { pass: ms >= 0 && ms <= budgetMs && countAfter === countBefore + 1 && steady && !shownEarly && brought, ms, detail: { scrolled, countBefore, countAfter, before, after, shownEarly, brought } };
  });

  d.log('deep: LV-26');
  await check('LV-26', 'A snooze made elsewhere runs out: the row comes back on another device by itself, within budget of its time', async () => {
    const id = d.threads.snz;
    await d.toList(C);
    await d.showNews(C);
    const at = `(document.querySelector('${rowSel(id)}')?.getAttribute('data-section') ?? 'gone')`;
    const before = (await C.evaluate(at)) as string;
    if (before === 'gone' || before === 'snoozed') return { pass: false, detail: { before, why: 'the row is not listed before the snooze' } };
    await arm(C, 's26a', `const s = ${at}; return s === 'gone' || s === 'snoozed'`);
    const t0 = Date.now();
    // Long enough for a slow link's snooze to land before its time.
    const until = t0 + Math.max(6000, budgetMs * 3);
    const r = await post(`/threads/${id}/snooze`, { until: new Date(until).toISOString() });
    const left = await landed(C, 's26a', t0);
    // Back: its return is news ("N new", held.ts), or the row is drawn outside the Snoozed band.
    await arm(C, 's26b', `const s = ${at}; return !!document.querySelector('[data-inbox-notice]') || (s !== 'gone' && s !== 'snoozed')`, until - Date.now() + 30_000);
    const back = await landed(C, 's26b', until, until - Date.now() + 32_000);
    await d.showNews(C);
    const placed = await C.waitForFunction(new Function(`const s = ${at}; return s !== 'gone' && s !== 'snoozed'`) as () => boolean, null, { timeout: 5000 }).then(
      () => true,
      () => false,
    );
    const server = (await get(d.listPath)).sections?.flatMap((s: any) => s.threads).find((x: any) => x.thread_id === id) ?? null;
    return {
      pass: r.status === 200 && left >= 0 && left <= budgetMs && back >= 0 && back <= budgetMs && placed,
      ms: back,
      detail: { status: r.status, before, left, backAfterItsTime: back, placed, after: await C.evaluate(at), serverBack: server?.snooze_back ?? null },
    };
  });

  d.log('deep: LV-27');
  await check('LV-27', 'A 300-message thread opens, and "Show 20 earlier" unfolds more of it', async () => {
    const id = d.threads.long;
    const pane = paneSel(id);
    const articles = `document.querySelectorAll('${pane} [data-message-article]').length`;
    await d.toList(A);
    await pause(500);
    const t0 = Date.now();
    await A.evaluate((id) => (location.hash = `#thread=${encodeURIComponent(id)}`), id);
    const opened = await A.waitForSelector(`${pane} [data-message-article]`, { timeout: 120_000 }).then(
      () => Date.now() - t0,
      () => -1,
    );
    await pause(1500);
    const openBytes = d.traffic.between(t0, Date.now(), [d.aName]).bytes;
    const newest = await A.evaluate((sel) => [...document.querySelectorAll(`${sel} [data-message-article]`)].some((m) => /Step 300 of the migration/.test(m.textContent ?? '')), pane);
    const n0 = (await A.evaluate(articles)) as number;
    const step = A.locator(`${pane} [data-fold-step]`).first();
    const folded = (await step.count()) > 0;
    let unfold = -1;
    let requests = -1;
    if (folded) {
      await arm(A, 'u27', `return ${articles} > ${n0}`);
      const t1 = Date.now();
      await step.click();
      unfold = await landed(A, 'u27', t1);
      await pause(1500);
      requests = d.traffic.between(t1, Date.now(), [d.aName]).count;
    }
    const n1 = (await A.evaluate(articles)) as number;
    d.add('longThreadOpen', 'ms', opened);
    d.add('longThreadOpenBytes', 'bytes', openBytes);
    if (unfold >= 0) d.add('longThreadUnfold', 'ms', unfold);
    if (requests >= 0) d.add('longThreadUnfoldRequests', 'count', requests);
    await d.toList(A);
    return {
      pass: opened >= 0 && opened <= d.longOpenMs && newest && folded && unfold >= 0 && unfold <= budgetMs && n1 > n0,
      ms: opened,
      detail: { opened, newest, folded, articlesBefore: n0, articlesAfter: n1, unfold, unfoldRequests: requests, openBytes },
    };
  });
}
