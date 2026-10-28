import type { BuildOptions } from "esbuild";

/** The main extension: the browser router and editor annotations. Activated on startup, kept small. */
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

/**
 * Guides: a second bundle, loaded the first time the Guides view or a Guides
 * command is used, so people who only use the browser router pay nothing.
 */
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

/** The stdio MCP relay the agent starts for a guide run. Dependency-free. */
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

/** The Guides webviews (browser). */
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
  // Overviews draw Mermaid only: Graphviz and KaTeX stay out of the bundle.
  alias: { "@viz-js/viz": "./src/guides/webview/stubs/viz.ts", katex: "./src/guides/webview/stubs/katex.ts" },
};

export const configs: BuildOptions[] = [config, guides, guideMcp, guidesWebview];

/** Files the webviews load as they are. */
export const copies: Array<[string, string]> = [
  ["node_modules/@vscode/codicons/dist/codicon.css", "dist/codicons/codicon.css"],
  ["node_modules/@vscode/codicons/dist/codicon.ttf", "dist/codicons/codicon.ttf"],
];

export default config;
