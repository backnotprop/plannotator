import { describe, expect, test } from "bun:test";
import { parsePRUrl } from "./pr-provider";
import { buildFilePatch_TEST, computeHunks_TEST } from "./pr-azuredevops";

// ─── URL Parsing ─────────────────────────────────────────────────────────────

describe("parsePRUrl – Azure DevOps", () => {
  test("parses dev.azure.com URL", () => {
    const ref = parsePRUrl("https://dev.azure.com/myorg/MyProject/_git/MyRepo/pullrequest/42");
    expect(ref).toMatchObject({
      platform: "azuredevops",
      orgUrl: "https://dev.azure.com/myorg",
      organization: "myorg",
      project: "MyProject",
      repo: "MyRepo",
      id: 42,
    });
  });

  test("parses legacy visualstudio.com URL", () => {
    const ref = parsePRUrl("https://myorg.visualstudio.com/MyProject/_git/MyRepo/pullrequest/99");
    expect(ref).toMatchObject({
      platform: "azuredevops",
      orgUrl: "https://myorg.visualstudio.com",
      organization: "myorg",
      project: "MyProject",
      repo: "MyRepo",
      id: 99,
    });
  });

  test("decodes URL-encoded spaces in project/repo names", () => {
    const ref = parsePRUrl("https://dev.azure.com/myorg/My%20Project/_git/My%20Repo/pullrequest/7");
    expect(ref).toMatchObject({
      platform: "azuredevops",
      project: "My Project",
      repo: "My Repo",
    });
  });

  test("is case-insensitive for pullrequest segment", () => {
    const ref = parsePRUrl("https://dev.azure.com/myorg/Proj/_git/Repo/PullRequest/1");
    expect(ref).toMatchObject({ platform: "azuredevops", id: 1 });
  });

  test("parses large PR ID", () => {
    const ref = parsePRUrl("https://dev.azure.com/org/proj/_git/repo/pullrequest/155857");
    expect(ref).toMatchObject({ platform: "azuredevops", id: 155857 });
  });

  test("returns null for non-ADO URLs", () => {
    expect(parsePRUrl("https://example.com/foo")).toBeNull();
    expect(parsePRUrl("")).toBeNull();
  });

  // Regression: GitHub and GitLab still parse correctly
  test("does not break GitHub URL parsing", () => {
    const ref = parsePRUrl("https://github.com/owner/repo/pull/1");
    expect(ref).toMatchObject({ platform: "github", owner: "owner", repo: "repo", number: 1 });
  });

  test("does not break GitLab URL parsing", () => {
    const ref = parsePRUrl("https://gitlab.com/group/project/-/merge_requests/5");
    expect(ref).toMatchObject({ platform: "gitlab", host: "gitlab.com", iid: 5 });
  });

  test("does not break self-hosted GitLab parsing", () => {
    const ref = parsePRUrl("https://gitlab.myco.com/grp/sub/proj/-/merge_requests/10");
    expect(ref).toMatchObject({ platform: "gitlab", host: "gitlab.myco.com", iid: 10 });
  });
});

// ─── Diff Engine ─────────────────────────────────────────────────────────────

describe("buildFilePatch – unified diff generation", () => {
  test("produces git-style header for edited file", () => {
    const patch = buildFilePatch_TEST(
      "line1\nline2\nline3\n",
      "line1\nchanged\nline3\n",
      "src/foo.ts",
    );
    expect(patch).toContain("diff --git a/src/foo.ts b/src/foo.ts");
    expect(patch).toContain("--- a/src/foo.ts");
    expect(patch).toContain("+++ b/src/foo.ts");
    expect(patch).toContain("-line2");
    expect(patch).toContain("+changed");
  });

  test("uses /dev/null for added files", () => {
    const patch = buildFilePatch_TEST("", "new content\n", "src/new.ts", undefined, "add");
    expect(patch).toContain("--- /dev/null");
    expect(patch).toContain("+++ b/src/new.ts");
    expect(patch).toContain("+new content");
  });

  test("uses /dev/null for deleted files", () => {
    const patch = buildFilePatch_TEST("old content\n", "", "src/old.ts", undefined, "delete");
    expect(patch).toContain("--- a/src/old.ts");
    expect(patch).toContain("+++ /dev/null");
    expect(patch).toContain("-old content");
  });

  test("returns empty string for identical files", () => {
    const patch = buildFilePatch_TEST("same\n", "same\n", "src/same.ts");
    expect(patch).toBe("");
  });

  test("handles files without trailing newline", () => {
    const patch = buildFilePatch_TEST("a\nb", "a\nc", "src/no-newline.ts");
    expect(patch).toContain("-b");
    expect(patch).toContain("+c");
  });

  test("includes rename path in header", () => {
    const patch = buildFilePatch_TEST(
      "content\n",
      "content changed\n",
      "src/new-name.ts",
      "src/old-name.ts",
      "rename",
    );
    expect(patch).toContain("a/src/old-name.ts");
    expect(patch).toContain("b/src/new-name.ts");
  });

  test("produces correct hunk header line numbers", () => {
    const old = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n") + "\n";
    const changed = old.replace("line5", "CHANGED");
    const patch = buildFilePatch_TEST(old, changed, "src/long.ts");
    expect(patch).toContain("@@");
    expect(patch).toContain("-line5");
    expect(patch).toContain("+CHANGED");
  });

  test("groups nearby changes into a single hunk", () => {
    const old = "a\nb\nc\nd\ne\nf\ng\n";
    const changed = "a\nB\nc\nd\ne\nF\ng\n";
    const patch = buildFilePatch_TEST(old, changed, "src/multi.ts");
    // Two changes 3 lines apart should be merged into one hunk
    const hunkCount = (patch.match(/^@@/gm) ?? []).length;
    expect(hunkCount).toBe(1);
  });

  test("splits distant changes into separate hunks", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line${i + 1}`);
    const changed = [...lines];
    changed[0] = "CHANGED_TOP";
    changed[29] = "CHANGED_BOTTOM";
    const patch = buildFilePatch_TEST(
      lines.join("\n") + "\n",
      changed.join("\n") + "\n",
      "src/split.ts",
    );
    const hunkCount = (patch.match(/^@@/gm) ?? []).length;
    expect(hunkCount).toBe(2);
  });
});

// ─── Hunk computation ────────────────────────────────────────────────────────

describe("computeHunks", () => {
  test("returns empty for identical content", () => {
    const hunks = computeHunks_TEST(["a", "b", "c"], ["a", "b", "c"]);
    expect(hunks).toHaveLength(0);
  });

  test("detects addition at end", () => {
    const hunks = computeHunks_TEST(["a", "b"], ["a", "b", "c"]);
    expect(hunks.join("\n")).toContain("+c");
  });

  test("detects deletion", () => {
    const hunks = computeHunks_TEST(["a", "b", "c"], ["a", "c"]);
    expect(hunks.join("\n")).toContain("-b");
  });

  test("detects replacement", () => {
    const hunks = computeHunks_TEST(["a", "b", "c"], ["a", "X", "c"]);
    const joined = hunks.join("\n");
    expect(joined).toContain("-b");
    expect(joined).toContain("+X");
  });
});
