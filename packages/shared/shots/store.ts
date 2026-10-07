/**
 * The shots store under `${dataDir}/shots/` (0700). The hub is its only
 * writer; it keeps the state in memory and writes each change through.
 *
 *   collections/hc-7f2a19/
 *     collection.json            { id, state, destination, note, shots: [ids], send }
 *     s-01-3be0/
 *       original.png             the native capture, full resolution, local only
 *       agent.png                ≤ 2000 px, marks and redactions burned in (what the agent reads)
 *       crop-1.png …             crops of small boxes, redacted
 *       app-text.raw.txt         App shots: the window text as captured, local only
 *       app-text.txt             written at send: the text minus the lines the person removed
 *       shot.json                boxes, strokes, redactions, note, app identity
 *     shots.json                 written at send: the structured sidecar the message names
 *   sends/<sendId>.json          a send not yet delivered (survives a hub restart)
 *   incoming/                    where the native app drops a capture before registering it
 *   .trash/                      discarded collections (10 s undo)
 *
 * Sent collections are kept for 7 days (the agent may Read the files later in
 * its session), then pruned. Discard removes at once, after the undo window.
 */

import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join } from "node:path";
import { shotsDir } from "./registry";
import type { Collection, Destination, SendState, Shot, ShotKind, ShotSource } from "./types";

export const SENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const DISCARD_UNDO_MS = 10_000;

export interface PendingSend {
  v: 1;
  sendId: string;
  collectionId: string;
  host: Destination["host"];
  sessionId: string;
  text: string;
  files: string[];
  createdAt: string;
}

export interface CaptureInput {
  captureId: string;
  /** Absolute path of the PNG/JPEG to register; moved into the collection when it is under `incoming/`, else copied. */
  file: string;
  kind: ShotKind;
  width?: number;
  height?: number;
  display?: { id?: number; scale: number };
  source?: ShotSource;
  /** App shots: absolute path of the captured window text, moved in like the image. */
  textFile?: string;
  /** Why there is no window text (e.g. "Accessibility is off"). */
  textUnavailable?: string;
}

function hex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function writeJson(path: string, value: unknown): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Width and height of a PNG or JPEG from its header; null when neither. */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) return null;
      const marker = bytes[offset + 1]!;
      const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: (bytes[offset + 5]! << 8) | bytes[offset + 6]!, width: (bytes[offset + 7]! << 8) | bytes[offset + 8]! };
      }
      offset += 2 + length;
    }
  }
  return null;
}

export class ShotsStore {
  readonly root: string;
  readonly collectionsDir: string;
  readonly incomingDir: string;
  readonly sendsDir: string;
  readonly trashDir: string;
  private collections = new Map<string, Collection>();
  private shots = new Map<string, Shot>();

  constructor(dataDir: string) {
    this.root = shotsDir(dataDir);
    this.collectionsDir = join(this.root, "collections");
    this.incomingDir = join(this.root, "incoming");
    this.sendsDir = join(this.root, "sends");
    this.trashDir = join(this.root, ".trash");
    for (const dir of [this.root, this.collectionsDir, this.incomingDir, this.sendsDir, this.trashDir]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    this.load();
  }

  // --- Loading and housekeeping ------------------------------------------------

  private load(): void {
    for (const name of readdirSync(this.collectionsDir)) {
      const collection = readJson<Collection>(join(this.collectionsDir, name, "collection.json"));
      if (!collection || collection.v !== 1) continue;
      this.collections.set(collection.id, collection);
      for (const shotId of collection.shots) {
        const shot = readJson<Shot>(join(this.collectionsDir, name, shotId, "shot.json"));
        if (shot) this.shots.set(shot.id, shot);
      }
    }
  }

  /** Remove sent collections past retention, discards past the undo window, and stale incoming files. */
  prune(now = Date.now()): void {
    for (const collection of [...this.collections.values()]) {
      if (collection.state !== "sealed") continue;
      const at = Date.parse(collection.send?.at ?? collection.createdAt);
      if (now - at > SENT_RETENTION_MS) this.removeCollection(collection.id);
    }
    for (const name of safeList(this.trashDir)) {
      const path = join(this.trashDir, name);
      if (now - statMs(path) > DISCARD_UNDO_MS) rmSync(path, { recursive: true, force: true });
    }
    for (const name of safeList(this.incomingDir)) {
      const path = join(this.incomingDir, name);
      if (now - statMs(path) > 24 * 60 * 60 * 1000) rmSync(path, { force: true });
    }
  }

  private removeCollection(id: string): void {
    const collection = this.collections.get(id);
    if (!collection) return;
    for (const shotId of collection.shots) this.shots.delete(shotId);
    this.collections.delete(id);
    rmSync(this.collectionDir(id), { recursive: true, force: true });
  }

  // --- Reading -------------------------------------------------------------------

  collectionDir(id: string): string {
    return join(this.collectionsDir, id);
  }

  shotDir(shot: Pick<Shot, "id" | "collectionId">): string {
    return join(this.collectionsDir, shot.collectionId, shot.id);
  }

  sidecarPath(collectionId: string): string {
    return join(this.collectionDir(collectionId), "shots.json");
  }

  getCollection(id: string): Collection | null {
    return this.collections.get(id) ?? null;
  }

  getShot(id: string): Shot | null {
    return this.shots.get(id) ?? null;
  }

  shotsOf(collection: Collection): Shot[] {
    return collection.shots.map((id) => this.shots.get(id)).filter((shot): shot is Shot => !!shot);
  }

  /** The collection being collected: the newest open one. */
  openCollection(): Collection | null {
    let newest: Collection | null = null;
    for (const collection of this.collections.values()) {
      if (collection.state !== "open") continue;
      if (!newest || collection.createdAt > newest.createdAt) newest = collection;
    }
    return newest;
  }

  lastSealed(): Collection | null {
    let newest: Collection | null = null;
    for (const collection of this.collections.values()) {
      if (collection.state !== "sealed" || !collection.send) continue;
      if (!newest || collection.send.at > newest.send!.at) newest = collection;
    }
    return newest;
  }

  /** The window text as captured; once sent, the raw copy is gone and this is the text that was sent. */
  readRawText(shot: Shot): string | null {
    for (const name of ["app-text.raw.txt", "app-text.txt"]) {
      try {
        return readFileSync(join(this.shotDir(shot), name), "utf8");
      } catch {
        // Try the next.
      }
    }
    return null;
  }

  // --- Writing -------------------------------------------------------------------

  private saveCollection(collection: Collection): void {
    mkdirSync(this.collectionDir(collection.id), { recursive: true, mode: 0o700 });
    writeJson(join(this.collectionDir(collection.id), "collection.json"), collection);
  }

  saveShot(shot: Shot): void {
    this.shots.set(shot.id, shot);
    writeJson(join(this.shotDir(shot), "shot.json"), shot);
  }

  createCollection(destination: Destination | null): Collection {
    const collection: Collection = {
      v: 1,
      id: `hc-${hex(3)}`,
      createdAt: new Date().toISOString(),
      state: "open",
      destination,
      note: "",
      shots: [],
    };
    this.collections.set(collection.id, collection);
    this.saveCollection(collection);
    return collection;
  }

  updateCollection(collection: Collection, patch: Partial<Pick<Collection, "note" | "destination" | "send" | "state" | "shots">>): Collection {
    Object.assign(collection, patch);
    this.saveCollection(collection);
    return collection;
  }

  /** Register a capture as the next shot of `collection`. */
  addShot(collection: Collection, input: CaptureInput): Shot {
    const bytes = readFileSync(input.file);
    const size = input.width && input.height ? { width: input.width, height: input.height } : imageSize(bytes);
    if (!size) throw new Error("Not a PNG or JPEG image.");
    const ext = extname(input.file).toLowerCase() === ".jpg" || extname(input.file).toLowerCase() === ".jpeg" ? ".jpg" : ".png";
    const id = `s-${String(collection.shots.length + 1).padStart(2, "0")}-${hex(2)}`;
    const shot: Shot = {
      v: 1,
      id,
      collectionId: collection.id,
      captureId: input.captureId,
      kind: input.kind,
      capturedAt: new Date().toISOString(),
      ...(input.display ? { display: input.display } : {}),
      ...(input.source ? { source: input.source } : {}),
      original: { file: `original${ext}`, width: size.width, height: size.height },
      boxes: [],
      strokes: [],
      redactions: [],
      note: "",
      crops: {},
    };
    const dir = this.shotDir(shot);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.moveIn(input.file, join(dir, shot.original.file));
    if (input.textFile && existsSync(input.textFile)) {
      this.moveIn(input.textFile, join(dir, "app-text.raw.txt"));
      const raw = readFileSync(join(dir, "app-text.raw.txt"), "utf8");
      shot.text = { chars: raw.length, include: raw.trim().length > 0, removedLines: [], source: "accessibility" };
    } else if (input.kind === "app") {
      shot.text = { chars: 0, include: false, removedLines: [], source: "accessibility", unavailable: input.textUnavailable ?? "No text" };
    }
    this.saveShot(shot);
    this.updateCollection(collection, { shots: [...collection.shots, id] });
    return shot;
  }

  /** Files the native app dropped under incoming/ are moved; anything else (a tool's own file) is copied. */
  private moveIn(from: string, to: string): void {
    if (from.startsWith(`${this.incomingDir}/`)) {
      try {
        renameSync(from, to);
        return;
      } catch {
        // Across devices: fall through to a copy.
      }
    }
    copyFileSync(from, to);
  }

  deleteShot(shot: Shot): Collection | null {
    const collection = this.collections.get(shot.collectionId) ?? null;
    this.shots.delete(shot.id);
    rmSync(this.shotDir(shot), { recursive: true, force: true });
    if (collection) this.updateCollection(collection, { shots: collection.shots.filter((id) => id !== shot.id) });
    return collection;
  }

  writeDerived(shot: Shot, name: string, bytes: Uint8Array): void {
    writeFileSync(join(this.shotDir(shot), basename(name)), bytes, { mode: 0o600 });
  }

  /** Write what a send names: each shot's sent text and the structured sidecar. Text lines the person removed never reach app-text.txt. */
  writeSendFiles(collection: Collection, sentTexts: Map<string, string>, sidecar: unknown): void {
    for (const shot of this.shotsOf(collection)) {
      const text = sentTexts.get(shot.id);
      const path = join(this.shotDir(shot), "app-text.txt");
      if (text !== undefined) writeFileSync(path, text, { mode: 0o600 });
      else rmSync(path, { force: true });
      // What the person removed from the window text never stays on disk once it is sent.
      rmSync(join(this.shotDir(shot), "app-text.raw.txt"), { force: true });
      if (shot.text && text !== undefined) {
        shot.text = { ...shot.text, chars: text.length, removedLines: [], edited: shot.text.edited || shot.text.removedLines.length > 0 };
        this.saveShot(shot);
      }
    }
    writeJson(this.sidecarPath(collection.id), sidecar);
  }

  /** Discard: out of sight at once, deleted after the undo window. */
  discard(collection: Collection): void {
    for (const shotId of collection.shots) this.shots.delete(shotId);
    this.collections.delete(collection.id);
    const from = this.collectionDir(collection.id);
    if (!existsSync(from)) return;
    const to = join(this.trashDir, collection.id);
    renameSync(from, to);
    // A rename keeps the old mtime; the undo window counts from now.
    const now = new Date();
    utimesSync(to, now, now);
  }

  /** Undo a discard inside the window. */
  restore(collectionId: string): Collection | null {
    const from = join(this.trashDir, collectionId);
    if (!existsSync(from)) return null;
    renameSync(from, this.collectionDir(collectionId));
    const collection = readJson<Collection>(join(this.collectionDir(collectionId), "collection.json"));
    if (!collection) return null;
    this.collections.set(collection.id, collection);
    for (const shotId of collection.shots) {
      const shot = readJson<Shot>(join(this.collectionDir(collectionId), shotId, "shot.json"));
      if (shot) this.shots.set(shot.id, shot);
    }
    return collection;
  }

  // --- Sends ---------------------------------------------------------------------

  savePendingSend(send: PendingSend): void {
    writeJson(join(this.sendsDir, `${send.sendId}.json`), send);
  }

  removePendingSend(sendId: string): void {
    rmSync(join(this.sendsDir, `${basename(sendId)}.json`), { force: true });
  }

  pendingSends(): PendingSend[] {
    return safeList(this.sendsDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => readJson<PendingSend>(join(this.sendsDir, name)))
      .filter((send): send is PendingSend => !!send && send.v === 1);
  }

  setSendState(collection: Collection, send: SendState): void {
    this.updateCollection(collection, { send });
  }
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function statMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}
