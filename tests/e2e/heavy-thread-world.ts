import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SimAgent } from '../../scripts/inbox-sim';
import { png } from './phone-touch';
import type { RawPage } from './raw-cdp';

export const MESSAGES = 120;
export const ARRIVALS = 30;
export const SHOTS = 30;
export const GALLERY = 6;
export const SHOT_WIDTH = 2880;
export const SHOT_HEIGHT = 1800;

const MB = 1024 * 1024;
const round1 = (n: number) => Math.round(n * 10) / 10;
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

const THREAD = 'checkout-redesign';

export async function arriveInHeavyThread(agent: SimAgent, project: string, i: number): Promise<void> {
  await agent.send({ project_path: project, thread: THREAD, body: `Step ${MESSAGES + i + 1}: one more change to the checkout page.\n\n- the totals\n- the button` });
}

export async function seedHeavyThread(binary: string, env: Record<string, string>, project: string): Promise<string> {
  mkdirSync(join(project, 'shots'), { recursive: true });
  const shots: string[] = [];
  for (let i = 0; i < SHOTS; i++) {
    const name = `shots/screen-${String(i + 1).padStart(2, '0')}.png`;
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
  openedDrawn: number;
  openedOpen: number;
  messages: number;
  open: number;
  heapMB: number;
  nodes: number;
  listeners: number;
  images: number;
  loaded: number;
  widestInline: number;
  widestGallery: number;
  widestTile: number;
  decodedMB: number;
  arrivalsBeforeMB: number;
  arrivalsAfterMB: number;
  messageCopies: number;
  renderCopies: number;
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

export async function measureHeavyThread(page: RawPage, url: string, threadId: string, arrive: (i: number) => Promise<void>): Promise<HeavyThreadMeasure> {
  await page.goto(`${url.replace(/\/+$/, '')}/`);
  if (!(await page.waitFor(`document.querySelector('.ib-lbody [data-thread-id]')`, 60_000))) throw new Error('the list never drew');
  await openThread(page, threadId);
  const newestOpen = `(() => { const a = [...document.querySelectorAll('[data-message-article]')]; return a.length > 0 && !a[a.length - 1].hasAttribute('data-folded'); })()`;
  if (!(await page.waitFor(newestOpen, 60_000))) throw new Error('the thread never drew');
  await pause(1_000);
  const opened = await page.evaluate<Record<string, number>>(STATS);
  await page.evaluate(`document.querySelector('[data-expand-all]').click()`);
  if (!(await page.waitFor(`document.querySelectorAll('[data-message-article]:not([data-folded])').length === ${MESSAGES}`, 60_000))) throw new Error('Expand all never opened the thread');
  await pause(2_000);
  await scrollPane(page, 'bottom');
  await pause(1_000);
  await scrollPane(page, 'top');
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
