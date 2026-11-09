/**
 * The Board's one filter (approval "board-initiatives", take C; the project
 * part from the owner's pick 2026-10-28): the filter icon in the Board's
 * header, its menu holding Initiative and Project, the picks as tokens, as
 * the window draws it over a scripted fetch. What regresses: a Board of one
 * project offering a Project choice it does not need; another project's (or
 * initiative's) card on the lanes, in the counts, on the Done or Cancelled
 * page or in the drops; the menu offering a project with no card, or wrong
 * counts per initiative and for No initiative; × or Show all not clearing; a
 * card opened from another project closing under the filter; New card not
 * starting in the filtered initiative; the opened card's Initiative not
 * writing; New initiative… not making one; the phone's tokens squeezed into
 * the header instead of their own row, or its menu not a bottom sheet; a card
 * not naming its project while the Board spans projects, or still naming it
 * once one project is picked or every card is in one project.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAuthor, InboxCardWire, InboxInitiative } from '@plannotator/core/inbox-types';
import type { BoardPageProps } from './board/BoardPage';

const hasDom = typeof document !== 'undefined';
const { BoardPage } = (hasDom ? await import('./board/BoardPage') : {}) as typeof import('./board/BoardPage');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');

const CLAUDE: InboxAuthor = { kind: 'agent', host: 'claude-code', session: 'ses_claude', name: 'Claude Code' };
const AT = '2026-10-20T09:00:00.000Z';

function card(id: string, project: string, over: Partial<InboxCardWire> = {}): InboxCardWire {
  return {
    id,
    project_id: project,
    title: id,
    column: 'backlog',
    you: null,
    said: null,
    threads: [],
    prs: [],
    refs: [],
    agent: CLAUDE,
    created_at: AT,
    created_by: CLAUDE,
    moved_at: AT,
    heard_at: AT,
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

const WEB = 'prj_web';
const API = 'prj_api';
const QUIET = 'prj_quiet';
const PROJECTS = [
  { id: WEB, key: 'web', name: 'web', root: '/Users/ada/src/web', created_at: AT, threads: 1, unread: 0 },
  { id: QUIET, key: 'quiet', name: 'quiet', root: '/Users/ada/src/quiet', created_at: AT, threads: 1, unread: 0 },
  { id: API, key: 'api', name: 'api', root: '/Users/ada/src/api', created_at: AT, threads: 1, unread: 0 },
] as BoardPageProps['projects'];

const SHAPE = 'ini_01JX0000000000000000000001';
const MEMORY = 'ini_01JX0000000000000000000002';
const INITIATIVES: InboxInitiative[] = [
  { id: SHAPE, name: 'Shape', created_at: AT, created_by: { kind: 'person' }, updated_at: AT, deleted_at: null },
  { id: MEMORY, name: 'Memory', created_at: AT, created_by: { kind: 'person' }, updated_at: AT, deleted_at: null },
  { id: 'ini_01JX0000000000000000000003', name: 'Gone', created_at: AT, created_by: { kind: 'person' }, updated_at: AT, deleted_at: AT },
];

const CARDS: InboxCardWire[] = [
  card('web_backlog', WEB, { column: 'todo', initiative: SHAPE }),
  card('web_design', WEB, { column: 'in_progress', initiative: SHAPE }),
  card('web_look', WEB, { column: 'in_review', you: 'Pick a dialog' }),
  card('web_done', WEB, { column: 'done' }),
  card('web_ice', WEB, { column: 'dropped', aside_from: 'backlog', dropped: { at: AT, by: { kind: 'person' }, reason: null, seen_at: AT } }),
  card('web_drop', WEB, { column: 'dropped', aside_from: 'in_progress', dropped: { at: AT, by: CLAUDE, reason: 'Superseded', seen_at: null } }),
  card('api_build', API, { column: 'in_progress', initiative: SHAPE }),
  card('api_review', API, { column: 'in_review', you: 'Merge #3' }),
  card('api_done', API, { column: 'done' }),
  card('docs_ship', 'prj_docs', { column: 'done' }),
];

let root: Root | null = null;
const restorers: Array<() => void> = [];

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  while (restorers.length > 0) restorers.pop()!();
});

/** What the window asked the server to write: each POST's path and body. */
const posts: { path: string; body: Record<string, unknown> }[] = [];

function scriptFetch() {
  const original = globalThis.fetch;
  posts.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://127.0.0.1:1');
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (init?.method === 'POST') posts.push({ path: url.pathname, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    if (url.pathname === '/api/inbox/cards' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { project: string; title: string; initiative?: string | null };
      return json({ card: card('made', body.project, { title: body.title, agent: null, initiative: body.initiative ?? null }) });
    }
    if (url.pathname === '/api/inbox/initiatives' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { name: string };
      return json({ initiative: { id: 'ini_01JX0000000000000000000009', name: body.name, created_at: AT, created_by: { kind: 'person' }, updated_at: AT, deleted_at: null } });
    }
    const initiativeAt = url.pathname.match(/^\/api\/inbox\/initiatives\/([^/]+)$/);
    if (initiativeAt && init?.method === 'POST') return json({ initiative: INITIATIVES.find((i) => i.id === initiativeAt[1]) });
    if (url.pathname === '/api/inbox/sessions') return json({ serverSession: 's', home: '/Users/ada', projects: [] });
    const one = url.pathname.match(/^\/api\/inbox\/cards\/([^/]+)$/);
    if (one && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { initiative?: string | null };
      return json({ card: { ...CARDS.find((c) => c.id === one[1])!, initiative: body.initiative ?? null } });
    }
    if (one) return json({ card: CARDS.find((c) => c.id === one[1]), history: [] });
    if (/\/refs$/.test(url.pathname)) return json({ refs: [] });
    return json({});
  }) as typeof fetch;
  restorers.push(() => {
    globalThis.fetch = original;
  });
}

/** The Board with its filter held the way App holds it (the address): each pick is drawn again. */
function draw(over: Partial<BoardPageProps> = {}, cards: InboxCardWire[] = CARDS) {
  const host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  root = createRoot(host);
  const picks: (string | null)[] = [];
  const initiativePicks: (string | null)[] = [];
  let props: BoardPageProps = {
    view: 'lanes',
    mcpCommand: null,
    claimIntro: false,
    model: { serverSession: 's', cursor: 1, cards, dropped_unseen: 1, seen_seq: 10, initiatives: INITIATIVES },
    error: null,
    visitLook: 10,
    handled: new Set(),
    projects: PROJECTS,
    defaultProject: WEB,
    home: '/Users/ada',
    phone: false,
    openCard: null,
    onOpenCard: () => {},
    rowOf: () => null,
    onView: () => {},
    onMove: async () => null,
    onChanged: () => {},
    onSeeDrops: () => {},
    onOpenThread: () => {},
    onCreateThread: () => {},
    project: null,
    onProject: (next) => {
      picks.push(next);
      props = { ...props, project: next };
      render();
    },
    initiative: null,
    onInitiative: (next) => {
      initiativePicks.push(next);
      props = { ...props, initiative: next };
      render();
    },
    ...over,
  };
  const render = () => act(() => root!.render(<SidebarProvider><BoardPage {...props} /></SidebarProvider>));
  render();
  return {
    picks,
    initiativePicks,
    rerender: (next: Partial<BoardPageProps>) => {
      props = { ...props, ...next };
      render();
    },
  };
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((done) => setTimeout(done, 0));
  });
}

/** Base UI opens on the pointer's press, as a person's click does. */
async function press(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    el.click();
  });
  await settle();
}

async function type(input: HTMLInputElement, text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const $ = (selector: string) => document.querySelector<HTMLElement>(selector);
const $$ = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)];
const laneIds = (column: string) => $$(`.ib-blanes [data-lane="${column}"] .ib-bcard`).map((el) => el.getAttribute('data-card-id'));
const shownCards = () => $$('.ib-bcard').map((el) => el.getAttribute('data-card-id')).sort();
/** A token's words: the picked project's or initiative's name, or null when nothing of that kind is picked. */
const token = (kind: 'project' | 'initiative') => $(`[data-board-filter-token="${kind}"] .ib-bflt-tok-l`)?.textContent ?? null;
/** The open menu's rows of one kind: their words (the count apart) and whether each is checked. */
const rows = (attr: 'data-board-project-option' | 'data-board-initiative-option') =>
  $$(`[data-board-filter-menu] [${attr}]`).map((o) => ({
    name: o.querySelector('.ib-pmi-l')?.textContent?.trim() ?? '',
    count: o.querySelector('.ib-bflt-n')?.textContent ?? null,
    checked: o.getAttribute('aria-checked'),
  }));

test.if(hasDom)('a Board whose cards are all in one project: the filter offers initiatives only, and the Board draws as before', async () => {
  scriptFetch();
  draw({}, CARDS.filter((c) => c.project_id === WEB));
  await settle();
  expect($('.ib-bhead [data-board-filter-button]')).not.toBeNull();
  expect($('[data-board-filter-token]')).toBeNull();
  expect($('.ib-bfbar')).toBeNull();
  expect(shownCards()).toEqual(['web_backlog', 'web_design', 'web_look']);
  expect($$('[data-card-project]')).toEqual([]);
  await press($('[data-board-filter-button]')!);
  expect(rows('data-board-project-option')).toEqual([]);
  expect(rows('data-board-initiative-option').map((r) => r.name)).toEqual(['All initiatives', 'Shape', 'Memory', 'No initiative']);
});

test.if(hasDom)('cards name their project while the Board spans projects, on a row above the title, and not once one is picked', async () => {
  scriptFetch();
  const drawn = draw();
  await settle();
  const projectOf = (id: string) => $(`.ib-bcard[data-card-id="${id}"] [data-card-project]`)?.textContent ?? null;
  const cardButton = (id: string) => $(`.ib-bcard[data-card-id="${id}"] .ib-bc-main`)!;
  // The sidebar's names; the marks and the age leave the title's button for the project's row.
  expect(projectOf('web_design')).toBe('web');
  expect(projectOf('api_build')).toBe('api');
  expect($('.ib-bcard[data-card-id="api_build"] .ib-bc-head .ib-bc-meta')).not.toBeNull();
  expect(cardButton('api_build').querySelector('.ib-bc-meta')).toBeNull();
  // The title stays first in the card's name (it is the button's visible words), the project right after it.
  expect(cardButton('api_build').getAttribute('aria-label')).toStartWith('api_build. api. In progress');

  // Done lists every project too: its cards name theirs.
  drawn.rerender({ view: 'done' });
  await settle();
  expect(projectOf('api_done')).toBe('api');
  expect(projectOf('web_done')).toBe('web');

  // One project picked: no names, and the card is the title row it always was.
  drawn.rerender({ view: 'lanes', project: API });
  await settle();
  expect($$('[data-card-project]')).toEqual([]);
  expect(cardButton('api_build').querySelector('.ib-bc-meta')).not.toBeNull();
  expect(cardButton('api_build').getAttribute('aria-label')).toStartWith('api_build. In progress');
});

test.if(hasDom)('All projects shows every card; picking a project narrows the lanes, the counts and the links', async () => {
  scriptFetch();
  const drawn = draw();
  await settle();
  // Unfiltered: today's Board, no token, the icon alone.
  expect($('[data-board-filter-token]')).toBeNull();
  expect($('[data-board-filter-button]')!.getAttribute('aria-label')).toBe('Filter');
  expect(shownCards()).toEqual(['api_build', 'api_review', 'web_backlog', 'web_design', 'web_look']);
  expect($('[data-board-link="done"]')!.textContent).toBe('All done');
  expect($('[data-board-link="cancelled"]')!.textContent).toBe('Cancelled 2');
  expect($('[data-dropped-notice]')!.getAttribute('data-dropped-notice')).toBe('1');

  await press($('[data-board-filter-button]')!);
  const menu = $('[data-board-filter-menu]')!;
  expect(menu.getAttribute('role')).toBe('menu');
  // Only projects with a card (quiet has none), in the sidebar's order; the docs card's project is not one the Inbox knows.
  expect(rows('data-board-project-option')).toEqual([
    { name: 'All projects', count: null, checked: 'true' },
    { name: 'web', count: null, checked: 'false' },
    { name: 'api', count: null, checked: 'false' },
  ]);
  await act(async () => $('[data-board-project-option="prj_api"]')!.click());
  await settle();

  expect(drawn.picks).toEqual([API]);
  expect(shownCards()).toEqual(['api_build', 'api_review']);
  expect(laneIds('in_progress')).toEqual(['api_build']);
  expect(laneIds('todo')).toEqual([]);
  expect($('[data-board-link="cancelled"]')!.textContent).toBe('Cancelled 0');
  // web's drop is not api's news.
  expect($('[data-dropped-notice]')).toBeNull();
  // The project's name alone as the token, and a way to clear it.
  expect(token('project')).toBe('api');
  expect($('[data-board-filter]')!.hasAttribute('data-set')).toBe(true);
  const said = $('[data-board-live]')!.textContent ?? '';
  expect(said).toContain('api');

  // × shows every project again.
  await act(async () => $('[data-board-filter-clear="project"]')!.click());
  await settle();
  expect(drawn.picks).toEqual([API, null]);
  expect(shownCards()).toHaveLength(5);
  expect($('[data-board-filter-token]')).toBeNull();
  const cleared = $('[data-board-live]')!.textContent ?? '';
  expect(cleared).not.toBe('');
  expect(cleared).not.toBe(said);
  expect(cleared).not.toContain('api');
});

test.if(hasDom)('an initiative: its count and No initiative\'s in the menu, the lanes narrowed, the token named, the project filter kept', async () => {
  scriptFetch();
  const drawn = draw({ project: WEB });
  await settle();
  await press($('[data-board-filter-button]')!);
  // Counted on the lanes of the picked project: web has two Shape cards and one in none (its done card is past the week).
  expect(rows('data-board-initiative-option')).toEqual([
    { name: 'All initiatives', count: null, checked: 'true' },
    { name: 'Shape', count: '2', checked: 'false' },
    { name: 'Memory', count: '0', checked: 'false' },
    { name: 'No initiative', count: '1', checked: 'false' },
  ]);
  // A deleted one is never offered.
  expect($('[data-board-initiative-option="ini_01JX0000000000000000000003"]')).toBeNull();
  await act(async () => $(`[data-board-initiative-option="${SHAPE}"]`)!.click());
  await settle();
  expect(drawn.initiativePicks).toEqual([SHAPE]);
  expect(shownCards()).toEqual(['web_backlog', 'web_design']);
  expect(token('initiative')).toBe('Shape');
  expect(token('project')).toBe('web');
  expect($('[data-board-filter-button]')!.getAttribute('aria-label')).toBe('Filter: Shape, web');

  // No initiative: the cards in none.
  drawn.rerender({ project: null, initiative: 'none' });
  await settle();
  expect(shownCards()).toEqual(['api_review', 'web_look']);
  expect(token('initiative')).toBe('No initiative');

  // Its × clears only the initiative.
  drawn.rerender({ project: WEB, initiative: SHAPE });
  await settle();
  await act(async () => $('[data-board-filter-clear="initiative"]')!.click());
  await settle();
  expect(drawn.initiativePicks).toEqual([SHAPE, null]);
  expect(token('project')).toBe('web');
  expect(shownCards()).toEqual(['web_backlog', 'web_design', 'web_look']);
});

test.if(hasDom)('New card on a Board filtered to an initiative starts in it, and its × takes it out', async () => {
  scriptFetch();
  draw({ initiative: SHAPE });
  await settle();
  act(() => $('[data-board-new]')!.click());
  await settle();
  expect($('[data-new-card-initiative] .ib-bflt-tok-l')!.textContent).toBe('Shape');
  await type($('[data-new-card-title]') as HTMLInputElement, 'Tokens pass');
  await act(async () => $$('[data-new-card-add]').at(-1)!.click());
  await settle();
  expect(posts.find((p) => p.path === '/api/inbox/cards')!.body).toMatchObject({ title: 'Tokens pass', initiative: SHAPE });

  // Made again with the initiative taken out: none.
  posts.length = 0;
  act(() => $('[data-board-new]')!.click());
  await settle();
  await act(async () => $('[data-new-card-initiative-clear]')!.click());
  await type($('[data-new-card-title]') as HTMLInputElement, 'Favicon');
  await act(async () => $$('[data-new-card-add]').at(-1)!.click());
  await settle();
  expect(posts.find((p) => p.path === '/api/inbox/cards')!.body).toMatchObject({ title: 'Favicon', initiative: null });
});

test.if(hasDom)('the opened card sets its initiative, and takes it out', async () => {
  scriptFetch();
  const changed: (InboxCardWire | undefined)[] = [];
  draw({ openCard: 'web_look', onChanged: (card) => changed.push(card) });
  await settle();
  const trigger = $('[data-card-panel="web_look"] [data-card-initiative]')!;
  expect(trigger.getAttribute('data-card-initiative')).toBe('none');
  expect(trigger.textContent).toContain('No initiative');
  await press(trigger);
  expect($$('[data-card-initiative-menu] [data-card-initiative-option]').map((o) => o.textContent?.trim())).toEqual(['Shape', 'Memory', 'No initiative']);
  await act(async () => $(`[data-card-initiative-menu] [data-card-initiative-option="${MEMORY}"]`)!.click());
  await settle();
  expect(posts.at(-1)).toEqual({ path: '/api/inbox/cards/web_look', body: { op: 'initiative', initiative: MEMORY } });
  expect(changed.at(-1)?.initiative).toBe(MEMORY);
  expect($('[data-board-live]')!.textContent).toContain('Memory');
});

test.if(hasDom)('New initiative… makes one from the filter menu; Edit initiatives… renames in place', async () => {
  scriptFetch();
  let refreshed = 0;
  draw({ onChanged: () => (refreshed += 1) });
  await settle();
  await press($('[data-board-filter-button]')!);
  await act(async () => $('[data-board-initiative-new]')!.click());
  await settle();
  const dialog = $('[data-dialog="initiatives"]')!;
  expect(dialog).not.toBeNull();
  await type(dialog.querySelector<HTMLInputElement>('[data-initiative-new-name]')!, '  Release ');
  await act(async () => dialog.querySelector<HTMLElement>('[data-initiative-add]')!.click());
  await settle();
  expect(posts.at(-1)).toMatchObject({ path: '/api/inbox/initiatives', body: { name: 'Release' } });
  expect(refreshed).toBe(1);

  // Rename in place: Enter saves.
  const name = dialog.querySelector<HTMLInputElement>(`[data-initiative-row="${SHAPE}"] [data-initiative-name]`)!;
  await type(name, 'Shape v2');
  await act(async () => name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  await settle();
  expect(posts.at(-1)).toMatchObject({ path: `/api/inbox/initiatives/${SHAPE}`, body: { op: 'rename', name: 'Shape v2' } });

});

// The owner, 2026-11-04: "delete initiatives very simply without friction". The failures guarded: a question coming
// back; an Undo drawn under the modal (the page behind it is inert, so it could not be pressed) or lost on Done; a
// double click deleting the row that moved up under the pointer.
test.if(hasDom)('Delete is one click with no question; the toast inside the dialog undoes it, and Done hands the Undo to the window', async () => {
  scriptFetch();
  const toasts: ({ lead: string; detail?: string; onUndo?: () => void } | null)[] = [];
  draw({ onToast: (toast) => toasts.push(toast) });
  await settle();
  await press($('[data-board-filter-button]')!);
  await act(async () => $('[data-board-initiative-edit]')!.click());
  await settle();
  const dialog = $('[data-dialog="initiatives"]')!;
  const row = (id: string) => dialog.querySelector<HTMLElement>(`[data-initiative-row="${id}"]`);
  const del = (id: string) => row(id)!.querySelector<HTMLElement>('[data-initiative-delete]')!;

  await act(async () => del(SHAPE).click());
  await settle();
  expect(posts.at(-1)).toMatchObject({ path: `/api/inbox/initiatives/${SHAPE}`, body: { op: 'delete' } });
  expect(row(SHAPE)).toBeNull();
  const inside = dialog.querySelector<HTMLElement>('.ib-toast')!;
  expect(inside.textContent).toContain('Deleted');
  expect(inside.textContent).toContain('“Shape”');
  // Undo by its button: the dialog's fields take a Z.
  expect(inside.querySelector('[data-toast-undo]')!.getAttribute('aria-keyshortcuts')).toBeNull();
  await act(async () => inside.querySelector<HTMLElement>('[data-toast-undo]')!.click());
  await settle();
  expect(posts.at(-1)).toMatchObject({ path: `/api/inbox/initiatives/${SHAPE}`, body: { op: 'restore' } });
  expect(dialog.querySelector('.ib-toast')).toBeNull();
  expect(row(SHAPE)).not.toBeNull();

  // The second click of a double click writes nothing.
  const before = posts.length;
  await act(async () => del(SHAPE).dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 })));
  await settle();
  expect(posts.length).toBe(before);

  // Two deletes in one toast, undone together, by the window's toast once the dialog closed.
  await act(async () => del(SHAPE).click());
  await settle();
  await act(async () => del(MEMORY).click());
  await settle();
  expect(dialog.querySelector('.ib-toast')!.textContent).toContain('2 initiatives');
  await act(async () => dialog.querySelector<HTMLElement>('[data-initiatives-done]')!.click());
  await settle();
  expect($('[data-dialog="initiatives"]')).toBeNull();
  const handed = toasts.at(-1)!;
  expect(handed.lead).toBe('Deleted');
  await act(async () => handed.onUndo!());
  await settle();
  expect(posts.slice(-2).map((p) => [p.path, p.body.op])).toEqual([
    [`/api/inbox/initiatives/${SHAPE}`, 'restore'],
    [`/api/inbox/initiatives/${MEMORY}`, 'restore'],
  ]);
});

test.if(hasDom)("the Initiatives dialog never shows a browser's raw error: a failed fetch says the one line, a taken name the server's words", async () => {
  scriptFetch();
  const scripted = globalThis.fetch;
  let answer: 'offline' | 'taken' | 'broken' = 'offline';
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://127.0.0.1:1');
    if (url.pathname === '/api/inbox/initiatives' && init?.method === 'POST') {
      if (answer === 'offline') throw new TypeError('Failed to fetch');
      if (answer === 'taken') {
        return new Response(JSON.stringify({ code: 'initiative_exists', error: 'There is already an initiative named Shape.' }), { status: 409, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ code: 'error', error: 'Internal error: disk full' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
    return scripted(input, init);
  }) as typeof fetch;
  draw();
  await settle();
  await press($('[data-board-filter-button]')!);
  await act(async () => $('[data-board-initiative-new]')!.click());
  await settle();
  const dialog = $('[data-dialog="initiatives"]')!;
  const tryAdd = async (name: string) => {
    await type(dialog.querySelector<HTMLInputElement>('[data-initiative-new-name]')!, name);
    await act(async () => dialog.querySelector<HTMLElement>('[data-initiative-add]')!.click());
    await settle();
    return dialog.querySelector('[data-initiative-error]')?.textContent ?? null;
  };
  expect(await tryAdd('Release')).toBe('That did not save. Try again.');
  answer = 'broken';
  expect(await tryAdd('Release')).toBe('That did not save. Try again.');
  answer = 'taken';
  expect(await tryAdd('shape')).toBe('There is already an initiative named Shape.');
});

// Restores answered per initiative: what the two Undos must survive.
function scriptRestores(answers: Record<string, 'taken' | 'offline' | undefined>) {
  scriptFetch();
  const scripted = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://127.0.0.1:1');
    const at = url.pathname.match(/^\/api\/inbox\/initiatives\/([^/]+)$/);
    if (at && init?.method === 'POST' && JSON.parse(String(init.body)).op === 'restore') {
      posts.push({ path: url.pathname, body: { op: 'restore' } });
      const answer = answers[at[1]!];
      if (answer === 'offline') throw new TypeError('Failed to fetch');
      if (answer === 'taken') {
        return new Response(JSON.stringify({ code: 'initiative_exists', error: `There is already an initiative named ${INITIATIVES.find((i) => i.id === at[1])!.name}.` }), { status: 409, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ initiative: INITIATIVES.find((i) => i.id === at[1]) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return scripted(input, init);
  }) as typeof fetch;
}
const restores = () => posts.filter((p) => p.body.op === 'restore').map((p) => p.path.split('/').at(-1));

async function openInitiatives() {
  await settle();
  await press($('[data-board-filter-button]')!);
  await act(async () => $('[data-board-initiative-edit]')!.click());
  await settle();
  const dialog = $('[data-dialog="initiatives"]')!;
  return {
    dialog,
    del: async (id: string) => {
      await act(async () => dialog.querySelector<HTMLElement>(`[data-initiative-row="${id}"] [data-initiative-delete]`)!.click());
      await settle();
    },
    undo: async () => {
      await act(async () => dialog.querySelector<HTMLElement>('.ib-toast [data-toast-undo]')!.click());
      await settle();
    },
    error: () => dialog.querySelector('[data-initiative-error]')?.textContent ?? null,
  };
}

// The review's picture: the line said the name was taken while the toast still offered the Undo that had just failed.
test.if(hasDom)('the dialog: a refused Undo stops offering it, the others still come back, and focus stays in the dialog; a failed save can be tried again', async () => {
  const answers: Record<string, 'taken' | 'offline' | undefined> = { [MEMORY]: 'offline' };
  scriptRestores(answers);
  let changed = 0;
  draw({ onChanged: () => changed++ });
  const { dialog, del, undo, error } = await openInitiatives();

  await del(MEMORY);
  await undo();
  expect(error()).toBe('That did not save. Try again.');
  expect(dialog.querySelector('.ib-toast [data-toast-undo]')).not.toBeNull();

  // Refused alone: the line, no toast, a read (who took the name shows), focus on the name field and not the page.
  answers[MEMORY] = 'taken';
  const before = changed;
  await undo();
  expect(error()).toBe('There is already an initiative named Memory.');
  expect(dialog.querySelector('.ib-toast')).toBeNull();
  expect(changed).toBeGreaterThan(before);
  expect(document.activeElement).toBe(dialog.querySelector('[data-initiative-new-name]'));

  // Refused first, with another waiting behind it: that one is still restored.
  await del(MEMORY);
  await del(SHAPE);
  expect(dialog.querySelector('.ib-toast')!.textContent).toContain('2 initiatives');
  posts.length = 0;
  await undo();
  expect(restores()).toEqual([MEMORY, SHAPE]);
  expect(error()).toBe('There is already an initiative named Memory.');
  expect(dialog.querySelector('.ib-toast')).toBeNull();
});

// The review's order: Alpha refused with two waiting, the second click of a double click took one of their Undos.
test.if(hasDom)('the dialog: a double click on Undo restores once and keeps what is left', async () => {
  const answers: Record<string, 'taken' | 'offline' | undefined> = { [MEMORY]: 'offline', [SHAPE]: 'offline' };
  scriptRestores(answers);
  draw();
  const { dialog, del, error } = await openInitiatives();
  await del(MEMORY);
  await del(SHAPE);
  posts.length = 0;
  const button = dialog.querySelector<HTMLElement>('.ib-toast [data-toast-undo]')!;
  await act(async () => {
    button.click();
    button.click();
  });
  await settle();
  expect(restores()).toEqual([MEMORY, SHAPE]);
  expect(error()).toBe('That did not save. Try again.');
  expect(dialog.querySelector('.ib-toast')!.textContent).toContain('2 initiatives');
});

// Done pressed while the restore is on its way: the window's toast offered Undo for what was already back.
test.if(hasDom)("Done during the dialog's Undo hands the window's toast only what the restore leaves out", async () => {
  const answers: Record<string, 'taken' | 'offline' | undefined> = { [MEMORY]: 'offline' };
  scriptRestores(answers);
  const scripted = globalThis.fetch;
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST' && JSON.parse(String(init.body)).op === 'restore') await held;
    return scripted(input, init);
  }) as typeof fetch;
  const toasts: ({ lead: string; detail?: string; onUndo?: () => void } | null)[] = [];
  draw({ onToast: (toast) => toasts.push(toast) });
  const { dialog, del, undo } = await openInitiatives();
  await del(SHAPE);
  await del(MEMORY);
  await undo();
  await act(async () => dialog.querySelector<HTMLElement>('[data-initiatives-done]')!.click());
  await settle();
  expect($('[data-dialog="initiatives"]')).toBeNull();
  expect(toasts.filter((t) => t?.lead === 'Deleted')).toEqual([]);

  await act(async () => release());
  await settle();
  const handed = toasts.at(-1)!;
  expect([handed.lead, handed.detail]).toEqual(['Deleted', '“Memory”']);
  expect(handed.onUndo).toBeDefined();
});

// Seven seconds from the delete would take the Undo away just after the line said to try again.
test.if(hasDom)("a failed save in the dialog gives its Undo the toast's full time again", async () => {
  scriptRestores({ [MEMORY]: 'offline' });
  draw();
  const { dialog, del, undo } = await openInitiatives();
  await del(MEMORY);
  const realSet = globalThis.setTimeout;
  const armed: number[] = [];
  globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
    armed.push(ms ?? 0);
    return realSet(fn, ms, ...(rest as []));
  }) as typeof setTimeout;
  try {
    await undo();
  } finally {
    globalThis.setTimeout = realSet;
  }
  expect(dialog.querySelector('.ib-toast [data-toast-undo]')).not.toBeNull();
  expect(armed).toContain(7000);
});

// The review's blocker: after Done, one refused name lost every other initiative in the toast, and a failed save left nothing to press.
test.if(hasDom)("the window's Undo after Done: every restore is tried; a failed save offers Undo again, for what is still out", async () => {
  const answers: Record<string, 'taken' | 'offline' | undefined> = { [MEMORY]: 'taken' };
  scriptRestores(answers);
  const toasts: ({ lead: string; onUndo?: () => void } | null)[] = [];
  draw({ onToast: (toast) => toasts.push(toast) });
  const { dialog, del } = await openInitiatives();
  const done = async () => {
    await act(async () => dialog.querySelector<HTMLElement>('[data-initiatives-done]')!.click());
    await settle();
  };
  await del(MEMORY);
  await del(SHAPE);
  await done();
  posts.length = 0;

  // A name taken, with another behind it: the other comes back, the line says why, and no Undo is left to fail again.
  await act(async () => toasts.at(-1)!.onUndo!());
  await settle();
  expect(restores()).toEqual([MEMORY, SHAPE]);
  expect(toasts.at(-1)!.lead).toBe('There is already an initiative named Memory.');
  expect(toasts.at(-1)!.onUndo).toBeUndefined();
});

test.if(hasDom)("the window's Undo after a failed save: pressed again, it tries what is still out and nothing that came back", async () => {
  const answers: Record<string, 'taken' | 'offline' | undefined> = { [MEMORY]: 'offline' };
  scriptRestores(answers);
  const toasts: ({ lead: string; onUndo?: () => void } | null)[] = [];
  draw({ onToast: (toast) => toasts.push(toast) });
  const { dialog, del } = await openInitiatives();
  await del(SHAPE);
  await del(MEMORY);
  await act(async () => dialog.querySelector<HTMLElement>('[data-initiatives-done]')!.click());
  await settle();
  posts.length = 0;
  await act(async () => toasts.at(-1)!.onUndo!());
  await settle();
  expect(restores()).toEqual([SHAPE, MEMORY]);
  expect(toasts.at(-1)!.lead).toBe('That did not save. Try again.');

  answers[MEMORY] = undefined;
  posts.length = 0;
  await act(async () => toasts.at(-1)!.onUndo!());
  await settle();
  expect(restores()).toEqual([MEMORY]);
  expect(toasts.at(-1)).toBeNull();
});

test.if(hasDom)('Done and Cancelled list only the filtered project', async () => {
  scriptFetch();
  const drawn = draw({ view: 'done', project: API });
  await settle();
  expect(shownCards()).toEqual(['api_done']);
  expect(token('project')).toBe('api');
  drawn.rerender({ view: 'cancelled', project: WEB });
  await settle();
  expect($$('[data-dropped-row]').map((el) => el.getAttribute('data-dropped-row')).sort()).toEqual(['web_drop', 'web_ice']);
  drawn.rerender({ view: 'cancelled', project: API });
  await settle();
  expect(shownCards()).toEqual([]);
  expect($$('[data-dropped-row]')).toEqual([]);
  // The empty line is the filtered one: it names the project.
  expect($('.ib-blist .ib-lane-empty')!.textContent).toContain('api');
});

test.if(hasDom)('a project with nothing in flight says so, and Show all projects clears the filter', async () => {
  scriptFetch();
  const drawn = draw({ project: QUIET });
  await settle();
  const empty = $('[data-board-empty="project"]')!;
  expect(empty.querySelector('b')!.textContent).toBe('quiet');
  // Not the empty Board's line: the Board has cards, this project has none.
  expect($('[data-board-empty=""]')).toBeNull();
  await act(async () => $('[data-board-show-all]')!.click());
  await settle();
  expect(drawn.picks).toEqual([null]);
  expect($('[data-board-empty="project"]')).toBeNull();
  expect(shownCards()).toHaveLength(5);
});

test.if(hasDom)('a card opened from another project stays open while the Board is filtered', async () => {
  scriptFetch();
  draw({ project: API, openCard: 'web_design' });
  await settle();
  expect($('[data-card-panel="web_design"]')).not.toBeNull();
  expect(shownCards()).toEqual(['api_build', 'api_review']);
});

test.if(hasDom)('a card made in another project while filtered: the announcement names that project, the filter stays', async () => {
  scriptFetch();
  // Filtered to api, with New card on web (as when the person picks another project in the dialog).
  const drawn = draw({ project: API, defaultProject: WEB });
  await settle();
  act(() => $('[data-board-new]')!.click());
  await settle();
  await type($('[data-new-card-title]') as HTMLInputElement, 'A roadmap page');
  await act(async () => $$('[data-new-card-add]').at(-1)!.click());
  await settle();
  expect($('[data-board-live]')!.textContent).toContain('web');
  expect(drawn.picks).toEqual([]);
  expect(token('project')).toBe('api');
});

test.if(hasDom)('a phone: the filter icon in the header, its picks on their own row under it, its menu a bottom sheet', async () => {
  scriptFetch();
  draw({ phone: true, project: WEB, initiative: SHAPE });
  await settle();
  expect($('.ib-bhead [data-board-filter-button]')).not.toBeNull();
  expect($('.ib-bhead [data-board-filter-token]')).toBeNull();
  expect($$('.ib-bfbar [data-board-filter-token]').map((el) => el.getAttribute('data-board-filter-token'))).toEqual(['initiative', 'project']);
  // The stacked list holds only web's Shape cards.
  expect($$('[data-board-view="phone"] .ib-bcard').map((el) => el.getAttribute('data-card-id')).sort()).toEqual(['web_backlog', 'web_design']);
  await press($('[data-board-filter-button]')!);
  expect($('.ib-pm-pos[data-phone] [data-board-filter-menu]')).not.toBeNull();
  expect($('.ib-pm-scrim')).not.toBeNull();
});

test.if(hasDom)('a phone filtered to a project with no cards says so, with Show all projects', async () => {
  scriptFetch();
  draw({ phone: true, project: QUIET });
  await settle();
  expect($('[data-board-empty="project"]')!.textContent).toContain('quiet');
  expect($('[data-board-view="phone"] .ib-bstack')).toBeNull();
  expect($('[data-board-show-all]')).not.toBeNull();
});
