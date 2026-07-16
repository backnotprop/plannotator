import { describe, expect, test } from "bun:test";
import type { VaultNode } from "../../types";
import type { WorkspaceFileChange, WorkspaceStatusPayload } from "@plannotator/core/workspace-status-types";
import {
  filterFileTree,
  getAggregateWorkspaceChange,
  getFileEditStatus,
  getFileTreeFilterTokens,
  getWorkspaceChange,
  isFileTreeSelectionDisabled,
  normalizePathForLookup,
} from "./FileBrowser";

describe("FileBrowser filtering", () => {
  const tree: VaultNode[] = [
    {
      name: "docs",
      path: "docs",
      type: "folder",
      children: [
        { name: "intro.md", path: "docs/intro.md", type: "file" },
        {
          name: "auth",
          path: "docs/auth",
          type: "folder",
          children: [
            { name: "middleware.md", path: "docs/auth/middleware.md", type: "file" },
            { name: "session.md", path: "docs/auth/session.md", type: "file" },
          ],
        },
      ],
    },
    { name: "changelog.txt", path: "changelog.txt", type: "file" },
  ];

  test("keeps ancestor folders for matching descendant files", () => {
    expect(filterFileTree(tree, getFileTreeFilterTokens("middleware"))).toEqual([
      {
        name: "docs",
        path: "docs",
        type: "folder",
        children: [
          {
            name: "auth",
            path: "docs/auth",
            type: "folder",
            children: [
              { name: "middleware.md", path: "docs/auth/middleware.md", type: "file" },
            ],
          },
        ],
      },
    ]);
  });

  test("matches multiple tokens across the full path", () => {
    expect(filterFileTree(tree, getFileTreeFilterTokens("auth session"))).toEqual([
      {
        name: "docs",
        path: "docs",
        type: "folder",
        children: [
          {
            name: "auth",
            path: "docs/auth",
            type: "folder",
            children: [
              { name: "session.md", path: "docs/auth/session.md", type: "file" },
            ],
          },
        ],
      },
    ]);
  });

  test("keeps a matching folder subtree intact", () => {
    expect(filterFileTree(tree, getFileTreeFilterTokens("auth"))).toEqual([
      {
        name: "docs",
        path: "docs",
        type: "folder",
        children: [
          {
            name: "auth",
            path: "docs/auth",
            type: "folder",
            children: [
              { name: "middleware.md", path: "docs/auth/middleware.md", type: "file" },
              { name: "session.md", path: "docs/auth/session.md", type: "file" },
            ],
          },
        ],
      },
    ]);
  });
});

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

  test("allows selecting a deleted file when Plannotator still has a missing-file buffer", () => {
    const deleted: WorkspaceFileChange = {
      path: "/repo/docs/plan.md",
      repoRelativePath: "docs/plan.md",
      status: "deleted",
      additions: 0,
      deletions: 3,
      staged: false,
      unstaged: true,
    };

    expect(isFileTreeSelectionDisabled(deleted, undefined)).toBe(true);
    expect(isFileTreeSelectionDisabled(deleted, { status: "dirty", dirty: true })).toBe(true);
    expect(isFileTreeSelectionDisabled(deleted, { status: "missing", dirty: false })).toBe(false);
    expect(isFileTreeSelectionDisabled({ ...deleted, status: "modified" }, undefined)).toBe(false);
  });

  test("matches edit statuses when the UI path uses mixed separators or doubled slashes", () => {
    const statuses = new Map([
      ["C:\\repo\\docs\\plan.md", { status: "missing" as const, dirty: false }],
      ["/repo/docs/other.md", { status: "dirty" as const, dirty: true }],
    ]);

    expect(getFileEditStatus("C:\\repo\\docs/plan.md", statuses)?.status).toBe("missing");
    expect(getFileEditStatus("/repo/docs//other.md", statuses)?.status).toBe("dirty");
  });

  test("keeps a deleted file selectable when the missing edit status needs path normalization", () => {
    const deleted: WorkspaceFileChange = {
      path: "C:\\repo\\docs\\plan.md",
      repoRelativePath: "docs/plan.md",
      status: "deleted",
      additions: 0,
      deletions: 3,
      staged: false,
      unstaged: true,
    };
    const statuses = new Map([
      ["C:\\repo\\docs\\plan.md", { status: "missing" as const, dirty: false }],
    ]);
    const editStatus = getFileEditStatus("C:\\repo\\docs/plan.md", statuses);

    expect(editStatus?.status).toBe("missing");
    expect(isFileTreeSelectionDisabled(deleted, editStatus)).toBe(false);
  });

  test("matches deleted-file status through a symlinked folder root alias", () => {
    const status: WorkspaceStatusPayload = {
      available: true,
      rootPath: "/real/docs",
      repoRoot: "/real",
      files: {
        "/real/docs/plan.md": {
          path: "/real/docs/plan.md",
          repoRelativePath: "docs/plan.md",
          status: "deleted",
          additions: 0,
          deletions: 5,
          staged: false,
          unstaged: true,
        },
      },
      totals: { files: 1, additions: 0, deletions: 5 },
    };
    const editStatuses = new Map([
      ["/real/docs/plan.md", { status: "missing" as const, dirty: false }],
    ]);
    const node: VaultNode = {
      name: "docs",
      path: ".",
      type: "folder",
      children: [{ name: "plan.md", path: "plan.md", type: "file" }],
    };

    const workspaceChange = getWorkspaceChange("/link/docs/plan.md", status, "plan.md");
    const editStatus = getFileEditStatus("/link/docs/plan.md", editStatuses, "plan.md", status);

    expect(workspaceChange?.status).toBe("deleted");
    expect(editStatus?.status).toBe("missing");
    expect(isFileTreeSelectionDisabled(workspaceChange, editStatus)).toBe(false);
    expect(getAggregateWorkspaceChange(node, "/link/docs", status)).toEqual({
      additions: 0,
      deletions: 5,
      files: 1,
    });
  });
});
