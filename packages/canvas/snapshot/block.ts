/**
 * How a canvas snapshot is written in a plan's Markdown.
 *
 *     :::canvas-snapshot
 *     canvas: parcel-alerts
 *     snapshot: architecture
 *     title: Architecture
 *     ![Orders API feeds two queues, one worker sends alerts](parcel-alerts.architecture.svg)
 *     :::
 *
 * It is an ordinary directive container, the same shape as `:::question`,
 * so the product's parser already makes it one block (`type: 'directive'`,
 * `directiveKind: 'canvas-snapshot'`) and this file only reads the body.
 *
 * The block holds a reference, not a picture of the data: the snapshot's
 * source lives in the canvas document, so the figure is live, the block
 * never goes stale, and the same snapshot can be written any number of
 * times. The optional image line is the fallback: a renderer that does not
 * know this directive (an older Plannotator, any other Markdown viewer)
 * shows it as an image inside a callout, and this one shows it when the
 * canvas itself cannot be reached.
 *
 * Pure text in, plain data out: safe in a browser, a server or a worker.
 */
import { DIRECTIVE_OPEN_RE, codeFenceCloseIndex, directiveCloseIndex } from '@plannotator/core/markdown-structure';
import { isValidId } from '../model/ids';

export const CANVAS_SNAPSHOT_DIRECTIVE = 'canvas-snapshot';

export interface SnapshotFallbackImage {
  src: string;
  alt: string;
}

/** What one `:::canvas-snapshot` block says. */
export interface SnapshotRef {
  canvas: string;
  snapshot: string;
  /** A caption written in the plan. Absent: the snapshot's own title. */
  title?: string;
  fallback?: SnapshotFallbackImage;
}

const FIELD_RE = /^([a-z]+)\s*:\s*(.*)$/i;
const IMAGE_RE = /^!\[([^\]]*)\]\(\s*(<[^>]+>|[^\s)]+)\s*\)$/;

const oneLine = (value: string): string => value.replace(/\s+/g, ' ').trim();

/**
 * Read a block's body (the lines between `:::canvas-snapshot` and `:::`).
 * Null when it names no canvas or no snapshot: the caller then draws the
 * block as the ordinary callout it would have been. A line this version does
 * not know is skipped, so a later version can add fields.
 */
export function parseSnapshotBlock(body: string): SnapshotRef | null {
  let canvas: string | undefined;
  let snapshot: string | undefined;
  let title: string | undefined;
  let fallback: SnapshotFallbackImage | undefined;
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const image = line.match(IMAGE_RE);
    if (image) {
      fallback ??= { alt: image[1], src: image[2].replace(/^<|>$/g, '') };
      continue;
    }
    const field = line.match(FIELD_RE);
    if (!field) continue;
    const key = field[1].toLowerCase();
    const value = field[2].trim();
    if (key === 'canvas') canvas ??= value;
    else if (key === 'snapshot') snapshot ??= value;
    else if (key === 'title' && value) title ??= value;
  }
  if (!isValidId(canvas) || !isValidId(snapshot)) return null;
  return { canvas, snapshot, ...(title ? { title } : {}), ...(fallback ? { fallback } : {}) };
}

/** The block's body: what `parseSnapshotBlock` reads back to the same value. */
export function serializeSnapshotBody(ref: SnapshotRef): string {
  const lines = [`canvas: ${ref.canvas}`, `snapshot: ${ref.snapshot}`];
  const title = ref.title ? oneLine(ref.title) : '';
  if (title) lines.push(`title: ${title}`);
  if (ref.fallback?.src) {
    const alt = oneLine(ref.fallback.alt).replace(/[\[\]]/g, '');
    const src = /[\s()]/.test(ref.fallback.src) ? `<${ref.fallback.src}>` : ref.fallback.src;
    lines.push(`![${alt}](${src})`);
  }
  return lines.join('\n');
}

/** The whole block, opener and closer included. */
export function serializeSnapshotBlock(ref: SnapshotRef): string {
  return `:::${CANVAS_SNAPSHOT_DIRECTIVE}\n${serializeSnapshotBody(ref)}\n:::`;
}

export interface FoundSnapshotBlock {
  ref: SnapshotRef;
  /** 1-based lines of the opener and the closer. */
  startLine: number;
  endLine: number;
}

/**
 * Every snapshot block in a Markdown document, in order. A block inside a
 * code fence is text, not a snapshot. Which canvases a plan refers to, and
 * where, is answered from here without rendering anything.
 */
export function findSnapshotBlocks(markdown: string): FoundSnapshotBlock[] {
  const lines = markdown.split('\n');
  const found: FoundSnapshotBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('```')) {
      i = codeFenceCloseIndex(lines, i);
      continue;
    }
    const open = trimmed.match(DIRECTIVE_OPEN_RE);
    if (!open) continue;
    const close = directiveCloseIndex(lines, i);
    if (open[1].toLowerCase() === CANVAS_SNAPSHOT_DIRECTIVE) {
      const ref = parseSnapshotBlock(lines.slice(i + 1, close).join('\n'));
      if (ref) found.push({ ref, startLine: i + 1, endLine: Math.min(close, lines.length - 1) + 1 });
    }
    i = close;
  }
  return found;
}

/**
 * The document with a snapshot block put in after line `afterLine` (1-based;
 * 0 puts it first, a number past the end puts it last). The block gets a
 * blank line on each side and no more than one, so inserting never joins it
 * to a paragraph and never stacks up blank lines.
 */
export function insertSnapshotBlock(markdown: string, afterLine: number, ref: SnapshotRef): string {
  const lines = markdown === '' ? [] : markdown.split('\n');
  const at = Math.max(0, Math.min(lines.length, Math.trunc(afterLine)));
  const before = lines.slice(0, at);
  const after = lines.slice(at);
  while (before.length && before[before.length - 1].trim() === '') before.pop();
  while (after.length && after[0].trim() === '') after.shift();
  const out = [...before];
  if (before.length) out.push('');
  out.push(...serializeSnapshotBlock(ref).split('\n'));
  if (after.length) out.push('', ...after);
  else if (markdown.endsWith('\n')) out.push('');
  return out.join('\n');
}
