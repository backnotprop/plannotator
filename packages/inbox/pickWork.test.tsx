/**
 * Tidy… and Combine… on the picked rows (approval "inbox-multi-select", 4A and 4b), on the window's own InboxList:
 * the wide bar has both as buttons and Combine… is greyed with one pick; beside an open thread they are the ⋯'s first
 * items; Tidy… reads and asks about the picked threads only, with the person's words; Combine… names who can write
 * it, sends the picks, the chosen session and the words, and ends picking; threads on two machines are said so and
 * nobody is offered; a row in a Combine still waiting says "Combining…" and draws again when that changes.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxCombineRecord, InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import type { BulkWrites } from './bulkWrites';
import type { MachinesModel } from './machines';

const hasDom = typeof document !== 'undefined';
const { InboxList } = (hasDom ? await import('./components/InboxList') : {}) as typeof import('./components/InboxList');
const { CombineDialog } = (hasDom ? await import('./components/CombineDialog') : {}) as typeof import('./components/CombineDialog');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');

let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;
const requests: { method: string; url: string; body: Record<string, unknown> | null }[] = [];
let answers: (url: string, method: string) => unknown = () => ({});
beforeEach(() => {
  if (!hasDom) return;
  requests.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    requests.push({ method, url, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null });
    return new Response(JSON.stringify(answers(url, method)), { status: 200, headers: { 'Content-Type': 'application/json' } });
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

const AGO = '2026-10-10T10:00:00.000Z';
function row(id: string, extra: Partial<InboxListRow> = {}): InboxListRow {
  return {
    thread_id: id,
    project_id: 'prj_1',
    subject: `Thread ${id}`,
    author: { kind: 'agent', host: 'claude-code', session: `ses_${id}`, name: null },
    created_at: AGO,
    last_at: AGO,
    last_agent_at: AGO,
    last_author: 'agent',
    message_count: 1,
    resolved_at: null,
    questions: { open: 0, picked: 0, stopped: false, holds_up: [], prompt: null, actions: 0 },
    waiting_on_person: true,
    project: { id: 'prj_1', name: 'alpha' },
    thread_name: null,
    section: 'waiting',
    unread: false,
    answered_not_sent: false,
    waiting_since: null,
    unseen: 0,
    sent: null,
    guide: false,
    priority: null,
    ...extra,
  } as InboxListRow;
}

const RECORD: InboxCombineRecord = { id: 'cmb_1', threads: [{ id: 'a', subject: 'Thread a' }, { id: 'b', subject: 'Thread b' }], session: 'ses_a', host: 'claude-code', name: 'Billing work', at: AGO, state: 'asked' };
const begun: { record: InboxCombineRecord; machine: string | null; rows: string[] }[] = [];
const bulk = {
  archive: async () => {},
  snooze: async () => {},
  markRead: async () => {},
  markUnread: async () => {},
  star: async () => {},
  priority: async () => {},
  combines: {
    waiting: new Map(),
    begin: (record: InboxCombineRecord, machine: string | null, rows: readonly InboxListRow[]) => void begun.push({ record, machine, rows: rows.map((r) => r.thread_id) }),
    stop: async () => {},
  },
} as unknown as BulkWrites;

function draw(sections: InboxListSection[], narrow = false): void {
  if (!host) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  }
  act(() => {
    root!.render(
      <SidebarProvider>
        <div className="pn-inbox">
          <InboxList title="Inbox" path={null} scope={null} sections={sections} filtered={false} narrow={narrow} selectedThreadId={narrow ? 'd' : null} notice={null} onShowNew={() => {}} onOpen={() => {}} onRowAction={() => {}} bulk={bulk} pinned={new Set()} />
        </div>
      </SidebarProvider>,
    );
  });
}
const SECTIONS = (extra: Partial<Record<string, Partial<InboxListRow>>> = {}): InboxListSection[] => [{ id: 'waiting', label: 'Waiting on you', threads: ['a', 'b', 'c', 'd'].map((id) => row(id, extra[id])) }];
const rowEl = (id: string) => host!.querySelector<HTMLElement>(`.ib-lbody [data-thread-id="${id}"]`)!;
const pick = (id: string) => act(() => rowEl(id).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true })));
const click = (el: Element | null) => act(() => void (el as HTMLElement).click());
const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 20))));
const type = (el: HTMLTextAreaElement, value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });

test.skipIf(!hasDom)('the wide bar has Tidy… and Combine…; Combine… is greyed with one pick and opens its dialog with two', async () => {
  answers = (url) => (url.includes('/combine') ? { serverSession: 's', agents: [{ session: 'ses_a', host: 'claude-code', name: 'Claude Code', title: 'Billing work', threads: 2 }], combines: [] } : {});
  draw(SECTIONS());
  pick('a');
  const combineBtn = () => host!.querySelector<HTMLButtonElement>('[data-pick-bar] [data-pick-combine]')!;
  expect(host!.querySelector('[data-pick-bar] [data-pick-tidy]')?.textContent).toBe('Tidy…');
  expect(combineBtn().getAttribute('aria-disabled')).toBe('true');
  click(combineBtn());
  expect(document.querySelector('[data-dialog="combine"]')).toBeNull();
  pick('b');
  expect(combineBtn().getAttribute('aria-disabled')).toBeNull();
  click(combineBtn());
  await settle();
  const dialog = document.querySelector('[data-dialog="combine"]')!;
  expect(dialog.querySelector('h2')?.textContent).toBe('Combine 2 threads');
  // Not the field: on a phone a focused field opens the keyboard over the dialog.
  expect(document.activeElement?.textContent).toBe('Cancel');
  expect(requests.some((r) => r.method === 'GET' && r.url.includes('/api/inbox/combine?threads=a,b'))).toBe(true);
  const option = dialog.querySelector('[data-combine-agent="ses_a"]')!;
  expect(option.querySelector('input')!.checked).toBe(true);
  // Named by host and title, the count under it.
  expect(option.querySelector('b')?.textContent).toBe('Claude Code · Billing work');
  expect(option.querySelector('small')?.textContent).toBe('2 of these');
  expect(dialog.querySelector('.ib-cmb-what')?.textContent).toBe('Claude Code · Billing work gets one prompt with the 2 threads. Open questions are asked again in the new thread. Undo brings the 2 back.');
  type(dialog.querySelector<HTMLTextAreaElement>('[data-combine-words]')!, '  just   the billing work ');
  answers = () => ({ combine: RECORD });
  click(dialog.querySelector('[data-combine-go]'));
  await settle();
  const sent = requests.find((r) => r.method === 'POST' && r.url.endsWith('/api/inbox/combine'))!;
  expect(sent.body).toMatchObject({ thread_ids: ['a', 'b'], session: 'ses_a', words: 'just the billing work' });
  expect(typeof sent.body!.idempotency_key).toBe('string');
  expect(begun.at(-1)).toEqual({ record: RECORD, machine: null, rows: ['a', 'b'] });
  // Started: the dialog closes and picking ends.
  expect(document.querySelector('[data-dialog="combine"]')).toBeNull();
  expect(host!.querySelector('[data-pick-bar]')).toBeNull();
});

test.skipIf(!hasDom)('beside an open thread Tidy… and Combine… are the ⋯ menu’s first items, not buttons', async () => {
  draw(SECTIONS(), true);
  pick('a');
  expect(host!.querySelector('[data-pick-bar] [data-pick-tidy]')).toBeNull();
  expect(host!.querySelector('[data-pick-bar] [data-pick-combine]')).toBeNull();
  const more = host!.querySelector<HTMLElement>('[data-pick-bar] [data-pick-menu="more"]')!;
  act(() => {
    more.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    more.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    more.click();
  });
  await settle();
  const items = [...document.querySelectorAll('[data-pick-popup="more"] [role="menuitem"]')];
  expect(items[0]?.getAttribute('data-pick-work')).toBe('tidy');
  expect(items[1]?.getAttribute('data-pick-work')).toBe('combine');
  // One pick: Combine… is there, greyed.
  expect(items[1]?.getAttribute('aria-disabled')).toBe('true');
});

test.skipIf(!hasDom)('Tidy… reads and asks about the picked threads only, with the person’s words', async () => {
  const plan = { serverSession: 's', count: 2, agents: [{ session: 'ses_a', host: 'claude-code', name: 'Claude Code', reach: 'wakes', items: [{ thread_id: 'a' }, { thread_id: 'c' }] }], run: null, unreached: { ended: 1, asked: 0 }, recent: ['Ask me only what blocks you'] };
  answers = (_url, method) => (method === 'GET' ? plan : { run: null, asked: ['ses_a'] });
  draw(SECTIONS());
  pick('a');
  pick('c');
  pick('d');
  click(host!.querySelector('[data-pick-bar] [data-pick-tidy]'));
  await settle();
  const read = requests.find((r) => r.method === 'GET' && r.url.includes('/api/inbox/tidy'))!;
  expect(new URL(read.url, 'http://x').searchParams.get('threads')).toBe('a,c,d');
  const pop = document.querySelector('[data-pick-tidy-popover]')!;
  expect(pop.querySelector('.ib-tidy-top')?.textContent).toBe('Tidy3 selected');
  expect(pop.textContent).toContain('1 thread has no agent to ask: its session ended.');
  // Recent fills the field.
  click(pop.querySelector('[data-tidy-recent]'));
  expect(pop.querySelector<HTMLTextAreaElement>('[data-tidy-words]')!.value).toBe('Ask me only what blocks you');
  click(pop.querySelector('[data-tidy-go]'));
  await settle();
  const sent = requests.find((r) => r.method === 'POST' && r.url.endsWith('/api/inbox/tidy'))!;
  expect(sent.body).toMatchObject({ sessions: ['ses_a'], thread_ids: ['a', 'c', 'd'], words: 'Ask me only what blocks you', surface: 'list' });
  // Asked a moment ago is why nobody is left: the popover does not say they cannot be reached.
  answers = () => ({ ...plan, agents: [], unreached: { ended: 0, asked: 3 } });
  click(host!.querySelector('[data-pick-bar] [data-pick-tidy]'));
  await settle();
  const again = document.querySelector('[data-pick-tidy-popover]')!;
  expect(again.textContent).toContain('3 threads’ agents were asked a moment ago.');
  expect(again.textContent).not.toContain('can be reached');
});

test.skipIf(!hasDom)('threads on two machines: the dialog says so, offers nobody and reads nothing', async () => {
  const machines: MachinesModel = {
    self: 'm_self',
    all: [{ id: 'm_self', name: 'MacBook', self: true } as never, { id: 'm_mini', name: 'Mac mini', marks: ['combine', 'tidy'] } as never],
    linked: [{ id: 'm_mini', name: 'Mac mini', marks: ['combine', 'tidy'] } as never],
    names: new Map([['m_mini', 'Mac mini']]),
    away: new Set(),
  } as MachinesModel;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<div className="pn-inbox"><CombineDialog rows={[row('a'), row('b', { machine: 'm_mini' } as Partial<InboxListRow>)]} machines={machines} onClose={() => {}} onStarted={() => {}} /></div>));
  await settle();
  const dialog = document.querySelector('[data-dialog="combine"]')!;
  expect(dialog.querySelector('.ib-cmb-why')?.textContent).toBe('These threads are on two machines, MacBook and Mac mini. An agent reads only the threads on its own machine: pick threads from one machine to combine them.');
  expect(dialog.querySelector('[data-combine-agent]')).toBeNull();
  expect(dialog.querySelector<HTMLButtonElement>('[data-combine-go]')!.disabled).toBe(true);
  expect(requests).toHaveLength(0);
});

for (const many of [10, 25])
  test.skipIf(!hasDom)(`${many} agents: the top writer is picked, four show, "Show ${many - 4} more" and the arrows reach the rest in a bounded box`, async () => {
    // As the server orders them: most picked threads first.
    const agents = Array.from({ length: many }, (_, i) => ({ session: `ses_${i}`, host: 'claude-code', name: 'Claude Code', title: `Session ${i}`, threads: i === 0 ? 3 : 1 }));
    answers = (url) => (url.includes('/combine') ? { serverSession: 's', agents, combines: [] } : {});
    const style = document.head.appendChild(document.createElement('style'));
    style.textContent = readFileSync(join(import.meta.dir, 'picks.css'), 'utf8');
    host = document.body.appendChild(document.createElement('div'));
    root = createRoot(host);
    act(() => root!.render(<div className="pn-inbox"><CombineDialog rows={[row('a'), row('b'), row('c')]} onClose={() => {}} onStarted={() => {}} /></div>));
    await settle();
    const dialog = document.querySelector('[data-dialog="combine"]')!;
    const shown = () => [...dialog.querySelectorAll('[data-combine-agent]')].map((el) => el.getAttribute('data-combine-agent'));
    expect(shown()).toEqual(['ses_0', 'ses_1', 'ses_2', 'ses_3']);
    expect(dialog.querySelector<HTMLInputElement>('[data-combine-agent="ses_0"] input')!.checked).toBe(true);
    const more = dialog.querySelector<HTMLButtonElement>('[data-combine-more]')!;
    expect(more.textContent).toBe(`Show ${many - 4} more`);
    // Down from the fourth shows them all and moves to the fifth.
    click(dialog.querySelector('[data-combine-agent="ses_3"] input'));
    act(() => void dialog.querySelector('.ib-cmb-list')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    await settle();
    expect(shown()).toHaveLength(many);
    expect(dialog.querySelector<HTMLInputElement>('[data-combine-agent="ses_4"] input')!.checked).toBe(true);
    expect(dialog.querySelector('[data-combine-more]')).toBeNull();
    // All of them scroll inside a box with a ceiling, so the dialog does not grow with them.
    const list = getComputedStyle(dialog.querySelector('.ib-cmb-list')!);
    expect(list.overflowY).toBe('auto');
    expect(list.maxHeight).not.toBe('none');
    style.remove();
  });

test.skipIf(!hasDom)('"Show N more" shows every agent and gives the focus to the first it showed', async () => {
  const agents = Array.from({ length: 10 }, (_, i) => ({ session: `ses_${i}`, host: 'claude-code', name: 'Claude Code', title: `Session ${i}`, threads: 1 }));
  answers = (url) => (url.includes('/combine') ? { serverSession: 's', agents, combines: [] } : {});
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
  act(() => root!.render(<div className="pn-inbox"><CombineDialog rows={[row('a'), row('b')]} onClose={() => {}} onStarted={() => {}} /></div>));
  await settle();
  click(document.querySelector('[data-combine-more]'));
  await settle();
  expect(document.querySelectorAll('[data-combine-agent]')).toHaveLength(10);
  expect(document.activeElement?.closest('[data-combine-agent]')?.getAttribute('data-combine-agent')).toBe('ses_4');
});

test.skipIf(!hasDom)('two agents that read the same are told apart by when they last wrote; others are not', async () => {
  const twin = (session: string, at: string) => ({ session, host: 'codex', name: 'Codex', project: 'plannotator', thread: 'Release notes 0.29', wrote_at: at, threads: 1 });
  const agents = [twin('ses_x', '2026-11-14T23:42:00.000Z'), twin('ses_y', '2026-11-14T22:05:00.000Z'), { session: 'ses_z', host: 'pi', name: 'Pi', project: 'docs-site', wrote_at: '2026-11-14T21:00:00.000Z', threads: 1 }];
  answers = (url) => (url.includes('/combine') ? { serverSession: 's', agents, combines: [] } : {});
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
  act(() => root!.render(<div className="pn-inbox"><CombineDialog rows={[row('a'), row('b')]} onClose={() => {}} onStarted={() => {}} /></div>));
  await settle();
  const sub = (session: string) => document.querySelector(`[data-combine-agent="${session}"] small`)!.textContent!;
  expect(document.querySelector('[data-combine-agent="ses_x"] b')!.textContent).toBe('Codex · Release notes 0.29');
  expect(sub('ses_x')).toMatch(/^1 of these · last wrote \S/);
  expect(sub('ses_x')).not.toBe(sub('ses_y'));
  expect(sub('ses_z')).toBe('1 of these');
});

test.skipIf(!hasDom)('two agents that read the same and last wrote the same minute are told apart by project, then by their session', async () => {
  const at = '2026-11-14T23:42:00.000Z';
  const codex = (session: string, project: string) => ({ session, host: 'codex', name: 'Codex', title: 'Release notes 0.29', project, wrote_at: at, threads: 1 });
  const agents = [codex('019a-0000-1111-aaaa', 'plannotator'), codex('019a-0000-2222-aaaa', 'plannotator'), codex('019a-0000-3333-bbbb', 'docs-site')];
  answers = (url) => (url.includes('/combine') ? { serverSession: 's', agents, combines: [] } : {});
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
  act(() => root!.render(<div className="pn-inbox"><CombineDialog rows={[row('a'), row('b')]} onClose={() => {}} onStarted={() => {}} /></div>));
  await settle();
  const line = (session: string) => {
    const el = document.querySelector(`[data-combine-agent="${session}"]`)!;
    return `${el.querySelector('b')!.textContent} / ${el.querySelector('small')!.textContent}`;
  };
  expect(line('019a-0000-1111-aaaa')).toBe('Codex · Release notes 0.29 / 1 of these · plannotator · session 1-aaaa');
  expect(line('019a-0000-2222-aaaa')).toBe('Codex · Release notes 0.29 / 1 of these · plannotator · session 2-aaaa');
  expect(line('019a-0000-3333-bbbb')).toBe('Codex · Release notes 0.29 / 1 of these · docs-site');
  expect(new Set(agents.map((a) => line(a.session))).size).toBe(3);
});

test.skipIf(!hasDom)('a row in a Combine still waiting says “Combining…”, and draws again when it settles', () => {
  draw(SECTIONS({ b: { combining: true } }));
  const before = rowEl('b');
  expect(before.textContent).toContain('Combining…');
  expect(rowEl('a').textContent).not.toContain('Combining…');
  draw(SECTIONS());
  expect(rowEl('b')).toBe(before);
  expect(rowEl('b').textContent).not.toContain('Combining…');
});
