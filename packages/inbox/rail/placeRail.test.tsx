/**
 * The project rail (rail/PlaceRail.tsx; the owner's pick "R1 · The rail is the closed sidebar"), drawn in the window's
 * own sidebar shell (shell/SidebarShell.tsx) with the window's own Sidebar and list, all fed the one places object App
 * builds (sidebarPlaces.ts `sidebarPlacesOf`, with App's route rules).
 *
 * What this catches: anything drawn with the mode off (it is off by default: the closed sidebar must stay exactly as
 * today); no rail when the sidebar is closed and the mode is on; the rail staying in sight once the sidebar opens; a
 * pin that goes anywhere but where the sidebar's own click on that place goes; pin, unpin and reorder not saved with
 * the layout; ⋯ building its own flyout instead of opening today's peek; the choice missing from the sidebar's
 * right-click or not saved; the selected tile marked by anything on its edge; a thread count beside the list title.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxInitiative } from '@plannotator/core/inbox-types';
import type { Route } from '../app/route';

const hasDom = typeof document !== 'undefined';
const { InboxList } = (hasDom ? await import('../components/InboxList') : {}) as typeof import('../components/InboxList');
const { Sidebar } = (hasDom ? await import('../components/Sidebar') : {}) as typeof import('../components/Sidebar');
const { SidebarShell } = (hasDom ? await import('../shell/SidebarShell') : {}) as typeof import('../shell/SidebarShell');
const { sidebarPlacesOf } = await import('../sidebarPlaces');
const { setStorageBackend, resetStorageBackend } = await import('@plannotator/ui/utils/storage');
const { SIDEBAR_LAYOUT_COOKIE, sidebarLayoutCookie, resetSidebarLayoutForTests } = await import('../sidebarLayout');
const { INBOX_SIDEBAR_DEFAULT } = await import('@plannotator/core/inbox-sidebar');

let root: Root | null = null;
let host: HTMLElement | null = null;
const stored = new Map<string, string>();
const saves: { rail?: boolean; pins?: string[] }[] = [];
let went: string[] = [];
const realFetch = globalThis.fetch;
const realMatchMedia = hasDom ? window.matchMedia : undefined;

beforeEach(() => {
  if (!hasDom) return;
  went = [];
  saves.length = 0;
  stored.clear();
  setStorageBackend({ getItem: (k) => stored.get(k) ?? null, setItem: (k, v) => void stored.set(k, v), removeItem: (k) => void stored.delete(k) });
  let rev = 0;
  // The settings write (the layout's save): answered with what it saved.
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const sidebar = (JSON.parse(init?.body ?? '{}') as { sidebar: { rail?: boolean; pins?: string[] } }).sidebar;
    saves.push(sidebar);
    return new Response(JSON.stringify({ sidebar, sidebar_rev: ++rev }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  // A desktop window 1440 wide: the peek's query matches, a phone's does not.
  window.matchMedia = ((query: string) => ({ matches: query.includes('min-width: 1024px'), media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
  resetSidebarLayoutForTests();
});
afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  resetSidebarLayoutForTests();
  host?.remove();
  document.body.innerHTML = '';
  root = null;
  host = null;
  globalThis.fetch = realFetch;
  window.matchMedia = realMatchMedia!;
  resetStorageBackend();
});

const folder = (id: string, name: string, machine?: string) => ({ id, key: `${id}-k`, name, root: `/tmp/${name}`, created_at: '2026-11-20T10:00:00.000Z', threads: 1, unread: 0, listed: 1, ...(machine ? { machine } : {}) });
const PROJECTS = [folder('prj_harbor', 'harbor'), folder('prj_fern', 'fern-api'), folder('prj_quill', 'quill-docs'), folder('prj_ledger', 'ledger'), folder('prj_harbor_l', 'harbor', 'ibx_laptop')];
const NAMES = new Map([['prj_harbor', 'harbor'], ['prj_fern', 'fern-api'], ['prj_quill', 'quill-docs'], ['prj_ledger', 'ledger'], ['prj_harbor_l', 'harbor · Laptop']]);
const COUNTS = new Map([['prj_harbor', 1], ['prj_fern', 1], ['prj_harbor_l', 1]]);
const TAGS = [{ id: 'tag_release', name: 'release' }, { id: 'tag_design', name: 'design' }] as unknown as InboxInitiative[];
const PINS = ['project:prj_harbor', 'project:prj_fern', 'tag:tag_release'];

function saved(layout: { rail?: true; pins?: string[] }) {
  stored.set(SIDEBAR_LAYOUT_COOKIE, sidebarLayoutCookie({ ...INBOX_SIDEBAR_DEFAULT, ...layout }));
}

function draw({ open = false, route = { page: 'inbox', project: 'prj_harbor', thread: null } as Route } = {}) {
  const places = sidebarPlacesOf({
    route,
    fromCard: false,
    filterMachine: null,
    filterAgent: null,
    tags: { tags: TAGS, waiting: new Map([['tag_release', 2]]), tagId: route.tag ?? null, onOpen: (id) => void went.push(`tag ${id}`), onCreate: async () => null, onRename: async () => false, onDelete: () => {}, shown: true },
    inboxCount: 4,
    projects: PROJECTS as never,
    self: 'ibx_studio',
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
  let isOpen = open;
  const render = () =>
    root!.render(
      <SidebarShell
        open={isOpen}
        onOpenChange={(next) => {
          isOpen = next;
          render();
        }}
        rail={{ places, machines: { self: 'ibx_studio', all: [] } as never, rows: [], readable: new Set(['prj_fern']), onProjectAction: (id, action) => void went.push(`${action} ${id}`) }}
        navigation={<Sidebar {...places} update={null} restarting={false} updated={null} onSearch={noop} onCompose={noop} onSettings={noop} onUpdate={noop} onWhatsNew={noop} />}
      >
        <main className="ib-main">
          <InboxList title="harbor" path={null} places={places} sections={[]} filtered narrow={false} selectedThreadId={null} notice={null} onShowNew={noop} onOpen={noop} onRefresh={noop} />
        </main>
      </SidebarShell>,
    );
  act(render);
}

async function settle() {
  for (let i = 0; i < 6; i += 1) await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
}
async function press(target: Element) {
  await act(async () => {
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, detail: 1 }));
    target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }));
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, detail: 1 }));
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, detail: 1 }));
  });
  await settle();
}
async function rightClick(target: Element) {
  await act(async () => void target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 30, clientY: 200 })));
  await settle();
}
const $ = (selector: string) => document.querySelector<HTMLElement>(selector);
const rail = () => $('[data-place-rail]');
const tile = (key: string) => $(`[data-place-rail] [data-rail-place="${key}"]`)!;
const tiles = () => [...document.querySelectorAll<HTMLElement>('[data-place-rail] [data-rail-place]')].map((el) => el.getAttribute('data-rail-place'));
const sideProject = (name: string) => [...document.querySelectorAll<HTMLElement>('.ib-sb-panel .ib-side .ib-proj')].find((el) => el.querySelector('.ib-name')?.textContent === name)!;

test.skipIf(!hasDom)('off by default: a closed sidebar leaves nothing, exactly as today', async () => {
  draw();
  await settle();
  expect(rail()).toBeNull();
  expect($('.ib-sb-wrapper')!.hasAttribute('data-rail')).toBe(false);
  // Pins kept from an earlier time, the mode off: still nothing.
  resetSidebarLayoutForTests();
  act(() => root?.unmount());
  saved({ pins: PINS });
  draw();
  await settle();
  expect(rail()).toBeNull();
});

test.skipIf(!hasDom)('closed with the mode on: the rail, Inbox then the pins in order with their counts; open: it steps aside', async () => {
  saved({ rail: true, pins: PINS });
  draw();
  await settle();
  expect(rail()!.hasAttribute('data-shown')).toBe(true);
  expect(tiles()).toEqual(['inbox', ...PINS]);
  expect(tile('project:prj_harbor').getAttribute('aria-current')).toBe('page');
  expect(tile('tag:tag_release').textContent).toContain('2 waiting on you');
  // ⊟ (the list header's toggle) docks the sidebar: the rail is out of sight and out of reach.
  await press($('.ib-lhead [data-sidebar="trigger"]')!);
  expect(rail()!.hasAttribute('data-shown')).toBe(false);
  expect(rail()!.inert).toBe(true);
  expect($('.ib-sb-wrapper')!.hasAttribute('data-rail')).toBe(false);
});

test.skipIf(!hasDom)('a pin goes exactly where the sidebar’s own click on that place goes', async () => {
  saved({ rail: true, pins: PINS });
  draw({ open: true });
  await settle();
  // The sidebar's rows (docked open), then the rail's tiles (closed), for the same places.
  for (const name of ['fern-api', 'harbor']) await press(sideProject(name));
  const bySidebar = [...went];
  went = [];
  await press($('.ib-lhead [data-sidebar="trigger"]')!);
  await press(tile('project:prj_fern'));
  await press(tile('project:prj_harbor'));
  expect(went).toEqual(bySidebar);
  expect(went[0]).toContain('"project":"prj_fern"');
  // A tag, and Inbox.
  went = [];
  await press(tile('tag:tag_release'));
  await press(tile('inbox'));
  expect(went).toEqual(['tag tag_release', 'leave {"page":"inbox","project":null,"thread":null}']);
});

test.skipIf(!hasDom)('pin from +, reorder and unpin from a pin’s right-click: each saved with the layout', async () => {
  saved({ rail: true, pins: PINS });
  draw();
  await settle();
  await press($('[data-place-rail] [data-place-picker]')!);
  const pin = $('[data-place-menu] [data-place-pin="project:prj_ledger"]')!;
  expect(pin.getAttribute('aria-label')).toBe('Pin ledger');
  expect($('[data-place-menu] [data-place-pin="project:prj_harbor"]')!.getAttribute('aria-checked')).toBe('true');
  await press(pin);
  expect(saves.at(-1)?.pins).toEqual([...PINS, 'project:prj_ledger']);
  // The menu stays open on a pin; the name itself still goes there.
  expect($('[data-place-menu]')).not.toBeNull();
  await act(async () => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await settle();

  await rightClick(tile('project:prj_fern'));
  expect($('[data-rail-menu="place"]')).not.toBeNull();
  await press($('[data-rail-action="up"]')!);
  expect(saves.at(-1)?.pins).toEqual(['project:prj_fern', 'project:prj_harbor', 'tag:tag_release', 'project:prj_ledger']);
  expect(tiles()).toEqual(['inbox', 'project:prj_fern', 'project:prj_harbor', 'tag:tag_release', 'project:prj_ledger']);

  await rightClick(tile('tag:tag_release'));
  await press($('[data-rail-action="unpin"]')!);
  expect(saves.at(-1)?.pins).toEqual(['project:prj_fern', 'project:prj_harbor', 'project:prj_ledger']);
  expect(saves.at(-1)?.rail).toBe(true);
});

test.skipIf(!hasDom)('nothing pinned: Recent holds the places where something waits', async () => {
  saved({ rail: true });
  draw();
  await settle();
  expect($('.ib-rail-cap')?.textContent).toBe('Recent');
  expect(tiles().slice(1).sort()).toEqual(['project:prj_fern', 'project:prj_harbor', 'project:prj_harbor_l', 'tag:tag_release']);
});

test.skipIf(!hasDom)('⋯ opens today’s peek (the whole sidebar), not a flyout of its own; again closes it', async () => {
  saved({ rail: true, pins: PINS });
  draw();
  await settle();
  const peek = $('[data-sidebar-peek]')!;
  expect(peek.hasAttribute('data-visible')).toBe(false);
  await press($('[data-rail-more]')!);
  expect(peek.hasAttribute('data-visible')).toBe(true);
  expect(peek.querySelector('.ib-side')).not.toBeNull();
  expect(document.querySelectorAll('[data-sidebar-peek]')).toHaveLength(1);
  await press($('[data-rail-more]')!);
  expect(peek.hasAttribute('data-visible')).toBe(false);
});

test.skipIf(!hasDom)('the choice is in the sidebar’s right-click menu, and turning it on is saved', async () => {
  draw({ open: true });
  await settle();
  await rightClick($('.ib-sb-panel .ib-side')!);
  const keep = $('[data-sidebar-menu] [data-rail-choice="rail"]')!;
  expect(keep.textContent).toContain('Keep a rail of places');
  expect($('[data-sidebar-menu] [data-rail-choice="hide"]')!.getAttribute('aria-checked')).toBe('true');
  await press(keep);
  expect(saves.at(-1)?.rail).toBe(true);
});

test.skipIf(!hasDom)('no mark on a tile’s edge, and no thread count beside the list title', async () => {
  saved({ rail: true, pins: PINS });
  draw();
  await settle();
  // The selected tile holds its mark, its name and its words, nothing else.
  const on = tile('project:prj_harbor');
  expect([...on.children].map((el) => el.className)).toEqual(['ib-rail-mk', 'ib-rail-l', 'ib-sr']);
  // Its look: the soft fill only, no border, inset shadow or pseudo-element on any rail rule.
  const css = readFileSync(join(import.meta.dir, 'rail.css'), 'utf8');
  for (const rule of css.match(/[^{}]*\.ib-rail-tile[^{}]*\{[^}]*\}/g) ?? []) {
    expect(rule).not.toMatch(/border-(left|inline-start)|box-shadow:\s*inset|::?(before|after)/);
  }
  expect($('.ib-lhead')!.textContent).not.toMatch(/\d+\s*threads?/);
});
