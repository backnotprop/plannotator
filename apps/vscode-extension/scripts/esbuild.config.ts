import type { BuildOptions } from "esbuild";

const config: BuildOptions = {
  entryPoints: ["./src/extension.ts"],
  bundle: true,
  platform: "node",
  target: "node18",
  outdir: "./dist",
  outbase: "./src",
  outExtension: { ".js": ".cjs" },
  format: "cjs",
  external: ["vscode"],
  loader: { ".ts": "ts" },
  logLevel: "info",
  sourcemap: "linked",
};

const guides: BuildOptions = {
  entryPoints: { guides: "./src/guides/vscode/index.ts" },
  bundle: true,
  platform: "node",
  target: "node18",
  outdir: "./dist",
  outExtension: { ".js": ".cjs" },
  format: "cjs",
  external: ["vscode"],
  loader: { ".ts": "ts" },
  logLevel: "info",
  sourcemap: "linked",
};

const guideMcp: BuildOptions = {
  entryPoints: { "guide-mcp": "./src/guides/mcp/relay-script.ts" },
  bundle: true,
  platform: "node",
  target: "node18",
  outdir: "./dist",
  outExtension: { ".js": ".cjs" },
  format: "cjs",
  logLevel: "info",
};

const guidesWebview: BuildOptions = {
  entryPoints: { "guides-webview": "./src/guides/webview/main.ts" },
  bundle: true,
  platform: "browser",
  target: "es2022",
  outdir: "./dist",
  format: "iife",
  loader: { ".ts": "ts", ".css": "css" },
  logLevel: "info",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
  alias: { "@viz-js/viz": "./src/guides/webview/stubs/viz.ts", katex: "./src/guides/webview/stubs/katex.ts" },
};

export const configs: BuildOptions[] = [config, guides, guideMcp, guidesWebview];

export const copies: Array<[string, string]> = [
  ["node_modules/@vscode/codicons/dist/codicon.css", "dist/codicons/codicon.css"],
  ["node_modules/@vscode/codicons/dist/codicon.ttf", "dist/codicons/codicon.ttf"],
];

export default config;
