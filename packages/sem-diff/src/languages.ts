// Which parser reads a file, by its name. Kept apart from the parsers so a page can ask
// without loading them.
export type LanguageId = 'go' | 'typescript' | 'tsx' | 'rust' | 'python' | 'java' | 'csharp';

export function languageForPath(path: string): LanguageId | null {
  if (path.endsWith('.go')) return 'go';
  if (path.endsWith('.rs')) return 'rust';
  if (/\.pyi?$/.test(path)) return 'python';
  if (path.endsWith('.java')) return 'java';
  if (path.endsWith('.cs')) return 'csharp';
  // Plain JavaScript may hold JSX (React `.js` files); the TSX grammar reads both.
  if (path.endsWith('.tsx') || /\.(m|c)?jsx?$/.test(path)) return 'tsx';
  if (/\.(m|c)?(ts|js)$/.test(path)) return 'typescript';
  return null;
}
