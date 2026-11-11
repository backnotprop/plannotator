import { diffLines, diffWordsWithSpace, type Change } from "diff";
import { parseMarkdownToBlocks } from "./parser";
import type { Block } from "../types";

export interface InlineDiffToken {
  type: "added" | "removed" | "unchanged";
  value: string;
}

export interface InlineDiffWrap {
  type: "heading" | "paragraph" | "list-item";
  level?: number;
  ordered?: boolean;
  listLevel?: number;
  checked?: boolean;
  orderedStart?: number;
}

export interface PlanDiffBlock {
  type: "added" | "removed" | "modified" | "unchanged";
  content: string;
  oldContent?: string;
  lines: number;
  inlineTokens?: InlineDiffToken[];
  inlineWrap?: InlineDiffWrap;
  oldStart?: number;
  oldEnd?: number;
  newStart?: number;
  newEnd?: number;
}

export interface PlanDiffStats {
  additions: number;
  deletions: number;
  modifications: number;
}

function countLines(text: string): number {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    return lines.length - 1;
  }
  return lines.length;
}

function trimmedLineRange(
  value: string,
  start: number
): { start?: number; end?: number } {
  const lines = value.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  let first = 0;
  while (first < lines.length && lines[first].trim() === "") first++;
  if (first >= lines.length) return {};
  let last = lines.length - 1;
  while (last > first && lines[last].trim() === "") last--;
  return { start: start + first, end: start + last };
}

function oldRange(value: string, start: number): Pick<PlanDiffBlock, "oldStart" | "oldEnd"> {
  const r = trimmedLineRange(value, start);
  return r.start === undefined ? {} : { oldStart: r.start, oldEnd: r.end };
}

function newRange(value: string, start: number): Pick<PlanDiffBlock, "newStart" | "newEnd"> {
  const r = trimmedLineRange(value, start);
  return r.start === undefined ? {} : { newStart: r.start, newEnd: r.end };
}

const INLINE_DIFFABLE_TYPES = new Set<Block["type"]>([
  "paragraph",
  "heading",
  "list-item",
]);

function structuralFieldsMatch(a: Block, b: Block): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "heading") return a.level === b.level;
  if (a.type === "list-item") {
    return (
      a.ordered === b.ordered &&
      a.level === b.level &&
      a.checked === b.checked
    );
  }
  return true; // paragraph
}

const SENTINEL_PREFIX = "__PLDIFFCODE";
const SENTINEL_SUFFIX = "PLDIFFCODE__";
const SENTINEL_PATTERN = /__PLDIFFCODE\d+PLDIFFCODE__/g;
const CODE_SPAN_PATTERN = /`[^`]+`/g;

/**
 * Replace every inline-code span in `text` with a numeric sentinel so that diffWordsWithSpace
 * treats the span as an atomic token.
 */
function sentinelFor(id: number): string {
  return `${SENTINEL_PREFIX}${id}${SENTINEL_SUFFIX}`;
}

function substituteCodeSpans(
  text: string,
  codeMap: Map<string, string>,
  codeToId: Map<string, number>
): string {
  return text.replace(CODE_SPAN_PATTERN, (match) => {
    let id = codeToId.get(match);
    if (id === undefined) {
      id = codeToId.size;
      codeMap.set(sentinelFor(id), match);
      codeToId.set(match, id);
    }
    return sentinelFor(id);
  });
}

function restoreCodeSpans(
  value: string,
  codeMap: Map<string, string>
): string {
  if (codeMap.size === 0) return value;
  return value.replace(SENTINEL_PATTERN, (m) => codeMap.get(m) ?? m);
}

const LINK_SENTINEL_PREFIX = "__PLDIFFLINK";
const LINK_SENTINEL_SUFFIX = "PLDIFFLINK__";
const LINK_SENTINEL_PATTERN = /__PLDIFFLINK\d+PLDIFFLINK__/g;
const LINK_PATTERN = /\[[^\]]+\]\([^)]+\)/g;

function linkSentinelFor(id: number): string {
  return `${LINK_SENTINEL_PREFIX}${id}${LINK_SENTINEL_SUFFIX}`;
}

function substituteLinks(
  text: string,
  linkMap: Map<string, string>,
  linkToId: Map<string, number>
): string {
  return text.replace(LINK_PATTERN, (match) => {
    let id = linkToId.get(match);
    if (id === undefined) {
      id = linkToId.size;
      linkMap.set(linkSentinelFor(id), match);
      linkToId.set(match, id);
    }
    return linkSentinelFor(id);
  });
}

function restoreLinks(
  value: string,
  linkMap: Map<string, string>
): string {
  if (linkMap.size === 0) return value;
  return value.replace(LINK_SENTINEL_PATTERN, (m) => linkMap.get(m) ?? m);
}

const FENCE_SENTINEL_PREFIX = "__PLDIFFFENCE";
const FENCE_SENTINEL_SUFFIX = "PLDIFFFENCE__";
const FENCE_SENTINEL_PATTERN = /__PLDIFFFENCE\d+PLDIFFFENCE__/g;
const FENCE_BLOCK_PATTERN = /^(`{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gm;

function fenceSentinelFor(id: number): string {
  return `${FENCE_SENTINEL_PREFIX}${id}${FENCE_SENTINEL_SUFFIX}`;
}

function substituteFencedBlocks(
  text: string,
  fenceMap: Map<string, string>,
  fenceToId: Map<string, number>
): string {
  return text.replace(FENCE_BLOCK_PATTERN, (match) => {
    let id = fenceToId.get(match);
    if (id === undefined) {
      id = fenceToId.size;
      fenceMap.set(fenceSentinelFor(id), match);
      fenceToId.set(match, id);
    }
    return fenceSentinelFor(id);
  });
}

// Diffed line by line, an edit inside the quoted fence split it into chunks holding half a fence
// each, so one chunk opened a fence it never closed and rendered the prose after it as code.
const QUOTE_RUN_PATTERN = /^[ \t]*>[^\n]*(?:\n[ \t]*>[^\n]*)*/gm;
const QUOTED_FENCE_LINE = /^[ \t]*(?:>[ \t]?)+[ \t]*`{3,}/m;

function substituteQuotedFenceRuns(
  text: string,
  fenceMap: Map<string, string>,
  fenceToId: Map<string, number>
): string {
  return text.replace(QUOTE_RUN_PATTERN, (match) => {
    if (!QUOTED_FENCE_LINE.test(match)) return match;
    let id = fenceToId.get(match);
    if (id === undefined) {
      id = fenceToId.size;
      fenceMap.set(fenceSentinelFor(id), match);
      fenceToId.set(match, id);
    }
    return fenceSentinelFor(id);
  });
}

function restoreFencedBlocks(
  value: string,
  fenceMap: Map<string, string>
): string {
  if (fenceMap.size === 0) return value;
  return value.replace(FENCE_SENTINEL_PATTERN, (m) => fenceMap.get(m) ?? m);
}

const PAIR_SENTINEL_PREFIX = "PLDIFFEMPH";
const PAIR_SENTINEL_PATTERN = /PLDIFFEMPH\d+ZZ/g;

const PAIR_PATTERNS: Array<{ delim: string; regex: RegExp }> = [
  { delim: "***", regex: /(?<!\w)\*\*\*(\S(?:[\s\S]*?\S)?)\*\*\*(?!\w)/g },
  {
    delim: "___",
    regex: /(?<![A-Za-z0-9])___(\S(?:[\s\S]*?\S)?)___(?![A-Za-z0-9])/g,
  },
  { delim: "**", regex: /(?<!\w)\*\*(\S(?:[\s\S]*?\S)?)\*\*(?!\w)/g },
  {
    delim: "__",
    regex: /(?<![A-Za-z0-9])__(\S(?:[\s\S]*?\S)?)__(?![A-Za-z0-9])/g,
  },
  { delim: "~~", regex: /(?<!\w)~~(\S(?:[\s\S]*?\S)?)~~(?!\w)/g },
  { delim: "*", regex: /(?<!\w)\*(\S(?:[^*]*?\S)?)\*(?!\w)/g },
  {
    delim: "_",
    regex: /(?<![A-Za-z0-9])_(\S(?:[^_]*?\S)?)_(?![A-Za-z0-9])/g,
  },
];

function pairSentinelFor(id: number): string {
  return `${PAIR_SENTINEL_PREFIX}${id}ZZ`;
}

function substituteEmphasisPairs(
  text: string,
  pairMap: Map<string, string>,
  pairToId: Map<string, number>
): string {
  for (const { regex } of PAIR_PATTERNS) {
    text = text.replace(regex, (match) => {
      let id = pairToId.get(match);
      if (id === undefined) {
        id = pairToId.size;
        pairMap.set(pairSentinelFor(id), match);
        pairToId.set(match, id);
      }
      return pairSentinelFor(id);
    });
  }
  return text;
}

function restoreEmphasisPairs(
  value: string,
  pairMap: Map<string, string>
): string {
  if (pairMap.size === 0) return value;
  return value.replace(PAIR_SENTINEL_PATTERN, (m) => pairMap.get(m) ?? m);
}

const HYPHEN_SENTINEL = "PLDIFFHYZZ";
const HYPHEN_SENTINEL_PATTERN = /PLDIFFHYZZ/g;
const HYPHEN_INFIX_PATTERN = /(?<=\w)-(?=\w)/g;

function substituteHyphens(text: string): string {
  return text.replace(HYPHEN_INFIX_PATTERN, HYPHEN_SENTINEL);
}

function restoreHyphens(value: string): string {
  return value.replace(HYPHEN_SENTINEL_PATTERN, "-");
}

const THIN_UNCHANGED_RE =
  /^[\s,.;:—–"'‘’“”]+$/;

function isChangeToken(t: InlineDiffToken): boolean {
  return t.type !== "unchanged";
}

function isThinUnchangedToken(t: InlineDiffToken): boolean {
  return t.type === "unchanged" && THIN_UNCHANGED_RE.test(t.value);
}

function coalesceChangeTokens(tokens: InlineDiffToken[]): InlineDiffToken[] {
  const out: InlineDiffToken[] = [];
  let i = 0;
  while (i < tokens.length) {
    if (!isChangeToken(tokens[i])) {
      out.push(tokens[i]);
      i++;
      continue;
    }
    let lastChangeEnd = i;
    while (
      lastChangeEnd + 1 < tokens.length &&
      isChangeToken(tokens[lastChangeEnd + 1])
    ) {
      lastChangeEnd++;
    }
    let siteCount = 1;
    while (true) {
      let scan = lastChangeEnd + 1;
      while (scan < tokens.length && isThinUnchangedToken(tokens[scan])) scan++;
      if (scan < tokens.length && isChangeToken(tokens[scan])) {
        let newEnd = scan;
        while (
          newEnd + 1 < tokens.length &&
          isChangeToken(tokens[newEnd + 1])
        ) {
          newEnd++;
        }
        lastChangeEnd = newEnd;
        siteCount++;
      } else {
        break;
      }
    }
    if (siteCount >= 2) {
      let removedText = "";
      let addedText = "";
      for (let j = i; j <= lastChangeEnd; j++) {
        const t = tokens[j];
        if (t.type === "removed") removedText += t.value;
        else if (t.type === "added") addedText += t.value;
        else {
          removedText += t.value;
          addedText += t.value;
        }
      }
      if (removedText.length > 0)
        out.push({ type: "removed", value: removedText });
      if (addedText.length > 0) out.push({ type: "added", value: addedText });
    } else {
      for (let j = i; j <= lastChangeEnd; j++) out.push(tokens[j]);
    }
    i = lastChangeEnd + 1;
  }
  return out;
}

function wrapFromBlock(block: Block): InlineDiffWrap {
  if (block.type === "heading") {
    return { type: "heading", level: block.level };
  }
  if (block.type === "list-item") {
    return {
      type: "list-item",
      ordered: block.ordered,
      listLevel: block.level,
      checked: block.checked,
      orderedStart: block.orderedStart,
    };
  }
  return { type: "paragraph" };
}

/** Second-pass word diff on the inline content of a modified block. */
export function computeInlineDiff(
  oldContent: string,
  newContent: string
): { tokens: InlineDiffToken[]; wrap: InlineDiffWrap } | null {
  const oldBlocks = parseMarkdownToBlocks(oldContent);
  const newBlocks = parseMarkdownToBlocks(newContent);

  if (oldBlocks.length !== 1 || newBlocks.length !== 1) return null;

  const [a] = oldBlocks;
  const [b] = newBlocks;

  if (!INLINE_DIFFABLE_TYPES.has(a.type)) return null;
  if (!structuralFieldsMatch(a, b)) return null;

  const codeMap = new Map<string, string>();
  const codeToId = new Map<string, number>();
  const linkMap = new Map<string, string>();
  const linkToId = new Map<string, number>();
  const pairMap = new Map<string, string>();
  const pairToId = new Map<string, number>();

  let substA = substituteCodeSpans(a.content, codeMap, codeToId);
  let substB = substituteCodeSpans(b.content, codeMap, codeToId);
  substA = substituteLinks(substA, linkMap, linkToId);
  substB = substituteLinks(substB, linkMap, linkToId);
  substA = substituteEmphasisPairs(substA, pairMap, pairToId);
  substB = substituteEmphasisPairs(substB, pairMap, pairToId);
  substA = substituteHyphens(substA);
  substB = substituteHyphens(substB);

  const changes = diffWordsWithSpace(substA, substB);
  const rawTokens: InlineDiffToken[] = changes.map((c) => ({
    type: c.added ? "added" : c.removed ? "removed" : "unchanged",
    value: restoreCodeSpans(
      restoreLinks(
        restoreEmphasisPairs(restoreHyphens(c.value), pairMap),
        linkMap
      ),
      codeMap
    ),
  }));

  const tokens = coalesceChangeTokens(rawTokens);

  // Build the render wrapper from the NEW block so ordered-list items that renumbered (e.g., 3. →
  // 4. because a step was inserted above) display the current plan's numeral rather than the
  // previous version's.
  return { tokens, wrap: wrapFromBlock(b) };
}

/**
 * Past it the diff view stacks old over new, so a rewritten block of a large config file never
 * runs one big word diff on the main thread.
 */
export const CODE_INLINE_DIFF_LIMIT = 8 * 1024;

/**
 * Word-level tokens for a modified block of a config or data file (`renderAs: "code"`), or null
 * when the pair is too long to diff inline.
 */
export function computeCodeInlineDiff(oldText: string, newText: string): InlineDiffToken[] | null {
  if (oldText.length + newText.length > CODE_INLINE_DIFF_LIMIT) return null;
  // A chunk ends with its line's newline; diffing without it keeps a token from
  // straddling the end of the block.
  const strip = (text: string) => text.replace(/\n$/, "");
  return diffWordsWithSpace(strip(oldText), strip(newText)).map((c) => ({
    type: c.added ? "added" : c.removed ? "removed" : "unchanged",
    value: c.value,
  }));
}

export function computePlanDiff(
  oldText: string,
  newText: string
): { blocks: PlanDiffBlock[]; stats: PlanDiffStats } {
  const fenceMap = new Map<string, string>();
  const fenceToId = new Map<string, number>();
  const substOld = substituteQuotedFenceRuns(
    substituteFencedBlocks(oldText, fenceMap, fenceToId),
    fenceMap,
    fenceToId,
  );
  const substNew = substituteQuotedFenceRuns(
    substituteFencedBlocks(newText, fenceMap, fenceToId),
    fenceMap,
    fenceToId,
  );

  const rawChanges: Change[] = diffLines(substOld, substNew);
  const changes: Change[] = rawChanges.map((c) => ({
    ...c,
    value: restoreFencedBlocks(c.value, fenceMap),
  }));

  const blocks: PlanDiffBlock[] = [];
  const stats: PlanDiffStats = { additions: 0, deletions: 0, modifications: 0 };
  let oldLine = 1;
  let newLine = 1;

  for (let i = 0; i < changes.length; i++) {
    const change = changes[i];
    const next = changes[i + 1];

    if (change.removed && next?.added) {
      const inline = computeInlineDiff(change.value, next.value);
      blocks.push({
        type: "modified",
        content: next.value,
        oldContent: change.value,
        lines: countLines(next.value),
        ...(inline ? { inlineTokens: inline.tokens, inlineWrap: inline.wrap } : {}),
        ...oldRange(change.value, oldLine),
        ...newRange(next.value, newLine),
      });
      oldLine += countLines(change.value);
      newLine += countLines(next.value);
      stats.modifications++;
      stats.additions += countLines(next.value);
      stats.deletions += countLines(change.value);
      i++; // skip the next (add) since we consumed it
    } else if (change.added) {
      blocks.push({
        type: "added",
        content: change.value,
        lines: countLines(change.value),
        ...newRange(change.value, newLine),
      });
      newLine += countLines(change.value);
      stats.additions += countLines(change.value);
    } else if (change.removed) {
      blocks.push({
        type: "removed",
        content: change.value,
        lines: countLines(change.value),
        ...oldRange(change.value, oldLine),
      });
      oldLine += countLines(change.value);
      stats.deletions += countLines(change.value);
    } else {
      blocks.push({
        type: "unchanged",
        content: change.value,
        lines: countLines(change.value),
        ...oldRange(change.value, oldLine),
        ...newRange(change.value, newLine),
      });
      oldLine += countLines(change.value);
      newLine += countLines(change.value);
    }
  }

  return { blocks, stats };
}

/** A run of unchanged sections hidden behind one row. */
export interface PlanDiffFold {
  kind: "fold";
  key: string;
  pieces: PlanDiffBlock[];
  sectionCount: number;
  headings: string[];
  oldStart?: number;
  oldEnd?: number;
  newStart?: number;
  newEnd?: number;
}

export type PlanDiffSegment =
  | { kind: "block"; block: PlanDiffBlock; index: number }
  | PlanDiffFold;

const MAX_FOLD_HEADINGS = 3;

function plainHeadingText(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

interface UnchangedPiece {
  piece: PlanDiffBlock;
  heading?: string;
}

function splitUnchangedChunk(block: PlanDiffBlock): UnchangedPiece[] {
  const content = block.content;
  const parsed = parseMarkdownToBlocks(content);
  if (parsed.length <= 1) {
    const only = parsed[0];
    return [only?.type === "heading" ? { piece: block, heading: plainHeadingText(only.content) } : { piece: block }];
  }

  const lineOffsets: number[] = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") lineOffsets.push(i + 1);
  }
  const lineCount = countLines(content);
  const starts = Array.from(
    new Set(parsed.map((b) => b.startLine).filter((line) => line >= 1 && line <= lineCount))
  ).sort((a, b) => a - b);
  if (starts.length === 0) return [{ piece: block }];
  starts[0] = 1;

  const contentLines = content.split("\n");
  let leadingBlank = 0;
  while (leadingBlank < contentLines.length && contentLines[leadingBlank].trim() === "") leadingBlank++;
  const oldBase = block.oldStart !== undefined ? block.oldStart - leadingBlank : undefined;
  const newBase = block.newStart !== undefined ? block.newStart - leadingBlank : undefined;

  const headingByStart = new Map<number, string>();
  for (const b of parsed) {
    if (b.type === "heading" && !headingByStart.has(b.startLine)) {
      headingByStart.set(b.startLine, plainHeadingText(b.content));
    }
  }

  return starts.map((startLine, i) => {
    const nextStart = starts[i + 1];
    const from = lineOffsets[startLine - 1] ?? content.length;
    const to = nextStart !== undefined ? lineOffsets[nextStart - 1] ?? content.length : content.length;
    const pieceContent = content.slice(from, to);
    const piece: PlanDiffBlock = {
      type: "unchanged",
      content: pieceContent,
      lines: countLines(pieceContent),
      ...(oldBase !== undefined ? oldRange(pieceContent, oldBase + startLine - 1) : {}),
      ...(newBase !== undefined ? newRange(pieceContent, newBase + startLine - 1) : {}),
    };
    const heading = headingByStart.get(i === 0 ? parsed[0].startLine : startLine);
    return heading !== undefined ? { piece, heading } : { piece };
  });
}

function spanOf(pieces: PlanDiffBlock[]): Pick<PlanDiffBlock, "oldStart" | "oldEnd" | "newStart" | "newEnd"> {
  const withOld = pieces.filter((p) => p.oldStart !== undefined);
  const withNew = pieces.filter((p) => p.newStart !== undefined);
  return {
    ...(withOld.length > 0
      ? { oldStart: withOld[0].oldStart, oldEnd: withOld[withOld.length - 1].oldEnd }
      : {}),
    ...(withNew.length > 0
      ? { newStart: withNew[0].newStart, newEnd: withNew[withNew.length - 1].newEnd }
      : {}),
  };
}

function joinPieces(pieces: PlanDiffBlock[]): PlanDiffBlock {
  if (pieces.length === 1) return pieces[0];
  const content = pieces.map((p) => p.content).join("");
  return { type: "unchanged", content, lines: countLines(content), ...spanOf(pieces) };
}

/** Fold long runs of unchanged sections behind one row, the way a code diff folds unmodified lines. */
export function foldUnchangedPlanDiff(
  blocks: PlanDiffBlock[],
  options: { context?: number; minHidden?: number } = {}
): PlanDiffSegment[] {
  const context = Math.max(0, options.context ?? 1);
  const minHidden = Math.max(1, options.minHidden ?? 2);
  const segments: PlanDiffSegment[] = [];

  blocks.forEach((block, index) => {
    if (block.type !== "unchanged") {
      segments.push({ kind: "block", block, index });
      return;
    }
    const pieces = splitUnchangedChunk(block);
    const head = index > 0 ? Math.min(context, pieces.length) : 0;
    const tail = index < blocks.length - 1 ? Math.min(context, pieces.length - head) : 0;
    const hidden = pieces.length - head - tail;
    if (hidden < minHidden) {
      segments.push({ kind: "block", block, index });
      return;
    }
    if (head > 0) {
      segments.push({ kind: "block", block: joinPieces(pieces.slice(0, head).map((p) => p.piece)), index });
    }
    const folded = pieces.slice(head, head + hidden);
    const foldPieces = folded.map((p) => p.piece);
    segments.push({
      kind: "fold",
      key: `fold-${index}-${head}`,
      pieces: foldPieces,
      sectionCount: foldPieces.length,
      headings: folded
        .map((p) => p.heading)
        .filter((h): h is string => !!h)
        .slice(0, MAX_FOLD_HEADINGS),
      ...spanOf(foldPieces),
    });
    if (tail > 0) {
      segments.push({
        kind: "block",
        block: joinPieces(pieces.slice(head + hidden).map((p) => p.piece)),
        index,
      });
    }
  });

  return segments;
}
