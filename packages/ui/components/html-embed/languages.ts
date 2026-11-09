/** Fence languages a host with `htmlEmbeds` draws instead of showing code (approval "inbox-inline-html"). */

function fenceLanguage(language?: string): string | undefined {
  return language?.trim().split(/\s+/, 1)[0]?.toLowerCase();
}

/** ```html: a live page in a sandboxed frame. */
export function isHtmlEmbedLanguage(language?: string): boolean {
  return fenceLanguage(language) === 'html';
}

/** ```svg: a drawing, shown as an image (it never runs). */
export function isSvgFenceLanguage(language?: string): boolean {
  return fenceLanguage(language) === 'svg';
}
