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

/**
 * Approximate the renderer's inline output for a fragment of source markdown:
 * drop the syntax that `InlineMarkdown` consumes without rendering.
 *
 * Only `slugifyHeading` calls this now. Annotation restore used to, and that is
 * what made leaving the crudeness in place affordable; it now asks the renderer
 * directly (`utils/renderedText`), because approximating an inverse that does
 * not exist cost four rungs of a ladder and still could not see text the DOM
 * ADDS — a bullet, an ordered numeral, a match-count badge.
 *
 * Slugs stay here on purpose. `slugifyHeading` is pure and runs where no DOM
 * exists, which `renderedText` cannot do, and its output is anchor ids that
 * live in URLs — so the one place the two would disagree (`snake_case` slugging
 * to `snakecase` rather than `snake-case`) is a link-stability question, not a
 * correctness one. Stripping every `*_`~` rather than only paired ones is safe
 * for that caller: a heading is slugged whole, never matched against anything.
 */
export function stripInlineMarkdown(text: string): string {
  return text
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`~]/g, '');
}

export function transformPlainText(text: string): string {
  return smartypants(replaceEmoji(text));
}
