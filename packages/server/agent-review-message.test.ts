import { describe, expect, test } from "bun:test";
import { buildAgentReviewUserMessage, buildAgentReviewUserMessageForTarget, getLocalDiffInstruction } from "./agent-review-message";
import { buildClaudeCommand } from "./claude-review";

const patch = "diff --git a/src/large.ts b/src/large.ts\n+const value = 1;\n";

describe("buildAgentReviewUserMessage", () => {
  test("builds Git local review instructions without inlining the patch", () => {
    const cases = [
      ["uncommitted", "current code changes"],
      ["staged", "git diff --staged"],
      ["unstaged", "unstaged code changes"],
      ["last-commit", "git diff HEAD~1..HEAD"],
      ["branch", "git diff origin/main..HEAD"],
      ["merge-base", "git merge-base origin/main HEAD"],
      ["all", "All files are shown as additions"],
    ] as const;

    for (const [diffType, expected] of cases) {
      const message = buildAgentReviewUserMessage(patch, diffType, { defaultBranch: "origin/main" });
      expect(message).toContain(expected);
      expect(message).not.toContain(patch);
    }
  });

  test("builds JJ local review instructions without inlining the patch", () => {
    const cases = [
      ["jj-current", "jj diff --git -r @"],
      ["jj-last", "jj diff --git -r @-"],
      ["jj-line", "jj diff --git --from 'heads(::@ & ::(trunk()))' --to @"],
      ["jj-all", "jj diff --git --from 'root()' --to @"],
    ] as const;

    for (const [diffType, command] of cases) {
      const message = buildAgentReviewUserMessage(patch, diffType, { defaultBranch: "trunk()" });
      expect(message).toContain(command);
      expect(message).toContain("Provide prioritized, actionable findings.");
      expect(message).not.toContain(patch);
    }
  });

  test("uses selected JJ compare target for line-of-work instructions", () => {
    const message = buildAgentReviewUserMessage(patch, "jj-line", { defaultBranch: "feature-base@origin" });

    expect(message).toContain("the JJ line of work against `feature-base@origin`");
    expect(message).toContain('remote_bookmarks(exact:"feature-base", exact:"origin")');
  });

  test("shell-quotes JJ line-of-work revsets with single quotes", () => {
    const message = buildAgentReviewUserMessage(patch, "jj-line", { defaultBranch: "feature'base" });

    expect(message).toContain("'heads(::@ & ::(bookmarks(exact:\"feature'\\''base\")))'");
    expect(message).not.toContain(patch);
  });

  test("normalizes worktree diff types using the encoded subtype", () => {
    const message = buildAgentReviewUserMessage(patch, "worktree:/tmp/repo:staged", { defaultBranch: "origin/main" });

    expect(message).toContain("git diff --staged");
    expect(message).not.toContain(patch);
  });

  test("falls back to the inline patch for unknown local diff types", () => {
    const message = buildAgentReviewUserMessage(patch, "p4-default");

    expect(message).toContain("Review the following code changes");
    expect(message).toContain(patch);
  });

  test("builds workspace review instructions with prefixed paths and inline patch", () => {
    const message = buildAgentReviewUserMessageForTarget({
      kind: "workspace",
      patch,
      workspace: {
        root: "/tmp/workspace",
        repos: [
          { label: "api", cwd: "/tmp/workspace/api", changed: true, vcsType: "git", gitRef: "Uncommitted changes" },
          { label: "web", cwd: "/tmp/workspace/web", changed: true, vcsType: "jj", gitRef: "Uncommitted changes" },
        ],
      },
    });

    expect(message).toContain("multiple nested VCS repositories");
    expect(message).toContain("workspace root: /tmp/workspace");
    expect(message).toContain("api/src/file.ts");
    expect(message).toContain("must exactly match the path shown in the diff");
    expect(message).toContain("web/src/file.ts");
    expect(message).toContain("Do not use bare repo-relative paths like `src/file.ts`");
    expect(message).toContain("do not use absolute filesystem paths");
    expect(message).toContain("- api/ [git, changed] -> /tmp/workspace/api");
    expect(message).toContain("- web/ [jj, changed] -> /tmp/workspace/web");
    expect(message).toContain("git -C <child-repo-folder>");
    expect(message).toContain("JJ child repos");
    expect(message).toContain(patch);
  });

  test("discloses failed child repositories in workspace review instructions", () => {
    const message = buildAgentReviewUserMessageForTarget({
      kind: "workspace",
      patch,
      workspace: {
        root: "/tmp/workspace",
        repos: [
          { label: "api", cwd: "/tmp/workspace/api", changed: true, vcsType: "git", gitRef: "Uncommitted changes" },
          { label: "web", cwd: "/tmp/workspace/web", changed: false, error: "Git workspace not found." },
        ],
      },
    });

    expect(message).toContain("partial workspace review");
    expect(message).toContain("- web/ [failed] -> /tmp/workspace/web - error: Git workspace not found.");
  });
});

describe("getLocalDiffInstruction", () => {
  test("returns null for non-local diff types", () => {
    expect(getLocalDiffInstruction("p4-default")).toBeNull();
  });
});

describe("buildClaudeCommand", () => {
  test("allows read-only JJ commands", () => {
    const command = buildClaudeCommand("review").command;
    const allowedTools = command[command.indexOf("--allowedTools") + 1];

    expect(allowedTools).toContain("Bash(jj status:*)");
    expect(allowedTools).toContain("Bash(jj diff:*)");
    expect(allowedTools).toContain("Bash(jj log:*)");
    expect(allowedTools).toContain("Bash(jj show:*)");
    expect(allowedTools).toContain("Bash(jj file show:*)");
    expect(allowedTools).toContain("Bash(jj cat:*)");
    expect(allowedTools).toContain("Bash(jj bookmark list:*)");
    expect(allowedTools).toContain("Bash(git -C:*)");
  });
});
