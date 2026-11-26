/**
 * The project rail's places (the owner's pick "R1 · The rail is the closed sidebar", 2026-11-26; packages/inbox/rail/):
 * which tiles the rail shows and where each goes. Every place is one of the sidebar's own (sidebarPlaces.ts): its name,
 * its count and its click are the sidebar's, so a pin lands exactly where the same click in the sidebar does.
 *
 * - Pinned (the layout's `pins`, core inbox-sidebar.ts): the pinned places in the person's order. A pin whose place is
 *   not in the window now (a tag deleted, a project gone, or another computer's while the list shows one computer) is
 *   kept, and drawn again when its place comes back.
 * - Nothing pinned: Recent, the places where something waits on the person, newest first, at most five.
 */
import { inboxGroupWaitsOnPerson, type InboxListRow } from '@plannotator/core/inbox-types';
import type { SidebarPlaces } from '../sidebarPlaces';

export const RECENT_MAX = 5;

export interface RailPlace {
  /** `tag:<id>` or `project:<id>`: its pin's name. */
  key: string;
  kind: 'tag' | 'project';
  id: string;
  /** The window's name for it, "harbor · Laptop" for another computer's project. */
  label: string;
  /** The name alone, "harbor". */
  name: string;
  /** Another computer's project: that computer's name ("Laptop"). */
  machine: string | null;
  /** What waits on the person there, counted as the sidebar counts. */
  count: number;
  /** The place on screen. */
  on: boolean;
  /** The sidebar's own handler for that place. */
  go: () => void;
  /** Its latest activity (ISO time), for Recent. */
  activity: string | null;
}

export const tagPin = (id: string) => `tag:${id}`;
export const projectPin = (id: string) => `project:${id}`;

/** "harbor · Laptop" as its name and its computer. */
export function splitPlaceLabel(label: string): { name: string; machine: string | null } {
  const at = label.lastIndexOf(' · ');
  return at < 0 ? { name: label, machine: null } : { name: label.slice(0, at), machine: label.slice(at + 3) };
}

/** The place a pin names, or null when the window has no such place now. */
export function railPlaceOf(places: SidebarPlaces, key: string): RailPlace | null {
  if (key.startsWith('tag:')) {
    const tags = places.tags?.shown ? places.tags : null;
    const id = key.slice(4);
    const tag = tags?.tags.find((other) => other.id === id);
    if (!tags || !tag) return null;
    return {
      key,
      kind: 'tag',
      id,
      label: tag.name,
      name: tag.name,
      machine: null,
      count: tags.waiting.get(id) ?? 0,
      on: places.page === 'inbox' && tags.tagId === id,
      go: () => tags.onOpen(id),
      activity: tags.activity?.get(id) ?? null,
    };
  }
  if (key.startsWith('project:')) {
    const id = key.slice(8);
    const project = places.projects.find((other) => other.id === id);
    if (!project) return null;
    const label = places.projectNames?.get(id) ?? project.name;
    return {
      key,
      kind: 'project',
      id,
      label,
      ...splitPlaceLabel(label),
      count: places.projectCounts.get(id) ?? 0,
      on: (places.page === 'inbox' || places.page === 'plans') && places.projectId === id,
      go: () => places.onProject(id),
      activity: places.projectActivity?.get(id) ?? null,
    };
  }
  return null;
}

/** What the rail shows: the pinned places, or (nothing pinned) Recent. */
export function railTiles(places: SidebarPlaces, pins: readonly string[]): { recent: boolean; tiles: RailPlace[] } {
  const pinned = pins.flatMap((key) => railPlaceOf(places, key) ?? []);
  if (pins.length > 0) return { recent: false, tiles: pinned };
  const tags = places.tags?.shown ? places.tags.tags.map((tag) => tagPin(tag.id)) : [];
  const all = [...tags, ...places.projects.map((project) => projectPin(project.id))].flatMap((key) => railPlaceOf(places, key) ?? []);
  const waiting = all.filter((place) => place.count > 0);
  // Newest first; a place with no time after those with one, in the sidebar's order.
  const tiles = waiting
    .map((place, index) => ({ place, index }))
    .sort((a, b) => (b.place.activity ?? '').localeCompare(a.place.activity ?? '') || a.index - b.index)
    .slice(0, RECENT_MAX)
    .map(({ place }) => place);
  return { recent: true, tiles };
}

/** The rows waiting on the person in one place, newest first: what its peek card lists. */
export function waitingIn(place: Pick<RailPlace, 'kind' | 'id'>, rows: readonly InboxListRow[]): InboxListRow[] {
  return rows
    .filter((row) => inboxGroupWaitsOnPerson(row.section) && (place.kind === 'project' ? row.project.id === place.id : (row.tags ?? []).includes(place.id)))
    .sort((a, b) => b.last_at.localeCompare(a.last_at));
}
