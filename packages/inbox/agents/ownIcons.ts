import { useSyncExternalStore } from 'react';
import { inboxOwnFaceHash, isInboxOwnFace, readInboxAgentIcons, type InboxAgentIcon, type InboxOwnFace } from '@plannotator/core/inbox-types';
import { inboxUrl } from '../inboxUrl';

let icons: readonly InboxAgentIcon[] | null = null;
let ids: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

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

export function ownFaceShows(face: string): boolean {
  if (!isInboxOwnFace(face)) return false;
  return icons === null || ids.has(inboxOwnFaceHash(face));
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
const none = () => null;

export function useOwnIcons(): readonly InboxAgentIcon[] | null {
  return useSyncExternalStore(subscribe, ownIconsNow, none);
}

export function ownIconSrc(face: InboxOwnFace | string, still: boolean): string {
  const id = face.startsWith('own:') ? face.slice(4) : face;
  return inboxUrl(`/agent-icons/${encodeURIComponent(id)}`, still ? 'still=1' : undefined);
}

export function resetOwnIcons(): void {
  icons = null;
  ids = new Set();
  for (const listener of [...listeners]) listener();
}
