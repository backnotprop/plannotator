/**
 * The thread canvas on the Inbox's capability seam (docs/agent-guides/inbox-canvas.md): its routes under
 * `/api/canvas`, its settings wire and its event frames, all only while config.json `inboxCanvas` is true. Off, every
 * path is the unknown-route 404 (`routeInboxCapabilities`), the settings say nothing of it and no frame is sent.
 *
 * The board is laid out by a window (a browser engine), never here: an agent's write leaves its version `pending`;
 * every window open on this computer hears `event: canvas` and lays pending versions out in the background, the
 * first to answer wins. The server writes `canvases/.windows.json` (how many windows can lay out, and its pid), so
 * the agent's CLI knows whether to wait for the layout's warnings.
 */
import { CANVAS_ID_RE, createCanvasStore, writeCanvasWindows, type CanvasFileRef, type CanvasStore } from "@plannotator/shared/canvas/store";
import { canvasOn, setCanvasSwitch } from "@plannotator/shared/canvas/switch";
import type { CanvasElement, CanvasParts } from "@plannotator/core/canvas-scene";
import { CANVAS_INSTRUCTIONS_LINE, canvasChangedLine } from "@plannotator/core/canvas-skill";
import type { InboxCapability, InboxCore } from "./inbox-capability";

export const CANVAS_ROUTE_PREFIX = "/api/canvas";
const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const MAX_ELEMENTS = 20_000;

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: NO_STORE });
const refuse = (message: string, code = "validation_error", status = 400) => json({ error: message, code }, status);

/** A canvas's frame on the window's event stream: these canvases changed. */
export const canvasEventFrame = (ids: readonly string[]) => `event: canvas\ndata: ${JSON.stringify({ ids })}\n\n`;

function elementsOf(input: unknown): CanvasElement[] | null {
  if (!Array.isArray(input) || input.length > MAX_ELEMENTS) return null;
  const out: CanvasElement[] = [];
  for (const e of input) {
    if (!e || typeof e !== "object" || Array.isArray(e)) return null;
    const el = e as Record<string, unknown>;
    if (typeof el.id !== "string" || !el.id || el.id.length > 200 || typeof el.type !== "string") return null;
    for (const k of ["x", "y", "width", "height"]) if (typeof el[k] !== "number" || !Number.isFinite(el[k] as number)) return null;
    // Links are off on the canvas: none is kept.
    out.push({ ...(el as unknown as CanvasElement), link: null });
  }
  return out;
}

function filesOf(input: unknown): Record<string, CanvasFileRef> | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const out: Record<string, CanvasFileRef> = {};
  for (const [id, v] of Object.entries(input as Record<string, unknown>)) {
    const f = v as { name?: unknown; mimeType?: unknown } | null;
    if (!f || typeof f.name !== "string" || !/^[\w][\w.-]{0,120}$/.test(f.name) || typeof f.mimeType !== "string") return null;
    out[id] = { name: f.name, mimeType: f.mimeType };
  }
  return out;
}

function bytesOfDataUrl(input: unknown): { mimeType: string; bytes: Uint8Array } | null {
  if (typeof input !== "string") return null;
  const m = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(input);
  if (!m) return null;
  return { mimeType: m[1], bytes: Uint8Array.from(Buffer.from(m[2], "base64")) };
}

async function unlocked(store: CanvasStore, id: string, waitMs = 5000): Promise<boolean> {
  const until = Date.now() + waitMs;
  while (store.locked(id)) {
    if (Date.now() > until) return false;
    await new Promise((r) => setTimeout(r, 15));
  }
  return true;
}

/** The canvas as a window reads it. */
export function canvasView(store: CanvasStore, id: string) {
  const s = store.get(id);
  return {
    id,
    rev: s.rev,
    version: s.version,
    agent_version: s.agentVersion,
    board: s.board,
    pins: s.standing.pins,
    deleted: s.standing.deleted,
    scene: s.scene,
    layout: s.layout,
    versions: store.versions(id),
    marks: store.readBack(id),
    picture: !!s.png,
  };
}

export function createCanvasCapability(core: InboxCore): InboxCapability & { store: CanvasStore } {
  const store = createCanvasStore({ dataDir: core.dataDir });
  const on = () => canvasOn();
  // Every window's stream, and the last fingerprint per canvas they were told about.
  const streams = new Set<(frame: string) => void>();
  let seen = new Map<string, string>();
  let timer: ReturnType<typeof setInterval> | null = null;
  const tellWindows = () => {
    try {
      writeCanvasWindows(core.dataDir, streams.size);
    } catch {
      // The CLI then lays out nothing it waits for; it says so.
    }
  };
  const poll = () => {
    const now = store.fingerprints();
    const changed = [...now.entries()].filter(([id, fp]) => seen.get(id) !== fp).map(([id]) => id);
    seen = now;
    if (changed.length) for (const send of streams) send(canvasEventFrame(changed));
  };
  const answerFile = (path: string | null, contentType: string) =>
    path
      ? new Response(Bun.file(path), { headers: { "Content-Type": contentType, "Cross-Origin-Resource-Policy": "same-origin", "Content-Security-Policy": "sandbox", ...NO_STORE } })
      : refuse("Not found", "not_found", 404);

  return {
    key: "canvas",
    prefix: CANVAS_ROUTE_PREFIX,
    store,
    on,
    save(next) {
      const was = on();
      if (!setCanvasSwitch(next)) return false;
      if (was !== on()) core.changed();
      return true;
    },
    settingsWire: () => (on() ? { canvas: { on: true } } : {}),
    agentInstructions: () => [CANVAS_INSTRUCTIONS_LINE],
    agentThreadLines: (threadId) => (CANVAS_ID_RE.test(threadId) && store.exists(threadId) && store.readBack(threadId).length > 0 ? [canvasChangedLine(threadId)] : []),
    stream(send) {
      streams.add(send);
      tellWindows();
      if (!timer) {
        seen = store.fingerprints();
        timer = setInterval(poll, 400);
        (timer as { unref?: () => void }).unref?.();
      }
      return () => {
        streams.delete(send);
        tellWindows();
        if (!streams.size && timer) {
          clearInterval(timer);
          timer = null;
        }
      };
    },
    async route(req, url) {
      const rest = url.pathname.slice(CANVAS_ROUTE_PREFIX.length).split("/").filter(Boolean).map(decodeURIComponent);
      if (rest.length === 1 && rest[0] === "pending" && req.method === "GET") return json({ pending: store.pending() });
      const id = rest[0];
      if (!id || !CANVAS_ID_RE.test(id)) return null;
      if (req.method === "GET") {
        if (rest.length === 1) return json(canvasView(store, id));
        if (rest[1] === "files" && rest.length === 3) {
          const p = store.filePath(id, rest[2]);
          const ext = rest[2].toLowerCase().split(".").pop();
          return answerFile(p, ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "gif" ? "image/gif" : ext === "webp" ? "image/webp" : "image/png");
        }
        if (rest[1] === "picture" && rest.length === 2) return answerFile(store.picturePath(id), "image/png");
        if (rest[1] === "versions" && rest.length >= 3) {
          const n = Number(rest[2]);
          if (!Number.isInteger(n) || n < 1) return null;
          if (rest.length === 4 && rest[3] === "picture") return answerFile(store.picturePath(id, n), "image/png");
          if (rest.length === 3) {
            const v = store.version(id, n);
            return v ? json(v) : refuse("No such version", "not_found", 404);
          }
        }
        return null;
      }
      if (req.method !== "POST" || rest.length !== 2) return null;
      const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
      if (!body || typeof body !== "object") return refuse("A JSON body is required.");
      if (!(await unlocked(store, id))) return refuse("The canvas stayed busy; try again.", "busy", 503);
      if (rest[1] === "scene") {
        const elements = elementsOf(body.elements);
        const files = filesOf(body.files ?? {});
        if (!elements || !files || typeof body.base !== "number") return refuse("scene: { base, elements, files } is required.");
        const uploads: Record<string, { mimeType: string; bytes: Uint8Array }> = {};
        if (body.uploads && typeof body.uploads === "object") {
          for (const [fileId, v] of Object.entries(body.uploads as Record<string, unknown>)) {
            const up = bytesOfDataUrl((v as { dataURL?: unknown } | null)?.dataURL);
            if (up && files[fileId]) uploads[fileId] = up;
          }
        }
        const saved = store.personSave(id, { base: body.base, elements, files, uploads });
        if (!saved.ok) return json({ error: saved.message, code: saved.code, rev: saved.rev }, 409);
        poll();
        return json({ rev: saved.rev, version: saved.version, deleted: saved.deleted, marks: store.readBack(id) });
      }
      if (rest[1] === "layout") {
        const elements = elementsOf(body.elements);
        const files = filesOf(body.files ?? {});
        const warnings = Array.isArray(body.warnings) ? body.warnings.filter((w): w is string => typeof w === "string").slice(0, 200) : null;
        if (!elements || !files || !warnings || typeof body.version !== "number" || !body.parts || typeof body.parts !== "object") {
          return refuse("layout: { version, elements, files, warnings, parts } is required.");
        }
        const done = store.layoutDone(id, { version: body.version, elements, files, warnings, parts: body.parts as CanvasParts, changed: typeof body.changed === "number" ? body.changed : 0 });
        if (!done.ok) return json({ error: done.message, code: done.code }, 409);
        poll();
        return json({ rev: done.rev });
      }
      if (rest[1] === "picture") {
        const up = bytesOfDataUrl(body.dataURL);
        if (!up || typeof body.rev !== "number") return refuse("picture: { rev, dataURL } is required.");
        const version = typeof body.version === "number" && Number.isInteger(body.version) && body.version > 0 ? body.version : undefined;
        return json({ saved: store.savePicture(id, { rev: body.rev, version, bytes: up.bytes }) });
      }
      return null;
    },
  };
}
