/**
 * Plannotator Inbox: a thread's canvas, a capability off by default
 * (inbox-canvas-switch.ts; the routes answer only while it is on).
 *
 * Every thread can hold one canvas: an Excalidraw scene the person draws on
 * in the window (packages/inbox/canvas) and an agent reads and changes with
 * `plannotator inbox canvas` (a command, not an action of the agent tool:
 * inbox-canvas-agent.ts is its route). The scene is Excalidraw's own JSON,
 * stored beside the thread (packages/shared/inbox/canvas/store.ts).
 *
 * The server never loads Excalidraw. It reads the scene as text and applies an
 * agent's changes itself (shared/inbox/canvas/reading.ts, apply.ts). Two
 * things only a browser can do, drawing a picture and turning mermaid text
 * into shapes, it asks an open window to do (`event: canvas-job` on the
 * windows' streams; the window answers on `/api/inbox/canvas/jobs/<id>`), and
 * falls back to the last picture a window stored when none is open.
 *
 * The rule the command is built around: an agent never replaces what the person
 * just did without knowing. Every change names the revision the agent last
 * read (`base`). A change to a thing someone else changed after that is
 * refused whole, with their change shown. A change to anything else lands,
 * and every answer opens with what others changed since the agent's last look.
 */
import { gunzipSync } from "node:zlib";
import { inboxStoredAgentName } from "@plannotator/core/inbox-format";
import { inboxAgentName, type InboxReplySketch } from "@plannotator/core/inbox-types";
import { applyOps, mermaidTexts, RefError, resolveThing } from "@plannotator/shared/inbox/canvas/apply";
import { canvasReadCommand } from "@plannotator/shared/inbox/canvas/command";
import { mergeSave, sameAuthor, sinceLines, undoneLine, type CanvasAuthor, type CanvasLogEntry, type CanvasUndone } from "@plannotator/shared/inbox/canvas/changes";
import { countWords, lineOf, readThings, thingsOf, type Thing } from "@plannotator/shared/inbox/canvas/reading";
import { asScene, lookOf, pictureTiles, unionBox, type Box, type CanvasElement, type CanvasScene } from "@plannotator/shared/inbox/canvas/scene";
import {
  canvasThreads,
  commitCanvas,
  isCanvasSession,
  markCanvasTold,
  readCanvasFile,
  readCanvasTold,
  removeCanvasUndo,
  sweepGoneCanvases,
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
  writeCanvasFiles,
  writeCanvasPicture,
} from "@plannotator/shared/inbox/canvas/store";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { decodePng, encodePng } from "./inbox-icon-trim";

/** What `plannotator inbox canvas` asks (inbox-canvas-agent.ts checks it). `by`: the agent, as its shell names it. */
export interface CanvasAgentAsk {
  thread_id: string;
  in?: string;
  things?: string[];
  after_thing?: string;
  picture?: true | string | string[];
  base?: number;
  do?: unknown;
  /** `away`: a paired agent on another computer (the agent door sets it): a picture's path here means nothing to it. */
  by?: { host?: string; session?: string; name?: string; away?: true };
}

/** The answer: the text the agent reads, and the canvas's rev (and the pictures' paths). Not ok: nothing changed. */
export type CanvasAgentAnswer = { ok: boolean; code?: string; text: string; structured: Record<string, unknown> };

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
  /** An agent's `plannotator inbox canvas`: a read, a picture, or a change (inbox-canvas-agent.ts is its route). */
  agent(ask: CanvasAgentAsk): Promise<CanvasAgentAnswer>;
  /** What a reply sent from the canvas carries for the agent (`body.sketch` of the reply route), checked and worded here. */
  replySketch(threadId: string, raw: unknown): InboxReplySketch | undefined;
  /** For tests and the route: the command's three jobs. */
  read(threadId: string, viewer: CanvasAuthor, options?: { in?: string; after?: string; things?: string[] }): string;
  /** The reply that carried `sketch` is stored and went to `session`: what it lists is shown to that session. */
  replyShown(threadId: string, sketch: InboxReplySketch, session: string): void;
  apply(threadId: string, viewer: CanvasAuthor, base: unknown, ops: unknown): Promise<{ ok: boolean; text: string; rev: number }>;
}

export function createInboxCanvas(options: {
  store: InboxStore;
  serverSession: string;
  json: Json;
  readBody: (req: Request) => Promise<Record<string, unknown>>;
  sessionMismatch: (body: Record<string, unknown>) => Response | null;
  now?: () => number;
  /** The canvas switch (inbox-canvas-switch.ts). Off: stored canvases are left exactly as they are, deleted threads' too. Absent: on. */
  on?: () => boolean;
}): InboxCanvas {
  const { store, json } = options;
  const dir = store.dir;
  const now = options.now ?? Date.now;
  const windows = new Set<(event: string, data: unknown) => void>();
  const jobs = new Map<string, Job>();
  const emit = (event: string, data: unknown) => {
    for (const send of windows) send(event, data);
  };
  // A deleted thread's canvas goes with it (moved aside, store.ts `retireCanvas`). Only while the canvas is on.
  const on = options.on ?? (() => true);
  store.onDeletion(() => {
    if (!on()) return;
    for (const id of canvasThreads(dir)) if (!store.message(id)) retireCanvas(dir, id, now());
    sweepGoneCanvases(dir, now());
  });
  if (on()) sweepGoneCanvases(dir, now());

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

  /** An agent session's own key; none for a call that names no session (nothing is remembered for it, and it shares nothing). */
  const sessionOf = (viewer: CanvasAuthor): string | undefined => (isCanvasSession(viewer.key) ? viewer.key : undefined);
  /** The look each of these elements has in a scene (scene.ts `lookOf`): what "shown" records. */
  const looksIn = (scene: CanvasScene, ids: Iterable<string>): [string, string][] => {
    const by = new Map(scene.elements.map((e) => [e.id, e]));
    const out: [string, string][] = [];
    for (const id of ids) {
      const el = by.get(id);
      if (el) out.push([id, lookOf(el)]);
    }
    return out;
  };
  /** A list of others' changes was printed: the things in it whose line is still their line now are shown, as they are now. */
  const showListed = (threadId: string, key: string, scene: CanvasScene, things: Thing[], listed: Map<string, { change: { line: string } }>) => {
    const thingOf = new Map<string, Thing>();
    for (const t of things) for (const id of t.elementIds) thingOf.set(id, t);
    const ids: string[] = [];
    for (const [id, hit] of listed) {
      const thing = thingOf.get(id);
      if (thing && lineOf(thing, scene, things) === hit.change.line) ids.push(id);
    }
    markCanvasTold(dir, threadId, key, looksIn(scene, ids));
  };
  const readCall = canvasReadCommand;

  /** Exactly what each Undo took back and what the person kept (changes.ts `undoneLine`); each thing is in the list that follows, as it is now. */
  const undoneLines = (entries: CanvasLogEntry[]) => entries.map(undoneLine);

  /**
   * The lines an answer opens with: what others changed since this session's last answer about the canvas. Each
   * thing listed is marked as shown to the session; the list's point (`seen`) moves only as far as the list reached.
   * A call with no session has no memory: it opens with nothing and is told nothing.
   */
  const opening = (threadId: string, viewer: CanvasAuthor, rev: number, scene: CanvasScene, things: Thing[]): string[] => {
    const key = sessionOf(viewer);
    if (!key) return [];
    const last = readCanvasMeta(dir, threadId).seen[key];
    if (last === undefined || last >= rev) {
      noteCanvasSeen(dir, threadId, key, rev);
      return last === undefined ? (rev === 0 ? [] : ["Your first look at this canvas."]) : [`Nothing changed since you last looked (rev ${rev}).`];
    }
    const told = sinceLines(readCanvasLog(dir, threadId), last, viewer);
    noteCanvasSeen(dir, threadId, key, told.cut ? told.through : rev);
    showListed(threadId, key, scene, things, told.byElement);
    if (told.lines.length === 0 && told.undone.length === 0) return [`Nothing others did changed it since you last looked (rev ${last}); your own changes made it rev ${rev}.`];
    return [
      ...undoneLines(told.undone),
      `Changed since you last looked (rev ${last}; now rev ${told.cut ? told.through : rev}${told.saves ? `: ${told.saves}` : ""}):`,
      ...told.lines,
      ...(told.cut ? [`  More changed after rev ${told.through}. For the rest: ${readCall(threadId)}`] : []),
    ];
  };

  const read: InboxCanvas["read"] = (threadId, viewer, readOptions = {}) => {
    const scene = readCanvasScene(dir, threadId, false);
    const meta = readCanvasMeta(dir, threadId);
    const things = thingsOf(scene);
    // Everything that can refuse the read comes before anything is marked as shown.
    let frame: string | undefined;
    if (readOptions.in) {
      const thing = resolveThing(readOptions.in, things, scene);
      if (thing.kind !== "frame") throw new InboxError("validation_error", `in: ${thing.id} is a ${thing.kind}, not a frame.`, { field: "in" });
      frame = thing.id;
    }
    const head = opening(threadId, viewer, meta.rev, scene, things);
    if (things.length === 0) {
      return [...head, `Canvas of thread ${threadId}, rev ${meta.rev}: empty. Add to it with --base ${meta.rev} --do, or wait for the person to draw.`].join("\n");
    }
    // `things`: exactly these, by id (a refusal names the ones it could not list this way).
    let only: Set<string> | undefined;
    if (readOptions.things) {
      const known = new Set(things.map((t) => t.id));
      only = new Set(readOptions.things.filter((id) => known.has(id)));
    }
    // Things asked for by id come with all their words; a reading of the canvas holds the first 90 characters of each.
    const reading = readThings(scene, things, { frame, after: readOptions.after, only, ...(only ? { limit: 400, full: true } : {}) });
    const key = sessionOf(viewer);
    if (key) markCanvasTold(dir, threadId, key, looksIn(scene, reading.shown.flatMap((t) => t.elementIds)));
    const size = `${Math.round(reading.box.w)}x${Math.round(reading.box.h)}`;
    const lines = [...head, `Canvas of thread ${threadId}, rev ${meta.rev}, ${frame ? `frame ${frame}` : countWords(things)}, ${size}:`];
    if (reading.afterMissing) lines.push(`(Nothing is called ${JSON.stringify(readOptions.after)} any more, so this reading starts from the top.)`);
    lines.push(...reading.lines);
    if (reading.cutAfter) lines.push(`${reading.total - reading.lines.length} more. Next: ${readCall(threadId, { ...(frame ? { in: frame } : {}), after_thing: reading.cutAfter })}`);
    // Words cut short say so, with the call that gives them whole.
    if (reading.cutWords.length > 0) lines.push(`Words ending in … are cut at 90 characters. All of a thing's words: ${readCall(threadId, { things: reading.cutWords.slice(0, 12) })}`);
    return lines.join("\n");
  };

  const crop = (stored: PictureAnswer, want: Box): Uint8Array | "outside" | "unreadable" => {
    const decoded = decodePng(stored.png, 8192);
    if (!decoded) return "unreadable";
    const x0 = Math.max(0, Math.floor((want.x - stored.box.x) * stored.scale));
    const y0 = Math.max(0, Math.floor((want.y - stored.box.y) * stored.scale));
    const x1 = Math.min(decoded.width, Math.ceil((want.x + want.w - stored.box.x) * stored.scale));
    const y1 = Math.min(decoded.height, Math.ceil((want.y + want.h - stored.box.y) * stored.scale));
    const w = x1 - x0;
    const h = y1 - y0;
    if (w < 2 || h < 2) return "outside";
    const out = new Uint8Array(w * h * 4);
    for (let row = 0; row < h; row++) {
      const from = ((y0 + row) * decoded.width + x0) * 4;
      out.set(decoded.rgba.subarray(from, from + w * 4), row * w * 4);
    }
    return encodePng(w, h, out);
  };

  const picture = async (threadId: string, of: unknown): Promise<{ path: string; paths?: string[]; note: string; only: Set<string> | null; named: string[] }> => {
    const scene = readCanvasScene(dir, threadId, false);
    const meta = readCanvasMeta(dir, threadId);
    const things = thingsOf(scene);
    if (things.length === 0) throw new InboxError("validation_error", "picture: the canvas is empty, so there is nothing to draw.", { field: "picture" });
    let only: Set<string> | null = null;
    let named: string[] = [];
    let box: Box | null = null;
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
      for (const t of shown) only.add(t.id);
    }
    const name = `rev${meta.rev}-${only ? named.slice(0, 3).join("-") : "all"}`;
    // A strip many times longer than it is wide (a tall screenshot) is drawn in pieces along its length, each at a
    // size that can be read; as one picture it would be a sliver.
    const near = things.filter((t) => !t.far);
    const whole = box ?? ((b: Box) => ({ x: b.x - 24, y: b.y - 24, w: b.w + 48, h: b.h + 48 }))(unionBox((near.length > 0 ? near : things).map((t) => t.box)));
    const tiles = pictureTiles(whole);
    if (tiles.length > 1) {
      const paths: string[] = [];
      for (const [i, tile] of tiles.entries()) {
        const part = await askWindow<PictureAnswer>("picture", { thread_id: threadId, rev: meta.rev, box: tile, crop: true }, PICTURE_WAIT_MS);
        if (!part) break;
        paths.push(writeAgentPicture(dir, threadId, `${name}-part${i + 1}of${tiles.length}`, part.png));
      }
      if (paths.length === tiles.length) {
        return { path: paths[0]!, paths, note: ` It is ${Math.round(whole.w)}x${Math.round(whole.h)}, too long for one readable picture, so it is in ${paths.length} parts from ${whole.h >= whole.w ? "top to bottom" : "left to right"}.`, only, named };
      }
    }
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
    const stale = meta.picture.rev !== meta.rev ? ` It shows rev ${meta.picture.rev}; the canvas is now rev ${meta.rev} and no Inbox window is open to draw it again, so trust the text where they differ.` : "";
    const cut = box ? crop({ png: stored, box: meta.picture.box, scale: meta.picture.scale }, box) : stored;
    if (typeof cut === "string") {
      const why = cut === "outside" ? "the part you asked for is not in the stored picture (it was added after it was drawn)" : "the stored picture could not be cut here";
      return { path: writeAgentPicture(dir, threadId, `rev${meta.picture.rev}-all`, stored), note: ` This is the whole canvas: no Inbox window is open to draw the part, and ${why}.${stale}`, only, named };
    }
    return { path: writeAgentPicture(dir, threadId, `rev${meta.picture.rev}-${only ? named.slice(0, 3).join("-") : "all"}`, cut), note: stale, only, named };
  };

  const ANSWER_LINES = 40;
  const CLASH_LINES = 30;

  const apply: InboxCanvas["apply"] = async (threadId, viewer, base, ops) => {
    const rev = readCanvasMeta(dir, threadId).rev;
    const key = sessionOf(viewer);
    const refuse = (text: string, at = rev) => ({ ok: false, rev: at, text });
    if (!Number.isInteger(base)) {
      return refuse(`Nothing changed. --do needs --base: the rev of your last answer about this canvas. Read it first: ${readCall(threadId)}`);
    }
    if ((base as number) > rev || (base as number) < 0) {
      return refuse(`Nothing changed. --base ${String(base)} is not a rev of this canvas (it is at rev ${rev}). Read it: ${readCall(threadId)}`);
    }
    const wanted = mermaidTexts(ops);
    let mermaid: Map<string, CanvasElement[]> | undefined;
    if (wanted.length > 0) {
      const drawn = await askWindow<Record<string, CanvasElement[] | { error: string }>>("mermaid", { texts: wanted }, MERMAID_WAIT_MS);
      if (drawn) {
        mermaid = new Map();
        for (const text of wanted) {
          const made = drawn[text];
          if (made && !Array.isArray(made)) return refuse(`Nothing changed. The mermaid diagram was not drawn: ${String(made.error).slice(0, 400)}`);
          if (Array.isArray(made)) mermaid.set(text, asScene({ elements: made }).elements);
        }
      }
    }
    // Read after any wait for a window: the scene may have moved on meanwhile.
    const scene = readCanvasScene(dir, threadId, false);
    const now0 = readCanvasMeta(dir, threadId).rev;
    const log = readCanvasLog(dir, threadId);
    // No session, no memory: the only thing such a caller can show is that it holds the canvas as it is now.
    if (!key && (base as number) !== now0) {
      const since = sinceLines(log, base as number, null);
      return refuse(
        [
          `Nothing changed. This call names no session, so nothing is remembered between your calls, and --base must be the canvas's current rev (${now0}), not ${String(base)}.`,
          ...(since.lines.length > 0 ? [`Changed since rev ${String(base)}:`, ...since.lines, ...(since.cut ? [`  More changed after rev ${since.through}.`] : [])] : []),
          `Read it as it is now, then send your change with --base ${now0}: ${readCall(threadId)}`,
        ].join("\n"),
        now0,
      );
    }
    const result = applyOps(scene, ops, { by: viewer.name || "agent", now: now(), mermaid });
    if (!result.ok) {
      // An error opens with what changed too: the answer the agent acts on next must not hide news.
      const head = opening(threadId, viewer, now0, scene, thingsOf(scene));
      const news = head.filter((line) => !line.startsWith("Nothing") && !line.startsWith("Your first look"));
      // A name that fits nothing any more (the person renamed the thing) is answered with the nearest things as they
      // are now: those lines have shown them, so the next call, by id, lands.
      if (key && result.listed && result.listed.size > 0 && result.errors.length <= 10) markCanvasTold(dir, threadId, key, looksIn(scene, result.listed));
      return refuse([...news, `Nothing changed (rev ${now0}). ${result.errors.length === 1 ? "One change cannot be made" : `${result.errors.length} changes cannot be made`}:`, ...result.errors.slice(0, 10).map((e) => `  ${e}`)].join("\n"), now0);
    }
    if (key) {
      // Thing by thing: a change may overwrite, move or remove a thing only as this session was last shown it. Shown
      // means an answer to this session (or the person's reply from the canvas) held the thing's line at or after the
      // last change anyone else made to it. Nothing else counts: not the base sent, not a reading that was cut.
      const told = readCanvasTold(dir, threadId)[key];
      const byId = new Map(scene.elements.map((e) => [e.id, e]));
      // The log only says who changed a thing, when it still reaches that far; whether it changed is read off the thing itself.
      const lastOther = new Map<string, { rev: number; by: CanvasAuthor; what: string }>();
      for (const entry of log) {
        if (sameAuthor(entry.by, viewer)) continue;
        for (const change of entry.changes) {
          for (const id of change.elements) lastOther.set(id, { rev: entry.rev, by: entry.by, what: change.op === "changed" ? change.what ?? "edited" : change.op });
        }
      }
      const things = thingsOf(scene);
      const thingOf = new Map<string, Thing>();
      for (const t of things) for (const id of t.elementIds) thingOf.set(id, t);
      const clashes = new Map<string, { line: string; ids: string[]; person: boolean; by: string }>();
      for (const id of result.direct) {
        const el = byId.get(id);
        if (el && told?.[id] === lookOf(el)) continue;
        const thing = thingOf.get(id);
        if (!thing || clashes.has(thing.id)) continue;
        const other = lastOther.get(id);
        const never = !thing.elementIds.some((e) => told?.[e] !== undefined);
        const who = other
          ? `${other.by.kind === "person" ? "the person" : other.by.name || "another agent"} ${other.what} (rev ${other.rev})`
          : never
            ? "not shown to you yet"
            : "changed since you were shown it";
        clashes.set(thing.id, { line: `  ${who}: ${lineOf(thing, scene, things)}`, ids: thing.elementIds, person: !other || other.by.kind === "person", by: other && other.by.kind !== "person" ? other.by.name || "another agent" : "" });
      }
      if (clashes.size > 0) {
        const all = [...clashes.entries()];
        const listed = all.slice(0, CLASH_LINES);
        const rest = all.slice(CLASH_LINES).map(([thing]) => thing);
        // What this answer shows is now shown, as it is; what it leaves out is not, and the call that shows exactly the rest is given.
        markCanvasTold(dir, threadId, key, looksIn(scene, listed.flatMap(([, c]) => c.ids)));
        const others = [...new Set(all.map(([, c]) => c.by).filter(Boolean))];
        const ask = all.some(([, c]) => c.person)
          ? "if it would undo what the person did, ask them first"
          : `it would change what ${others.join(" and ") || "another agent"} did, so check that is wanted`;
        return refuse(
          [
            `Nothing changed. ${clashes.size === 1 ? "A thing you are changing is" : `${clashes.size} things you are changing are`} not as you were last shown ${clashes.size === 1 ? "it" : "them"}:`,
            ...listed.map(([, c]) => c.line),
            ...(rest.length > 0 ? [`  and ${rest.length} more. See exactly those first: ${readCall(threadId, { things: rest })}`] : []),
            `That stays as it is. If your change still makes sense with this in view, send it again with --base ${now0}; ${ask}.`,
          ].join("\n"),
          now0,
        );
      }
    }
    const heard = key ? sinceLines(log, readCanvasMeta(dir, threadId).seen[key] ?? (base as number), viewer) : null;
    const committed = commitCanvas(dir, threadId, result.scene, viewer, new Date(now()));
    // What this change replaced, so the person can take it back with one press (the window's Undo).
    if (committed.entry) {
      writeCanvasUndo(dir, threadId, {
        rev: committed.rev,
        before: scene.elements.filter((e) => result.touched.has(e.id)),
        added: [...result.added],
        after: Object.fromEntries(looksIn(result.scene, result.added)),
        left: result.scene.elements.filter((e) => result.touched.has(e.id)),
      });
    }
    if (key) {
      // Its own change is what it now knows of the things it named and made. A thing that only followed along (an
      // arrow rerouted, a frame that grew) stays known if it was known as it was before.
      const before = readCanvasTold(dir, threadId)[key];
      const was = new Map(scene.elements.map((e) => [e.id, e]));
      const followed = [...result.touched].filter((id) => !result.direct.has(id) && was.has(id) && before?.[id] === lookOf(was.get(id)!));
      markCanvasTold(dir, threadId, key, looksIn(result.scene, [...result.added, ...result.direct, ...followed]));
      if (heard) {
        showListed(threadId, key, result.scene, thingsOf(result.scene), heard.byElement);
        noteCanvasSeen(dir, threadId, key, heard.cut ? heard.through : committed.rev);
      }
    }
    emit("canvas", { thread_id: threadId, rev: committed.rev, by: viewer.name || "An agent", elements: [...result.added, ...result.touched] });
    const others = heard
      ? [
          ...undoneLines(heard.undone),
          ...(heard.lines.length > 0 ? ["Changed by others since you last looked, not touched by you:", ...heard.lines] : []),
          ...(heard.cut ? [`  More changed after rev ${heard.through}. For the rest: ${readCall(threadId)}`] : []),
        ]
      : [];
    const done = result.done.length > ANSWER_LINES ? [...result.done.slice(0, ANSWER_LINES), `and ${result.done.length - ANSWER_LINES} more changes, all made. To see them: ${readCall(threadId)}`] : result.done;
    return {
      ok: true,
      rev: committed.rev,
      text: [...others, `Done: the canvas is now rev ${committed.rev}. The person sees it on the canvas; nothing was sent to them.`, ...done.map((line) => `  ${line}`)].join("\n"),
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

  /** What a reply being built lists, until the reply is stored (a reply that fails leaves an entry; a few at most are kept). */
  const replyLooks = new Map<string, [string, string][]>();
  const replySketch: InboxCanvas["replySketch"] = (threadId, raw) => {
    for (const old of [...replyLooks.keys()].slice(0, Math.max(0, replyLooks.size - 20))) replyLooks.delete(old);
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
    // A selection: also what its things are joined to, one step out (the arrows that touch them and the things at
    // those arrows' other ends). "Move this behind the queue" names a thing that was not picked; listed here, it is
    // shown too, and the first change lands without a read.
    const shown = [...reading.shown];
    if (kind === "selection") {
      const byId = new Map(things.map((t) => [t.id, t]));
      const joined = new Map<string, Thing>();
      for (const arrow of things) {
        if (arrow.kind !== "arrow" && arrow.kind !== "line") continue;
        const ends = [arrow.from?.id, arrow.to?.id].filter((id): id is string => !!id);
        if (!only.has(arrow.id) && !ends.some((id) => only.has(id))) continue;
        for (const id of [arrow.id, ...ends]) {
          const thing = byId.get(id);
          if (thing && !only.has(id)) joined.set(id, thing);
        }
      }
      const extra = [...joined.values()].slice(0, 40);
      if (extra.length > 0) {
        lines.push("Connected, not selected:");
        for (const thing of extra) lines.push(`  ${lineOf(thing, scene, things)}`);
        shown.push(...extra);
      }
      // Everything else, by kind, id and words only: "behind the queue" may name a thing two steps away, and an agent
      // that cannot see it draws a second one. Enough to connect to or stand beside; a change to one of these still
      // needs it shown in full (a read, or the refusal that shows it).
      const listed = new Set([...only, ...extra.map((x) => x.id)]);
      const rest = things.filter((x) => !listed.has(x.id) && ((x.kind !== "arrow" && x.kind !== "line") || x.words));
      if (rest.length > 0) {
        const brief = (x: Thing) => `${x.kind} ${x.id}${x.words ? ` ${JSON.stringify(Array.from(x.words).length > 40 ? `${Array.from(x.words).slice(0, 39).join("")}…` : x.words)}` : ""}`;
        const more = rest.length > 40 ? `; and ${rest.length - 40} more: canvas ${JSON.stringify({ thread_id: threadId })}` : "";
        lines.push(`Also on the canvas: ${rest.slice(0, 40).map(brief).join("; ")}${more}`);
      }
    }
    // What the reply lists, as it looks now: shown to the session the reply goes to, once the reply is stored (`replyShown`).
    const looks = looksIn(scene, shown.flatMap((t) => t.elementIds));
    const sketch: InboxReplySketch = { kind, rev: readCanvasMeta(dir, threadId).rev, things: [...only], reading: lines.join("\n") };
    replyLooks.set(`${threadId}\n${sketch.rev}\n${sketch.reading}`, looks);
    return sketch;
  };

  const replyShown: InboxCanvas["replyShown"] = (threadId, sketch, session) => {
    const at = `${threadId}\n${sketch.rev}\n${sketch.reading}`;
    const looks = replyLooks.get(at);
    replyLooks.delete(at);
    if (looks && isCanvasSession(session)) markCanvasTold(dir, threadId, session, looks);
  };

  return {
    read,
    apply,
    replySketch,
    replyShown,
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
      const fileMatch = /^\/api\/inbox\/threads\/([A-Za-z0-9_]+)\/canvas\/files\/([A-Za-z0-9_-]+)$/.exec(path);
      if (fileMatch) {
        // One picture's file, for a window that holds the element but not its bytes (an agent's change or an Undo brought it back).
        if (req.method !== "GET") return json({ error: "Use GET." }, 405);
        const root = store.message(fileMatch[1]!)?.thread_id;
        const file = root ? readCanvasFile(dir, root, fileMatch[2]!) : null;
        return file ? json({ file }) : json({ error: "No such file.", code: "not_found" }, 404);
      }
      const match = /^\/api\/inbox\/threads\/([A-Za-z0-9_]+)\/canvas(\/picture|\/undo|\/files)?$/.exec(path);
      if (!match) return null;
      const message = store.message(match[1]!);
      if (!message) return json({ error: `No thread ${match[1]}.`, code: "thread_not_found" }, 404);
      const threadId = message.thread_id;
      if (match[2] === "/files") {
        // Pictures' files ahead of the save that names them: a window on a linked computer sends them now, while this
        // computer answers, so the save itself (small, and perhaps held in that computer's outbox) carries none.
        if (req.method !== "POST") return json({ error: "Use POST." }, 405);
        let files: unknown;
        try {
          files = (JSON.parse(new TextDecoder().decode(await rawBody(req, SCENE_MAX_BYTES))) as { files?: unknown }).files;
        } catch {
          return json({ error: "body: expected { files } no larger than a canvas may be.", code: "validation_error" }, 413);
        }
        if (!files || typeof files !== "object" || Array.isArray(files)) return json({ error: "files: expected an object of pictures by id.", code: "validation_error" }, 422);
        writeCanvasFiles(dir, threadId, files as Record<string, unknown>);
        return json({ ok: true });
      }
      if (match[2] === "/undo") {
        // The person takes back one change an agent made: each thing it changed goes back to what it was, what it
        // added goes, and whatever the person did since to other things stays.
        if (req.method !== "POST") return json({ error: "Use POST." }, 405);
        const body = await options.readBody(req);
        const mismatch = options.sessionMismatch(body);
        if (mismatch) return mismatch;
        const undo = Number.isInteger(body.rev) ? readCanvasUndo(dir, threadId, body.rev as number) : null;
        const stored = readCanvasScene(dir, threadId, false);
        // Taken back already (a second press, another window), or too old to take back: nothing happens, and it says so.
        if (!undo) return json({ serverSession: options.serverSession, rev: readCanvasMeta(dir, threadId).rev, already: true, kept: [], scene: stored });
        const was = new Map(undo.before.map((e) => [e.id, e]));
        const added = new Set(undo.added);
        // What each element came to: back as it was, part of it back, none of it (the person's), or removed.
        const fate = new Map<string, "back" | "part" | "kept" | "gone">();
        const stamp = (e: CanvasElement, current: CanvasElement) => ({ ...e, version: (current.version ?? 1) + 1, versionNonce: Math.floor(Math.random() * 2 ** 31), updated: now() });
        // Field by field: what the change made of a thing goes back only where it is still what the change made it.
        // A thing the person moved keeps its place and still loses the agent's colour; one they rewrote keeps their
        // words; one they deleted stays deleted. What the agent added goes only if nobody touched it.
        const left = new Map(undo.left.map((e) => [e.id, e]));
        const FIELDS = ["x", "y", "width", "height", "text", "originalText", "strokeColor", "backgroundColor", "frameId", "containerId", "name", "points", "isDeleted", "startBinding", "endBinding", "boundElements"] as const;
        // What only follows along (who is tied to whom) is not something a person "kept".
        const QUIET = new Set<string>(["boundElements", "startBinding", "endBinding"]);
        const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
        const byStored = new Map(stored.elements.map((e) => [e.id, e]));
        // A shape and its label are one thing: what the agent added goes only when neither was touched since.
        const unitOf = (e: CanvasElement) => (e.type === "text" && e.containerId && added.has(e.containerId) && !byStored.get(e.containerId)?.isDeleted ? e.containerId : e.id);
        const touchedUnits = new Set<string>();
        for (const e of stored.elements) if (added.has(e.id) && !e.isDeleted && lookOf(e) !== undo.after[e.id]) touchedUnits.add(unitOf(e));
        const elements = stored.elements.map((e) => {
          const before = was.get(e.id);
          const after = left.get(e.id);
          if (before && after) {
            // Deleted by the person since: theirs to decide; it stays gone.
            if (e.isDeleted && !after.isDeleted) {
              fate.set(e.id, "kept");
              return e;
            }
            // A label's place and size are the editor's (it wraps the words to the shape and centres them): they
            // follow the shape and are never put back on their own. Its words are judged as written (`originalText`).
            const label = e.type === "text" && !!e.containerId;
            const made = FIELDS.filter((f) => !same(before[f], after[f]) && !(label && (f === "x" || f === "y")));
            const words = (el: CanvasElement) => el.originalText ?? el.text;
            const still = (f: string) => (label && (f === "text" || f === "width" || f === "height") ? same(words(e), words(after)) : same(e[f], after[f]));
            const back = made.filter(still);
            const loud = made.filter((f) => !QUIET.has(f) && !(label && (f === "width" || f === "height")));
            const loudBack = loud.filter((f) => back.includes(f));
            if (loud.length > 0) fate.set(e.id, loudBack.length === loud.length ? "back" : loudBack.length === 0 ? "kept" : "part");
            if (back.length === 0) return e;
            return stamp({ ...e, ...Object.fromEntries(back.map((f) => [f, before[f]])) } as CanvasElement, e);
          }
          if (!added.has(e.id) || e.isDeleted) return e;
          if (touchedUnits.has(unitOf(e))) {
            fate.set(e.id, "kept");
            return e;
          }
          fate.set(e.id, "gone");
          return stamp({ ...e, isDeleted: true }, e);
        });
        const next = { ...stored, elements };
        // Said by thing, as a person would name it: its kind and its words (as they are after the Undo; as they were, for what was removed).
        const namesIn = (scene: CanvasScene) => {
          const map = new Map<string, { id: string; name: string }>();
          for (const t of thingsOf(scene)) for (const id of t.elementIds) map.set(id, { id: t.id, name: `${t.kind}${t.words ? ` ${JSON.stringify(Array.from(t.words).slice(0, 40).join(""))}` : ""}` });
          return map;
        };
        const nowNames = namesIn(next);
        const oldNames = namesIn(stored);
        const perThing = new Map<string, { name: string; fates: Set<string> }>();
        for (const [id, f] of fate) {
          const named = (f === "gone" ? oldNames.get(id) : nowNames.get(id)) ?? oldNames.get(id);
          if (!named) continue;
          const entry = perThing.get(named.id) ?? { name: named.name, fates: new Set<string>() };
          entry.fates.add(f);
          perThing.set(named.id, entry);
        }
        const undone: CanvasUndone = { back: [], part: [], kept: [], gone: [] };
        for (const { name, fates } of perThing.values()) {
          if (fates.has("gone") && fates.size === 1) undone.gone.push(name);
          else if (fates.has("part") || (fates.has("kept") && (fates.has("back") || fates.has("gone")))) undone.part.push(name);
          else if (fates.has("kept")) undone.kept.push(name);
          else undone.back.push(name);
        }
        const committed = commitCanvas(dir, threadId, next, { kind: "person" }, new Date(now()), { undid: undo.rev, undone });
        removeCanvasUndo(dir, threadId, undo.rev);
        const kept = [...undone.part, ...undone.kept];
        emit("canvas", { thread_id: threadId, rev: committed.rev, by: null, window: typeof body.window === "string" ? body.window : null, elements: [] });
        return json({ serverSession: options.serverSession, rev: committed.rev, kept: kept.slice(0, 8), kept_count: kept.length, scene: readCanvasScene(dir, threadId, false) });
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
        // The first read carries the pictures' files; a read after a change (`since`) does not: the window holds
        // them already and asks for one it lacks by id (`…/canvas/files/<id>`).
        const scene = readCanvasScene(dir, threadId, !url.searchParams.has("since"));
        // What changed after a revision, for the window's "what changed" line.
        const changes = url.searchParams.has("since") && Number.isInteger(since) ? readCanvasLog(dir, threadId).filter((entry) => entry.rev > since) : [];
        return json({ serverSession: options.serverSession, rev: meta.rev, scene, changes });
      }
      if (req.method !== "POST") return json({ error: "Use GET or POST." }, 405);
      const length = Number(req.headers.get("content-length") ?? "0");
      if (length > SCENE_MAX_BYTES) return json({ error: "This canvas is too large to save.", code: "validation_error" }, 413);
      // The window sends its saves compressed (a scene is repetitive JSON: about a tenth), so the save made as the page
      // closes fits what a browser lets a closing page send.
      let body: Record<string, unknown>;
      if ((req.headers.get("content-encoding") ?? "").toLowerCase() === "gzip") {
        try {
          // Capped as it expands: a small body that unpacks to gigabytes is refused before it is held in memory.
          const value = JSON.parse(gunzipSync(await rawBody(req, SCENE_MAX_BYTES), { maxOutputLength: SCENE_MAX_BYTES }).toString("utf8")) as unknown;
          body = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
        } catch {
          return json({ error: "body: expected a compressed JSON object no larger than a canvas may be.", code: "validation_error" }, 413);
        }
      } else body = await options.readBody(req);
      const mismatch = options.sessionMismatch(body);
      if (mismatch) return mismatch;
      const incoming = asScene(body.scene);
      let stored = readCanvasScene(dir, threadId, false);
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
      // `partial`: only what the window changed (a linked computer's window, mergeSave).
      const partial = body.partial === true;
      const merged = mergeSave(stored, incoming, now(), partial);
      const committed = commitCanvas(dir, threadId, merged.scene, { kind: "person" }, new Date(now()));
      if (committed.rev !== before) emit("canvas", { thread_id: threadId, rev: committed.rev, by: null, window: typeof body.window === "string" ? body.window : null, elements: [] });
      // The store held things this window did not (an agent's change landed meanwhile): the window takes the merged
      // scene. A partial save names only its own changes, so what it lacks is anything after the revision it had.
      const lacks = partial ? merged.kept > 0 || (Number.isInteger(body.have) && body.have !== before) : merged.kept > 0;
      return json({ serverSession: options.serverSession, rev: committed.rev, ...(lacks && body.have !== committed.rev ? { scene: merged.scene } : {}) });
    },
    async agent(ask) {
      const threadId = threadOf(ask.thread_id ?? "");
      const session = ask.by?.session?.trim();
      const viewer: CanvasAuthor = {
        kind: "agent",
        // One line, a sane length: this name is drawn on the person's canvas.
        name: inboxAgentName({ kind: "agent", host: ask.by?.host?.trim() || null, name: inboxStoredAgentName(ask.by?.name) }).replace(/\s+/g, " ").slice(0, 60),
        ...(session ? { key: session } : {}),
      };
      if (ask.do !== undefined) {
        const result = await apply(threadId, viewer, ask.base, ask.do);
        // The window that waits for this agent's change is told when one was refused instead.
        if (!result.ok) emit("canvas", { thread_id: threadId, rev: result.rev, by: viewer.name || "An agent", refused: true, elements: [] });
        // A refusal is an error to the caller (the command's exit code): nothing changed.
        if (!result.ok) return { ok: false, code: "canvas_unchanged", text: result.text, structured: { thread_id: threadId, rev: result.rev } };
        return { ok: true, text: result.text, structured: { thread_id: threadId, rev: result.rev, changed: true } };
      }
      try {
        if (ask.picture !== undefined && ask.by?.away) {
          // A picture is a file on this computer, which an agent paired from elsewhere cannot open: said plainly, with the text it can use.
          const text = read(threadId, viewer, { in: ask.in });
          return { ok: true, text: `No picture: it would be a file on the person's computer, which you cannot open from where you run. The canvas as text:\n${text}`, structured: { thread_id: threadId, rev: readCanvasMeta(dir, threadId).rev, picture: null } };
        }
        if (ask.picture !== undefined) {
          const drawn = await picture(threadId, ask.picture);
          const text = read(threadId, viewer, { in: ask.in });
          const head = `Picture${drawn.only ? ` of ${drawn.named.slice(0, 8).join(", ")}` : " of the whole canvas"}: ${(drawn.paths ?? [drawn.path]).join(", ")}${drawn.note}`;
          return { ok: true, text: `${head}\n${text}`, structured: { thread_id: threadId, rev: readCanvasMeta(dir, threadId).rev, picture: drawn.path, ...(drawn.paths ? { pictures: drawn.paths } : {}) } };
        }
        return { ok: true, text: read(threadId, viewer, { in: ask.in, after: ask.after_thing, things: ask.things }), structured: { thread_id: threadId, rev: readCanvasMeta(dir, threadId).rev } };
      } catch (error) {
        if (error instanceof RefError) throw new InboxError("validation_error", error.message);
        throw error;
      }
    },
  };
}
