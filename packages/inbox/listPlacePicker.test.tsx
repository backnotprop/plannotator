/**
 * The list title's picker (components/ListPlacePicker.tsx; the owner's pick "E · Title drop-down"): a ⌄ beside the
 * list's title opens the sidebar's places. Drawn here beside the window's own Sidebar, both fed the one places object
 * App builds (sidebarPlaces.ts `sidebarPlacesOf`, with App's route rules), so a pick is compared with the sidebar's
 * own click on the same place.
 *
 * What this catches: the title no longer refreshing, or its click opening the picker; the ⌄ not a button, not
 * opening on a press or on Enter; the picker listing other places, another order or other counts than the sidebar,
 * or not marking the place on screen; a pick that goes anywhere but where the sidebar's click goes (Inbox, a tag,
 * a project, another computer's project); typing that does not narrow, or Enter that does not take the first match;
 * Escape that also runs the window's Escape (App closes the open thread on an Escape nobody used), or that closes
 * before it empties the field; a thread count drawn beside the title; a click open focusing the field (a tablet's
 * keyboard rising) or a key open not focusing it; words matching nothing leaving an empty menu; a Tags section with no
 * tags to list; a project or tag dropped because Customize sidebar hides its section; a count with no words for a
 * screen reader.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxInitiative } from '@plannotator/core/inbox-types';
import type { Route } from './app/route';

const hasDom = typeof document !== 'undefined';
const { InboxList } = (hasDom ? await import('./components/InboxList') : {}) as typeof import('./components/InboxList');
const { Sidebar } = (hasDom ? await import('./components/Sidebar') : {}) as typeof import('./components/Sidebar');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');
const { sidebarPlacesOf } = await import('./sidebarPlaces');
const { setStorageBackend, resetStorageBackend } = await import('@plannotator/ui/utils/storage');
const { SIDEBAR_LAYOUT_COOKIE, sidebarLayoutCookie, resetSidebarLayoutForTests } = await import('./sidebarLayout');
const { INBOX_SIDEBAR_DEFAULT, inboxSidebarSetShown } = await import('@plannotator/core/inbox-sidebar');

let root: Root | null = null;
let host: HTMLElement | null = null;
const stored = new Map<string, string>();
/** Every place the handlers went, in order: `leave`, `refresh` (App's refreshInbox), as App would run them. */
let went: string[] = [];
let refreshed = 0;
/** App's last rung: an Escape nobody used closes the open thread (App.tsx's window keydown listener). */
let threadClosedByEscape = 0;
const appEscape = (event: KeyboardEvent) => {
  if (event.key !== 'Escape' || event.defaultPrevented) return;
  const target = event.target as HTMLElement | null;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
  threadClosedByEscape += 1;
};

beforeEach(() => {
  if (!hasDom) return;
  went = [];
  refreshed = 0;
  threadClosedByEscape = 0;
  stored.clear();
  setStorageBackend({ getItem: (k) => stored.get(k) ?? null, setItem: (k, v) => void stored.set(k, v), removeItem: (k) => void stored.delete(k) });
  window.addEventListener('keydown', appEscape);
});
afterEach(() => {
  if (!hasDom) return;
  window.removeEventListener('keydown', appEscape);
  act(() => root?.unmount());
  resetSidebarLayoutForTests();
  host?.remove();
  for (const node of document.body.querySelectorAll('[data-base-ui-portal], [role="presentation"]')) node.remove();
  document.body.innerHTML = '';
  root = null;
  host = null;
  resetStorageBackend();
});

const folder = (id: string, name: string, machine?: string) => ({ id, key: `${id}-abc123`, name, root: `/tmp/${name}`, created_at: '2026-11-20T10:00:00.000Z', threads: 1, unread: 0, listed: 1, ...(machine ? { machine } : {}) });
const SELF = 'ibx_studio';
const LAPTOP = 'ibx_laptop';
const PROJECTS = [folder('prj_harbor', 'harbor'), folder('prj_fern', 'fern-api'), folder('prj_quill', 'quill-docs'), folder('prj_ledger', 'ledger'), folder('prj_harbor_l', 'harbor', LAPTOP)];
const NAMES = new Map([['prj_harbor', 'harbor'], ['prj_fern', 'fern-api'], ['prj_quill', 'quill-docs'], ['prj_ledger', 'ledger'], ['prj_harbor_l', 'harbor · Laptop']]);
const COUNTS = new Map([['prj_harbor', 1], ['prj_fern', 1], ['prj_harbor_l', 1]]);
const tag = (id: string, name: string) => ({ id, name, created_at: '2026-11-20T10:00:00.000Z', created_by: { kind: 'person' } }) as unknown as InboxInitiative;
const TAGS = [tag('tag_release', 'release'), tag('tag_design', 'design')];

const routeAt = (over: Partial<Route> = {}): Route => ({ page: 'inbox', project: 'prj_harbor', thread: 'thr_cert', ...over }) as Route;

function draw(route: Route = routeAt(), { tagsShown = true } = {}) {
  const places = sidebarPlacesOf({
    route,
    fromCard: false,
    filterMachine: null,
    filterAgent: null,
    tags: {
      tags: TAGS,
      waiting: new Map([['tag_release', 2], ['tag_design', 1]]),
      tagId: route.tag ?? null,
      onOpen: (id) => void went.push(`leave tag ${id}`),
      onCreate: async () => null,
      onRename: async () => false,
      onDelete: () => {},
      shown: tagsShown,
    },
    inboxCount: 4,
    projects: PROJECTS as never,
    self: SELF,
    projectNames: NAMES,
    projectCounts: COUNTS,
    projectActivity: new Map(),
    refreshInbox: (scope, closeThread) => void went.push(`refresh ${scope} close=${closeThread}`),
    leave: (to) => void went.push(`leave ${JSON.stringify(to)}`),
  });
  const noop = () => {};
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <SidebarProvider>
        <Sidebar {...places} update={null} restarting={false} updated={null} onSearch={noop} onCompose={noop} onSettings={noop} onUpdate={noop} onWhatsNew={noop} />
        <InboxList
          title={NAMES.get(route.project ?? '') ?? 'Inbox'}
          path={null}
          places={places}
          sections={[]}
          filtered={route.project !== null}
          narrow={false}
          selectedThreadId={route.thread}
          notice={null}
          onShowNew={noop}
          onOpen={noop}
          onRefresh={() => (refreshed += 1)}
        />
      </SidebarProvider>,
    ),
  );
}

async function settle() {
  for (let i = 0; i < 6; i += 1) await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
}
/** Base UI opens on the pointer's press, as a person's click does; the click counts one click (`detail` 1), as a mouse's does. */
async function press(target: HTMLElement) {
  await act(async () => {
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, detail: 1 }));
    target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }));
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, detail: 1 }));
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, detail: 1 }));
  });
  await settle();
}
/**
 * A key on the focused ⌄ (Enter or Space), then the click a browser fires for it: no pointer, `detail` 0. happy-dom
 * fires no such click itself, so it is sent here; the key must not be prevented, or a browser would send none.
 */
async function keyOpen(name: string) {
  let went = true;
  await act(async () => {
    arrow().focus();
    went = arrow().dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
    if (went) arrow().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
  });
  await settle();
  return went;
}
async function key(name: string) {
  await act(async () => {
    const target = (document.activeElement as HTMLElement | null) ?? document.body;
    target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
  });
  await settle();
}
async function type(text: string) {
  const input = field()!;
  await act(async () => input.focus());
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}

const $ = (selector: string) => document.querySelector<HTMLElement>(selector);
const arrow = () => $('.ib-lhead [data-place-picker]')!;
const menu = () => $('[data-place-menu]');
const field = () => menu()?.querySelector<HTMLInputElement>('input[data-list-filter-find]') ?? null;
const pickRows = () => [...(menu()?.querySelectorAll<HTMLElement>('[data-place]') ?? [])];
/** A picker row by its words: [name, count]. */
const rowWords = () => pickRows().map((el) => [el.querySelector('.ib-pmi-l')!.textContent, el.querySelector('.ib-pmi-n')?.firstChild?.textContent ?? ''] as const);
const pickRow = (name: string) => pickRows().find((el) => el.querySelector('.ib-pmi-l')!.textContent === name)!;
/** The sidebar's row for a place, by its words. */
const sideRow = (name: string) => [...document.querySelectorAll<HTMLElement>('.ib-side .ib-nav-inbox, .ib-side .ib-proj')].find((el) => el.querySelector('.ib-name')?.textContent === name || (name === 'Inbox' && el.classList.contains('ib-nav-inbox')))!;

test.skipIf(!hasDom)('the title still refreshes the list, and its click never opens the picker', async () => {
  draw();
  await press($('.ib-lhead [data-list-refresh]')!);
  expect(refreshed).toBe(1);
  expect(menu()).toBeNull();
  expect(arrow().getAttribute('aria-expanded')).toBe('false');
});

test.skipIf(!hasDom)('the ⌄ is a button that opens the picker on a press; the places, order and counts are the sidebar’s', async () => {
  draw();
  expect(arrow().tagName).toBe('BUTTON');
  expect(arrow().getAttribute('aria-label')).toBe('Switch inbox');
  await press(arrow());
  expect(menu()).not.toBeNull();
  expect(arrow().getAttribute('aria-expanded')).toBe('true');
  expect(rowWords()).toEqual([
    ['Inbox', '4'],
    ['release', '2'],
    ['design', '1'],
    ['harbor', '1'],
    ['fern-api', '1'],
    ['quill-docs', ''],
    ['ledger', ''],
    ['harbor · Laptop', '1'],
  ]);
  // The same projects in the same order as the sidebar draws them.
  const sideProjects = [...document.querySelectorAll('.ib-side .ib-projs .ib-proj .ib-name')].map((el) => el.textContent);
  expect(rowWords().slice(3).map(([name]) => name)).toEqual(sideProjects);
  // The place on screen is the menu's picked row, as in the sidebar.
  expect(pickRows().filter((el) => el.hasAttribute('data-checked')).map((el) => el.querySelector('.ib-pmi-l')!.textContent)).toEqual(['harbor']);
  expect(sideRow('harbor').getAttribute('aria-current')).toBe('page');
  // A count says what it counts to a screen reader, as the sidebar's rows do.
  expect(pickRow('release').querySelector('.ib-pmi-n')!.textContent).toBe('2 waiting on you');
  expect(pickRow('Inbox').querySelector('.ib-pmi-n .ib-sr')!.textContent).toBe(' waiting on you');
  expect(pickRow('harbor · Laptop').querySelector('.ib-pmi-n .ib-sr')!.textContent).toBe(' waiting on you');
});

test.skipIf(!hasDom)('a pointer open focuses the menu, not the field; Enter and Space open it with focus in the field', async () => {
  draw();
  // A mouse press (the filter menu's rule): no field focus, so no tablet keyboard and the pointer's hover stays on.
  await press(arrow());
  expect(menu()).not.toBeNull();
  expect(document.activeElement).not.toBe(field());
  expect(menu()!.contains(document.activeElement)).toBe(true);
  await key('Escape');
  expect(menu()).toBeNull();
  // The keyboard alone, no click: focus in the field, so typing finds at once.
  for (const name of ['Enter', ' ']) {
    expect([name, await keyOpen(name)]).toEqual([name, true]);
    expect([name, menu() !== null]).toEqual([name, true]);
    expect(document.activeElement).toBe(field());
    await key('Escape');
    expect(menu()).toBeNull();
  }
});

test.skipIf(!hasDom)('a pick goes exactly where the sidebar’s click on the same place goes', async () => {
  for (const name of ['fern-api', 'harbor · Laptop', 'harbor', 'Inbox']) {
    went = [];
    draw();
    await act(async () => sideRow(name).click());
    const bySidebar = went;
    expect([name, bySidebar.length]).toEqual([name, 1]);
    went = [];
    await press(arrow());
    await press(pickRow(name));
    expect(went).toEqual(bySidebar);
    expect(menu()).toBeNull();
    act(() => root?.unmount());
    host?.remove();
  }
  // A tag: the tags section's own row.
  went = [];
  draw();
  await act(async () => document.querySelector<HTMLElement>('.ib-side [data-tag-row="tag_design"]')!.click());
  const bySidebar = went;
  expect(bySidebar).toEqual(['leave tag tag_design']);
  went = [];
  await press(arrow());
  await press(pickRow('design'));
  expect(went).toEqual(bySidebar);
});

test.skipIf(!hasDom)('on the Inbox, Inbox is the marked row and picking it refreshes, as its sidebar row does', async () => {
  draw(routeAt({ project: null, thread: null }));
  await press(arrow());
  expect(pickRows().filter((el) => el.hasAttribute('data-checked')).map((el) => el.dataset.place)).toEqual(['inbox']);
  await press(pickRow('Inbox'));
  expect(went).toEqual(['refresh null close=false']);
});

test.skipIf(!hasDom)('typing narrows every section, Inbox steps aside, and Enter takes the first match', async () => {
  draw();
  await press(arrow());
  await type('LAP');
  expect(rowWords()).toEqual([['harbor · Laptop', '1']]);
  expect(menu()!.querySelector('[data-place-group="tags"]')).toBeNull();
  await type('e');
  expect(rowWords().map(([name]) => name)).toEqual(['release', 'design', 'fern-api', 'ledger']);
  await type('quill');
  expect(menu()!.querySelector('.ib-lflt-hit')!.textContent).toBe('quill');
  await key('Enter');
  expect(went).toEqual([`leave ${JSON.stringify({ page: 'inbox', project: 'prj_quill', machine: null, thread: null })}`]);
  expect(menu()).toBeNull();
});

test.skipIf(!hasDom)('words that match nothing draw the filter menu’s visible line for each section, and say it', async () => {
  draw();
  await press(arrow());
  await type('zzz');
  expect(pickRows()).toEqual([]);
  expect([...menu()!.querySelectorAll('[data-list-filter-none]')].map((el) => el.textContent)).toEqual(['No tags match “zzz”', 'No projects match “zzz”']);
  // A screen reader hears the same words once typing pauses (not "0 matches").
  await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 450))));
  expect(menu()!.querySelector('[role="status"]')!.textContent).toBe('No tags match “zzz”. No projects match “zzz”');
  // Matching again: the lines go.
  await type('fern');
  expect(menu()!.querySelector('[data-list-filter-none]')).toBeNull();
});

test.skipIf(!hasDom)('with no tags to list there is no Tags section, and nothing matching says projects only', async () => {
  draw(routeAt(), { tagsShown: false });
  await press(arrow());
  expect(menu()!.querySelector('[data-place-group="tags"]')).toBeNull();
  expect(rowWords().map(([name]) => name)).toEqual(['Inbox', 'harbor', 'fern-api', 'quill-docs', 'ledger', 'harbor · Laptop']);
  await type('zzz');
  expect([...menu()!.querySelectorAll('[data-list-filter-none]')].map((el) => el.textContent)).toEqual(['No projects match “zzz”']);
});

test.skipIf(!hasDom)('Tags and Projects hidden in Customize sidebar are still listed in the picker', async () => {
  const hidden = inboxSidebarSetShown(inboxSidebarSetShown(INBOX_SIDEBAR_DEFAULT, 'tags', false), 'projects', false);
  stored.set(SIDEBAR_LAYOUT_COOKIE, sidebarLayoutCookie(hidden));
  resetSidebarLayoutForTests();
  draw();
  // The sidebar draws neither section.
  expect(document.querySelector('.ib-side [data-tag-row]')).toBeNull();
  expect(document.querySelector('.ib-side .ib-projs .ib-proj')).toBeNull();
  await press(arrow());
  expect(rowWords().map(([name]) => name)).toEqual(['Inbox', 'release', 'design', 'harbor', 'fern-api', 'quill-docs', 'ledger', 'harbor · Laptop']);
});

test.skipIf(!hasDom)('Escape empties the field first, then closes only the picker; focus goes back to the ⌄', async () => {
  draw();
  await press(arrow());
  await type('fern');
  await key('Escape');
  expect(menu()).not.toBeNull();
  expect(field()!.value).toBe('');
  await key('Escape');
  expect(menu()).toBeNull();
  expect(document.activeElement).toBe(arrow());
  // From a row too (focus off the field): the menu takes the key, the window's Escape never runs.
  await press(arrow());
  await key('ArrowDown');
  expect(document.activeElement?.getAttribute('data-place')).toBe('inbox');
  await key('Escape');
  expect(menu()).toBeNull();
  expect(threadClosedByEscape).toBe(0);
  expect(went).toEqual([]);
});

test.skipIf(!hasDom)('no thread count beside the title', () => {
  draw();
  const head = $('.ib-lhead')!;
  const shown = [...head.childNodes].filter((n) => !(n instanceof HTMLElement && n.hidden)).map((n) => n.textContent).join('');
  expect(shown).toBe('harbor');
  expect(head.textContent).not.toMatch(/\d/);
});
