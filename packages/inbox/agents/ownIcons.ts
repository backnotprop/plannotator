/**
 * "Your own…": the pictures the person uploaded for agents' icons (packages/server/inbox-agent-icons.ts), as the
 * window last heard them (the faces' wire carries them: a read, a save's answer, `event: agent-faces`).
 *
 * A picture is only ever drawn as an `<img>` whose `src` is its address on this Inbox (`/api/inbox/agent-icons/<hash>`,
 * set as an attribute, never markup), so an SVG runs no script and loads nothing from outside. It moves only in the
 * sidebar; everywhere else, and under reduced motion, the window asks for its still (`still=1`: the first frame of
 * one that moves, the picture itself otherwise).
 */
import { useSyncExternalStore } from 'react';
import { inboxOwnFaceHash, isInboxOwnFace, readInboxAgentIcons, type InboxAgentIcon, type InboxOwnFace } from '@plannotator/core/inbox-types';
import { inboxUrl } from '../inboxUrl';

/** The pictures, newest first; null until a wire named them (an Inbox from before uploads never does). */
let icons: readonly InboxAgentIcon[] | null = null;
let ids: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

/** Take the pictures a wire names (none named: kept as they were). True when they changed. */
export function hearOwnIcons(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  const next = readInboxAgentIcons(value);
  if (icons && icons.length === next.length && icons.every((icon, i) => icon.id === next[i]!.id && icon.at === next[i]!.at)) return false;
  icons = next;
  ids = new Set(next.map((icon) => icon.id));
  for (const listener of [...listeners]) listener();
  return true;
}

export function ownIconsNow(): readonly InboxAgentIcon[] | null {
  return icons;
}

/**
 * Whether an uploaded face can be drawn here: its picture is kept by this Inbox, or the window has not heard the list
 * yet (the picture's own load decides then). A face from a picture another machine kept, or one removed, is not.
 */
export function ownFaceShows(face: string): boolean {
  if (!isInboxOwnFace(face)) return false;
  return icons === null || ids.has(inboxOwnFaceHash(face));
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
const none = () => null;

/** The pictures, redrawn when one is added or removed. */
export function useOwnIcons(): readonly InboxAgentIcon[] | null {
  return useSyncExternalStore(subscribe, ownIconsNow, none);
}

/** A picture's address: `still` everywhere but the sidebar, and there too under reduced motion. */
export function ownIconSrc(face: InboxOwnFace | string, still: boolean): string {
  const id = face.startsWith('own:') ? face.slice(4) : face;
  return inboxUrl(`/agent-icons/${encodeURIComponent(id)}`, still ? 'still=1' : undefined);
}

/** Tests: forget the pictures. */
export function resetOwnIcons(): void {
  icons = null;
  ids = new Set();
  for (const listener of [...listeners]) listener();
}
