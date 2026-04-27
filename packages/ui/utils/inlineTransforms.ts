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
