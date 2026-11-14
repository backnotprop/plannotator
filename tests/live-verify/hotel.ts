/**
 * The "hotel WiFi" run of the live verifier (LIVE_PROFILE=hotel): one desktop page on a bad link, and three checks.
 *
 * The link: about 400 ms each way with jitter (the latency moves between 250 and 550 ms every 300 ms), 1 Mbit, and
 * 3 % loss. Chromium's throttle has no packet loss for HTTP (its `packetLoss` is WebRTC only), so a lost packet is
 * played as what TCP makes of it: one request in 33 stalls for a retransmit (1.2 to 3 s) before it goes. Then one
 * scripted drop: the link goes down for 6 s in the middle of typing, while an agent writes and another window acts.
 *
 * HW-1 No spinner, busy mark or "Loading…" stays up more than LOADING_DEADLINE_MS once no request is out.
 * HW-2 Words typed in the reply box and in "Other", before, during and after the drop, are all still there, and
 *      reach the server once the link is back.
 * HW-3 After the drop the window matches the server with no reload: the agent's messages are in the open thread,
 *      a row read elsewhere is not bold, a thread archived elsewhere has left the list (or shows archived).
 */
import type { Page, Request, Route } from '@playwright/test';

export const HOTEL = { latency: 400, jitterMs: 150, mbit: 1, loss: 0.03, stallMs: [1200, 3000] as const, dropMs: 6000 };
/** How long a loading mark may stay once nothing is on its way (a frame or two to draw, plus one jittered trip). */
export const LOADING_DEADLINE_MS = 1500;
/** How long the window has to match the server once the link is back. */
const CONVERGE_MS = 20_000;

/** A small seeded generator, so a run's stalls and jitter repeat. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

export interface HotelDeps {
  A: Page;
  base: string;
  log: (s: string) => void;
  check: (id: string, title: string, fn: () => Promise<{ pass: boolean; ms?: number | null; detail?: unknown }>) => Promise<void>;
  add: (name: string, unit: 'ms' | 'count', x: number) => void;
  get: (path: string) => Promise<any>;
  post: (path: string, body: unknown) => Promise<{ status: number; text: string }>;
  agentSend: (threadId: string, body: string) => Promise<unknown>;
  threads: { hotel: string; open: string; read: string; arch: string };
  /** The page's link down or up (its throttle's `offline`). */
  setLink: (p: Page, offline: boolean) => Promise<void>;
  /** The throttle's latency now (jitter). */
  setLatency: (p: Page, ms: number) => Promise<void>;
  openThread: (p: Page, id: string) => Promise<void>;
  paneSel: (id: string) => string;
  rowSel: (id: string) => string;
}

/** Requests held in a loss stall (Playwright reports a routed request only once it goes on): they count as out. */
const stallTimes: { start: number; end: number | null }[] = [];

/** Jitter on the latency, and the stalls loss makes, on page `p`; returns a stop. */
export async function hotelLink(p: Page, deps: Pick<HotelDeps, 'setLatency'>, seed = 7): Promise<() => Promise<void>> {
  const next = rng(seed);
  let on = true;
  const jitter = (async () => {
    while (on) {
      await deps.setLatency(p, Math.round(HOTEL.latency - HOTEL.jitterMs + next() * 2 * HOTEL.jitterMs)).catch(() => {});
      await new Promise((d) => setTimeout(d, 300));
    }
  })();
  const stall = async (route: Route) => {
    if (!route.request().url().includes('/api/inbox/events') && next() < HOTEL.loss) {
      const [lo, hi] = HOTEL.stallMs;
      stallTimes.push({ start: Date.now(), end: null });
      const mine = stallTimes[stallTimes.length - 1]!;
      await new Promise((d) => setTimeout(d, lo + next() * (hi - lo)));
      mine.end = Date.now();
    }
    await route.continue().catch(() => {});
  };
  await p.route('**/api/**', stall);
  return async () => {
    on = false;
    await jitter;
    await p.unroute('**/api/**', stall).catch(() => {});
  };
}

/** Every API request of the page (not the event stream) with when it went and when it ended. */
function trackRequests(p: Page) {
  const out = new Map<Request, { start: number; end: number | null }>();
  const isApi = (r: Request) => r.url().includes('/api/') && !(r.url().includes('/api/inbox/events') && !r.url().includes('once=1'));
  p.on('request', (r) => isApi(r) && out.set(r, { start: Date.now(), end: null }));
  const done = (r: Request) => {
    const x = out.get(r);
    if (x) x.end = Date.now();
  };
  p.on('requestfinished', done);
  p.on('requestfailed', done);
  /** Whether a request was out at `t`, or ended within the deadline before it. */
  return (t: number) => [...out.values(), ...stallTimes].some((x) => x.start <= t && (x.end === null || x.end + LOADING_DEADLINE_MS >= t));
}

/** In the page: each frame, which loading marks are on screen (by what they are), with the time. */
async function watchLoading(p: Page) {
  await p.evaluate(() => {
    const w = window as any;
    w.__hwLoading = [];
    const seen = () => {
      const marks: string[] = [];
      const visible = (e: Element) => (e as HTMLElement).getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
      for (const e of document.querySelectorAll('.ib-spin, [aria-busy="true"]')) if (visible(e)) marks.push(e.className || e.tagName);
      for (const e of document.querySelectorAll('body *')) {
        if (e.children.length === 0 && /^Loading…$/.test(e.textContent?.trim() ?? '') && visible(e)) marks.push('Loading…');
      }
      return marks;
    };
    const tick = () => {
      const marks = seen();
      if (marks.length) w.__hwLoading.push({ t: Date.now(), marks });
      if (!w.__hwStop) requestAnimationFrame(tick);
    };
    tick();
  });
}

export async function runHotel(d: HotelDeps): Promise<void> {
  const { A, log, check, get, post, threads: T } = d;
  const outAt = trackRequests(A);
  const t0 = Date.now();
  const moments: Record<string, number> = {};
  const mark = (name: string) => (moments[name] = Date.now() - t0);
  await watchLoading(A);
  await A.evaluate(() => ((window as any).__hwNoReload = 1));
  const stop = await hotelLink(A, d);
  try {
    // A thread opened on the bad link (its wait shows), and back to the list and in again.
    await d.openThread(A, T.open);
    mark('openedFirst');
    await d.openThread(A, T.hotel);
    mark('openedHotel');
    await A.waitForTimeout(1500);
    const pane = d.paneSel(T.hotel);
    const other = `${pane} input[aria-label^="Other answer"]`;
    const reply = A.getByRole('textbox', { name: /^Reply to/ });
    const edit = A.locator('.ib-pfoot').getByRole('button', { name: /^(Reply|Edit draft)$/ });
    if (await edit.count()) await edit.first().click();
    await reply.waitFor({ timeout: 30_000 });
    const words = ['before the drop,', ' typed while the link is down,', ' and after it came back'];
    const others = ['other words', ' kept offline', ' and online'];
    await reply.pressSequentially(words[0]!, { delay: 40 });
    const hasOther = (await A.$(other)) !== null;
    if (hasOther) {
      await A.click(other);
      await A.keyboard.type(others[0]!, { delay: 40 });
    }
    const server = (id: string) => get(`/threads/${encodeURIComponent(id)}`);
    const firstId = async (id: string) => (await server(id)).thread.messages[0].id as string;
    const archRoot = await firstId(T.arch);
    // ---- The drop, mid-typing: the agent writes twice, another window marks a row read and archives one. ----
    log('hotel: link down');
    const droppedAt = Date.now();
    mark('down');
    await d.setLink(A, true);
    await d.agentSend(T.hotel, 'Written while your link was down (one).');
    await reply.click();
    await A.keyboard.type(words[1]!, { delay: 40 });
    await d.agentSend(T.hotel, 'Written while your link was down (two).');
    await post(`/threads/${T.read}/read`, {});
    await post(`/messages/${archRoot}/resolve`, { resolved: true });
    if (hasOther) {
      await A.click(other);
      await A.keyboard.type(others[1]!, { delay: 40 });
    }
    await A.waitForTimeout(Math.max(0, HOTEL.dropMs - (Date.now() - droppedAt)));
    await d.setLink(A, false);
    const back = Date.now();
    mark('up');
    log('hotel: link back');
    if (hasOther) await A.keyboard.type(others[2]!, { delay: 40 });
    await reply.click();
    await A.keyboard.type(words[2]!, { delay: 40 });
    const wantReply = words.join('');
    const wantOther = others.join('');

    // ---- HW-3 and HW-2, watched together from the moment the link is back. ----
    const serverCount = (await server(T.hotel)).thread.messages.length as number;
    let converged = -1;
    let reached = -1;
    let last: unknown = null;
    let seen: unknown = null;
    for (const end = back + CONVERGE_MS; Date.now() < end && (converged < 0 || reached < 0); ) {
      if (converged < 0) {
        const shown = await A.evaluate(
          ({ pane, row, arch }) => ({
            messages: document.querySelectorAll(`${pane} [data-message-article]`).length,
            readBold: document.querySelector(row)?.classList.contains('ib-u') ?? null,
            archGone: !document.querySelector(arch) || document.querySelector(arch)!.hasAttribute('data-archived'),
            noReload: (window as any).__hwNoReload === 1,
          }),
          { pane, row: d.rowSel(T.read), arch: d.rowSel(T.arch) },
        );
        last = shown;
        if (shown.messages >= serverCount && shown.readBold !== true && shown.archGone && shown.noReload) converged = Date.now() - back;
      }
      if (reached < 0) {
        const draft = (await get(`/threads/${encodeURIComponent(T.hotel)}/draft`).catch(() => null))?.draft?.body ?? null;
        const q = hasOther ? (((await server(T.hotel)).thread.messages[0].questions ?? []).find((x: any) => x.answer?.other !== undefined)?.answer?.other ?? null) : wantOther;
        seen = { draft, other: q };
        if (draft === wantReply && q === wantOther) reached = Date.now() - back;
      }
      await A.waitForTimeout(100);
    }
    d.add('hotelConvergeAfterDrop', 'ms', converged);
    await check('HW-3', 'Hotel WiFi: after a 6 s drop the window matches the server with no reload (messages, a read row, an archived row)', async () => ({
      pass: converged >= 0,
      ms: converged,
      detail: { serverCount, shown: last },
    }));
    const onScreen = { reply: await reply.inputValue(), other: hasOther ? await A.inputValue(other) : wantOther };
    d.add('hotelWordsOnServerAfterDrop', 'ms', reached);
    await check('HW-2', 'Hotel WiFi: words typed in the reply box and in "Other" across a drop are never lost (screen and server)', async () => ({
      pass: onScreen.reply === wantReply && onScreen.other === wantOther && reached >= 0,
      ms: reached,
      detail: { hasOther, onScreen, server: seen },
    }));

    // ---- HW-1: no loading mark outlives what it waits for. ----
    await A.evaluate(() => ((window as any).__hwStop = 1));
    const frames: { t: number; marks: string[] }[] = await A.evaluate(() => (window as any).__hwLoading);
    const stuck = frames.filter((f) => !outAt(f.t));
    const longest = (() => {
      let run = 0;
      let best = 0;
      let prev = -1;
      for (const f of stuck) {
        run = prev >= 0 && f.t - prev < 100 ? run + (f.t - prev) : 0;
        best = Math.max(best, run);
        prev = f.t;
      }
      return best;
    })();
    d.add('hotelLoadingFrames', 'count', frames.length);
    await check('HW-1', `Hotel WiFi: no spinner or "Loading…" stays up more than ${LOADING_DEADLINE_MS} ms after its request ended`, async () => ({
      pass: stuck.length === 0,
      ms: longest,
      detail: { framesWithMarks: frames.length, framesWithNothingOut: stuck.length, marks: [...new Set(stuck.flatMap((f) => f.marks))].slice(0, 8), stuckAt: stuck.slice(0, 3).map((f) => f.t - t0), moments },
    }));
  } finally {
    await stop();
  }
}
