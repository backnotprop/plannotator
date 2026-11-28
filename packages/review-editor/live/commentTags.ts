import { useSyncExternalStore } from 'react';
import type { MentionSource } from '@plannotator/ui/utils/mentions';
import type { LiveSendTag } from './api';

const HOLD_MS = 5_000;
let source: MentionSource | undefined;
let held: { tags: LiveSendTag[]; at: number } | null = null;
const listeners = new Set<() => void>();

export function setLiveCommentSource(next: MentionSource | undefined): void {
  if (next === source) return;
  source = next;
  for (const listener of listeners) listener();
}

export function useLiveCommentSource(): MentionSource | undefined {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => source,
    () => undefined,
  );
}

export function holdCommentTags(tags: LiveSendTag[]): void {
  held = tags.length > 0 ? { tags, at: Date.now() } : null;
}

export function takeCommentTags(now = Date.now()): LiveSendTag[] | null {
  const taken = held && now - held.at <= HOLD_MS ? held.tags : null;
  held = null;
  return taken;
}

export function tagsFromIds(ids: readonly string[], from: MentionSource | undefined): LiveSendTag[] {
  return ids.flatMap((id) => {
    const at = id.indexOf(':');
    if (at <= 0) return [];
    const person = from?.people.find((p) => p.id === id);
    return [{ host: id.slice(0, at), session: id.slice(at + 1), ...(person ? { label: person.label } : {}) }];
  });
}
