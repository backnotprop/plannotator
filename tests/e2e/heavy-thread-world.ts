/**
 * A heavy synthetic thread, and what the window holds once it is open, for
 * inbox-heavy-thread-budget.spec.ts (#2948). Kept apart from the spec so the
 * budgets can be measured by hand on any binary with the same steps
 * (`measureHeavyThread` takes a raw CDP page and a running Inbox).
 *
 * The thread: MESSAGES agent messages in one thread, all unread. It opens on
 * its newest 20 (approval "inbox-thread-fold-unread"), and the measure then
 * presses Expand all, so every message is open. Every MESSAGES / SHOTS-th message shows a
 * full-size screenshot inline (SHOT_WIDTH × SHOT_HEIGHT, a Retina laptop's
 * screen), and the last message attaches GALLERY of them as files (the
 * gallery and the tiles). Synthetic only: the PNGs are drawn here.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SimAgent } from '../../scripts/inbox-sim';
import { png } from './phone-touch';
import type { RawPage } from './raw-cdp';

export const MESSAGES = 120;
/** Messages the agent sends into the thread while it is open (the window left open while the agent works). */
export const ARRIVALS = 30;
export const SHOTS = 30;
export const GALLERY = 6;
export const SHOT_WIDTH = 2880;
export const SHOT_HEIGHT = 1800;

const MB = 1024 * 1024;
const round1 = (n: number) => Math.round(n * 10) / 10;
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

const THREAD = 'checkout-redesign';

/** One more message from the agent into the thread, as it works (`arrive` for measureHeavyThread). */
export async function arriveInHeavyThread(agent: SimAgent, project: string, i: number): Promise<void> {
  await agent.send({ project_path: project, thread: THREAD, body: `Step ${MESSAGES + i + 1}: one more change to the checkout page.\n\n- the totals\n- the button` });
}

/** Writes the screenshots into `project`/shots and sends the thread as one agent. Returns the thread id. */
export async function seedHeavyThread(binary: string, env: Record<string, string>, project: string): Promise<string> {
  mkdirSync(join(project, 'shots'), { recursive: true });
  const shots: string[] = [];
  for (let i = 0; i < SHOTS; i++) {
    const name = `shots/screen-${String(i + 1).padStart(2, '0')}.png`;
    // A different colour each: the bytes differ, so nothing is shared between two screenshots.
    writeFileSync(join(project, name), png(SHOT_WIDTH, SHOT_HEIGHT, [40 + ((i * 53) % 200), 90 + ((i * 29) % 160), 220 - ((i * 17) % 180)]));
    shots.push(name);
  }
  const agent = await SimAgent.connect({ binary, env, name: 'Claude Code', host: 'claude-code' });
  try {
    const every = MESSAGES / SHOTS;
    let threadId = '';
    for (let i = 0; i < MESSAGES; i++) {
      const shot = i % every === 0 ? shots[i / every] : undefined;
      const last = i === MESSAGES - 1;
      const body = [
        `Step ${i + 1}: the checkout page, a little further on.`,
        '',
        'I changed the summary card and the totals. The tax line now waits for the address, and the button says what it costs.',
        ...(shot ? ['', `![Checkout after step ${i + 1}](${shot})`] : []),
      ].join('\n');
      const sent = await agent.send({
        project_path: project,
        subject: i === 0 ? 'Checkout redesign, step by step' : undefined,
        thread: THREAD,
        body,
        attachments: last ? shots.slice(0, GALLERY) : undefined,
      });
      threadId ||= sent.thread_id;
    }
    return threadId;
  } finally {
    await agent.close();
  }
}

export interface HeavyThreadMeasure {
  /** Articles drawn when the unread thread opened, and open ones: its first message's line and its newest 20. */
  openedDrawn: number;
  openedOpen: number;
  /** Articles drawn, and open ones, after Expand all. */
  messages: number;
  open: number;
  /** After two forced collections. */
  heapMB: number;
  nodes: number;
  listeners: number;
  /** Pictures in the thread pane, and how many have loaded. */
  images: number;
  loaded: number;
  /** The widest picture each place loaded (its natural width: what the browser decodes). */
  widestInline: number;
  widestGallery: number;
  widestTile: number;
  /** What the loaded pictures take decoded (natural width × height × 4 bytes). */
  decodedMB: number;
  /** The JS heap with the thread open, before and after ARRIVALS more messages came into it. */
  arrivalsBeforeMB: number;
  arrivalsAfterMB: number;
  /**
   * Message records alive after the arrivals (every message carries the thread's name, so this counts the strings
   * equal to it in a heap snapshot): MESSAGES + ARRIVALS when each read shares what did not change, many times that
   * when every read's copy stays alive.
   */
  messageCopies: number;
  /**
   * The strings equal to the first message's time on its head line ("7:22 PM"), drawn anew on every render: many
   * more than the messages when each render of the thread view stays alive, held by a callback a message kept.
   */
  renderCopies: number;
  /** The JS heap after the thread was closed: the first time, and after opening and closing it twice more. */
  closedHeapMB: number;
  reclosedHeapMB: number;
}

const STATS = `(() => {
  const pane = document.querySelector('.ib-pbody');
  const imgs = pane ? [...pane.querySelectorAll('img')] : [];
  const loaded = imgs.filter((i) => i.complete && i.naturalWidth > 0);
  const widest = (sel) => Math.max(0, ...loaded.filter((i) => i.matches(sel)).map((i) => i.naturalWidth));
  return {
    messages: document.querySelectorAll('[data-message-article]').length,
    open: document.querySelectorAll('[data-message-article]:not([data-folded])').length,
    images: imgs.length,
    loaded: loaded.length,
    widestInline: widest('.ib-body img'),
    widestGallery: widest('[data-image-gallery] img'),
    widestTile: widest('.ib-thumb img'),
    decodedBytes: loaded.reduce((n, i) => n + i.naturalWidth * i.naturalHeight * 4, 0),
  };
})()`;

/** Scrolls the thread pane 700 px a step to the bottom or the top, so every lazy picture loads. */
async function scrollPane(page: RawPage, to: 'top' | 'bottom'): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const done = await page.evaluate<boolean>(`(() => {
      const el = document.querySelector('.ib-pbody');
      if (!el) return true;
      if (${JSON.stringify(to)} === 'top') { if (el.scrollTop <= 0) return true; el.scrollTop = Math.max(0, el.scrollTop - 700); }
      else { if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) return true; el.scrollTop += 700; }
      return false;
    })()`);
    if (done) return;
    await pause(60);
  }
}

/** How many string values in a heap snapshot are exactly `value`. */
function countStrings(snapshot: string, value: string): number {
  const snap = JSON.parse(snapshot) as { snapshot: { meta: { node_fields: string[]; node_types: unknown[] } }; nodes: number[]; strings: string[] };
  const fields = snap.snapshot.meta.node_fields;
  const stride = fields.length;
  const typeAt = fields.indexOf('type');
  const nameAt = fields.indexOf('name');
  const stringType = (snap.snapshot.meta.node_types[typeAt] as string[]).indexOf('string');
  let count = 0;
  for (let i = 0; i < snap.nodes.length; i += stride) {
    if (snap.nodes[i + typeAt] === stringType && snap.strings[snap.nodes[i + nameAt]!] === value) count++;
  }
  return count;
}

const openThread = (page: RawPage, threadId: string) => page.evaluate(`void (window.location.hash = ${JSON.stringify(`thread=${threadId}`)})`);
const closeThread = (page: RawPage) => page.evaluate(`void (window.location.hash = '')`);

/**
 * Opens the window on `url`, opens the thread, scrolls through it (every picture loads) and back, and measures. Then
 * `arrive` sends ARRIVALS messages into it while it stays open, and the heap is read before and after. Then it is
 * closed, opened and closed twice more, and the heap is read each time it is closed.
 */
export async function measureHeavyThread(page: RawPage, url: string, threadId: string, arrive: (i: number) => Promise<void>): Promise<HeavyThreadMeasure> {
  await page.goto(`${url.replace(/\/+$/, '')}/`);
  if (!(await page.waitFor(`document.querySelector('.ib-lbody [data-thread-id]')`, 60_000))) throw new Error('the list never drew');
  await openThread(page, threadId);
  const newestOpen = `(() => { const a = [...document.querySelectorAll('[data-message-article]')]; return a.length > 0 && !a[a.length - 1].hasAttribute('data-folded'); })()`;
  if (!(await page.waitFor(newestOpen, 60_000))) throw new Error('the thread never drew');
  await pause(1_000);
  const opened = await page.evaluate<Record<string, number>>(STATS);
  // Every message open, as a person who presses Expand all has it: the most the thread can hold.
  await page.evaluate(`document.querySelector('[data-expand-all]').click()`);
  if (!(await page.waitFor(`document.querySelectorAll('[data-message-article]:not([data-folded])').length === ${MESSAGES}`, 60_000))) throw new Error('Expand all never opened the thread');
  await pause(2_000);
  await scrollPane(page, 'bottom');
  await pause(1_000);
  await scrollPane(page, 'top');
  // Every picture the scroll reached has finished loading (or failed): a slow runner is not a smaller number.
  await page.waitFor(`[...document.querySelectorAll('.ib-pbody img')].every((i) => i.complete)`, 60_000);
  await pause(1_000);
  const heap = await page.heapAfterGc();
  const stats = await page.evaluate<Record<string, number>>(STATS);
  const arrivalsBeforeMB = round1(heap.jsHeapUsed / MB);
  for (let i = 0; i < ARRIVALS; i++) {
    await arrive(i);
    await pause(150);
  }
  const last = `Step ${MESSAGES + ARRIVALS}:`;
  if (!(await page.waitFor(`[...document.querySelectorAll('.ib-body')].some((b) => b.textContent.includes(${JSON.stringify(last)}))`, 60_000))) throw new Error('the messages that came in were never drawn');
  await pause(1_500);
  const arrivalsAfterMB = round1((await page.heapAfterGc()).jsHeapUsed / MB);
  const when = await page.evaluate<string>(`document.querySelector('[data-message-article] [data-full-when]')?.textContent ?? ''`);
  if (!when) throw new Error('no time on the first message');
  const snapshot = await page.heapSnapshot();
  const messageCopies = countStrings(snapshot, THREAD);
  const renderCopies = countStrings(snapshot, when);
  const closed = async () => {
    await closeThread(page);
    if (!(await page.waitFor(`!document.querySelector('[data-message-article]')`, 30_000))) throw new Error('the thread never closed');
    await pause(1_500);
    return round1((await page.heapAfterGc()).jsHeapUsed / MB);
  };
  const closedHeapMB = await closed();
  for (let i = 0; i < 2; i++) {
    await openThread(page, threadId);
    // Read once, the thread now folds its older messages: any message drawn is the thread back.
    if (!(await page.waitFor(`document.querySelector('[data-message-article]')`, 60_000))) throw new Error('the thread never drew again');
    await pause(1_500);
    await scrollPane(page, 'bottom');
    await scrollPane(page, 'top');
    if (i === 0) await closed();
  }
  const reclosedHeapMB = await closed();
  return {
    openedDrawn: opened.messages!,
    openedOpen: opened.open!,
    messages: stats.messages!,
    open: stats.open!,
    heapMB: round1(heap.jsHeapUsed / MB),
    nodes: heap.nodes,
    listeners: heap.listeners,
    images: stats.images!,
    loaded: stats.loaded!,
    widestInline: stats.widestInline!,
    widestGallery: stats.widestGallery!,
    widestTile: stats.widestTile!,
    decodedMB: round1(stats.decodedBytes! / MB),
    arrivalsBeforeMB,
    arrivalsAfterMB,
    messageCopies,
    renderCopies,
    closedHeapMB,
    reclosedHeapMB,
  };
}
