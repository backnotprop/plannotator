/**
 * The project rail's places (railModel.ts), a drag's order (railDrag.ts) and the layout cookie that paints them before
 * the settings read answers (sidebarLayout.ts). What regresses if these fail: a pin going somewhere other than the
 * sidebar's handler for that place, pins drawn out of the person's order, a pin dropped because its place is gone
 * for now, Recent showing places with nothing waiting or more than five, a drop saving the wrong order, or a reload
 * painting the rail off (or without its pins) until the settings read lands.
 */
import { describe, expect, test } from 'bun:test';
import { INBOX_SIDEBAR_DEFAULT, inboxSidebarPin, inboxSidebarSetRail } from '@plannotator/core/inbox-sidebar';
import { parseSidebarLayoutCookie, sidebarLayoutCookie } from '../sidebarLayout';
import { sidebarPlacesOf } from '../sidebarPlaces';
import type { Route } from '../app/route';
import { RECENT_MAX, railTiles, splitPlaceLabel } from './railModel';
import { movedPins } from './railDrag';

const folder = (id: string, name: string, machine?: string) => ({ id, key: `${id}-k`, name, root: `/tmp/${name}`, created_at: '2026-11-20T10:00:00.000Z', threads: 1, unread: 0, listed: 1, ...(machine ? { machine } : {}) });
const PROJECTS = [folder('prj_harbor', 'harbor'), folder('prj_fern', 'fern-api'), folder('prj_quill', 'quill-docs'), folder('prj_ledger', 'ledger'), folder('prj_quill_m', 'quill-docs', 'ibx_mini')];
const NAMES = new Map([['prj_quill_m', 'quill-docs · Mini']]);

function placesAt(route: Partial<Route>, went: string[], counts: Record<string, number> = { prj_harbor: 2, prj_fern: 1, prj_quill_m: 1 }) {
  return sidebarPlacesOf({
    route: { page: 'inbox', project: null, thread: null, ...route } as Route,
    fromCard: false,
    filterMachine: null,
    filterAgent: null,
    tags: {
      tags: [{ id: 'ini_release', name: 'release' }, { id: 'ini_design', name: 'design' }] as never,
      waiting: new Map([['ini_release', 2]]),
      tagId: (route as Route).tag ?? null,
      activity: new Map([['ini_release', '2026-11-26T09:00:00.000Z']]),
      onOpen: (id) => void went.push(`tag ${id}`),
      onCreate: async () => null,
      onRename: async () => false,
      onDelete: () => {},
      shown: true,
    },
    inboxCount: 4,
    projects: PROJECTS as never,
    self: 'ibx_studio',
    projectNames: NAMES,
    projectCounts: new Map(Object.entries(counts)),
    projectActivity: new Map([['prj_harbor', '2026-11-26T10:00:00.000Z'], ['prj_fern', '2026-11-26T08:00:00.000Z'], ['prj_quill_m', '2026-11-26T11:00:00.000Z']]),
    refreshInbox: (scope, close) => void went.push(`refresh ${scope} ${close}`),
    leave: (to) => void went.push(`leave ${to.page} ${to.project}`),
  });
}

describe('the rail’s tiles', () => {
  test('pinned: the person’s order, the sidebar’s names and counts, another computer’s name apart', () => {
    const { recent, tiles } = railTiles(placesAt({}, []), ['project:prj_quill_m', 'tag:ini_release', 'project:prj_harbor']);
    expect(recent).toBe(false);
    expect(tiles.map((t) => [t.name, t.machine, t.count])).toEqual([
      ['quill-docs', 'Mini', 1],
      ['release', null, 2],
      ['harbor', null, 2],
    ]);
  });
  test('a pin runs the sidebar’s own handler for its place, and marks the place on screen', () => {
    const went: string[] = [];
    const places = placesAt({ project: 'prj_harbor' }, went);
    const { tiles } = railTiles(places, ['project:prj_harbor', 'project:prj_fern', 'tag:ini_release']);
    expect(tiles.map((t) => t.on)).toEqual([true, false, false]);
    for (const tile of tiles) tile.go();
    // The same three calls the sidebar's rows make (sidebarPlaces.ts: the place on screen refreshes, another leaves).
    const sidebar: string[] = [];
    const same = placesAt({ project: 'prj_harbor' }, sidebar);
    same.onProject('prj_harbor');
    same.onProject('prj_fern');
    same.tags!.onOpen('ini_release');
    expect(went).toEqual(sidebar);
  });
  test('a pin whose place is gone for now is kept, not drawn', () => {
    const { tiles } = railTiles(placesAt({}, []), ['project:prj_gone', 'project:prj_fern']);
    expect(tiles.map((t) => t.key)).toEqual(['project:prj_fern']);
  });
  test('nothing pinned: Recent, only where something waits, newest first, at most five', () => {
    const { recent, tiles } = railTiles(placesAt({}, []), []);
    expect(recent).toBe(true);
    expect(tiles.map((t) => t.label)).toEqual(['quill-docs · Mini', 'harbor', 'release', 'fern-api']);
    const many = Object.fromEntries(PROJECTS.map((p) => [p.id, 1]));
    expect(railTiles(placesAt({}, [], many), []).tiles.length).toBe(RECENT_MAX);
  });
  test('a name and its computer', () => {
    expect(splitPlaceLabel('harbor · Laptop')).toEqual({ name: 'harbor', machine: 'Laptop' });
    expect(splitPlaceLabel('harbor')).toEqual({ name: 'harbor', machine: null });
  });
});

describe('a drag', () => {
  const order = ['a', 'b', 'c', 'd'];
  test('before or after the pin it is over; over itself or an unknown pin, no change', () => {
    expect(movedPins(order, 'd', 'b', false)).toEqual(['a', 'd', 'b', 'c']);
    expect(movedPins(order, 'a', 'c', true)).toEqual(['b', 'c', 'a', 'd']);
    expect(movedPins(order, 'b', 'b', true)).toEqual(order);
    expect(movedPins(order, 'x', 'b', true)).toEqual(order);
  });
});

describe('the layout cookie', () => {
  test('carries the rail and its pins, so a reload paints them before the settings read', () => {
    const layout = inboxSidebarPin(inboxSidebarPin(inboxSidebarSetRail(INBOX_SIDEBAR_DEFAULT, true), 'project:prj_a,b;c', true), 'tag:ini_x', true);
    const read = parseSidebarLayoutCookie(sidebarLayoutCookie(layout));
    expect(read?.rail).toBe(true);
    expect(read?.pins).toEqual(['project:prj_a,b;c', 'tag:ini_x']);
    // Off with pins kept, and an older cookie with neither.
    expect(parseSidebarLayoutCookie(sidebarLayoutCookie(inboxSidebarSetRail(layout, false)))?.pins).toEqual(['project:prj_a,b;c', 'tag:ini_x']);
    expect(sidebarLayoutCookie(INBOX_SIDEBAR_DEFAULT).split(';')).toHaveLength(3);
  });
});
