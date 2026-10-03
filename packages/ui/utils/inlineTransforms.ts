/**
 * Render-time transforms applied to plain-text fragments inside the inline
 * scanner. Called only after code spans, links, and other markdown syntax
 * have been consumed — so transforms here are guaranteed to operate on prose,
 * not on code or URL strings.
 */

const EMOJI_MAP: Record<string, string> = {
  smile: '😄', heart: '❤️', thumbsup: '👍', thumbsdown: '👎',
  fire: '🔥', star: '⭐', tada: '🎉', rocket: '🚀',
  bug: '🐛', sparkles: '✨', warning: '⚠️', white_check_mark: '✅',
  x: '❌', eyes: '👀', wave: '👋', thinking: '🤔',
  ok: '🆗', construction: '🚧', boom: '💥', gear: '⚙️',
  hourglass: '⏳', zap: '⚡', lock: '🔒', unlock: '🔓',
  memo: '📝', book: '📖', package: '📦', hammer: '🔨',
  checkered_flag: '🏁', question: '❓', exclamation: '❗', bulb: '💡',
};

function replaceEmoji(s: string): string {
  return s.replace(/:([a-z_]+):/g, (whole, code) => EMOJI_MAP[code] ?? whole);
}

function smartypants(s: string): string {
  return s
    .replace(/\.{3}/g, '…')
    .replace(/---/g, '—')
    // Narrow en-dash rule to numeric ranges (e.g. "pages 3--5" → "3–5").
    // Previously matched any non-hyphen context, which rewrote CLI flags
    // like "bun --watch" into "bun –watch". Letter-to-letter en-dashes
    // are rare in technical writing; we accept losing them to avoid the
    // false positive on command-line arguments.
    .replace(/(\d)--(?=\d)/g, '$1–')
    .replace(/(^|[\s([{])"/g, '$1“')
    .replace(/"/g, '”')
    .replace(/(^|[\s([{])'/g, '$1‘')
    .replace(/'/g, '’');
}

export function transformPlainText(text: string): string {
  return smartypants(replaceEmoji(text));
}

/**
 * Strip the inline markdown syntax the renderer consumes, so a quote taken
 * from a document's SOURCE can be matched against its RENDERED text.
 *
 * An external annotation's `originalText` is a quote, and its natural source
 * is the markdown a tool read from the server — where `` `config.ts` `` still
 * carries its backticks. The rendered DOM has none of that syntax, so a
 * faithful quote of a line containing any inline markup finds nothing and the
 * annotation degrades to sidebar-only.
 *
 * Deliberately conservative and lossy in one direction only: it removes
 * delimiters, never content. Both helpers are last-resort restore tiers, tried
 * only after a literal search has already failed, so a quote that matches the
 * page verbatim never reaches them.
 */
export function stripInlineMarkdown(text: string): string {
  // Code-span content is literal to the renderer, so emphasis delimiters
  // inside one are ordinary characters and must survive. Unwrapping the
  // backticks first would expose them to the rules below, so the content is
  // parked out of reach and restored at the end.
  const spans: string[] = [];
  const SENTINEL = '\u0000';
  const parked = text.replace(/``([\s\S]+?)``|`([^`]+)`/g, (_match, double, single) => {
    spans.push(double ?? single);
    return `${SENTINEL}${spans.length - 1}${SENTINEL}`;
  });

  const stripped = parked
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*\*([^*]+)\*\*\*/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1');

  return stripped.replace(
    new RegExp(`${SENTINEL}(\\d+)${SENTINEL}`, 'g'),
    (_match, index) => spans[Number(index)] ?? '',
  );
}

/**
 * `stripInlineMarkdown` plus the cell delimiters of a table row.
 *
 * A row renders as sibling `<td>` elements with no text between them, so the
 * rendered text of `| a | b |` is `ab` — the pipes AND the padding around them
 * have to go, not just the pipes. Kept separate from `stripInlineMarkdown`
 * because deleting the whitespace around a `|` mangles ordinary prose that
 * happens to contain one; it is only ever worth trying when everything else
 * has already failed.
 */
export function stripTableCellDelimiters(text: string): string {
  return stripInlineMarkdown(text).replace(/\s*\|\s*/g, '');
}
