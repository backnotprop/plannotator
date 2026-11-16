/**
 * The idempotency keys of Combine's dialog and Tidy's panel (pressKeys.ts). A linked machine's door keeps every answer
 * under 500 per key, refusals included. What this catches: a refusal kept under the dialog's one key, so a changed
 * pick (another agent, other words) gets the old refusal back until the dialog is opened again; a retry after a lost
 * answer sent under a new key (two Combines, two Tidies); a double press sending twice.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxCombineRecord, InboxListRow } from '@plannotator/core/inbox-types';
import { InboxApiError } from './apiError';
import type { MachinesModel } from './machines';
import type { TidyController } from './components/Tidy';
import type { TidyAcrossAgent } from './tidyAcross';

const hasDom = typeof document !== 'undefined';
const { CombineDialog } = (hasDom ? await import('./components/CombineDialog') : {}) as typeof import('./components/CombineDialog');
const { TidyPanel } = (hasDom ? await import('./components/TidyPanel') : {}) as typeof import('./components/TidyPanel');
const { startAcross } = (hasDom ? await import('./tidyAcross') : {}) as typeof import('./tidyAcross');

const MACHINES = { self: 'm_self', all: [], linked: [{ id: 'm_mini', name: 'Mac mini', marks: ['combine', 'tidy'], state: 'online' }], names: new Map([['m_mini', 'Mac mini']]), away: new Set() } as unknown as MachinesModel;
const RECORD: InboxCombineRecord = { id: 'cmb_1', threads: [{ id: 'a', subject: 'A' }, { id: 'b', subject: 'B' }], session: 'ses_b', host: 'claude-code', name: 'Billing work', at: '2026-11-14T10:00:00.000Z', state: 'asked' };
const AGENTS = [
  { session: 'ses_a', host: 'claude-code', name: 'Claude Code', title: 'Billing', threads: 2 },
  { session: 'ses_b', host: 'codex', name: 'Codex', title: 'Billing', threads: 1 },
];
const refusal = () => new Response(JSON.stringify({ code: 'session_not_live', error: 'That session ended.' }), { status: 409, headers: { 'Content-Type': 'application/json' } });
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;
const posts: Record<string, unknown>[] = [];
/** The next POST answers, in order; a function throws (a network error). */
let answers: (Response | (() => never))[] = [];
beforeEach(() => {
  if (!hasDom) return;
  posts.length = 0;
  answers = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'GET') return ok(String(input).includes('/combine') ? { serverSession: 's', agents: AGENTS, combines: [] } : {});
    posts.push(JSON.parse(String(init!.body)) as Record<string, unknown>);
    const next = answers.shift() ?? ok({ combine: RECORD });
    return typeof next === 'function' ? next() : next;
  }) as typeof fetch;
});
afterEach(() => {
  if (!hasDom) return;
  globalThis.fetch = realFetch;
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  document.body.innerHTML = '';
});

const row = (id: string) => ({ thread_id: id, machine: 'm_mini' }) as unknown as InboxListRow;
const click = (el: Element | null) => act(() => void (el as HTMLElement).click());
const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 20))));
const type = (el: HTMLTextAreaElement, value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
function mount(node: React.ReactNode): void {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<div className="pn-inbox">{node}</div>));
}

async function combineDialog() {
  const started: InboxCombineRecord[] = [];
  mount(<CombineDialog rows={[row('a'), row('b')]} machines={MACHINES} onClose={() => {}} onStarted={(record) => void started.push(record)} />);
  await settle();
  const dialog = document.querySelector('[data-dialog="combine"]')!;
  return { dialog, started, go: () => dialog.querySelector<HTMLButtonElement>('[data-combine-go]')! };
}

test.skipIf(!hasDom)('Combine on a linked machine: refused for one agent, then another picked in the same dialog, goes through under a new key', async () => {
  const { dialog, started, go } = await combineDialog();
  answers = [refusal()];
  click(go());
  await settle();
  expect(dialog.querySelector('.ib-cmb-err')?.textContent).toBe('That session ended.');
  click(dialog.querySelector('[data-combine-agent="ses_b"] input'));
  click(go());
  await settle();
  expect(posts.map((p) => p.session)).toEqual(['ses_a', 'ses_b']);
  expect(posts[1]!.idempotency_key).not.toBe(posts[0]!.idempotency_key);
  expect(started.map((r) => r.id)).toEqual(['cmb_1']);
});

test.skipIf(!hasDom)('Combine: a retry after a lost answer or a 5xx sends the same key; a double press sends once', async () => {
  const { started, go } = await combineDialog();
  answers = [
    () => {
      throw new TypeError('Failed to fetch');
    },
    new Response('{}', { status: 502 }),
  ];
  click(go());
  await settle();
  click(go());
  await settle();
  act(() => {
    go().click();
    go().click();
  });
  await settle();
  expect(posts).toHaveLength(3);
  expect(new Set(posts.map((p) => p.idempotency_key)).size).toBe(1);
  expect(started).toHaveLength(1);
});

function tidyPanel(send: (machine: string | null, key: string, words: string | undefined) => Promise<unknown>) {
  const agents = [{ session: 'ses_far', host: 'claude-code', name: 'Claude Code', reach: 'wakes', items: [{ thread_id: 'a' }], machine: 'm_mini', machineName: 'Mac mini' }] as unknown as TidyAcrossAgent[];
  let done = 0;
  const tidy: TidyController = {
    surface: 'list',
    scope: null,
    plan: { serverSession: 's', count: 1, agents, run: null } as unknown as TidyController['plan'],
    run: null,
    refresh: () => {},
    start: (picked, keys, words) => startAcross(picked, keys, (machine, _sessions, key) => send(machine, key, words)),
  };
  mount(<TidyPanel tidy={tidy} onDone={() => void done++} />);
  return { done: () => done, go: () => document.querySelector<HTMLButtonElement>('[data-tidy-go]')!, words: () => document.querySelector<HTMLTextAreaElement>('[data-tidy-words]')! };
}

test.skipIf(!hasDom)('Tidy with words on a linked machine: refused, then changed words go through under a new key; a lost answer keeps it; a double press sends once', async () => {
  const sent: { key: string; words: string | undefined }[] = [];
  const script: (Error | null)[] = [new InboxApiError(422, 'nothing_to_tidy', 'Nothing to tidy.'), new TypeError('Failed to fetch'), null];
  const { done, go, words } = tidyPanel(async (_machine, key, said) => {
    sent.push({ key, words: said });
    const fail = script.shift();
    if (fail) throw fail;
  });
  type(words(), 'Only the billing threads');
  click(go());
  await settle();
  expect(document.querySelector('.ib-tidy-err')?.textContent).toBe('Nothing to tidy.');
  type(words(), 'Only the release threads');
  click(go());
  await settle();
  act(() => {
    go().click();
    go().click();
  });
  await settle();
  expect(sent.map((s) => s.words)).toEqual(['Only the billing threads', 'Only the release threads', 'Only the release threads']);
  expect(sent[1]!.key).not.toBe(sent[0]!.key);
  expect(sent[2]!.key).toBe(sent[1]!.key);
  expect(sent.every((s) => s.key.endsWith('-m_mini'))).toBe(true);
  expect(done()).toBe(1);
});
