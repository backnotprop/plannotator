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
});
