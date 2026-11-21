/**
 * Settings → Rows' ask box (components/RowsAsk.tsx) and the "<agent> changed" line (components/RowsSettings.tsx),
 * with the Inbox's routes stubbed (approval "inbox-rows-settings-page").
 * What this catches: the box loud at rest (the picker or Send showing before it has focus), or example chips back;
 * Send starting a thread without `rows_ask` (the agent would get no instructions) or to no one; Send taking the
 * person off the page; the agent's line never appearing; a retry making a second thread; no agent running and no way
 * to keep the words (Copy), or a Send with no one to send to; an agent's save not said on the page, said without its
 * name, or its Undo not putting back the look from before in one save; the person's own save read as an agent's.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const { RowsAsk } = (hasDom ? await import('./components/RowsAsk') : {}) as typeof import('./components/RowsAsk');
const { RowsSection } = (hasDom ? await import('./components/RowsSettings') : {}) as typeof import('./components/RowsSettings');
const { hearRowsEvent, readListLook, resetListLookForTests, rowsFromLook } = await import('./listLook');
const { setStorageBackend, resetStorageBackend } = await import('@plannotator/ui/utils/storage');

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}
const calls: Call[] = [];
let sessions: { host: string; session: string; label?: string }[] = [];
let agentSays: string | null = null;
let sendFails = 0;
const realFetch = globalThis.fetch;
const realHash = hasDom ? window.location.hash : '';
let root: Root | null = null;
let host: HTMLElement | null = null;

const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  calls.length = 0;
  sessions = [{ host: 'claude-code', session: 'ses_a' }];
  agentSays = null;
  sendFails = 0;
  const stored = new Map<string, string>();
  setStorageBackend({ getItem: (k) => stored.get(k) ?? null, setItem: (k, v) => void stored.set(k, v), removeItem: (k) => void stored.delete(k) });
  globalThis.fetch = (async (url: unknown, init?: { method?: string; body?: string }) => {
    const path = new URL(String(url), 'http://localhost').pathname;
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ method: init?.method ?? 'GET', path, body });
    if (path.endsWith('/sessions')) return answer({ projects: sessions.length ? [{ project: { id: 'prj_a', name: 'storefront', root: '/src/storefront' }, sessions }] : [] });
    if (path.endsWith('/messages')) return sendFails-- > 0 ? answer({ error: 'The Inbox is busy.', code: 'busy' }, 503) : answer({ thread_id: 'msg_ask', message: { id: 'msg_ask' }, replayed: false });
    if (path.includes('/threads/')) return answer({ serverSession: 's', cursor: 1, thread: { thread_id: 'msg_ask', messages: [{ id: 'msg_ask', author: { kind: 'person' }, body: 'x' }, ...(agentSays ? [{ id: 'msg_r', author: { kind: 'agent', host: 'claude-code' }, body: agentSays }] : [])] } });
    return answer({ rows: body?.rows });
  }) as typeof fetch;
  resetListLookForTests();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  resetStorageBackend();
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  window.location.hash = realHash;
});

async function settle(ms = 15) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}
async function render(node: React.ReactNode): Promise<HTMLElement> {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(node));
  await settle();
  return host;
}
const box = (el: HTMLElement) => el.querySelector<HTMLInputElement>('[data-rows-ask] input')!;
async function type(el: HTMLElement, words: string) {
  act(() => box(el).focus());
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(box(el), words);
    box(el).dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}
async function press(el: HTMLElement, selector: string) {
  act(() => el.querySelector<HTMLElement>(selector)!.click());
  await settle();
}
const sends = () => calls.filter((call) => call.path.endsWith('/messages'));

describe.if(hasDom)("Settings → Rows' ask box", () => {
  test('at rest it is one line: no picker, no Send, no chips; they come with focus', async () => {
    sessions = [{ host: 'claude-code', session: 'ses_a' }, { host: 'codex', session: 'ses_b', label: 'billing' }];
    const el = await render(<RowsAsk />);
    const ask = el.querySelector('[data-rows-ask]')!;
    expect([ask.querySelectorAll('input').length, ask.querySelectorAll('button, select').length, box(el).placeholder]).toEqual([1, 0, 'Or tell your agent how you want your rows…']);
    act(() => box(el).focus());
    await settle();
    expect([ask.querySelectorAll('[data-rows-ask-who] option').length, ask.querySelector<HTMLButtonElement>('[data-rows-ask-send]')!.disabled]).toEqual([2, true]);
  });

  test('Send starts one thread to the picked agent, marked rows_ask, and the person stays on the page with "Sent to …" and the way to the thread', async () => {
    const el = await render(<RowsAsk replyPollMs={20} />);
    const before = window.location.hash;
    await type(el, '  Make my rows tighter  ');
    await press(el, '[data-rows-ask-send]');
    expect(sends().map((call) => [call.body!.to, call.body!.body, call.body!.rows_ask])).toEqual([[{ host: 'claude-code', session: 'ses_a' }, 'Make my rows tighter', true]]);
    expect([window.location.hash, el.querySelector('[data-rows-ask-sent]')!.textContent, el.querySelector('[data-rows-ask-thread]')!.getAttribute('href'), box(el).value]).toEqual([before, 'Sent to Claude Code. Open thread', '#thread=msg_ask', '']);
    // The agent's own line shows once it has replied, and follows its newest.
    expect(el.querySelector('[data-rows-ask-reply]')).toBeNull();
    agentSays = 'On it.\n\nmore below';
    await settle(80);
    expect(el.querySelector('[data-rows-ask-reply]')!.textContent).toContain('Claude Code On it.');
    expect(el.querySelector('[data-rows-ask-log]')!.getAttribute('aria-live')).toBe('polite');
  });

  test('a Send that fails says so and keeps the words; sending again is the same Send, never a second thread', async () => {
    sendFails = 1;
    const el = await render(<RowsAsk />);
    await type(el, 'Hide the PRs');
    await press(el, '[data-rows-ask-send]');
    expect([el.querySelector('[data-rows-ask-error]')!.getAttribute('role'), box(el).value, el.querySelector('[data-rows-ask-sent]')]).toEqual(['alert', 'Hide the PRs', null]);
    await press(el, '[data-rows-ask-send]');
    expect([sends().length, new Set(sends().map((call) => call.body!.idempotency_key)).size, el.querySelector('[data-rows-ask-sent]') !== null]).toEqual([2, 1, true]);
  });

  test('no agent running: it says so and offers Copy, never a Send', async () => {
    sessions = [];
    const copied: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => void copied.push(text) } });
    const el = await render(<RowsAsk />);
    await type(el, 'Make it compact');
    expect([el.querySelector('[data-rows-ask-send]'), el.querySelector('[data-rows-ask-none]')!.textContent]).toEqual([null, 'No agent is running']);
    await press(el, '[data-rows-ask-copy]');
    expect([copied, sends().length, el.querySelector('[data-rows-ask-copy]')!.textContent]).toEqual([['Make it compact'], 0, 'Copied']);
  });
});

describe.if(hasDom)('Settings → Rows: an agent changed the rows', () => {
  const saves = () => calls.filter((call) => call.method === 'POST' && call.path.endsWith('/settings')).map((call) => call.body!.rows);

  test('the page says who and what, with Undo; Undo puts back the look from before in one save', async () => {
    const el = await render(<RowsSection phone={false} />);
    act(() => hearRowsEvent(['compact', 'smallNames', 'relativeTime'], 5, undefined, { prev: ['smallNames'], by: { host: 'claude-code', session: 'ses_a' } }));
    await settle();
    expect(el.querySelector('[data-rows-last] [role="status"]')!.textContent).toBe('Claude Code changed: Spacing → Compact, Time → 10m ago');
    expect([el.querySelector('[data-rows-last] .ib-mk') !== null, el.querySelector<HTMLButtonElement>('[data-rows-undo]')!.disabled, rowsFromLook(readListLook()), saves()]).toEqual([true, false, ['compact', 'smallNames', 'relativeTime'], []]);
    await press(el, '[data-rows-undo-last]');
    expect([saves(), rowsFromLook(readListLook()), el.querySelector('[data-rows-last] [role="status"]')!.textContent]).toEqual([[['smallNames']], ['smallNames'], 'Undid: Spacing → Compact, Time → 10m ago']);
  });

  test("a save with no agent behind it (the person's, in another window) changes the list and names no one", async () => {
    const el = await render(<RowsSection phone={false} />);
    act(() => hearRowsEvent(['smallNames', 'hidePulls'], 6, undefined, { prev: ['smallNames'], by: null }));
    await settle();
    expect([rowsFromLook(readListLook()), el.querySelector('[data-rows-last] [role="status"]')!.textContent, el.querySelector<HTMLButtonElement>('[data-rows-undo]')!.disabled]).toEqual([['smallNames', 'hidePulls'], '', true]);
  });

  test('an agent with a host this build does not know is still named', async () => {
    const el = await render(<RowsSection phone={false} />);
    act(() => hearRowsEvent(['smallNames', 'dividers'], 7, undefined, { prev: ['smallNames'], by: { host: 'some-new-agent', session: 's' } }));
    await settle();
    expect(el.querySelector('[data-rows-last] [role="status"]')!.textContent).toBe('An agent changed: Lines between rows → on');
  });
});
