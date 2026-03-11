const GRAPHVIZ_LANGUAGES = new Set(['dot', 'graphviz', 'gv']);

function getFenceLanguage(language?: string): string | undefined {
  return language?.trim().split(/\s+/, 1)[0]?.toLowerCase();
}

export function isMermaidLanguage(language?: string): boolean {
  return getFenceLanguage(language) === 'mermaid';
}

export function isGraphvizLanguage(language?: string): boolean {
  const normalizedLanguage = getFenceLanguage(language);
  return normalizedLanguage ? GRAPHVIZ_LANGUAGES.has(normalizedLanguage) : false;
}
