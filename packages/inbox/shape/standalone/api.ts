/**
 * The standalone Shape page's requests (packages/server/shape.ts): the same
 * Shape routes the Inbox mounts, on the Shapes server, plus its own
 * `/api/shape-server` (who it is, and the `serverSession` every write carries,
 * so a page left open across a restart gets a 409 instead of writing blind).
 */
import { SERVER_SESSION_MISMATCH_CODE } from '@plannotator/core/server-session';
import type { ShapeBoardStyle, ShapeNote } from '@plannotator/core/shape';
import type { InboxShapeSummary, ShapeLoadedWire } from '../../api';

export type ShapeSummaryWire = InboxShapeSummary;
export type { ShapeLoadedWire };

export interface ShapeServerInfoWire {
  shape_server: 1;
  version: string;
  serverSession: string;
  on: boolean;
  /** Pages open on the server (an older server leaves it out). */
  pages?: number;
  /** How every board is drawn (config.json `shapeBoardStyle`; an older server leaves it out). */
  board_style?: ShapeBoardStyle;
}

/** A refused request: the status and the server's words. */
export class ShapeApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'ShapeApiError';
  }
}

async function read<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => null)) as { error?: unknown; code?: unknown } | null;
  if (!response.ok) {
    const message = typeof body?.error === 'string' ? body.error : `HTTP ${response.status}`;
    throw new ShapeApiError(response.status, typeof body?.code === 'string' ? body.code : null, message);
  }
  return body as T;
}

export function createShapePageApi(options: { fetch?: (path: string, init?: RequestInit) => Promise<Response> } = {}) {
  const doFetch = options.fetch ?? ((path: string, init?: RequestInit) => fetch(path, init));
  let serverSession: string | null = null;

  const get = async <T>(path: string, signal?: AbortSignal) =>
    read<T>(await doFetch(path, { headers: { Accept: 'application/json' }, cache: 'no-store', signal }));
  const send = async (path: string, body: Record<string, unknown>) =>
    doFetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(serverSession ? { ...body, serverSession } : body),
    });
  /**
   * A write. A 409 `session_mismatch` means another Shapes server answers on this address now (most often this
   * data dir's, restarted after its idle exit; the event stream already reconnected to it) and it saved nothing. The
   * page takes that server's `serverSession` and sends once more. Safe: every write names a board by its id
   * (`shp_` + a ULID), so a server of another data dir has no such board and refuses it (404); the same store
   * takes it. A second refusal is the caller's to show.
   */
  const post = async <T>(path: string, body: Record<string, unknown>) => {
    const first = await send(path, body);
    if (first.status === 409) {
      const refused = (await first.clone().json().catch(() => null)) as { code?: unknown } | null;
      if (refused?.code === SERVER_SESSION_MISMATCH_CODE) {
        const live = await read<ShapeServerInfoWire>(await doFetch('/api/shape-server', { headers: { Accept: 'application/json' }, cache: 'no-store' }));
        if (live.serverSession && live.serverSession !== serverSession) {
          serverSession = live.serverSession;
          return read<T>(await send(path, body));
        }
      }
    }
    return read<T>(first);
  };
  const at = (id: string) => `/api/shapes/${encodeURIComponent(id)}`;

  return {
    /** Who serves this page. The first answer's `serverSession` is the page's, until a write finds a restarted server. */
    async info(signal?: AbortSignal): Promise<ShapeServerInfoWire> {
      const info = await get<ShapeServerInfoWire>('/api/shape-server', signal);
      serverSession ??= info.serverSession;
      return info;
    },
    shapes: (signal?: AbortSignal) => get<{ shapes: ShapeSummaryWire[] }>('/api/shapes?preview=1', signal),
    shape: (id: string, n?: number) => get<ShapeLoadedWire>(`${at(id)}${n ? `?n=${n}` : ''}`),
    note: (id: string, input: Record<string, unknown>) => post<{ note: ShapeNote }>(`${at(id)}/notes`, input),
    seen: (id: string, n: number) => post<{ seen: number | null }>(`${at(id)}/seen`, { n }),
    codeFile: (id: string, path: string) => get<{ content: string }>(`${at(id)}/code/file?path=${encodeURIComponent(path)}`),
    codeHover: (id: string, request: Record<string, unknown>) => post<unknown>(`${at(id)}/code/hover`, request),
  };
}

export type ShapePageApi = ReturnType<typeof createShapePageApi>;
