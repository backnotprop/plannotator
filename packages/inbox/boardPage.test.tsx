/**
 * The Board page (approval "inbox-board", step 2) as the window draws it,
 * over a scripted fetch (no server): the five lanes and a card's two lines,
 * bold while unread, no "on you" pill on a lane; the agents' drops above the
 * lanes with "Got it"; the opened card beside the lanes with its history,
 * its links read only once it opens, and Ship, Icebox, Drop with a reason;
 * Start on an agent's Backlog card telling that agent in the card's thread
 * and marking the card sent; New card into Backlog; the empty Board's line;
 * the phone's stacked list with Shipped and Icebox folded. What regresses: a
 * lane out of order, "You: …" in an agent's lane, a card fetching its links
 * before it is opened, a Start that moves the card, a drop that never asks
 * for its reason, a phone that lays the lanes side by side.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAuthor, InboxCardWire, InboxListRow } from '@plannotator/core/inbox-types';
import type { BoardMove, BoardPageProps } from './board/BoardPage';
import { sized, tooltipOf, unhover } from './testing/tooltip';

const hasDom = typeof document !== 'undefined';
const { BoardPage } = (hasDom ? await import('./board/BoardPage') : {}) as typeof import('./board/BoardPage');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');

const CLAUDE: InboxAuthor = { kind: 'agent', host: 'claude-code', session: 'ses_claude', name: 'Claude Code' };
const CODEX: InboxAuthor = { kind: 'agent', host: 'codex', session: 'ses_codex', name: 'Codex' };
const PERSON: InboxAuthor = { kind: 'person' };
const LOOK = 10;
const OLD = '2026-10-20T09:00:00.000Z';
const NEW = '2026-10-21T09:00:00.000Z';

function card(id: string, over: Partial<InboxCardWire> = {}): InboxCardWire {
  return {
    id,
    project_id: 'prj_1',
    title: id,
    column: 'backlog',
    you: null,
    said: null,
    threads: [],
    prs: [],
    refs: [],
    agent: CLAUDE,
    created_at: OLD,
    created_by: CLAUDE,
    moved_at: OLD,
    heard_at: OLD,
    heard_by: CLAUDE,
    heard_seq: 5,
    dropped: null,
    aside_from: null,
    idempotency_key: null,
    notes: null,
    sent: null,
    ...over,
  } as InboxCardWire;
}

const CARDS: InboxCardWire[] = [
  card('crd_auto', { title: 'Auto-update for users', said: 'Pick it up: read the issue first', heard_at: NEW, heard_seq: 12, threads: ['msg_auto'] }),
  card('crd_hero', { title: 'Hero scene timers', column: 'designing', said: 'Option 3 of 6 rendered' }),
  card('crd_price', { title: 'Pricing page', column: 'your_look', you: 'Read the copy, then say go', said: 'Copy drafted', heard_at: NEW, heard_seq: 12 }),
  card('crd_vite', { title: 'vite 8 and electron-forge', column: 'building', said: 'vite 8 merged', agent: CODEX, refs: [{ kind: 'pr', source: 'github', ref: 'acme/widgets#12', url: 'https://github.com/acme/widgets/pull/12' }] }),
  card('crd_ticks', { title: 'Delivery ticks on list rows', column: 'your_review', you: 'Merge #14' }),
  card('crd_tab', { title: 'Unread count on the tab', column: 'shipped' }),
  card('crd_poly', { title: 'Polylane plan evaluation', column: 'icebox', aside_from: 'backlog', agent: null, created_by: PERSON, heard_by: PERSON }),
  card('crd_sqlite', { title: 'Spike: SQLite for the store', column: 'dropped', aside_from: 'building', dropped: { at: NEW, by: CODEX, reason: 'Superseded by the JSONL store', seen_at: null } }),
];

/** Cards waiting on the person, for the "You: …" way in: sent in a thread, linked to two threads, linked to none. */
const YOU_CARDS: InboxCardWire[] = [
  card('crd_sent', { title: 'Fixed address', column: 'your_look', you: 'Pick a dialog', threads: ['msg_new', 'msg_sent'], sent: { at: OLD, to: CLAUDE, thread_id: 'msg_sent' } }),
  card('crd_two', { title: 'Caret anywhere', column: 'your_review', you: 'Merge #15', threads: ['msg_new', 'msg_old'] }),
  card('crd_none', { title: 'Settings search', column: 'your_look', you: 'Choose fuzzy or prefix' }),
];
// The lane card's second line (approval board-lane-card, r1): only "You: …" or a pending "Sent to …", never the agent's last word.
const LINE_CARDS: InboxCardWire[] = [
  card('crd_said', { title: 'Hero scene timers', column: 'building', said: 'Option 3 of 6 rendered' }),
  card('crd_owe', { title: 'Pricing page', column: 'your_look', you: 'Read the copy, then say go', said: 'Copy drafted' }),
  card('crd_wait', { title: 'Auto-update', column: 'backlog', agent: null, said: 'Not started', sent: { at: NEW, to: CODEX, thread_id: 'msg_wait' } }),
];
const YOU_LAST: Record<string, string> = { msg_new: '2026-10-21T09:00:00.000Z', msg_old: '2026-10-20T09:00:00.000Z', msg_sent: '2026-10-19T09:00:00.000Z' };
const youRow = (id: string) => (YOU_LAST[id] ? ({ thread_id: id, subject: id, project: { id: 'prj_1', name: 'web' }, last_at: YOU_LAST[id] } as unknown as InboxListRow) : null);

let root: Root | null = null;
let calls: { method: string; path: string; body: Record<string, unknown> | null }[] = [];
const restorers: Array<() => void> = [];

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  calls = [];
  while (restorers.length > 0) restorers.pop()!();
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** A scripted Inbox: the routes the Board reads and writes, every call recorded. */
function scriptFetch(sessions: unknown[] = []) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://127.0.0.1:1');
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ method, path: url.pathname, body });
    if (url.pathname === '/api/inbox/sessions') return json({ serverSession: 's', home: '/Users/ada', projects: sessions });
    if (url.pathname === '/api/inbox/board/intro') return json({ show: false });
    if (url.pathname === '/api/inbox/cards/marks') {
      const ids = (body?.cards as string[]) ?? [];
      const marks = Object.fromEntries(ids.filter((id) => id === 'crd_vite').map((id) => [id, { kind: 'pr', ref: 'acme/widgets#12', url: 'https://github.com/acme/widgets/pull/12', state: 'merged', title: 'vite 8 for the review app' }]));
      return json({ serverSession: 's', marks });
    }
    const refs = url.pathname.match(/^\/api\/inbox\/cards\/([^/]+)\/refs$/);
    if (refs) return json({ refs: [] });
    const one = url.pathname.match(/^\/api\/inbox\/cards\/([^/]+)$/);
    if (one && method === 'GET') {
      const found = [...CARDS, ...YOU_CARDS, ...LINE_CARDS].find((c) => c.id === one[1]);
      // The agent's last word is in the opened card's history.
      return json({ card: found, history: [...(found?.said ? [{ kind: 'said', at: NEW, by: CLAUDE, text: found.said }] : []), { kind: 'created', at: OLD, by: CLAUDE }] });
    }
    if (one && method === 'POST') return json({ card: { ...[...CARDS, ...YOU_CARDS].find((c) => c.id === one[1])!, sent: body?.op === 'send' ? { at: NEW, to: CLAUDE, thread_id: body.thread_id } : null } });
    if (url.pathname === '/api/inbox/cards') return json({ card: card('crd_new', { title: String(body?.title), agent: null, notes: (body?.notes as string) ?? null }) });
    if (/^\/api\/inbox\/threads\/[^/]+\/message$/.test(url.pathname)) return json({ message: { id: 'msg_start' }, replayed: false });
    return json({ error: 'not scripted' }, 404);
  }) as typeof fetch;
  restorers.push(() => {
    globalThis.fetch = original;
  });
}

interface Drawn {
  moves: { id: string; move: BoardMove }[];
  opened: (string | null)[];
  seen: number;
  changed: number;
  rerender: (over: Partial<BoardPageProps>) => void;
}

function draw(over: Partial<BoardPageProps> = {}): Drawn {
  const host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  root = createRoot(host);
  const drawn: Drawn = { moves: [], opened: [], seen: 0, changed: 0, rerender: () => {} };
  let props: BoardPageProps = {
    view: 'lanes',
    mcpCommand: ['/Users/ada/.local/bin/plannotator', 'inbox', 'mcp'],
    claimIntro: false,
    model: { serverSession: 's', cursor: 1, cards: CARDS, dropped_unseen: 1, seen_seq: LOOK },
    error: null,
    visitLook: LOOK,
    handled: new Set(),
    projects: [{ id: 'prj_1', key: 'web', name: 'web', root: '/Users/ada/src/web', created_at: OLD, threads: 1, unread: 0 }] as BoardPageProps['projects'],
    defaultProject: 'prj_1',
    home: '/Users/ada',
    phone: false,
    openCard: null,
    onOpenCard: (id) => drawn.opened.push(id),
    rowOf: (id) => (id === 'msg_auto' ? ({ thread_id: 'msg_auto', subject: 'Auto-update', project: { id: 'prj_1', name: 'web' } } as unknown as InboxListRow) : null),
    onView: () => {},
    onMove: async (target, move) => {
      drawn.moves.push({ id: target.id, move });
      return { ...target, column: move.op === 'move' ? move.column : move.op === 'icebox' ? 'icebox' : move.op === 'drop' ? 'dropped' : 'backlog' };
    },
    onChanged: () => {
      drawn.changed += 1;
    },
    onSeeDrops: () => {
      drawn.seen += 1;
    },
    onOpenThread: () => {},
    onCreateThread: () => {},
    ...over,
  };
  const render = () => act(() => root!.render(<SidebarProvider><BoardPage {...props} /></SidebarProvider>));
  drawn.rerender = (next) => {
    props = { ...props, ...next };
    render();
  };
  render();
  return drawn;
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((done) => setTimeout(done, 0));
  });
}

const $ = (selector: string) => document.querySelector<HTMLElement>(selector);
const $$ = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)];
const cardEl = (id: string) => $(`.ib-bcard[data-card-id="${id}"]`);

test.if(hasDom)('the lanes in order, the title row, bold while unread, no "on you" pill', async () => {
  scriptFetch();
  draw();
  await settle();
  expect($$('.ib-blanes [data-lane]').map((lane) => lane.dataset.lane)).toEqual(['backlog', 'designing', 'your_look', 'building', 'your_review']);
  expect($('[data-board-summary]')!.textContent).toBe('5 in flight · 2 on you');
  expect($('[data-board-link="shipped"]')!.textContent).toBe('Shipped 1');
  expect($('[data-board-link="icebox"]')!.textContent).toBe('Icebox 1');
  expect(cardEl('crd_price')!.querySelector('.ib-bc-line')!.textContent).toBe('You: Read the copy, then say go');
  // The marks and the age sit in the title row, in this order; a card with nothing owed or pending is that row alone.
  expect([...cardEl('crd_vite')!.querySelectorAll('.ib-bc-top .ib-bc-meta > *')].map((el) => el.className.split(' ')[0])).toEqual(['ib-bc-mark', 'ib-bc-who', 'ib-bc-age']);
  expect(cardEl('crd_vite')!.querySelector('.ib-bc-bot')).toBeNull();
  // Heard after the look: bold. Before it: not.
  expect(cardEl('crd_auto')!.hasAttribute('data-unread')).toBe(true);
  expect(cardEl('crd_hero')!.hasAttribute('data-unread')).toBe(false);
  expect(cardEl('crd_tab')).toBeNull();
  expect($('.ib-onyou')).toBeNull();
  // A card is a button that opens it, named with its state.
  const open = cardEl('crd_auto')!.querySelector<HTMLButtonElement>('[data-card-open]')!;
  expect(open.getAttribute('aria-label')).toContain('Auto-update for users');
  act(() => open.click());
  expect(calls.some((c) => c.path.startsWith('/api/inbox/cards/'))).toBe(false);
});

test.if(hasDom)('a second line only when the person owes something or a send is pending; the agent’s last word only in the opened card', async () => {
  scriptFetch();
  draw({ model: { serverSession: 's', cursor: 1, cards: LINE_CARDS, dropped_unseen: 0, seen_seq: LOOK }, openCard: 'crd_said' });
  await settle();
  const second = (id: string) => cardEl(id)!.querySelector('.ib-bc-bot .ib-bc-line')?.textContent ?? null;
  expect(second('crd_owe')).toBe('You: Read the copy, then say go');
  expect(second('crd_wait')).toBe('Sent to Codex');
  expect(second('crd_said')).toBeNull();
  // Never the agent's word on a lane card, whether or not it has a second line.
  for (const c of LINE_CARDS) expect(cardEl(c.id)!.textContent).not.toContain(c.said!);
  // The opened card has it.
  await settle();
  expect($('[data-card-panel="crd_said"]')!.textContent).toContain('Option 3 of 6 rendered');
});

// Review of #2248: the title is inline, so its own box never reads as cut; the clamp is on the title button.
// What regresses: a title cut at three lines (or a long word cut at the edge) with no way to read it whole.
test.if(hasDom)('a lane card title cut by its clamp opens the full title in a tooltip; one that fits opens none', async () => {
  scriptFetch();
  draw({ model: { serverSession: 's', cursor: 1, cards: LINE_CARDS, dropped_unseen: 0, seen_seq: LOOK } });
  await settle();
  const title = (id: string) => cardEl(id)!.querySelector<HTMLElement>('.ib-bc-t')!;
  const main = (id: string) => cardEl(id)!.querySelector<HTMLElement>('.ib-bc-main')!;
  // Clamped: the button's content is taller than the button.
  Object.defineProperty(main('crd_said'), 'scrollHeight', { configurable: true, get: () => 66 });
  Object.defineProperty(main('crd_said'), 'clientHeight', { configurable: true, get: () => 59 });
  expect(await tooltipOf(title('crd_said'))).toBe('Hero scene timers');
  unhover(title('crd_said'));
  await settle();
  sized(main('crd_owe'), 180, 180);
  expect(await tooltipOf(title('crd_owe'))).toBeNull();
});

test.if(hasDom)('"You: …" opens the thread where the person makes the call, a target apart from opening the card', async () => {
  scriptFetch();
  const threads: { card: string; thread: string }[] = [];
  const drawn = draw({
    model: { serverSession: 's', cursor: 1, cards: YOU_CARDS, dropped_unseen: 0, seen_seq: LOOK },
    rowOf: youRow,
    onOpenThread: (target, thread) => threads.push({ card: target.id, thread }),
  });
  await settle();
  const link = (id: string) => cardEl(id)!.querySelector<HTMLButtonElement>('[data-card-you-link]')!;
  // Two buttons on each card: the title opens the card, "You: …" its thread.
  expect(cardEl('crd_two')!.querySelectorAll('button').length).toBe(2);
  // Its name holds the words it shows (WCAG 2.5.3), so a voice user can say what they see.
  for (const id of ['crd_two', 'crd_sent']) expect(link(id).getAttribute('aria-label')!.startsWith(link(id).textContent!)).toBe(true);
  // The sent thread first; else the linked thread that spoke last.
  act(() => link('crd_sent').click());
  act(() => link('crd_two').click());
  expect(threads).toEqual([
    { card: 'crd_sent', thread: 'msg_sent' },
    { card: 'crd_two', thread: 'msg_new' },
  ]);
  expect(drawn.opened).toEqual([]);
  // No thread linked: "You: …" is plain words, no second tab stop; a click on them opens the card.
  expect(cardEl('crd_none')!.querySelector('[data-card-you-link]')).toBeNull();
  expect(cardEl('crd_none')!.querySelectorAll('button').length).toBe(1);
  act(() => cardEl('crd_none')!.querySelector<HTMLElement>('.ib-bc-youw')!.click());
  expect(drawn.opened).toEqual(['crd_none']);
  // The title, and anywhere else on the card, open the card, never a thread.
  act(() => cardEl('crd_two')!.querySelector<HTMLButtonElement>('[data-card-open]')!.click());
  act(() => cardEl('crd_sent')!.querySelector<HTMLElement>('.ib-bc-age')!.click());
  expect(drawn.opened).toEqual(['crd_none', 'crd_two', 'crd_sent']);
  expect(threads.length).toBe(2);
});

test.if(hasDom)('the opened card: Open thread at the top to the same thread; with no thread, Create thread to the card’s live agent', async () => {
  scriptFetch([{ project: { id: 'prj_1', name: 'web', root: '/Users/ada/src/web' }, sessions: [{ session: 'ses_claude', host: 'claude-code', started_at: OLD, last_seen_at: NEW, busy: false, idle_since: NEW, last_thread: null }] }]);
  const threads: { card: string; thread: string }[] = [];
  const created: { card: string; session: string | null }[] = [];
  const drawn = draw({
    model: { serverSession: 's', cursor: 1, cards: YOU_CARDS, dropped_unseen: 0, seen_seq: LOOK },
    rowOf: youRow,
    openCard: 'crd_two',
    onOpenThread: (target, thread) => threads.push({ card: target.id, thread }),
    onCreateThread: (target, session) => created.push({ card: target.id, session }),
  });
  await settle();
  const open = $('[data-card-panel] .ib-crdp-top [data-card-open-thread]') as HTMLButtonElement;
  // Named by its own words (no aria-label to drift from them), described by what the person owes.
  expect(open.hasAttribute('aria-label')).toBe(false);
  expect(document.getElementById(open.getAttribute('aria-describedby')!)!.textContent).toContain('Merge #15');
  expect($('[data-card-create-thread]')).toBeNull();
  act(() => open.click());
  expect(threads).toEqual([{ card: 'crd_two', thread: 'msg_new' }]);
  // Ask for an update: by History, never beside the agent.
  expect($('[data-card-panel] .ib-crdp-hhead [data-card-ask]')!.textContent).toBe('Ask for an update');
  expect($('[data-card-panel] .ib-crdp-who [data-card-ask]')).toBeNull();
  // No thread linked: no Open thread; Create thread goes to the card’s live agent.
  drawn.rerender({ openCard: 'crd_none' });
  await settle();
  expect($('[data-card-open-thread]')).toBeNull();
  const create = $('[data-card-panel] .ib-crdp-top [data-card-create-thread]') as HTMLButtonElement;
  expect(create.textContent).toBe('Create thread');
  expect(create.disabled).toBe(false);
  act(() => create.click());
  expect(created).toEqual([{ card: 'crd_none', session: 'ses_claude' }]);
  expect(threads.length).toBe(1);
});

test.if(hasDom)('the agents’ drops show above the lanes with their reason; Got it says the person looked', async () => {
  scriptFetch();
  const drawn = draw();
  await settle();
  const notice = $('[data-dropped-notice]')!;
  expect(notice.getAttribute('data-dropped-notice')).toBe('1');
  expect(notice.textContent).toContain('Spike: SQLite for the store');
  expect(notice.textContent).toContain('Superseded by the JSONL store');
  act(() => $('[data-dropped-seen]')!.click());
  expect(drawn.seen).toBe(1);
  act(() => $('[data-card-restore="crd_sqlite"]')!.click());
  await settle();
  expect(drawn.moves).toEqual([{ id: 'crd_sqlite', move: { op: 'restore' } }]);
});

test.if(hasDom)('the opened card: its history and links read now, then Ship, Icebox, and Drop with a reason', async () => {
  scriptFetch();
  const drawn = draw({ openCard: 'crd_vite' });
  await settle();
  const panel = $('[data-card-panel="crd_vite"]')!;
  expect(panel).not.toBeNull();
  expect(cardEl('crd_vite')!.hasAttribute('data-open')).toBe(true);
  expect(calls.map((c) => `${c.method} ${c.path}`)).toContain('GET /api/inbox/cards/crd_vite/refs');
  expect(calls.map((c) => `${c.method} ${c.path}`)).toContain('GET /api/inbox/cards/crd_vite');
  expect(panel.querySelector('section[aria-label="History"]')!.textContent).toContain('Created');
  act(() => panel.querySelector<HTMLButtonElement>('[data-card-ship]')!.click());
  act(() => panel.querySelector<HTMLButtonElement>('[data-card-icebox]')!.click());
  act(() => panel.querySelector<HTMLButtonElement>('[data-card-drop]')!.click());
  const reason = panel.querySelector<HTMLInputElement>('[data-drop-reason]')!;
  expect(reason).not.toBeNull();
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    set.call(reason, 'Folded into the plan');
    reason.dispatchEvent(new Event('input', { bubbles: true }));
  });
  act(() => panel.querySelector<HTMLButtonElement>('[data-drop-confirm]')!.click());
  await settle();
  expect(drawn.moves).toEqual([
    { id: 'crd_vite', move: { op: 'move', column: 'shipped' } },
    { id: 'crd_vite', move: { op: 'icebox' } },
    { id: 'crd_vite', move: { op: 'drop', reason: 'Folded into the plan' } },
  ]);
  // Escape closes it.
  act(() => panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(drawn.opened).toContain(null);
});

test.if(hasDom)('Start on an agent’s Backlog card tells its live agent in the card’s thread and marks the card sent; it never moves it', async () => {
  scriptFetch([{ project: { id: 'prj_1', name: 'web', root: '/Users/ada/src/web' }, sessions: [{ session: 'ses_claude', host: 'claude-code', started_at: OLD, last_seen_at: NEW, busy: false, idle_since: NEW, last_thread: null }] }]);
  const drawn = draw({ openCard: 'crd_auto' });
  await settle();
  const start = $('[data-card-start]') as HTMLButtonElement;
  expect(start).not.toBeNull();
  expect(start.disabled).toBe(false);
  await act(async () => start.click());
  await settle();
  const message = calls.find((c) => c.path === '/api/inbox/threads/msg_auto/message')!;
  expect(message.body).toMatchObject({ session: 'ses_claude' });
  expect(String(message.body!.body)).toContain('Auto-update for users');
  expect(calls.find((c) => c.path === '/api/inbox/cards/crd_auto' && c.method === 'POST')!.body).toMatchObject({ op: 'send', thread_id: 'msg_start' });
  expect(drawn.moves).toEqual([]);
  expect(drawn.changed).toBe(1);
});

test.if(hasDom)('a card the person made gets Send to an agent, not Start; no live agent leaves Start off', async () => {
  scriptFetch();
  draw({ openCard: 'crd_auto' });
  await settle();
  expect(($('[data-card-start]') as HTMLButtonElement).disabled).toBe(true);
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  draw({ openCard: 'crd_poly' });
  await settle();
  // An iced card restores; its menu offers no Start.
  expect($('[data-card-start]')).toBeNull();
  expect($('[data-card-panel="crd_poly"] [data-card-restore="crd_poly"]')).not.toBeNull();
});

test.if(hasDom)('New card into Backlog with its notes', async () => {
  scriptFetch();
  const drawn = draw();
  await settle();
  act(() => $('[data-board-new]')!.click());
  await settle();
  const title = $('[data-new-card-title]') as HTMLInputElement;
  const notes = $('[data-new-card-notes]') as HTMLTextAreaElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(title, 'A roadmap page');
    title.dispatchEvent(new Event('input', { bubbles: true }));
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(notes, 'One page of what is next.');
    notes.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const add = $$('[data-new-card-add]').at(-1)!;
  expect(add.textContent).toContain('Add to Backlog');
  await act(async () => add.click());
  await settle();
  expect(calls.find((c) => c.path === '/api/inbox/cards' && c.method === 'POST')!.body).toMatchObject({ project: 'prj_1', title: 'A roadmap page', notes: 'One page of what is next.', column: 'backlog' });
  expect(drawn.changed).toBe(1);
  expect($('[data-board-live]')!.textContent).toBe('Added “A roadmap page” to Backlog.');
});

test.if(hasDom)('an empty Board says "No cards yet" with Copy prompt', async () => {
  scriptFetch();
  draw({ model: { serverSession: 's', cursor: 1, cards: [], dropped_unseen: 0, seen_seq: null } });
  await settle();
  expect($('[data-board-empty]')!.textContent).toContain('No cards yet');
  expect($('[data-board-summary]')!.textContent).toBe('Nothing in flight');
});

test.if(hasDom)('a phone: one stacked list, Shipped and Icebox folded at the end', async () => {
  scriptFetch();
  draw({ phone: true });
  await settle();
  expect($('[data-board-view="phone"]')).not.toBeNull();
  expect($('.ib-blanes')).toBeNull();
  const folds = $$('[data-board-fold]');
  expect(folds.map((b) => [b.dataset.boardFold, b.getAttribute('aria-expanded')]).slice(-2)).toEqual([
    ['shipped', 'false'],
    ['icebox', 'false'],
  ]);
  // A folded group keeps its body (aria-controls names it), hidden. Booleans, so a failure
  // prints one word, never the React node.
  const shown = () => {
    const el = cardEl('crd_tab');
    return el === null ? 'absent' : el.closest('[hidden]') ? 'hidden' : 'shown';
  };
  expect(shown()).toBe('hidden');
  act(() => $('[data-board-fold="shipped"]')!.click());
  expect(shown()).toBe('shown');
});

/** An IntersectionObserver that sees every card it is given (happy-dom never scrolls). */
function seeEveryCard() {
  const saved = globalThis.IntersectionObserver;
  class Seen {
    constructor(private readonly callback: IntersectionObserverCallback) {}
    observe(target: Element) {
      this.callback([{ target, isIntersecting: true } as unknown as IntersectionObserverEntry], this as unknown as IntersectionObserver);
    }
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  globalThis.IntersectionObserver = Seen as unknown as typeof IntersectionObserver;
  restorers.push(() => {
    globalThis.IntersectionObserver = saved;
  });
}

test.if(hasDom)('a lane card shows its linked PR as a mark: quiet until read, then its state, in its name and tooltip', async () => {
  scriptFetch();
  seeEveryCard();
  draw({ marks: true });
  // Before the answer: the neutral mark, named without a state.
  const neutral = $('.ib-bcard[data-card-id="crd_vite"] [data-card-mark]');
  expect(neutral?.dataset.cardMark).toBe('unknown');
  expect($('.ib-bcard[data-card-id="crd_vite"] [data-card-open]')!.getAttribute('aria-label')).toEndWith('. Pull request #12');
  // Cards with no link carry no mark.
  expect($('.ib-bcard[data-card-id="crd_hero"] [data-card-mark]')).toBeNull();
  await act(async () => {
    await new Promise((done) => setTimeout(done, 300));
  });
  await settle();
  const asked = calls.filter((c) => c.path === '/api/inbox/cards/marks');
  // One request for the cards in view, naming only those that link something.
  expect(asked).toHaveLength(1);
  expect(asked[0]!.body!.cards).toEqual(['crd_vite']);
  const mark = $('.ib-bcard[data-card-id="crd_vite"] [data-card-mark]')!;
  expect(mark.dataset.cardMark).toBe('merged');
  expect(mark.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
  expect($('.ib-bcard[data-card-id="crd_vite"] [data-card-open]')!.getAttribute('aria-label')).toEndWith('. Pull request #12, merged');
  // A component tooltip, never a native title.
  expect(document.querySelector('.ib-bcard [title]')).toBeNull();
  // Moving the card, or a re-render, asks nothing more while the mark is fresh.
  await act(async () => {
    await new Promise((done) => setTimeout(done, 300));
  });
  expect(calls.filter((c) => c.path === '/api/inbox/cards/marks')).toHaveLength(1);
});

test.if(hasDom)('a page that may not read marks (over the tailnet) asks nothing and keeps the quiet mark', async () => {
  scriptFetch();
  seeEveryCard();
  draw({ marks: false });
  await act(async () => {
    await new Promise((done) => setTimeout(done, 300));
  });
  expect(calls.filter((c) => c.path === '/api/inbox/cards/marks')).toHaveLength(0);
  expect($('.ib-bcard[data-card-id="crd_vite"] [data-card-mark]')!.dataset.cardMark).toBe('unknown');
});
