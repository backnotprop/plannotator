/**
 * A text splice that inserts an embed line as its own markdown paragraph.
 */
export interface EmbedInsertPlan {
  /**
   * Replacement start at the beginning of the line that holds the typed
   * `/embed` query. Leading whitespace is swallowed so the embed does not
   * become an indented code block.
   */
  readonly from: number;
  /**
   * Replacement end. Trailing text on the trigger line is preserved and
   * moved to its own paragraph.
   */
  readonly to: number;
  /** Text inserted in place of the replacement range. */
  readonly insert: string;
  /** Caret destination at the start of the line after the embed. */
  readonly cursor: number;
}

/**
 * Plan the splice that replaces a typed `/embed` query with an embed line.
 *
 * The embed line is normalized into its own blank-line-delimited paragraph.
 * The caller owns the embed grammar and supplies the exact line to insert.
 *
 * @param body - Current document text.
 * @param from - Start of the typed query, after any leading line whitespace.
 * @param to - End of the typed query.
 * @param embedLine - Exact host-built embed line.
 * @returns The replacement range, inserted text, and caret destination.
 */
export function planEmbedInsert(
  body: string,
  from: number,
  to: number,
  embedLine: string,
): EmbedInsertPlan {
  // Extend the replacement to the start of the line. The picker only fires
  // when everything before the typed query is whitespace.
  let lineStart = body.lastIndexOf('\n', from - 1) + 1;
  if (from === 0) lineStart = 0;

  // No blank line is needed before an embed at the document start or when
  // the previous line is already blank (including whitespace-only lines).
  let prefix = '';
  if (lineStart > 0) {
    const previousLineStart = body.lastIndexOf('\n', lineStart - 2) + 1;
    const previousLine = body.slice(previousLineStart, lineStart - 1);
    if (!/^\s*$/.test(previousLine)) prefix = '\n';
  }

  // Normalize the paragraph after the embed according to what follows the
  // replaced range. Existing blank lines are retained instead of doubled.
  let lineEnd = body.indexOf('\n', to);
  if (lineEnd === -1) lineEnd = body.length;
  const restOfLine = body.slice(to, lineEnd);
  let suffix: string;
  if (!/^\s*$/.test(restOfLine)) {
    suffix = '\n\n';
  } else if (lineEnd >= body.length) {
    suffix = '\n';
  } else {
    let nextLineEnd = body.indexOf('\n', lineEnd + 1);
    if (nextLineEnd === -1) nextLineEnd = body.length;
    const nextLine = body.slice(lineEnd + 1, nextLineEnd);
    suffix = /^\s*$/.test(nextLine) ? '' : '\n';
  }

  const embedEnd = lineStart + prefix.length + embedLine.length;
  return {
    from: lineStart,
    // Swallow a whitespace-only rest of line. Leaving it behind would add
    // trailing spaces to the embed line and break exact-line host grammars.
    to: /^\s*$/.test(restOfLine) ? lineEnd : to,
    insert: prefix + embedLine + suffix,
    cursor: embedEnd + 1,
  };
}
