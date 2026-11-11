/** Runtime-neutral Shape HTTP routes: one handler both servers mount. Agents write through the CLI, never here. The code routes read inside the shape's project folder only, through the runtime's code-nav (`ShapeRouteDeps.code`). */
import { extname } from "node:path";
import { isShapeId, type ShapeNote, type ShapeRecord, type ShapeSession, type ShapeVersion } from "./format";
import { shapeCodeRoot, type ShapeStore, type ShapeSummary } from "./store";

export type ShapeRouteResult =
  | { status: number; body: unknown }
  | { status: 200; file: { path: string; contentType: string } };

export interface ShapeRouteRequest {
  method: string;
  pathname: string;
  params: URLSearchParams;
  json: () => Promise<unknown>;
}

export interface ShapeSessionState {
  state: "live" | "busy" | "gone";
  agent: string;
}

export interface ShapeRouteDeps {
  store: ShapeStore;
  sessionOf?: (shape: ShapeRecord) => ShapeSessionState;
  changed?: (id: string) => void;
  /** The runtime's code-nav, rooted at the shape's project folder. Absent: the code routes answer 404. */
  code?: {
    file(root: string, path: string | null): Promise<{ status: number; body: unknown }>;
    hover(root: string, body: unknown): Promise<{ status: number; body: unknown }>;
  };
}

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

export async function unlocked(store: ShapeStore, id: string, waitMs = 5_000): Promise<boolean> {
  const until = Date.now() + waitMs;
  while (store.locked(id)) {
    if (Date.now() > until) return false;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  return true;
}

const bad = (message: string, status = 400): ShapeRouteResult => ({ status, body: { error: message } });

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
  if (id === "events") return null;
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

/** Agents write from their own processes (the CLI), so each tick compares every shape's fingerprint and names the ones that moved. */
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
    poke: tick,
    watching: () => listeners.size,
  };
}
