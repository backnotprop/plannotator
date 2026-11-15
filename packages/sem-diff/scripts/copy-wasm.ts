import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
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
  ["tree-sitter-java/tree-sitter-java.wasm", "tree-sitter-java.wasm"],
  ["tree-sitter-c-sharp/tree-sitter-c_sharp.wasm", "tree-sitter-c_sharp.wasm"],
  ["tree-sitter-php/tree-sitter-php.wasm", "tree-sitter-php.wasm"],
  ["tree-sitter-ruby/tree-sitter-ruby.wasm", "tree-sitter-ruby.wasm"],
  ["@tree-sitter-grammars/tree-sitter-kotlin/tree-sitter-kotlin.wasm", "tree-sitter-kotlin.wasm"],
];
const pinned: Record<string, string> = {
  "tree-sitter-kotlin.wasm": "7009d69453bc8735e438b2818a633efb21c88f99782769abba60dffedfab73f7",
};
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const [from, to] of files) {
  const source = require.resolve(from);
  const want = pinned[to];
  if (want) {
    const got = createHash("sha256").update(readFileSync(source)).digest("hex");
    if (got !== want) throw new Error(`sem-diff: ${to} has sha256 ${got}, expected ${want}`);
  }
  copyFileSync(source, join(out, to));
}
console.log(`sem-diff: ${files.length} parser files in ${out}`);
