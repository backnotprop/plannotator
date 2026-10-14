/**
 * Inbox search's palette (search/SearchPalette.tsx) in a DOM, its server
 * answers scripted through `fetch`:
 *
 * - combobox and listbox semantics; groups labelled by their headings; the
 *   first row highlighted when the rows change; ↓ ↑ wrap and move
 *   `aria-activedescendant`; `pointermove` moves the highlight;
 * - Enter opens the highlighted result (the hash, and a message's landing
 *   with the query's terms and a question's key); Enter during IME
 *   composition does nothing; an Enter while a newer query is still settling
 *   opens that query's first row once it lands;
 * - typing is debounced (one request for a burst), a stale answer is dropped,
 *   the last results stay dimmed while the next are on their way;
 * - the live region speaks once per settled answer;
 * - "Show all" asks for the group and expands it in place;
 * - a chip's menu: arrows, Enter, Escape closes the menu before the palette;
 *   a set chip has a ×; "No matches" names the scope and Search everywhere
 *   clears it;
 * - the index still building: skeletons, the indexing line, asked again;
 * - the route failing: "Search isn't answering" and Try again;
 * - recent searches: a click runs one; Clear forgets them; opening a
 *   result remembers its query;
 * - the landing highlight finds the words in the message's text nodes.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from the test.yml DOM list.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxSearchAnswer, InboxSearchRow, InboxSearchThreadRow } from '@plannotator/core/inbox-search';

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
const totals = (t: Partial<Record<'threads' | 'messages' | 'files' | 'decisions' | 'projects', number>>) => ({ threads: 0, messages: 0, files: 0, decisions: 0, projects: 0, ...t });

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

async function render(props: { currentProject?: string | null } = {}): Promise<void> {
  await act(async () => {
    root!.render(
      <SearchPalette
        open
        phone={false}
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
  // Groups labelled by their headings, in order; "Show all 12 messages" ends Messages.
  const groups = [...host!.querySelectorAll('[role="group"]')];
  expect(groups.map((g) => host!.querySelector(`#${g.getAttribute('aria-labelledby')}`)!.textContent)).toEqual(['Threads', 'Messages12']);
  expect(options().at(-1)!.textContent).toBe('Show all 12 messages');
  expect(input().getAttribute('aria-activedescendant')).toBe(options()[0]!.id);
  expect(options()[0]!.getAttribute('aria-selected')).toBe('true');
  // Matched words in semibold, only where they matched.
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
  // The live region spoke once for the settled answer.
  expect(host!.querySelector('[data-search-live]')!.textContent).toBe('13 results in 2 groups');
});

test.skipIf(!hasDom)('Enter opens: the hash and a message landing with its terms and question key; IME Enter does nothing', async () => {
  respond = async (call) => (call.url.searchParams.get('q') ? results(call.url.searchParams.get('q')!) : answer({}));
  await render();
  await type('rate lim');
  await waitFor(() => options().length === 10);
  await key(input(), { key: 'ArrowDown' });
  // A composing Enter (an IME committing text) is not an open.
  await key(input(), { key: 'Enter', isComposing: true });
  expect(opened).toEqual([]);
  await key(input(), { key: 'Enter' });
  expect(opened).toEqual([{ hash: '#thread=msg_t2&msg=msg_m0', land: { messageId: 'msg_m0', terms: ['rate', 'lim'], questionKey: 'q-abc' } }]);
  expect(closed).toEqual(['opened']);
  // Opening a result remembers its words.
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
  // A slow query then a quick one: the slow answer, landing last, is dropped.
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
  // A press on a row, a group heading and Show all is not a focus change (the click still runs).
  for (const target of [options()[1]!, host!.querySelector('.ib-sp-gh')!, options().at(-1)!]) {
    const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    target.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
  }
  expect(options().every((o) => !o.hasAttribute('title'))).toBe(true);
  // Show all: focus back in the input (even from elsewhere), and the arrows move on from the expanded group.
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
  // The dialog's cancel while a composition is under way closes nothing either.
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
  // No matches: shown in the list, spoken by the one live region.
  await type('jitter');
  await waitFor(() => host!.querySelector('[data-search-none]') !== null);
  expect(host!.querySelector('[role="listbox"] [role="status"]')).toBeNull();
  expect(host!.querySelectorAll('[role="status"]')).toHaveLength(1);
  expect(host!.querySelector('[data-search-live]')!.textContent).toContain('No matches');
  await key(input(), { key: 'Escape' });
  expect(closed).toEqual(['dismissed']);
});

test.skipIf(!hasDom)('chips: the Project chip starts on the current project; a menu by keys; Escape closes the menu before the palette; No matches names the scope', async () => {
  respond = async (call) => {
    if (call.url.searchParams.get('status') === 'archived') return answer({ q: 'jitter', terms: ['jitter'], totals: totals({}), groups: {}, recent: null });
    return call.url.searchParams.get('q') ? results(call.url.searchParams.get('q')!) : answer({});
  };
  await render({ currentProject: project.id });
  await waitFor(() => searches().length === 1);
  expect(searches()[0]!.url.searchParams.get('project')).toBe(project.id);
  expect(searches()[0]!.url.searchParams.get('current')).toBe(project.id);
  expect(host!.querySelector('[data-chip="project"]')!.textContent).toBe('in plannotator');
  expect(host!.querySelector('[data-unset="project"]')).not.toBeNull();
  // Clear the project, then pick Status → Archived by keys.
  await act(async () => {
    host!.querySelector<HTMLElement>('[data-unset="project"]')!.click();
  });
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
  // Escape with a menu open closes the menu, not the palette.
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
  article.innerHTML = '<div data-fold-head>Claude Code retry</div><p>The first <b>retry</b> waits; a retry budget holds. Résumé.</p>';
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
  // Three letters of "message": the action, after the real matches.
  await type('mes');
  await waitFor(() => headings().includes('Threads') && headings().includes('Actions'));
  expect(headings()).toEqual(['Threads', 'Messages12', 'Actions']);
  expect(options()[0]!.textContent).toContain('Relay: rate limit');
  // Two letters call nothing.
  await type('me');
  await waitFor(() => searches().at(-1)?.url.searchParams.get('q') === 'me' && !headings().includes('Actions'));
  // The whole word: the action first.
  await type('new');
  await waitFor(() => headings()[0] === 'Actions');
  // While the index builds: the action, above the skeletons.
  await type('idle');
  await waitFor(() => host!.querySelector('[data-search-indexing]') !== null);
  expect(host!.querySelector('[data-compose-action="new"]')).not.toBeNull();
});
