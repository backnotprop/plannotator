/**
 * Plannotator Inbox: a thread's canvas (prototype).
 *
 * Every thread can hold one canvas: an Excalidraw scene the person draws on
 * in the window (packages/inbox/canvas) and an agent reads and changes with
 * the `canvas` tool. The scene is Excalidraw's own JSON, stored beside the
 * thread (packages/shared/inbox/canvas/store.ts).
 *
 * The server never loads Excalidraw. It reads the scene as text and applies an
 * agent's changes itself (shared/inbox/canvas/reading.ts, apply.ts). Two
 * things only a browser can do, drawing a picture and turning mermaid text
 * into shapes, it asks an open window to do (`event: canvas-job` on the
 * windows' streams; the window answers on `/api/inbox/canvas/jobs/<id>`), and
 * falls back to the last picture a window stored when none is open.
 *
 * The rule the tool is built around: an agent never replaces what the person
 * just did without knowing. Every change names the revision the agent last
 * read (`base`). A change to a thing someone else changed after that is
 * refused whole, with their change shown. A change to anything else lands,
 * and every answer opens with what others changed since the agent's last look.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { inboxStoredAgentName } from "@plannotator/core/inbox-format";
import { inboxAgentName, type InboxReplySketch } from "@plannotator/core/inbox-types";
import { applyOps, mermaidTexts, RefError, resolveThing } from "@plannotator/shared/inbox/canvas/apply";
import { mergeSave, sinceLines, type CanvasAuthor } from "@plannotator/shared/inbox/canvas/changes";
import { countWords, readThings, thingsOf } from "@plannotator/shared/inbox/canvas/reading";
import { asScene, unionBox, type Box, type CanvasElement } from "@plannotator/shared/inbox/canvas/scene";
import {
  canvasThreads,
  commitCanvas,
  noteCanvasSeen,
  readCanvasUndo,
  retireCanvas,
  writeCanvasMeta,
  writeCanvasUndo,
  readCanvasLog,
  readCanvasMeta,
  readCanvasPicture,
  readCanvasScene,
  writeAgentPicture,
  writeCanvasPicture,
} from "@plannotator/shared/inbox/canvas/store";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { decodePng, encodePng } from "./inbox-icon-trim";
import { fail, guarded, okComplete } from "./inbox-mcp-result";

export const INBOX_CANVAS_DESCRIPTION = [
  "A thread's canvas: a shared Excalidraw drawing the person sketches on, which you read and change. With only thread_id it answers the canvas as text, one line per thing, and its rev.",
  '"picture": true also writes a PNG of it and gives the path; "picture": "<thing>" (or a list) is that part only. "in": "<frame>" reads one frame.',
  '"do": [...] changes it, all or nothing; send "base": the rev of your last answer. Name a thing by the id at the start of its line, or by its words. Each change has one verb:',
  '{"add": "box", "text": "...", "rightOf": "<thing>"}  kinds: box, ellipse, diamond, note, text, frame, mermaid (text is a flowchart or sequence diagram). Place: near, rightOf, leftOf, above, below, in (a frame), or "at": [x, y]. Optional "color".',
  '{"connect": "<thing>", "to": "<thing>", "label": "..."}   {"set": "<thing>", "text": "...", "color": "..."}',
  '{"move": "<thing>", "below": "<thing>"}   {"remove": "<thing>"}   {"frame": ["<thing>", ...], "title": "..."}',
  '{"replace": "<thing>", "with": [add and connect changes]}  a frame: what it holds is replaced; a list of things: they are.',
  "If someone changed the same thing since your base, you are told what they did and nothing changes. The person sees your change on the canvas at once; nothing is sent to them.",
].join("\n");

/** The `do` field: the whole grammar, so an agent that sees only the fields (the `plannotator_inbox` tool) can write a change. */
export const INBOX_CANVAS_DO_DESCRIPTION = [
  'Changes to the canvas, all or nothing; send "base" (the rev of your last answer) with them. Name a thing by the id at the start of its line, or by its words. One verb per change:',
  '{"add": "box", "text": "...", "rightOf": "<thing>"}  add: box, ellipse, diamond, note, text, frame, mermaid (text is a flowchart or sequence diagram). Place: near, rightOf, leftOf, above, below, in (a frame), or "at": [x, y]. Optional "color".',
  '{"connect": "<thing>", "to": "<thing>", "label": "..."}   {"set": "<thing>", "text": "...", "color": "..."}',
  '{"move": "<thing>", "below": "<thing>"}   {"remove": "<thing>"}   {"frame": ["<thing>", ...], "title": "..."}',
  '{"replace": "<thing>", "with": [add and connect changes]}  a frame: what it holds is replaced; a list of things: they are.',
  "If someone changed the same thing since your base, you are told what they did and nothing changes.",
].join("\n");

const PICTURE_WAIT_MS = 8_000;
const MERMAID_WAIT_MS = 12_000;
const SCENE_MAX_BYTES = 64 * 1024 * 1024;
const PICTURE_MAX_BYTES = 32 * 1024 * 1024;

type Json = (data: unknown, status?: number) => Response;

interface Job {
  kind: "picture" | "mermaid";
  resolve: (value: unknown) => void;
}

interface PictureAnswer {
  png: Uint8Array;
  box: Box;
  scale: number;
}

export interface InboxCanvas {
  /** The window's routes; null for a path that is not a canvas path. */
  route(req: Request, path: string): Promise<Response | null>;
  /** A window's stream: called for every canvas frame until the returned function is called. */
  listen(send: (event: string, data: unknown) => void): () => void;
  register(server: McpServer): void;
  /** What a reply sent from the canvas carries for the agent (`body.sketch` of the reply route), checked and worded here. */
  replySketch(threadId: string, raw: unknown): InboxReplySketch | undefined;
  /** For tests and the route: the tool's three jobs. */
  read(threadId: string, viewer: CanvasAuthor, options?: { in?: string; after?: string }): string;
  apply(threadId: string, viewer: CanvasAuthor, base: unknown, ops: unknown): Promise<{ ok: boolean; text: string; rev: number }>;
}

export function createInboxCanvas(options: {
  store: InboxStore;
  serverSession: string;
  json: Json;
  readBody: (req: Request) => Promise<Record<string, unknown>>;
  sessionMismatch: (body: Record<string, unknown>) => Response | null;
  now?: () => number;
}): InboxCanvas {
  const { store, json } = options;
  const dir = store.dir;
  const now = options.now ?? Date.now;
  const windows = new Set<(event: string, data: unknown) => void>();
  const jobs = new Map<string, Job>();
  const emit = (event: string, data: unknown) => {
    for (const send of windows) send(event, data);
  };
  // A deleted thread's canvas goes with it (moved aside, store.ts `retireCanvas`).
  store.onDeletion(() => {
    for (const id of canvasThreads(dir)) if (!store.message(id)) retireCanvas(dir, id, now());
  });

  const threadOf = (id: string): string => {
    const root = store.message(id.trim())?.thread_id;
    if (!root) throw new InboxError("thread_not_found", `No thread or message ${id}.`, { field: "thread_id" });
    return root;
  };

  /** Ask an open window to do what only a browser can. Null when none is open or none answers in time. */
  const askWindow = <T>(kind: Job["kind"], payload: Record<string, unknown>, waitMs: number): Promise<T | null> => {
    if (windows.size === 0) return Promise.resolve(null);
    const id = `job_${crypto.randomUUID().replace(/-/g, "")}`;
    return new Promise<T | null>((resolve) => {
      const timer = setTimeout(() => {
        jobs.delete(id);
        resolve(null);
      }, waitMs);
      jobs.set(id, {
        kind,
        resolve: (value) => {
          clearTimeout(timer);
          jobs.delete(id);
          resolve(value as T | null);
        },
      });
      emit("canvas-job", { id, kind, ...payload });
    });
  };

  const viewerKey = (viewer: CanvasAuthor) => viewer.key || "agent";

  const undoneLines = (revs: number[]) => revs.map((n) => `The person undid your change (rev ${n}): what it changed is as it was before, and what it added is gone.`);

  /** The lines an answer opens with: what others changed since this agent's last look. Marks the look, only as far as it told. */
  const opening = (threadId: string, viewer: CanvasAuthor, rev: number): string[] => {
    const key = viewerKey(viewer);
    const last = readCanvasMeta(dir, threadId).seen[key];
    if (last === undefined || last >= rev) {
      noteCanvasSeen(dir, threadId, key, rev);
      return last === undefined ? (rev === 0 ? [] : ["Your first look at this canvas."]) : [`Nothing changed since you last looked (rev ${rev}).`];
    }
    const told = sinceLines(readCanvasLog(dir, threadId), last, viewer);
    noteCanvasSeen(dir, threadId, key, told.cut ? told.through : rev);
    if (told.lines.length === 0 && told.undone.length === 0) return [`Nothing others did changed it since you last looked (rev ${last}); your own changes made it rev ${rev}.`];
    return [
      ...undoneLines(told.undone),
      `Changed since you last looked (rev ${last}):`,
      ...told.lines,
      ...(told.cut ? [`  More changed after rev ${told.through}. Your next call about this canvas tells the rest; until then, change only things listed here or new ones.`] : []),
    ];
  };

  const read: InboxCanvas["read"] = (threadId, viewer, readOptions = {}) => {
    const scene = readCanvasScene(dir, threadId);
    const meta = readCanvasMeta(dir, threadId);
    const things = thingsOf(scene);
    const head = opening(threadId, viewer, meta.rev);
    if (things.length === 0) {
      return [...head, `Canvas of thread ${threadId}, rev ${meta.rev}: empty. Add to it with "do" and "base": ${meta.rev}, or wait for the person to draw.`].join("\n");
    }
    let frame: string | undefined;
    if (readOptions.in) {
      const thing = resolveThing(readOptions.in, things, scene);
      if (thing.kind !== "frame") throw new InboxError("validation_error", `in: ${thing.id} is a ${thing.kind}, not a frame.`, { field: "in" });
      frame = thing.id;
    }
    const reading = readThings(scene, things, { frame, after: readOptions.after });
    const size = `${Math.round(reading.box.w)}x${Math.round(reading.box.h)}`;
    const lines = [...head, `Canvas of thread ${threadId}, rev ${meta.rev}, ${frame ? `frame ${frame}` : countWords(things)}, ${size}:`, ...reading.lines];
    if (reading.cutAfter) {
      const next = { thread_id: threadId, ...(frame ? { in: frame } : {}), after_thing: reading.cutAfter };
      lines.push(`${reading.total - reading.lines.length} more. Next: canvas ${JSON.stringify(next)}`);
    }
    return lines.join("\n");
  };

  const crop = (stored: PictureAnswer, want: Box): Uint8Array | null => {
    const decoded = decodePng(stored.png);
    if (!decoded) return null;
    const x0 = Math.max(0, Math.floor((want.x - stored.box.x) * stored.scale));
    const y0 = Math.max(0, Math.floor((want.y - stored.box.y) * stored.scale));
    const x1 = Math.min(decoded.width, Math.ceil((want.x + want.w - stored.box.x) * stored.scale));
    const y1 = Math.min(decoded.height, Math.ceil((want.y + want.h - stored.box.y) * stored.scale));
    const w = x1 - x0;
    const h = y1 - y0;
    if (w < 2 || h < 2) return null;
    const out = new Uint8Array(w * h * 4);
    for (let row = 0; row < h; row++) {
      const from = ((y0 + row) * decoded.width + x0) * 4;
      out.set(decoded.rgba.subarray(from, from + w * 4), row * w * 4);
    }
    return encodePng(w, h, out);
  };

  const picture = async (threadId: string, of: unknown): Promise<{ path: string; note: string; only: Set<string> | null; named: string[] }> => {
    const scene = readCanvasScene(dir, threadId);
    const meta = readCanvasMeta(dir, threadId);
    const things = thingsOf(scene);
    if (things.length === 0) throw new InboxError("validation_error", "picture: the canvas is empty, so there is nothing to draw.", { field: "picture" });
    let only: Set<string> | null = null;
    let named: string[] = [];
    let box: Box | null = null;
    let elementIds: string[] | null = null;
    if (of !== true) {
      const names = Array.isArray(of) ? of : [of];
      let chosen;
      try {
        chosen = names.map((n) => resolveThing(n, things, scene));
      } catch (error) {
        if (error instanceof RefError) throw new InboxError("validation_error", `picture: ${error.message}`, { field: "picture" });
        throw error;
      }
      only = new Set(chosen.map((t) => t.id));
      named = chosen.map((t) => t.id);
      // A frame's picture shows what it holds.
      const shown = things.filter((t) => only!.has(t.id) || (t.frame && only!.has(t.frame)));
      const around = unionBox(shown.map((t) => t.box));
      box = { x: around.x - 24, y: around.y - 24, w: around.w + 48, h: around.h + 48 };
      elementIds = shown.flatMap((t) => t.elementIds);
      for (const t of shown) only.add(t.id);
    }
    const name = `rev${meta.rev}-${only ? named.slice(0, 3).join("-") : "all"}`;
    const drawn = await askWindow<PictureAnswer>("picture", { thread_id: threadId, rev: meta.rev, box }, PICTURE_WAIT_MS);
    if (drawn) {
      if (!box) writeCanvasPicture(dir, threadId, drawn.png, { rev: meta.rev, box: drawn.box, scale: drawn.scale });
      return { path: writeAgentPicture(dir, threadId, name, drawn.png), note: "", only, named };
    }
    // No window drew it: the last picture a window stored, cut to the part asked for.
    const stored = readCanvasPicture(dir, threadId);
    if (!stored || !meta.picture) {
      throw new InboxError("validation_error", "picture: no Inbox window is open to draw the canvas, and none stored a picture of it yet. The text reading is complete; ask again when the person has the Inbox open.", { field: "picture" });
    }
    const whole: PictureAnswer = { png: stored, box: meta.picture.box, scale: meta.picture.scale };
    const cut = box ? crop(whole, box) : stored;
    const stale = meta.picture.rev !== meta.rev ? ` It shows rev ${meta.picture.rev}; the canvas is now rev ${meta.rev} and no Inbox window is open to draw it again, so trust the text where they differ.` : "";
    void elementIds;
    if (!cut) return { path: writeAgentPicture(dir, threadId, `rev${meta.picture.rev}-all`, stored), note: ` This is the whole canvas: the part you asked for is outside the stored picture.${stale}`, only, named };
    return { path: writeAgentPicture(dir, threadId, `rev${meta.picture.rev}-${only ? named.slice(0, 3).join("-") : "all"}`, cut), note: stale, only, named };
  };

  const apply: InboxCanvas["apply"] = async (threadId, viewer, base, ops) => {
    const meta = readCanvasMeta(dir, threadId);
    const rev = meta.rev;
    if (!Number.isInteger(base)) {
      return { ok: false, rev, text: `Nothing changed. "do" needs "base": the rev of your last answer about this canvas, so a change the person made since is never replaced unseen. Read it first: canvas ${JSON.stringify({ thread_id: threadId })}` };
    }
    if ((base as number) > rev || (base as number) < 0) {
      return { ok: false, rev, text: `Nothing changed. "base": ${String(base)} is not a rev of this canvas (it is at rev ${rev}). Read it: canvas ${JSON.stringify({ thread_id: threadId })}` };
    }
    const scene = readCanvasScene(dir, threadId);
    const wanted = mermaidTexts(ops);
    let mermaid: Map<string, CanvasElement[]> | undefined;
    if (wanted.length > 0) {
      const drawn = await askWindow<Record<string, CanvasElement[] | { error: string }>>("mermaid", { texts: wanted }, MERMAID_WAIT_MS);
      if (drawn) {
        mermaid = new Map();
        for (const text of wanted) {
          const made = drawn[text];
          if (made && !Array.isArray(made)) return { ok: false, rev, text: `Nothing changed. The mermaid diagram was not drawn: ${made.error.slice(0, 400)}` };
          if (Array.isArray(made)) mermaid.set(text, asScene({ elements: made }).elements);
        }
      }
    }
    // The scene may have moved on while a window drew the diagram.
    const fresh = readCanvasScene(dir, threadId);
    const freshRev = readCanvasMeta(dir, threadId).rev;
    const result = applyOps(freshRev === rev ? scene : fresh, ops, { by: viewer.name || "agent", now: now(), mermaid });
    if (!result.ok) {
      return { ok: false, rev: freshRev, text: [`Nothing changed (rev ${freshRev}). ${result.errors.length === 1 ? "One change cannot be made" : `${result.errors.length} changes cannot be made`}:`, ...result.errors.map((e) => `  ${e}`)].join("\n") };
    }
    const log = readCanvasLog(dir, threadId);
    // Judged by what this agent was told, not only by the rev it sends: a rev copied from a message (the person's
    // "work on this" names one) says nothing about what changed between the agent's last look and that rev.
    const told = readCanvasMeta(dir, threadId).seen[viewerKey(viewer)];
    const from = told === undefined ? (base as number) : Math.min(base as number, told);
    const since = sinceLines(log, from, viewer, Number.MAX_SAFE_INTEGER);
    const heard = sinceLines(log, from, viewer);
    const clashes = new Map<string, string>();
    for (const id of result.touched) {
      const hit = since.byElement.get(id);
      if (hit) clashes.set(hit.change.elements.slice().sort()[0] ?? id, `  ${hit.by.kind === "person" ? "the person" : hit.by.name || "another agent"} ${hit.change.op === "changed" ? hit.change.what ?? "edited" : hit.change.op} (rev ${hit.rev}): ${hit.change.line}`);
    }
    // A base older than the log reaches: what changed since cannot be told, so read again.
    const oldest = log[0]?.rev ?? 1;
    if (from < oldest - 1 && result.touched.size > 0) {
      noteCanvasSeen(dir, threadId, viewerKey(viewer), freshRev);
      return { ok: false, rev: freshRev, text: `Nothing changed. Your base (rev ${String(base)}) is older than this canvas's history reaches, so what changed since cannot be checked. Read it again and send your change with "base": ${freshRev}: canvas ${JSON.stringify({ thread_id: threadId })}` };
    }
    if (clashes.size > 0) {
      noteCanvasSeen(dir, threadId, viewerKey(viewer), freshRev);
      return {
        ok: false,
        rev: freshRev,
        text: [
          `Nothing changed. Since ${from < (base as number) ? `you last looked (rev ${from})` : `your base (rev ${String(base)})`} ${clashes.size === 1 ? "a thing you are changing was" : `${clashes.size} things you are changing were`} changed by someone else:`,
          ...clashes.values(),
          `Their change stays. If yours still makes sense with theirs in view, send it again with "base": ${freshRev}; if it would undo what the person did, ask them first.`,
        ].join("\n"),
      };
    }
    const base0 = freshRev === rev ? scene : fresh;
    const committed = commitCanvas(dir, threadId, result.scene, viewer, new Date(now()));
    // What this change replaced, so the person can take it back with one press (the window's Undo).
    if (committed.entry) writeCanvasUndo(dir, threadId, { rev: committed.rev, before: base0.elements.filter((e) => result.touched.has(e.id)), added: [...result.added] });
    noteCanvasSeen(dir, threadId, viewerKey(viewer), heard.cut ? heard.through : committed.rev);
    emit("canvas", { thread_id: threadId, rev: committed.rev, by: viewer.name || "An agent", elements: [...result.added, ...result.touched] });
    const others = [
      ...undoneLines(heard.undone),
      ...(heard.lines.length > 0 ? [`Changed by others since you last looked (rev ${from}), not touched by you:`, ...heard.lines] : []),
      ...(heard.cut ? [`  More changed after rev ${heard.through}. Your next call about this canvas tells the rest.`] : []),
    ];
    return {
      ok: true,
      rev: committed.rev,
      text: [...others, `Done: the canvas is now rev ${committed.rev}. The person sees it on the canvas; nothing was sent to them.`, ...result.done.map((line) => `  ${line}`)].join("\n"),
    };
  };

  const rawBody = async (req: Request, max: number): Promise<Uint8Array> => {
    const length = Number(req.headers.get("content-length") ?? "0");
    if (length > max) throw new InboxError("validation_error", "body: too large.");
    const bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes.length > max) throw new InboxError("validation_error", "body: too large.");
    return bytes;
  };

  const placeOf = (url: URL): { box: Box; scale: number } | null => {
    const n = (key: string) => Number(url.searchParams.get(key));
    const box = { x: n("x"), y: n("y"), w: n("w"), h: n("h") };
    const scale = n("scale");
    return [box.x, box.y, box.w, box.h, scale].every((v) => Number.isFinite(v)) && box.w > 0 && box.h > 0 && scale > 0 ? { box, scale } : null;
  };

  const replySketch: InboxCanvas["replySketch"] = (threadId, raw) => {
    if (!raw || typeof raw !== "object") return undefined;
    const input = raw as { kind?: unknown; elements?: unknown; pictures?: unknown };
    const scene = readCanvasScene(dir, threadId);
    const things = thingsOf(scene);
    const ids = new Set(Array.isArray(input.elements) ? input.elements.filter((id): id is string => typeof id === "string").slice(0, 5000) : []);
    const kind = input.kind === "selection" && ids.size > 0 ? "selection" : "sketch";
    // A selection: the things that hold a picked element, and what a picked frame holds. A sketch: the whole canvas.
    const picked = kind === "selection" ? things.filter((t) => t.elementIds.some((id) => ids.has(id))) : things;
    const only = new Set(picked.map((t) => t.id));
    for (const t of things) if (t.frame && only.has(t.frame)) only.add(t.id);
    if (only.size === 0) return undefined;
    // The picture each sketch was sent as, by its thing id (file names the window chose; one line, no path).
    const pictures = new Map<string, string>();
    if (input.pictures && typeof input.pictures === "object") {
      for (const [thing, name] of Object.entries(input.pictures as Record<string, unknown>)) {
        if (typeof name === "string" && /^[A-Za-z0-9._ -]{1,120}$/.test(name)) pictures.set(thing, name);
      }
    }
    const reading = readThings(scene, things, { only, limit: 80 });
    const lines = reading.lines.map((line) => {
      const id = /^\s*sketch (\S+)/.exec(line)?.[1];
      const name = id ? pictures.get(id) : undefined;
      return name ? `${line} [picture: ${name}]` : line;
    });
    if (reading.cutAfter) lines.push(`${reading.total - reading.lines.length} more: canvas ${JSON.stringify({ thread_id: threadId, after_thing: reading.cutAfter })}`);
    return { kind, rev: readCanvasMeta(dir, threadId).rev, things: [...only], reading: lines.join("\n") };
  };

  return {
    read,
    apply,
    replySketch,
    listen(send) {
      windows.add(send);
      return () => windows.delete(send);
    },
    async route(req, path) {
      const url = new URL(req.url);
      const jobMatch = /^\/api\/inbox\/canvas\/jobs\/(job_[a-f0-9]{32})$/.exec(path);
      if (jobMatch) {
        if (req.method !== "POST") return json({ error: "Use POST." }, 405);
        const job = jobs.get(jobMatch[1]!);
        // Another window answered first, or the wait ran out: nothing to do.
        if (!job) return json({ ok: true, late: true });
        if (job.kind === "picture") {
          const place = placeOf(url);
          const png = await rawBody(req, PICTURE_MAX_BYTES);
          if (place && png.length > 8) job.resolve({ png, ...place } satisfies PictureAnswer);
          else if (url.searchParams.get("failed")) job.resolve(null);
        } else {
          const body = await options.readBody(req);
          job.resolve(body.drawn && typeof body.drawn === "object" ? body.drawn : null);
        }
        return json({ ok: true });
      }
      if (path === "/api/inbox/canvases") {
        // Which threads have a canvas with something on it, and where an agent changed it since the person last had it on screen.
        if (req.method !== "GET") return json({ error: "Use GET." }, 405);
        const canvases = canvasThreads(dir)
          .map((id) => ({ id, meta: readCanvasMeta(dir, id) }))
          .filter(({ meta }) => meta.count > 0)
          .map(({ id, meta }) => ({ thread_id: id, rev: meta.rev, changed: meta.agent_rev > meta.person_seen }));
        return json({ serverSession: options.serverSession, canvases });
      }
      const match = /^\/api\/inbox\/threads\/([A-Za-z0-9_]+)\/canvas(\/picture|\/undo)?$/.exec(path);
      if (!match) return null;
      const message = store.message(match[1]!);
      if (!message) return json({ error: `No thread ${match[1]}.`, code: "thread_not_found" }, 404);
      const threadId = message.thread_id;
      if (match[2] === "/undo") {
        // The person takes back one change an agent made: each thing it changed goes back to what it was, what it
        // added goes, and whatever the person did since to other things stays.
        if (req.method !== "POST") return json({ error: "Use POST." }, 405);
        const body = await options.readBody(req);
        const mismatch = options.sessionMismatch(body);
        if (mismatch) return mismatch;
        const undo = Number.isInteger(body.rev) ? readCanvasUndo(dir, threadId, body.rev as number) : null;
        if (!undo) return json({ error: "That change can no longer be undone.", code: "validation_error" }, 422);
        const stored = readCanvasScene(dir, threadId);
        const was = new Map(undo.before.map((e) => [e.id, e]));
        const added = new Set(undo.added);
        const stamp = (e: CanvasElement, current: CanvasElement) => ({ ...e, version: (current.version ?? 1) + 1, versionNonce: Math.floor(Math.random() * 2 ** 31), updated: now() });
        const elements = stored.elements.map((e) => (was.has(e.id) ? stamp(was.get(e.id)!, e) : added.has(e.id) && !e.isDeleted ? stamp({ ...e, isDeleted: true }, e) : e));
        const committed = commitCanvas(dir, threadId, { ...stored, elements }, { kind: "person" }, new Date(now()), { undid: undo.rev });
        emit("canvas", { thread_id: threadId, rev: committed.rev, by: null, window: typeof body.window === "string" ? body.window : null, elements: [] });
        return json({ serverSession: options.serverSession, rev: committed.rev, scene: readCanvasScene(dir, threadId) });
      }
      if (match[2]) {
        // The window's drawing of the whole canvas, kept for an agent's `picture` when no window is open.
        if (req.method !== "POST") return json({ error: "Use POST." }, 405);
        const place = placeOf(url);
        const rev = Number(url.searchParams.get("rev"));
        const png = await rawBody(req, PICTURE_MAX_BYTES);
        if (!place || !Number.isInteger(rev) || png.length < 8) return json({ error: "A picture needs its place.", code: "validation_error" }, 422);
        writeCanvasPicture(dir, threadId, png, { rev, ...place });
        return json({ ok: true });
      }
      if (req.method === "GET") {
        const meta = readCanvasMeta(dir, threadId);
        // The canvas is on the person's screen (`look=1`): an agent's change up to here is no longer news.
        if (url.searchParams.get("look") === "1" && meta.person_seen !== meta.rev && meta.rev > 0) writeCanvasMeta(dir, threadId, { ...meta, person_seen: meta.rev });
        const since = Number(url.searchParams.get("since"));
        const scene = readCanvasScene(dir, threadId);
        // What changed after a revision, for the window's "what changed" line.
        const changes = url.searchParams.has("since") && Number.isInteger(since) ? readCanvasLog(dir, threadId).filter((entry) => entry.rev > since) : [];
        return json({ serverSession: options.serverSession, rev: meta.rev, scene, changes });
      }
      if (req.method !== "POST") return json({ error: "Use GET or POST." }, 405);
      const length = Number(req.headers.get("content-length") ?? "0");
      if (length > SCENE_MAX_BYTES) return json({ error: "This canvas is too large to save.", code: "validation_error" }, 413);
      const body = await options.readBody(req);
      const mismatch = options.sessionMismatch(body);
      if (mismatch) return mismatch;
      const incoming = asScene(body.scene);
      let stored = readCanvasScene(dir, threadId);
      const before = readCanvasMeta(dir, threadId).rev;
      // What this window held and no longer does (a file loaded over the canvas): deleted, not "never seen".
      const gone = new Set(Array.isArray(body.gone) ? body.gone.filter((id): id is string => typeof id === "string") : []);
      if (gone.size > 0) {
        const named = new Set(incoming.elements.map((e) => e.id));
        stored = {
          ...stored,
          elements: stored.elements.map((e) =>
            gone.has(e.id) && !named.has(e.id) && !e.isDeleted ? { ...e, isDeleted: true, version: (e.version ?? 1) + 1, versionNonce: Math.floor(Math.random() * 2 ** 31), updated: now() } : e,
          ),
        };
      }
      const merged = mergeSave(stored, incoming, now());
      const committed = commitCanvas(dir, threadId, merged.scene, { kind: "person" }, new Date(now()));
      if (committed.rev !== before) emit("canvas", { thread_id: threadId, rev: committed.rev, by: null, window: typeof body.window === "string" ? body.window : null, elements: [] });
      // The store held things this window did not (an agent's change landed meanwhile): the window takes the merged scene.
      return json({ serverSession: options.serverSession, rev: committed.rev, ...(merged.kept > 0 && body.have !== committed.rev ? { scene: merged.scene } : {}) });
    },
    register(server) {
      server.registerTool(
        "canvas",
        {
          title: "A thread's canvas",
          description: INBOX_CANVAS_DESCRIPTION,
          inputSchema: z
            .object({
              thread_id: z.string().describe("Thread or message id."),
              in: z.string().optional().describe("The canvas action: read only this frame (its id or title). With only thread_id the action answers the thread's canvas (the drawing the person sketches on) as text, one line per thing, and its rev."),
              after_thing: z.string().optional().describe("Continue a long reading of the canvas after this thing id (a cut reading ends with the exact call)."),
              picture: z.union([z.boolean(), z.string(), z.array(z.string())]).optional().describe('true: a PNG of the whole canvas. A thing or a list of things: a PNG of that part. The answer gives the file path.'),
              base: z.number().int().optional().describe('With "do": the rev your last answer about this canvas gave.'),
              do: z.array(z.record(z.string(), z.unknown())).optional().describe(INBOX_CANVAS_DO_DESCRIPTION),
              project_path: z.string().optional(),
              agent_session: z.string().optional(),
              agent_name: z.string().optional(),
              agent_host: z.string().optional(),
            })
            .strict(),
          annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        },
        async (input) =>
          guarded(async () => {
            const threadId = threadOf(input.thread_id ?? "");
            const session = input.agent_session?.trim();
            const viewer: CanvasAuthor = {
              kind: "agent",
              name: inboxAgentName({ kind: "agent", host: input.agent_host?.trim() || null, name: inboxStoredAgentName(input.agent_name) }),
              ...(session ? { key: session } : {}),
            };
            if (input.do !== undefined) {
              const result = await apply(threadId, viewer, input.base, input.do);
              // A refusal is an error to the caller (a script's exit code, a tool's red result): nothing changed.
              if (!result.ok) return fail("canvas_unchanged", result.text);
              return okComplete(result.text, { thread_id: threadId, rev: result.rev, changed: true });
            }
            try {
              if (input.picture !== undefined && input.picture !== false) {
                const drawn = await picture(threadId, input.picture);
                const text = read(threadId, viewer, { in: input.in });
                const head = `Picture${drawn.only ? ` of ${drawn.named.slice(0, 8).join(", ")}` : " of the whole canvas"}: ${drawn.path}${drawn.note}`;
                return okComplete(`${head}\n${text}`, { thread_id: threadId, rev: readCanvasMeta(dir, threadId).rev, picture: drawn.path });
              }
              return okComplete(read(threadId, viewer, { in: input.in, after: input.after_thing }), { thread_id: threadId, rev: readCanvasMeta(dir, threadId).rev });
            } catch (error) {
              if (error instanceof RefError) throw new InboxError("validation_error", error.message);
              throw error;
            }
          }),
      );
    },
  };
}
