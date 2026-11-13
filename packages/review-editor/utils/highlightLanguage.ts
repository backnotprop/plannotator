import { getFiletypeFromFileName, setCustomExtension } from '@pierre/diffs';

/**
 * Names Pierre's own table colours as the wrong language or not at all, keyed
 * the way Pierre matches a name: a whole file name or an extension. Every value
 * is a grammar Shiki's full bundle already carries.
 *
 * `go.mod` and `.gitignore` are missing on purpose: Shiki has no grammar for
 * either, and borrowing a near one would be a guess.
 */
export const FILE_LANGUAGE_FIXES: Readonly<Record<string, string>> = {
  // Pierre says Wolfram (whose files are .wl and .nb) and Prolog (which keeps .pro and .P).
  m: 'objective-c',
  pl: 'perl',
  justfile: 'just',
  Justfile: 'just',
  gradle: 'groovy',
  zshrc: 'zsh',
  svg: 'xml',
};

let applied = false;

/**
 * Add the fixes to Pierre's detection, which the diff pane and the whole-file
 * view call for every file (in its workers too: Pierre sends them its custom
 * names). Run before the first file renders.
 */
export function applyFileLanguageFixes(): void {
  if (applied) return;
  applied = true;
  for (const [name, lang] of Object.entries(FILE_LANGUAGE_FIXES)) setCustomExtension(name, lang);
}

/**
 * The grammar the diff pane colours `filePath` with, or undefined for plain
 * text. For colouring only: code navigation keeps `detectLanguage`, whose names
 * the server's search reads.
 */
export function fileHighlightLanguage(filePath: string): string | undefined {
  applyFileLanguageFixes();
  const lang = getFiletypeFromFileName(filePath);
  return lang === 'text' ? undefined : lang;
}
