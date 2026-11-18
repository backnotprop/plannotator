/**
 * The thread canvas's store: one folder per thread under `PLANNOTATOR_DATA_DIR/canvases/<thread id>/`.
 *
 * - `canvas.json` (written atomically, small): the agent's board HTML (the source of truth for its parts), the
 *   person's standing (pins, deletions), the parts the latest layout made, the layout's state and warnings, the revs.
 * - `scene.json`: the scene (Excalidraw elements; the agent's ids kept on its elements). `laid-out.json`: the scene as
 *   the agent's latest layout left it (what read-back compares with). Kept apart so a read of the state, `pending`
 *   or the version list never parses a scene.
 * - `versions/<n>.json`: a version, the agent's or the person's, with its scene once there is one. A person's saves
 *   between two agent versions are one version, rewritten as they draw. `versions/index.json` lists them (number,
 *   author, time, parts changed, picture kept, pictures used) so the list is one small read. The newest
 *   `CANVAS_KEEP_VERSIONS` are kept (and the agent's latest, always); an older one's files and its index entry go.
 * - `files/`: pictures the agent's board names (copied in) and pictures the person pasted. One that no kept version,
 *   the scene, the board or a deleted part's HTML names is removed when a new version starts.
 * - `canvas.png` and `versions/<n>.png`: pictures the window makes, for `read --png` and a message's preview card.
 *
 * An older canvas kept everything in `canvas.json`; the first write (or `pending`) splits it.
 *
 * The agent's CLI and the Inbox server both write, so every change holds the folder's lock (`store-files`). The
 * board is laid out by a browser: an agent write leaves the layout `pending` until an Inbox window lays it out and
 * sends the result (`layoutDone`). A person's save names the `rev` it started from and is refused when stale; an
 * agent's write names the standing and agent version it built on and is refused when the person's pins or deletions
 * changed since; a layout names the rev it read and is refused when the standing changed after it.
 *
 * Scenes read from disk are untrusted: every scene read is cleaned (`@plannotator/core/canvas-elements`).
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { dropDeleted, emptyStanding, type BoardPin, type BoardStanding } from "@plannotator/core/canvas-board";
import { cleanCanvasElements } from "@plannotator/core/canvas-elements";
import { readBackLines, standingAfter, type CanvasElement, type CanvasParts } from "@plannotator/core/canvas-scene";
import { sniffImageContentType } from "../review-image";
import { readJson, withLock, writeJsonAtomic } from "../store-files";

export const CANVAS_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
/** Only these pictures are kept (by their bytes, whatever their name says): never an SVG, which can carry script. */
const RASTER = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const isRaster = (bytes: Uint8Array) => RASTER.has(sniffImageContentType(bytes) ?? "");
/** A canvas's id: a thread's root message id (a space's id later). */
export const CANVAS_ID_RE = /^msg_[0-9A-HJKMNP-TV-Z]{26}$/;
/** A person's saves within this long of the last, with no agent version between, are one version. */
const PERSON_VERSION_JOIN_MS = 10 * 60 * 1000;
/** Versions kept per canvas (the agent's latest is kept too, however old). */
export const CANVAS_KEEP_VERSIONS = 50;
/** A window reports a layout it could not make this many times, and the version is failed (no window tries again). */
export const CANVAS_LAYOUT_ATTEMPTS = 3;
/** A picture written this recently is never removed as unused: the agent's CLI copies before it writes. */
const FILE_GRACE_MS = 10 * 60 * 1000;
/** A picture's name in files/ (as the board and the scene name it). */
const FILE_NAME_RE = /^[\w][\w.-]{0,120}$/;

export interface CanvasFileRef {
  name: string;
  mimeType: string;
}

export interface CanvasScene {
  elements: CanvasElement[];
  files: Record<string, CanvasFileRef>;
}

export interface CanvasLayoutState {
  version: number;
  /** `failed`: windows could not lay it out (`warnings[0]` says why); none tries again until the agent writes. */
  state: "pending" | "done" | "failed";
  warnings: string[];
  at: string;
  /** Windows that reported they could not lay this version out. */
  attempts?: number;
  /** The laid-out scene has no live element: there is nothing to make a picture of. */
  empty?: true;
}

/** What `canvas.json` holds: everything but the scenes. */
export interface CanvasMeta {
  id: string;
  /** Bumped by every write; a person's save names the rev it started from. */
  rev: number;
  /** The rev of the last write that changed the standing (pins or deletions). */
  standingRev: number;
  /** The latest version, the agent's or the person's. */
  version: number;
  /** The agent's latest version (0: it has drawn nothing). */
  agentVersion: number;
  board: string;
  standing: BoardStanding;
  parts: CanvasParts | null;
  layout: CanvasLayoutState | null;
  png: { rev: number } | null;
  updated: string;
}

export interface CanvasState extends CanvasMeta {
  scene: CanvasScene | null;
  /** The scene as the agent's latest version was laid out: what read-back compares with. */
  laidOut: CanvasElement[] | null;
}

export interface CanvasVersion {
  n: number;
  by: "agent" | "person";
  at: string;
  /** How many of the agent's parts changed from its previous version (agent versions, once laid out). */
  changed?: number;
  /** The agent's own words for what it did (`applied:` lines), for the window's change line. */
  applied?: string[];
  scene?: CanvasScene;
}

export type CanvasVersionSummary = Omit<CanvasVersion, "scene" | "applied"> & { picture: boolean };

/** One line of `versions/index.json`. */
interface CanvasVersionEntry {
  n: number;
  by: "agent" | "person";
  at: string;
  changed?: number;
  picture?: true;
  /** The pictures (files/ names) its scene uses. */
  files: string[];
}

/** What an agent's write was built on: refused when either changed since (`agentWrite`). */
export interface CanvasBase {
  standingRev: number;
  agentVersion: number;
}

export const canvasBase = (s: CanvasMeta): CanvasBase => ({ standingRev: s.standingRev, agentVersion: s.agentVersion });

const blankMeta = (id: string): CanvasMeta => ({
  id,
  rev: 0,
  standingRev: 0,
  version: 0,
  agentVersion: 0,
  board: "",
  standing: emptyStanding(),
  parts: null,
  layout: null,
  png: null,
  updated: new Date(0).toISOString(),
});

export const blankCanvas = (id: string): CanvasState => ({ ...blankMeta(id), scene: null, laidOut: null });

export const canvasesDirOf = (dataDir: string): string => join(dataDir, "canvases");

export type CanvasPersonSave =
  | { ok: true; rev: number; version: number; deleted: string[] }
  | { ok: false; code: "stale_base"; message: string; rev: number };

export type CanvasAgentWrite = { ok: true; state: CanvasMeta } | { ok: false; code: "stale_standing"; message: string };

export type CanvasLayoutSave = { ok: true; rev: number } | { ok: false; code: "stale_layout"; message: string };

export type CanvasLayoutFailure = { ok: true; state: "pending" | "failed"; attempts: number } | { ok: false; code: "stale_layout"; message: string };

export interface CanvasStore {
  dir: string;
  folder(id: string): string;
  /** The state with its scenes (cleaned). */
  get(id: string): CanvasState;
  /** The state without its scenes: one small read. */
  meta(id: string): CanvasMeta;
  exists(id: string): boolean;
  locked(id: string): boolean;
  /** Copy a picture the board names into files/; its name there, or the reason it cannot be used. */
  copyPicture(id: string, path: string): { ok: true; name: string } | { ok: false; error: string };
  agentWrite(id: string, input: { base: CanvasBase; board: string; pins: Record<string, BoardPin>; applied?: string[] }): CanvasAgentWrite;
  /** `rev`: the canvas's rev the window read before it laid the board out. */
  layoutDone(id: string, input: { version: number; rev: number; elements: CanvasElement[]; files: Record<string, CanvasFileRef>; warnings: string[]; parts: CanvasParts; changed: number }): CanvasLayoutSave;
  /** A window could not lay the waiting version out; the `CANVAS_LAYOUT_ATTEMPTS`th report fails it. */
  layoutFailed(id: string, input: { version: number; error: string }): CanvasLayoutFailure;
  personSave(id: string, input: { base: number; elements: CanvasElement[]; files: Record<string, CanvasFileRef>; uploads?: Record<string, { mimeType: string; bytes: Uint8Array }> }): CanvasPersonSave;
  savePicture(id: string, input: { rev: number; version?: number; bytes: Uint8Array }): boolean;
  versions(id: string): CanvasVersionSummary[];
  version(id: string, n: number): CanvasVersion | null;
  /** Canvases whose agent version waits for a window to lay it out, or to make its picture. */
  pending(): { id: string; version: number; picture?: true }[];
  filePath(id: string, name: string): string | null;
  picturePath(id: string, n?: number): string | null;
  /** What the person did since the agent's latest version, one line each. */
  readBack(id: string): string[];
  /** A cheap fingerprint per canvas, for the window's change events. */
  fingerprints(): Map<string, string>;
  /** Remove a canvas's folder (its thread was deleted). */
  remove(id: string): void;
}

const ensureDir = (dir: string) => mkdirSync(dir, { recursive: true, mode: 0o700 });

/** A scene's picture refs, kept only where the name is one files/ can hold (an untrusted read drops the rest). */
export function cleanCanvasFileRefs(input: unknown): Record<string, CanvasFileRef> {
  const out: Record<string, CanvasFileRef> = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return out;
  for (const [id, v] of Object.entries(input as Record<string, unknown>)) {
    const f = v as { name?: unknown; mimeType?: unknown } | null;
    if (f && typeof f.name === "string" && FILE_NAME_RE.test(f.name) && typeof f.mimeType === "string") out[id] = { name: f.name, mimeType: f.mimeType };
  }
  return out;
}

const cleanScene = (raw: unknown): CanvasScene | null => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const s = raw as { elements?: unknown; files?: unknown };
  return { elements: cleanCanvasElements(s.elements, false) ?? [], files: cleanCanvasFileRefs(s.files) };
};

const fileNames = (files: Record<string, CanvasFileRef> | undefined): string[] => [...new Set(Object.values(files ?? {}).map((f) => f.name))];
const samePins = (a: Record<string, BoardPin>, b: Record<string, BoardPin>) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
const boardFiles = (html: string): string[] => [...html.matchAll(/src="files\/([^"]+)"/g)].map((m) => m[1]!);

export function createCanvasStore(options: { dataDir: string; now?: () => number }): CanvasStore {
  const dir = canvasesDirOf(options.dataDir);
  const now = options.now ?? Date.now;
  const iso = () => new Date(now()).toISOString();

  const folder = (id: string) => {
    if (!CANVAS_ID_RE.test(id)) throw new Error(`canvas store: "${id}" is not a canvas id`);
    return join(dir, id);
  };
  const stateFile = (id: string) => join(folder(id), "canvas.json");
  const sceneFile = (id: string) => join(folder(id), "scene.json");
  const laidOutFile = (id: string) => join(folder(id), "laid-out.json");
  const versionsDir = (id: string) => join(folder(id), "versions");
  const versionFile = (id: string, n: number) => join(versionsDir(id), `${n}.json`);
  const indexFile = (id: string) => join(versionsDir(id), "index.json");

  const readRaw = (id: string) => readJson<Record<string, unknown>>(stateFile(id));
  /** An older canvas: its scenes are in canvas.json. */
  const isLegacy = (raw: Record<string, unknown> | null): raw is Record<string, unknown> => !!raw && ("scene" in raw || "laidOut" in raw);
  const metaOf = (id: string, raw: Record<string, unknown> | null): CanvasMeta => {
    if (!raw || raw.id !== id) return blankMeta(id);
    const { scene: _scene, laidOut: _laidOut, ...rest } = raw;
    return { ...blankMeta(id), ...(rest as Partial<CanvasMeta>) };
  };
  const meta = (id: string): CanvasMeta => metaOf(id, readRaw(id));

  const loadScene = (id: string): CanvasScene | null => {
    if (existsSync(sceneFile(id))) return cleanScene(readJson(sceneFile(id)));
    const raw = readRaw(id);
    return isLegacy(raw) ? cleanScene(raw.scene) : null;
  };
  const loadLaidOut = (id: string): CanvasElement[] | null => {
    let raw: unknown = null;
    if (existsSync(laidOutFile(id))) raw = readJson(laidOutFile(id));
    else {
      const legacy = readRaw(id);
      if (isLegacy(legacy)) raw = legacy.laidOut;
    }
    return Array.isArray(raw) ? (cleanCanvasElements(raw, false) ?? []) : null;
  };

  const readVersion = (id: string, n: number): CanvasVersion | null => {
    if (!Number.isInteger(n) || n < 1) return null;
    const v = readJson<CanvasVersion>(versionFile(id, n));
    if (!v || v.n !== n) return null;
    const { scene, ...rest } = v;
    const clean = scene ? cleanScene(scene) : null;
    return clean ? { ...rest, scene: clean } : rest;
  };
  const writeVersion = (id: string, v: CanvasVersion) => {
    ensureDir(versionsDir(id));
    writeJsonAtomic(versionFile(id, v.n), v);
  };

  /** The index as an older canvas would have it: every version file read once. */
  const buildIndex = (id: string, upTo: number): CanvasVersionEntry[] => {
    const out: CanvasVersionEntry[] = [];
    for (let n = 1; n <= upTo; n++) {
      const v = readJson<CanvasVersion>(versionFile(id, n));
      if (!v || v.n !== n) continue;
      out.push({
        n,
        by: v.by,
        at: v.at,
        ...(typeof v.changed === "number" ? { changed: v.changed } : {}),
        ...(existsSync(join(versionsDir(id), `${n}.png`)) ? { picture: true as const } : {}),
        files: fileNames(v.scene?.files),
      });
    }
    return out;
  };
  const readIndex = (id: string, upTo: number): CanvasVersionEntry[] => {
    const index = readJson<CanvasVersionEntry[]>(indexFile(id));
    return Array.isArray(index) ? index : buildIndex(id, upTo);
  };
  const putEntry = (id: string, index: CanvasVersionEntry[], entry: CanvasVersionEntry): CanvasVersionEntry[] => {
    const next = [...index.filter((e) => e.n !== entry.n), entry].sort((a, b) => a.n - b.n);
    ensureDir(versionsDir(id));
    writeJsonAtomic(indexFile(id), next);
    return next;
  };

  /** Under the lock: an older canvas's scenes move out of canvas.json, and its version index is written. */
  const migrate = (id: string) => {
    const raw = readRaw(id);
    if (isLegacy(raw)) {
      if (raw.scene) writeJsonAtomic(sceneFile(id), raw.scene);
      if (raw.laidOut) writeJsonAtomic(laidOutFile(id), raw.laidOut);
      writeJsonAtomic(stateFile(id), metaOf(id, raw));
    }
    if (!existsSync(indexFile(id)) && existsSync(versionsDir(id))) {
      writeJsonAtomic(indexFile(id), buildIndex(id, metaOf(id, raw).version));
    }
  };

  const locked = <T>(id: string, fn: () => T): T => {
    ensureDir(folder(id));
    return withLock(
      folder(id),
      () => {
        migrate(id);
        return fn();
      },
      "canvas store",
    );
  };

  /**
   * Under the lock, as a new version starts: versions past the newest `CANVAS_KEEP_VERSIONS` go (files and index
   * entry; the agent's latest stays), then every picture in files/ nothing names any more.
   */
  const prune = (id: string, s: CanvasMeta, index: CanvasVersionEntry[], scene: CanvasScene | null) => {
    let kept = index;
    if (index.length > CANVAS_KEEP_VERSIONS) {
      const keep = new Set(index.slice(-CANVAS_KEEP_VERSIONS).map((e) => e.n));
      keep.add(s.agentVersion);
      for (const e of index) {
        if (keep.has(e.n)) continue;
        rmSync(versionFile(id, e.n), { force: true });
        rmSync(join(versionsDir(id), `${e.n}.png`), { force: true });
      }
      kept = index.filter((e) => keep.has(e.n));
      writeJsonAtomic(indexFile(id), kept);
    }
    const used = new Set<string>([...kept.flatMap((e) => e.files), ...fileNames(scene?.files), ...boardFiles(s.board), ...Object.values(s.standing.deletedHtml).flatMap(boardFiles)]);
    const files = join(folder(id), "files");
    let names: string[];
    try {
      names = readdirSync(files);
    } catch {
      return;
    }
    const cutoff = Date.now() - FILE_GRACE_MS;
    for (const name of names) {
      if (used.has(name)) continue;
      try {
        const st = statSync(join(files, name));
        if (st.isFile() && st.mtimeMs < cutoff) rmSync(join(files, name), { force: true });
      } catch {
        // gone already
      }
    }
  };

  function copyPicture(id: string, path: string): { ok: true; name: string } | { ok: false; error: string } {
    if (!isAbsolute(path)) return { ok: false, error: `picture path must be absolute: ${path}` };
    let real: string;
    let size: number;
    try {
      const st = statSync(path);
      if (!st.isFile()) throw new Error("not a file");
      real = realpathSync(path);
      size = st.size;
    } catch {
      return { ok: false, error: `picture file not found: ${path}` };
    }
    if (!IMAGE_EXT.has(extname(real).toLowerCase())) return { ok: false, error: `${path} is not a png, jpg, gif or webp picture` };
    if (size > CANVAS_IMAGE_MAX_BYTES) return { ok: false, error: `${path} is ${size} bytes; a picture is at most ${CANVAS_IMAGE_MAX_BYTES}` };
    const bytes = readFileSync(real);
    if (!isRaster(bytes)) return { ok: false, error: `${path} is not a png, jpg, gif or webp picture` };
    const name = `${createHash("sha256").update(bytes).digest("hex").slice(0, 10)}-${basename(real).replace(/[^\w.-]+/g, "_")}`;
    const files = join(folder(id), "files");
    ensureDir(files);
    const dest = join(files, name);
    // Kept or touched: a picture the agent is about to name is never removed as unused before its write lands.
    if (!existsSync(dest)) copyFileSync(real, dest);
    else {
      const t = new Date();
      utimesSync(dest, t, t);
    }
    return { ok: true, name };
  }

  function filePath(id: string, name: string): string | null {
    if (!CANVAS_ID_RE.test(id)) return null;
    const rel = name.replace(/^files\//, "");
    if (!rel || rel.includes("/") || rel.includes("\\") || rel.startsWith(".")) return null;
    const files = join(folder(id), "files");
    try {
      const real = realpathSync(join(files, rel));
      if (dirname(real) !== realpathSync(files) || !statSync(real).isFile()) return null;
      return real;
    } catch {
      return null;
    }
  }

  return {
    dir,
    folder,
    get: (id) => ({ ...meta(id), scene: loadScene(id), laidOut: loadLaidOut(id) }),
    meta,
    exists: (id) => CANVAS_ID_RE.test(id) && existsSync(stateFile(id)),
    locked: (id) => CANVAS_ID_RE.test(id) && existsSync(join(folder(id), ".lock")),
    copyPicture,

    agentWrite(id, input) {
      return locked(id, () => {
        const s = meta(id);
        if (s.standingRev !== input.base.standingRev || s.agentVersion !== input.base.agentVersion) {
          return { ok: false, code: "stale_standing", message: "the person changed the canvas's pins or deletions, or another version was written, since this write read it" };
        }
        const n = s.version + 1;
        const rev = s.rev + 1;
        const next: CanvasMeta = {
          ...s,
          rev,
          standingRev: samePins(s.standing.pins, input.pins) ? s.standingRev : rev,
          version: n,
          agentVersion: n,
          board: input.board,
          standing: { ...s.standing, pins: input.pins },
          layout: { version: n, state: "pending", warnings: [], at: iso() },
          updated: iso(),
        };
        writeVersion(id, { n, by: "agent", at: iso(), applied: input.applied ?? [] });
        const index = putEntry(id, readIndex(id, s.version), { n, by: "agent", at: iso(), files: [] });
        prune(id, next, index, loadScene(id));
        writeJsonAtomic(stateFile(id), next);
        return { ok: true, state: next };
      });
    },

    layoutDone(id, input) {
      return locked(id, () => {
        const s = meta(id);
        if (!s.layout || s.layout.version !== input.version || s.agentVersion !== input.version) {
          return { ok: false, code: "stale_layout", message: `version ${input.version} is not the one waiting to be laid out` };
        }
        if (s.layout.state === "done") return { ok: false, code: "stale_layout", message: `version ${input.version} is laid out already` };
        if (input.rev < s.standingRev) {
          return { ok: false, code: "stale_layout", message: `the person's pins or deletions changed at rev ${s.standingRev}, after rev ${input.rev} this layout read; lay it out again` };
        }
        const was = loadScene(id);
        // The person's own elements stay as they are; the agent's are the new layout's.
        const mine = (was?.elements ?? []).filter((e) => !(e.customData && typeof e.customData.part === "string" && (e.id === e.customData.part || e.id.startsWith(`${e.customData.part}~`))));
        const elements = [...input.elements, ...mine];
        const files: Record<string, CanvasFileRef> = {};
        for (const el of elements) if (el.type === "image" && el.fileId && !el.isDeleted) {
          const ref = input.files[el.fileId] ?? was?.files[el.fileId];
          if (ref) files[el.fileId] = ref;
        }
        const scene: CanvasScene = { elements, files };
        const v = readVersion(id, input.version);
        writeVersion(id, { n: input.version, by: "agent", at: v?.at ?? iso(), applied: v?.applied ?? [], changed: input.changed, scene });
        const index = readIndex(id, s.version);
        const entry = index.find((e) => e.n === input.version);
        putEntry(id, index, { ...(entry ?? { n: input.version, by: "agent" as const, at: v?.at ?? iso() }), files: fileNames(files), changed: input.changed });
        writeJsonAtomic(sceneFile(id), scene);
        writeJsonAtomic(laidOutFile(id), elements);
        const empty = !elements.some((e) => !e.isDeleted);
        const next: CanvasMeta = {
          ...s,
          rev: s.rev + 1,
          parts: input.parts,
          layout: { version: input.version, state: "done", warnings: input.warnings, at: iso(), ...(empty ? { empty: true as const } : {}) },
          updated: iso(),
        };
        writeJsonAtomic(stateFile(id), next);
        return { ok: true, rev: next.rev };
      });
    },

    layoutFailed(id, input) {
      return locked(id, () => {
        const s = meta(id);
        if (!s.layout || s.layout.version !== input.version || s.agentVersion !== input.version || s.layout.state !== "pending") {
          return { ok: false, code: "stale_layout", message: `version ${input.version} is not the one waiting to be laid out` };
        }
        const attempts = (s.layout.attempts ?? 0) + 1;
        const failed = attempts >= CANVAS_LAYOUT_ATTEMPTS;
        const layout: CanvasLayoutState = failed
          ? { version: input.version, state: "failed", warnings: [input.error], at: iso(), attempts }
          : { ...s.layout, attempts };
        writeJsonAtomic(stateFile(id), { ...s, layout, updated: iso() });
        return { ok: true, state: failed ? "failed" : "pending", attempts };
      });
    },

    personSave(id, input) {
      return locked(id, () => {
        const s = meta(id);
        if (input.base !== s.rev) {
          return { ok: false, code: "stale_base", message: `the canvas is at rev ${s.rev}, not ${input.base}: it changed since. Load it again.`, rev: s.rev };
        }
        if (input.uploads) {
          const files = join(folder(id), "files");
          ensureDir(files);
          for (const [fileId, up] of Object.entries(input.uploads)) {
            const ref = input.files[fileId];
            if (!ref || !FILE_NAME_RE.test(ref.name)) continue;
            if (up.bytes.byteLength > CANVAS_IMAGE_MAX_BYTES || !isRaster(up.bytes)) continue;
            const dest = join(files, ref.name);
            if (!existsSync(dest)) writeFileSync(dest, up.bytes, { mode: 0o600 });
          }
        }
        const rev = s.rev + 1;
        let standing = s.standing;
        let board = s.board;
        let deleted: string[] = [];
        const laidOut = s.parts ? loadLaidOut(id) : null;
        if (s.parts && laidOut) {
          const after = standingAfter(laidOut, input.elements, s.parts, s.standing);
          deleted = after.newlyDeleted;
          const dropped = deleted.length ? dropDeleted(board, deleted) : { html: board, was: {} };
          board = dropped.html;
          standing = {
            pins: after.pins,
            deleted: [...s.standing.deleted, ...deleted],
            deletedHtml: { ...s.standing.deletedHtml, ...dropped.was },
          };
        }
        const standingRev = deleted.length || !samePins(s.standing.pins, standing.pins) ? rev : s.standingRev;
        const scene: CanvasScene = { elements: input.elements, files: input.files };
        const index = readIndex(id, s.version);
        const last = index.find((e) => e.n === s.version);
        const join_ = last?.by === "person" && now() - Date.parse(last.at) < PERSON_VERSION_JOIN_MS;
        const n = join_ ? s.version : s.version + 1;
        const at = join_ && last ? last.at : iso();
        writeVersion(id, { n, by: "person", at, scene });
        const next: CanvasMeta = { ...s, rev, standingRev, version: n, board, standing, updated: iso() };
        const kept = putEntry(id, index, { n, by: "person", at, files: fileNames(input.files) });
        writeJsonAtomic(sceneFile(id), scene);
        if (!join_) prune(id, next, kept, scene);
        writeJsonAtomic(stateFile(id), next);
        return { ok: true, rev, version: n, deleted };
      });
    },

    savePicture(id, input) {
      if (!isRaster(input.bytes) || input.bytes.byteLength > CANVAS_IMAGE_MAX_BYTES) return false;
      return locked(id, () => {
        const s = meta(id);
        if (input.rev < (s.png?.rev ?? -1)) return false;
        const index = input.version ? readIndex(id, s.version) : [];
        const entry = input.version ? index.find((e) => e.n === input.version) : undefined;
        if (input.version && !entry) return false;
        writeFileSync(join(folder(id), "canvas.png"), input.bytes, { mode: 0o600 });
        if (input.version && entry) {
          ensureDir(versionsDir(id));
          writeFileSync(join(versionsDir(id), `${input.version}.png`), input.bytes, { mode: 0o600 });
          putEntry(id, index, { ...entry, picture: true });
        }
        writeJsonAtomic(stateFile(id), { ...s, png: { rev: input.rev } });
        return true;
      });
    },

    versions(id) {
      return readIndex(id, meta(id).version).map((e) => ({ n: e.n, by: e.by, at: e.at, ...(e.changed !== undefined ? { changed: e.changed } : {}), picture: e.picture === true }));
    },
    version: (id, n) => readVersion(id, n),

    pending() {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        return [];
      }
      const out: { id: string; version: number; picture?: true }[] = [];
      for (const name of names) {
        if (!CANVAS_ID_RE.test(name)) continue;
        let raw = readRaw(name);
        if (isLegacy(raw)) {
          // Once per older canvas: its scenes move out, so the next look reads only the small state.
          try {
            locked(name, () => undefined);
          } catch {
            // busy: read it whole this once
          }
          raw = readRaw(name);
        }
        const layout = metaOf(name, raw).layout;
        if (layout?.state === "pending") out.push({ id: name, version: layout.version });
        // Laid out, but the window that did it closed before its picture was kept: the next window draws it.
        else if (layout?.state === "done" && !layout.empty && !existsSync(join(folder(name), "versions", `${layout.version}.png`))) out.push({ id: name, version: layout.version, picture: true });
      }
      return out;
    },

    filePath,
    picturePath(id, n) {
      if (!CANVAS_ID_RE.test(id)) return null;
      const p = n ? join(versionsDir(id), `${n}.png`) : join(folder(id), "canvas.png");
      return existsSync(p) ? p : null;
    },

    readBack(id) {
      const s = meta(id);
      const scene = loadScene(id);
      if (!scene) return [];
      const files = scene.files;
      return readBackLines({
        laidOut: loadLaidOut(id) ?? [],
        now: scene.elements,
        parts: s.parts ?? {},
        fileName: (fileId) => {
          const ref = files[fileId];
          return ref ? (filePath(id, ref.name) ?? resolve(folder(id), "files", ref.name)) : null;
        },
      });
    },

    fingerprints() {
      const out = new Map<string, string>();
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        return out;
      }
      for (const name of names) {
        if (!CANVAS_ID_RE.test(name)) continue;
        try {
          const st = statSync(join(dir, name, "canvas.json"));
          out.set(name, `${st.mtimeMs}:${st.size}`);
        } catch {
          // no state yet
        }
      }
      return out;
    },

    remove(id) {
      if (!CANVAS_ID_RE.test(id) || !existsSync(folder(id))) return;
      withLock(folder(id), () => rmSync(folder(id), { recursive: true, force: true }), "canvas store");
    },
  };
}

/** Remove the canvas of every thread that is gone (`alive` false): a thread's or a project's delete. */
export function removeGoneCanvases(dataDir: string, alive: (threadId: string) => boolean): string[] {
  let names: string[];
  try {
    names = readdirSync(canvasesDirOf(dataDir));
  } catch {
    return [];
  }
  const gone = names.filter((name) => CANVAS_ID_RE.test(name) && !alive(name));
  if (!gone.length) return [];
  const store = createCanvasStore({ dataDir });
  for (const id of gone) {
    try {
      store.remove(id);
    } catch {
      // busy: the next delete tries again
    }
  }
  return gone;
}

/** The windows that can lay a board out: the Inbox server writes it, the CLI reads it to know whether to wait. */
export const CANVAS_WINDOWS_FILE = ".windows.json";

export function writeCanvasWindows(dataDir: string, count: number, pid = process.pid): void {
  const d = canvasesDirOf(dataDir);
  ensureDir(d);
  writeJsonAtomic(join(d, CANVAS_WINDOWS_FILE), { count, pid, at: new Date().toISOString() });
}

/** True when an Inbox server says a window is open, and that server is still running. */
export function canvasWindowOpen(dataDir: string, alive: (pid: number) => boolean): boolean {
  const w = readJson<{ count?: unknown; pid?: unknown }>(join(canvasesDirOf(dataDir), CANVAS_WINDOWS_FILE));
  return !!w && typeof w.count === "number" && w.count > 0 && typeof w.pid === "number" && alive(w.pid);
}
