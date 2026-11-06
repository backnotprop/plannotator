/**
 * Settings -> Decision data's Ask box, over a scripted `fetch`: who it asks, what a press sends, what no agent running
 * shows, and what a press that fails leaves behind. The agent's side is `packages/server/inbox-decision-ask.test.ts`.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const { DecisionAsk } = (hasDom ? await import('./components/DecisionAsk') : {}) as typeof import('./components/DecisionAsk');

type Session = { session: string; host: string; started_at: string; last_seen_at: string; busy: boolean; idle_since: null; last_thread: null };
const session = (id: string, host: string): Session => ({ session: id, host, started_at: '2026-11-01T00:00:00.000Z', last_seen_at: '2026-11-05T00:00:00.000Z', busy: false, idle_since: null, last_thread: null });
const group = (name: string, sessions: Session[]) => ({ project: { id: `prj_${name}`, name, root: `/made/up/${name}` }, sessions });

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedClipboard: PropertyDescriptor | undefined;
let live: ReturnType<typeof group>[] = [];
let sends: Record<string, unknown>[] = [];
let answer: (body: Record<string, unknown>) => Response = () => new Response(JSON.stringify({ thread_id: 'msg_answer', message: {}, replayed: false }));
let copied: string[] = [];

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  savedClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  live = [];
  sends = [];
  copied = [];
  answer = () => new Response(JSON.stringify({ thread_id: 'msg_answer', message: {}, replayed: false }));
  window.location.hash = '#settings/decision-data';
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/inbox/sessions')) return new Response(JSON.stringify({ serverSession: 's', home: '/made/up', projects: live }));
    if (url.includes('/api/inbox/messages') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      sends.push(body);
      return answer(body);
    }
    return new Response('{}');
  }) as typeof fetch;
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        copied.push(text);
      },
    },
  });
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
  if (savedClipboard) Object.defineProperty(navigator, 'clipboard', savedClipboard);
  else delete (navigator as unknown as { clipboard?: unknown }).clipboard;
  window.location.hash = '';
});

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function open() {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<DecisionAsk />);
  });
  await until(() => host!.querySelector('[data-ask-go], [data-ask-copy]') !== null, 'the sessions');
  return host;
}

const box = (el: ParentNode) => el.querySelector('input') as HTMLInputElement;
const go = (el: ParentNode) => el.querySelector('[data-ask-go]') as HTMLButtonElement | null;
const copy = (el: ParentNode) => el.querySelector('[data-ask-copy]') as HTMLButtonElement | null;
/** The line under the heading: the part that says who would answer, when someone can. */
const lede = (el: ParentNode) => el.querySelector('[data-decision-ask] > p')!.textContent ?? '';

function type(el: ParentNode, words: string) {
  const input = box(el);
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, words);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

async function press(el: ParentNode) {
  await act(async () => {
    (el.querySelector('form') as HTMLFormElement).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 10));
  });
}

test.skipIf(!hasDom)('a press sends the question as an Ask to the running agent, marked so the agent gets the instructions, and opens the new thread', async () => {
  live = [group('harbor', [session('ses-a', 'claude-code')])];
  const el = await open();
  expect(go(el)!.textContent).toContain('Claude Code');
  expect(lede(el)).toContain('Claude Code');
  expect(go(el)!.disabled).toBe(true);
  type(el, '   ');
  expect(go(el)!.disabled).toBe(true);
  await press(el);
  expect(sends).toEqual([]);
  type(el, '  Why did we drop DockView?  ');
  expect(go(el)!.disabled).toBe(false);
  await press(el);
  expect(sends.length).toBe(1);
  expect(sends[0]).toMatchObject({ to: { host: 'claude-code', session: 'ses-a' }, body: 'Why did we drop DockView?', decision_ask: true });
  expect(typeof sends[0]!.idempotency_key).toBe('string');
  expect(sends[0]!.thread_name_auto).toBe(true);
  expect(window.location.hash).toBe('#thread=msg_answer');
});

test.skipIf(!hasDom)('with no agent running the line under the heading promises no reader: it is the line with an agent, less the sentence about that agent', async () => {
  live = [group('harbor', [session('ses-a', 'claude-code')])];
  const withAgent = lede(await open());
  act(() => root?.unmount());
  host?.remove();
  live = [];
  const alone = lede(await open());
  expect(withAgent).toContain('Claude Code');
  expect(alone).not.toBe(withAgent);
  expect(withAgent.startsWith(alone)).toBe(true);
});

test.skipIf(!hasDom)('with no agent running it says so and offers Copy of the question; nothing is sent and nothing goes looking', async () => {
  const el = await open();
  expect(el.querySelector('[data-ask-none]')!.textContent).toContain('No agent is running');
  expect(go(el)).toBeNull();
  expect(copy(el)!.disabled).toBe(true);
  type(el, 'Why did we drop DockView?');
  expect(copy(el)!.disabled).toBe(false);
  await act(async () => {
    copy(el)!.click();
    await new Promise((r) => setTimeout(r, 5));
  });
  expect(copied).toEqual(['Why did we drop DockView?']);
  expect(copy(el)!.textContent).toContain('Copied');
  await press(el);
  expect(sends).toEqual([]);
  expect(window.location.hash).toBe('#settings/decision-data');
  // Changing the question takes the Copied mark back.
  type(el, 'And when?');
  expect(copy(el)!.textContent).not.toContain('Copied');
});

test.skipIf(!hasDom)('with several agents the choice holds by session, even when the list comes back in another order', async () => {
  const a = session('ses-a', 'claude-code');
  const b = session('ses-b', 'pi');
  live = [group('harbor', [a]), group('lantern', [b])];
  const el = await open();
  const select = el.querySelector('[data-ask-who]') as HTMLSelectElement;
  expect(select.value).toBe('ses-a');
  act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!.call(select, 'ses-b');
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
  expect(go(el)!.textContent).toContain('Pi');
  type(el, 'Why?');
  // The agent went while this was open: nothing was sent, and the box reads the sessions there are now.
  live = [group('lantern', [b]), group('harbor', [a])];
  answer = () => new Response(JSON.stringify({ error: 'gone', code: 'session_not_live' }), { status: 409 });
  await press(el);
  await until(() => (el.querySelector('[data-ask-who]') as HTMLSelectElement)?.options[0]?.value === 'ses-b', 'the new order');
  expect(sends.at(-1)!.to).toMatchObject({ host: 'pi', session: 'ses-b' });
  expect(go(el)!.textContent).toContain('Pi');
  expect(box(el).value).toBe('Why?');
});

test.skipIf(!hasDom)('when the only agent went while the box was open, the words stay and it reads No agent is running', async () => {
  live = [group('harbor', [session('ses-a', 'claude-code')])];
  const el = await open();
  type(el, 'Why did we drop DockView?');
  live = [];
  answer = () => new Response(JSON.stringify({ error: 'That session is not live any more.', code: 'session_not_live' }), { status: 409 });
  await press(el);
  await until(() => el.querySelector('[data-ask-none]') !== null, 'no agent');
  expect(box(el).value).toBe('Why did we drop DockView?');
  expect(copy(el)).not.toBeNull();
  expect(window.location.hash).toBe('#settings/decision-data');
  expect(el.querySelector('[data-ask-error]')).toBeNull();
});

test.skipIf(!hasDom)('a press that fails says so and keeps the words; pressing again is the same Send, until the words change', async () => {
  live = [group('harbor', [session('ses-a', 'claude-code')])];
  const el = await open();
  type(el, 'Why did we drop DockView?');
  answer = () => new Response(JSON.stringify({ error: 'Something is off.', code: 'internal_error' }), { status: 500 });
  await press(el);
  await until(() => el.querySelector('[data-ask-error]') !== null, 'the error');
  expect(el.querySelector('[data-ask-error]')!.textContent).toContain('Something is off.');
  expect(window.location.hash).toBe('#settings/decision-data');
  expect(box(el).value).toBe('Why did we drop DockView?');
  await press(el);
  expect(sends.length).toBe(2);
  expect(sends[1]!.idempotency_key).toBe(sends[0]!.idempotency_key);
  type(el, 'Why did we drop DockView, again?');
  expect(el.querySelector('[data-ask-error]')).toBeNull();
  await press(el);
  expect(sends[2]!.idempotency_key).not.toBe(sends[0]!.idempotency_key);
});
