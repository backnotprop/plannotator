import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const out = process.argv[2];
if (!out) throw new Error("usage: bun copy-wasm.ts <out dir>");
const require = createRequire(import.meta.url);
const files: Array<[string, string]> = [
  ["web-tree-sitter/web-tree-sitter.wasm", "web-tree-sitter.wasm"],
  ["tree-sitter-typescript/tree-sitter-typescript.wasm", "tree-sitter-typescript.wasm"],
  ["tree-sitter-typescript/tree-sitter-tsx.wasm", "tree-sitter-tsx.wasm"],
  ["tree-sitter-python/tree-sitter-python.wasm", "tree-sitter-python.wasm"],
  ["tree-sitter-go/tree-sitter-go.wasm", "tree-sitter-go.wasm"],
  ["tree-sitter-rust/tree-sitter-rust.wasm", "tree-sitter-rust.wasm"],
];
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const [from, to] of files) copyFileSync(require.resolve(from), join(out, to));
console.log(`sem-diff: ${files.length} parser files in ${out}`);
