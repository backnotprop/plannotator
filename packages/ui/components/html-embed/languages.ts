function fenceLanguage(language?: string): string | undefined {
  return language?.trim().split(/\s+/, 1)[0]?.toLowerCase();
}

export function isHtmlEmbedLanguage(language?: string): boolean {
  return fenceLanguage(language) === 'html';
}

export function isSvgFenceLanguage(language?: string): boolean {
  return fenceLanguage(language) === 'svg';
}
