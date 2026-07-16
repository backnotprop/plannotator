import { describe, it, expect } from "bun:test";
import { buildFileTree, getAncestorPaths, getAllFolderPaths } from "./buildFileTree";
import type { DiffFile } from "../types";

const diffFile = (path: string, overrides: Partial<DiffFile> = {}): DiffFile => ({
  path,
  patch: "",
  additions: 0,
  deletions: 0,
  status: "modified",
  ...overrides,
});

describe("buildFileTree - workspace mode with repo-prefixed paths", () => {
  it("builds separate trees for different repo prefixes", () => {
    const files = [
      diffFile("repo-a/src/index.ts"),
      diffFile("repo-b/src/index.ts"),
    ];
    const tree = buildFileTree(files);

    // With flat fallback: single root folder with only file children gets unwrapped
    // But here we have two repos at root level, so they stay as folders
    expect(tree.length).toBeGreaterThanOrEqual(2);
    // After collapseSingleChild, paths like repo-a/src/index.ts become:
    // folder: "repo-a/src" with file child "index.ts"
    const names = tree.map(n => n.name);
    expect(names).toContain("repo-a/src");
    expect(names).toContain("repo-b/src");
  });

  it("handles same relative paths in different repos", () => {
    const files = [
      diffFile("repo-a/src/utils/helper.ts", { additions: 5, deletions: 2 }),
      diffFile("repo-b/src/utils/helper.ts", { additions: 3, deletions: 1 }),
    ];
    const tree = buildFileTree(files);

    // After collapseSingleChild: repo-a/src/utils becomes a single folder node
    const repoA = tree.find(n => n.name === "repo-a/src/utils");
    const repoB = tree.find(n => n.name === "repo-b/src/utils");

    expect(repoA).toBeDefined();
    expect(repoB).toBeDefined();

    // Each should have the helper.ts file as a child
    const repoAFile = repoA?.children?.find(n => n.name === "helper.ts");
    const repoBFile = repoB?.children?.find(n => n.name === "helper.ts");

    expect(repoAFile).toBeDefined();
    expect(repoBFile).toBeDefined();
    expect(repoAFile?.path).toBe("repo-a/src/utils/helper.ts");
    expect(repoBFile?.path).toBe("repo-b/src/utils/helper.ts");
    expect(repoAFile?.additions).toBe(5);
    expect(repoBFile?.additions).toBe(3);
  });

  it("handles nested repo labels (longest prefix)", () => {
    // Simulates repos like "apps", "apps/api", "apps/web"
    const files = [
      diffFile("apps/src/main.ts"),
      diffFile("apps/api/src/server.ts"),
      diffFile("apps/web/src/app.ts"),
    ];
    const tree = buildFileTree(files);

    // All under single "apps" root, with children for each sub-repo
    // After collapseSingleChild: api/src and web/src collapse
    expect(tree).toHaveLength(1);
    expect(tree[0].name).toBe("apps");
    expect(tree[0].type).toBe("folder");

    // Children: "api/src" (collapsed), "src" (from apps/src), "web/src" (collapsed)
    const childNames = tree[0].children?.map(n => n.name).sort();
    expect(childNames).toEqual(["api/src", "src", "web/src"]);
  });

  it("handles deeply nested repo labels", () => {
    const files = [
      diffFile("packages/shared/utils/helpers/string.ts"),
      diffFile("packages/core/src/index.ts"),
    ];
    const tree = buildFileTree(files);

    expect(tree).toHaveLength(1);
    expect(tree[0].name).toBe("packages");
    expect(tree[0].type).toBe("folder");

    // After collapseSingleChild, packages/core/src collapses to "core/src"
    // and packages/shared/utils/helpers collapses to "shared/utils/helpers"
    const children = tree[0].children?.map(n => n.name).sort();
    expect(children).toEqual(["core/src", "shared/utils/helpers"]);
  });

  it("collapses single-child folders correctly with repo prefixes", () => {
    const files = [
      diffFile("repo-a/src/components/Button.tsx"),
    ];
    const tree = buildFileTree(files);

    // After collapseSingleChild: repo-a/src/components collapses to single path
    // Then flat fallback kicks in: single folder with only file children gets unwrapped
    // Result: just the file at root level
    expect(tree).toHaveLength(1);
    expect(tree[0].name).toBe("Button.tsx");
    expect(tree[0].type).toBe("file");
    expect(tree[0].path).toBe("repo-a/src/components/Button.tsx");
  });

  it("aggregates stats correctly across repo boundaries", () => {
    const files = [
      diffFile("repo-a/src/index.ts", { additions: 10, deletions: 5 }),
      diffFile("repo-a/src/utils.ts", { additions: 5, deletions: 2 }),
      diffFile("repo-b/src/index.ts", { additions: 8, deletions: 3 }),
    ];
    const tree = buildFileTree(files);

    // After collapseSingleChild: repo-a/src contains both files
    const repoA = tree.find(n => n.name === "repo-a/src");
    const repoB = tree.find(n => n.name === "repo-b/src");

    expect(repoA?.additions).toBe(15); // 10 + 5
    expect(repoA?.deletions).toBe(7);  // 5 + 2
    expect(repoB?.additions).toBe(8);
    expect(repoB?.deletions).toBe(3);
  });

  it("handles repo labels with special characters", () => {
    const files = [
      diffFile("my-repo_2.0/src/index.ts"),
      diffFile("my-repo_2.0-beta/src/app.ts"),
    ];
    const tree = buildFileTree(files);

    // Two separate root-level folders after collapse
    expect(tree.length).toBeGreaterThanOrEqual(2);
    const names = tree.map(n => n.name);
    expect(names).toContain("my-repo_2.0/src");
    expect(names).toContain("my-repo_2.0-beta/src");
  });

  it("preserves full prefixed path in node path property", () => {
    const files = [
      diffFile("owner/repo/src/index.ts"),
    ];
    const tree = buildFileTree(files);

    // Collapses to "owner/repo/src" folder, then flat fallback unwraps
    // Result: just the file with full path preserved
    expect(tree[0].name).toBe("index.ts");
    expect(tree[0].path).toBe("owner/repo/src/index.ts");
  });

  it("handles empty file list", () => {
    const tree = buildFileTree([]);
    expect(tree).toHaveLength(0);
  });

  it("handles single file in repo (flat fallback)", () => {
    const files = [diffFile("repo-a/README.md")];
    const tree = buildFileTree(files);

    // Flat fallback: single root folder with only file children gets unwrapped
    // But first collapseSingleChild collapses repo-a to contain README.md
    // Then flat fallback sees single folder "repo-a" with file child, unwraps it
    expect(tree).toHaveLength(1);
    expect(tree[0].name).toBe("README.md");
    expect(tree[0].type).toBe("file");
    expect(tree[0].path).toBe("repo-a/README.md");
  });

  it("handles multiple files in same repo subdirectories", () => {
    const files = [
      diffFile("repo-a/src/index.ts"),
      diffFile("repo-a/src/app.ts"),
      diffFile("repo-a/lib/helpers.ts"),
    ];
    const tree = buildFileTree(files);

    // repo-a has two children: src (with 2 files) and lib (with 1 file)
    // So it doesn't get unwrapped by flat fallback
    expect(tree).toHaveLength(1);
    expect(tree[0].name).toBe("repo-a");
    expect(tree[0].type).toBe("folder");

    const children = tree[0].children?.map(n => n.name).sort();
    expect(children).toEqual(["lib", "src"]);
  });
});

describe("getAncestorPaths - workspace mode", () => {
  it("returns ancestor paths for repo-prefixed file", () => {
    const paths = getAncestorPaths("repo-a/src/utils/helper.ts");
    expect(paths).toEqual([
      "repo-a",
      "repo-a/src",
      "repo-a/src/utils",
    ]);
  });

  it("handles deeply nested repo labels", () => {
    const paths = getAncestorPaths("packages/shared/utils/helpers/string.ts");
    expect(paths).toEqual([
      "packages",
      "packages/shared",
      "packages/shared/utils",
      "packages/shared/utils/helpers",
    ]);
  });

  it("handles flat repo structure", () => {
    const paths = getAncestorPaths("repo-a/file.ts");
    expect(paths).toEqual(["repo-a"]);
  });
});

describe("getAllFolderPaths - workspace mode", () => {
  it("collects all folder paths from repo-prefixed tree", () => {
    const files = [
      diffFile("repo-a/src/index.ts"),
      diffFile("repo-b/src/app.ts"),
    ];
    const tree = buildFileTree(files);
    const folders = getAllFolderPaths(tree);

    // After collapseSingleChild, we get "repo-a/src" and "repo-b/src"
    expect(folders).toContain("repo-a/src");
    expect(folders).toContain("repo-b/src");
  });

  it("collects nested repo label folders", () => {
    const files = [
      diffFile("apps/api/src/server.ts"),
      diffFile("apps/web/src/app.ts"),
    ];
    const tree = buildFileTree(files);
    const folders = getAllFolderPaths(tree);

    // After collapseSingleChild: apps stays, apps/api/src and apps/web/src
    expect(folders).toContain("apps");
    expect(folders).toContain("apps/api/src");
    expect(folders).toContain("apps/web/src");
  });
});
