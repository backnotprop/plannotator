/**
 * Our faces' pictures (faceArt.ts), fetched once, in their own script: on the first click, the first look at the
 * picker, or at once when a face is kept for any agent (agentFaces.ts), so a row's face is in before the list's first read.
 */
import { useSyncExternalStore } from 'react';
import type { FaceSources } from './FaceFan';
import { setAgentFaceArt } from './motion';

let artLoad: Promise<void> | null = null;
let sources: FaceSources | null = null;
const listeners = new Set<() => void>();

export function loadAgentFaceArt(): Promise<void> {
  artLoad ??= import('./faceArt').then(
    (mod) => {
      sources = mod.AGENT_FACE_SRC;
      setAgentFaceArt(mod.AGENT_FACE_ART);
      for (const listener of [...listeners]) listener();
    },
    (cause: unknown) => {
      artLoad = null;
      throw cause;
    },
  );
  return artLoad;
}

/** The pictures' sources, or null until they are in. */
export function agentFaceSources(): FaceSources | null {
  return sources;
}

/** Tests: the pictures as given (no script to fetch). */
export function setAgentFaceSourcesForTests(next: FaceSources | null): void {
  sources = next;
  for (const listener of [...listeners]) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
const none = () => null;

/** The pictures' sources, redrawn when they come in; `want`: start fetching them. */
export function useAgentFaceSources(want: boolean): FaceSources | null {
  const now = useSyncExternalStore(subscribe, agentFaceSources, none);
  if (want && !now) void loadAgentFaceArt().catch(() => {});
  return now;
}
