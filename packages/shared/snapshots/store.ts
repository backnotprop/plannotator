/**
 * The snapshots store under `${dataDir}/snapshots/` (0700). The hub is its only
 * writer; it keeps the state in memory and writes each change through.
 *
 *   collections/hc-7f2a19/
 *     collection.json            { id, state, destination, note, snapshots: [ids], send }
 *     s-01-3be0/
 *       original.png             the native capture, full resolution, local only
 *       agent.png                ≤ 2000 px, marks and redactions burned in (what the agent reads)
 *       crop-1.png …             crops of small boxes, redacted
 *       app-text.raw.txt         App Capture: the window text as captured, local only
 *       app-text.txt             written at send: the text minus the lines the person removed
 *       snapshot.json                boxes, strokes, redactions, note, app identity
 *     snapshots.json                 written at send: the structured sidecar the message names
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
import { snapshotsDir } from "./registry";
import type { Collection, Destination, SendState, Snapshot, SnapshotKind, SnapshotSource } from "./types";

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
  kind: SnapshotKind;
  width?: number;
  height?: number;
  display?: { id?: number; scale: number };
  source?: SnapshotSource;
  /** App Capture: absolute path of the captured window text, moved in like the image. */
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

export class SnapshotsStore {
  readonly root: string;
  readonly collectionsDir: string;
  readonly incomingDir: string;
  readonly sendsDir: string;
  readonly trashDir: string;
  private collections = new Map<string, Collection>();
  private snapshots = new Map<string, Snapshot>();

  constructor(dataDir: string) {
    this.root = snapshotsDir(dataDir);
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
      for (const snapshotId of collection.snapshots) {
        const snapshot = readJson<Snapshot>(join(this.collectionsDir, name, snapshotId, "snapshot.json"));
        if (snapshot) this.snapshots.set(snapshot.id, snapshot);
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
    for (const snapshotId of collection.snapshots) this.snapshots.delete(snapshotId);
    this.collections.delete(id);
    rmSync(this.collectionDir(id), { recursive: true, force: true });
  }

  // --- Reading -------------------------------------------------------------------

  collectionDir(id: string): string {
    return join(this.collectionsDir, id);
  }

  snapshotDir(snapshot: Pick<Snapshot, "id" | "collectionId">): string {
    return join(this.collectionsDir, snapshot.collectionId, snapshot.id);
  }

  sidecarPath(collectionId: string): string {
    return join(this.collectionDir(collectionId), "snapshots.json");
  }

  getCollection(id: string): Collection | null {
    return this.collections.get(id) ?? null;
  }

  getSnapshot(id: string): Snapshot | null {
    return this.snapshots.get(id) ?? null;
  }

  snapshotsOf(collection: Collection): Snapshot[] {
    return collection.snapshots.map((id) => this.snapshots.get(id)).filter((snapshot): snapshot is Snapshot => !!snapshot);
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
  readRawText(snapshot: Snapshot): string | null {
    for (const name of ["app-text.raw.txt", "app-text.txt"]) {
      try {
        return readFileSync(join(this.snapshotDir(snapshot), name), "utf8");
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

  saveSnapshot(snapshot: Snapshot): void {
    this.snapshots.set(snapshot.id, snapshot);
    writeJson(join(this.snapshotDir(snapshot), "snapshot.json"), snapshot);
  }

  createCollection(destination: Destination | null): Collection {
    const collection: Collection = {
      v: 1,
      id: `hc-${hex(3)}`,
      createdAt: new Date().toISOString(),
      state: "open",
      destination,
      note: "",
      snapshots: [],
    };
    this.collections.set(collection.id, collection);
    this.saveCollection(collection);
    return collection;
  }

  updateCollection(collection: Collection, patch: Partial<Pick<Collection, "note" | "destination" | "send" | "state" | "snapshots">>): Collection {
    Object.assign(collection, patch);
    this.saveCollection(collection);
    return collection;
  }

  /** Register a capture as the next snapshot of `collection`. */
  addSnapshot(collection: Collection, input: CaptureInput): Snapshot {
    const bytes = readFileSync(input.file);
    const size = input.width && input.height ? { width: input.width, height: input.height } : imageSize(bytes);
    if (!size) throw new Error("Not a PNG or JPEG image.");
    const ext = extname(input.file).toLowerCase() === ".jpg" || extname(input.file).toLowerCase() === ".jpeg" ? ".jpg" : ".png";
    const id = `s-${String(collection.snapshots.length + 1).padStart(2, "0")}-${hex(2)}`;
    const snapshot: Snapshot = {
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
    const dir = this.snapshotDir(snapshot);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.moveIn(input.file, join(dir, snapshot.original.file));
    if (input.textFile && existsSync(input.textFile)) {
      this.moveIn(input.textFile, join(dir, "app-text.raw.txt"));
      const raw = readFileSync(join(dir, "app-text.raw.txt"), "utf8");
      snapshot.text = { chars: raw.length, include: raw.trim().length > 0, removedLines: [], source: "accessibility" };
    } else if (input.kind === "app") {
      snapshot.text = { chars: 0, include: false, removedLines: [], source: "accessibility", unavailable: input.textUnavailable ?? "No text" };
    }
    this.saveSnapshot(snapshot);
    this.updateCollection(collection, { snapshots: [...collection.snapshots, id] });
    return snapshot;
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

  deleteSnapshot(snapshot: Snapshot): Collection | null {
    const collection = this.collections.get(snapshot.collectionId) ?? null;
    this.snapshots.delete(snapshot.id);
    rmSync(this.snapshotDir(snapshot), { recursive: true, force: true });
    if (collection) this.updateCollection(collection, { snapshots: collection.snapshots.filter((id) => id !== snapshot.id) });
    return collection;
  }

  writeDerived(snapshot: Snapshot, name: string, bytes: Uint8Array): void {
    writeFileSync(join(this.snapshotDir(snapshot), basename(name)), bytes, { mode: 0o600 });
  }

  /** Write what a send names: each snapshot's sent text and the structured sidecar. Text lines the person removed never reach app-text.txt. */
  writeSendFiles(collection: Collection, sentTexts: Map<string, string>, sidecar: unknown): void {
    for (const snapshot of this.snapshotsOf(collection)) {
      const text = sentTexts.get(snapshot.id);
      const path = join(this.snapshotDir(snapshot), "app-text.txt");
      if (text !== undefined) writeFileSync(path, text, { mode: 0o600 });
      else rmSync(path, { force: true });
      // What the person removed from the window text never stays on disk once it is sent.
      rmSync(join(this.snapshotDir(snapshot), "app-text.raw.txt"), { force: true });
      if (snapshot.text && text !== undefined) {
        snapshot.text = { ...snapshot.text, chars: text.length, removedLines: [], edited: snapshot.text.edited || snapshot.text.removedLines.length > 0 };
        this.saveSnapshot(snapshot);
      }
    }
    writeJson(this.sidecarPath(collection.id), sidecar);
  }

  /** Discard: out of sight at once, deleted after the undo window. */
  discard(collection: Collection): void {
    for (const snapshotId of collection.snapshots) this.snapshots.delete(snapshotId);
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
    for (const snapshotId of collection.snapshots) {
      const snapshot = readJson<Snapshot>(join(this.collectionDir(collectionId), snapshotId, "snapshot.json"));
      if (snapshot) this.snapshots.set(snapshot.id, snapshot);
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
