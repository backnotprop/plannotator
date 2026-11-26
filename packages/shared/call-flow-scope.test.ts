import { expect, test } from "bun:test";
import { selectCallFlowPaths } from "./call-flow";

test("small snapshots retain callers outside the diff", () => {
  const paths = ["caller.ts", "changed.ts"];
  expect(selectCallFlowPaths(paths, "diff --git a/changed.ts b/changed.ts\n")).toEqual({ paths });
});

test("large snapshots keep both sides of renames and deletions and disclose the scope", () => {
  const paths = ["old.ts", "new.ts", "deleted.ts", ...Array.from({ length: 4_000 }, (_, i) => `caller-${i}.ts`)];
  const patch = [
    "diff --git a/old.ts b/new.ts",
    "--- a/old.ts",
    "+++ b/new.ts",
    "diff --git a/deleted.ts b/deleted.ts",
    "--- a/deleted.ts",
    "+++ /dev/null",
  ].join("\n");
  const scope = selectCallFlowPaths(paths, patch);
  expect(scope.paths).toEqual(["old.ts", "new.ts", "deleted.ts"]);
  expect(scope.notice).toBeString();
});

test("the full repository is read up to 2,250 supported files and scoped above it", () => {
  const patch = "diff --git a/changed.ts b/changed.ts\n";
  const files = (count: number) => ["changed.ts", ...Array.from({ length: count - 1 }, (_, i) => `caller-${i}.ts`)];
  expect(selectCallFlowPaths(files(2_250), patch).notice).toBeUndefined();
  expect(selectCallFlowPaths(files(2_251), patch)).toMatchObject({ paths: ["changed.ts"], notice: expect.any(String) });
});
