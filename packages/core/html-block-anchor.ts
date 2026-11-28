/**
 * Where a comment on an element of a live `html` block sits in its document
 * (a message in the Plannotator Inbox): which block, and which source.
 * Browser-safe and dependency-free. The annotation carries it as
 * `htmlBlockAnchor`, beside the element's own anchor inside the page
 * (`htmlAnchor`, `elementContext`: @plannotator/core/html-anchor), the way a
 * comment on a diagram part carries `diagramAnchor`.
 *
 *     { v: 1, index: 2, id: "<32 hex>", sourceLine: [14, 31] }
 *
 * - `index`: the block's place among the document's live html blocks,
 *   counted from 1 in document order.
 * - `id`: the block's embed id, the first 32 hex digits of the SHA-256 of its
 *   source (`EMBED_ID` in html-embed.ts). A comment is drawn only on the
 *   source it was made on.
 * - `sourceLine`: the fence's first and last line in the document, or null.
 *
 * A comment whose block is gone, or whose block now holds another source, is
 * unanchored: it is listed, never drawn on a page it was not made on.
 */

export interface HtmlBlockAnchor {
  v: 1;
  index: number;
  id: string;
  sourceLine: [number, number] | null;
}

/** The most html blocks one document can name (far past what a message holds). */
export const MAX_HTML_BLOCK_INDEX = 10_000;
const MAX_LINE = 10_000_000;
const ID = /^[a-f0-9]{32}$/;

const whole = (value: unknown, max: number): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= max;

/** The anchor, checked; null for anything else. Unknown keys are dropped. */
export function parseHtmlBlockAnchor(value: unknown): HtmlBlockAnchor | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.v !== 1 || !whole(raw.index, MAX_HTML_BLOCK_INDEX)) return null;
  if (typeof raw.id !== "string" || !ID.test(raw.id)) return null;
  let sourceLine: [number, number] | null = null;
  if (raw.sourceLine !== null && raw.sourceLine !== undefined) {
    const lines = raw.sourceLine;
    if (!Array.isArray(lines) || lines.length !== 2 || !whole(lines[0], MAX_LINE) || !whole(lines[1], MAX_LINE) || lines[1] < lines[0]) return null;
    sourceLine = [lines[0], lines[1]];
  }
  return { v: 1, index: raw.index, id: raw.id, sourceLine };
}

/** The anchor of a block: its place, its embed id and its fence's lines. Null when any of them is not one. */
export function buildHtmlBlockAnchor(index: number, id: string, sourceLine: readonly [number, number] | null): HtmlBlockAnchor | null {
  return parseHtmlBlockAnchor({ v: 1, index, id, sourceLine: sourceLine === null ? null : [sourceLine[0], sourceLine[1]] });
}

/**
 * Whether a comment's anchor names this block.
 * - `other`: another block's.
 * - `pending`: this block's place, and its id is not known yet (its page has not been asked for).
 * - `own`: this block's place and source.
 * - `changed`: this block's place, another source. Unanchored.
 */
export type HtmlBlockAnchorMatch = "other" | "pending" | "own" | "changed";

export function matchHtmlBlockAnchor(anchor: HtmlBlockAnchor, block: { index: number; id: string | null }): HtmlBlockAnchorMatch {
  if (anchor.index !== block.index) return "other";
  if (block.id === null) return "pending";
  return anchor.id === block.id ? "own" : "changed";
}

/** The fence's lines as an export prints them: `lines 14–31`, `line 14`, or nothing. */
export function htmlBlockAnchorLines(anchor: HtmlBlockAnchor): string {
  if (anchor.sourceLine === null) return "";
  const [first, last] = anchor.sourceLine;
  return last > first ? `lines ${first}–${last}` : `line ${first}`;
}
