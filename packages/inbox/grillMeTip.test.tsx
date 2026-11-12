import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListRow, InboxThread } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const reveal = (hasDom ? await import('./reveal') : {}) as typeof import('./reveal');
const tip = (hasDom ? await import('./components/GrillMeTip') : {}) as typeof import('./components/GrillMeTip');

const TIMES = { pageAgeMs: 300, readMs: 60, settledMs: 60, momentMs: 1500, recheckMs: 20, claimRetryMs: 30, broReadMs: 120 };

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let savedTimes: typeof reveal.REVEAL_TIMES;
let posts: { path: string; body: Record<string, unknown> }[] = [];

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  if (!hasDom) return;
  savedTimes = { ...reveal.REVEAL_TIMES };
  Object.assign(reveal.REVEAL_TIMES, TIMES);
  savedFetch = globalThis.fetch;
  posts = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, '');
    if (init?.method === 'POST') posts.push({ path, body: JSON.parse(String(init.body ?? '{}')) as Record<string, unknown> });
    if (path.endsWith('/api/inbox/reveal')) return json({ show: true, reveal: { next: null }, board: { on: false } });
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = '';
  globalThis.fetch = savedFetch;
  Object.assign(reveal.REVEAL_TIMES, savedTimes);
});

const wait = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));
async function until(done: () => boolean, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!done() && Date.now() < end) await wait(10);
}
const reveals = () => posts.filter((p) => p.path.endsWith('/api/inbox/reveal'));
const claims = () => reveals().filter((p) => p.body.answer === undefined);
const card = () => document.querySelector<HTMLDialogElement>('dialog[data-dialog="grill-me-tip"]');

const ROW = { thread_id: 'msg_a', section: 'sent', unseen: 0 } as InboxListRow;

function loaded(threadId: string, answer: 'sent' | 'skipped' | 'none') {
  const question = {
    kind: 'single',
    answer: answer === 'none' ? null : { skipped: answer === 'skipped' },
    revision: answer === 'none' ? 0 : 1,
    sent_revision: answer === 'none' ? 0 : 1,
    superseded_by: null,
  };
  reveal.noteRevealThread({ thread_id: threadId, messages: [{ author: { kind: 'agent', host: 'claude-code', session: 's1' }, body: 'Which way?', questions: [question] }] } as unknown as InboxThread);
}

interface State {
  due: boolean;
  thread: string | null;
  idle?: boolean;
}

const BASE: State = { due: true, thread: 'msg_a' };

function Harness({ state }: { state: State }) {
  const r = reveal.useLineReveal({
    id: 'grill_me_tip',
    due: state.due,
    blocked: false,
    rows: [ROW],
    toast: false,
    thread: state.thread,
    clear: true,
    place: state.thread ?? '',
    heldBack: () => false,
    leaveCounts: (visit, now, _row, next) => reveal.grillMeTipLeaveCounts(visit, now, next),
    idle: state.idle === true,
    idleCounts: reveal.grillMeTipIdleCounts,
    mayClaim: () => true,
    holds: () => true,
  });
  return r.stage === 'open' ? <tip.GrillMeTip phone={false} onClose={r.close} /> : null;
}

function mount(state: State) {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<Harness state={state} />);
  });
  return (next: State) => act(() => root!.render(<Harness state={next} />));
}

async function readThread(answer: 'sent' | 'skipped' | 'none' = 'sent', state: State = BASE) {
  loaded('msg_a', answer);
  const render = mount(state);
  await wait(TIMES.readMs + 20);
  return render;
}

describe.skipIf(!hasDom)('the grill-me tip', () => {
  test('never on load; back on the list from a thread where the person answered a question, it opens with its words and one button', async () => {
    const render = await readThread();
    expect(card()).toBeNull();
    expect(claims()).toHaveLength(0);
    render({ ...BASE, thread: null });
    await until(() => card() !== null);
    expect(claims().map((c) => c.body.id)).toEqual(['grill_me_tip']);
    const copy = tip.GRILL_ME_TIP_COPY;
    expect(card()!.querySelector('h2')!.textContent).toBe(copy.title);
    expect(card()!.querySelector('h2 code')!.textContent).toBe('/grill-me');
    expect(card()!.querySelector('#ib-gm-desc')!.textContent).toBe(copy.body);
    expect(card()!.textContent).toContain(copy.reach);
    expect(card()!.getAttribute('aria-labelledby')).toBe('ib-gm-title');
    expect([...card()!.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Got it']);
  });

  for (const [name, answer] of [
    ['no answer', 'none'],
    ['only a skip', 'skipped'],
  ] as const) {
    test(`a thread with ${name} is not the moment`, async () => {
      const render = await readThread(answer);
      render({ ...BASE, thread: null });
      await wait(TIMES.settledMs + 80);
      expect(card()).toBeNull();
      expect(claims()).toHaveLength(0);
    });
  }

  test('left too soon, or for another thread: not the moment', async () => {
    loaded('msg_a', 'sent');
    const render = mount(BASE);
    render({ ...BASE, thread: null });
    await wait(TIMES.settledMs + 80);
    expect(card()).toBeNull();
    render({ ...BASE, thread: 'msg_a' });
    await wait(TIMES.readMs + 20);
    render({ ...BASE, thread: 'msg_b' });
    await wait(TIMES.settledMs + 80);
    expect(card()).toBeNull();
    expect(claims()).toHaveLength(0);
  });

  test('a thread kept open: the page idle on a thread with an answer is the moment', async () => {
    const render = await readThread();
    await wait(TIMES.pageAgeMs);
    render({ ...BASE, idle: true });
    await until(() => card() !== null);
    expect(claims().map((c) => c.body.id)).toEqual(['grill_me_tip']);
  });

  test('Got it closes it for good: no Not now, and the next leave claims nothing', async () => {
    const render = await readThread();
    render({ ...BASE, thread: null });
    await until(() => card() !== null);
    act(() => document.querySelector<HTMLButtonElement>('[data-grill-me-tip-ok]')!.click());
    expect(card()).toBeNull();
    render({ ...BASE, thread: 'msg_a' });
    await wait(TIMES.readMs + 20);
    render({ ...BASE, thread: null });
    await wait(TIMES.settledMs + 80);
    expect(card()).toBeNull();
    expect(reveals()).toHaveLength(1);
  });

  test('Escape closes it for good, without a Not now', async () => {
    const render = await readThread();
    render({ ...BASE, thread: null });
    await until(() => card() !== null);
    act(() => {
      card()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    await until(() => card() === null);
    expect(card()).toBeNull();
    await wait(40);
    expect(reveals()).toHaveLength(1);
  });
});
