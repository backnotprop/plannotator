import esbuild from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { configs, copies } from "./esbuild.config";

for (const [from, to] of copies) {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}
for (const c of configs) {
  const ctx = await esbuild.context({ ...c, sourcemap: c.platform === "browser" ? c.sourcemap : "inline" });
  await ctx.watch();
}
// The Guide tab's reader and the diagram engine the other Guides webviews import
// (dist/reader/reader.js, dist/reader/diagram.js): Vite, rebuilt on change.
const reader = Bun.spawn(["bun", "x", "vite", "build", "--watch", "--config", "vite.reader.config.ts", "--logLevel", "warn"], { stdout: "inherit", stderr: "inherit" });
process.on("exit", () => reader.kill());
console.log("Watching for changes...");
