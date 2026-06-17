import { describe, expect, test } from "bun:test";
import type { VaultNode } from "../../types";
import type { WorkspaceStatusPayload } from "@plannotator/shared/workspace-status";
import { getAggregateWorkspaceChange, getWorkspaceChange, normalizePathForLookup } from "./FileBrowser";

describe("FileBrowser workspace status lookup", () => {
  test("matches Windows status keys when the UI path uses mixed separators", () => {
    const status: WorkspaceStatusPayload = {
      available: true,
      rootPath: "C:\\repo\\docs",
      repoRoot: "C:\\repo",
      files: {
        "C:\\repo\\docs\\nested\\a.md": {
          path: "C:\\repo\\docs\\nested\\a.md",
          repoRelativePath: "docs/nested/a.md",
          status: "modified",
          additions: 3,
          deletions: 1,
          staged: false,
          unstaged: true,
        },
      },
      totals: { files: 1, additions: 3, deletions: 1 },
    };

    expect(normalizePathForLookup("C:\\repo\\docs/nested/a.md")).toBe("C:/repo/docs/nested/a.md");
    expect(getWorkspaceChange("C:\\repo\\docs/nested/a.md", status)?.additions).toBe(3);

    const node: VaultNode = {
      name: "nested",
      path: "nested",
      type: "folder",
      children: [{ name: "a.md", path: "nested/a.md", type: "file" }],
    };
    expect(getAggregateWorkspaceChange(node, "C:\\repo\\docs", status)).toEqual({
      additions: 3,
      deletions: 1,
      files: 1,
    });
  });

  test("matches workspace status when configured directory has a trailing slash", () => {
    const status: WorkspaceStatusPayload = {
      available: true,
      rootPath: "/repo/docs",
      repoRoot: "/repo",
      files: {
        "/repo/docs/plan.md": {
          path: "/repo/docs/plan.md",
          repoRelativePath: "docs/plan.md",
          status: "modified",
          additions: 4,
          deletions: 2,
          staged: false,
          unstaged: true,
        },
      },
      totals: { files: 1, additions: 4, deletions: 2 },
    };
    const node: VaultNode = {
      name: "docs",
      path: ".",
      type: "folder",
      children: [{ name: "plan.md", path: "plan.md", type: "file" }],
    };

    expect(normalizePathForLookup("/repo/docs//plan.md")).toBe("/repo/docs/plan.md");
    expect(getWorkspaceChange("/repo/docs//plan.md", status)?.additions).toBe(4);
    expect(getAggregateWorkspaceChange(node, "/repo/docs/", status)).toEqual({
      additions: 4,
      deletions: 2,
      files: 1,
    });
  });
});
