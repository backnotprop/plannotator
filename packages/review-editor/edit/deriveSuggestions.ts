import { diffLines } from 'diff';

/**
 * One contiguous changed region of an edit session, expressed as a suggestion
 * anchored to the PRE-EDIT content's line numbers.
 *
 * The edit session operates on the diff's NEW-side (post-image) file content,
 * so `lineStart`/`lineEnd` are new-side file line numbers — exactly the
 * numbering `CodeAnnotation` uses with `side: 'new'`. The browser never writes
 * files; these hunks become suggestion annotations the agent applies.
 */
export interface SuggestionHunk {
  /** 1-based first line (inclusive) of the replaced range in the pre-edit content. */
  lineStart: number;
  /** 1-based last line (inclusive) of the replaced range in the pre-edit content. */
  lineEnd: number;
  /** The pre-edit lines being replaced (no trailing newline). */
  originalCode: string;
  /** The replacement lines (no trailing newline). */
  suggestedCode: string;
}

/** Normalize line endings so a CRLF file edited by an LF editor (or vice
 * versa) doesn't report every untouched line as changed. Suggestions are
 * emitted LF-only; the applying agent re-normalizes to the file's own style. */
function normalize(content: string): string {
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function splitLines(content: string): string[] {
  if (content === '') return [];
  const lines = content.split('\n');
  // A trailing newline yields a final empty element that is not a real line.
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

interface RawRegion {
  /** 1-based line in the pre-edit content where the region starts. For pure
   * insertions this is the line BEFORE which the new lines go (may be one past
   * the last line for end-of-file appends). */
  start: number;
  originalLines: string[];
  suggestedLines: string[];
}

/** A hunk under construction: line arrays instead of joined strings so the
 * collision pass can merge and fold before the final join. */
interface PendingHunk {
  lineStart: number;
  lineEnd: number;
  origLines: string[];
  suggLines: string[];
}

/**
 * Diff the pre-edit content against the edited content and return one
 * SuggestionHunk per contiguous changed region.
 *
 * Rules:
 * - A no-op edit (identical after CRLF normalization) returns [].
 * - Consecutive removed+added runs merge into a single "modified" hunk.
 * - Pure insertions and pure deletions are expanded to include one adjacent
 *   unchanged anchor line, so every hunk has non-empty `originalCode` (the
 *   reviewer's diff shows what the lines currently are) and — except when the
 *   whole file was emptied — non-empty `suggestedCode` (the export template
 *   skips falsy suggestedCode, so a bare deletion must carry its kept
 *   neighbor).
 *
 * Anchor collision resolution (hunks MUST never overlap — an agent applying
 * them against original line numbers would otherwise drop or duplicate code):
 * regions are emitted left to right, and each expansion checks its neighbors
 * BEFORE claiming an anchor line.
 * - Backward (the preceding line) is preferred, but only when that line is not
 *   already claimed by the previously emitted hunk.
 * - Otherwise the following line is used. A forward anchor is always an
 *   unchanged line (diffLines separates regions by at least one unchanged
 *   line), and later regions see it as claimed, so they can never take it.
 * - When both directions are unavailable (previous hunk claims the preceding
 *   line AND the region runs to end of file), the region merges into the
 *   previous hunk as one spanning suggestion.
 * - A region spanning the whole file (emptied file, insert into empty file)
 *   stays unanchored: suggestedCode may be '' and the caller is responsible
 *   for describing the deletion in text.
 *
 * The emission order makes overlap structurally impossible; a defensive fold
 * at the end enforces the invariant (`lineStart > previous lineEnd`) anyway,
 * merging any violating hunk into its predecessor rather than ever returning
 * overlapping ranges.
 */
export function deriveSuggestionHunks(preEditContent: string, editedContent: string): SuggestionHunk[] {
  const original = normalize(preEditContent);
  const edited = normalize(editedContent);
  if (original === edited) return [];

  const originalLines = splitLines(original);
  const parts = diffLines(original, edited);

  const regions: RawRegion[] = [];
  let current: RawRegion | null = null;
  // 1-based number of the NEXT line to consume from the original content.
  let origLine = 1;

  for (const part of parts) {
    const lines = splitLines(part.value);
    if (part.added) {
      if (!current) current = { start: origLine, originalLines: [], suggestedLines: [] };
      current.suggestedLines.push(...lines);
    } else if (part.removed) {
      if (!current) current = { start: origLine, originalLines: [], suggestedLines: [] };
      current.originalLines.push(...lines);
      origLine += lines.length;
    } else {
      if (current) {
        regions.push(current);
        current = null;
      }
      origLine += lines.length;
    }
  }
  if (current) regions.push(current);

  const lineCount = originalLines.length;
  const hunks: PendingHunk[] = [];
  const prevEnd = () => (hunks.length > 0 ? hunks[hunks.length - 1].lineEnd : 0);

  for (const region of regions) {
    const rawStart = region.start;
    // Last original line the region occupies; rawStart - 1 for pure inserts
    // (they occupy no original lines).
    const rawEnd = rawStart + region.originalLines.length - 1;
    const isInsert = region.originalLines.length === 0;
    const isDelete = !isInsert && region.suggestedLines.length === 0;

    if (!isInsert && !isDelete) {
      // Modification: never expands, and raw regions never overlap.
      hunks.push({
        lineStart: rawStart,
        lineEnd: rawEnd,
        origLines: [...region.originalLines],
        suggLines: [...region.suggestedLines],
      });
      continue;
    }

    const backwardLine = rawStart - 1;
    const canBackward = backwardLine >= 1 && backwardLine > prevEnd();
    // For an insert this is the line the new lines go before; for a delete the
    // first kept line after the removed run. Both are unchanged lines.
    const forwardLine = rawEnd + 1;
    const canForward = forwardLine <= lineCount;

    if (canBackward) {
      const anchor = originalLines[backwardLine - 1];
      hunks.push(
        isInsert
          ? {
              lineStart: backwardLine,
              lineEnd: backwardLine,
              origLines: [anchor],
              suggLines: [anchor, ...region.suggestedLines],
            }
          : {
              lineStart: backwardLine,
              lineEnd: rawEnd,
              origLines: [anchor, ...region.originalLines],
              suggLines: [anchor],
            },
      );
    } else if (canForward) {
      const anchor = originalLines[forwardLine - 1];
      hunks.push(
        isInsert
          ? {
              lineStart: forwardLine,
              lineEnd: forwardLine,
              origLines: [anchor],
              suggLines: [...region.suggestedLines, anchor],
            }
          : {
              lineStart: rawStart,
              lineEnd: forwardLine,
              origLines: [...region.originalLines, anchor],
              suggLines: [anchor],
            },
      );
    } else if (hunks.length > 0 && prevEnd() === rawStart - 1) {
      // Both anchor directions are taken (previous hunk claims the preceding
      // line; the region runs to end of file): merge into the previous hunk
      // as one spanning suggestion. Contiguity is guaranteed — backward is
      // only blocked when the previous hunk ends exactly one line before.
      const prev = hunks[hunks.length - 1];
      prev.lineEnd = Math.max(prev.lineEnd, rawEnd);
      prev.origLines.push(...region.originalLines);
      prev.suggLines.push(...region.suggestedLines);
    } else {
      // Region spans the whole file (emptied file / insert into empty file):
      // nothing to anchor to.
      hunks.push({
        lineStart: rawStart,
        lineEnd: Math.max(rawEnd, rawStart),
        origLines: [...region.originalLines],
        suggLines: [...region.suggestedLines],
      });
    }
  }

  // Hard invariant: hunks are disjoint and ascending. The emission above makes
  // a violation impossible; if one ever appears, fold the offender into its
  // predecessor (originalCode recomputed from the source lines so the anchor
  // stays truthful) rather than emitting overlapping ranges.
  const folded: PendingHunk[] = [];
  for (const hunk of hunks) {
    const prev = folded[folded.length - 1];
    if (prev && hunk.lineStart <= prev.lineEnd) {
      prev.lineEnd = Math.max(prev.lineEnd, hunk.lineEnd);
      prev.origLines = originalLines.slice(prev.lineStart - 1, prev.lineEnd);
      prev.suggLines = [...prev.suggLines, ...hunk.suggLines];
      continue;
    }
    folded.push(hunk);
  }

  return folded.map((hunk) => ({
    lineStart: hunk.lineStart,
    lineEnd: hunk.lineEnd,
    originalCode: hunk.origLines.join('\n'),
    suggestedCode: hunk.suggLines.join('\n'),
  }));
}
