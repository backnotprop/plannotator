import type { SemDiffSources } from "@plannotator/shared/sem-diff-assets";

let pending: Promise<SemDiffSources | null> | null = null;

async function read(module: Promise<{ default: unknown }>): Promise<Uint8Array> {
  const path = (await module).default;
  if (typeof path !== "string") throw new Error("not an embedded file");
  return Bun.file(path).bytes();
}

export function loadEmbeddedSemDiff(): Promise<SemDiffSources | null> {
  pending ??= (async () => {
    try {
      const [runtime, typescript, tsx, python, go, rust] = await Promise.all([
        // @ts-ignore - Bun import attribute for an embedded file
        read(import("../dist/sem-diff/web-tree-sitter.wasm", { with: { type: "file" } })),
        // @ts-ignore - Bun import attribute for an embedded file
        read(import("../dist/sem-diff/tree-sitter-typescript.wasm", { with: { type: "file" } })),
        // @ts-ignore - Bun import attribute for an embedded file
        read(import("../dist/sem-diff/tree-sitter-tsx.wasm", { with: { type: "file" } })),
        // @ts-ignore - Bun import attribute for an embedded file
        read(import("../dist/sem-diff/tree-sitter-python.wasm", { with: { type: "file" } })),
        // @ts-ignore - Bun import attribute for an embedded file
        read(import("../dist/sem-diff/tree-sitter-go.wasm", { with: { type: "file" } })),
        // @ts-ignore - Bun import attribute for an embedded file
        read(import("../dist/sem-diff/tree-sitter-rust.wasm", { with: { type: "file" } })),
      ]);
      return {
        "web-tree-sitter.wasm": runtime,
        "tree-sitter-typescript.wasm": typescript,
        "tree-sitter-tsx.wasm": tsx,
        "tree-sitter-python.wasm": python,
        "tree-sitter-go.wasm": go,
        "tree-sitter-rust.wasm": rust,
      };
    } catch {
      return null;
    }
  })();
  return pending;
}
