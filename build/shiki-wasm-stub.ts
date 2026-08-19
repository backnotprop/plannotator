/**
 * Build-time stub for `shiki/wasm`.
 *
 * `@pierre/diffs` picks its Shiki engine at RUNTIME:
 *
 *     engine: preferredHighlighter === "shiki-wasm"
 *       ? createOnigurumaEngine(import("shiki/wasm"))
 *       : createJavaScriptRegexEngine()
 *
 * (`dist/highlighter/shared_highlighter.js` on the main thread and
 * `dist/worker/worker.js` inside the inlined worker). Plannotator pins
 * `preferredHighlighter: 'shiki-js'` everywhere — see
 * `packages/review-editor/workerPool.tsx` — and Pierre's own default is
 * `'shiki-js'`, so the Oniguruma branch never executes. But because the choice
 * is a runtime ternary, the bundler keeps the `import("shiki/wasm")` edge and
 * inlines `@shikijs/engine-oniguruma/wasm-inlined` — a ~622 KB base64 blob —
 * into every single-file HTML build (twice in the review app: once on the main
 * thread, once in the inlined worker).
 *
 * Aliasing `shiki/wasm` to this module drops that payload. The JS regex engine
 * and the WASM engine were verified to produce identical tokens, so nothing
 * about the rendered output changes; the only thing that changes is that
 * opting into `'shiki-wasm'` now fails loudly instead of silently costing every
 * user a megabyte of dead bytes.
 *
 * Wired through `resolve.alias` (NOT a plugin) on purpose: `resolve.alias` is
 * shared with Vite's worker build, `plugins` are not.
 */

function unavailable(): never {
  throw new Error(
    "shiki/wasm is not bundled by Plannotator: the Oniguruma engine is stubbed out " +
      "in favour of Shiki's JavaScript regex engine (preferredHighlighter: 'shiki-js'). " +
      'Remove the `shiki/wasm` alias in the app vite config to re-enable it.',
  );
}

export default unavailable;
