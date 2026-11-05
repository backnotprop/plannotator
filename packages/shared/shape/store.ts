/**
 * The Shape store: one folder per shape under `<data dir>/shapes/`, shared by
 * the Inbox and the standalone Shapes page (SPEC.md §1, "Where the files live").
 *
 *   <data>/shapes/
 *     seen.json                        { "<shp id>": 7 }   the last version you looked at
 *     <projectKey>/<shp_id>/
 *       shape.json                     the shape (ShapeRecord), rewritten whole (temp file, then rename)
 *       versions.jsonl                 one full snapshot per line (ShapeVersion), append only
 *       chat.jsonl                     notes (ShapeNote), append only; a later line for the same id wins
 *       files/                         copies of the images the board cites
 *
 * `projectKey` is the Inbox's own `inboxProjectKey(name, root)`, so shapes and
 * Inbox threads group under the same project names. Nothing here reads or
 * writes the Inbox's store: an Inbox shape is a shape with `thread` set.
 *
 * Several processes may write (two agents, the CLI and a server), so every
 * change to one shape holds that shape's lock file. A torn last line (a crash
 * mid-append) is skipped on read, and the next append starts on a new line.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { inboxProjectKey } from "../inbox/project-key";
import {
  checkShapeBoard,
  checkShapeNoteInput,
  isShapeId,
  SHAPE_FORMAT_VERSION,
  shapeId,
  shapeNoteId,
  shapeNoteWaits,
  shapeParts,
  shapeViewNow,
  type ShapeBoard,
  type ShapeNote,
  type ShapeProject,
  type ShapeRecord,
  type ShapeSession,
  type ShapeState,
  type ShapeVersion,
} from "./format";

export const SHAPE_DRAWING_MAX_MS = 10 * 60 * 1000;
/** An image a board cites, copied into the shape's files/. */
export const SHAPE_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const LOCK_WAIT_MS = 5000;
const LOCK_STALE_MS = 30_000;
const MESSAGE_ID_RE = /^msg_[0-9A-HJKMNP-TV-Z]{26}$/;

export interface ShapeSummary {
  id: string;
  title: string;
  project: ShapeProject;
  thread: string | null;
  state: ShapeState;
  updated: string;
  latest: number;
  /** The last version you looked at, or null. */
  seen: number | null;
  /** The agent wrote a version newer than the one you looked at. */
  changed: boolean;
  /** The agent is drawing now. */
  drawing: boolean;
  /** Change it notes no agent has picked up. */
  waiting: number;
  session: ShapeSession | null;
}

export interface ShapeUpdateInput {
  /** What the agent wrote; validated here. */
  board: unknown;
  /** The shape to add a version to. Absent: a new shape. */
  id?: string | null;
  /** The version the agent started from. Required for an existing shape. */
  base?: number | null;
  /** The Inbox thread a new shape hangs off (`msg_…`). */
  thread?: string | null;
  /** The last thread message this version took in. */
  through?: string | null;
  project: ShapeProject;
  session?: ShapeSession | null;
  /** The folder the board file is in: image references by relative path are read from here. */
  sourceDir?: string | null;
}

export type ShapeUpdateResult =
  | { ok: true; id: string; v: number; created: boolean; record: ShapeRecord }
  | { ok: false; code: "invalid"; errors: string[] }
  | { ok: false; code: "base_required" | "not_found" | "finished"; message: string; latest?: number }
  | { ok: false; code: "stale_base"; message: string; latest: ShapeVersion };

export type ShapeNoteResult =
  | { ok: true; note: ShapeNote }
  | { ok: false; code: "invalid"; errors: string[] }
  | { ok: false; code: "not_found" | "finished" | "no_version"; message: string };

export interface ShapeStore {
  readonly dir: string;
  update(input: ShapeUpdateInput): ShapeUpdateResult;
  get(id: string): ShapeRecord | null;
  /** One version (the latest when `n` is absent). */
  read(id: string, n?: number): ShapeVersion | null;
  versions(id: string): { n: number; at: string; note: string | null; base: number | null }[];
  list(options?: { state?: ShapeState | "all" }): ShapeSummary[];
  /** The newest active shape of a session, else of a project root. For CLI calls that name no shape. */
  latestFor(options: { session?: ShapeSession | null; root?: string | null }): ShapeRecord | null;
  drawing(id: string, options?: { untilMs?: number }): ShapeRecord | null;
  setState(id: string, state: ShapeState): ShapeRecord | null;
  remove(id: string): boolean;
  seen(): Record<string, number>;
  markSeen(id: string, n: number): void;
  addNote(id: string, input: unknown): ShapeNoteResult;
  answer(id: string, input: { re: string | null; text: string; from: ShapeSession }): ShapeNoteResult;
  notes(id: string): ShapeNote[];
  /**
   * The notes waiting for an agent (Change it, Ask). Reading them marks
   * nothing: the caller hands them over, then calls `markDelivered`, so a
   * hand-over that fails (a closed pipe) leaves them waiting. Two readers at
   * once may both get them: delivery is at least once.
   */
  waiting(id: string): ShapeNote[];
  /** Mark these notes delivered (the ones not delivered yet); the notes as marked. */
  markDelivered(id: string, noteIds: readonly string[]): ShapeNote[];
  /** A file under the shape's files/ folder, path-guarded; null when absent or outside. */
  filePath(id: string, name: string): string | null;
  /**
   * Someone holds the store's lock (or this shape's). A server awaits this
   * clearing before it writes, so the store's blocking wait never stalls its
   * event loop behind an agent's CLI.
   */
  locked(id?: string | null): boolean;
}

// The lock is a file holding its owner's token. A lock older than
// LOCK_STALE_MS is broken, but only under a second lock (`.lock.break`) and
// only if it is still stale when looked at again there, so two waiters can
// never both break it and each take a fresh lock. The owner removes the lock
// only while it still holds its own token. `sleep` blocks the thread: the
// store is called from the CLI, one command per process; a server that calls
// it must call it off its event loop.
function sleep(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJsonAtomic(path: string, value: unknown) {
  const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

function readLines<T>(path: string): T[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // A torn line from a crash mid-append: skipped.
    }
  }
  return out;
}

/** Append one line; when the file's last line is torn, start on a new one so both stay readable. */
function appendLine(path: string, value: unknown) {
  let prefix = "";
  try {
    const size = statSync(path).size;
    if (size > 0) {
      const text = readFileSync(path, "utf8");
      if (!text.endsWith("\n")) prefix = "\n";
    }
  } catch {
    // a new file
  }
  appendFileSync(path, `${prefix}${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function lockAge(path: string): number | null {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function breakIfStale(lock: string) {
  if ((lockAge(lock) ?? 0) <= LOCK_STALE_MS) return;
  const breaker = `${lock}.break`;
  let fd: number;
  try {
    fd = openSync(breaker, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // A breaker that died mid-break: its lock goes the same way, later.
    if ((lockAge(breaker) ?? 0) > LOCK_STALE_MS) rmSync(breaker, { force: true });
    return;
  }
  try {
    if ((lockAge(lock) ?? 0) > LOCK_STALE_MS) rmSync(lock, { force: true });
  } finally {
    closeSync(fd);
    rmSync(breaker, { force: true });
  }
}

function withLock<T>(dir: string, fn: () => T): T {
  const lock = join(dir, ".lock");
  const token = `${process.pid}.${randomUUID()}`;
  const start = Date.now();
  for (;;) {
    try {
      writeFileSync(lock, token, { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      breakIfStale(lock);
      if (Date.now() - start > LOCK_WAIT_MS) throw new Error(`shape store: ${dir} stayed locked for ${LOCK_WAIT_MS} ms`);
      sleep(15);
    }
  }
  try {
    return fn();
  } finally {
    try {
      if (readFileSync(lock, "utf8") === token) rmSync(lock, { force: true });
    } catch {
      // broken as stale while we held it, or the folder is gone (remove)
    }
  }
}

export function shapesDirOf(dataDir: string): string {
  return join(dataDir, "shapes");
}

export type { ShapeProject };

/** The checkout a board's code lives in: the linked worktree it was written from while that is still there, else the project's root. */
export function shapeCodeRoot(project: ShapeProject): string {
  return project.worktree && existsSync(project.worktree) ? project.worktree : project.root;
}

export function createShapeStore(options: { dataDir: string; now?: () => number }): ShapeStore {
  const dir = shapesDirOf(options.dataDir);
  const now = options.now ?? (() => Date.now());
  const iso = () => new Date(now()).toISOString();
  const seenPath = join(dir, "seen.json");

  const ensureDir = (path: string) => mkdirSync(path, { recursive: true, mode: 0o700 });

  function shapeDir(id: string): string | null {
    if (!isShapeId(id)) return null;
    let projects: string[];
    try {
      projects = readdirSync(dir);
    } catch {
      return null;
    }
    for (const project of projects) {
      const candidate = join(dir, project, id);
      if (existsSync(join(candidate, "shape.json"))) return candidate;
    }
    return null;
  }

  const recordOf = (folder: string) => readJson<ShapeRecord>(join(folder, "shape.json"));
  // A version or note saved when What to know was Requirements says "reqs": read it as the view it is now. The file stays as written.
  const nowKnow = <T extends { view: unknown }>(x: T): T => (shapeViewNow(x.view) === x.view ? x : { ...x, view: "know" });
  const versionsOf = (folder: string) => readLines<ShapeVersion>(join(folder, "versions.jsonl")).map((v) => (v.parts ? { ...v, parts: v.parts.map(nowKnow) } : v));

  function notesOf(folder: string): ShapeNote[] {
    const byId = new Map<string, ShapeNote>();
    for (const note of readLines<ShapeNote>(join(folder, "chat.jsonl"))) {
      if (note && typeof note.id === "string") byId.set(note.id, nowKnow(note));
    }
    return [...byId.values()];
  }

  const drawingNow = (record: ShapeRecord) => !!record.drawing && Date.parse(record.drawing.until) > now();

  /** Where an image comes from and its name in files/. Null: it stays as written (a files/ name, a data:image) or an error was recorded. */
  function imageFile(src: string, field: string, sourceDir: string | null | undefined, errors: string[]): { path: string; name: string } | null {
    // files/… is a picture the board keeps, unless the board's own folder really has one by that name: that one is copied.
    const local = src.startsWith("files/") && sourceDir ? resolve(sourceDir, src) : null;
    if (src.startsWith("files/") && !(local && existsSync(local))) {
      if (!/^files\/[^/\\%?#.][^/\\%?#]*$/.test(src)) errors.push(`${field}: "${src.slice(0, 80)}" is not one file under files/`);
      return null;
    }
    if (/^data:image\/(?:png|jpeg|gif|webp)[;,]/i.test(src)) return null;
    // A board loads nothing from outside: an image is a file on this computer, copied in.
    if (/^[a-z][a-z0-9+.-]+:|^\/\/|^\\\\/i.test(src)) {
      errors.push(`${field}: "${src.slice(0, 80)}" is a URL; an image must be a file on this computer (it is copied into the board)`);
      return null;
    }
    const path = isAbsolute(src) ? src : sourceDir ? resolve(sourceDir, src) : null;
    if (!path) {
      errors.push(`${field}: a relative image path needs the board file's folder`);
      return null;
    }
    if (!IMAGE_EXT.has(extname(path).toLowerCase())) {
      errors.push(`${field}: "${src}" is not a PNG, JPEG, GIF or WebP image`);
      return null;
    }
    let size: number;
    let real: string;
    try {
      const stat = statSync(path);
      if (!stat.isFile()) throw new Error("not a file");
      size = stat.size;
      real = realpathSync(path);
    } catch {
      errors.push(`${field}: "${src}" was not found`);
      return null;
    }
    // A link named .png is what it points at.
    if (!IMAGE_EXT.has(extname(real).toLowerCase())) {
      errors.push(`${field}: "${src}" is not a PNG, JPEG, GIF or WebP image`);
      return null;
    }
    if (size > SHAPE_IMAGE_MAX_BYTES) {
      errors.push(`${field}: "${src}" is ${size} bytes; at most ${SHAPE_IMAGE_MAX_BYTES}`);
      return null;
    }
    return { path, name: `${createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 10)}-${basename(path).replace(/[^\w.-]+/g, "_")}` };
  }

  function copyImage(file: { path: string; name: string }, folder: string): void {
    const files = join(folder, "files");
    ensureDir(files);
    const dest = join(files, file.name);
    if (!existsSync(dest)) copyFileSync(file.path, dest);
  }

  /**
   * A picture a drawing names by its path (`<img src>`, SVG `<image href>`) gets
   * its files/ name before the board is checked; the file is copied once the
   * board's folder is known. A URL stays as written, for the check to refuse.
   */
  function drawnImages(input: unknown, sourceDir: string | null | undefined): { board: unknown; files: { path: string; name: string }[]; errors: string[] } {
    const errors: string[] = [];
    const files: { path: string; name: string }[] = [];
    const views = (input as { views?: unknown } | null)?.views;
    if (!views || typeof views !== "object") return { board: input, files, errors };
    const inHtml = (html: unknown, field: string): unknown =>
      typeof html !== "string"
        ? html
        : html.replace(/(<(?:img|image)\b[^>]*?\s)(xlink:href|src|href)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'>]+))/gi, (all, head: string, attr: string, q2?: string, q1?: string, bare?: string) => {
            const src = (q2 ?? q1 ?? bare)!;
            if (/^(?:#|[a-z][a-z0-9+.-]+:|\/\/|\\\\)/i.test(src)) return all;
            const file = imageFile(src, field, sourceDir, errors);
            if (!file) return all;
            files.push(file);
            return `${head}${attr.toLowerCase() === "xlink:href" ? "href" : attr}="files/${file.name}"`;
          });
    const next: Record<string, unknown> = {};
    for (const [name, view] of Object.entries(views)) {
      if (!view || typeof view !== "object") {
        next[name] = view;
        continue;
      }
      const v = view as { html?: unknown; tall?: { html?: unknown }; more?: { html?: unknown } };
      next[name] = {
        ...v,
        ...("html" in v ? { html: inHtml(v.html, `views.${name}.html`) } : {}),
        ...(v.tall ? { tall: { ...v.tall, html: inHtml(v.tall.html, `views.${name}.tall.html`) } } : {}),
        ...(v.more ? { more: { ...v.more, html: inHtml(v.more.html, `views.${name}.more.html`) } } : {}),
      };
    }
    return { board: { ...(input as object), views: next }, files, errors };
  }

  /** Copy the images the refs cite into files/, and point the refs at the copies. */
  function keepImages(board: ShapeBoard, folder: string, sourceDir: string | null | undefined): { board: ShapeBoard; errors: string[] } {
    const errors: string[] = [];
    if (!board.refs?.length) return { board, errors };
    const keep = (src: string, field: string): string => {
      const file = imageFile(src, field, sourceDir, errors);
      if (!file) return src;
      copyImage(file, folder);
      return `files/${file.name}`;
    };
    const refs = board.refs.map((ref, i) => {
      if (ref.kind !== "image" && !ref.images) return ref;
      return {
        ...ref,
        ...(ref.kind === "image" ? { target: keep(ref.target, `refs[${i}].target`) } : {}),
        ...(ref.images ? { images: ref.images.map((im, j) => ({ ...im, src: keep(im.src, `refs[${i}].images[${j}].src`) })) } : {}),
      };
    });
    return { board: { ...board, refs }, errors };
  }

  function update(input: ShapeUpdateInput): ShapeUpdateResult {
    const drawn = drawnImages(input.board, input.sourceDir);
    if (drawn.errors.length) return { ok: false, code: "invalid", errors: drawn.errors };
    const checked = checkShapeBoard(drawn.board);
    if (!checked.ok) return { ok: false, code: "invalid", errors: checked.errors };
    const ids = (["thread", "through"] as const).filter((k) => input[k] != null && !MESSAGE_ID_RE.test(input[k]!));
    if (ids.length) return { ok: false, code: "invalid", errors: ids.map((k) => `${k}: must be an Inbox message id (msg_…)`) };
    const at = iso();

    if (!input.id) {
      const id = shapeId(now());
      const folder = join(dir, inboxProjectKey(input.project.name, input.project.root), id);
      ensureDir(folder);
      return withLock(folder, () => {
        const kept = keepImages(checked.value, folder, input.sourceDir);
        if (kept.errors.length) {
          rmSync(folder, { recursive: true, force: true });
          return { ok: false, code: "invalid", errors: kept.errors };
        }
        for (const file of drawn.files) copyImage(file, folder);
        const version: ShapeVersion = {
          ...kept.board,
          n: 1,
          at,
          base: null,
          through: input.through ?? null,
          by: input.session ?? null,
          parts: shapeParts(kept.board),
        };
        const record: ShapeRecord = {
          v: SHAPE_FORMAT_VERSION,
          id,
          title: kept.board.title,
          project: input.project,
          session: input.session ?? null,
          thread: input.thread ?? null,
          state: "active",
          created: at,
          updated: at,
          latest: 1,
          drawing: null,
        };
        appendLine(join(folder, "versions.jsonl"), version);
        writeJsonAtomic(join(folder, "shape.json"), record);
        return { ok: true, id, v: 1, created: true, record };
      });
    }

    const folder = shapeDir(input.id);
    if (!folder) return { ok: false, code: "not_found", message: `No shape ${input.id}. List them with \`plannotator shape list\`.` };
    return withLock(folder, () => {
      const record = recordOf(folder);
      if (!record) return { ok: false, code: "not_found", message: `No shape ${input.id}.` };
      if (record.state === "finished") {
        return { ok: false, code: "finished", message: `${record.id} is finished; it takes no new versions until the person reopens it.`, latest: record.latest };
      }
      if (input.base === undefined || input.base === null) {
        return {
          ok: false,
          code: "base_required",
          message: `${record.id} is at version ${record.latest}. Pass the version you started from (--base ${record.latest} if you drew from the latest).`,
          latest: record.latest,
        };
      }
      const versions = versionsOf(folder);
      const latest = versions.at(-1);
      if (!latest) return { ok: false, code: "not_found", message: `${record.id} has no versions.` };
      if (input.base !== latest.n) {
        return {
          ok: false,
          code: "stale_base",
          message: `${record.id} is at version ${latest.n}, not ${input.base}: someone updated it since. Read version ${latest.n}, fold your change into it, and update with --base ${latest.n}.`,
          latest,
        };
      }
      const kept = keepImages(checked.value, folder, input.sourceDir);
      if (kept.errors.length) return { ok: false, code: "invalid", errors: kept.errors };
      for (const file of drawn.files) copyImage(file, folder);
      const n = latest.n + 1;
      const version: ShapeVersion = {
        ...kept.board,
        n,
        at,
        base: input.base,
        through: input.through ?? latest.through ?? null,
        by: input.session ?? null,
        parts: shapeParts(kept.board),
      };
      appendLine(join(folder, "versions.jsonl"), version);
      const next: ShapeRecord = { ...record, title: kept.board.title, updated: at, latest: n, drawing: null };
      writeJsonAtomic(join(folder, "shape.json"), next);
      return { ok: true, id: record.id, v: n, created: false, record: next };
    });
  }

  function get(id: string): ShapeRecord | null {
    const folder = shapeDir(id);
    if (!folder) return null;
    const record = recordOf(folder);
    if (!record) return null;
    // An expired "drawing" reads as not drawing; it is cleared on the next write.
    return record.drawing && !drawingNow(record) ? { ...record, drawing: null } : record;
  }

  function read(id: string, n?: number): ShapeVersion | null {
    const folder = shapeDir(id);
    if (!folder) return null;
    const versions = versionsOf(folder);
    if (n === undefined) return versions.at(-1) ?? null;
    return versions.find((v) => v.n === n) ?? null;
  }

  function versions(id: string) {
    const folder = shapeDir(id);
    if (!folder) return [];
    return versionsOf(folder).map((v) => ({ n: v.n, at: v.at, note: v.note ?? null, base: v.base }));
  }

  function seen(): Record<string, number> {
    const value = readJson<Record<string, unknown>>(seenPath);
    const out: Record<string, number> = {};
    if (value && typeof value === "object") {
      for (const [key, n] of Object.entries(value)) if (isShapeId(key) && typeof n === "number") out[key] = n;
    }
    return out;
  }

  function markSeen(id: string, n: number) {
    const record = get(id);
    if (!record || !Number.isInteger(n) || n < 1) return;
    ensureDir(dir);
    withLock(dir, () => {
      const all = seen();
      // Seen only moves forward, and never past what exists.
      const next = Math.min(Math.max(all[id] ?? 0, n), record.latest);
      if (all[id] === next) return;
      writeJsonAtomic(seenPath, { ...all, [id]: next });
    });
  }

  function list(opts: { state?: ShapeState | "all" } = {}): ShapeSummary[] {
    const state = opts.state ?? "all";
    const marks = seen();
    const out: ShapeSummary[] = [];
    let projects: string[] = [];
    try {
      projects = readdirSync(dir);
    } catch {
      return [];
    }
    for (const project of projects) {
      let ids: string[] = [];
      try {
        ids = readdirSync(join(dir, project)).filter(isShapeId);
      } catch {
        continue;
      }
      for (const id of ids) {
        const folder = join(dir, project, id);
        const record = recordOf(folder);
        if (!record) continue;
        if (state !== "all" && record.state !== state) continue;
        const mark = marks[id] ?? null;
        out.push({
          id,
          title: record.title,
          project: record.project,
          thread: record.thread,
          state: record.state,
          updated: record.updated,
          latest: record.latest,
          seen: mark,
          changed: record.latest > (mark ?? 0),
          drawing: drawingNow(record),
          waiting: notesOf(folder).filter(shapeNoteWaits).length,
          session: record.session,
        });
      }
    }
    // Newest change first (SPEC: "Last changed, by default and everywhere").
    return out.sort((a, b) => b.updated.localeCompare(a.updated) || b.id.localeCompare(a.id));
  }

  function latestFor({ session, root }: { session?: ShapeSession | null; root?: string | null }): ShapeRecord | null {
    const active = list({ state: "active" });
    const mine = session ? active.find((s) => s.session?.host === session.host && s.session.id === session.id) : undefined;
    const here = mine ?? (root ? active.find((s) => s.project.root === root) : undefined);
    return here ? get(here.id) : null;
  }

  function mutate(id: string, change: (record: ShapeRecord) => ShapeRecord): ShapeRecord | null {
    const folder = shapeDir(id);
    if (!folder) return null;
    return withLock(folder, () => {
      const record = recordOf(folder);
      if (!record) return null;
      const next = change(record);
      writeJsonAtomic(join(folder, "shape.json"), next);
      return next;
    });
  }

  function drawing(id: string, opts: { untilMs?: number } = {}) {
    const span = Math.min(Math.max(opts.untilMs ?? SHAPE_DRAWING_MAX_MS, 1000), SHAPE_DRAWING_MAX_MS);
    return mutate(id, (record) =>
      record.state === "finished" ? record : { ...record, drawing: { at: iso(), until: new Date(now() + span).toISOString() } },
    );
  }

  function setState(id: string, state: ShapeState) {
    return mutate(id, (record) => ({ ...record, state, drawing: state === "finished" ? null : record.drawing, updated: record.updated }));
  }

  function remove(id: string): boolean {
    const folder = shapeDir(id);
    if (!folder) return false;
    // Under the shape's lock, so no write lands in a folder being removed.
    withLock(folder, () => rmSync(folder, { recursive: true, force: true }));
    if (existsSync(seenPath)) {
      withLock(dir, () => {
        const all = seen();
        if (id in all) {
          delete all[id];
          writeJsonAtomic(seenPath, all);
        }
      });
    }
    return true;
  }

  function addNote(id: string, input: unknown): ShapeNoteResult {
    const checked = checkShapeNoteInput(input);
    if (!checked.ok) return { ok: false, code: "invalid", errors: checked.errors };
    const folder = shapeDir(id);
    if (!folder) return { ok: false, code: "not_found", message: `No shape ${id}.` };
    return withLock(folder, () => {
      const record = recordOf(folder);
      if (!record) return { ok: false, code: "not_found", message: `No shape ${id}.` };
      if (record.state === "finished") return { ok: false, code: "finished", message: `${id} is finished. Reopen it to change it.` };
      if (checked.value.v > record.latest) return { ok: false, code: "no_version", message: `${id} has no version ${checked.value.v}.` };
      const note: ShapeNote = {
        id: shapeNoteId(now()),
        at: iso(),
        kind: checked.value.kind,
        v: checked.value.v,
        view: checked.value.view ?? null,
        part: checked.value.part ?? null,
        quote: checked.value.quote ?? null,
        text: checked.value.text,
        from: "you",
        re: null,
        delivered: null,
      };
      appendLine(join(folder, "chat.jsonl"), note);
      return { ok: true, note };
    });
  }

  function answer(id: string, input: { re: string | null; text: string; from: ShapeSession }): ShapeNoteResult {
    const text = typeof input.text === "string" ? input.text.trim() : "";
    if (!text) return { ok: false, code: "invalid", errors: ["text: is empty"] };
    const folder = shapeDir(id);
    if (!folder) return { ok: false, code: "not_found", message: `No shape ${id}.` };
    return withLock(folder, () => {
      const record = recordOf(folder);
      if (!record) return { ok: false, code: "not_found", message: `No shape ${id}.` };
      const asked = input.re ? notesOf(folder).find((n) => n.id === input.re) : undefined;
      if (input.re && !asked) return { ok: false, code: "invalid", errors: [`re: no note ${input.re}`] };
      const note: ShapeNote = {
        id: shapeNoteId(now()),
        at: iso(),
        kind: "answer",
        v: record.latest,
        view: asked?.view ?? null,
        part: asked?.part ?? null,
        quote: null,
        text,
        from: input.from,
        re: input.re,
        delivered: null,
      };
      appendLine(join(folder, "chat.jsonl"), note);
      return { ok: true, note };
    });
  }

  function notes(id: string): ShapeNote[] {
    const folder = shapeDir(id);
    return folder ? notesOf(folder) : [];
  }

  const waitsForAgent = (n: ShapeNote) => n.from === "you" && (n.kind === "change" || n.kind === "ask") && !n.delivered;

  function waiting(id: string): ShapeNote[] {
    const folder = shapeDir(id);
    return folder ? notesOf(folder).filter(waitsForAgent) : [];
  }

  function markDelivered(id: string, noteIds: readonly string[]): ShapeNote[] {
    const folder = shapeDir(id);
    if (!folder || !noteIds.length) return [];
    const wanted = new Set(noteIds);
    return withLock(folder, () => {
      const at = iso();
      const marked = notesOf(folder).filter((n) => wanted.has(n.id) && waitsForAgent(n));
      for (const note of marked) appendLine(join(folder, "chat.jsonl"), { ...note, delivered: at });
      return marked.map((n) => ({ ...n, delivered: at }));
    });
  }

  function filePath(id: string, name: string): string | null {
    const folder = shapeDir(id);
    if (!folder) return null;
    const rel = name.replace(/^files\//, "");
    if (!rel || rel.includes("/") || rel.includes("\\") || rel.startsWith(".")) return null;
    const path = join(folder, "files", rel);
    // A link planted in files/ never leads out: the real file must sit in the real files/ folder, and be a file.
    try {
      const real = realpathSync(path);
      if (dirname(real) !== realpathSync(join(folder, "files")) || !statSync(real).isFile()) return null;
      return real;
    } catch {
      return null;
    }
  }

  function locked(id?: string | null): boolean {
    if (existsSync(join(dir, ".lock"))) return true;
    const folder = id ? shapeDir(id) : null;
    return !!folder && existsSync(join(folder, ".lock"));
  }

  return { dir, locked, update, get, read, versions, list, latestFor, drawing, setState, remove, seen, markSeen, addNote, answer, notes, waiting, markDelivered, filePath };
}
