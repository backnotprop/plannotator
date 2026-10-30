/**
 * The Board's project filter (option a, the owner's pick 2026-10-28): the
 * Project button in the Board's header, as the window draws it over a
 * scripted fetch. What regresses: a Board of one project growing a control
 * it does not need; another project's card on the lanes, in the counts, on
 * the Shipped or Icebox page or in the drops; "in" coming back on the
 * button; the menu offering a project with no card; × or Show all projects
 * not clearing; a card opened from another project closing under the
 * filter; the phone's button squeezed into the header instead of its own
 * row, or its menu not a bottom sheet.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAuthor, InboxCardWire } from '@plannotator/core/inbox-types';
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

const CARDS: InboxCardWire[] = [
  card('web_backlog', WEB),
  card('web_design', WEB, { column: 'designing' }),
  card('web_look', WEB, { column: 'your_look', you: 'Pick a dialog' }),
  card('web_shipped', WEB, { column: 'shipped' }),
  card('web_ice', WEB, { column: 'icebox', aside_from: 'backlog' }),
  card('web_drop', WEB, { column: 'dropped', aside_from: 'building', dropped: { at: AT, by: CLAUDE, reason: 'Superseded', seen_at: null } }),
  card('api_build', API, { column: 'building' }),
  card('api_review', API, { column: 'your_review', you: 'Merge #3' }),
  card('api_shipped', API, { column: 'shipped' }),
  card('docs_ship', 'prj_docs', { column: 'shipped' }),
];

let root: Root | null = null;
const restorers: Array<() => void> = [];

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  while (restorers.length > 0) restorers.pop()!();
});

function scriptFetch() {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://127.0.0.1:1');
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.pathname === '/api/inbox/cards' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { project: string; title: string };
      return json({ card: card('made', body.project, { title: body.title, agent: null }) });
    }
    if (url.pathname === '/api/inbox/sessions') return json({ serverSession: 's', home: '/Users/ada', projects: [] });
    const one = url.pathname.match(/^\/api\/inbox\/cards\/([^/]+)$/);
    if (one) return json({ card: CARDS.find((c) => c.id === one[1]), history: [] });
    if (/\/refs$/.test(url.pathname)) return json({ refs: [] });
    return json({});
  }) as typeof fetch;
  restorers.push(() => {
    globalThis.fetch = original;
  });
}

/** The Board with its project held the way App holds it (the address): each pick is drawn again. */
function draw(over: Partial<BoardPageProps> = {}, cards: InboxCardWire[] = CARDS) {
  const host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  root = createRoot(host);
  const picks: (string | null)[] = [];
  let props: BoardPageProps = {
    view: 'lanes',
    mcpCommand: null,
    claimIntro: false,
    model: { serverSession: 's', cursor: 1, cards, dropped_unseen: 1, seen_seq: 10 },
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
    ...over,
  };
  const render = () => act(() => root!.render(<SidebarProvider><BoardPage {...props} /></SidebarProvider>));
  render();
  return {
    picks,
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

const $ = (selector: string) => document.querySelector<HTMLElement>(selector);
const $$ = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)];
const laneIds = (column: string) => $$(`.ib-blanes [data-lane="${column}"] .ib-bcard`).map((el) => el.getAttribute('data-card-id'));
const shownCards = () => $$('.ib-bcard').map((el) => el.getAttribute('data-card-id')).sort();
/** What the button shows (the screen reader's "Project: " prefix aside). */
const chipWords = () => {
  const label = $('[data-board-project-chip] .ib-bpf-l')!.cloneNode(true) as HTMLElement;
  label.querySelector('.ib-sr')?.remove();
  return label.textContent;
};

test.if(hasDom)('a Board whose cards are all in one project has no Project button and draws as before', async () => {
  scriptFetch();
  draw({}, CARDS.filter((c) => c.project_id === WEB));
  await settle();
  expect($('[data-board-project-filter]')).toBeNull();
  expect($('.ib-bfbar')).toBeNull();
  expect(shownCards()).toEqual(['web_backlog', 'web_design', 'web_look']);
  expect($('[data-board-summary]')!.textContent).toBe('3 in flight · 1 on you');
});

test.if(hasDom)('All projects shows every card; picking a project narrows the lanes, the counts and the links', async () => {
  scriptFetch();
  const drawn = draw();
  await settle();
  // Unfiltered: today's Board, with the button reading All projects.
  expect(chipWords()).toBe('All projects');
  expect(shownCards()).toEqual(['api_build', 'api_review', 'web_backlog', 'web_design', 'web_look']);
  expect($('[data-board-summary]')!.textContent).toBe('5 in flight · 2 on you');
  expect($('[data-board-link="shipped"]')!.textContent).toBe('Shipped 3');
  expect($('[data-dropped-notice]')!.getAttribute('data-dropped-notice')).toBe('1');
  // The button is the Board header's, beside the counts.
  expect($('.ib-bhead [data-board-project-chip]')).not.toBeNull();

  await press($('[data-board-project-chip]')!);
  const menu = $('[data-board-project-menu]')!;
  expect(menu.getAttribute('role')).toBe('menu');
  const options = [...menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
  // Only projects with a card (quiet has none), in the sidebar's order; the docs card's project is not one the Inbox knows.
  expect(options.map((o) => o.textContent?.trim())).toEqual(['All projects', 'web', 'api']);
  expect(options.map((o) => o.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
  await act(async () => options[2]!.click());
  await settle();

  expect(drawn.picks).toEqual([API]);
  expect(shownCards()).toEqual(['api_build', 'api_review']);
  expect(laneIds('building')).toEqual(['api_build']);
  expect(laneIds('backlog')).toEqual([]);
  expect($('[data-board-summary]')!.textContent).toBe('2 in flight · 1 on you');
  expect($('[data-board-link="shipped"]')!.textContent).toBe('Shipped 1');
  expect($('[data-board-link="icebox"]')!.textContent).toBe('Icebox 0');
  // web's drop is not api's news.
  expect($('[data-dropped-notice]')).toBeNull();
  // The project's name alone: no "in" (the owner, 2026-10-28), and a way to clear it.
  expect(chipWords()).toBe('api');
  expect($('[data-board-project-filter]')!.hasAttribute('data-set')).toBe(true);
  // The polite live region names the picked project (its wording is free to change).
  const said = $('[data-board-live]')!.textContent ?? '';
  expect(said).toContain('api');

  // × shows every project again.
  await act(async () => $('[data-board-project-clear]')!.click());
  await settle();
  expect(drawn.picks).toEqual([API, null]);
  expect(shownCards()).toHaveLength(5);
  expect($('[data-board-project-clear]')).toBeNull();
  // Clearing is announced too: a new message, no longer naming api.
  const cleared = $('[data-board-live]')!.textContent ?? '';
  expect(cleared).not.toBe('');
  expect(cleared).not.toBe(said);
  expect(cleared).not.toContain('api');
});

test.if(hasDom)('Shipped and Icebox (with Dropped) list only the filtered project', async () => {
  scriptFetch();
  const drawn = draw({ view: 'shipped', project: API });
  await settle();
  expect(shownCards()).toEqual(['api_shipped']);
  expect(chipWords()).toBe('api');
  drawn.rerender({ view: 'icebox', project: WEB });
  await settle();
  expect(shownCards()).toEqual(['web_ice']);
  expect($$('[data-dropped-row]').map((el) => el.getAttribute('data-dropped-row'))).toEqual(['web_drop']);
  drawn.rerender({ view: 'icebox', project: API });
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
  const title = $('[data-new-card-title]') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(title, 'A roadmap page');
    title.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => $$('[data-new-card-add]').at(-1)!.click());
  await settle();
  expect($('[data-board-live]')!.textContent).toContain('web');
  expect(drawn.picks).toEqual([]);
  expect(chipWords()).toBe('api');
});

test.if(hasDom)('a phone: the Project button on its own row under the header, its menu a bottom sheet', async () => {
  scriptFetch();
  draw({ phone: true, project: WEB });
  await settle();
  expect($('.ib-bhead [data-board-project-chip]')).toBeNull();
  expect($('.ib-bfbar [data-board-project-chip]')).not.toBeNull();
  expect(chipWords()).toBe('web');
  // The stacked list holds only web's cards.
  expect($$('[data-board-view="phone"] .ib-bcard').map((el) => el.getAttribute('data-card-id')).sort()).toEqual(['web_backlog', 'web_design', 'web_look', 'web_shipped', 'web_ice'].sort());
  await press($('[data-board-project-chip]')!);
  expect($('[data-board-project-menu]')).not.toBeNull();
  expect($('.ib-pm-pos[data-phone] [data-board-project-menu]')).not.toBeNull();
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
