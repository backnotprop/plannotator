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
console.log("Watching for changes...");
