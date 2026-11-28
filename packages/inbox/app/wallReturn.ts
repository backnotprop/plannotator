import type { InboxArtifactType } from '@plannotator/core/inbox-artifact-pins';
import { backTo } from '../history';
import { readRoute, type Route } from './route';

const PLACE = 'ibWall';

export interface WallPlace {
  type: InboxArtifactType | null;
  archived: boolean;
  shown: number;
  top: number;
  key: string;
}

export function closeToWall(route: Route): boolean {
  const now = readRoute();
  const leaves = !!now.thread && route.thread === now.thread && ((!!now.file && !route.file) || (!!now.guide && !route.guide));
  const from = (window.history.state as { ibFrom?: unknown } | null)?.ibFrom;
  return leaves && typeof from === 'string' && /^#artifacts(=pinned)?$/.test(from) && backTo(from);
}

export function keepWallPlace(place: WallPlace): void {
  window.history.replaceState({ ...window.history.state, [PLACE]: place }, '', window.location.href);
}

export function wallPlace(): WallPlace | null {
  const place = (window.history.state as Record<string, unknown> | null)?.[PLACE] as WallPlace | undefined;
  return place && typeof place.key === 'string' && typeof place.top === 'number' && typeof place.shown === 'number' ? place : null;
}

export function dropWallPlace(): void {
  const state = { ...(window.history.state as Record<string, unknown> | null) };
  delete state[PLACE];
  window.history.replaceState(state, '', window.location.href);
}
