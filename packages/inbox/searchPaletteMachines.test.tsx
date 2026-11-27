import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxSearchAnswer, InboxSearchThreadRow } from '@plannotator/core/inbox-search';
import { rememberMachine, resetMachineRoutes, setSelfMachine } from './inboxUrl';
import type { MachineView } from './api';

const hasDom = typeof document !== 'undefined';
const { default: SearchPalette } = (hasDom ? await import('./search/SearchPalette') : {}) as typeof import('./search/SearchPalette');

type Answer = InboxSearchAnswer & { serverSession: string; recent_searches?: string[] };

const SELF = `ibx_01K${'0'.repeat(22)}S`;
const MAC = `ibx_01K${'0'.repeat(22)}M`;
const MINI = `ibx_01K${'0'.repeat(22)}N`;
const linked = [
  { id: MAC, name: 'MacBook', self: false, state: 'offline', since: '2026-11-20T09:00:00Z' },
  { id: MINI, name: 'Mini', self: false, state: 'online', since: '2026-11-20T09:00:00Z' },
] as unknown as MachineView[];
const here = { id: 'prj_01M4V7JERHR0Y3XQERK1MR604A', name: 'api' };
const far = { id: 'prj_01M4V7JERHR0Y3XQERK1MR604C', name: 'web' };

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let respond: (url: URL) => Promise<Answer> = async () => answer({});
let opened: string[] = [];

function threadRow(id: string, machine?: string): InboxSearchThreadRow {
  return { type: 'thread', id, thread_id: id, project: machine ? { ...far, machine } : here, section: 'quiet', archived: false, at: '2026-11-20T10:00:00Z', title: `Deploy ${id}`, title_marks: [], thread_name: null };
}
function answer(input: Partial<Answer>): Answer {
  return { serverSession: 's', q: '', terms: [], took_ms: 1, indexing: false, threads: 5, totals: null, groups: null, recent: [], recent_searches: [], ...input };
}
const found = (rows: InboxSearchThreadRow[], extra: Partial<Answer> = {}) =>
  answer({ q: 'deploy', terms: ['deploy'], totals: { threads: rows.length, messages: 0, files: 0, projects: 0 }, groups: { threads: rows }, recent: null, ...extra });
const merged = (url: URL) => url.searchParams.get('machines') === '1';

beforeEach(() => {
  if (!hasDom) return;
  setSelfMachine(SELF);
  opened = [];
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const value = await respond(new URL(String(input), 'http://127.0.0.1:1'));
    return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  globalThis.fetch = savedFetch;
  resetMachineRoutes();
});

async function render(): Promise<void> {
  await act(async () => {
    root!.render(
      <SearchPalette
        open
        phone={false}
        currentProject={null}
        projects={[{ ...here, root: '/src/api' }, { ...far, root: '/src/web' }]}
        projectLabels={new Map([[here.id, 'api'], [far.id, 'web · MacBook']])}
        linkedMachines={linked}
        onClose={() => {}}
        onOpenResult={(hash) => opened.push(hash)}
      />,
    );
  });
}
async function waitFor(check: () => boolean, ms = 2000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('waitFor timed out');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
}
const input = () => host!.querySelector<HTMLInputElement>('[role="combobox"]')!;
const ids = () => [...host!.querySelectorAll<HTMLElement>('[role="option"]')].map((option) => option.getAttribute('data-result-id'));
const highlighted = () => host!.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')?.getAttribute('data-result-id');
async function type(value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input(), value);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const key = async (init: KeyboardEventInit) => {
  await act(async () => {
    input().dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  });
};

test.skipIf(!hasDom)("this machine's rows show while a linked machine never answers", async () => {
  respond = (url) => (merged(url) ? new Promise(() => {}) : Promise.resolve(url.searchParams.get('q') ? found([threadRow('thr_here1'), threadRow('thr_here2')]) : answer({})));
  await render();
  await type('deploy');
  await waitFor(() => ids().length === 2);
  expect(ids()).toEqual(['thr_here1', 'thr_here2']);
  await key({ key: 'Enter' });
  expect(opened).toHaveLength(1);
});

test.skipIf(!hasDom)('the highlighted row stays highlighted when the other machines’ rows arrive, and Enter opens it', async () => {
  let arrive: (value: Answer) => void = () => {};
  const local = [threadRow('thr_here1'), threadRow('thr_here2'), threadRow('thr_here3')];
  respond = (url) => {
    if (!url.searchParams.get('q')) return Promise.resolve(answer({}));
    return merged(url) ? new Promise((resolve) => (arrive = resolve)) : Promise.resolve(found(local));
  };
  await render();
  await type('deploy');
  await waitFor(() => ids().length === 3);
  await key({ key: 'ArrowDown' });
  expect(highlighted()).toBe('thr_here2');
  await act(async () => arrive(found([threadRow('thr_far1', MAC), threadRow('thr_here1'), threadRow('thr_far2', MAC), threadRow('thr_here2'), threadRow('thr_here3')])));
  await waitFor(() => ids().length === 5);
  expect(ids()).toEqual(['thr_far1', 'thr_here1', 'thr_far2', 'thr_here2', 'thr_here3']);
  expect(highlighted()).toBe('thr_here2');
  await key({ key: 'Enter' });
  expect(opened[0]).toContain('thr_here2');
});

test.skipIf(!hasDom)('machines that did not answer are named, asleep in the list’s words: under the results, and in place of No results for its project', async () => {
  rememberMachine([far.id], MAC);
  respond = async (url) => {
    if (url.searchParams.get('project') === far.id) return merged(url) ? answer({ totals: { threads: 0, messages: 0, files: 0, projects: 0 }, groups: { threads: [] }, recent: null, unanswered: [{ id: MAC, name: 'MacBook' }] }) : Promise.reject(new Error('asked this machine for another machine’s project'));
    if (!url.searchParams.get('q')) return answer({});
    return found([threadRow('thr_here1')], merged(url) ? { unanswered: [{ id: MAC, name: 'MacBook' }, { id: MINI, name: 'Mini' }] } : {});
  };
  await render();
  await type('deploy');
  await waitFor(() => host!.querySelector('[data-search-unanswered]') !== null);
  expect(host!.querySelector('[data-search-unanswered]')!.textContent).toBe('MacBook is asleep · Mini didn’t answer');
  expect(ids()).toEqual(['thr_here1']);
  await type('');
  await act(async () => host!.querySelector<HTMLElement>('[data-chip="project"]')!.click());
  await act(async () => [...host!.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((item) => item.textContent === 'web · MacBook')!.click());
  await waitFor(() => host!.querySelector('[data-search-none]') !== null);
  expect(host!.querySelector('[data-search-none] > span')!.textContent).toBe('MacBook is asleep');
  expect(host!.textContent).not.toContain('No threads match');
});
