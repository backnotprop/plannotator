/**
 * The syntax highlighter every Plannotator surface asks `@pierre/diffs` for.
 *
 * `'highlights'` is Pierre's WebAssembly highlighter (`@pierre/highlights`):
 * faster to start and to tokenize than Shiki. `'shiki-js'` is Shiki with its
 * JavaScript regex engine, which Plannotator used before. Change this one line
 * to `'shiki-js'` to go back.
 *
 * Every caller in a page, every highlight worker and both servers' code-file
 * prerender read this, because Pierre allows only one highlighter type per
 * thread: a second type throws "Cannot load the … highlighter while … is in
 * use". Callers: `@plannotator/ui` (`utils/codeHighlight`, `CodeFilePopout`,
 * Shape), the review editor's worker pool and diff views, the guides-show
 * viewer's pool, and the Bun and Pi servers' `preloadFile`.
 *
 * Highlights compiles its WebAssembly from bytes inlined in its JavaScript
 * (`new WebAssembly.Module`), so it fetches nothing, but a page with a
 * Content-Security-Policy needs `'wasm-unsafe-eval'` in `script-src`.
 */
export type CodeHighlighter = 'shiki-js' | 'highlights';

export const CODE_HIGHLIGHTER: CodeHighlighter = 'highlights';
