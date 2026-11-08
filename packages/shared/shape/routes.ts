/**
 * Shape's HTTP routes, runtime-neutral: one handler both servers mount (the
 * Inbox's Bun server and Pi's), so a board reads and writes the same way
 * wherever it is open (SPEC.md §3, "Routes"). Each server turns the result
 * into its own response: JSON, or a file it streams.
 *
 *   GET  /api/shapes[?preview=1]         every shape, newest change first (preview: each one's latest Picture and refs, for a grid)
 *   GET  /api/shapes/:id[?n=]            one shape: its latest (or nth) version, notes, seen
 *   GET  /api/shapes/:id/versions        its history
 *   POST /api/shapes/:id/notes           the person's Change it or Ask
 *   POST /api/shapes/:id/answer          an answer to an Ask (the session's or Ask AI's)
 *   POST /api/shapes/:id/seen            { n }: the person has looked at version n
 *   POST /api/shapes/:id/state           { state: "active" | "finished" }
 *   GET  /api/shapes/:id/files/:name     an image the shape keeps (files/…)
 *   GET  /api/shapes/:id/code/file?path= a project file's text, for a file reference and the Code view
 *   POST /api/shapes/:id/code/hover      hover insights for a code token (code review's code-nav)
 *   GET  /api/shapes/events              the event feed (SSE): `event: shapes` `{ ids }` when shapes change
 *
 * The event feed is each server's own stream (`shapeEventFrame`); the watch
 * below tells it what changed. Agents write through the CLI, never here. The
 * code routes read inside the shape's project folder only, through the
 * runtime's code-nav (`ShapeRouteDeps.code`).
 */
import { extname } from "node:path";
import { isShapeId, type ShapeNote, type ShapeRecord, type ShapeSession, type ShapeVersion } from "./format";
import { shapeCodeRoot, type ShapeStore, type ShapeSummary } from "./store";

export type ShapeRouteResult =
  | { status: number; body: unknown }
  | { status: 200; file: { path: string; contentType: string } };

export interface ShapeRouteRequest {
  method: string;
  /** The URL's path, `/api/shapes/…`. */
  pathname: string;
  params: URLSearchParams;
  /** The JSON body of a POST; it throws on bad JSON. */
  json: () => Promise<unknown>;
}

/** The session that drew a shape, as the server knows it now. */
export interface ShapeSessionState {
  state: "live" | "busy" | "gone";
  agent: string;
}

export interface ShapeRouteDeps {
  store: ShapeStore;
  /** Live or gone, for the board's Ask footer. Absent: gone. */
  sessionOf?: (shape: ShapeRecord) => ShapeSessionState;
  /** A shape changed through these routes (a note, seen, a state); the event feed tells the pages. */
  changed?: (id: string) => void;
  /** The runtime's code-nav, rooted at the shape's project folder. Absent: the code routes answer 404. */
  code?: {
    /** `{ content }`, or an error status and body (code review's `/api/code-nav/file`). */
    file(root: string, path: string | null): Promise<{ status: number; body: unknown }>;
    /** Code review's `/api/code-nav/hover` answer for this body. */
    hover(root: string, body: unknown): Promise<{ status: number; body: unknown }>;
  };
}

/** The event feed's frame: these shapes changed (read them again). */
export function shapeEventFrame(ids: readonly string[]): string {
  return `event: shapes\ndata: ${JSON.stringify({ ids })}\n\n`;
}

export const SHAPE_EVENTS_PATH = "/api/shapes/events";

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  // Served with `sandbox` and nosniff (both runtimes), so an SVG opened directly runs no script.
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
};

const AGENT_NAMES: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  pi: "Pi",
  opencode: "OpenCode",
  droid: "Droid",
  amp: "Amp",
};

export function shapeAgentName(session: ShapeSession | null): string {
  if (!session) return "the agent";
  return AGENT_NAMES[session.host] ?? session.host;
}

/** The store's lock (and this shape's) is free, waited for without blocking; false after `waitMs`. */
export async function unlocked(store: ShapeStore, id: string, waitMs = 5_000): Promise<boolean> {
  const until = Date.now() + waitMs;
  while (store.locked(id)) {
    if (Date.now() > until) return false;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  return true;
}

const bad = (message: string, status = 400): ShapeRouteResult => ({ status, body: { error: message } });

/** Shape's routes; null when the path is not one of them. */
export async function handleShapeRoute(req: ShapeRouteRequest, deps: ShapeRouteDeps): Promise<ShapeRouteResult | null> {
  if (req.pathname !== "/api/shapes" && !req.pathname.startsWith("/api/shapes/")) return null;
  const { store } = deps;
  const parts = req.pathname.split("/").slice(3).map((p) => decodeURIComponent(p));
  const method = req.method.toUpperCase();

  if (parts.length === 0) {
    if (method !== "GET") return bad("method not allowed", 405);
    const all = req.params.get("state") === "all";
    const shapes: (ShapeSummary & { preview?: { picture: unknown; refs: unknown } | null })[] = store.list({ state: all ? "all" : "active" });
    if (req.params.get("preview") === "1") {
      for (const s of shapes) {
        const latest = store.read(s.id);
        s.preview = latest ? { picture: latest.views.picture ?? null, refs: latest.refs ?? [] } : null;
      }
    }
    return { status: 200, body: { shapes } };
  }

  const id = parts[0]!;
  if (id === "events") return null; // the server's own stream
  if (!isShapeId(id)) return bad("not a shape id", 404);
  const shape = store.get(id);
  if (!shape) return bad(`No shape ${id}.`, 404);
  const sub = parts[1];

  if (!sub) {
    if (method !== "GET") return bad("method not allowed", 405);
    const nRaw = req.params.get("n");
    const n = nRaw === null ? undefined : Number(nRaw);
    if (n !== undefined && (!Number.isInteger(n) || n < 1)) return bad("n is a version number");
    const version: ShapeVersion | null = store.read(id, n);
    if (!version) return bad(`${id} has no version ${nRaw}.`, 404);
    const session = deps.sessionOf?.(shape) ?? { state: "gone", agent: shapeAgentName(shape.session) };
    return {
      status: 200,
      body: { shape, version, seen: store.seen()[id] ?? null, notes: store.notes(id), session },
    };
  }

  if (sub === "versions" && parts.length === 2) {
    if (method !== "GET") return bad("method not allowed", 405);
    return { status: 200, body: { versions: store.versions(id) } };
  }

  if (sub === "files" && parts.length === 3) {
    if (method !== "GET") return bad("method not allowed", 405);
    const name = parts[2]!;
    const type = IMAGE_TYPES[extname(name).toLowerCase()];
    const path = type ? store.filePath(id, name) : null;
    if (!path || !type) return bad("not found", 404);
    return { status: 200, file: { path, contentType: type } };
  }

  if (sub === "code" && parts.length === 3 && deps.code) {
    const root = shapeCodeRoot(shape.project);
    if (parts[2] === "file" && method === "GET") return deps.code.file(root, req.params.get("path"));
    if (parts[2] === "hover" && method === "POST") {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return bad("the body must be JSON");
      }
      return deps.code.hover(root, body);
    }
    return bad("not found", 404);
  }

  if (parts.length !== 2 || method !== "POST") return bad("not found", 404);
  // An agent's CLI may hold the lock a moment: wait here, not in the store's blocking wait.
  if (!(await unlocked(store, id))) return bad("The shape is busy; try again.", 503);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return bad("the body must be JSON");
  }
  const input = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;

  if (sub === "notes") {
    const result = store.addNote(id, input);
    if (!result.ok) return result.code === "invalid" ? { status: 400, body: { error: result.errors.join("; "), errors: result.errors } } : bad(result.message, result.code === "not_found" ? 404 : 409);
    deps.changed?.(id);
    return { status: 200, body: { note: result.note satisfies ShapeNote } };
  }

  if (sub === "answer") {
    const re = typeof input.re === "string" ? input.re : null;
    const text = typeof input.text === "string" ? input.text.trim() : "";
    const from = input.from as ShapeSession | undefined;
    if (!text) return bad("text is required");
    if (!from || typeof from.host !== "string" || typeof from.id !== "string") return bad("from must be { host, id }");
    const result = store.answer(id, { re, text, from: { host: from.host, id: from.id } });
    if (!result.ok) return result.code === "invalid" ? bad(result.errors.join("; ")) : bad(result.message, result.code === "not_found" ? 404 : 409);
    deps.changed?.(id);
    return { status: 200, body: { note: result.note } };
  }

  if (sub === "seen") {
    const n = input.n;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1) return bad("n is a version number");
    store.markSeen(id, n);
    deps.changed?.(id);
    return { status: 200, body: { seen: store.seen()[id] ?? null } };
  }

  if (sub === "state") {
    if (input.state !== "active" && input.state !== "finished") return bad('state is "active" or "finished"');
    const next = store.setState(id, input.state);
    deps.changed?.(id);
    return { status: 200, body: { shape: next } };
  }

  return bad("not found", 404);
}

/**
 * What changed in the store, for the event feed. Agents write from their own
 * processes (the CLI), so the server looks: each tick it compares every
 * shape's fingerprint (latest version, drawing, notes, seen, state) and
 * names the ones that moved. Cheap: one directory walk, small files.
 */
export function createShapeWatch(store: ShapeStore, options: { intervalMs?: number } = {}) {
  const listeners = new Set<(ids: string[]) => void>();
  let last = new Map<string, string>();
  let timer: ReturnType<typeof setInterval> | null = null;

  const fingerprints = () => {
    const seen = store.seen();
    const next = new Map<string, string>();
    for (const s of store.list({ state: "all" })) {
      const notes = store.notes(s.id);
      const lastNote = notes[notes.length - 1];
      next.set(s.id, [s.latest, s.updated, s.state, s.drawing ? 1 : 0, s.waiting, notes.length, lastNote?.delivered ?? "", seen[s.id] ?? 0].join("|"));
    }
    return next;
  };

  const tick = () => {
    let next: Map<string, string>;
    try {
      next = fingerprints();
    } catch {
      return;
    }
    const moved: string[] = [];
    for (const [id, fp] of next) if (last.get(id) !== fp) moved.push(id);
    for (const id of last.keys()) if (!next.has(id)) moved.push(id);
    last = next;
    if (moved.length) for (const l of listeners) l(moved);
  };

  return {
    /** Listen; returns the unsubscribe. The watch runs only while someone listens. */
    subscribe(listener: (ids: string[]) => void): () => void {
      if (!listeners.size) {
        try {
          last = fingerprints();
        } catch {
          last = new Map();
        }
        timer = setInterval(tick, options.intervalMs ?? 1000);
        (timer as { unref?: () => void }).unref?.();
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (!listeners.size && timer) {
          clearInterval(timer);
          timer = null;
        }
      };
    },
    /** Look now (after a write through the routes). */
    poke: tick,
    /** How many listen (0: the watch reads nothing). Tests read it. */
    watching: () => listeners.size,
  };
}
