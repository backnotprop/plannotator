/**
 * Plannotator Snapshots: checks on what the hub takes from its callers (the
 * HUD page and the native app, both behind the HUD token). Pure and
 * browser-safe. Anything the hub stores is later read by the composer, so a
 * malformed value is refused here (400) rather than failing every later send.
 */

import type { Rect, SnapshotBox, SnapshotRedaction, SnapshotStroke } from "./types";

/** A send id names a file under `snapshots/sends/` and a claim folder in each host: letters, digits, `-` and `_` only. */
export const SEND_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function isSendId(value: unknown): value is string {
  return typeof value === "string" && SEND_ID_PATTERN.test(value);
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const MAX_MARKS = 500;
const MAX_POINTS = 20_000;
const MAX_COMMENT = 20_000;
/** Larger than any display or window the native app captures. */
const MAX_COORD = 1_000_000;

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isCoord(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= MAX_COORD;
}

function rectOf(value: unknown): Rect | null {
  if (!Array.isArray(value) || value.length !== 4 || !value.every(isCoord)) return null;
  const [x, y, w, h] = value as Rect;
  return w >= 0 && h >= 0 ? [x, y, w, h] : null;
}

function idOf(value: unknown): string | null {
  return typeof value === "string" && ID_PATTERN.test(value) ? value : null;
}

function list<T>(value: unknown, name: string, item: (entry: unknown, index: number) => T | string): Checked<T[]> {
  if (!Array.isArray(value)) return { ok: false, error: `${name} must be a list.` };
  if (value.length > MAX_MARKS) return { ok: false, error: `Too many ${name}.` };
  const out: T[] = [];
  for (let index = 0; index < value.length; index++) {
    const parsed = item(value[index], index);
    if (typeof parsed === "string") return { ok: false, error: `${name}[${index}]: ${parsed}` };
    out.push(parsed);
  }
  return { ok: true, value: out };
}

export function checkBoxes(value: unknown): Checked<SnapshotBox[]> {
  const checked = list<SnapshotBox>(value, "boxes", (entry) => {
    if (!isRecord(entry)) return "not an object";
    const id = idOf(entry.id);
    if (!id) return "a bad id";
    if (!Number.isInteger(entry.n) || (entry.n as number) < 1 || (entry.n as number) > 9999) return "n must be a positive integer";
    const rect = rectOf(entry.rect);
    if (!rect) return "rect must be [x, y, w, h]";
    if (typeof entry.comment !== "string" || entry.comment.length > MAX_COMMENT) return "comment must be text";
    return { id, n: entry.n as number, rect, comment: entry.comment };
  });
  if (!checked.ok) return checked;
  const ids = new Set(checked.value.map((box) => box.id));
  const numbers = new Set(checked.value.map((box) => box.n));
  if (ids.size !== checked.value.length || numbers.size !== checked.value.length) return { ok: false, error: "boxes: ids and numbers must be unique." };
  return checked;
}

export function checkStrokes(value: unknown): Checked<SnapshotStroke[]> {
  return list<SnapshotStroke>(value, "strokes", (entry) => {
    if (!isRecord(entry)) return "not an object";
    const id = idOf(entry.id);
    if (!id) return "a bad id";
    if (entry.tool !== "pen" && entry.tool !== "arrow") return "tool must be pen or arrow";
    if (typeof entry.color !== "string" || entry.color.length > 64) return "color must be text";
    if (!isCoord(entry.size) || (entry.size as number) <= 0) return "size must be a positive number";
    if (!Array.isArray(entry.points) || entry.points.length > MAX_POINTS) return "points must be a list";
    const points: Array<{ x: number; y: number }> = [];
    for (const point of entry.points) {
      if (!isRecord(point) || !isCoord(point.x) || !isCoord(point.y)) return "points must be { x, y }";
      points.push({ x: point.x, y: point.y });
    }
    return { id, tool: entry.tool, color: entry.color, size: entry.size as number, points };
  });
}

export function checkRedactions(value: unknown): Checked<SnapshotRedaction[]> {
  return list<SnapshotRedaction>(value, "redactions", (entry) => {
    if (!isRecord(entry)) return "not an object";
    const id = idOf(entry.id);
    if (!id) return "a bad id";
    const rect = rectOf(entry.rect);
    if (!rect) return "rect must be [x, y, w, h]";
    return { id, rect };
  });
}

/** A URL as the agent message shows it: origin and path only (a query or fragment can carry tokens). */
export function displayUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "file:") return undefined;
    return url.protocol === "file:" ? `file://${url.pathname}` : `${url.origin}${url.pathname}`;
  } catch {
    return undefined;
  }
}
