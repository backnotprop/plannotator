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
    .replace(/(\d)--(?=\d)/g, '$1–')
    .replace(/(^|[\s([{])"/g, '$1“')
    .replace(/"/g, '”')
    .replace(/(^|[\s([{])'/g, '$1‘')
    .replace(/'/g, '’');
}

export function transformPlainText(text: string): string {
  return smartypants(replaceEmoji(text));
}
