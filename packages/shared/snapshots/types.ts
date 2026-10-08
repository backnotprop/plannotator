/**
 * Plannotator Snapshots: the data model shared by the hub (Bun), the HUD (web)
 * and the composer. Browser-safe: types and tiny pure helpers only.
 *
 * Coordinates are ORIGINAL image pixels everywhere they are stored (`Rect` is
 * `[x, y, w, h]`); the agent-sized copy is derived at send time, and the
 * composer scales rects into its space so the numbers in the message line up
 * with the pixels the agent reads.
 */

export type SnapshotKind = "region" | "window" | "display" | "app";

/** `[x, y, w, h]` in image pixels. */
export type Rect = [number, number, number, number];

export interface SnapshotSource {
  app?: string;
  bundleId?: string;
  windowTitle?: string;
  /** A browser page's URL (AXURL), when the window exposes one. */
  url?: string;
  pid?: number;
}

export interface SnapshotBox {
  id: string;
  /** 1-based marker number, stable once given (deleting box 2 leaves 1 and 3). */
  n: number;
  rect: Rect;
  comment: string;
}

export type SnapshotStrokeTool = "pen" | "arrow";

export interface SnapshotStroke {
  id: string;
  tool: SnapshotStrokeTool;
  color: string;
  /** Stroke width in original pixels. */
  size: number;
  points: Array<{ x: number; y: number }>;
}

export interface SnapshotRedaction {
  id: string;
  rect: Rect;
}

export interface SnapshotText {
  /** Characters in the text as captured. */
  chars: number;
  /** Send the window text with this snapshot. */
  include: boolean;
  /** 0-based line indices the user removed from what is sent. */
  removedLines: number[];
  /** Set once sent: lines were removed before the send (the raw text is gone then). */
  edited?: boolean;
  /** Where the text came from: always accessibility for now. */
  source: "accessibility";
  /** Why there is no text, when there is none (e.g. Accessibility is off). */
  unavailable?: string;
}

export interface SnapshotImageFile {
  file: string;
  width: number;
  height: number;
}

export interface Snapshot {
  v: 1;
  id: string;
  collectionId: string;
  captureId: string;
  kind: SnapshotKind;
  capturedAt: string;
  display?: { id?: number; scale: number };
  source?: SnapshotSource;
  original: SnapshotImageFile;
  /** The agent-sized, marked-up copy; written by the HUD before a send or an Ask. */
  agent?: SnapshotImageFile & { madeAt: string };
  boxes: SnapshotBox[];
  strokes: SnapshotStroke[];
  redactions: SnapshotRedaction[];
  note: string;
  /** Box crops the HUD wrote (box id -> file name), small boxes only. */
  crops: Record<string, string>;
  /** App Capture: the window's accessibility text. */
  text?: SnapshotText;
}

export type CollectionState = "open" | "sealed" | "discarded";

/** Why a destination was chosen; anything but `chosen`/`summoned` reads as a guess ("Auto"). */
export type DestinationReason = "summoned" | "chosen" | "typed" | "only";

export interface Destination {
  host: ConnectionHost;
  sessionId: string;
  reason: DestinationReason;
}

export type SendStateName =
  | "pending" // queued in the hub, the session has not picked it up yet
  | "queued" // the session took it and will read it after its current turn
  | "delivered" // the session has it
  | "ended" // the session went away before it took it
  | "cleared" // the session was cleared (/clear); the person decides
  | "copied"; // no session: the person copied it instead

export interface SendState {
  sendId: string;
  state: SendStateName;
  at: string;
  /** Who it went to, as the strip says it ("Claude · plannotator"). */
  label: string;
  /** The session the send is latched to. */
  host?: ConnectionHost;
  sessionId?: string;
  /** For `cleared`: the session that replaced it, so "Send there anyway" can follow. */
  successorSessionId?: string;
}

export interface Collection {
  v: 1;
  id: string;
  createdAt: string;
  state: CollectionState;
  destination: Destination | null;
  note: string;
  snapshots: string[];
  send?: SendState;
}

export type ConnectionHost = "claude-code" | "pi" | "opencode" | "cli-wait";

export interface ConnectionView {
  id: string;
  host: ConnectionHost;
  sessionId: string;
  cwd: string;
  project: string;
  title: string;
  live: boolean;
  busy: boolean;
  /** Epoch ms of the last prompt a person typed into the session, or 0. */
  lastHumanInputAt: number;
  /** "Ask this session" works there (a turn-capable bridge). */
  canAsk: boolean;
  /** Set when the session was cleared: the session id that took its place. */
  successorSessionId?: string;
}

export interface SnapshotsState {
  serverSession: string;
  /** The open collection (what the strip and panel show), or null. */
  collection: Collection | null;
  snapshots: Snapshot[];
  /** The last sealed collection, for the delivery state in the strip. */
  lastSent: Collection | null;
  lastSentSnapshots: Snapshot[];
  connections: ConnectionView[];
  /** The latched destination's connection, resolved. */
  destination: (ConnectionView & { reason: DestinationReason }) | null;
  settings: SnapshotsSettings;
  /** Bumped on every change. */
  revision: number;
}

/** The two capture modes: a Screen Capture (a box, picture only) or an App Capture (a window plus its text). */
export type SnapshotsCaptureMode = "screen" | "app";

export interface SnapshotsSettings {
  /** The menu bar's "App Capture for ⌥⇧⌘4": ⌥⇧⌘4 takes an App Capture (window + its text) instead of a Screen Capture. */
  appCapture: boolean;
  /** The HUD's new-capture control (Screen / App): the mode its + button starts, remembered. */
  captureMode: SnapshotsCaptureMode;
  /** The one-time App Capture explainer was answered. */
  explainerSeen: boolean;
}

export const HOST_LABELS: Record<ConnectionHost, string> = {
  "claude-code": "Claude",
  pi: "Pi",
  opencode: "OpenCode",
  "cli-wait": "Waiting command",
};

export const HOST_LONG_LABELS: Record<ConnectionHost, string> = {
  "claude-code": "Claude Code",
  pi: "Pi",
  opencode: "OpenCode",
  "cli-wait": "Waiting command",
};

/** "Claude · plannotator": how a destination reads in the chip and the strip. */
export function connectionLabel(connection: Pick<ConnectionView, "host" | "project">): string {
  return connection.project ? `${HOST_LABELS[connection.host]} · ${connection.project}` : HOST_LABELS[connection.host];
}

/** The text a snapshot will send, with the removed lines taken out. */
export function textWithoutRemovedLines(raw: string, removedLines: readonly number[]): string {
  if (removedLines.length === 0) return raw;
  const removed = new Set(removedLines);
  return raw
    .split("\n")
    .filter((_, index) => !removed.has(index))
    .join("\n");
}

/** Long edge of the copy the agent reads. Claude caps every image at 2000 px once a request holds more than 20. */
export const AGENT_IMAGE_MAX_EDGE = 2000;

/** A box smaller than this share of the snapshot's area also gets its own crop. */
export const CROP_AREA_SHARE = 0.4;

export function agentSizeFor(width: number, height: number): { width: number; height: number; scale: number } {
  const long = Math.max(width, height);
  if (long <= AGENT_IMAGE_MAX_EDGE) return { width, height, scale: 1 };
  const scale = AGENT_IMAGE_MAX_EDGE / long;
  return { width: Math.round(width * scale), height: Math.round(height * scale), scale };
}

export function needsCrop(box: Pick<SnapshotBox, "rect">, width: number, height: number): boolean {
  const [, , w, h] = box.rect;
  return w * h < CROP_AREA_SHARE * width * height;
}
