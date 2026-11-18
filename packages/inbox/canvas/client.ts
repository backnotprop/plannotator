/**
 * The thread canvas's routes as the window reads them (packages/server/canvas-capability.ts, mounted only while
 * config.json `inboxCanvas` is on; docs/agent-guides/inbox-canvas.md). This computer's own window only: a phone's
 * door or a linked machine gets the unknown-route 404. Every write carries the page's `serverSession`.
 */
import type { CanvasElement } from '@plannotator/core/canvas-scene';
import { pageServerSession } from '../api';
import { readJson } from '../apiError';

declare module '../api' {
  interface SettingsModel {
    /** The thread canvas (config.json `inboxCanvas`): present only while on. */
    canvas?: { on: boolean };
  }
}

export interface CanvasFileRef {
  name: string;
  mimeType: string;
}

export interface CanvasPin {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CanvasVersionSummary {
  n: number;
  by: 'agent' | 'person';
  at: string;
  changed?: number;
  picture: boolean;
}

export interface CanvasWire {
  id: string;
  rev: number;
  version: number;
  agent_version: number;
  board: string | null;
  pins: Record<string, CanvasPin>;
  deleted: string[];
  scene: { elements: CanvasElement[]; files: Record<string, CanvasFileRef> } | null;
  /** `failed`: no window could lay it out (`warnings[0]` says why); none tries again until the agent writes. */
  layout: { version: number; state: 'pending' | 'done' | 'failed'; warnings: string[]; at: string } | null;
  versions: CanvasVersionSummary[];
  /** What the person did since the agent's latest version, as the agent reads it (`canvas read`). */
  marks: string[];
  picture: boolean;
}

export interface CanvasVersionWire {
  n: number;
  by: 'agent' | 'person';
  at: string;
  changed?: number;
  scene?: { elements: CanvasElement[]; files: Record<string, CanvasFileRef> };
}

const BASE = '/api/canvas';
const one = (id: string, rest = '') => `${BASE}/${encodeURIComponent(id)}${rest}`;

async function get<T>(path: string): Promise<T> {
  return readJson<T>(await fetch(path, { headers: { Accept: 'application/json' }, cache: 'no-store' }));
}

async function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const session = pageServerSession();
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(session ? { ...body, serverSession: session } : body),
  });
  return readJson<T>(response);
}

export const canvasApi = {
  read: (id: string) => get<CanvasWire>(one(id)),
  version: (id: string, n: number) => get<CanvasVersionWire>(one(id, `/versions/${n}`)),
  /** Agent versions waiting for a window: to lay out, or (`picture`) laid out with no picture kept yet. */
  pending: () => get<{ pending: { id: string; version: number; picture?: true }[] }>(`${BASE}/pending`),
  fileUrl: (id: string, name: string) => one(id, `/files/${encodeURIComponent(name)}`),
  pictureUrl: (id: string, n?: number) => (n ? one(id, `/versions/${n}/picture`) : one(id, '/picture')),
  save: (id: string, body: { base: number; elements: readonly unknown[]; files: Record<string, CanvasFileRef>; uploads: Record<string, { dataURL: string }> }) =>
    post<{ rev: number; version: number; deleted: string[]; marks: string[] }>(one(id, '/scene'), body),
  /** `rev`: the canvas's rev the layout was computed from; a newer one refuses it (409 `stale_layout`). */
  layout: (id: string, body: { rev: number; version: number; elements: readonly unknown[]; files: Record<string, CanvasFileRef>; warnings: string[]; parts: unknown; changed: number }) =>
    post<{ rev: number }>(one(id, '/layout'), body),
  /** The board could not be laid out here (a bad board, over the lift's budget): the agent's CLI hears it. */
  layoutFailed: (id: string, body: { version: number; error: string }) => post<{ state: 'pending' | 'failed'; attempts: number }>(one(id, '/layout-failed'), { ...body, error: body.error.slice(0, 300) }),
  picture: (id: string, body: { rev: number; version?: number; dataURL: string }) => post<{ saved: boolean }>(one(id, '/picture'), body),
};
