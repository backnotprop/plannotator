import { defineConfig } from "tsup";
import { solidPlugin } from "esbuild-plugin-solid";

export default defineConfig({
  entry: { tui: "tui.tsx" },
  format: ["esm"],
  platform: "node",
  target: "es2022",
  bundle: true,
  splitting: false,
  sourcemap: true,
  clean: false,
  dts: false,
  outDir: "dist",
  esbuildPlugins: [
    solidPlugin({ solid: { generate: "universal", moduleName: "@opentui/solid" } }),
  ],
  external: ["@opentui/solid", "solid-js"],
});
