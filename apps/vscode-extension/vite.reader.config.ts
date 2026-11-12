import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { diffsWorkerCatalogs } from "../../build/diffs-worker-catalogs";

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
      "shiki/wasm": path.resolve(__dirname, "../../build/shiki-wasm-stub.ts"),
      "@pierre/highlights/themes/loader": path.resolve(__dirname, "../../build/pierre-highlights-stub.ts"),
      "@pierre/highlights": path.resolve(__dirname, "../../build/pierre-highlights-stub.ts"),
      "katex/dist/katex.min.css": path.resolve(__dirname, "../guides-show/viewer/stubs/empty.css"),
      "@viz-js/viz": path.resolve(__dirname, "src/guides/webview/stubs/viz.ts"),
    },
  },
  worker: {
    format: "es",
    plugins: () => [diffsWorkerCatalogs()],
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
