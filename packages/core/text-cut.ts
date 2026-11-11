const graphemes: Intl.Segmenter | null =
  typeof Intl !== "undefined" && typeof (Intl as { Segmenter?: unknown }).Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

const LOOKAHEAD = 32;

/**
 * The longest start of `text` that is at most `max` UTF-16 code units and ends between two
 * characters.
 */
export function sliceText(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  if (graphemes) {
    let end = 0;
    // Only the start is segmented: the work never grows with the text.
    for (const { segment } of graphemes.segment(text.slice(0, max + LOOKAHEAD))) {
      if (end + segment.length > max) break;
      end += segment.length;
    }
    return text.slice(0, end);
  }
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/** `text` when it fits in `max` code units, else its start and "…", together at most `max`, never ending inside a character. */
export function cutText(text: string, max: number, ellipsis = "…"): string {
  if (text.length <= max) return text;
  return `${sliceText(text, max - ellipsis.length)}${ellipsis}`;
}
