import { describe, expect, test } from "bun:test";
import {
  getCallFlowTreesForFiles,
  indexCallFlowImpacts,
  parseCallDiffWorkerResult,
} from "./call-flow-types";

describe("parseCallDiffWorkerResult", () => {
  test("keeps structured trees and the canonical colorless CallDiff output", () => {
    const parsed = parseCallDiffWorkerResult({
      protocol: 1,
      ok: true,
      version: "0.4.1",
      diagnostics: [{ level: "warning", message: "one file was skipped" }],
      result: {
        from: "abc",
        to: "def",
        ascii: "calldiff diff abc → def\n\n  main  src/main.ts:1\n+ └─ save  src/main.ts:5",
        trees: [{
          entry: "main",
          ascii: "  main  src/main.ts:1\n+ └─ save  src/main.ts:5",
          tree: {
            key: "main",
            label: "main",
            status: "same",
            file: "src/main.ts",
            line: 1,
            children: [{
              key: "save",
              label: "save",
              status: "added",
              file: "src/main.ts",
              line: 5,
              children: [],
            }],
          },
        }],
      },
    });

    expect(parsed.trees).toHaveLength(1);
    expect(parsed.trees[0].tree.children[0].status).toBe("added");
    expect(parsed.trees[0]).toMatchObject({
      raw: "  main  src/main.ts:1\n+ └─ save  src/main.ts:5",
      rawLineStart: 3,
    });
    expect(parsed.raw).toContain("src/main.ts:5");
    expect(parsed.diagnostics).toEqual([{ level: "warning", message: "one file was skipped" }]);
  });

  test("keeps structured analysis when an entry raw slice cannot be aligned", () => {
    const parsed = parseCallDiffWorkerResult({
      protocol: 1,
      ok: true,
      version: "0.4.1",
      result: {
        from: "abc",
        to: "def",
        ascii: "calldiff diff abc → def\n\n+ canonical()",
        trees: [{
          entry: "canonical",
          ascii: "+ differently-rendered()",
          tree: {
            key: "canonical",
            label: "canonical()",
            status: "added",
            file: "src/main.ts",
            line: 1,
            children: [],
          },
        }],
      },
    });

    expect(parsed.trees).toHaveLength(1);
    expect(parsed.trees[0]?.tree.label).toBe("canonical()");
    expect(parsed.trees[0]?.raw).toBeUndefined();
    expect(parsed.raw).toContain("canonical()");
  });

  test("aligns entry raw slices without assuming tree-array order", () => {
    const parsed = parseCallDiffWorkerResult({
      protocol: 1,
      ok: true,
      version: "0.4.1",
      result: {
        from: "abc",
        to: "def",
        ascii: "header\n\n+ first()\n\n+ second()",
        trees: [
          {
            entry: "second",
            ascii: "+ second()",
            tree: { key: "second", label: "second()", status: "added", children: [] },
          },
          {
            entry: "first",
            ascii: "+ first()",
            tree: { key: "first", label: "first()", status: "added", children: [] },
          },
        ],
      },
    });

    expect(parsed.trees[0]).toMatchObject({ raw: "+ second()", rawLineStart: 5 });
    expect(parsed.trees[1]).toMatchObject({ raw: "+ first()", rawLineStart: 3 });
  });

  test("rejects malformed nodes at the process boundary", () => {
    expect(() => parseCallDiffWorkerResult({
      protocol: 1,
      ok: true,
      version: "0.4.1",
      result: { from: "a", to: "b", ascii: "raw", trees: [{ entry: "x", tree: { status: "changed" } }] },
    })).toThrow("invalid node status");
  });

  test("rejects absolute and parent-traversing source locations", () => {
    const responseForFile = (file: string) => ({
      protocol: 1,
      ok: true,
      version: "0.4.1",
      result: {
        from: "a",
        to: "b",
        ascii: "raw",
        trees: [{ entry: "x", tree: { key: "x", label: "x", status: "added", file, children: [] } }],
      },
    });
    expect(() => parseCallDiffWorkerResult(responseForFile("/tmp/source.ts"))).toThrow("unsafe source path");
    expect(() => parseCallDiffWorkerResult(responseForFile("src/../../secret.ts"))).toThrow("unsafe source path");
    expect(() => parseCallDiffWorkerResult(responseForFile("C:\\repo\\source.ts"))).toThrow("unsafe source path");
    expect(() => parseCallDiffWorkerResult(responseForFile(`${"a".repeat(2_100)}/../secret.ts`))).toThrow("unsafe source path");
  });

  test("rejects rather than truncating an over-budget tree list", () => {
    const tree = { entry: "x", tree: { key: "x", label: "x", status: "same", children: [] } };
    expect(() => parseCallDiffWorkerResult({
      protocol: 1,
      ok: true,
      version: "0.4.1",
      result: { from: "a", to: "b", ascii: "raw", trees: Array.from({ length: 101 }, () => tree) },
    })).toThrow("tree limits");
  });

  test("rejects missing or over-budget raw output", () => {
    const tree = { entry: "x", tree: { key: "x", label: "x", status: "same", children: [] } };
    expect(() => parseCallDiffWorkerResult({
      protocol: 1,
      ok: true,
      version: "0.4.1",
      result: { from: "a", to: "b", trees: [tree] },
    })).toThrow("missing its raw diff");
    expect(() => parseCallDiffWorkerResult({
      protocol: 1,
      ok: true,
      version: "0.4.1",
      result: { from: "a", to: "b", ascii: "x".repeat(1024 * 1024 + 1), trees: [tree] },
    })).toThrow("1 MB limit");
  });
});

describe("indexCallFlowImpacts", () => {
  test("indexes only changed nodes by source file", () => {
    const result = indexCallFlowImpacts([{ entry: "main", raw: "main", rawLineStart: 1, tree: {
      key: "main", label: "main", status: "same", file: "src/main.ts", children: [
        { key: "old", label: "old", status: "removed", file: "src/main.ts", line: 4, children: [] },
        { key: "new", label: "new", status: "added", file: "src/new.ts", line: 9, children: [] },
      ],
    } }]);
    expect(result.summary).toMatchObject({ entries: 1, changedNodes: 2, added: 1, removed: 1, impactedFiles: 2 });
    expect(result.fileImpacts["src/main.ts"][0]).toMatchObject({ key: "old", status: "removed" });
  });

  test("deduplicates the same source node reached through multiple entry paths", () => {
    const changed = {
      key: "save",
      label: "save(order)",
      status: "added" as const,
      file: "src/order.ts",
      line: 12,
      children: [],
    };
    const result = indexCallFlowImpacts([
      { entry: "checkout", raw: "checkout", rawLineStart: 1, tree: { key: "checkout", label: "checkout", status: "same", children: [changed] } },
      { entry: "submitOrder", raw: "submitOrder", rawLineStart: 3, tree: { key: "submitOrder", label: "submitOrder", status: "same", children: [changed] } },
    ]);

    expect(result.summary).toMatchObject({ entries: 2, changedNodes: 1, added: 1 });
    expect(result.fileImpacts["src/order.ts"]).toHaveLength(1);
    expect(result.fileImpacts["src/order.ts"][0].entries).toEqual(["checkout", "submitOrder"]);
  });
});

describe("getCallFlowTreesForFiles", () => {
  test("returns complete entry trees instead of pruning to changed nodes", () => {
    const trees = [{
      entry: "checkout",
      raw: "checkout",
      rawLineStart: 1,
      tree: {
        key: "checkout",
        label: "checkout",
        status: "same" as const,
        file: "src/checkout.ts",
        children: [{
          key: "validate",
          label: "validate",
          status: "same" as const,
          file: "src/validate.ts",
          children: [{
            key: "save",
            label: "save",
            status: "added" as const,
            file: "src/order.ts",
            line: 12,
            children: [],
          }],
        }],
      },
    }, {
      entry: "healthcheck",
      raw: "healthcheck",
      rawLineStart: 3,
      tree: {
        key: "healthcheck",
        label: "healthcheck",
        status: "same" as const,
        children: [],
      },
    }];

    const relevant = getCallFlowTreesForFiles(trees, ["src/order.ts"]);

    expect(relevant).toHaveLength(1);
    expect(relevant[0]).toBe(trees[0]);
    expect(relevant[0].tree.children[0].label).toBe("validate");
  });
});
