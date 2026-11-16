import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { SEM_DIFF_FILES } from "@plannotator/shared/sem-diff-assets";

describe("embedded sem-diff parsers", () => {
  test("the binary embeds every wasm file the engine package ships, or semantic diffs turn off", () => {
    const source = readFileSync(new URL("./sem-diff.ts", import.meta.url), "utf8");
    const embedded = [...source.matchAll(/import\("\.\.\/dist\/sem-diff\/([^"]+)"/g)].map((m) => m[1]);
    const keyed = [...source.matchAll(/^\s*"([^"]+\.wasm)": \w+,$/gm)].map((m) => m[1]);
    expect(embedded.sort()).toEqual([...SEM_DIFF_FILES].sort());
    expect(keyed.sort()).toEqual([...SEM_DIFF_FILES].sort());
  });
});
