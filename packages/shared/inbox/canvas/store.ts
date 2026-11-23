/**
 * Plannotator Inbox: a thread's canvas on disk.
 *
 *   inbox/canvas/<thread id>/scene.excalidraw   the scene: Excalidraw's own JSON (opens in Excalidraw as it is)
 *   inbox/canvas/<thread id>/meta.json          the revision, each agent's last look, the stored picture's place
 *   inbox/canvas/<thread id>/log.jsonl          one line per revision: who changed which things
 *   inbox/canvas/<thread id>/picture.png        the window's last drawing of the whole canvas
 *   inbox/canvas/<thread id>/pictures/          pictures cut for an agent (canvas_picture)
 *
 * Files, not the store's JSONL: a canvas changes on every stroke and must not
 * enter the event log (the window's stream, search, the phone relay). Written
 * whole (temp, then rename), owner-only, like a reply draft.
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { diffScenes, type CanvasAuthor, type CanvasLogEntry, type CanvasUndone } from './changes';
import { asScene, emptyScene, type Box, type CanvasScene } from './scene';

export const INBOX_CANVAS_DIR = 'canvas';
const THREAD_ID = /^[A-Za-z0-9_]{1,80}$/;
/** The log keeps this many revisions; an agent that last looked before them is told to read again. */
const LOG_KEEP = 400;
/** A picture cut for an agent is kept this long after it was written (`pictures/`), and the folder at most this large. */
export const AGENT_PICTURE_LIFE_MS = 24 * 60 * 60 * 1000;
export const AGENT_PICTURES_MAX_BYTES = 200 * 1024 * 1024;
const UNDO_KEPT = 30;
/** A deleted thread's canvas is kept aside this long (`canvas/.gone`), then removed. */
export const CANVAS_GONE_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

export interface CanvasPictureMeta {
  rev: number;
  /** The part of the scene the picture shows, and how many picture pixels one scene unit is. */
  box: Box;
  scale: number;
}

export interface CanvasMeta {
  v: 1;
  rev: number;
  updated_at: string | null;
  /** Each agent session's last look: the revision its last answer gave it. */
  seen: Record<string, number>;
  picture: CanvasPictureMeta | null;
  /** The last revision an agent made, and the revision the person last had on screen: an agent's change after that is news to them. */
  agent_rev: number;
  person_seen: number;
  /** How many live elements the scene holds (0: nothing to show a mark for). */
  count: number;
}

export function canvasDirOf(inboxDirPath: string, threadId: string): string {
  if (!THREAD_ID.test(threadId)) throw new Error('canvas: not a thread id');
  return join(inboxDirPath, INBOX_CANVAS_DIR, threadId);
}

function writeWhole(file: string, content: string | Uint8Array): void {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, content, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function readCanvasMeta(inboxDirPath: string, threadId: string): CanvasMeta {
  const raw = readJson(join(canvasDirOf(inboxDirPath, threadId), 'meta.json')) as Partial<CanvasMeta> | null;
  const seen: Record<string, number> = {};
  if (raw?.seen && typeof raw.seen === 'object') {
    for (const [key, rev] of Object.entries(raw.seen)) if (Number.isInteger(rev)) seen[key] = rev as number;
  }
  const p = raw?.picture;
  const picture = p && Number.isInteger(p.rev) && p.box && [p.box.x, p.box.y, p.box.w, p.box.h, p.scale].every((n) => Number.isFinite(n)) ? p : null;
  const int = (value: unknown) => (Number.isInteger(value) ? (value as number) : 0);
  return { v: 1, rev: int(raw?.rev), updated_at: typeof raw?.updated_at === 'string' ? raw.updated_at : null, seen, picture, agent_rev: int(raw?.agent_rev), person_seen: int(raw?.person_seen), count: int(raw?.count) };
}

export function writeCanvasMeta(inboxDirPath: string, threadId: string, meta: CanvasMeta): void {
  const dir = canvasDirOf(inboxDirPath, threadId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeWhole(join(dir, 'meta.json'), `${JSON.stringify(meta)}\n`);
}

const FILE_ID = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * The scene. Pictures' bytes are not in `scene.excalidraw`: each is one file under `files/`, written once, so a save
 * of a canvas with photos rewrites kilobytes, not megabytes, and a picture's file outlives its element's deletion.
 * `withFiles`: put the files every picture element names (deleted ones too) back into the scene, as Excalidraw's own
 * JSON has them.
 */
export function readCanvasScene(inboxDirPath: string, threadId: string, withFiles = true): CanvasScene {
  const dir = canvasDirOf(inboxDirPath, threadId);
  const raw = readJson(join(dir, 'scene.excalidraw'));
  const scene = raw ? asScene(raw) : emptyScene();
  if (!withFiles) return { ...scene, files: {} };
  const files: Record<string, unknown> = { ...scene.files };
  for (const el of scene.elements) {
    const id = el.fileId;
    if (typeof id !== 'string' || files[id] !== undefined || !FILE_ID.test(id)) continue;
    const file = readJson(join(dir, 'files', `${id}.json`));
    if (file) files[id] = file;
  }
  return { ...scene, files };
}

/** One picture's file (Excalidraw's `{ id, mimeType, dataURL, … }`), or null. */
export function readCanvasFile(inboxDirPath: string, threadId: string, fileId: string): unknown {
  if (!FILE_ID.test(fileId)) return null;
  return readJson(join(canvasDirOf(inboxDirPath, threadId), 'files', `${fileId}.json`));
}

function writeNewFiles(dir: string, files: Record<string, unknown>): void {
  for (const [id, file] of Object.entries(files)) {
    if (!FILE_ID.test(id) || !file || typeof file !== 'object') continue;
    const path = join(dir, 'files', `${id}.json`);
    if (existsSync(path)) continue;
    mkdirSync(join(dir, 'files'), { recursive: true, mode: 0o700 });
    writeWhole(path, JSON.stringify(file));
  }
}

export function hasCanvas(inboxDirPath: string, threadId: string): boolean {
  try {
    return existsSync(join(canvasDirOf(inboxDirPath, threadId), 'scene.excalidraw'));
  } catch {
    return false;
  }
}

export function readCanvasLog(inboxDirPath: string, threadId: string): CanvasLogEntry[] {
  let text = '';
  try {
    text = readFileSync(join(canvasDirOf(inboxDirPath, threadId), 'log.jsonl'), 'utf8');
  } catch {
    return [];
  }
  const out: CanvasLogEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line) as CanvasLogEntry;
      if (Number.isInteger(entry.rev) && Array.isArray(entry.changes) && entry.by) out.push(entry);
    } catch {
      // A torn last line (the process died mid-append) is skipped.
    }
  }
  return out;
}

/**
 * Store a scene as the next revision, when it differs from the stored one.
 * Returns the revision it now is and the log entry written (null when nothing
 * a reader would see changed).
 */
export function commitCanvas(inboxDirPath: string, threadId: string, next: CanvasScene, by: CanvasAuthor, at: Date, extra: { undid?: number; undone?: CanvasUndone } = {}): { rev: number; entry: CanvasLogEntry | null } {
  const dir = canvasDirOf(inboxDirPath, threadId);
  const prev = readCanvasScene(inboxDirPath, threadId, false);
  const meta = readCanvasMeta(inboxDirPath, threadId);
  const changes = diffScenes(prev, next);
  // A scene an agent started has no background yet; the editor's first save names the default one. Not a change.
  const paper = (scene: CanvasScene) => scene.appState.viewBackgroundColor ?? '#ffffff';
  const background = paper(prev) !== paper(next);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeNewFiles(dir, next.files);
  const text = `${JSON.stringify({ ...next, files: {} })}\n`;
  if (changes.length === 0 && !background) {
    // Selection order, a version bump with no visible change: keep the bytes current, not the revision.
    if (existsSync(join(dir, 'scene.excalidraw')) || next.elements.length > 0) writeWhole(join(dir, 'scene.excalidraw'), text);
    return { rev: meta.rev, entry: null };
  }
  const entry: CanvasLogEntry = { rev: meta.rev + 1, at: at.toISOString(), by, changes: changes.slice(0, 300), ...(extra.undid !== undefined ? { undid: extra.undid, ...(extra.undone ? { undone: extra.undone } : {}) } : {}) };
  writeWhole(join(dir, 'scene.excalidraw'), text);
  const log = readCanvasLog(inboxDirPath, threadId);
  if (log.length >= LOG_KEEP * 2) writeWhole(join(dir, 'log.jsonl'), `${[...log.slice(-LOG_KEEP), entry].map((e) => JSON.stringify(e)).join('\n')}\n`);
  else appendFileSync(join(dir, 'log.jsonl'), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  const count = next.elements.filter((e) => !e.isDeleted).length;
  // The person's own save is on their screen as they make it.
  writeCanvasMeta(inboxDirPath, threadId, { ...meta, rev: entry.rev, updated_at: entry.at, count, ...(by.kind === 'agent' ? { agent_rev: entry.rev } : { person_seen: entry.rev }) });
  return { rev: entry.rev, entry };
}

export function writeCanvasPicture(inboxDirPath: string, threadId: string, png: Uint8Array, picture: CanvasPictureMeta): void {
  const dir = canvasDirOf(inboxDirPath, threadId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeWhole(join(dir, 'picture.png'), png);
  writeCanvasMeta(inboxDirPath, threadId, { ...readCanvasMeta(inboxDirPath, threadId), picture });
}

export function readCanvasPicture(inboxDirPath: string, threadId: string): Uint8Array | null {
  try {
    return new Uint8Array(readFileSync(join(canvasDirOf(inboxDirPath, threadId), 'picture.png')));
  } catch {
    return null;
  }
}

/** Write a picture an agent asked for, and give its path. */
export function writeAgentPicture(inboxDirPath: string, threadId: string, name: string, png: Uint8Array): string {
  const dir = join(canvasDirOf(inboxDirPath, threadId), 'pictures');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${name.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80)}.png`);
  writeWhole(file, png);
  // A path an answer handed out stays good for as long as an agent may still open it: pictures go by age, never by
  // how many came after. Beyond a total size the oldest go first, whatever their age.
  try {
    const now = Date.now();
    const kept = readdirSync(dir)
      .filter((n) => n.endsWith('.png'))
      .map((n) => ({ n, stat: statSync(join(dir, n)) }))
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    let bytes = 0;
    for (const old of kept) {
      bytes += old.stat.size;
      if (join(dir, old.n) === file) continue;
      if (now - old.stat.mtimeMs > AGENT_PICTURE_LIFE_MS || bytes > AGENT_PICTURES_MAX_BYTES) unlinkSync(join(dir, old.n));
    }
  } catch {
    // Tidying is best effort.
  }
  return file;
}

/** Note that an agent session has now seen a revision. */
export function noteCanvasSeen(inboxDirPath: string, threadId: string, key: string, rev: number): void {
  const meta = readCanvasMeta(inboxDirPath, threadId);
  if (meta.seen[key] === rev) return;
  if (!existsSync(canvasDirOf(inboxDirPath, threadId))) return;
  const seen = { ...meta.seen, [key]: rev };
  const keys = Object.keys(seen);
  // A canvas many sessions touched keeps the latest lookers.
  for (const old of keys.slice(0, Math.max(0, keys.length - 64))) delete seen[old];
  writeCanvasMeta(inboxDirPath, threadId, { ...meta, seen });
}

/** What an agent's revision replaced, kept so the person can take that change back: each changed element as it was, and what it added. */
export interface CanvasUndo {
  rev: number;
  before: CanvasScene['elements'];
  added: string[];
  /** The look (scene.ts `lookOf`) the change left each element it added with: one nobody touched since is removed. */
  after: Record<string, string>;
  /** Each changed element as the change left it: a field goes back only where it is still what the change made it. */
  left: CanvasScene['elements'];
}

export function writeCanvasUndo(inboxDirPath: string, threadId: string, undo: CanvasUndo): void {
  const dir = join(canvasDirOf(inboxDirPath, threadId), 'undo');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeWhole(join(dir, `${undo.rev}.json`), `${JSON.stringify(undo)}\n`);
  // The newest few changes can be taken back; older records go.
  try {
    const revs = readdirSync(dir).map((n) => Number(n.replace(/\.json$/, ''))).filter((n) => Number.isInteger(n)).sort((a, b) => b - a);
    for (const old of revs.slice(UNDO_KEPT)) unlinkSync(join(dir, `${old}.json`));
  } catch {
    // Tidying is best effort.
  }
}

/** A change that was taken back cannot be taken back again. */
export function removeCanvasUndo(inboxDirPath: string, threadId: string, rev: number): void {
  try {
    unlinkSync(join(canvasDirOf(inboxDirPath, threadId), 'undo', `${rev}.json`));
  } catch {
    // Already gone.
  }
}

export function readCanvasUndo(inboxDirPath: string, threadId: string, rev: number): CanvasUndo | null {
  const raw = readJson(join(canvasDirOf(inboxDirPath, threadId), 'undo', `${rev}.json`)) as CanvasUndo | null;
  return raw && Array.isArray(raw.before) && Array.isArray(raw.added) && raw.after && typeof raw.after === 'object' && Array.isArray(raw.left) ? raw : null;
}

/** Every thread that has a canvas folder. */
export function canvasThreads(inboxDirPath: string): string[] {
  try {
    return readdirSync(join(inboxDirPath, INBOX_CANVAS_DIR)).filter((name) => THREAD_ID.test(name));
  } catch {
    return [];
  }
}

/**
 * A deleted thread's canvas goes with it: its folder is moved out of the way (`canvas/.gone/<thread>-<time>`), where
 * nothing reads it, rather than removed outright, so a thread deleted by mistake still has its drawing on disk.
 */
export function retireCanvas(inboxDirPath: string, threadId: string, at: number): boolean {
  try {
    const gone = join(inboxDirPath, INBOX_CANVAS_DIR, '.gone');
    mkdirSync(gone, { recursive: true, mode: 0o700 });
    renameSync(canvasDirOf(inboxDirPath, threadId), join(gone, `${threadId}-${at}`));
    return true;
  } catch {
    return false;
  }
}

/**
 * What each agent session has been shown, thing by thing: element id → the look (scene.ts `lookOf`) the element had
 * when an answer to that session held the thing's line. An agent may change a thing only while it still looks as it
 * was shown; nothing else moves this, so no error, cut list, copied revision or log that has been trimmed can stand in
 * for having been told.
 */
export type CanvasTold = Record<string, Record<string, string>>;
const TOLD_SESSIONS = 32;

/** A session key that may name a record: never a name every object already has, never the old everyone mark. */
export function isCanvasSession(key: unknown): key is string {
  return typeof key === 'string' && key.length > 0 && key.length <= 300 && !['__proto__', 'constructor', 'prototype', 'hasOwnProperty', 'toString', 'valueOf', '*'].includes(key);
}

export function readCanvasTold(inboxDirPath: string, threadId: string): CanvasTold {
  const raw = readJson(join(canvasDirOf(inboxDirPath, threadId), 'told.json'));
  // No prototype anywhere: a key is only ever a key.
  const out: CanvasTold = Object.create(null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const session of Object.keys(raw)) {
    const from = (raw as Record<string, unknown>)[session];
    if (!isCanvasSession(session) || !from || typeof from !== 'object') continue;
    const mine: Record<string, string> = Object.create(null);
    for (const id of Object.keys(from)) {
      const look = (from as Record<string, unknown>)[id];
      if (typeof look === 'string') mine[id] = look;
    }
    out[session] = mine;
  }
  return out;
}

/** Record that an answer to `session` showed these elements with these looks. */
export function markCanvasTold(inboxDirPath: string, threadId: string, session: string, looks: Iterable<[string, string]>): void {
  const dir = canvasDirOf(inboxDirPath, threadId);
  if (!isCanvasSession(session) || !existsSync(dir)) return;
  const all = readCanvasTold(inboxDirPath, threadId);
  const mine: Record<string, string> = all[session] ?? Object.create(null);
  let changed = false;
  for (const [id, look] of looks) {
    if (mine[id] !== look) {
      mine[id] = look;
      changed = true;
    }
  }
  if (!changed) return;
  // The session just told moves to the end; the oldest sessions beyond the cap go.
  delete all[session];
  all[session] = mine;
  const sessions = Object.keys(all);
  for (const old of sessions.slice(0, Math.max(0, sessions.length - TOLD_SESSIONS))) delete all[old];
  writeWhole(join(dir, 'told.json'), `${JSON.stringify(all)}\n`);
}

/** Remove the canvases of threads deleted more than `CANVAS_GONE_KEEP_MS` ago. */
export function sweepGoneCanvases(inboxDirPath: string, now: number): number {
  const gone = join(inboxDirPath, INBOX_CANVAS_DIR, '.gone');
  let removed = 0;
  try {
    for (const name of readdirSync(gone)) {
      const at = Number(/-(\d+)$/.exec(name)?.[1]);
      if (!Number.isFinite(at) || now - at <= CANVAS_GONE_KEEP_MS) continue;
      rmSync(join(gone, name), { recursive: true, force: true });
      removed++;
    }
  } catch {
    // No such folder: nothing was ever deleted.
  }
  return removed;
}
