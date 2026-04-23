/**
 * Plan Diff Engine
 *
 * Computes line-level diffs between two plan versions, then (for modified
 * blocks that qualify) computes a second-pass word-level diff so the UI
 * can render inline insertions/deletions in context instead of showing
 * the whole old block struck-through above the whole new block.
 *
 * Two-pass hierarchical diff: `diffLines` outer + `diffWordsWithSpace`
 * inner, same shape as `git diff --word-diff`.
 */

import { diffLines, diffWordsWithSpace, type Change } from "diff";
import { parseMarkdownToBlocks } from "./parser";
import type { Block } from "../types";

export interface InlineDiffToken {
  type: "added" | "removed" | "unchanged";
  value: string;
}

export interface InlineDiffWrap {
  type: "heading" | "paragraph" | "list-item";
  /** For headings */
  level?: number;
  /** For list items */
  ordered?: boolean;
  listLevel?: number;
  checked?: boolean;
  orderedStart?: number;
}

export interface PlanDiffBlock {
  /** What kind of change this block represents */
  type: "added" | "removed" | "modified" | "unchanged";
  /** The content for this block (new content for added/modified, old content for removed, full content for unchanged) */
  content: string;
  /** For 'modified' blocks: the old content that was replaced */
  oldContent?: string;
  /** Number of lines in this block */
  lines: number;
  /** Present only on 'modified' blocks that pass the qualification gate for word-level inline diff. */
  inlineTokens?: InlineDiffToken[];
  /** Structural wrap metadata paired with inlineTokens. */
  inlineWrap?: InlineDiffWrap;
}

export interface PlanDiffStats {
  additions: number;
  deletions: number;
  modifications: number;
}

/**
 * Count lines in a string (handles trailing newline correctly).
 */
function countLines(text: string): number {
  const lines = text.split("\n");
  // diffLines often includes a trailing empty string from the final newline
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    return lines.length - 1;
  }
  return lines.length;
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

// Sentinel used to replace inline-code spans before word-diffing. Must be
// made entirely of word characters ([A-Za-z0-9_]) so diffWordsWithSpace
// treats it as a single atomic token — word-boundary splits (\b) happen at
// transitions between word and non-word chars, so any non-word character
// inside the sentinel would cause the tokenizer to fragment it mid-diff
// and defeat the round-trip. Collision with real plan text is implausible.
const SENTINEL_PREFIX = "__PLDIFFCODE";
const SENTINEL_SUFFIX = "PLDIFFCODE__";
const SENTINEL_PATTERN = /__PLDIFFCODE\d+PLDIFFCODE__/g;
const CODE_SPAN_PATTERN = /`[^`]+`/g;

/**
 * Replace every inline-code span in `text` with a numeric sentinel so that
 * diffWordsWithSpace treats the span as an atomic token. Identical spans on
 * both sides share the same sentinel, so they pair as unchanged. Different
 * spans get different sentinels and diff as whole-span add/remove tokens.
 *
 * The sentinel sits in place of the backticks, so diff markers injected
 * later by the unified-string builder never land *between* backticks — which
 * is the hazard the old backtick gate was protecting against.
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

// Link sentinel. Same trick as inline-code spans but applied to markdown
// links [text](url) so diffWordsWithSpace treats each whole link atomically.
// Without this pass, a URL-only change like [docs](old) → [docs](new) would
// tokenize on "old"/"new" and inject <ins>/<del> markers into the raw
// Markdown, producing `[docs](https://<del>old</del><ins>new</ins>.example)`.
// InlineMarkdown's link regex would then swallow those tags into the href,
// rendering an unchanged-looking link with a broken URL. Atomizing the link
// means URL-only changes render as old-link-struck + new-link-green, each
// rendered as a real, clickable anchor. Tradeoff: word-level highlighting
// inside link anchor text goes away — the whole link is the diff unit.
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

// Fenced-block sentinel. Same idea as the inline-code sentinel above, but
// applied at block granularity BEFORE diffLines runs. Without this pass,
// diffLines finds common lines like the closing ```, a shared `}`, or a
// blank line between two otherwise-rewritten code blocks, and fragments
// the block into 4-6 separate diff chunks. Each chunk then renders
// independently (half a fence here, a stray `}` paragraph there, an
// empty <pre> where the lone closing ``` landed) — the visually "messy"
// cascade after case ⑩. By collapsing each whole fenced block to a
// single-line sentinel, diffLines treats the block atomically: it
// becomes one modified pair, rendered as a clean before/after.
// Capture the opening fence's backtick count and back-reference it on the
// closer so nested fences (e.g., 4-backtick outer wrapping a 3-backtick
// example) are matched atomically — the inner closer has fewer backticks
// than \1 and is correctly skipped by the lazy content scanner.
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

function restoreFencedBlocks(
  value: string,
  fenceMap: Map<string, string>
): string {
  if (fenceMap.size === 0) return value;
  return value.replace(FENCE_SENTINEL_PATTERN, (m) => fenceMap.get(m) ?? m);
}

// Inline-emphasis sentinels. Each balanced markdown emphasis pair
// (`**...**`, `__...__`, `~~...~~`, `*...*`, `_..._`) gets a unique
// word-char sentinel before `diffWordsWithSpace` runs so that:
//
//   - The whole phrase diffs as a single atomic token (sentinels contain
//     no whitespace, and `diffWordsWithSpace` splits on whitespace).
//   - Identical phrases on both sides pair as unchanged via sentinel
//     identity; different phrases pair as a single remove + add.
//
// This is the "pair" form of atomization discussed in the bold-phrase
// design doc: it reliably handles both single-word (`**important**`) and
// multi-word (`**preliminary analysis**`) emphasis without fragmenting
// the closing delimiter into unchanged-tail tokens, which the earlier
// single-delimiter substitution couldn't achieve.
//
// Pair matching uses CommonMark-ish flanking rules: opening delimiter
// must not be preceded by a word char and must be followed by a non-space
// char; closing delimiter must be preceded by a non-space char and not
// followed by a word char. Content is matched lazily. Stray unbalanced
// delimiters (e.g., `2**3` arithmetic) don't match and are left verbatim,
// preserving existing behaviour.
//
// Longest-first ordering (`**`/`__`/`~~` before `*`/`_`) prevents single
// delimiters from eating the inside of a double-delim pair.
const PAIR_SENTINEL_PREFIX = "PLDIFFEMPH";
const PAIR_SENTINEL_PATTERN = /PLDIFFEMPH\d+ZZ/g;

const PAIR_PATTERNS: Array<{ delim: string; regex: RegExp }> = [
  // Triples first so `***foo***` (bold+italic) atomizes as one token
  // instead of being split into `**` pair plus a leftover `*`.
  { delim: "***", regex: /(?<!\w)\*\*\*(\S(?:[\s\S]*?\S)?)\*\*\*(?!\w)/g },
  {
    delim: "___",
    regex: /(?<![A-Za-z0-9])___(\S(?:[\s\S]*?\S)?)___(?![A-Za-z0-9])/g,
  },
  { delim: "**", regex: /(?<!\w)\*\*(\S(?:[\s\S]*?\S)?)\*\*(?!\w)/g },
  // `__` with word-boundary guard to protect intraword underscores
  // (e.g., `my__var__name`). Same for `_` below.
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

// Hyphen sentinel. Hyphens between word chars (e.g. `ninety-five`,
// `64-byte`, `state-of-the-art`) are semantic compound words, not two
// tokens. `diffWordsWithSpace` splits on word boundaries, so without
// this pass `ninety-five` → `ninety-nine` fragments into an unchanged
// `ninety-` prefix and a swapped `five`/`nine` suffix, producing
// visually noisy partial-word diffs that confuse readers.
//
// Replace each infix hyphen with a word-char marker before diffing and
// restore afterwards. The sentinel is a fixed string (no per-instance
// id) because all hyphens restore to the same character — uniqueness
// isn't needed, only opacity to the word-boundary tokenizer.
//
// Runs AFTER the code/link/emphasis sentinel passes so hyphens inside
// those constructs (e.g. `**state-of-the-art**`, `[link-text](url)`)
// are already hidden and not re-processed here.
const HYPHEN_SENTINEL = "PLDIFFHYZZ";
const HYPHEN_SENTINEL_PATTERN = /PLDIFFHYZZ/g;
const HYPHEN_INFIX_PATTERN = /(?<=\w)-(?=\w)/g;

function substituteHyphens(text: string): string {
  return text.replace(HYPHEN_INFIX_PATTERN, HYPHEN_SENTINEL);
}

function restoreHyphens(value: string): string {
  return value.replace(HYPHEN_SENTINEL_PATTERN, "-");
}

// Coalescing pass (Commit 2). After `diffWordsWithSpace` and sentinel
// restoration, adjacent word-level changes separated by only "thin"
// unchanged tokens (whitespace + closed punctuation) get merged into a
// single phrase-level swap. This turns alternating red/green word-noise
// into a readable before/after, and rescues the A3 regression where
// mashed sentinel-plus-word tokens would otherwise render as fragmented
// literal delimiters inside colored tags.
//
// Definitions (from the design doc):
//   - change site: contiguous non-unchanged run
//   - thin unchanged: value consists only of whitespace + { , . ; : — – " ' }
//     (parens/brackets EXCLUDED so inline links stay as hard boundaries)
//   - dirty run: maximal sequence of change sites joined by thin-unchanged
// Coalesce when a dirty run has ≥2 change sites (asymmetric counts allowed).
// Single-site dirty runs pass through so isolated swaps keep word-level
// highlighting.
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
    // Scan first change site.
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

/**
 * Second-pass word diff on the inline content of a modified block.
 * Returns null (falls back to block-level rendering) if the block doesn't
 * pass the qualification gate. Gate is whitelist-based on block type:
 * only single-block prose-like modifications get the inline treatment.
 */
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

  // Atomic passes before word-diffing (longest-lived sentinels first):
  //   1. Inline code spans — protect backtick-wrapped content so diff markers
  //      never land between backticks (see SENTINEL_PREFIX comment).
  //   2. Markdown links [text](url) — protect the whole link so diff markers
  //      never land inside the link's bracketed text or parenthesized href.
  //   3. Balanced emphasis pairs (**…**, __…__, ~~…~~, *…*, _…_) — replace
  //      each whole pair with a unique word-char sentinel so the phrase
  //      diffs atomically, avoiding the fragmented/unbalanced-delimiter
  //      output that whitespace-splitting `diffWordsWithSpace` produces
  //      for multi-word emphasis changes.
  //   4. Infix hyphens — replace `-` between word chars with a word-char
  //      marker so hyphenated compounds (`ninety-five`, `64-byte`,
  //      `state-of-the-art`) diff as single atomic tokens instead of
  //      fragmenting into an unchanged prefix + swapped suffix.
  //
  // Code spans are substituted first so that a backticked literal like
  // `[fake](link)` is treated as code and not accidentally captured by the
  // link regex; similarly, code and link sentinels are opaque to the
  // emphasis-pair regex. Hyphens run last so that hyphens inside those
  // constructs are already hidden. Restorations run in reverse order.
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

  // Coalesce adjacent change sites separated by thin unchanged context into
  // single phrase-level swaps. Turns alternating red/green word-noise into
  // a readable before/after, and rescues the Case-2 regression where
  // wrapping a previously-plain phrase in emphasis would otherwise surface
  // as fragmented literal delimiters inside colored tags.
  const tokens = coalesceChangeTokens(rawTokens);

  // Build the render wrapper from the NEW block so ordered-list items that
  // renumbered (e.g., 3. → 4. because a step was inserted above) display the
  // current plan's numeral rather than the previous version's.
  return { tokens, wrap: wrapFromBlock(b) };
}

/**
 * Compute the diff between two plan versions.
 *
 * Groups consecutive remove+add changes into "modified" blocks for
 * better rendering (showing what was replaced rather than separate
 * remove and add blocks). For each modified block, attempts a word-level
 * sub-diff; blocks that pass the qualification gate get `inlineTokens`
 * populated for inline rendering.
 */
export function computePlanDiff(
  oldText: string,
  newText: string
): { blocks: PlanDiffBlock[]; stats: PlanDiffStats } {
  // Pre-pass: collapse every fenced code block to a single-line sentinel
  // so diffLines treats each whole fence atomically. See the comment on
  // FENCE_BLOCK_PATTERN for the failure this prevents.
  const fenceMap = new Map<string, string>();
  const fenceToId = new Map<string, number>();
  const substOld = substituteFencedBlocks(oldText, fenceMap, fenceToId);
  const substNew = substituteFencedBlocks(newText, fenceMap, fenceToId);

  const rawChanges: Change[] = diffLines(substOld, substNew);
  // Restore the fenced-block content on each change value before the
  // block-building loop consumes it, so downstream rendering and the
  // inline-diff pass see the original fence text.
  const changes: Change[] = rawChanges.map((c) => ({
    ...c,
    value: restoreFencedBlocks(c.value, fenceMap),
  }));

  const blocks: PlanDiffBlock[] = [];
  const stats: PlanDiffStats = { additions: 0, deletions: 0, modifications: 0 };

  for (let i = 0; i < changes.length; i++) {
    const change = changes[i];
    const next = changes[i + 1];

    if (change.removed && next?.added) {
      // Adjacent remove + add = modification
      const inline = computeInlineDiff(change.value, next.value);
      blocks.push({
        type: "modified",
        content: next.value,
        oldContent: change.value,
        lines: countLines(next.value),
        ...(inline ? { inlineTokens: inline.tokens, inlineWrap: inline.wrap } : {}),
      });
      stats.modifications++;
      stats.additions += countLines(next.value);
      stats.deletions += countLines(change.value);
      i++; // skip the next (add) since we consumed it
    } else if (change.added) {
      blocks.push({
        type: "added",
        content: change.value,
        lines: countLines(change.value),
      });
      stats.additions += countLines(change.value);
    } else if (change.removed) {
      blocks.push({
        type: "removed",
        content: change.value,
        lines: countLines(change.value),
      });
      stats.deletions += countLines(change.value);
    } else {
      blocks.push({
        type: "unchanged",
        content: change.value,
        lines: countLines(change.value),
      });
    }
  }

  return { blocks, stats };
}
