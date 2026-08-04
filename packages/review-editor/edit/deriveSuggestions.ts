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
 *   neighbor). Anchoring prefers the preceding line; at file start it uses the
 *   following line instead.
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

  return regions.map((region) => {
    let { start } = region;
    const orig = [...region.originalLines];
    const sugg = [...region.suggestedLines];
    let end = start + orig.length - 1;

    if (orig.length === 0) {
      // Pure insertion before line `start`. Anchor to the preceding line when
      // one exists; at file start anchor to the (current) first line instead.
      if (start > 1) {
        const anchor = originalLines[start - 2];
        orig.unshift(anchor);
        sugg.unshift(anchor);
        start -= 1;
        end = start;
      } else if (originalLines.length > 0) {
        const anchor = originalLines[0];
        orig.push(anchor);
        sugg.push(anchor);
        end = start;
      } else {
        // Inserting into an empty file: nothing to anchor to.
        end = start;
      }
    } else if (sugg.length === 0) {
      // Pure deletion. Keep one unchanged neighbor so suggestedCode stays
      // non-empty (the feedback export skips falsy suggestedCode).
      if (start > 1) {
        const anchor = originalLines[start - 2];
        orig.unshift(anchor);
        sugg.push(anchor);
        start -= 1;
      } else if (end < originalLines.length) {
        const anchor = originalLines[end];
        orig.push(anchor);
        sugg.push(anchor);
        end += 1;
      }
      // else: the whole file was emptied — suggestedCode stays '' and the
      // caller is responsible for describing the deletion in text.
    }

    return {
      lineStart: start,
      lineEnd: end,
      originalCode: orig.join('\n'),
      suggestedCode: sugg.join('\n'),
    };
  });
}
