import esbuild from "esbuild";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { configs, copies } from "./esbuild.config";

rmSync("dist", { recursive: true, force: true });
for (const [from, to] of copies) {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}
Promise.all(configs.map((c) => esbuild.build(c))).catch(() => process.exit(1));
