import { describe, expect, test } from "bun:test";
import { inboxScratchCandidate, inboxScratchSlug } from "./inbox-scratch";

describe("inboxScratchSlug", () => {
  test("a thread name becomes one safe folder name: never a path, a dot name or empty", () => {
    expect(inboxScratchSlug("Settings search")).toBe("settings-search");
    expect(inboxScratchSlug("  Fix: the café's ÜBER bug!! ")).toBe("fix-the-cafe-s-uber-bug");
    // Nothing that could leave the root or hide: separators and dots become dashes, and leading or trailing dashes go.
    expect(inboxScratchSlug("../../etc/passwd")).toBe("etc-passwd");
    expect(inboxScratchSlug(".hidden")).toBe("hidden");
    expect(inboxScratchSlug("a\\b/c\u0000d")).toBe("a-b-c-d");
    for (const empty of ["", "   ", "..", "日本語", null, undefined]) expect(inboxScratchSlug(empty)).toBe("scratch");
    const long = inboxScratchSlug(`${"word ".repeat(30)}end`);
    expect(long.length).toBeLessThanOrEqual(48);
    expect(long.endsWith("-")).toBe(false);
  });

  test("a taken name gets -2, -3", () => {
    expect([1, 2, 3].map((n) => inboxScratchCandidate("settings-search", n))).toEqual(["settings-search", "settings-search-2", "settings-search-3"]);
  });
});
