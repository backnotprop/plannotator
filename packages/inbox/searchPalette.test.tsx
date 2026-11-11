import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxSearchAnswer, InboxSearchRow, InboxSearchThreadRow } from '@plannotator/core/inbox-search';
import { tooltipOf } from './testing/tooltip';

const hasDom = typeof document !== 'undefined';
const { default: SearchPalette } = (hasDom ? await import('./search/SearchPalette') : {}) as typeof import('./search/SearchPalette');
const { searchHitRanges } = (hasDom ? await import('./search/highlight') : {}) as typeof import('./search/highlight');

type Answer = InboxSearchAnswer & { serverSession: string; recent_searches?: string[] };
type Call = { url: URL; method: string; body: unknown };

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let calls: Call[] = [];
let respond: (call: Call) => Promise<Answer | Record<string, unknown> | Response> = async () => answer({});
let opened: { hash: string; land: unknown }[] = [];
let closed: string[] = [];

const project = { id: 'prj_01M4V7JERHR0Y3XQERK1MR604A', name: 'plannotator' };
const totals = (t: Partial<Record<'threads' | 'messages' | 'files' | 'projects', number>>) => ({ threads: 0, messages: 0, files: 0, projects: 0, ...t });

function threadRow(id: string, title: string, extra: Partial<InboxSearchThreadRow> = {}): InboxSearchThreadRow {
  return { type: 'thread', id, thread_id: id, project, section: 'quiet', archived: false, at: '2026-10-09T14:03:00Z', title, title_marks: [], thread_name: null, ...extra };
}
function messageRow(id: string, threadId: string, text: string, question: { key: string; replaced: boolean } | null = null): InboxSearchRow {
  return { type: 'message', id, thread_id: threadId, project, section: 'quiet', archived: false, at: '2026-10-09T14:03:00Z', author: { kind: 'agent', name: 'Claude Code' }, title: 'Retry storm', snippet: { text, marks: [[0, 4]] }, question };
}

function answer(input: Partial<Answer>): Answer {
  return { serverSession: 's', q: '', terms: [], took_ms: 1, indexing: false, threads: 12, totals: null, groups: null, recent: [], recent_searches: [], ...input };
}

const results = (q: string): Answer =>
  answer({
    q,
    terms: q.split(/\s+/).filter(Boolean),
    totals: totals({ threads: 1, messages: 12 }),
    groups: {
      threads: [threadRow('msg_t1', 'Relay: rate limit', { title_marks: [[7, 4]] })],
      messages: Array.from({ length: 8 }, (_, i) => messageRow(`msg_m${i}`, 'msg_t2', `rate limit note ${i}`, i === 0 ? { key: 'q-abc', replaced: false } : null)),
    },
    recent: null,
  });

async function waitFor(check: () => boolean, ms = 2000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('waitFor timed out');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
}

beforeEach(() => {
  if (!hasDom) return;
  calls = [];
  opened = [];
  closed = [];
  respond = async () => answer({});
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://127.0.0.1:1');
    const call = { url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const value = await respond(call);
    if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    if (value instanceof Response) return value;
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
});

async function render(props: { currentProject?: string | null; phone?: boolean } = {}): Promise<void> {
  await act(async () => {
    root!.render(
      <SearchPalette
        open
        phone={props.phone ?? false}
        currentProject={props.currentProject ?? null}
        projects={[{ ...project, root: '/src/plannotator' }, { id: 'prj_01M4V7JERHR0Y3XQERK1MR604B', name: 'api', root: '/w/api' }]}
        onClose={(reason) => closed.push(reason)}
        onOpenResult={(hash, land) => opened.push({ hash, land })}
      />,
    );
  });
}

const input = () => host!.querySelector<HTMLInputElement>('[role="combobox"]')!;
const options = () => [...host!.querySelectorAll<HTMLElement>('[role="option"]')];
const key = async (target: Element, init: KeyboardEventInit) => {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  });
};
async function type(value: string): Promise<void> {
  await act(async () => {
    const el = input();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const searches = () => calls.filter((c) => c.url.pathname === '/api/inbox/search');

test.skipIf(!hasDom)('combobox over a listbox; the first row highlighted; arrows wrap; pointermove moves the highlight', async () => {
  respond = async (call) => (call.url.searchParams.get('q') ? results(call.url.searchParams.get('q')!) : answer({}));
  await render();
  expect(input().getAttribute('aria-expanded')).toBe('true');
  expect(input().getAttribute('aria-autocomplete')).toBe('list');
  const list = host!.querySelector(`#${input().getAttribute('aria-controls')}`)!;
  expect(list.getAttribute('role')).toBe('listbox');
  expect(list.getAttribute('aria-label')).toBe('Search results');
  await type('rate lim');
  await waitFor(() => options().length === 10);
  const groups = [...host!.querySelectorAll('[role="group"]')];
  expect(groups.map((g) => host!.querySelector(`#${g.getAttribute('aria-labelledby')}`)!.textContent)).toEqual(['Threads', 'Messages12']);
  expect(options().at(-1)!.textContent).toBe('Show all 12 messages');
  expect(input().getAttribute('aria-activedescendant')).toBe(options()[0]!.id);
  expect(options()[0]!.getAttribute('aria-selected')).toBe('true');
  expect([...options()[0]!.querySelectorAll('.ib-sp-m')].map((m) => m.textContent)).toEqual(['rate']);
  await key(input(), { key: 'ArrowUp' });
  expect(input().getAttribute('aria-activedescendant')).toBe(options().at(-1)!.id);
  await key(input(), { key: 'ArrowDown' });
  expect(input().getAttribute('aria-activedescendant')).toBe(options()[0]!.id);
  await key(input(), { key: 'ArrowDown' });
  expect(input().getAttribute('aria-activedescendant')).toBe(options()[1]!.id);
  await act(async () => {
    options()[3]!.dispatchEvent(new PointerEvent('pointermove', { bubbles: true }));
  });
  expect(options()[3]!.getAttribute('aria-selected')).toBe('true');
  expect(host!.querySelector('[data-search-live]')!.textContent).toBe('13 results in 2 groups');
});

test.skipIf(!hasDom)('Enter opens: the hash and a message landing with its terms and question key; IME Enter does nothing', async () => {
  respond = async (call) => (call.url.searchParams.get('q') ? results(call.url.searchParams.get('q')!) : answer({}));
  await render();
  await type('rate lim');
  await waitFor(() => options().length === 10);
  await key(input(), { key: 'ArrowDown' });
  await key(input(), { key: 'Enter', isComposing: true });
  expect(opened).toEqual([]);
  await key(input(), { key: 'Enter' });
  expect(opened).toEqual([{ hash: '#thread=msg_t2&msg=msg_m0', land: { messageId: 'msg_m0', terms: ['rate', 'lim'], questionKey: 'q-abc' } }]);
  expect(closed).toEqual(['opened']);
  await waitFor(() => calls.some((c) => c.url.pathname === '/api/inbox/search/recent'));
  expect(calls.find((c) => c.url.pathname === '/api/inbox/search/recent')!.body).toMatchObject({ q: 'rate lim' });
});

test.skipIf(!hasDom)('typing is debounced; a stale answer is dropped; Enter during a newer query opens its first row once it lands', async () => {
  const gates = new Map<string, () => void>();
  respond = async (call) => {
    const q = call.url.searchParams.get('q')!;
    if (q === 'slow') await new Promise<void>((resolve) => gates.set(q, resolve));
    return q ? results(q) : answer({});
  };
  await render();
  await waitFor(() => searches().length === 1);
  for (const value of ['r', 'ra', 'rat', 'rate']) await type(value);
  await waitFor(() => searches().length === 2);
  expect(searches()[1]!.url.searchParams.get('q')).toBe('rate');
  await waitFor(() => options().length > 0);
  await type('slow');
  await waitFor(() => searches().some((c) => c.url.searchParams.get('q') === 'slow'));
  expect(host!.querySelector('.ib-sp-list')!.hasAttribute('data-dim')).toBe(true);
  await type('quick');
  await key(input(), { key: 'Enter' });
  await waitFor(() => opened.length === 1);
  expect(opened[0]!.hash).toBe('#thread=msg_t1');
  gates.get('slow')?.();
});

test.skipIf(!hasDom)('Show all asks for the group and expands it in place', async () => {
  respond = async (call) => {
    const q = call.url.searchParams.get('q')!;
    if (call.url.searchParams.get('group') === 'messages') {
      return answer({ q, terms: ['rate'], totals: totals({ threads: 1, messages: 12 }), groups: { messages: Array.from({ length: 12 }, (_, i) => messageRow(`msg_m${i}`, 'msg_t2', `rate ${i}`)) }, recent: null });
    }
    return q ? results(q) : answer({});
  };
  await render();
  await type('rate');
  await waitFor(() => options().length === 10);
  const more = options().at(-1)!;
  await act(async () => {
    more.click();
  });
  await waitFor(() => options().length === 13);
  const request = calls.find((c) => c.url.searchParams.get('group') === 'messages')!;
  expect(request.url.searchParams.get('offset')).toBeNull();
  expect(request.url.searchParams.get('limit')).toBe('50');
  expect(host!.querySelector('[data-show-more]')).toBeNull();
});

test.skipIf(!hasDom)('focus stays in the input: a mouse press in the list takes no focus, and after Show all the arrows go on; no option repeats its text as a title', async () => {
  respond = async (call) => {
    const q = call.url.searchParams.get('q')!;
    if (call.url.searchParams.get('group') === 'messages') {
      return answer({ q, terms: ['rate'], totals: totals({ threads: 1, messages: 12 }), groups: { messages: Array.from({ length: 12 }, (_, i) => messageRow(`msg_m${i}`, 'msg_t2', `rate ${i}`)) }, recent: null });
    }
    return q ? results(q) : answer({});
  };
  await render();
  await type('rate');
  await waitFor(() => options().length === 10);
  for (const target of [options()[1]!, host!.querySelector('.ib-sp-gh')!, options().at(-1)!]) {
    const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    target.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
  }
  expect(options().every((o) => !o.hasAttribute('title'))).toBe(true);
  input().blur();
  await act(async () => {
    options().at(-1)!.click();
  });
  await waitFor(() => options().length === 13);
  expect(document.activeElement).toBe(input());
  const before = input().getAttribute('aria-activedescendant');
  await key(input(), { key: 'ArrowDown' });
  expect(input().getAttribute('aria-activedescendant')).not.toBe(before);
});

test.skipIf(!hasDom)('while an IME composes, the arrows and Escape are its own; No matches is announced once, by the live region', async () => {
  respond = async (call) => {
    const q = call.url.searchParams.get('q')!;
    if (q === 'jitter') return answer({ q, terms: ['jitter'], totals: totals({}), groups: {}, recent: null });
    return q ? results(q) : answer({});
  };
  await render();
  await type('rate');
  await waitFor(() => options().length === 10);
  const at = input().getAttribute('aria-activedescendant');
  await key(input(), { key: 'ArrowDown', isComposing: true });
  expect(input().getAttribute('aria-activedescendant')).toBe(at);
  await key(input(), { key: 'Escape', isComposing: true });
  await act(async () => {
    input().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    host!.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true }));
  });
  expect(closed).toEqual([]);
  await act(async () => {
    input().dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 5));
  });
  await key(input(), { key: 'ArrowDown' });
  expect(input().getAttribute('aria-activedescendant')).not.toBe(at);
  await type('jitter');
  await waitFor(() => host!.querySelector('[data-search-none]') !== null);
  expect(host!.querySelector('[role="listbox"] [role="status"]')).toBeNull();
  expect(host!.querySelectorAll('[role="status"]')).toHaveLength(1);
  expect(host!.querySelector('[data-search-live]')!.textContent).toContain('No matches');
  await key(input(), { key: 'Escape' });
  expect(closed).toEqual(['dismissed']);
});

test.skipIf(!hasDom)('opened inside a project, search starts everywhere: no Only in chip, the open project only the tie boost, and other projects\' results show', async () => {
  const api = { id: 'prj_01M4V7JERHR0Y3XQERK1MR604B', name: 'api' };
  respond = async (call) => {
    const q = call.url.searchParams.get('q');
    if (!q) return answer({});
    const rows = [threadRow('msg_t1', 'Relay: rate limit', { title_marks: [[7, 4]] }), threadRow('msg_a1', 'API rate limit headers', { project: api, title_marks: [[4, 4]] })];
    const only = call.url.searchParams.get('project');
    const threads = rows.filter((row) => !only || row.project.id === only);
    return answer({ q, terms: [q], totals: totals({ threads: threads.length }), groups: { threads }, recent: null });
  };
  await render({ currentProject: project.id });
  await waitFor(() => searches().length === 1);
  expect(searches()[0]!.url.searchParams.get('project')).toBeNull();
  expect(searches()[0]!.url.searchParams.get('current')).toBe(project.id);
  expect(host!.querySelector('[data-chip="project"]')!.textContent).toBe('All projects');
  expect(host!.querySelector('[data-unset="project"]')).toBeNull();
  await type('rate');
  await waitFor(() => options().length === 2);
  const last = searches().at(-1)!.url.searchParams;
  expect(last.get('project')).toBeNull();
  expect(last.get('current')).toBe(project.id);
  expect(options().map((o) => o.querySelector('.ib-sp-pj bdi')?.textContent)).toEqual(['plannotator', 'api']);
  expect(host!.querySelector('[data-search-scope]')).toBeNull();
  expect(host!.textContent).not.toContain('Only in');
});

test.skipIf(!hasDom)('chips: a menu by keys; Escape closes the menu before the palette; No matches names the scope', async () => {
  respond = async (call) => {
    if (call.url.searchParams.get('status') === 'archived') return answer({ q: 'jitter', terms: ['jitter'], totals: totals({}), groups: {}, recent: null });
    return call.url.searchParams.get('q') ? results(call.url.searchParams.get('q')!) : answer({});
  };
  await render({ currentProject: project.id });
  await waitFor(() => searches().length === 1);
  await type('jitter');
  const status = host!.querySelector<HTMLElement>('[data-chip="status"]')!;
  await act(async () => {
    status.click();
  });
  const menu = host!.querySelector('[role="menu"]')!;
  expect(menu.querySelectorAll('[role="menuitemradio"]')).toHaveLength(6);
  for (let i = 0; i < 5; i++) await key(menu, { key: 'ArrowDown' });
  await key(menu, { key: 'Enter' });
  expect(host!.querySelector('[role="menu"]')).toBeNull();
  await waitFor(() => host!.querySelector('[data-search-none]') !== null);
  expect(host!.querySelector('[data-search-none]')!.textContent).toBe('No matches for “jitter”Searched only Archived. Search everywhere');
  await act(async () => {
    host!.querySelector<HTMLElement>('[data-chip="from"]')!.click();
  });
  expect(host!.querySelector('[role="menu"]')).not.toBeNull();
  await key(host!.querySelector('[role="menu"]')!, { key: 'Escape' });
  expect(host!.querySelector('[role="menu"]')).toBeNull();
  expect(closed).toEqual([]);
  await key(input(), { key: 'Escape' });
  expect(closed).toEqual(['dismissed']);
});

test.skipIf(!hasDom)('the index still building: skeletons and the indexing line, then asked again', async () => {
  let asked = 0;
  respond = async (call) => {
    if (!call.url.searchParams.get('q')) return answer({});
    asked += 1;
    return asked === 1 ? answer({ q: 'relay', indexing: true, threads: 4212, totals: null, groups: null, recent: null }) : results('relay');
  };
  await render();
  await type('relay');
  await waitFor(() => host!.querySelector('[data-search-indexing]') !== null);
  expect(host!.querySelector('[data-search-indexing]')!.textContent).toBe('Indexing 4,212 threads…');
  expect(host!.querySelectorAll('.ib-sp-skel').length).toBeGreaterThan(0);
  await waitFor(() => options().length === 10);
  expect(host!.querySelector('[data-search-indexing]')).toBeNull();
});

test.skipIf(!hasDom)('the route failing: Search isn’t answering, Try again, the text kept', async () => {
  let fail = true;
  respond = async (call) => {
    if (!call.url.searchParams.get('q')) return answer({});
    if (fail) return new Response('{}', { status: 500 });
    return results('relay');
  };
  await render();
  await type('relay');
  await waitFor(() => host!.querySelector('[data-search-retry]') !== null);
  expect(host!.querySelector('.ib-sp-empty')!.textContent).toContain('Search isn’t answering.');
  expect(input().value).toBe('relay');
  fail = false;
  await act(async () => {
    host!.querySelector<HTMLElement>('[data-search-retry]')!.click();
  });
  await waitFor(() => options().length === 10);
});

test.skipIf(!hasDom)('recent searches: a click runs one, Clear forgets them', async () => {
  respond = async (call) => {
    if (call.url.pathname === '/api/inbox/search/recent') return { recent_searches: [] };
    const q = call.url.searchParams.get('q');
    return q ? results(q) : answer({ recent_searches: ['rate limit', 'pagination'], recent: [threadRow('msg_t1', 'Relay: rate limit')] });
  };
  await render();
  await waitFor(() => host!.querySelectorAll('[data-recent-search]').length === 2);
  expect([...host!.querySelectorAll('[role="group"]')].map((g) => g.getAttribute('data-search-group'))).toEqual(['recent-searches', 'recent']);
  await act(async () => {
    host!.querySelector<HTMLElement>('[data-recent-search]')!.click();
  });
  expect(input().value).toBe('rate limit');
  await waitFor(() => options().length === 10);
  await type('');
  await waitFor(() => host!.querySelector('[data-clear-recent]') !== null);
  await act(async () => {
    host!.querySelector<HTMLElement>('[data-clear-recent]')!.click();
  });
  await waitFor(() => host!.querySelectorAll('[data-recent-search]').length === 0);
  expect(calls.find((c) => c.url.pathname === '/api/inbox/search/recent')!.body).toMatchObject({ clear: true });
});

test.skipIf(!hasDom)('the landing highlight finds the words in the text, not in the message header', () => {
  const article = document.createElement('article');
  article.innerHTML =
    '<div class="ib-fline ib-is-open" data-open-head=""><button type="button" class="ib-fl-hit" data-fold-head="" aria-label="Claude Code retry"></button>' +
    '<span class="ib-fl-nm ib-who"><bdi>Claude Code retry</bdi></span><span class="ib-fl-meta"><span class="ib-fl-in">in <bdi>retry-budget</bdi> </span>' +
    '<span class="ib-fl-to"><span class="ib-to-sep">·</span> <span class="ib-to">to you</span></span></span></div>' +
    '<div class="ib-msg"><p>The first <b>retry</b> waits; a retry budget holds. Résumé.</p></div>';
  const ranges = searchHitRanges(article, ['retry', 'budget', 'resume']);
  expect(ranges.map((r) => r.toString())).toEqual(['retry', 'retry', 'budget', 'Résumé']);
});

test.skipIf(!hasDom)("compose's Actions: below real results unless the words name an action; shown while the index builds", async () => {
  const { composeActions } = await import('./compose/model');
  const headings = () => [...host!.querySelectorAll('[role="group"]')].map((g) => host!.querySelector(`#${g.getAttribute('aria-labelledby')}`)!.textContent);
  respond = async (call) => {
    const q = call.url.searchParams.get('q') ?? '';
    return q === 'idle' ? answer({ q: 'idle', indexing: true }) : q ? results(q) : answer({});
  };
  await act(async () => {
    root!.render(
      <SearchPalette
        open
        phone={false}
        currentProject={null}
        projects={[{ ...project, root: '/src/plannotator' }]}
        onClose={(reason) => closed.push(reason)}
        onOpenResult={(hash, land) => opened.push({ hash, land })}
        actions={(q) => (q === 'idle' ? [{ kind: 'new' }] : composeActions(q, [], null))}
        onAction={() => {}}
      />,
    );
  });
  await type('mes');
  await waitFor(() => headings().includes('Threads') && headings().includes('Actions'));
  expect(headings()).toEqual(['Threads', 'Messages12', 'Actions']);
  expect(options()[0]!.textContent).toContain('Relay: rate limit');
  await type('me');
  await waitFor(() => searches().at(-1)?.url.searchParams.get('q') === 'me' && !headings().includes('Actions'));
  await type('new');
  await waitFor(() => headings()[0] === 'Actions');
  await type('idle');
  await waitFor(() => host!.querySelector('[data-search-indexing]') !== null);
  expect(host!.querySelector('[data-compose-action="new"]')).not.toBeNull();
});

test.skipIf(!hasDom)('every result in a thread draws the list’s thread chip: its name, else its subject; whole in the DOM; thread rows follow the list’s rule', async () => {
  const where = { project, section: 'quiet' as const, archived: false, at: '2026-10-09T14:03:00Z' };
  const longSubject = 'Investigate why the nightly deploy of the customer-portal-frontend fails only on the second retry when the CDN cache is warm';
  const messages: InboxSearchRow[] = [
    { type: 'message', id: 'msg_a', thread_id: 'msg_t1', ...where, author: { kind: 'agent', name: 'Claude Code' }, title: longSubject, thread_name: 'nightly-deploy', snippet: { text: 'The nightly deploy fails on the second retry', marks: [] }, question: null },
    { type: 'message', id: 'msg_b', thread_id: 'msg_t2', ...where, author: { kind: 'me', name: 'You' }, title: 'Deploy', thread_name: null, snippet: { text: 'We should deploy tomorrow morning', marks: [] }, question: null },
    { type: 'message', id: 'msg_c', thread_id: 'msg_t3', ...where, author: { kind: 'agent', name: 'Pi' }, title: 'Schema migration for the comments table', thread_name: null, snippet: { text: '…Schema migration for the comments table…', marks: [] }, question: null },
  ];
  const files: InboxSearchRow[] = [
    { type: 'file', id: 'att_1', thread_id: 'msg_t4', message_id: 'msg_t4', ...where, name: 'retry-policy.md', name_marks: [], folder: 'docs', kind: 'md', title: 'Retry storm on the relay after a deploy', thread_name: 'retry' },
  ];
  const threads: InboxSearchRow[] = [
    threadRow('msg_t4', 'Retry storm on the relay after a deploy', { thread_name: 'retry' }),
    threadRow('msg_t1', longSubject, { thread_name: 'nightly-deploy' }),
    threadRow('msg_t5', 'Schema migration', { thread_name: null }),
  ];
  respond = async (call) =>
    call.url.searchParams.get('q')
      ? answer({ q: 'x', terms: ['x'], totals: totals({ threads: 3, messages: 3, files: 1 }), groups: { threads, messages, files }, recent: null })
      : answer({});
  await render();
  await type('x');
  await waitFor(() => options().length === 7);
  const row = (type: string, id: string) => host!.querySelector<HTMLElement>(`[data-result="${type}"][data-result-id="${id}"]`)!;
  const chip = (type: string, id: string) => row(type, id).querySelector<HTMLElement>('[data-result-thread]');

  const named = chip('message', 'msg_a')!;
  expect(named.classList.contains('ib-key')).toBe(true);
  expect(named.getAttribute('data-result-thread')).toBe('name');
  expect(named.querySelector('.ib-keyt')!.textContent).toBe('nightly-deploy');
  expect(named.querySelector('.ib-keyt')!.getAttribute('dir')).toBe('auto');
  expect(named.hasAttribute('title')).toBe(false);
  expect(await tooltipOf(named)).toBe(`Thread: nightly-deploy: ${longSubject}`);
  expect(row('message', 'msg_a').textContent).toContain(`Thread: nightly-deploy, ${longSubject}, Claude Code·, plannotator, `);
  expect(chip('message', 'msg_b')!.getAttribute('data-result-thread')).toBe('subject');
  expect(chip('message', 'msg_b')!.querySelector('.ib-keyt')!.textContent).toBe('Deploy');
  expect(chip('message', 'msg_c')).toBeNull();
  expect(row('message', 'msg_c').textContent).toContain('plannotator');
  expect(chip('file', 'att_1')!.querySelector('.ib-keyt')!.textContent).toBe('retry');
  expect(chip('thread', 'msg_t4')).toBeNull();
  expect(chip('thread', 'msg_t1')!.querySelector('.ib-keyt')!.textContent).toBe('nightly-deploy');
  expect(chip('thread', 'msg_t5')).toBeNull();
  for (const option of options()) expect(option.querySelectorAll('.ib-key').length).toBeLessThanOrEqual(1);
});

test.skipIf(!hasDom)('why a result matched: the words marked only in the fields the row was found by; a project’s folder whole; a file name whole when its cut would hide a match', async () => {
  const where = { project, section: 'quiet' as const, archived: false, at: '2026-10-09T14:03:00Z' };
  const name = 'Launch agents from Plannotator Cloud for the superfans beta';
  const longFile = 'superfans-onboarding-notes-for-the-beta-launch-plannotator-cloud-checklist-2026.md';
  const threads: InboxSearchRow[] = [threadRow('msg_t1', 'Superfans folder', { thread_name: name })];
  const messages: InboxSearchRow[] = [
    { type: 'message', id: 'msg_a', thread_id: 'msg_t1', ...where, author: { kind: 'agent', name: 'Cloud Plannotator Bot' }, title: 'Superfans folder', thread_name: name, snippet: { text: 'launch agents from Plannotator Cloud', marks: [[19, 11], [31, 5]] }, question: null },
  ];
  const files: InboxSearchRow[] = [
    { type: 'file', id: 'att_1', thread_id: 'msg_t1', message_id: 'msg_t1', ...where, name: longFile, name_marks: [[47, 11], [59, 5]], folder: 'docs', kind: 'md', title: 'Superfans folder', thread_name: name },
  ];
  const longRoot = '/Users/someone/src/github.com/backnotprop/plannotator-cloud-workspaces-for-the-superfans-beta';
  const projects: InboxSearchRow[] = [{ type: 'project', id: project.id, project, name: 'plannotator', name_marks: [[0, 11]], root: longRoot, at: '2026-10-09T14:03:00Z' }];
  respond = async (call) =>
    call.url.searchParams.get('q')
      ? answer({ q: 'plannotator cloud', terms: ['plannotator', 'cloud'], totals: totals({ threads: 1, messages: 1, files: 1, projects: 1 }), groups: { threads, messages, files, projects }, recent: null })
      : answer({});
  await render();
  await type('plannotator cloud');
  await waitFor(() => options().length === 4);
  const marked = (el: Element | null) => [...(el?.querySelectorAll('.ib-sp-m') ?? [])].map((m) => m.textContent);
  const thread = host!.querySelector('[data-result="thread"]')!;
  expect(thread.querySelector('.ib-keyt')!.textContent).toBe(name);
  expect(marked(thread.querySelector('.ib-key'))).toEqual(['Plannotator', 'Cloud']);
  expect(marked(thread.querySelector('.ib-sp-pj'))).toEqual(['plannotator']);
  const message = host!.querySelector('[data-result="message"]')!;
  expect(marked(message.querySelector('.ib-sp-lead'))).toEqual(['Cloud', 'Plannotator']);
  expect(marked(message.querySelector('.ib-sp-snip'))).toEqual(['Plannotator', 'Cloud']);
  expect(message.querySelector('.ib-keyt')!.textContent).toBe(name);
  expect(marked(message.querySelector('.ib-key'))).toEqual([]);
  expect(message.querySelector('.ib-sp-pj > bdi')!.textContent).toBe('plannotator');
  expect(marked(message.querySelector('.ib-sp-pj'))).toEqual([]);
  const file = host!.querySelector('[data-result="file"]')!;
  expect(file.querySelector('.ib-sp-p')!.textContent).toBe(longFile);
  expect(marked(file.querySelector('.ib-sp-p'))).toEqual(['plannotator', 'cloud']);
  expect(marked(file.querySelector('.ib-key'))).toEqual([]);
  expect(marked(file.querySelector('.ib-sp-pj'))).toEqual([]);
  const projectRow = host!.querySelector('[data-result="project"]')!;
  const second = projectRow.querySelector('.ib-sp-s')!;
  expect(second.textContent).toContain(longRoot);
  expect(marked(second)).toEqual(['plannotator', 'cloud']);
});

test.skipIf(!hasDom)('a renamed project: a thread row marks the indexed name only where the shown name holds it', async () => {
  respond = async (call) =>
    call.url.searchParams.get('q')
      ? answer({
          q: 'plannotator',
          terms: ['plannotator'],
          totals: totals({ threads: 3 }),
          groups: {
            threads: [
              threadRow('msg_t1', 'Relay'),
              threadRow('msg_t2', 'Board', { project: { id: 'prj_01M4V7JERHR0Y3XQERK1MR604B', name: 'plannotator' } }),
              threadRow('msg_t3', 'Plannotator launch', { title_marks: [[0, 11]], project: { id: 'prj_01M4V7JERHR0Y3XQERK1MR604C', name: 'web' } }),
            ],
          },
          recent: null,
        })
      : answer({});
  await act(async () => {
    root!.render(
      <SearchPalette
        open
        phone={false}
        currentProject={null}
        projects={[
          { ...project, root: '/src/plannotator', display_name: 'Cloud app' },
          { id: 'prj_01M4V7JERHR0Y3XQERK1MR604B', name: 'plannotator', root: '/w/plannotator', display_name: 'plannotator fork' },
          { id: 'prj_01M4V7JERHR0Y3XQERK1MR604C', name: 'web', root: '/w/web', display_name: 'plannotator web' },
        ]}
        onClose={(reason) => closed.push(reason)}
        onOpenResult={(hash, land) => opened.push({ hash, land })}
      />,
    );
  });
  await type('plannotator');
  await waitFor(() => options().length === 3);
  const pj = (id: string) => host!.querySelector(`[data-result-id="${id}"] .ib-sp-pj > bdi`)!;
  expect(pj('msg_t1').textContent).toBe('Cloud app');
  expect(pj('msg_t1').querySelectorAll('.ib-sp-m').length).toBe(0);
  expect([...pj('msg_t2').querySelectorAll('.ib-sp-m')].map((m) => m.textContent)).toEqual(['plannotator']);
  expect(pj('msg_t3').textContent).toBe('plannotator web');
  expect(pj('msg_t3').querySelectorAll('.ib-sp-m').length).toBe(0);
});

test.skipIf(!hasDom)('a picked project: the chip says Only in, the results say what was left out, and Search everywhere asks again everywhere', async () => {
  respond = async (call) => (call.url.searchParams.get('q') ? results(call.url.searchParams.get('q')!) : answer({}));
  await render({ currentProject: project.id });
  await waitFor(() => searches().length === 1);
  await act(async () => {
    host!.querySelector<HTMLElement>('[data-chip="project"]')!.click();
  });
  await act(async () => {
    [...host!.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((item) => item.textContent === 'plannotator')!.click();
  });
  await waitFor(() => searches().at(-1)!.url.searchParams.get('project') === project.id);
  expect(host!.querySelector('[data-chip="project"]')!.textContent).toBe('Only in plannotator');
  expect(host!.querySelector('[data-search-scope]')).toBeNull();
  await type('rate');
  await waitFor(() => options().length === 10);
  expect(host!.querySelector('[data-search-scope]')!.textContent).toBe('Searched only plannotator. Search everywhere');
  expect(host!.querySelector('[data-search-live]')!.textContent).toBe('13 results in 2 groups. Searched only plannotator');
  const asked = searches().length;
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  respond = async (call) => {
    if (!call.url.searchParams.get('q')) return answer({});
    await held;
    return results(call.url.searchParams.get('q')!);
  };
  await act(async () => {
    host!.querySelector<HTMLElement>('[data-search-scope] [data-clear-filters]')!.click();
  });
  await waitFor(() => searches().length === asked + 1);
  expect(host!.querySelector('[data-chip="project"]')!.textContent).toBe('All projects');
  expect(host!.querySelector('[data-search-scope]')!.textContent).toBe('Searched only plannotator. Search everywhere');
  await act(async () => release());
  await waitFor(() => host!.querySelector('[data-search-scope]') === null);
  const last = searches().at(-1)!.url.searchParams;
  expect(last.get('q')).toBe('rate');
  expect(last.get('project')).toBeNull();
  expect(host!.querySelector('[data-chip="project"]')!.textContent).toBe('All projects');
  expect(host!.querySelector('[data-search-live]')!.textContent).toBe('13 results in 2 groups');
  expect(document.activeElement).toBe(input());
});

test.skipIf(!hasDom)('the subject chip is left out only when the first line is, begins with or starts the subject; never for a word met inside the text', async () => {
  const { rowThreadChip } = await import('./search/model');
  const where = { project, section: 'quiet' as const, archived: false, at: '2026-10-09T14:03:00Z' };
  const message = (title: string, text: string, thread_name: string | null = null): InboxSearchRow => ({
    type: 'message', id: 'msg_x', thread_id: 'msg_t', ...where, author: { kind: 'agent', name: 'Pi' }, title, thread_name, snippet: { text, marks: [] }, question: null,
  });
  const text = (row: InboxSearchRow) => rowThreadChip(row)?.text ?? null;
  expect(text(message('Deploy', 'We should deploy tomorrow morning'))).toBe('Deploy');
  expect(text(message('Tests', 'All tests pass now'))).toBe('Tests');
  expect(text(message('Auth bug', '…the auth bug is in the session check…'))).toBe('Auth bug');
  expect(text(message('Keep the rate limit?', 'Keep the rate limit?'))).toBeNull();
  expect(text(message('Schema migration', 'Schema migration for the comments table runs in 4 s'))).toBeNull();
  expect(text(message('Investigate why the nightly deploy fails on the second retry', 'Investigate why the nightly…'))).toBeNull();
  expect(text(message('Investigate why the nightly deploy fails', 'Investigate…'))).toBe('Investigate why the nightly deploy fails');
  expect(rowThreadChip(message('Keep the rate limit?', 'Keep the rate limit?', 'relay'))).toEqual({ text: 'relay', kind: 'name', subject: 'Keep the rate limit?' });
});

test.skipIf(!hasDom)('an action item hit (key a-…) is labelled "Action item", a question hit "Question"', async () => {
  respond = async (call) =>
    call.url.searchParams.get('q')
      ? answer({
          q: 'vercel',
          terms: ['vercel'],
          totals: totals({ threads: 0, messages: 2 }),
          groups: {
            threads: [],
            messages: [
              messageRow('msg_a', 'msg_t3', 'Approve the deploy on Vercel', { key: 'a-4f2c19e0', replaced: false }),
              messageRow('msg_b', 'msg_t3', 'Which Vercel team?', { key: 'q-abc', replaced: false }),
            ],
          },
          recent: null,
        })
      : answer({});
  await render();
  await type('vercel');
  await waitFor(() => options().length === 2);
  const chips = options().map((o) => [...o.querySelectorAll('.ib-sp-chip')].map((c) => c.textContent));
  expect(chips[0]).toContain('Action item');
  expect(chips[0]).not.toContain('Question');
  expect(chips[1]).toContain('Question');
});

const markedResults = (q: string): Answer =>
  answer({
    q,
    terms: [q],
    totals: totals({ threads: 1, messages: 3, files: 1 }),
    groups: {
      threads: [threadRow('msg_t1', 'Bookmarks sidebar syncs', { title_marks: [[0, 6]] })],
      messages: [
        { ...(messageRow('msg_c', 'msg_t1', 'saved from codex') as Extract<InboxSearchRow, { type: 'message' }>), author: { kind: 'agent', name: 'Codex', host: 'codex' } },
        messageRow('msg_o', 'msg_t1', 'saved by an older inbox'),
        { ...(messageRow('msg_y', 'msg_t1', 'saved by me') as Extract<InboxSearchRow, { type: 'message' }>), author: { kind: 'me', name: 'You', host: null } },
      ],
      files: [{ type: 'file', id: 'att_1', thread_id: 'msg_t1', message_id: 'msg_c', project, section: 'quiet', archived: false, at: '2026-10-09T14:03:00Z', name: 'saved.md', name_marks: [[0, 5]], folder: 'docs', kind: 'md', title: 'Bookmarks sidebar syncs' }],
    },
    recent: null,
  });
const resultRows = () => [...host!.querySelectorAll<HTMLElement>('[role="option"][data-result]')];
const markOf = (row: HTMLElement) => row.querySelector(':scope > .ib-sp-mark')?.getAttribute('data-row-mark') ?? null;

test.skipIf(!hasDom)('a message’s mark follows its agent’s host from the answer (the generic agent mark without one); every mark leads its row, hidden from a screen reader', async () => {
  respond = async (call) => (call.url.searchParams.get('q') ? markedResults(call.url.searchParams.get('q')!) : answer({}));
  await render();
  await type('saved');
  await waitFor(() => resultRows().length === 5);
  const byId = Object.fromEntries(resultRows().map((r) => [r.dataset.resultId, markOf(r)]));
  expect(byId.msg_c).toBe('agent:codex');
  expect(byId.msg_o).toBe('agent:');
  for (const row of resultRows()) {
    expect(row.firstElementChild!.classList.contains('ib-sp-mark')).toBe(true);
    expect(row.firstElementChild!.getAttribute('aria-hidden')).toBe('true');
  }
});

test.skipIf(!hasDom)('desktop: the time in its own column and the key footer; a phone: the time in the meta line, no footer', async () => {
  respond = async (call) => (call.url.searchParams.get('q') ? markedResults(call.url.searchParams.get('q')!) : answer({}));
  await render();
  await type('saved');
  await waitFor(() => resultRows().length === 5);
  const thread = resultRows()[0]!;
  expect(thread.querySelector(':scope > [data-result-time]')!.textContent).toBe(', Oct 9');
  expect(thread.querySelector('.ib-sp-at')).toBeNull();
  expect(resultRows()[4]!.querySelector('[data-result-time]')).toBeNull();
  expect(host!.querySelector('[data-search-keys]')).not.toBeNull();

  act(() => root!.unmount());
  root = createRoot(host!);
  await render({ phone: true });
  await type('saved');
  await waitFor(() => resultRows().length === 5);
  const phoneThread = resultRows()[0]!;
  expect(phoneThread.querySelector('[data-result-time]')).toBeNull();
  expect(phoneThread.querySelector('.ib-sp-at')!.textContent).toContain('Oct 9');
  expect(host!.querySelector('[data-search-keys]')).toBeNull();
});

function fileRow(i: number): InboxSearchRow {
  return { type: 'file', id: `att_f${i}`, thread_id: 'msg_t1', message_id: 'msg_m0', project, section: 'quiet', archived: false, at: '2026-10-09T14:03:00Z', name: `relay-${i}.md`, name_marks: [[0, 5]], folder: 'docs', kind: 'md', title: 'Relay: rate limit' };
}
const typeTotals = totals({ threads: 1, messages: 12, files: 60 });
const typeAnswers = async (call: Call): Promise<Answer> => {
  const p = call.url.searchParams;
  const q = p.get('q') ?? '';
  if (!q) return answer({});
  if (p.get('group') === 'files') {
    const offset = Number(p.get('offset') ?? 0);
    const limit = Number(p.get('limit'));
    return answer({ q, terms: [q], totals: typeTotals, groups: { files: Array.from({ length: Math.min(limit, 60 - offset) }, (_, i) => fileRow(offset + i)) }, recent: null });
  }
  return answer({
    q,
    terms: [q],
    totals: typeTotals,
    groups: { threads: [threadRow('msg_t1', 'Relay: rate limit')], messages: Array.from({ length: 8 }, (_, i) => messageRow(`msg_m${i}`, 'msg_t1', `relay ${i}`)), files: Array.from({ length: 5 }, (_, i) => fileRow(i)) },
    recent: null,
  });
};
async function renderTyped(open: boolean, currentProject: string | null = null): Promise<void> {
  await act(async () => {
    root!.render(
      <SearchPalette
        open={open}
        phone={false}
        currentProject={currentProject}
        projects={[{ ...project, root: '/src/plannotator' }]}
        onClose={(reason) => closed.push(reason)}
        onOpenResult={(hash, land) => opened.push({ hash, land })}
        actions={() => [{ kind: 'new' }]}
        onAction={() => {}}
      />,
    );
  });
}
const groupHeadings = () => [...host!.querySelectorAll('[role="group"]')].map((g) => host!.querySelector(`#${g.getAttribute('aria-labelledby')}`)!.textContent);
const typeChip = () => host!.querySelector<HTMLElement>('[data-chip="type"]')!;
const live = () => host!.querySelector('[data-search-live]')!.textContent;
async function pickType(label: string): Promise<void> {
  await act(async () => {
    typeChip().click();
  });
  const item = [...host!.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitemradio"]')].find((el) => el.querySelector('.ib-sp-ml')!.textContent === label)!;
  await act(async () => {
    item.click();
  });
}

test.skipIf(!hasDom)('the Type chip: All types sends the request as before; a picked type asks for its group on every query and lists it alone, Actions hidden, first row highlighted, Show 50 more going on from 50', async () => {
  respond = typeAnswers;
  await renderTyped(true);
  await type('relay');
  await waitFor(() => groupHeadings().includes('Threads'));
  const plain = searches().at(-1)!.url.searchParams;
  expect([plain.get('group'), plain.get('limit'), plain.get('offset')]).toEqual([null, null, null]);
  expect(groupHeadings()).toEqual(['Threads', 'Messages12', 'Files60', 'Actions']);
  expect([...host!.querySelectorAll('[data-chip]')].map((c) => c.getAttribute('data-chip'))).toEqual(['type', 'project', 'status', 'from']);

  await act(async () => {
    typeChip().click();
  });
  const menu = host!.querySelector('[role="menu"]')!;
  expect(menu.getAttribute('aria-label')).toBe('Type');
  expect([...menu.querySelectorAll('[role="menuitemradio"]')].map((el) => el.textContent)).toEqual(['All types', 'Threads1', 'Messages12', 'Files60', 'Projects0']);
  for (let i = 0; i < 3; i++) await key(menu, { key: 'ArrowDown' });
  await key(menu, { key: 'Enter' });
  await waitFor(() => groupHeadings()[0] === 'Files60');

  const picked = searches().at(-1)!.url.searchParams;
  expect([picked.get('q'), picked.get('group'), picked.get('limit'), picked.get('offset')]).toEqual(['relay', 'files', '50', null]);
  expect(groupHeadings()).toEqual(['Files60']);
  expect(options()).toHaveLength(51);
  expect(options().at(-1)!.textContent).toBe('Show 10 more');
  expect(input().getAttribute('aria-activedescendant')).toBe(options()[0]!.id);
  expect(live()).toBe('60 files');
  expect(typeChip().textContent).toBe('Files');
  // Pinned on purpose: the ×'s accessible name from the approved design notes.
  expect(host!.querySelector('[data-unset="type"]')!.getAttribute('aria-label')).toBe('Clear the type filter');

  await act(async () => {
    options().at(-1)!.click();
  });
  await waitFor(() => options().length === 60);
  const more = searches().at(-1)!.url.searchParams;
  expect([more.get('group'), more.get('offset'), more.get('limit')]).toEqual(['files', '50', '50']);
  expect(new Set(options().map((o) => o.getAttribute('data-result-id'))).size).toBe(60);
  expect(host!.querySelector('[data-show-more]')).toBeNull();

  await type('relay-');
  await waitFor(() => searches().at(-1)!.url.searchParams.get('q') === 'relay-' && options().length === 51);
  expect(searches().at(-1)!.url.searchParams.get('group')).toBe('files');
  await type('');
  await waitFor(() => host!.querySelector('[data-search-type-empty]') !== null);
  expect(searches().at(-1)!.url.searchParams.get('group')).toBeNull();
  expect(options()).toHaveLength(0);
});

test.skipIf(!hasDom)('Show 50 more drops a row already shown (a message that came in moved the next page down by one)', async () => {
  respond = async (call) => {
    const p = call.url.searchParams;
    if (p.get('group') === 'files' && p.get('offset') === '50') {
      return answer({ q: p.get('q') ?? '', terms: [p.get('q') ?? ''], totals: typeTotals, groups: { files: Array.from({ length: 11 }, (_, i) => fileRow(49 + i)) }, recent: null });
    }
    return typeAnswers(call);
  };
  await renderTyped(true);
  await type('relay');
  await waitFor(() => groupHeadings().includes('Threads'));
  await pickType('Files');
  await waitFor(() => groupHeadings()[0] === 'Files60' && options().length === 51);
  await act(async () => {
    options().at(-1)!.click();
  });
  await waitFor(() => options().length === 60);
  const ids = options().map((o) => o.getAttribute('data-result-id'));
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids.at(-1)).toBe('att_f59');
});

test.skipIf(!hasDom)('the Type chip goes back to All types on ×, on Clear filters, on Search everywhere and at every open', async () => {
  respond = typeAnswers;
  const plainAgain = async () => {
    await waitFor(() => groupHeadings().includes('Threads'));
    expect(typeChip().textContent).toBe('All types');
    expect(searches().at(-1)!.url.searchParams.get('group')).toBeNull();
  };
  await renderTyped(true, project.id);
  await type('relay');
  await pickType('Files');
  await waitFor(() => groupHeadings()[0] === 'Files60');
  await act(async () => {
    host!.querySelector<HTMLElement>('[data-unset="type"]')!.click();
  });
  await plainAgain();

  await pickType('Files');
  await waitFor(() => groupHeadings()[0] === 'Files60');
  await act(async () => {
    host!.querySelector<HTMLElement>('[data-chip="project"]')!.click();
  });
  await act(async () => {
    [...host!.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((item) => item.textContent === 'plannotator')!.click();
  });
  await waitFor(() => searches().at(-1)!.url.searchParams.get('project') === project.id);
  await act(async () => {
    host!.querySelector<HTMLElement>('.ib-sp-filters [data-clear-filters]')!.click();
  });
  await plainAgain();
  expect(host!.querySelector('[data-chip="project"]')!.textContent).toBe('All projects');

  respond = async (call) => (call.url.searchParams.get('group') === 'projects' ? answer({ q: 'relay', terms: ['relay'], totals: typeTotals, groups: { projects: [] }, recent: null }) : typeAnswers(call));
  await pickType('Projects');
  await waitFor(() => host!.querySelector('[data-search-none]') !== null);
  expect(host!.querySelector('[data-search-none] .ib-sp-e2')!.textContent).toContain('projects');
  await act(async () => {
    host!.querySelector<HTMLElement>('[data-search-none] [data-clear-filters]')!.click();
  });
  await plainAgain();

  await pickType('Files');
  await waitFor(() => groupHeadings()[0] === 'Files60');
  await renderTyped(false);
  await renderTyped(true);
  expect(typeChip().textContent).toBe('All types');
  await type('relay');
  await plainAgain();
});

test.skipIf(!hasDom)('a type change on its way draws the last answer as it was asked, never under the new chip', async () => {
  let holding = false;
  let release: (() => void) | null = null;
  respond = async (call) => {
    if (holding) {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    return typeAnswers(call);
  };
  const drawn = () => options().map((o) => o.getAttribute('data-result-id') ?? o.getAttribute('data-show-more') ?? o.getAttribute('data-compose-action'));
  const dimmed = () => host!.querySelector('[role="listbox"]')!.hasAttribute('data-dim');
  const highlighted = () => host!.querySelector(`#${input().getAttribute('aria-activedescendant')}`);
  await renderTyped(true);
  await type('relay');
  await waitFor(() => groupHeadings().includes('Threads'));
  const allTypes = drawn();
  expect(groupHeadings()).toEqual(['Threads', 'Messages12', 'Files60', 'Actions']);
  await key(input(), { key: 'ArrowDown' });
  await key(input(), { key: 'ArrowDown' });
  const row = highlighted();
  holding = true;

  await pickType('Files');
  await waitFor(() => release !== null);
  expect(typeChip().textContent).toBe('Files');
  expect(dimmed()).toBe(true);
  expect(groupHeadings()).toEqual(['Threads', 'Messages12', 'Files60', 'Actions']);
  expect(drawn()).toEqual(allTypes);
  expect(highlighted()).toBe(row);
  await act(async () => release!());
  await waitFor(() => groupHeadings()[0] === 'Files60');
  release = null;
  expect(groupHeadings()).toEqual(['Files60']);
  const filesPage = drawn();
  expect(filesPage).toHaveLength(51);

  await act(async () => {
    host!.querySelector<HTMLElement>('[data-unset="type"]')!.click();
  });
  await waitFor(() => release !== null);
  expect(typeChip().textContent).toBe('All types');
  expect(dimmed()).toBe(true);
  expect(groupHeadings()).toEqual(['Files60']);
  expect(drawn()).toEqual(filesPage);
  await act(async () => release!());
  await waitFor(() => groupHeadings().includes('Actions'));
  expect(groupHeadings()).toEqual(['Threads', 'Messages12', 'Files60', 'Actions']);
});

test.skipIf(!hasDom)('Best match | Newest: shown for words, asks again in the order picked, Show all keeps it, and the pick is remembered at the next open', async () => {
  const { SEARCH_SORT_COOKIE } = await import('./search/searchSort');
  const { storage, setStorageBackend, resetStorageBackend } = await import('@plannotator/ui/utils/storage');
  // The pick persists through Plannotator's storage (cookies in the app); a map stands in for them here.
  const kept = new Map<string, string>();
  setStorageBackend({ getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => void kept.set(k, v), removeItem: (k) => void kept.delete(k) });
  try {
    respond = async (call) => {
      const q = call.url.searchParams.get('q')!;
      if (call.url.searchParams.get('group') === 'messages') {
        return answer({ q, terms: ['rate'], totals: totals({ threads: 1, messages: 12 }), groups: { messages: Array.from({ length: 12 }, (_, i) => messageRow(`msg_m${i}`, 'msg_t2', `rate ${i}`)) }, recent: null });
      }
      return q ? results(q) : answer({});
    };
    const sortSwitch = () => host!.querySelector<HTMLElement>('[data-search-sort]');
    const radio = (value: string) => host!.querySelector<HTMLInputElement>(`[data-search-sort] input[value="${value}"]`)!;
    await renderTyped(true);
    expect(sortSwitch()).toBeNull();
    await type('rate');
    await waitFor(() => options().length > 0 && searches().some((c) => c.url.searchParams.get('q') === 'rate'));
    expect(sortSwitch()!.getAttribute('role')).toBe('radiogroup');
    expect(sortSwitch()!.closest('.ib-sp-inrow')).not.toBeNull();
    expect(host!.querySelector('[data-search-filter-bar] [data-search-sort]')).toBeNull();
    expect([...sortSwitch()!.querySelectorAll('label')].map((l) => l.textContent)).toEqual(['Best match', 'Newest']);
    expect(radio('best').checked).toBe(true);
    expect(searches().at(-1)!.url.searchParams.get('sort')).toBeNull();

    const before = searches().length;
    await act(async () => {
      radio('newest').click();
    });
    await waitFor(() => searches().length > before);
    expect(searches().at(-1)!.url.searchParams.get('q')).toBe('rate');
    expect(searches().at(-1)!.url.searchParams.get('sort')).toBe('newest');
    expect(radio('newest').checked).toBe(true);
    expect(storage.getItem(SEARCH_SORT_COOKIE)).toBe('newest');

    await waitFor(() => host!.querySelector('[data-show-more]') !== null);
    await act(async () => {
      host!.querySelector<HTMLElement>('[data-show-more]')!.click();
    });
    await waitFor(() => calls.some((c) => c.url.searchParams.get('group') === 'messages'));
    expect(calls.find((c) => c.url.searchParams.get('group') === 'messages')!.url.searchParams.get('sort')).toBe('newest');

    await renderTyped(false);
    await renderTyped(true);
    await type('limit');
    await waitFor(() => searches().some((c) => c.url.searchParams.get('q') === 'limit'));
    expect(searches().at(-1)!.url.searchParams.get('sort')).toBe('newest');
    await waitFor(() => sortSwitch() !== null);
    expect(radio('newest').checked).toBe(true);

    const again = searches().length;
    await act(async () => {
      radio('best').click();
    });
    await waitFor(() => searches().length > again);
    expect(searches().at(-1)!.url.searchParams.get('sort')).toBeNull();
    expect(storage.getItem(SEARCH_SORT_COOKIE)).toBeNull();
  } finally {
    resetStorageBackend();
  }
});

test.skipIf(!hasDom)('Tab reaches the order once (the chosen half), as a radio group', async () => {
  respond = async (call) => (call.url.searchParams.get('q') ? results(call.url.searchParams.get('q')!) : answer({}));
  await renderTyped(true);
  await type('rate');
  await waitFor(() => host!.querySelector('[data-search-sort]') !== null);
  const stops: string[] = [];
  input().focus();
  for (let i = 0; i < 20; i++) {
    await key(document.activeElement!, { key: 'Tab' });
    const el = document.activeElement as HTMLElement;
    if (el === input()) break;
    stops.push(el instanceof HTMLInputElement && el.type === 'radio' ? `radio:${el.value}` : (el.getAttribute('data-chip') ?? el.className));
  }
  expect(stops.filter((s) => s.startsWith('radio:'))).toEqual(['radio:best']);
  expect(stops.filter((s) => s !== 'ib-sp-cancel').slice(0, 5)).toEqual(['radio:best', 'type', 'project', 'status', 'from']);
});

test.skipIf(!hasDom)('a phone: the order is pinned at the end of the filter line, after the filters, once there are words', async () => {
  respond = async (call) => (call.url.searchParams.get('q') ? results(call.url.searchParams.get('q')!) : answer({}));
  await render({ phone: true });
  await waitFor(() => searches().length === 1);
  const bar = () => host!.querySelector<HTMLElement>('[data-search-filter-bar]')!;
  expect(host!.querySelector('[data-search-sort]')).toBeNull();
  expect(bar().querySelector('.ib-sp-pin')).toBeNull();
  await type('rate');
  await waitFor(() => host!.querySelector('[data-search-sort]') !== null);
  expect(host!.querySelectorAll('[data-search-sort]')).toHaveLength(1);
  expect(host!.querySelector('.ib-sp-inrow [data-search-sort]')).toBeNull();
  expect([...bar().children].map((el) => el.className)).toEqual(['ib-sp-filters', 'ib-sp-pin']);
  expect(bar().querySelector('.ib-sp-pin [data-search-sort]')).not.toBeNull();
  expect(host!.querySelector('.ib-sp-sortrow')).toBeNull();
});
