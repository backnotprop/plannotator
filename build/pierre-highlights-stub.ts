/**
 * Build-time stub for `@pierre/highlights` (and its theme catalog,
 * `@pierre/highlights/themes/loader`).
 *
 * Since 1.6, `@pierre/diffs` ships a second highlighter, Highlights (WebAssembly,
 * in beta), next to Shiki. It picks one at RUNTIME from `preferredHighlighter`
 * (default `'shiki-js'`, `DEFAULT_HIGHLIGHTER` in its `dist/constants.js`), so the
 * Highlights backend sits behind a dynamic import the bundler still follows.
 * Plannotator stays on Shiki (`'shiki-js'`, see
 * `packages/review-editor/workerPool.tsx` and `packages/ui/utils/codeHighlight.ts`),
 * so that branch never runs. Without this stub it would still put the
 * Highlights chunk, its inlined WASM (~440 KB base64) and its theme catalog into
 * every single-file build, and again inside the inlined highlight worker.
 *
 * Every export throws on use, so asking Pierre for `'highlights'` fails loudly.
 * The module itself evaluates cleanly: the worker is built with
 * `inlineDynamicImports`, which runs every inlined module when it starts.
 *
 * Wired through `resolve.alias` (NOT a plugin), like `build/shiki-wasm-stub.ts`:
 * `resolve.alias` is shared with Vite's worker build, `plugins` are not. List
 * `@pierre/highlights/themes/loader` before `@pierre/highlights`: a string alias
 * also matches its subpaths.
 */

function unavailable(): never {
  throw new Error(
    '@pierre/highlights is not bundled by Plannotator: code is highlighted with Shiki ' +
      "(preferredHighlighter: 'shiki-js'). Remove the `@pierre/highlights` aliases in the app vite config to re-enable it.",
  );
}

export const codeToTokens = unavailable;
export const isSupportedLanguage = unavailable;

export class LiveTokenizer {
  constructor() {
    unavailable();
  }
}

/** The theme catalog (`@pierre/highlights/themes/loader`): any read throws. */
export const themes = new Proxy({}, { get: unavailable, has: unavailable, ownKeys: unavailable, getOwnPropertyDescriptor: unavailable });
