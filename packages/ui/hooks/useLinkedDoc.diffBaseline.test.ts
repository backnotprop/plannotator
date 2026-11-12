import { describe, expect, test } from "bun:test";
import { resolveDiffBaseline } from "./useLinkedDoc";

const VERSION_INFO_A = { version: 2, totalVersions: 2, project: "demo" };
const VERSION_INFO_B = { version: 3, totalVersions: 3, project: "demo" };

describe("resolveDiffBaseline", () => {
  test("no cache entry — falls through to the freshly-fetched data", () => {
    const result = resolveDiffBaseline(undefined, {
      previousPlan: "old text",
      versionInfo: VERSION_INFO_A,
    });
    expect(result).toEqual({ previousPlan: "old text", versionInfo: VERSION_INFO_A });
  });

  test("cached baseline wins over a fresh fetch — re-opening a document doesn't refetch its baseline", () => {
    const result = resolveDiffBaseline(
      { previousPlan: "cached previous", versionInfo: VERSION_INFO_A },
      { previousPlan: "different fetched text", versionInfo: VERSION_INFO_B },
    );
    expect(result).toEqual({ previousPlan: "cached previous", versionInfo: VERSION_INFO_A });
  });

  test("cache entry exists but has no diff fields (e.g. opened via a non-diff-aware path) — falls through to fetched data", () => {
    const result = resolveDiffBaseline(
      { previousPlan: undefined, versionInfo: undefined },
      { previousPlan: "fetched text", versionInfo: VERSION_INFO_B },
    );
    expect(result).toEqual({ previousPlan: "fetched text", versionInfo: VERSION_INFO_B });
  });

  test("neither cache nor data has diff fields — a document with no eligible history stays null/undefined", () => {
    const result = resolveDiffBaseline(undefined, { previousPlan: undefined, versionInfo: undefined });
    expect(result.previousPlan).toBeUndefined();
    expect(result.versionInfo).toBeUndefined();
  });

  test("a first-ever-open document (version 1, no history yet) — cached null previousPlan is preserved, not treated as absent", () => {
    const result = resolveDiffBaseline(
      { previousPlan: null, versionInfo: { version: 1, totalVersions: 1, project: "demo" } },
      { previousPlan: "should not be used", versionInfo: VERSION_INFO_B },
    );
    expect(result.previousPlan).toBeNull();
    expect(result.versionInfo).toEqual({ version: 1, totalVersions: 1, project: "demo" });
  });
});
