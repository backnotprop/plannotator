import esbuild from "esbuild";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { configs, copies } from "./esbuild.config";

rmSync("dist", { recursive: true, force: true });
for (const [from, to] of copies) {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}
// The Guide tab's reader (React, Tailwind, Pierre): a Vite build into dist/reader.
async function buildReader(): Promise<void> {
  const proc = Bun.spawn(["bun", "x", "vite", "build", "--config", "vite.reader.config.ts", "--logLevel", "warn"], { stdout: "inherit", stderr: "inherit" });
  if ((await proc.exited) !== 0) throw new Error("reader build failed");
}

Promise.all([...configs.map((c) => esbuild.build(c)), buildReader()]).catch((err) => {
  console.error(err);
  process.exit(1);
});
