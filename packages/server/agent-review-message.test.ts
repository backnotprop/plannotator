import { describe, expect, test } from "bun:test";
import { buildAgentReviewUserMessage, buildAgentReviewUserMessageForTarget, buildWorkspacePromptContextLines, getLocalDiffInstruction } from "./agent-review-message";
import { buildClaudeCommand } from "./claude-review";

const patch = "diff --git a/src/large.ts b/src/large.ts\n+const value = 1;\n";

describe("buildAgentReviewUserMessage", () => {
  test("builds Git local review instructions without inlining the patch", () => {
    const cases = [
      ["uncommitted", "current code changes"],
      ["staged", "git diff --staged"],
      ["unstaged", "unstaged code changes"],
      ["last-commit", "git diff HEAD~1..HEAD"],
      // First-parent diff, never `git show` — a merge commit's `git show`
      // combined-diff presentation differs from the on-screen patch.
      ["commit:abc1234def5678", "git diff abc1234def5678^ abc1234def5678"],
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

describe("buildAgentReviewUserMessage — contextOnly (custom review skill)", () => {
  test("keeps the git context but drops the review framing prose", () => {
    const message = buildAgentReviewUserMessage(
      patch,
      "last-commit",
      { defaultBranch: "origin/main" },
      undefined,
      true,
    );

    expect(message).toContain("the code changes introduced in the last commit");
    expect(message).toContain("git diff HEAD~1..HEAD");
    expect(message).not.toContain("Review the");
    expect(message).not.toContain("Provide prioritized, actionable findings.");
    expect(message).not.toContain(patch);
  });

  test("falls back to the inline patch without the review framing line", () => {
    const message = buildAgentReviewUserMessage(patch, "p4-default", undefined, undefined, true);

    expect(message).toContain(patch);
    expect(message).not.toContain("Review the following code changes");
    expect(message).not.toContain("provide prioritized findings");
  });

  test("PR full-stack drops the review line but keeps the URL and stack context", () => {
    const prMetadata = {
      url: "https://github.com/o/r/pull/7",
      baseBranch: "main",
    } as Parameters<typeof buildAgentReviewUserMessage>[3];
    const message = buildAgentReviewUserMessage(
      patch,
      "branch",
      { prDiffScope: "full-stack" },
      prMetadata,
      true,
    );

    expect(message).toContain("https://github.com/o/r/pull/7");
    expect(message).toContain("This is a stacked PR.");
    expect(message).toContain(patch);
    expect(message).not.toContain("Full-stack review of");
    expect(message).not.toContain("Review the complete diff");
  });

  test("PR local-access is pure context — identical for default and custom", () => {
    const prMetadata = {
      url: "https://github.com/o/r/pull/9",
      baseBranch: "main",
    } as Parameters<typeof buildAgentReviewUserMessage>[3];
    const opts = { hasLocalAccess: true };

    const dflt = buildAgentReviewUserMessage(patch, "branch", opts, prMetadata, false);
    const custom = buildAgentReviewUserMessage(patch, "branch", opts, prMetadata, true);

    // This branch carries no framing prose, only context, so stripping does
    // nothing — the two must be byte-identical, and the diff instruction stays.
    expect(custom).toBe(dflt);
    expect(custom).toContain("git diff origin/main...HEAD");
    expect(custom).not.toContain("Provide prioritized");
  });

  test("workspace drops the opening review line but keeps the path-reporting rules", () => {
    const message = buildAgentReviewUserMessageForTarget(
      {
        kind: "workspace",
        patch,
        workspace: {
          root: "/tmp/workspace",
          repos: [
            { label: "api", cwd: "/tmp/workspace/api", changed: true, vcsType: "git", gitRef: "Uncommitted changes" },
          ],
        },
      },
      true,
    );

    expect(message).not.toContain("Review the local workspace changes");
    expect(message).toContain("must exactly match the path shown in the diff");
    expect(message).toContain("Do not use bare repo-relative paths like `src/file.ts`");
    expect(message).toContain("workspace root: /tmp/workspace");
    expect(message).toContain(patch);
  });
});

// Coverage for the scenarios Ask AI relies on (it reuses this exact machine via
// the review server's buildCurrentAiReviewContext). These fill the gaps the
// existing suite didn't cover: plain PR, PR full-stack default framing, the PR
// local-access "don't use stale local main" warning, untracked-file mention,
// jj-evolog, and the workspace prompt-context lines in isolation.
describe("buildAgentReviewUserMessage — Ask AI scenario coverage", () => {
  const prMetadata = {
    url: "https://github.com/o/r/pull/3",
    baseBranch: "main",
  } as Parameters<typeof buildAgentReviewUserMessage>[3];

  test("PR without confirmed checkout → worktree-aware instruction (verify files), URL + diff command, no paste", () => {
    const message = buildAgentReviewUserMessage(patch, "branch", {}, prMetadata, true);
    expect(message).toContain("https://github.com/o/r/pull/3");
    expect(message).toContain("git diff origin/main...HEAD");
    expect(message.toLowerCase()).toContain("verify the pr files exist");
    expect(message.toLowerCase()).toContain("warming up");
    // Still no pasted diff — the agent fetches it from the worktree itself.
    expect(message).not.toContain(patch);
    expect(message).not.toContain("```diff");
  });

  test("PR full-stack (default framing) → review line, stacked explanation, inline patch", () => {
    const message = buildAgentReviewUserMessage(patch, "branch", { prDiffScope: "full-stack" }, prMetadata, false);
    expect(message).toContain("Full-stack review of https://github.com/o/r/pull/3");
    expect(message).toContain("This is a stacked PR.");
    expect(message).toContain("Review the complete diff");
    expect(message).toContain(patch);
  });

  test("PR local-access → origin/<base>...HEAD and a warning against stale local main", () => {
    const message = buildAgentReviewUserMessage(patch, "branch", { hasLocalAccess: true }, prMetadata, true);
    expect(message).toContain("git diff origin/main...HEAD");
    expect(message).toContain("Do NOT diff against the local `main`");
    expect(message).toContain("Always use origin/");
    expect(message).not.toContain(patch);
  });

  test("uncommitted/unstaged contextOnly mention untracked files", () => {
    for (const diffType of ["uncommitted", "unstaged"] as const) {
      const message = buildAgentReviewUserMessage(patch, diffType, undefined, undefined, true);
      expect(message.toLowerCase()).toContain("untracked");
    }
  });

  test("buildWorkspacePromptContextLines lists repos and the git -C guidance", () => {
    const lines = buildWorkspacePromptContextLines({
      root: "/tmp/ws",
      repos: [
        { label: "api", cwd: "/tmp/ws/api", changed: true, vcsType: "git", gitRef: "Uncommitted changes" },
      ],
    }).join("\n");
    expect(lines).toContain("workspace root: /tmp/ws");
    expect(lines).toContain("git -C <child-repo-folder>");
    expect(lines).toContain("- api/ [git, changed] -> /tmp/ws/api");
  });
});

describe("getLocalDiffInstruction", () => {
  test("returns null for non-local diff types", () => {
    expect(getLocalDiffInstruction("p4-default")).toBeNull();
  });

  test("jj-evolog produces a from/to jj diff command", () => {
    const instruction = getLocalDiffInstruction("jj-evolog", "abc123");
    expect(instruction?.inspect).toContain("jj diff --git --from 'abc123' --to @");
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
