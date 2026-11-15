/**
 * Icon sets for agents' icons ("Sets" in the face picker; packages/server/inbox-icon-sets.ts): the sets as the window
 * last read them, each set's icons once opened, and how a `set:<set>/<icon>` face is drawn.
 *
 * An icon is only ever drawn from its address on this Inbox (`/api/inbox/icon-sets/<set>/<icon>`): as an `<img>`
 * (pixel art: nearest-neighbour, at whole multiples of its native size only, agents.css), or, for a one-colour set,
 * as a CSS mask filled with the theme's text colour (an `<img>` cannot take it). Never as markup: an SVG in an image
 * or a mask runs no script and loads nothing. An icon that does not load (a set this machine lacks, an icon a later
 * curation dropped) shows the agent's own mark.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { inboxSetFaceParts, isInboxSetFace, type InboxIconSet, type InboxIconSetListing, type InboxSetFace } from '@plannotator/core/inbox-types';
import { inboxApi } from '../api';
import { inboxUrl } from '../inboxUrl';

export type SetFace = InboxSetFace;
export const isSetFace = isInboxSetFace;
export const setFaceParts = inboxSetFaceParts;

/** How a set's icons are drawn. */
export interface SetLook {
  pixelated?: boolean;
  /** Native px of a pixel set. */
  size?: number;
  mono?: boolean;
  /** Drawn larger inside its tile (its edges cut): for pictures with wide empty margins. */
  zoom?: number;
}

/** The built-in sets' looks, known before any request (the server's manifests say the same: inbox-icon-sets.test). */
export const BUILT_IN_SET_LOOKS: Readonly<Record<string, SetLook>> = {
  'tiny-creatures': { pixelated: true, size: 16 },
  'game-icons': { mono: true },
  dcss: { pixelated: true, size: 32 },
};

export const setIconSrc = (set: string, icon: string) => inboxUrl(`/icon-sets/${encodeURIComponent(set)}/${encodeURIComponent(icon)}`);
export const setCreditsHref = (set: string) => inboxUrl(`/icon-sets/${encodeURIComponent(set)}`, 'credits=1');

/* ---------- the sets ---------- */

let sets: readonly InboxIconSet[] | null = null;
let reading: Promise<void> | null = null;
let readRemote = false;
const listeners = new Set<() => void>();
/** Moves on every change (the sets, a listing): what the hooks redraw on. */
let version = 0;
const tell = () => {
  version++;
  for (const listener of [...listeners]) listener();
};
const versionNow = () => version;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

function take(value: unknown): void {
  const list = (value as { sets?: unknown } | null)?.sets;
  if (!Array.isArray(list)) return;
  sets = list.filter((set): set is InboxIconSet => !!set && typeof set.id === 'string' && typeof set.name === 'string' && typeof set.count === 'number');
  tell();
}

/** Read the sets (`remote`: the pointer's too, which only the picker's Sets asks). */
export function readIconSets(remote = false): Promise<void> {
  if (reading && (readRemote || !remote)) return reading;
  readRemote = remote;
  reading = inboxApi
    .iconSets(remote)
    .then(take, () => {})
    .finally(() => {
      reading = null;
    });
  return reading;
}

export const iconSetsNow = () => sets;
export function useIconSets(): readonly InboxIconSet[] | null {
  return useSyncExternalStore(subscribe, iconSetsNow, () => null);
}

/** A set's look: a built-in one's at once, a fetched one's once the sets are read (asked for here the first time). */
export function setLookOf(set: string): SetLook | null {
  const builtIn = BUILT_IN_SET_LOOKS[set];
  if (builtIn) return builtIn;
  const known = sets?.find((s) => s.id === set);
  if (known) return { pixelated: known.pixelated, size: known.size, mono: known.mono, zoom: known.zoom };
  if (!sets && !reading) void readIconSets(false);
  return null;
}
export function useSetLook(set: string): SetLook | null {
  useSyncExternalStore(subscribe, versionNow, versionNow);
  return setLookOf(set);
}

/* ---------- one set's icons ---------- */

const listings = new Map<string, InboxIconSetListing>();
const listingReads = new Map<string, Promise<void>>();

export function readSetListing(id: string): Promise<void> {
  const known = listingReads.get(id);
  if (known) return known;
  const read = inboxApi
    .iconSet(id)
    .then(
      (value) => {
        const listing = value as InboxIconSetListing | null;
        if (listing && Array.isArray(listing.icons)) {
          listings.set(id, listing);
          tell();
        }
      },
      () => {},
    )
    .finally(() => listingReads.delete(id));
  listingReads.set(id, read);
  return read;
}

export function useSetListing(id: string | null): InboxIconSetListing | null {
  useSyncExternalStore(subscribe, versionNow, versionNow);
  useEffect(() => {
    if (id && !listings.has(id)) void readSetListing(id);
  }, [id]);
  return id ? (listings.get(id) ?? null) : null;
}

/** "Get": download a fetchable set; the picker reads it again while it fills in. */
export async function getIconSet(id: string): Promise<void> {
  try {
    const answer = await inboxApi.getIconSet(id);
    const set = answer?.set as InboxIconSet | undefined;
    if (set && sets) {
      sets = sets.map((s) => (s.id === id ? { ...s, ...set } : s));
      tell();
    }
  } catch {
    // Refused (offline, the pointer changed): the set shows "Get" again.
  }
}

/** Read a fetchable set again (its state and the icons kept so far): while it fills in. */
export async function refreshFetchable(id: string): Promise<void> {
  listingReads.delete(id);
  await Promise.all([readIconSets(false), readSetListing(id)]);
}

/** The CSS variables a set icon's box carries: its native size, its mask (one colour), its zoom. */
export function setArtStyle(look: SetLook | null, src: string | null): Record<string, string> {
  return {
    ...(look?.size ? { '--set-px': `${look.size}px` } : {}),
    ...(look?.mono && src ? { '--set-src': `url("${src}")` } : {}),
    ...(look?.zoom ? { '--set-zoom': String(look.zoom) } : {}),
  };
}

/** A set face's drawing: the address, and the look (null until a fetched set's is known). */
export function setFaceDrawing(face: string): { set: string; icon: string; src: string; look: SetLook | null } | null {
  if (!isSetFace(face)) return null;
  const { set, icon } = setFaceParts(face);
  return { set, icon, src: setIconSrc(set, icon), look: setLookOf(set) };
}

/** Tests: forget everything read. */
export function resetIconSets(): void {
  sets = null;
  reading = null;
  readRemote = false;
  listings.clear();
  listingReads.clear();
  tell();
}
