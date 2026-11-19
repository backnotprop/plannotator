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
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { diffScenes, type CanvasAuthor, type CanvasLogEntry } from './changes';
import { asScene, emptyScene, type Box, type CanvasScene } from './scene';

export const INBOX_CANVAS_DIR = 'canvas';
const THREAD_ID = /^[A-Za-z0-9_]{1,80}$/;
/** The log keeps this many revisions; an agent that last looked before them is told to read again. */
const LOG_KEEP = 400;

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

export function readCanvasScene(inboxDirPath: string, threadId: string): CanvasScene {
  const raw = readJson(join(canvasDirOf(inboxDirPath, threadId), 'scene.excalidraw'));
  return raw ? asScene(raw) : emptyScene();
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
export function commitCanvas(inboxDirPath: string, threadId: string, next: CanvasScene, by: CanvasAuthor, at: Date, extra: { undid?: number } = {}): { rev: number; entry: CanvasLogEntry | null } {
  const dir = canvasDirOf(inboxDirPath, threadId);
  const prev = readCanvasScene(inboxDirPath, threadId);
  const meta = readCanvasMeta(inboxDirPath, threadId);
  const changes = diffScenes(prev, next);
  // A scene an agent started has no background yet; the editor's first save names the default one. Not a change.
  const paper = (scene: CanvasScene) => scene.appState.viewBackgroundColor ?? '#ffffff';
  const background = paper(prev) !== paper(next);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const text = `${JSON.stringify(next)}\n`;
  if (changes.length === 0 && !background) {
    // Selection order, a version bump with no visible change: keep the bytes current, not the revision.
    if (existsSync(join(dir, 'scene.excalidraw')) || next.elements.length > 0) writeWhole(join(dir, 'scene.excalidraw'), text);
    return { rev: meta.rev, entry: null };
  }
  const entry: CanvasLogEntry = { rev: meta.rev + 1, at: at.toISOString(), by, changes: changes.slice(0, 300), ...(extra.undid !== undefined ? { undid: extra.undid } : {}) };
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
}

export function writeCanvasUndo(inboxDirPath: string, threadId: string, undo: CanvasUndo): void {
  const dir = join(canvasDirOf(inboxDirPath, threadId), 'undo');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeWhole(join(dir, `${undo.rev}.json`), `${JSON.stringify(undo)}\n`);
}

export function readCanvasUndo(inboxDirPath: string, threadId: string, rev: number): CanvasUndo | null {
  const raw = readJson(join(canvasDirOf(inboxDirPath, threadId), 'undo', `${rev}.json`)) as CanvasUndo | null;
  return raw && Array.isArray(raw.before) && Array.isArray(raw.added) ? raw : null;
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
