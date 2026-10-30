import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * The Guide tab: Plannotator's guide reader (packages/guide-viewer over
 * review-editor's AllFilesCodeView, the same chain guides.show and the review
 * app render) in a VS Code webview. A multi-file build like guides.show's:
 * `reader.js` / `reader.css` are what the webview loads by name; Shiki's
 * grammars and themes are lazy chunks, the highlight worker is its own file
 * (fetched and started as a blob worker, see apps/guides-show/viewer/portablePool.tsx).
 * `base: './'` keeps chunk URLs relative to the entry, so they resolve under
 * the webview's resource origin.
 */
/**
 * The Guide tab draws in VS Code's own fonts (reader.css maps `--font-sans` /
 * `--font-mono` to `--vscode-*`), so the web fonts the shared CSS declares
 * (Inter, Geist Mono) are never used: their `@font-face` rules and files are
 * left out of the build.
 */
function dropWebFonts(): Plugin {
  return {
    name: "plannotator-reader-drop-web-fonts",
    enforce: "post",
    generateBundle(_options, bundle) {
      for (const [name, item] of Object.entries(bundle)) {
        if (item.type !== "asset") continue;
        if (/\.(woff2?|ttf|otf)$/.test(name)) delete bundle[name];
        else if (name.endsWith(".css") && typeof item.source === "string") item.source = item.source.replace(/@font-face\{[^}]*\}/g, "");
      }
    },
  };
}

export default defineConfig({
  root: __dirname,
  base: "./",
  plugins: [react(), tailwindcss(), dropWebFonts()],
  resolve: {
    alias: {
      // Pierre runs Shiki's JavaScript regex engine: the Oniguruma WASM is dead weight.
      "shiki/wasm": path.resolve(__dirname, "../../build/shiki-wasm-stub.ts"),
      "katex/dist/katex.min.css": path.resolve(__dirname, "../guides-show/viewer/stubs/empty.css"),
      // Overview diagrams are Mermaid only: Graphviz's 1.3 MB engine stays out (as in the webview build).
      "@viz-js/viz": path.resolve(__dirname, "src/guides/webview/stubs/viz.ts"),
    },
  },
  worker: {
    format: "es",
    rollupOptions: { output: { inlineDynamicImports: true, entryFileNames: "worker.[hash].js" } },
  },
  define: { "process.env.NODE_ENV": '"production"' },
  build: {
    target: "es2022",
    outDir: path.resolve(__dirname, "dist/reader"),
    emptyOutDir: true,
    cssCodeSplit: false,
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 4_000,
    sourcemap: false,
    rollupOptions: {
      // `diagram.js`: the Mermaid engine the other Guides webviews load when they draw a
      // diagram (src/guides/webview/diagram-loader.ts), sharing the reader's chunks.
      input: { reader: path.resolve(__dirname, "src/guides/reader/main.tsx"), diagram: path.resolve(__dirname, "src/guides/webview/diagram.ts") },
      preserveEntrySignatures: "exports-only",
      output: {
        inlineDynamicImports: false,
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name].[hash].js",
        assetFileNames: (info) => {
          const name = info.names?.[0] ?? info.name ?? "asset";
          if (name.endsWith(".css")) return "reader.css";
          if (/\.(woff2?|ttf|otf)$/.test(name)) return "fonts/[name].[hash][extname]";
          return "assets/[name].[hash][extname]";
        },
      },
    },
  },
});
