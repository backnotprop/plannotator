/**
 * The onboarding tour in the window (approval "inbox-onboarding-tour"): the
 * whole window over a REAL Inbox in a temp data dir, one per test (its own
 * process, tests/helpers/inbox-dom-server.ts `first-run-tour`: no project yet, so
 * the window opens on the entry screen). The tour's fixture is the real one,
 * served by the real fixture route.
 *
 * - Two paths: the entry screen's two cards; Connect my agents opens the
 *   real first-run screen and is remembered (`tour.skipped_at`).
 * - The walk: open, pick a picture, Send (a replay that writes nothing to the
 *   person's store and calls no route that writes but the `tour` setting),
 *   the replay's messages, the mock, step 6, Finish.
 * - Exit at any step: back to the person's Inbox, the entry screen gone, a
 *   quiet "Take the tour" link.
 * - A real message mid-tour: a chip, no interruption.
 * - A pick other than the real answer: the honest note.
 * - Returning users: Settings → General → Take the tour.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const hasDom = typeof document !== 'undefined';
const { InboxApp } = (hasDom ? await import('./App') : {}) as typeof import('./App');
const { __forgetTourFixtureForTests } = (hasDom ? await import('./tour/Tour') : {}) as typeof import('./tour/Tour');
const { __forgetTourAssetsForTests } = await import('./tour/assets');
const { setStorageBackend, resetStorageBackend } = await import('@plannotator/ui/utils/storage');

const SERVER_SCRIPT = resolve(import.meta.dir, '../../tests/helpers/inbox-dom-server.ts');

let child: ReturnType<typeof Bun.spawn> | null = null;
let childOut: ReadableStreamDefaultReader<Uint8Array> | null = null;
let port = 0;
let dir: string | null = null;
let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedEventSource: unknown;
let savedMatchMedia: typeof window.matchMedia;
let pushRecord: ((data: unknown) => void) | null = null;
let tailnetPage = false;
let savedNotification: unknown;
let savedHasFocus: typeof document.hasFocus;
/** The browser's answer for this origin, and every notification raised (its title). */
let permission: NotificationPermission = 'default';
const notices: string[] = [];
const posts: { path: string; body: Record<string, unknown> }[] = [];
/** A test's own answer for a request (a failure, a stopped server: 'network'); null lets it reach the Inbox. */
let intercept: ((path: string, method: string, body?: string) => Response | 'network' | null) | null = null;

function loopback(path: string, method = 'GET', body?: string): Promise<{ status: number; text: string; type: string }> {
  return new Promise((done, fail) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { 'Content-Type': 'application/json', Host: `127.0.0.1:${port}` } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => done({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8'), type: String(res.headers['content-type'] ?? 'application/json') }));
    });
    req.on('error', fail);
    if (body) req.write(body);
    req.end();
  });
}

async function readLine(): Promise<string> {
  let line = '';
  while (!line.includes('\n')) {
    const { value, done } = await childOut!.read();
    if (done) throw new Error('the Inbox stopped');
    line += new TextDecoder().decode(value);
  }
  return line.trim();
}

beforeEach(async () => {
  if (!hasDom) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plannotator-inbox-tour-dom-')));
  child = Bun.spawn(['bun', SERVER_SCRIPT, join(dir, 'data'), join(dir, 'projects'), '1', 'first-run-tour'], {
    env: { ...process.env, DOM_TESTS: '0', PLANNOTATOR_DATA_DIR: join(dir, 'data'), HOME: dir },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
  });
  childOut = (child.stdout as ReadableStream<Uint8Array>).getReader();
  port = (JSON.parse(await readLine()) as { port: number }).port;
  posts.length = 0;
  intercept = null;
  // Cookies, kept in memory per test (happy-dom's about:blank keeps none): the browser's memory of a tour
  // decision that could not be saved is never carried between tests.
  const jar = new Map<string, string>();
  // Each test loads the tour's content itself (a page loads it once).
  if (hasDom) {
    __forgetTourFixtureForTests();
    __forgetTourAssetsForTests();
  }
  setStorageBackend({ getItem: (k) => jar.get(k) ?? null, setItem: (k, v) => void jar.set(k, v), removeItem: (k) => void jar.delete(k) });
  tailnetPage = false;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    let body = init?.body ? String(init.body) : undefined;
    if (body?.startsWith('{')) {
      const { serverSession: _session, ...rest } = JSON.parse(body) as Record<string, unknown>;
      body = JSON.stringify(rest);
    }
    if (method === 'POST') posts.push({ path, body: body ? (JSON.parse(body) as Record<string, unknown>) : {} });
    const forced = intercept?.(path, method, body);
    if (forced === 'network') throw new TypeError('Failed to fetch');
    if (forced) return forced;
    if (path.startsWith('/api/inbox/agents') && tailnetPage) return Response.json({ error: 'local only', code: 'local_only' }, { status: 403 });
    const answer = await loopback(path, method, body);
    if (method === 'GET' && path.startsWith('/api/inbox/settings') && answer.status === 200 && tailnetPage) {
      return Response.json({ ...(JSON.parse(answer.text) as Record<string, unknown>), via: 'tailnet' });
    }
    return new Response(answer.text, { status: answer.status, headers: { 'Content-Type': answer.type } });
  }) as typeof fetch;
  savedEventSource = (globalThis as Record<string, unknown>).EventSource;
  (globalThis as Record<string, unknown>).EventSource = class {
    addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
      if (type === 'record') pushRecord = (data) => listener({ data: JSON.stringify(data), lastEventId: '999' } as MessageEvent<string>);
    }
    close() {}
  };
  // Reduced motion: the replay runs in under 4 s.
  savedMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => {
    const real = savedMatchMedia.call(window, query);
    if (!query.includes('prefers-reduced-motion')) return real;
    return { ...real, matches: query.includes('reduce'), media: query, addEventListener() {}, removeEventListener() {} } as MediaQueryList;
  }) as typeof window.matchMedia;
  savedNotification = (window as unknown as Record<string, unknown>).Notification;
  permission = 'default';
  notices.length = 0;
  (window as unknown as Record<string, unknown>).Notification = class {
    static get permission() {
      return permission;
    }
    static async requestPermission() {
      return permission;
    }
    onclick: unknown = null;
    constructor(title: string) {
      notices.push(title);
    }
    close() {}
  };
  // The page is in front (visible, focused) unless a test says otherwise.
  savedHasFocus = document.hasFocus.bind(document);
  document.hasFocus = () => true;
  window.location.hash = '';
});

afterEach(async () => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  pushRecord = null;
  globalThis.fetch = savedFetch;
  (globalThis as Record<string, unknown>).EventSource = savedEventSource;
  window.matchMedia = savedMatchMedia;
  // happy-dom has no Notification: put back "none", not a property set to undefined, which
  // `'Notification' in window` reads as support (a read still in flight after the unmount
  // then reached Notification.permission: an unhandled error between tests on Bun 1.4.4).
  if (savedNotification === undefined) delete (window as unknown as Record<string, unknown>).Notification;
  else (window as unknown as Record<string, unknown>).Notification = savedNotification;
  document.hasFocus = savedHasFocus;
  resetStorageBackend();
  window.location.hash = '';
  childOut?.releaseLock();
  child?.kill();
  await child?.exited;
  child = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

async function wait(ms: number) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

async function until(check: () => boolean, what: string, tries = 200) {
  for (let i = 0; i < tries; i++) {
    if (check()) return;
    await wait(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function renderApp(): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<InboxApp />);
  });
  return host;
}

async function click(el: Element | null | undefined) {
  expect(el).toBeTruthy();
  await act(async () => (el as HTMLElement).click());
}

const $ = (el: ParentNode, s: string) => el.querySelector<HTMLElement>(s);
const radios = (el: ParentNode) => el.querySelectorAll<HTMLInputElement>('[data-tour-message="ask"] input[type="radio"]');
/** The warm-up's plain choices (step 2, crawl). */
const warmRadios = (el: ParentNode) => el.querySelectorAll<HTMLInputElement>('[data-tour-message="warm"] input[type="radio"]');
const coachKey = (el: ParentNode) => $(el, '[data-tour-coach]')?.getAttribute('data-tour-coach') ?? null;
const config = () => JSON.parse(readFileSync(join(dir!, 'data', 'config.json'), 'utf8')) as Record<string, any>;
/** What the tour may write: the `tour` setting, and nothing else (no picks, reply, annotation or MCP route). */
const writes = () => posts.filter((p) => !(p.path === '/api/inbox/settings' && Object.keys(p.body).every((k) => k === 'tour')) && p.path !== '/api/inbox/window');

/** An agent's first message, written to the real store: its folder becomes the Inbox's first project. */
async function firstMessage(body: string, subject: string): Promise<string> {
  (child!.stdin as import('bun').FileSink).write(`${JSON.stringify({ first: { root: join(dir!, 'projects', 'billing'), session: 'ses_first', body, subject } })}\n`);
  (child!.stdin as import('bun').FileSink).flush();
  return (JSON.parse(await readLine()) as { sent: string }).sent;
}

/** What the event stream would say about that message's first line. */
function recordOf(id: string) {
  return { seq: 1, kind: 'message', id, first: true, message: { id, thread_id: id, project_id: 'p', reply_to: null, subject: null, body: '', created_at: new Date().toISOString(), resolved_at: null, idempotency_key: null, author: { kind: 'agent', host: 'claude-code', session: 'ses_first', name: null } } };
}

/** A tour started from a screen opens on its first card ("a fresh reminder"); Show me, then "How it's organised", then step 1. */
async function pastIntro(el: HTMLElement) {
  await until(() => $(el, '[data-tour-intro-go]') !== null, 'the tour’s first card');
  await until(() => document.activeElement === $(el, '[data-tour-intro] h2'), 'focus on the first card');
  expect($(el, '[data-tour-intro] h2')!.textContent).toBe('The Inbox works beside your agents');
  expect($(el, '[data-tour-exit]')).not.toBeNull();
  await click($(el, '[data-tour-intro-go]'));
  // How it's organised: a picture of the tour's own list and thread, then Next.
  await until(() => coachKey(el) === '1-orient', 'how it is organised');
  expect($(el, '[data-tour-orient]')!.textContent).toContain('EVALUATION.md');
  await click($(el, '[data-tour-next]'));
  await until(() => coachKey(el) === '1', 'step 1');
}

async function openOnEntry(): Promise<HTMLElement> {
  const el = await renderApp();
  await until(() => $(el, '[data-tour-entry]') !== null, 'the entry screen');
  return el;
}

const PHRASE = 'a 2-day check that hover feels instant';
const EV_LINE = 'It is also the cheapest direction, because the reader and its hooks already exist.';

/** Select `phrase` inside `scope` the way a drag does, and let the viewer hear the pointer go up. */
async function select(scope: HTMLElement, phrase: string) {
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let all = '';
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push(n as Text);
    all += (n as Text).data;
  }
  const at = all.indexOf(phrase);
  if (at < 0) throw new Error(`"${phrase}" is not there`);
  const range = document.createRange();
  let off = 0;
  for (const node of nodes) {
    const end = off + node.data.length;
    if (at >= off && at < end) range.setStart(node, at - off);
    if (at + phrase.length > off && at + phrase.length <= end) {
      range.setEnd(node, at + phrase.length - off);
      break;
    }
    off = end;
  }
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  const target = (range.startContainer.parentElement!.closest('article') as HTMLElement | null) ?? range.startContainer.parentElement!;
  await act(async () => {
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
  });
  await wait(100);
}

const popoverBox = () => document.querySelector<HTMLTextAreaElement>('[data-comment-popover] textarea');

/** Select words, press the toolbar's Comment, keep the suggestion the box opens with, Save. Returns the suggestion. */
async function commentOn(scope: HTMLElement, phrase: string): Promise<string> {
  await select(scope, phrase);
  await until(() => document.querySelector('.annotation-toolbar button[aria-label="Comment"], [data-pn-annotation-toolbar-row] button[aria-label="Comment"]') !== null, 'the selection toolbar');
  await click(document.querySelector('.annotation-toolbar button[aria-label="Comment"], [data-pn-annotation-toolbar-row] button[aria-label="Comment"]'));
  await until(() => popoverBox() !== null, 'the composer');
  const suggested = popoverBox()!.value;
  const save = [...document.querySelectorAll<HTMLButtonElement>('[data-comment-popover] button')].find((x) => x.textContent?.trim() === 'Save');
  await click(save);
  return suggested;
}

/** Start the tour (the entry screen's button, else the first-run screen's quiet link) and walk to `step`, keeping every suggestion. */
async function walkTo(el: HTMLElement, step: number, record: { suggestions?: string[] } = {}) {
  const keep = (text: string) => record.suggestions?.push(text);
  await click($(el, '[data-tour-start]') ?? $(el, '[data-tour-again] button'));
  await pastIntro(el);
  if (step === 1) return;
  await click($(el, '[data-thread-id="tour-vscode"]'));
  // Crawl: a plain question first, the card saying it is the person's turn.
  await until(() => coachKey(el) === '2' && warmRadios(el).length === 2, 'step 2 and its plain choices');
  expect($(el, '[data-tour-coach] [data-tour-your-turn]')).not.toBeNull();
  expect(radios(el).length).toBe(0);
  if (step === 2) return;
  await click(warmRadios(el)[0]);
  await until(() => coachKey(el) === '2-send', 'Send it back');
  await click($(el, '[data-tour-warm-send]'));
  // happy-dom loads no picture, so the card draws its text rows (the e2e spec proves the tiles).
  await until(() => coachKey(el) === '3' && radios(el).length === 4, 'step 3 and its choices', 160);
  if (step === 3) return;
  await click(radios(el)[0]);
  await until(() => coachKey(el) === '4', 'step 4');
  if (step === 4) return;
  keep(await commentOn($(el, '[data-tour-message="ask"] .ib-body')!, PHRASE));
  await until(() => coachKey(el) === '5', 'step 5');
  if (step === 5) return;
  await click($(el, '[data-tour-thread] .ib-attachments:not(.ib-hatts-tiles) [data-attachment-name="EVALUATION.md"]'));
  await until(() => coachKey(el) === '5-file' && (el.querySelector('[data-attachment-pane] .ib-docscroll')?.textContent ?? '').includes(EV_LINE), 'EVALUATION.md open');
  keep(await commentOn($(el, '[data-attachment-pane] .ib-docscroll')!, EV_LINE));
  await until(() => coachKey(el) === '6', 'step 6');
  if (step === 6) return;
  await click($(el, '[data-tour-reply]'));
  await until(() => coachKey(el) === '6-box', 'the recap');
  await click($(el, '[data-tour-send]'));
  await until(() => coachKey(el) === '7', 'the replay', 160);
  if (step === 7) return;
  await click($(el, '[data-tour-thread] img[data-inline-image="tour-img-built-a1"]') ?? [...el.querySelectorAll<HTMLImageElement>('[data-tour-arrival="2"] img')][0]);
  await until(() => coachKey(el) === '7-file' && $(el, '[data-image-composer] textarea') !== null, 'a1.png open');
  keep(($(el, '[data-image-composer] textarea') as HTMLTextAreaElement).value);
  await click($(el, '[data-image-comment-save]'));
  await until(() => coachKey(el) === '7-drawn', 'the screenshot’s comment');
  await click($(el, '[data-tour-next]'));
  await until(() => coachKey(el) === '7-art', 'Artifacts');
  await click($(el, '[data-tour-thread] [data-artifacts-button]'));
  await until(() => coachKey(el) === '7-art-grid', 'the grid');
  expect(el.querySelectorAll('[data-artifacts-view] [data-artifact-kind]').length).toBe(5);
  await click($(el, '[data-artifacts-view] [data-artifact-kind="markdown"]'));
  await until(() => coachKey(el) === '7-art-open', 'a tile open');
  await click($(el, '[data-tour-next]'));
  await until(() => coachKey(el) === '8-open', 'step 8');
  if (step === 8) return;
  await click($(el, '[data-thread-id="tour-film"]'));
  await until(() => coachKey(el) === '8', 'the film thread');
  await click($(el, '[data-tour-thread] .ib-attachments:not(.ib-hatts-tiles) [data-attachment-name="guides-vscode.mp4"]'));
  await until(() => $(el, '[data-video-player]') !== null, 'the film');
  // A pause near the chapter text: the box fills with the suggestion and the moment pins.
  await act(async () => {
    $(el, '[data-video-player]')!.dispatchEvent(new Event('pause', { bubbles: false }));
  });
  await until(() => coachKey(el) === '8-pinned', 'the moment pinned');
  keep(($(el, '[data-video-composer] textarea') as HTMLTextAreaElement).value);
  await click($(el, '[data-video-comment-save]'));
  await until(() => coachKey(el) === '8-send', 'Send it back');
  await click($(el, '[data-tour-film-send]'));
  await until(() => coachKey(el) === '8-done', 'the film’s answer', 160);
  await click($(el, '[data-tour-next]'));
  await until(() => coachKey(el) === '9', 'step 9');
  if (step === 9) return;
  await click([...el.querySelectorAll<HTMLElement>('[data-open-compose]')][0]);
  await until(() => coachKey(document) === '9-open' && document.querySelector('[data-compose] [data-compose-to]') !== null, 'compose');
  keep((document.querySelector('[data-compose] textarea') as HTMLTextAreaElement).value);
  await click(document.querySelector('[data-compose] [data-compose-to]'));
  await until(() => document.querySelector('[data-compose] [role="option"]') !== null, 'the picker');
  await click(document.querySelector('[data-compose] [role="option"]'));
  await until(() => coachKey(document) === '9-to', 'To chosen');
  await click(document.querySelector('[data-compose] [data-compose-send]'));
  await until(() => coachKey(el) === '9-loop', 'the loop', 160);
  await click($(el, '[data-tour-next]'));
  await until(() => coachKey(el) === '9-also', 'Also in your Inbox');
  await click($(el, '[data-tour-next]'));
  await until(() => window.location.hash === '#tour=10', 'step 10');
}

test.skipIf(!hasDom)('Two paths: two equal cards; Connect my agents opens the real first-run screen and is remembered', async () => {
  const el = await openOnEntry();
  expect(el.querySelectorAll('.ib-te-paths .ib-te-card')).toHaveLength(2);
  // The bento's top tile: how the Inbox fits with your agents, in the owner's words.
  expect($(el, '[data-tour-fit] h3')!.textContent).toBe('The Inbox works beside your agents');
  expect($(el, '[data-tour-fit]')!.textContent).toContain('Your reply goes back into the same session, and it keeps working.');
  expect($(el, '[data-tour-start]')!.textContent).toContain('Start the tour');
  expect($(el, '[data-tour-connect]')!.textContent).toContain('Connect my agents');
  await click($(el, '[data-tour-connect]'));
  await until(() => $(el, '[data-inbox-empty]') !== null && $(el, '[data-tour-entry]') === null, 'the first-run screen');
  await until(() => !!config().inboxTour?.skipped_at, 'the skip remembered');
  // Once decided, the first-run screen keeps a quiet way to the tour.
  expect($(el, '[data-tour-again]')!.textContent).toContain('Take the 2-minute tour');
  // A new load opens on the first-run screen, never the entry screen again.
  act(() => root?.unmount());
  host?.remove();
  const again = await renderApp();
  await until(() => $(again, '[data-inbox-empty]') !== null, 'the first-run screen after a reload');
  expect($(again, '[data-tour-entry]')).toBeNull();
}, 90_000);

/**
 * What the tour may ask of the server: the tour's own read-only routes, the window's own reads, and the
 * `tour` setting. Never a route that writes anything else: no annotations, markups, picks, replies,
 * messages (compose), uploads or drafts, and never the person's attachments.
 */
const FORBIDDEN = /\/api\/inbox\/(annotations|markups|uploads|drafts|messages|attachments)|\/picks|\/reply|\/send-now|\/ack/;

test.skipIf(!hasDom)('the walk writes nothing: a plain question, comments, a screenshot, the film, compose, all in the tour; step 10 real, Finish', async () => {
  const el = await openOnEntry();
  const before = (await loopback('/api/inbox/threads')).text.replace(/"cursor":\d+,?/, '');
  const record = { suggestions: [] as string[] };
  const seen: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(`${init?.method ?? 'GET'} ${String(input)}`);
    return realFetch(input, init);
  }) as typeof fetch;
  await walkTo(el, 10, record);
  globalThis.fetch = realFetch;
  // Every comment box opened with the developer's real comment, condensed; the compose words are the real request.
  expect(record.suggestions).toEqual([
    'Good. If hover isn’t instant, tell me before you build B.',
    'Nice, reusing the reader’s hooks keeps this small.',
    'Looks great. This screenshot should go on the site.',
    'Make chapter one taller here. It’s the narrative guide, and it’s easy to miss.',
    'We need a page and a short film for Guided Reviews in VS Code, like plannotator.ai/inbox.',
  ]);
  await until(() => $(el, '.ib-empty h2')?.textContent === 'Now, let’s connect your agents', 'step 9’s screen');
  expect($(el, '[data-tour-bar]')!.textContent).toContain('Your own Inbox');
  // Nothing of the tour reached a route that writes, or the person's files.
  expect(writes()).toEqual([]);
  expect(seen.filter((r) => FORBIDDEN.test(r))).toEqual([]);
  expect(seen.filter((r) => !r.startsWith('GET ') && !r.includes('/api/inbox/settings') && !r.includes('/api/inbox/window'))).toEqual([]);
  await click($(el, '[data-tour-exit="finish"]'));
  await until(() => $(el, '[data-tour-bar]') === null, 'the tour ended');
  await until(() => !!config().inboxTour?.finished_at, 'finished remembered');
  expect(config().inboxTour.notify_again).toBe(true);
  // The person's own list is exactly as it was.
  expect((await loopback('/api/inbox/threads')).text.replace(/"cursor":\d+,?/, '')).toBe(before);
  expect(existsSync(join(dir!, 'data', 'inbox', 'markups'))).toBe(false);
}, 180_000);

test.skipIf(!hasDom)('Fast-forward through every step writes nothing and ends each step as the walk would; a click the tour cannot use is answered', async () => {
  const el = await openOnEntry();
  const before = (await loopback('/api/inbox/threads')).text.replace(/"cursor":\d+,?/, '');
  const seen: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(`${init?.method ?? 'GET'} ${String(input)}`);
    return realFetch(input, init);
  }) as typeof fetch;
  await click($(el, '[data-tour-start]'));
  await pastIntro(el);
  // The first card that asks for an action says it is the person's turn.
  expect($(el, '[data-tour-coach] [data-tour-your-turn]')!.textContent).toBe('Your turn');
  // New message is answered before its step, never ignored.
  await click([...el.querySelectorAll<HTMLElement>('[data-open-compose]')][0]);
  await until(() => $(el, '[data-tour-nudge]') !== null, 'the answer to New message');
  expect($(el, '[data-tour-nudge]')!.textContent).toContain('step 9');
  expect(document.querySelector('[data-compose]')).toBeNull();
  const ends = ['2', '3', '4', '5', '6', '7', '8-open', '9'];
  for (const [i, key] of ends.entries()) {
    await click($(el, '[data-tour-forward]'));
    await until(() => coachKey(el) === key, `step ${i + 1} fast-forwarded`);
    expect(activeIsPage()).toBe(false);
  }
  await click($(el, '[data-tour-forward]'));
  await until(() => coachKey(el) === '9-loop', 'step 9 fast-forwarded to the loop');
  expect($(el, '[data-tour-forward]')).toBeNull();
  await click($(el, '[data-tour-next]'));
  await click($(el, '[data-tour-next]'));
  await until(() => window.location.hash === '#tour=10', 'step 10');
  globalThis.fetch = realFetch;
  expect(writes()).toEqual([]);
  expect(seen.filter((r) => FORBIDDEN.test(r))).toEqual([]);
  expect((await loopback('/api/inbox/threads')).text.replace(/"cursor":\d+,?/, '')).toBe(before);
}, 120_000);

test.skipIf(!hasDom)('a sent question card, Mark read, Archive and an early Send answer a click; the card itself points again', async () => {
  const el = await openOnEntry();
  await walkTo(el, 3);
  // The warm-up was sent: a click on its card says so.
  await click($(el, '[data-tour-message="warm"] .question-block label'));
  await until(() => ($(el, '[data-tour-nudge]')?.textContent ?? '').includes('sent already'), 'the sent card answers');
  // Mark read and Archive are the person's own Inbox's.
  const markRead = [...el.querySelectorAll<HTMLButtonElement>('[data-tour-thread] .ib-phead button[aria-disabled="true"]')][0];
  await click(markRead);
  await until(() => ($(el, '[data-tour-nudge]')?.textContent ?? '').includes('after the tour'), 'Mark read answers');
  // A click on the card's words shows its target again.
  await click($(el, '[data-tour-coach] h2'));
  await until(() => document.querySelector('.ib-tour-again') !== null, 'the target pointed at again');
  expect(writes()).toEqual([]);
}, 90_000);

test.skipIf(!hasDom)('Fast-forward mid-replay leaves nothing stale; a second Send and New message after its Send are answered as they are', async () => {
  const el = await openOnEntry();
  await walkTo(el, 6);
  // Everything the live region says from here on.
  const said: string[] = [];
  const live = document.querySelector('[data-inbox-live]')!;
  const watch = new MutationObserver(() => said.push(live.textContent ?? ''));
  watch.observe(live, { childList: true, characterData: true, subtree: true });
  await click($(el, '[data-tour-reply]'));
  await click($(el, '[data-tour-send]'));
  await until(() => coachKey(el) === '7-sending', 'the replay running');
  // A second press on Send lands on the foot's Reply: it is answered with where the reply is, not "not part of the tour".
  await click($(el, '[data-tour-thread] .ib-pfoot button[aria-disabled="true"]'));
  await until(() => ($(el, '[data-tour-nudge]')?.textContent ?? '').includes('on its way'), 'the reply on its way');
  await click($(el, '[data-tour-forward]'));
  await until(() => coachKey(el) === '8-open', 'step 7 fast-forwarded');
  const from = said.length;
  // Past the replay's own timings (5.6 s): its timers said and did nothing more.
  await wait(6200);
  watch.disconnect();
  expect(said.slice(from).filter((s) => /Delivered|New message from/.test(s))).toEqual([]);
  // The Fast-forward was said with the card it landed on, in one announcement.
  expect(said.some((s) => s.startsWith('Fast-forwarded. Step 8 of 10.'))).toBe(true);
  expect(coachKey(el)).toBe('8-open');
  // Step 9 after its Send: New message says where the thread is.
  await click($(el, '[data-tour-forward]'));
  await until(() => coachKey(el) === '9', 'step 9');
  await click($(el, '[data-tour-forward]'));
  await until(() => coachKey(el) === '9-loop', 'the loop');
  await click([...el.querySelectorAll<HTMLElement>('[data-open-compose]')][0]);
  await until(() => ($(el, '[data-tour-nudge]')?.textContent ?? '').includes('Your thread is started'), 'New message after its Send');
  expect(document.querySelector('[data-compose]')).toBeNull();
  expect(writes()).toEqual([]);
}, 120_000);

test.skipIf(!hasDom)('Exit at every step, 1 to 10, gives the Inbox back; a pick other than the real answer is replayed as a fact', async () => {
  const el = await openOnEntry();
  for (const step of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    await walkTo(el, step);
    await click($(el, step === 10 ? '[data-tour-exit="finish"]' : '[data-tour-exit="exit"]'));
    await until(() => $(el, '[data-tour-bar]') === null && $(el, '[data-inbox-empty]') !== null, `the Inbox after Exit at step ${step}`);
    expect(window.location.hash).toBe('');
    expect($(el, '[data-tour-entry]')).toBeNull();
    expect($(el, '[data-tour-again] button')).not.toBeNull();
  }
  expect(writes()).toEqual([]);
  // B, not the real answer: the replay says so, as a fact.
  await click($(el, '[data-tour-again] button'));
  await pastIntro(el);
  await click($(el, '[data-thread-id="tour-vscode"]'));
  // The warm-up's other answer: the agent's next message says so, as a fact.
  await until(() => warmRadios(el).length === 2, 'the plain choices');
  await click(warmRadios(el)[1]);
  await click($(el, '[data-tour-warm-send]'));
  await until(() => $(el, '[data-tour-differs="warm"]') !== null, 'the warm-up’s note', 160);
  // The warm-up is the tour's own question (the real thread asked nothing then): its note never claims a real answer.
  expect($(el, '[data-tour-differs="warm"]')!.textContent).toBe('You picked Evaluate only, no mockups yet. The tour goes on with the mockups, so you can see the pictures.');
  await until(() => radios(el).length === 4, 'the choices');
  await click(radios(el)[1]);
  await until(() => coachKey(el) === '4', 'step 4');
  await commentOn($(el, '[data-tour-message="ask"] .ib-body')!, PHRASE);
  await until(() => coachKey(el) === '5', 'step 5');
  await click($(el, '[data-tour-thread] .ib-attachments:not(.ib-hatts-tiles) [data-attachment-name="EVALUATION.md"]'));
  await until(() => (el.querySelector('[data-attachment-pane] .ib-docscroll')?.textContent ?? '').includes(EV_LINE), 'EVALUATION.md');
  await commentOn($(el, '[data-attachment-pane] .ib-docscroll')!, EV_LINE);
  await until(() => coachKey(el) === '6', 'step 6');
  await click($(el, '[data-tour-reply]'));
  await click($(el, '[data-tour-send]'));
  await until(() => $(el, '[data-tour-differs=""]') !== null, 'the note', 160);
  expect($(el, '[data-tour-differs=""]')!.textContent).toBe('You picked B · Our reader beside a live native diff. In the real thread the answer was A, so this is what Claude Code built.');
}, 400_000);

test.skipIf(!hasDom)('a real message mid-tour is a chip in the bar; the tour goes on; the chip leaves the tour to it', async () => {
  const el = await openOnEntry();
  await walkTo(el, 2);
  await act(async () =>
    pushRecord!({
      seq: 999,
      kind: 'message',
      id: 'msg_01REALMESSAGE000000000000',
      first: true,
      message: { id: 'msg_01REALMESSAGE000000000000', thread_id: 'msg_01REALMESSAGE000000000000', author: { kind: 'agent', host: 'claude-code', session: 'ses_x', name: null } },
    }),
  );
  await until(() => $(el, '[data-tour-arrivals]') !== null, 'the chip');
  expect($(el, '[data-tour-arrivals]')!.textContent).toBe('1 new message in your Inbox');
  expect(coachKey(el)).toBe('2');
  await click($(el, '[data-tour-arrivals]'));
  await until(() => $(el, '[data-tour-bar]') === null, 'out of the tour');
  expect(window.location.hash).toContain('thread=msg_01REALMESSAGE000000000000');
}, 90_000);

test.skipIf(!hasDom)('returning users: Settings → General → Take the tour; over the tailnet step 6 says where to connect', async () => {
  tailnetPage = true;
  const el = await openOnEntry();
  await act(async () => {
    window.location.hash = '#settings/general';
  });
  await until(() => $(el, '[data-settings-take-tour]') !== null, 'Getting started');
  expect($(el, '[data-settings-tour]')!.textContent).toContain('See how the Inbox works through real threads from building Plannotator');
  await click($(el, '[data-settings-take-tour]'));
  await pastIntro(el);
  // Steps 1 to 5 play in full over the tailnet; step 6 cannot read the agents there.
  await act(async () => {
    window.location.hash = '#tour=10';
  });
  await until(() => $(el, '.ib-empty h2')?.textContent === 'Now, let’s connect your agents', 'step 10');
  await until(() => (el.textContent ?? '').includes('Open the Inbox on the computer to connect agents with one click.'), 'the tailnet line');
}, 90_000);

test.skipIf(!hasDom)('notifications: quiet over the replay in front (the chip says it), as always on step 6 and in the background', async () => {
  permission = 'granted';
  const el = await openOnEntry();
  // Steps 1 to 5 in front: the chip, no notification.
  await walkTo(el, 2);
  const first = await firstMessage('A first real question.', 'Real one');
  await act(async () => pushRecord!(recordOf(first)));
  await until(() => $(el, '[data-tour-arrivals]') !== null, 'the chip');
  await wait(600);
  expect(notices).toEqual([]);
  // The tab in the background: what arrives notifies as always, even over the replay.
  document.hasFocus = () => false;
  const second = await firstMessage('Another real one.', 'Background one');
  await act(async () => pushRecord!(recordOf(second)));
  await until(() => notices.length === 1, 'the background notification');
  document.hasFocus = () => true;
  // Step 6 (where the person gets their first question): notifications as always, in front too.
  await act(async () => {
    window.location.hash = '#tour=10';
  });
  await until(() => $(el, '.ib-empty h2')?.textContent === 'Now, let’s connect your agents', 'step 10');
  const third = await firstMessage('The question you asked for.', 'Step six one');
  await act(async () => pushRecord!(recordOf(third)));
  await until(() => notices.length === 2, 'the step 6 notification');
  // Step 6 carries the brief's prompt: one real question, with pictures.
  expect($(el, '.ib-try-quote')!.textContent).toContain('Send me one real question in my Plannotator Inbox');
}, 90_000);

test.skipIf(!hasDom)('the first real thread asks once more, inline, in a real thread’s words; never when off or dismissed', async () => {
  const threadId = await firstMessage(':::question\nWhich retry policy?\n- [ ] Exponential\n- [ ] Fixed\n:::', 'Export job retries');
  const notifyAgain = () => loopback('/api/inbox/settings', 'POST', JSON.stringify({ tour: { notify_again: true } }));
  await notifyAgain();
  const el = await renderApp();
  await until(() => $(el, `[data-thread-id="${threadId}"]`) !== null, 'the list');
  await act(async () => {
    window.location.hash = `#thread=${threadId}`;
  });
  await until(() => $(el, '[data-tour-notify-again]') !== null, 'the inline ask');
  const ask = $(el, '[data-tour-notify-again]')!;
  expect(ask.textContent).toContain('Get a desktop notice when an agent needs you.');
  expect(ask.textContent).not.toContain('first question');
  // One ask on screen: the list's line stands down while it shows.
  expect(el.querySelectorAll('[data-notification-ask]')).toHaveLength(1);
  // Shown once: leaving the thread ends it.
  await act(async () => {
    window.location.hash = '';
  });
  await until(() => config().inboxTour?.notify_again === false, 'notify_again cleared');
  await act(async () => {
    window.location.hash = `#thread=${threadId}`;
  });
  await wait(600);
  expect($(el, '[data-tour-notify-again]')).toBeNull();
  // Off, or dismissed: never, as for the ask above the list.
  for (const change of [{ enabled: false }, { enabled: true, dismissed: true }]) {
    await loopback('/api/inbox/settings', 'POST', JSON.stringify({ notifications: change }));
    await notifyAgain();
    act(() => root?.unmount());
    host?.remove();
    const again = await renderApp();
    await act(async () => {
      window.location.hash = `#thread=${threadId}`;
    });
    await until(() => $(again, 'section.ib-pane h2.ib-subject') !== null, 'the thread');
    await wait(600);
    expect($(again, '[data-tour-notify-again]'), JSON.stringify(change)).toBeNull();
  }
}, 90_000);

test.skipIf(!hasDom)('⌘K does not open search over the replay (it shows the person’s own threads); on step 6 it does', async () => {
  const el = await openOnEntry();
  await walkTo(el, 2);
  const { isMac } = await import('@plannotator/ui/utils/platform');
  const chord = () => act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', metaKey: isMac, ctrlKey: !isMac, bubbles: true, cancelable: true })));
  await chord();
  await wait(500);
  expect(document.querySelector('[data-search-palette]')).toBeNull();
  expect(window.location.hash).toBe('#tour=2');
  await act(async () => {
    window.location.hash = '#tour=10';
  });
  await until(() => $(el, '.ib-empty h2')?.textContent === 'Now, let’s connect your agents', 'step 10');
  await chord();
  await until(() => document.querySelector('[data-search-palette]') !== null, 'search');
}, 90_000);

// ── What a user can end up in (tour QA, 2026-10-25): the tour keeps working, and so does the Inbox ──

const activeIsPage = () => !document.activeElement || document.activeElement === document.body;

test.skipIf(!hasDom)('a failed settings read never blanks the first run: the screen draws, the read is tried again, the tour stays reachable', async () => {
  let gets = 0;
  intercept = (path, method) => (path.startsWith('/api/inbox/settings') && method === 'GET' && gets++ === 0 ? Response.json({ error: 'busy' }, { status: 503 }) : null);
  const el = await renderApp();
  await until(() => $(el, '[data-inbox-empty]') !== null, 'the first-run screen without settings');
  // Read again; once the settings come, the screen gains its quiet way to the tour (no swap under the person).
  await until(() => gets >= 2 && $(el, '[data-tour-again] button') !== null, 'the settings read again');
  expect($(el, '[data-tour-entry]')).toBeNull();
  await click($(el, '[data-tour-again] button'));
  await pastIntro(el);
}, 90_000);

test.skipIf(!hasDom)('a settings read that keeps failing: the first-run screen still draws', async () => {
  intercept = (path, method) => (path.startsWith('/api/inbox/settings') && method === 'GET' ? Response.json({ error: 'down' }, { status: 502 }) : null);
  const el = await renderApp();
  await until(() => $(el, '[data-inbox-empty]') !== null, 'the first-run screen');
  expect($(el, '.ib-listcol[aria-busy="true"]')).toBeNull();
}, 90_000);

test.skipIf(!hasDom)('Forward after Exit, and a reload of that entry, never reopen the tour; odd #tour= values are normalized', async () => {
  const el = await openOnEntry();
  await walkTo(el, 3);
  await click($(el, '[data-tour-exit="exit"]'));
  await until(() => $(el, '[data-tour-bar]') === null && window.location.hash === '', 'out of the tour');
  await act(async () => window.history.forward());
  await wait(400);
  expect(window.location.hash).toBe('');
  expect($(el, '[data-tour-bar]')).toBeNull();
  // A reload of an entry the tour ended from (its mark kept in history.state) opens the Inbox, not the tour.
  window.history.pushState({ ibFrom: '', ibTourEnded: '' }, '', '#tour=4');
  act(() => root?.unmount());
  host?.remove();
  const again = await renderApp();
  await until(() => $(again, '[data-inbox-empty]') !== null, 'the Inbox after the reload');
  expect(window.location.hash).toBe('');
  expect($(again, '[data-tour-bar]')).toBeNull();
  for (const [odd, step] of [['abc', 1], ['0', 1], ['', 1], ['99', 10], ['2.5', 2], ['-3', 1]] as const) {
    await act(async () => {
      window.location.hash = `#tour=${odd}`;
    });
    await until(() => window.location.hash === `#tour=${step}`, `#tour=${odd} as #tour=${step}`);
  }
}, 90_000);

test.skipIf(!hasDom)('Z never undoes into the Inbox while the tour is up; the toast leaves when the tour starts', async () => {
  const threadId = await firstMessage(':::question\nShip it?\n- [ ] Yes\n- [ ] No\n:::', 'Ship question');
  const el = await renderApp();
  await act(async () => {
    window.location.hash = `#thread=${threadId}`;
  });
  await until(() => $(el, '[data-mark-read]') !== null, 'the thread');
  await act(async () => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', bubbles: true })));
  await until(() => document.querySelector('[data-inbox-toast]') !== null, 'the Mark read toast');
  await act(async () => {
    window.location.hash = '#settings/general';
  });
  await until(() => $(el, '[data-settings-take-tour]') !== null, 'Getting started');
  await click($(el, '[data-settings-take-tour]'));
  await pastIntro(el);
  expect(document.querySelector('[data-inbox-toast]')).toBeNull();
  const before = posts.length;
  await act(async () => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', bubbles: true })));
  await wait(600);
  expect(posts.slice(before).filter((p) => p.path.includes('/unread'))).toEqual([]);
}, 90_000);

test.skipIf(!hasDom)('a tour decision that cannot be saved is tried again, then said; Two paths does not come back', async () => {
  intercept = (path, method, body) =>
    path === '/api/inbox/settings' && method === 'POST' && body?.includes('skipped')
      ? Response.json({ error: 'config.json could not be saved; nothing changed.', code: 'config_not_saved' }, { status: 500 })
      : null;
  const el = await openOnEntry();
  await walkTo(el, 2);
  await click($(el, '[data-tour-exit="exit"]'));
  await until(() => document.querySelector('[data-inbox-toast] .ib-tlead')?.textContent === 'Not saved', 'the quiet failure', 200);
  // Three tries: the first and two more.
  expect(posts.filter((p) => p.path === '/api/inbox/settings' && (p.body.tour as Record<string, unknown> | undefined)?.skipped).length).toBe(3);
  expect(config().inboxTour?.skipped_at ?? null).toBeNull();
  act(() => root?.unmount());
  host?.remove();
  const again = await renderApp();
  await until(() => $(again, '[data-inbox-empty]') !== null, 'the first-run screen');
  expect($(again, '[data-tour-entry]')).toBeNull();
}, 90_000);

test.skipIf(!hasDom)('the step-6 chip ends the tour as finished, not skipped', async () => {
  const el = await openOnEntry();
  await walkTo(el, 1);
  await act(async () => {
    window.location.hash = '#tour=10';
  });
  await until(() => $(el, '.ib-empty h2')?.textContent === 'Now, let’s connect your agents', 'step 10');
  await act(async () => pushRecord!(recordOf('msg_01REALMESSAGE000000000000')));
  await until(() => $(el, '[data-tour-arrivals]') !== null, 'the chip');
  await click($(el, '[data-tour-arrivals]'));
  await until(() => !!config().inboxTour?.finished_at, 'finished remembered');
  expect(config().inboxTour.skipped_at ?? null).toBeNull();
}, 90_000);

/** Every word the tour may never show: the tour is all positive (the owner, on #2178). */
const NEVER_IN_THE_TOUR = /could not|couldn’t|not answering|did not load|didn’t load|try again|error|failed|missing/i;

test.skipIf(!hasDom)('content that cannot be had never starts the tour: no error, the first-run screen, the tour kept in Settings', async () => {
  intercept = (path) => (path.startsWith('/api/inbox/tour/fixture.json') ? Response.json({ error: 'boom' }, { status: 500 }) : null);
  // A link (or a reload) of #tour=2: the tour leaves without a word.
  await act(async () => {
    window.location.hash = '#tour=2';
  });
  const el = await renderApp();
  await until(() => $(el, '[data-tour-bar]') === null && $(el, '[data-inbox-empty]') !== null, 'the first-run screen');
  expect(el.textContent ?? '').not.toMatch(NEVER_IN_THE_TOUR);
  expect(window.location.hash).toBe('');
  // The entry screen and the first-run screen's tour line stand down; nothing recorded.
  expect($(el, '[data-tour-entry]')).toBeNull();
  expect($(el, '[data-tour-again]')).toBeNull();
  expect(existsSync(join(dir!, 'data', 'config.json')) ? (config().inboxTour?.skipped_at ?? null) : null).toBeNull();
  await until(() => !activeIsPage(), 'focus on the Inbox');
  // Settings → Getting started keeps it: once the content can be had, it starts.
  intercept = null;
  await act(async () => {
    window.location.hash = '#settings/general';
  });
  await until(() => $(el, '[data-settings-take-tour]') !== null, 'Getting started');
  await click($(el, '[data-settings-take-tour]'));
  await pastIntro(el);
}, 90_000);

test.skipIf(!hasDom)('the entry screen loads the tour early; content that cannot be had takes it away before Start', async () => {
  intercept = (path) => (path.startsWith('/api/inbox/tour/fixture.json') ? 'network' : null);
  const el = await renderApp();
  await until(() => $(el, '[data-inbox-empty]') !== null && $(el, '[data-tour-entry]') === null, 'the first-run screen in place of the entry screen');
  expect(el.textContent ?? '').not.toMatch(NEVER_IN_THE_TOUR);
}, 90_000);

test.skipIf(!hasDom)('focus never drops to the page: the loading screen, a hash change mid-tour, Back out of the tour', async () => {
  let release: () => void = () => {};
  const held = new Promise<void>((done) => (release = done));
  let first = true;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith('/api/inbox/tour/fixture.json') && first) {
      first = false;
      await held;
    }
    return realFetch(input, init);
  }) as typeof fetch;
  await act(async () => {
    window.location.hash = '#tour=2';
  });
  const el = await renderApp();
  await until(() => $(el, '[data-tour-loading]') !== null, 'the loading screen');
  await until(() => document.activeElement === $(el, '[data-tour-loading] h2'), 'focus on the loading screen');
  release();
  await until(() => coachKey(el) === '2', 'the tour loaded');
  await until(() => !activeIsPage(), 'focus kept once the tour shows');
  // A hash change mid-tour that takes the focused control away.
  await until(() => warmRadios(el).length === 2, 'the plain choices');
  warmRadios(el)[0]!.focus();
  await act(async () => {
    window.location.hash = '#tour=4';
  });
  await until(() => coachKey(el) === '4', 'step 4');
  await until(() => !activeIsPage(), 'focus after the hash change');
  // Out of the tour as the browser's Back would (no Exit): focus lands on the Inbox.
  $(el, '[data-tour-thread] [data-attachment-name="EVALUATION.md"]')?.focus();
  await act(async () => {
    window.location.hash = '';
  });
  await until(() => $(el, '[data-tour-bar]') === null, 'out of the tour');
  await until(() => !activeIsPage(), 'focus on the Inbox after Back');
}, 90_000);

test.skipIf(!hasDom)('the replay takes Other as an answer: kept on the card, and the walk goes on', async () => {
  const el = await openOnEntry();
  await walkTo(el, 3);
  const field = () => $(el, '[data-tour-message="ask"] input[placeholder="Other…"], [data-tour-message="ask"] textarea[placeholder="Other…"]') as HTMLInputElement | null;
  expect(field()).not.toBeNull();
  const proto = field() instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(field(), 'Something else entirely');
    field()!.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await until(() => coachKey(el) === '4', 'step 4 after Other');
  expect(field()!.value).toBe('Something else entirely');
  expect(writes()).toEqual([]);
}, 90_000);

test.skipIf(!hasDom)('everything loads when the tour starts: a server that stops mid-tour changes nothing; the files read from memory', async () => {
  const el = await openOnEntry();
  await walkTo(el, 5);
  // From here on the tour's routes answer nothing.
  intercept = (path) => (path.startsWith('/api/inbox/tour/') ? 'network' : null);
  await click($(el, '[data-tour-thread] .ib-attachments:not(.ib-hatts-tiles) [data-attachment-name="EVALUATION.md"]'));
  await until(() => (el.querySelector('[data-attachment-pane] .ib-docscroll')?.textContent ?? '').includes('Guided Reviews in VS Code: an honest look'), 'EVALUATION.md from memory');
  await click($(el, '[data-tour-thread] .ib-attachments:not(.ib-hatts-tiles) [data-attachment-name="prototype.html"]'));
  await until(() => $(el, '[data-attachment-pane] iframe') !== null, 'the mock from memory');
  expect((($(el, '[data-attachment-pane] iframe') as HTMLIFrameElement).getAttribute('srcdoc') ?? '').length).toBeGreaterThan(1000);
  expect(el.textContent ?? '').not.toMatch(NEVER_IN_THE_TOUR);
  // Nothing leaves the window: no Download, no Open in.
  expect($(el, '[data-attachment-pane] [data-attachment-download]')).toBeNull();
}, 90_000);

test.skipIf(!hasDom)('pictures that are not here degrade quietly: the card names its choices, the coach says so calmly', async () => {
  __forgetTourFixtureForTests();
  __forgetTourAssetsForTests();
  intercept = (path) => (path.includes('-thumb.webp') ? Response.json({ error: 'Not found' }, { status: 404 }) : null);
  await act(async () => {
    window.location.hash = '#tour=3';
  });
  const el = await renderApp();
  await until(() => $(el, '[data-tour-coach] h2')?.textContent === 'Pick a direction', 'the step-3 card without pictures');
  expect(el.textContent ?? '').not.toMatch(NEVER_IN_THE_TOUR);
}, 90_000);
