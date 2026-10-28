import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchDefinitions } from "./symbol-search";

describe("symbol text search (no language server)", () => {
  const root = mkdtempSync(join(tmpdir(), "pn-symbols-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/retry.ts"), "export interface RetryPolicy { max: number }\nexport function computeBackoff(a: number) { return a; }\n");
  writeFileSync(join(root, "src/deliver.ts"), 'import { computeBackoff, type RetryPolicy } from "./retry";\nexport const deliver = async (p: RetryPolicy) => computeBackoff(1);\n');
  writeFileSync(join(root, "src/multi.ts"), 'import {\n  computeBackoff,\n  type RetryPolicy,\n} from "./retry";\nexport type Local = RetryPolicy;\n');
  writeFileSync(join(root, "src/py.py"), "def compute_backoff(attempt):\n    return attempt\n");

  it("finds definitions, never imports", async () => {
    expect(await searchDefinitions(root, ["src/deliver.ts", "src/multi.ts", "src/retry.ts"], "RetryPolicy")).toEqual([{ path: "src/retry.ts", line: 1 }]);
    expect(await searchDefinitions(root, ["src/deliver.ts", "src/retry.ts"], "computeBackoff")).toEqual([{ path: "src/retry.ts", line: 2 }]);
    expect(await searchDefinitions(root, ["src/deliver.ts"], "deliver")).toEqual([{ path: "src/deliver.ts", line: 2 }]);
    expect(await searchDefinitions(root, ["src/py.py"], "compute_backoff")).toEqual([{ path: "src/py.py", line: 1 }]);
    expect(await searchDefinitions(root, ["src/retry.ts", "missing.ts"], "nothing")).toEqual([]);
  });
});
