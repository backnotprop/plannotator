/**
 * Pure helpers behind the document tool catalog: outline, section ranges,
 * block-boundary windowing, quote resolution and context excerpts. No DOM,
 * no React, so every anchoring rule is unit-testable with parsed blocks.
 */
import type { Annotation, Block } from '@plannotator/ui/types';

export interface OutlineEntry {
  /** Stable heading slug the tools accept as `section`. */
  id: string;
  level: number;
  title: string;
  line: number;
  /** Annotations anchored inside the section (heading inclusive, up to the next heading of the same or higher level). */
  annotations: number;
  /** Parser block id backing this heading. */
  blockId: string;
}

export const DEFAULT_MAX_CHARS = 16000;
export const CONTEXT_RADIUS = 120;
export const ANNOTATION_TEXT_MAX = 1000;
export const MAX_ANNOTATIONS_IN_RESPONSE = 200;

export function slugifyHeading(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[`*_~[\]()]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
  return slug || 'section';
}

/** Index of the nearest heading block at or before `blockIndex`, or -1. */
function headingIndexFor(blocks: readonly Block[], blockIndex: number): number {
  for (let i = blockIndex; i >= 0; i--) if (blocks[i]?.type === 'heading') return i;
  return -1;
}

/** Block index range `[start, end)` of the section headed by block `headingIndex`. */
export function sectionRangeAt(blocks: readonly Block[], headingIndex: number): { start: number; end: number } {
  const level = blocks[headingIndex]?.level ?? 1;
  let end = blocks.length;
  for (let i = headingIndex + 1; i < blocks.length; i++) {
    const block = blocks[i]!;
    if (block.type === 'heading' && (block.level ?? 1) <= level) {
      end = i;
      break;
    }
  }
  return { start: headingIndex, end };
}

export function buildOutline(blocks: readonly Block[], annotations: readonly Annotation[]): OutlineEntry[] {
  const seen = new Map<string, number>();
  const entries: OutlineEntry[] = [];
  blocks.forEach((block, index) => {
    if (block.type !== 'heading') return;
    const base = slugifyHeading(block.content);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    const id = count === 1 ? base : `${base}-${count}`;
    const range = sectionRangeAt(blocks, index);
    const inSection = new Set(blocks.slice(range.start, range.end).map((b) => b.id));
    entries.push({
      id,
      level: block.level ?? 1,
      title: block.content,
      line: block.startLine,
      annotations: annotations.filter((a) => a.blockId && inSection.has(a.blockId)).length,
      blockId: block.id,
    });
  });
  return entries;
}

export function findSection(outline: readonly OutlineEntry[], sectionId: string): OutlineEntry | null {
  const wanted = sectionId.trim();
  return outline.find((entry) => entry.id === wanted || entry.blockId === wanted)
    ?? outline.find((entry) => entry.title.trim().toLowerCase() === wanted.toLowerCase())
    ?? null;
}

/** The section (from the outline) containing `blockId`, or null for unanchored / document-level. */
export function sectionForBlock(blocks: readonly Block[], outline: readonly OutlineEntry[], blockId: string | undefined): OutlineEntry | null {
  if (!blockId) return null;
  const index = blocks.findIndex((b) => b.id === blockId);
  if (index < 0) return null;
  const headingIndex = headingIndexFor(blocks, index);
  if (headingIndex < 0) return null;
  const headingId = blocks[headingIndex]!.id;
  return outline.find((entry) => entry.blockId === headingId) ?? null;
}

/** Character offset at which each 1-based line starts. */
export function lineStartOffsets(text: string): number[] {
  const offsets = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) offsets.push(i + 1);
  return offsets;
}

function offsetOfLine(offsets: number[], line: number, total: number): number {
  if (line <= 1) return 0;
  return offsets[line - 1] ?? total;
}

/** The text of one section as a slice of the full document, with its absolute offset. */
export function sectionSlice(text: string, blocks: readonly Block[], section: OutlineEntry): { text: string; offset: number } {
  const headingIndex = blocks.findIndex((b) => b.id === section.blockId);
  if (headingIndex < 0) return { text: '', offset: 0 };
  const range = sectionRangeAt(blocks, headingIndex);
  const offsets = lineStartOffsets(text);
  const start = offsetOfLine(offsets, blocks[headingIndex]!.startLine, text.length);
  const end = range.end < blocks.length ? offsetOfLine(offsets, blocks[range.end]!.startLine, text.length) : text.length;
  return { text: text.slice(start, end), offset: start };
}

export interface TextWindow {
  text: string;
  offset: number;
  length: number;
  total: number;
  truncated: boolean;
  /** Absolute offset to continue from, present only when truncated. */
  nextOffset?: number;
}

/**
 * Window `text` from `offset` to at most `maxChars`, cutting at the last
 * block boundary (a block's first character) inside the budget when one
 * exists past the start, else hard-cutting.
 */
export function windowText(text: string, blocks: readonly Block[], offset: number, maxChars: number, base = 0): TextWindow {
  const total = text.length;
  const start = Math.max(0, Math.min(offset, total));
  if (total - start <= maxChars) {
    return { text: text.slice(start), offset: start, length: total - start, total, truncated: false };
  }
  const limit = start + maxChars;
  const offsets = lineStartOffsets(text);
  let cut = -1;
  for (const block of blocks) {
    const at = offsetOfLine(offsets, block.startLine - base, total);
    if (at > start && at <= limit) cut = Math.max(cut, at);
    if (at > limit) break;
  }
  if (cut <= start) cut = limit;
  return { text: text.slice(start, cut), offset: start, length: cut - start, total, truncated: true, nextOffset: cut };
}

export interface QuoteMatch {
  blockId: string;
  blockIndex: number;
  startOffset: number;
  endOffset: number;
  /** The exact document text matched (whitespace as in the block). */
  originalText: string;
  /** About 120 characters either side of the match. */
  context: string;
}

export type QuoteResolution =
  | { status: 'found'; match: QuoteMatch }
  | { status: 'ambiguous'; candidates: QuoteMatch[] }
  | { status: 'not_found' };

const SEARCHABLE: ReadonlySet<Block['type']> = new Set(['paragraph', 'heading', 'blockquote', 'list-item', 'code', 'table', 'directive', 'math']);

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findInContent(content: string, quote: string): { start: number; end: number } | null {
  const exact = content.indexOf(quote);
  if (exact >= 0) return { start: exact, end: exact + quote.length };
  const tokens = quote.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const pattern = new RegExp(tokens.map(escapeRegex).join('\\s+'));
  const loose = pattern.exec(content);
  if (!loose) return null;
  return { start: loose.index, end: loose.index + loose[0].length };
}

export function contextAround(content: string, start: number, end: number, radius = CONTEXT_RADIUS): string {
  const from = Math.max(0, start - radius);
  const to = Math.min(content.length, end + radius);
  const before = from > 0 ? '…' : '';
  const after = to < content.length ? '…' : '';
  return `${before}${content.slice(from, to).replace(/\s+/g, ' ')}${after}`;
}

/**
 * Anchor a quote on the blocks: exact substring first, then a whitespace-
 * tolerant match. Two blocks matching without a section is `ambiguous`
 * with both contexts as candidates; `section` restricts the search.
 */
export function resolveQuote(
  blocks: readonly Block[],
  quote: string,
  section?: { blockId: string } | null,
): QuoteResolution {
  const trimmed = quote.trim();
  if (!trimmed) return { status: 'not_found' };
  let start = 0;
  let end = blocks.length;
  if (section) {
    const headingIndex = blocks.findIndex((b) => b.id === section.blockId);
    if (headingIndex >= 0) {
      const range = sectionRangeAt(blocks, headingIndex);
      start = range.start;
      end = range.end;
    }
  }
  const matches: QuoteMatch[] = [];
  for (let i = start; i < end; i++) {
    const block = blocks[i]!;
    if (!SEARCHABLE.has(block.type)) continue;
    const hit = findInContent(block.content, trimmed);
    if (!hit) continue;
    matches.push({
      blockId: block.id,
      blockIndex: i,
      startOffset: hit.start,
      endOffset: hit.end,
      originalText: block.content.slice(hit.start, hit.end),
      context: contextAround(block.content, hit.start, hit.end),
    });
  }
  if (matches.length === 0) return { status: 'not_found' };
  if (matches.length === 1) return { status: 'found', match: matches[0]! };
  return { status: 'ambiguous', candidates: matches };
}

/** Context for an existing annotation: the block text around its quote, or the quote itself. */
export function contextForAnnotation(blocks: readonly Block[], annotation: Annotation): string {
  const block = blocks.find((b) => b.id === annotation.blockId);
  const quote = annotation.originalText ?? '';
  if (!block || !quote) return quote.replace(/\s+/g, ' ');
  const hit = findInContent(block.content, quote.trim());
  if (!hit) return quote.replace(/\s+/g, ' ');
  return contextAround(block.content, hit.start, hit.end);
}

export function capText(text: string | undefined, max = ANNOTATION_TEXT_MAX): { text: string; truncated: boolean } {
  const value = text ?? '';
  if (value.length <= max) return { text: value, truncated: false };
  return { text: value.slice(0, max), truncated: true };
}

/** Plain text of an HTML document, for quote verification on raw-HTML surfaces. */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
