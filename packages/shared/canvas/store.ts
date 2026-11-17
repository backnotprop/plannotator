/**
 * The thread canvas's store: one folder per thread under `PLANNOTATOR_DATA_DIR/canvases/<thread id>/`.
 *
 * - `canvas.json` (written atomically): the agent's board HTML (the source of truth for its parts), the scene
 *   (Excalidraw elements; the agent's ids kept on its elements), the person's standing (pins, deletions), the parts
 *   the latest layout made, the scene as that layout left it (for read-back), the layout's state and warnings.
 * - `versions/<n>.json`: every version, the agent's and the person's, with its scene once there is one. A person's
 *   saves between two agent versions are one version, rewritten as they draw.
 * - `files/`: pictures the agent's board names (copied in) and pictures the person pasted.
 * - `canvas.png` and `versions/<n>.png`: pictures the window makes, for `read --png` and a message's preview card.
 *
 * The agent's CLI and the Inbox server both write, so every change holds the folder's lock (`store-files`). The
 * board is laid out by a browser: an agent write leaves the layout `pending` until an Inbox window lays it out and
 * sends the result (`layoutDone`). A person's save names the `rev` it started from and is refused when stale.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { dropDeleted, emptyStanding, type BoardPin, type BoardStanding } from "@plannotator/core/canvas-board";
import { readBackLines, standingAfter, type CanvasElement, type CanvasParts } from "@plannotator/core/canvas-scene";
import { sniffImageContentType } from "../review-image";
import { readJson, withLock, writeJsonAtomic } from "../store-files";

export const CANVAS_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
/** A canvas's id: a thread's root message id (a space's id later). */
export const CANVAS_ID_RE = /^msg_[0-9A-HJKMNP-TV-Z]{26}$/;
/** A person's saves within this long of the last, with no agent version between, are one version. */
const PERSON_VERSION_JOIN_MS = 10 * 60 * 1000;

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
  state: "pending" | "done";
  warnings: string[];
  at: string;
}

export interface CanvasState {
  id: string;
  /** Bumped by every write; a person's save names the rev it started from. */
  rev: number;
  /** The latest version, the agent's or the person's. */
  version: number;
  /** The agent's latest version (0: it has drawn nothing). */
  agentVersion: number;
  board: string;
  standing: BoardStanding;
  parts: CanvasParts | null;
  scene: CanvasScene | null;
  /** The scene as the agent's latest version was laid out: what read-back compares with. */
  laidOut: CanvasElement[] | null;
  layout: CanvasLayoutState | null;
  png: { rev: number } | null;
  updated: string;
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

export const blankCanvas = (id: string): CanvasState => ({
  id,
  rev: 0,
  version: 0,
  agentVersion: 0,
  board: "",
  standing: emptyStanding(),
  parts: null,
  scene: null,
  laidOut: null,
  layout: null,
  png: null,
  updated: new Date(0).toISOString(),
});

export const canvasesDirOf = (dataDir: string): string => join(dataDir, "canvases");

export type CanvasPersonSave =
  | { ok: true; rev: number; version: number; deleted: string[] }
  | { ok: false; code: "stale_base"; message: string; rev: number };

export type CanvasLayoutSave = { ok: true; rev: number } | { ok: false; code: "stale_layout"; message: string };

export interface CanvasStore {
  dir: string;
  folder(id: string): string;
  get(id: string): CanvasState;
  exists(id: string): boolean;
  locked(id: string): boolean;
  /** Copy a picture the board names into files/; its name there, or the reason it cannot be used. */
  copyPicture(id: string, path: string): { ok: true; name: string } | { ok: false; error: string };
  agentWrite(id: string, input: { board: string; pins: Record<string, BoardPin>; applied?: string[] }): CanvasState;
  layoutDone(id: string, input: { version: number; elements: CanvasElement[]; files: Record<string, CanvasFileRef>; warnings: string[]; parts: CanvasParts; changed: number }): CanvasLayoutSave;
  personSave(id: string, input: { base: number; elements: CanvasElement[]; files: Record<string, CanvasFileRef>; uploads?: Record<string, { mimeType: string; bytes: Uint8Array }> }): CanvasPersonSave;
  savePicture(id: string, input: { rev: number; version?: number; bytes: Uint8Array }): boolean;
  versions(id: string): CanvasVersionSummary[];
  version(id: string, n: number): CanvasVersion | null;
  /** Canvases whose agent version waits for a window to lay it out. */
  pending(): { id: string; version: number; picture?: true }[];
  filePath(id: string, name: string): string | null;
  picturePath(id: string, n?: number): string | null;
  /** What the person did since the agent's latest version, one line each. */
  readBack(id: string): string[];
  /** A cheap fingerprint per canvas, for the window's change events. */
  fingerprints(): Map<string, string>;
}

const ensureDir = (dir: string) => mkdirSync(dir, { recursive: true, mode: 0o700 });

export function createCanvasStore(options: { dataDir: string; now?: () => number }): CanvasStore {
  const dir = canvasesDirOf(options.dataDir);
  const now = options.now ?? Date.now;
  const iso = () => new Date(now()).toISOString();

  const folder = (id: string) => {
    if (!CANVAS_ID_RE.test(id)) throw new Error(`canvas store: "${id}" is not a canvas id`);
    return join(dir, id);
  };
  const stateFile = (id: string) => join(folder(id), "canvas.json");
  const versionFile = (id: string, n: number) => join(folder(id), "versions", `${n}.json`);
  const read = (id: string): CanvasState => {
    const s = readJson<CanvasState>(stateFile(id));
    return s && s.id === id ? { ...blankCanvas(id), ...s } : blankCanvas(id);
  };
  const locked = <T>(id: string, fn: () => T): T => {
    ensureDir(folder(id));
    return withLock(folder(id), fn, "canvas store");
  };
  const writeVersion = (id: string, v: CanvasVersion) => {
    ensureDir(dirname(versionFile(id, v.n)));
    writeJsonAtomic(versionFile(id, v.n), v);
  };
  const readVersion = (id: string, n: number) => (Number.isInteger(n) && n > 0 ? readJson<CanvasVersion>(versionFile(id, n)) : null);

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
    if (!sniffImageContentType(bytes)) return { ok: false, error: `${path} is not a png, jpg, gif or webp picture` };
    const name = `${createHash("sha256").update(bytes).digest("hex").slice(0, 10)}-${basename(real).replace(/[^\w.-]+/g, "_")}`;
    const files = join(folder(id), "files");
    ensureDir(files);
    const dest = join(files, name);
    if (!existsSync(dest)) copyFileSync(real, dest);
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
    get: (id) => read(id),
    exists: (id) => CANVAS_ID_RE.test(id) && existsSync(stateFile(id)),
    locked: (id) => CANVAS_ID_RE.test(id) && existsSync(join(folder(id), ".lock")),
    copyPicture,

    agentWrite(id, input) {
      return locked(id, () => {
        const s = read(id);
        const n = s.version + 1;
        const next: CanvasState = {
          ...s,
          rev: s.rev + 1,
          version: n,
          agentVersion: n,
          board: input.board,
          standing: { ...s.standing, pins: input.pins },
          layout: { version: n, state: "pending", warnings: [], at: iso() },
          updated: iso(),
        };
        writeVersion(id, { n, by: "agent", at: iso(), applied: input.applied ?? [] });
        writeJsonAtomic(stateFile(id), next);
        return next;
      });
    },

    layoutDone(id, input) {
      return locked(id, () => {
        const s = read(id);
        if (!s.layout || s.layout.version !== input.version || s.agentVersion !== input.version) {
          return { ok: false, code: "stale_layout", message: `version ${input.version} is not the one waiting to be laid out` };
        }
        if (s.layout.state === "done") return { ok: false, code: "stale_layout", message: `version ${input.version} is laid out already` };
        // The person's own elements stay as they are; the agent's are the new layout's.
        const mine = (s.scene?.elements ?? []).filter((e) => !(e.customData && typeof e.customData.part === "string" && (e.id === e.customData.part || e.id.startsWith(`${e.customData.part}~`))));
        const elements = [...input.elements, ...mine];
        const files: Record<string, CanvasFileRef> = {};
        for (const el of elements) if (el.type === "image" && el.fileId && !el.isDeleted) {
          const ref = input.files[el.fileId] ?? s.scene?.files[el.fileId];
          if (ref) files[el.fileId] = ref;
        }
        const scene: CanvasScene = { elements, files };
        const was = readVersion(id, input.version);
        writeVersion(id, { n: input.version, by: "agent", at: was?.at ?? iso(), applied: was?.applied ?? [], changed: input.changed, scene });
        const next: CanvasState = {
          ...s,
          rev: s.rev + 1,
          parts: input.parts,
          scene,
          laidOut: elements,
          layout: { version: input.version, state: "done", warnings: input.warnings, at: iso() },
          updated: iso(),
        };
        writeJsonAtomic(stateFile(id), next);
        return { ok: true, rev: next.rev };
      });
    },

    personSave(id, input) {
      return locked(id, () => {
        const s = read(id);
        if (input.base !== s.rev) {
          return { ok: false, code: "stale_base", message: `the canvas is at rev ${s.rev}, not ${input.base}: it changed since. Load it again.`, rev: s.rev };
        }
        if (input.uploads) {
          const files = join(folder(id), "files");
          ensureDir(files);
          for (const [fileId, up] of Object.entries(input.uploads)) {
            const ref = input.files[fileId];
            if (!ref || !/^[\w.-]+$/.test(ref.name) || ref.name.startsWith(".")) continue;
            if (up.bytes.byteLength > CANVAS_IMAGE_MAX_BYTES || !sniffImageContentType(up.bytes)) continue;
            const dest = join(files, ref.name);
            if (!existsSync(dest)) writeFileSync(dest, up.bytes, { mode: 0o600 });
          }
        }
        let standing = s.standing;
        let board = s.board;
        let deleted: string[] = [];
        if (s.parts && s.laidOut) {
          const after = standingAfter(s.laidOut, input.elements, s.parts, s.standing);
          deleted = after.newlyDeleted;
          const dropped = deleted.length ? dropDeleted(board, deleted) : { html: board, was: {} };
          board = dropped.html;
          standing = {
            pins: after.pins,
            deleted: [...s.standing.deleted, ...deleted],
            deletedHtml: { ...s.standing.deletedHtml, ...dropped.was },
          };
        }
        const scene: CanvasScene = { elements: input.elements, files: input.files };
        const last = s.version > 0 ? readVersion(id, s.version) : null;
        const join_ = last?.by === "person" && now() - Date.parse(last.at) < PERSON_VERSION_JOIN_MS;
        const n = join_ ? s.version : s.version + 1;
        writeVersion(id, { n, by: "person", at: join_ && last ? last.at : iso(), scene });
        const next: CanvasState = { ...s, rev: s.rev + 1, version: n, board, standing, scene, updated: iso() };
        writeJsonAtomic(stateFile(id), next);
        return { ok: true, rev: next.rev, version: n, deleted };
      });
    },

    savePicture(id, input) {
      if (!sniffImageContentType(input.bytes) || input.bytes.byteLength > CANVAS_IMAGE_MAX_BYTES) return false;
      return locked(id, () => {
        const s = read(id);
        if (input.rev < (s.png?.rev ?? -1)) return false;
        writeFileSync(join(folder(id), "canvas.png"), input.bytes, { mode: 0o600 });
        if (input.version) {
          ensureDir(join(folder(id), "versions"));
          writeFileSync(join(folder(id), "versions", `${input.version}.png`), input.bytes, { mode: 0o600 });
        }
        writeJsonAtomic(stateFile(id), { ...s, png: { rev: input.rev } });
        return true;
      });
    },

    versions(id) {
      const s = read(id);
      const out: CanvasVersionSummary[] = [];
      for (let n = 1; n <= s.version; n++) {
        const v = readVersion(id, n);
        if (v) out.push({ n: v.n, by: v.by, at: v.at, ...(v.changed !== undefined ? { changed: v.changed } : {}), picture: existsSync(join(folder(id), "versions", `${n}.png`)) });
      }
      return out;
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
        const s = read(name);
        if (s.layout?.state === "pending") out.push({ id: name, version: s.layout.version });
        // Laid out, but the window that did it closed before its picture was kept: the next window draws it.
        else if (s.layout?.state === "done" && !existsSync(join(folder(name), "versions", `${s.layout.version}.png`))) out.push({ id: name, version: s.layout.version, picture: true });
      }
      return out;
    },

    filePath,
    picturePath(id, n) {
      if (!CANVAS_ID_RE.test(id)) return null;
      const p = n ? join(folder(id), "versions", `${n}.png`) : join(folder(id), "canvas.png");
      return existsSync(p) ? p : null;
    },

    readBack(id) {
      const s = read(id);
      if (!s.scene) return [];
      const files = s.scene.files;
      return readBackLines({
        laidOut: s.laidOut ?? [],
        now: s.scene.elements,
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
  };
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
