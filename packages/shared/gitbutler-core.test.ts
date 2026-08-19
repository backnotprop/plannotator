import { describe, expect, test } from "bun:test";

import type { GitCommandOptions, GitCommandResult } from "./review-core";
import { MAX_REVIEW_FILE_CONTENT_BYTES } from "./review-core";
import {
  GITBUTLER_WORKSPACE_DIFF,
  GitButlerContractError,
  type ReviewGitButlerRuntime,
  detectGitButlerWorkspace,
  getGitButlerContext,
  getGitButlerContextRevision,
  getGitButlerDiffFingerprint,
  getGitButlerFileContentsForDiff,
  getGitButlerPatchFingerprint,
  parseGitButlerDiffType,
  parseGitButlerStatus,
  runGitButlerDiff,
} from "./gitbutler-core";
import {
  createGitButlerProvider,
  createGitProvider,
  createVcsApi,
} from "./vcs-core";

const ROOT = "/repo";
const MERGE_BASE = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const LOWER_TIP = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TOP_TIP = "cccccccccccccccccccccccccccccccccccccccc";
const PATCH_OLD_OBJECT = "d".repeat(40);
const PATCH_NEW_OBJECT = "e".repeat(40);

function commandResult(
  stdout = "",
  stderr = "",
  exitCode = 0,
): GitCommandResult {
  return { stdout, stderr, exitCode };
}

function statusJson(extraTopBranch = false): string {
  return JSON.stringify({
    uncommittedChanges: [],
    stacks: [{
      cliId: "i0",
      assignedChanges: [],
      branches: [
        ...(extraTopBranch ? [{
          cliId: "f0",
          name: "feature-new-top",
          commits: [],
          upstreamCommits: [],
        }] : []),
        {
          cliId: "g0",
          name: "feature/top lane",
          commits: [{ commitId: TOP_TIP }],
          upstreamCommits: [],
        },
        {
          cliId: "h0",
          name: "feature-lower",
          commits: [{ commitId: LOWER_TIP }],
          upstreamCommits: [],
        },
      ],
    }],
    mergeBase: { commitId: MERGE_BASE },
    // Additive current/nightly fields must not break the parser.
    conflictedFiles: [],
  });
}

interface RuntimeFixture {
  runtime: ReviewGitButlerRuntime;
  gitCalls: string[][];
  butCalls: string[][];
  setPatch(value: string): void;
}

function createRuntime(options: {
  activeRef?: string;
  version?: GitCommandResult;
  status?: GitCommandResult;
  topParents?: GitCommandResult;
  ancestor?: GitCommandResult;
  configured?: boolean;
} = {}): RuntimeFixture {
  const gitCalls: string[][] = [];
  const butCalls: string[][] = [];
  let patch = "diff --git a/file.txt b/file.txt\n-old\n+new\n";

  const runtime: ReviewGitButlerRuntime = {
    async getFileInfo() {
      return null;
    },
    async readLink() {
      return null;
    },
    async runGit(args: string[], commandOptions?: GitCommandOptions): Promise<GitCommandResult> {
      gitCalls.push(args);
      const commandArgs = args[0] === "--no-optional-locks" ? args.slice(1) : args;
      if (commandArgs[0] === "symbolic-ref") {
        return commandResult(`${options.activeRef ?? "refs/heads/gitbutler/workspace"}\n`);
      }
      if (commandArgs[0] === "config") {
        return options.configured === false
          ? commandResult("", "", 1)
          : commandResult("refs/remotes/origin/main\n");
      }
      if (commandArgs[0] === "rev-parse" && commandArgs[1] === "--show-toplevel") {
        return commandResult(`${ROOT}\n`);
      }
      if (commandArgs[0] === "rev-parse" && commandArgs.includes("HEAD")) {
        return commandResult(`${TOP_TIP}\n`);
      }
      if (commandArgs[0] === "rev-list" && commandArgs.at(-1) === TOP_TIP) {
        return options.topParents ?? commandResult(`${TOP_TIP} ${LOWER_TIP}\n`);
      }
      if (commandArgs[0] === "rev-list" && commandArgs.at(-1) === LOWER_TIP) {
        return commandResult(`${LOWER_TIP} ${MERGE_BASE}\n`);
      }
      if (commandArgs[0] === "merge-base" && commandArgs[1] === "--is-ancestor") {
        return options.ancestor ?? commandResult();
      }
      if (commandArgs[0] === "merge-base") {
        return commandResult(`${MERGE_BASE}\n`);
      }
      if (commandArgs[0] === "cat-file" && commandArgs[1] === "-s") {
        return commandResult("10\n");
      }
      if (commandArgs[0] === "cat-file" && commandArgs.some((arg) => arg.startsWith("--batch-check"))) {
        return commandResult(
          (commandOptions?.stdin ?? "").trim().split("\n").filter(Boolean).map((objectId) =>
            `${objectId} blob 10`,
          ).join("\n"),
        );
      }
      if (commandArgs[0] === "diff" && commandArgs.includes("--raw")) {
        return commandResult(
          `:100644 100644 ${PATCH_OLD_OBJECT} ${PATCH_NEW_OBJECT} M\0file.txt\0`,
        );
      }
      if (commandArgs[0] === "diff") return commandResult(patch);
      if (commandArgs[0] === "status") return commandResult();
      if (commandArgs[0] === "ls-files") return commandResult();
      if (commandArgs[0] === "show") {
        const refPath = commandArgs.at(-1) ?? "";
        return commandResult(`content:${refPath}`);
      }
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    },
    async runBut(args: string[], _options?: GitCommandOptions): Promise<GitCommandResult> {
      butCalls.push(args);
      if (args[0] === "--version") {
        return options.version ?? commandResult("but 0.21.0\n");
      }
      if (args.join(" ") === "--format json status") {
        return options.status ?? commandResult(statusJson());
      }
      throw new Error(`Unexpected but command: ${args.join(" ")}`);
    },
    async readTextFile(path: string): Promise<string | null> {
      return `working:${path}`;
    },
  };

  return {
    runtime,
    gitCalls,
    butCalls,
    setPatch(value: string) {
      patch = value;
    },
  };
}

describe("GitButler status contract", () => {
  test("accepts the supported schema and ignores additive fields", () => {
    expect(parseGitButlerStatus(statusJson())).toEqual({
      mergeBase: { commitId: MERGE_BASE },
      stacks: [{
        branches: [
          { name: "feature/top lane", commits: [{ commitId: TOP_TIP }] },
          { name: "feature-lower", commits: [{ commitId: LOWER_TIP }] },
        ],
      }],
    });
  });

  test("rejects old or malformed status output instead of returning an empty review", () => {
    expect(() => parseGitButlerStatus("not json")).toThrow(GitButlerContractError);
    expect(() => parseGitButlerStatus(JSON.stringify({
      unassignedChanges: [],
      stacks: [],
      mergeBase: { commitId: MERGE_BASE },
    }))).toThrow("uncommittedChanges");
    expect(() => parseGitButlerStatus(JSON.stringify({
      uncommittedChanges: [],
      stacks: [],
      mergeBase: { commitId: "abc1" },
    }))).toThrow("not a Git object id");
  });

  test("accepts anonymous current-schema segments but omits unstable selectors", async () => {
    const anonymous = JSON.parse(statusJson()) as {
      stacks: Array<{ branches: Array<{ name: string }> }>;
    };
    anonymous.stacks[0]!.branches[0]!.name = "";
    expect(parseGitButlerStatus(JSON.stringify(anonymous)).stacks[0]?.branches[0]?.name).toBe("");

    const fixture = createRuntime({ status: commandResult(JSON.stringify(anonymous)) });
    const context = await getGitButlerContext(fixture.runtime, ROOT);
    expect(context.diffOptions).toEqual([
      { id: GITBUTLER_WORKSPACE_DIFF, label: "Workspace (all applied changes)" },
      { id: "gitbutler:branch:feature-lower", label: "Branch: feature-lower (committed)" },
    ]);
  });
});

describe("GitButler status JSON flag fallback", () => {
  // 0.21.x accepts only `--format json` (gitbutlerapp/gitbutler#14061);
  // 0.22.0+ accepts only `--json` (gitbutlerapp/gitbutler#15026). Each
  // rejects the other spelling with clap's unexpected-argument error.
  const formatRejected = commandResult(
    "",
    "error: unexpected argument '--format' found\n\nUsage: but [OPTIONS] [COMMAND]\n\nFor more information, try '--help'.\n",
    2,
  );
  const jsonRejected = commandResult(
    "",
    "error: unexpected argument '--json' found\n\nUsage: but [OPTIONS] [COMMAND]\n\nFor more information, try '--help'.\n",
    2,
  );

  test("falls back to `but --json status` once when the CLI rejects `--format`, then remembers it", async () => {
    const fixture = createRuntime({ version: commandResult("but 0.22.0\n") });
    const originalRunBut = fixture.runtime.runBut.bind(fixture.runtime);
    fixture.runtime.runBut = async (args, options) => {
      if (args.join(" ") === "--format json status") {
        fixture.butCalls.push(args);
        return formatRejected;
      }
      if (args.join(" ") === "--json status") {
        fixture.butCalls.push(args);
        return commandResult(statusJson());
      }
      return originalRunBut(args, options);
    };

    const context = await getGitButlerContext(fixture.runtime, ROOT);
    expect(context).toMatchObject({ vcsType: "gitbutler", defaultBranch: MERGE_BASE });
    const result = await runGitButlerDiff(fixture.runtime, GITBUTLER_WORKSPACE_DIFF, ROOT);
    expect(result).toMatchObject({
      patch: "diff --git a/file.txt b/file.txt\n-old\n+new\n",
      label: "GitButler workspace (all applied changes)",
    });
    expect(fixture.butCalls.filter((args) => args.includes("status"))).toEqual([
      ["--format", "json", "status"],
      ["--json", "status"],
    ]);

    // The accepted spelling is remembered, so the next status call after the
    // cache TTL does not pay the failed `--format` probe again.
    await Bun.sleep(1_050);
    await getGitButlerContext(fixture.runtime, ROOT);
    expect(fixture.butCalls.filter((args) => args.includes("status"))).toEqual([
      ["--format", "json", "status"],
      ["--json", "status"],
      ["--json", "status"],
    ]);
  });

  test("a real status failure is never retried with the other syntax", async () => {
    const fixture = createRuntime({ status: commandResult("", "database locked", 1) });
    await expect(getGitButlerContext(fixture.runtime, ROOT)).rejects.toThrow(GitButlerContractError);
    const failed = createRuntime({ status: commandResult("", "database locked", 1) });
    await expect(getGitButlerContext(failed.runtime, ROOT)).rejects.toThrow(
      "GitButler status (`but --format json status`) failed: database locked",
    );
    // The fixture's runBut throws for any unexpected invocation, so reaching
    // this assertion also proves `--json status` was never attempted.
    expect(failed.butCalls.filter((args) => args.includes("status"))).toEqual([
      ["--format", "json", "status"],
    ]);
  });

  test("rejecting both spellings yields a clear version-requirement contract error", async () => {
    const fixture = createRuntime();
    const originalRunBut = fixture.runtime.runBut.bind(fixture.runtime);
    fixture.runtime.runBut = async (args, options) => {
      if (args.join(" ") === "--format json status") {
        fixture.butCalls.push(args);
        return formatRejected;
      }
      if (args.join(" ") === "--json status") {
        fixture.butCalls.push(args);
        return jsonRejected;
      }
      return originalRunBut(args, options);
    };

    const pending = getGitButlerContext(fixture.runtime, ROOT);
    await expect(pending).rejects.toThrow(GitButlerContractError);
    await expect(pending).rejects.toThrow(
      "GitButler rejected both `but --format json status` and `but --json status`; " +
      "Plannotator requires GitButler 0.21.0 or newer.",
    );
    expect(fixture.butCalls.filter((args) => args.includes("status"))).toEqual([
      ["--format", "json", "status"],
      ["--json", "status"],
    ]);
  });
});

describe("GitButler detection and context", () => {
  test("detects only an active GitButler workspace ref, including from a subdirectory", async () => {
    const fixture = createRuntime();
    await expect(detectGitButlerWorkspace(fixture.runtime, "/repo/packages/ui")).resolves.toBe(ROOT);

    const ordinary = createRuntime({ activeRef: "refs/heads/main" });
    await expect(detectGitButlerWorkspace(ordinary.runtime, ROOT)).resolves.toBeNull();
    expect(ordinary.butCalls).toEqual([]);

    const legacy = createRuntime({ activeRef: "refs/heads/gitbutler/integration" });
    await expect(detectGitButlerWorkspace(legacy.runtime, ROOT)).resolves.toBe(ROOT);

    const reservedOrdinaryBranch = createRuntime({ configured: false });
    await expect(detectGitButlerWorkspace(reservedOrdinaryBranch.runtime, ROOT)).resolves.toBeNull();
  });

  test("ordinary Git selection never invokes the GitButler CLI", async () => {
    const fixture = createRuntime({ activeRef: "refs/heads/main" });
    const api = createVcsApi([
      createGitButlerProvider(fixture.runtime),
      createGitProvider(fixture.runtime),
    ]);

    await expect(api.detectManagedVcs(ROOT)).resolves.toMatchObject({ id: "git" });
    expect(fixture.butCalls).toEqual([]);
  });

  test("an ordinary Git branch named gitbutler/workspace stays on the Git provider", async () => {
    const fixture = createRuntime({ configured: false });
    const api = createVcsApi([
      createGitButlerProvider(fixture.runtime),
      createGitProvider(fixture.runtime),
    ]);

    await expect(api.detectManagedVcs(ROOT)).resolves.toMatchObject({ id: "git" });
    expect(fixture.butCalls).toEqual([]);
  });

  test("uses stable encoded branch names instead of transient CLI ids", async () => {
    const fixture = createRuntime();
    const context = await getGitButlerContext(fixture.runtime, ROOT);

    expect(context).toMatchObject({
      vcsType: "gitbutler",
      cwd: ROOT,
      defaultBranch: MERGE_BASE,
    });
    expect(context.diffOptions).toEqual([
      { id: GITBUTLER_WORKSPACE_DIFF, label: "Workspace (all applied changes)" },
      {
        id: "gitbutler:stack:feature-lower",
        label: "Stack: feature-lower → feature/top lane (committed)",
      },
      {
        id: "gitbutler:branch:feature%2Ftop%20lane",
        label: "Branch: feature/top lane (committed)",
      },
      {
        id: "gitbutler:branch:feature-lower",
        label: "Branch: feature-lower (committed)",
      },
    ]);
    expect(fixture.butCalls).toEqual([
      ["--version"],
      ["--format", "json", "status"],
    ]);
    expect(parseGitButlerDiffType("gitbutler:branch:feature%2Ftop%20lane")).toEqual({
      kind: "branch",
      branchName: "feature/top lane",
    });
    expect(getGitButlerContextRevision(context)).not.toBeNull();
    expect(getGitButlerContextRevision({ ...context, vcsType: "git" })).toBeNull();
    expect(getGitButlerContextRevision({
      ...context,
      diffOptions: [...context.diffOptions, { id: "gitbutler:branch:new", label: "Branch: new" }],
    })).not.toBe(getGitButlerContextRevision(context));
    const rewritten = createRuntime({
      status: commandResult(statusJson().replaceAll(TOP_TIP, "dddddddddddddddddddddddddddddddddddddddd")),
    });
    expect(getGitButlerContextRevision(await getGitButlerContext(rewritten.runtime, ROOT)))
      .not.toBe(getGitButlerContextRevision(context));
    await runGitButlerDiff(fixture.runtime, GITBUTLER_WORKSPACE_DIFF, ROOT);
    // Context, initial patch, immediate fingerprint/file requests share one
    // validated status snapshot instead of spawning `but status` per request.
    expect(fixture.butCalls.filter((args) => args.includes("status"))).toHaveLength(1);
  });

  test("shares a slow in-flight status call and starts its TTL after success", async () => {
    const fixture = createRuntime();
    const runBut = fixture.runtime.runBut.bind(fixture.runtime);
    let releaseStatus: (() => void) | undefined;
    const statusGate = new Promise<void>((resolve) => {
      releaseStatus = resolve;
    });
    fixture.runtime.runBut = async (args, options) => {
      if (args.join(" ") !== "--format json status") return runBut(args, options);
      fixture.butCalls.push(args);
      await statusGate;
      return commandResult(statusJson());
    };

    const first = getGitButlerContext(fixture.runtime, ROOT);
    await Bun.sleep(1_050);
    const second = getGitButlerContext(fixture.runtime, ROOT);
    expect(fixture.butCalls.filter((args) => args.includes("status"))).toHaveLength(1);
    releaseStatus?.();
    await Promise.all([first, second]);
    await getGitButlerContext(fixture.runtime, ROOT);
    expect(fixture.butCalls.filter((args) => args.includes("status"))).toHaveLength(1);
  });

  test("reports a missing or stale CLI explicitly", async () => {
    const missing = createRuntime({
      version: commandResult("", "but not found", 1),
    });
    await expect(getGitButlerContext(missing.runtime, ROOT)).rejects.toThrow("not on PATH");

    const old = createRuntime({ version: commandResult("but 0.19.7\n") });
    await expect(getGitButlerContext(old.runtime, ROOT)).rejects.toThrow("requires 0.21.0 or newer");

    const minimumPrerelease = createRuntime({ version: commandResult("but 0.21.0-beta.1\n") });
    await expect(getGitButlerContext(minimumPrerelease.runtime, ROOT)).rejects.toThrow(
      "requires 0.21.0 or newer",
    );

    const newerPrerelease = createRuntime({ version: commandResult("but 0.22.0-beta.1\n") });
    await expect(getGitButlerContext(newerPrerelease.runtime, ROOT)).resolves.toMatchObject({
      vcsType: "gitbutler",
    });
  });

  test("an active workspace with a missing CLI does not silently fall back to Git", async () => {
    const fixture = createRuntime({ version: commandResult("", "but not found", 1) });
    const api = createVcsApi([
      createGitButlerProvider(fixture.runtime),
      createGitProvider(fixture.runtime),
    ]);

    await expect(api.prepareLocalReviewDiff({
      cwd: ROOT,
      configuredDiffType: "since-base",
    })).rejects.toThrow("not on PATH");
  });
});

describe("GitButler diffs and expansion", () => {
  test("builds the workspace view directly from the reported base", async () => {
    const fixture = createRuntime();
    const result = await runGitButlerDiff(fixture.runtime, GITBUTLER_WORKSPACE_DIFF, ROOT, {
      hideWhitespace: true,
    });

    expect(result).toMatchObject({
      patch: "diff --git a/file.txt b/file.txt\n-old\n+new\n",
      label: "GitButler workspace (all applied changes)",
      gitContext: {
        defaultBranch: MERGE_BASE,
        vcsType: "gitbutler",
      },
    });
    expect(result.fingerprint).toBe(getGitButlerPatchFingerprint(
      GITBUTLER_WORKSPACE_DIFF,
      result.patch,
      result.gitContext,
    ));
    expect(fixture.gitCalls).toContainEqual([
      "diff",
      "--no-ext-diff",
      "-w",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "--end-of-options",
      MERGE_BASE,
    ]);
  });

  test("fails explicitly instead of hiding committed changes when the workspace merge base is invalid", async () => {
    const fixture = createRuntime({ ancestor: commandResult("", "not an ancestor", 1) });
    await expect(runGitButlerDiff(
      fixture.runtime,
      GITBUTLER_WORKSPACE_DIFF,
      ROOT,
    )).resolves.toMatchObject({
      patch: "",
      error: "GitButler's reported merge base is missing or is not an ancestor of the workspace HEAD.",
    });
    expect(fixture.gitCalls.some((args) => args[0] === "diff")).toBe(false);
  });

  test("uses one native merge-base-to-tip range for a committed stack", async () => {
    const fixture = createRuntime();
    const result = await runGitButlerDiff(
      fixture.runtime,
      "gitbutler:stack:feature-lower",
      ROOT,
    );

    expect(result.label).toBe("Stack: feature-lower → feature/top lane (committed changes)");
    expect(fixture.gitCalls).toContainEqual([
      "merge-base",
      "--is-ancestor",
      MERGE_BASE,
      TOP_TIP,
    ]);
    expect(fixture.gitCalls).toContainEqual([
      "diff",
      "--no-ext-diff",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "--end-of-options",
      `${MERGE_BASE}..${TOP_TIP}`,
    ]);
  });

  test("keeps a selected stack stable when a new branch is added on top", async () => {
    const fixture = createRuntime({ status: commandResult(statusJson(true)) });
    const result = await runGitButlerDiff(
      fixture.runtime,
      "gitbutler:stack:feature-lower",
      ROOT,
    );

    expect(result).toMatchObject({
      patch: "diff --git a/file.txt b/file.txt\n-old\n+new\n",
      label: "Stack: feature-lower → feature/top lane → feature-new-top (committed changes)",
    });
  });

  test("hides conflicted committed selectors and fails old tabs closed", async () => {
    const conflictedStatus = JSON.parse(statusJson()) as {
      stacks: Array<{ branches: Array<{ commits: Array<Record<string, unknown>> }> }>;
    };
    conflictedStatus.stacks[0]!.branches[1]!.commits[0]!.conflicted = true;
    const fixture = createRuntime({
      status: commandResult(JSON.stringify(conflictedStatus)),
    });

    const context = await getGitButlerContext(fixture.runtime, ROOT);
    expect(context.diffOptions).toEqual([
      { id: GITBUTLER_WORKSPACE_DIFF, label: "Workspace (all applied changes)" },
    ]);
    await expect(runGitButlerDiff(
      fixture.runtime,
      "gitbutler:stack:feature-lower",
      ROOT,
    )).resolves.toMatchObject({
      patch: "",
      error: 'GitButler stack "feature-lower → feature/top lane" is conflicted; use the Workspace view until it is resolved.',
    });
    await expect(runGitButlerDiff(
      fixture.runtime,
      "gitbutler:branch:feature%2Ftop%20lane",
      ROOT,
    )).resolves.toMatchObject({
      patch: "",
      error: 'GitButler branch "feature/top lane" is conflicted; use the Workspace view until its stack is resolved.',
    });
    expect(fixture.gitCalls.some((args) => args[0] === "diff")).toBe(false);
  });

  test("fails closed when a stack's bottom-branch anchor moves", async () => {
    const movedStatus = JSON.parse(statusJson()) as {
      stacks: Array<{ branches: Array<Record<string, unknown>> }>;
    };
    movedStatus.stacks[0]?.branches.push({
      cliId: "j0",
      name: "new-lower-branch",
      commits: [],
      upstreamCommits: [],
    });
    const fixture = createRuntime({
      status: commandResult(JSON.stringify(movedStatus)),
    });

    await expect(runGitButlerDiff(
      fixture.runtime,
      "gitbutler:stack:feature-lower",
      ROOT,
    )).resolves.toMatchObject({
      patch: "",
      error: "GitButler stack \"feature-lower\" no longer exists.",
    });
  });

  test("uses a branch segment's first parent and tip without merging hunks", async () => {
    const fixture = createRuntime();
    const result = await runGitButlerDiff(
      fixture.runtime,
      "gitbutler:branch:feature%2Ftop%20lane",
      ROOT,
    );

    expect(result.label).toBe("Branch: feature/top lane (committed changes)");
    expect(fixture.gitCalls).toContainEqual([
      "diff",
      "--no-ext-diff",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "--end-of-options",
      `${LOWER_TIP}..${TOP_TIP}`,
    ]);
  });

  test("does not mistake a missing branch commit for a root commit", async () => {
    const fixture = createRuntime({ topParents: commandResult("", "bad object", 128) });
    await expect(runGitButlerDiff(
      fixture.runtime,
      "gitbutler:branch:feature%2Ftop%20lane",
      ROOT,
    )).resolves.toMatchObject({
      patch: "",
      error: `Could not resolve GitButler branch commit ${TOP_TIP}: bad object`,
    });
    expect(fixture.gitCalls.some((args) => args[0] === "hash-object")).toBe(false);
  });

  test("rejects a status branch whose reported commits no longer match first-parent history", async () => {
    const fixture = createRuntime({
      topParents: commandResult(`${TOP_TIP} ${MERGE_BASE}\n`),
    });
    await expect(runGitButlerDiff(
      fixture.runtime,
      "gitbutler:branch:feature%2Ftop%20lane",
      ROOT,
    )).resolves.toMatchObject({
      patch: "",
      error: "GitButler branch \"feature/top lane\" no longer matches its reported stack base.",
    });
  });

  test("passes rename and binary metadata through from the authoritative Git diff", async () => {
    const fixture = createRuntime();
    const patch = [
      "diff --git a/old name.bin b/new name.bin",
      "similarity index 100%",
      "rename from old name.bin",
      "rename to new name.bin",
      "GIT binary patch",
      "",
    ].join("\n");
    fixture.setPatch(patch);

    await expect(runGitButlerDiff(
      fixture.runtime,
      "gitbutler:stack:feature-lower",
      ROOT,
    )).resolves.toMatchObject({ patch });
  });

  test("omits oversized committed object diffs with a content-sensitive binary stub", async () => {
    const fixture = createRuntime();
    const originalRunGit = fixture.runtime.runGit.bind(fixture.runtime);
    const oldObjectId = "d".repeat(40);
    let newObjectId = "e".repeat(40);
    let sawRawDiff = false;
    fixture.setPatch("x".repeat(MAX_REVIEW_FILE_CONTENT_BYTES + 1));
    fixture.runtime.runGit = async (args, options) => {
      const commandArgs = args[0] === "-c" ? args.slice(2) : args;
      if (commandArgs[0] === "diff" && commandArgs.includes("--raw")) {
        sawRawDiff = true;
        return commandResult(
          `:100644 100644 ${oldObjectId} ${newObjectId} M\0large [*]?.txt\0`,
        );
      }
      if (commandArgs[0] === "cat-file" && commandArgs.some((arg) => arg.startsWith("--batch-check"))) {
        return commandResult(
          (options?.stdin ?? "").trim().split("\n").filter(Boolean).map((objectId) =>
            `${objectId} blob ${MAX_REVIEW_FILE_CONTENT_BYTES + 1}`,
          ).join("\n"),
        );
      }
      if (commandArgs[0] === "diff" && commandArgs.some((arg) => arg.startsWith(":(top,exclude,literal)"))) {
        return commandResult();
      }
      return originalRunGit(args, options);
    };

    const result = await runGitButlerDiff(
      fixture.runtime,
      "gitbutler:branch:feature%2Ftop%20lane",
      ROOT,
    );
    expect(result.patch.length).toBeLessThan(2_000);
    expect(result.patch).toContain("Binary files");
    expect(result.patch).not.toContain("xxxxxxxxxx");
    expect(sawRawDiff).toBe(true);

    const first = await getGitButlerDiffFingerprint(
      fixture.runtime,
      "gitbutler:branch:feature%2Ftop%20lane",
      ROOT,
    );
    newObjectId = "f".repeat(40);
    const second = await getGitButlerDiffFingerprint(
      fixture.runtime,
      "gitbutler:branch:feature%2Ftop%20lane",
      ROOT,
    );
    expect(second).not.toBe(first);
  });

  test("returns explicit errors when status or a selected target disappears", async () => {
    const failedStatus = createRuntime({ status: commandResult("", "database locked", 1) });
    await expect(runGitButlerDiff(failedStatus.runtime, GITBUTLER_WORKSPACE_DIFF, ROOT)).resolves.toMatchObject({
      patch: "",
      error: "GitButler status (`but --format json status`) failed: database locked",
    });

    const fixture = createRuntime();
    await expect(runGitButlerDiff(
      fixture.runtime,
      "gitbutler:branch:deleted",
      ROOT,
    )).resolves.toMatchObject({
      patch: "",
      error: "GitButler branch \"deleted\" no longer exists.",
    });
  });

  test("expands committed branch files from the exact old and new objects", async () => {
    const fixture = createRuntime();
    await expect(getGitButlerFileContentsForDiff(
      fixture.runtime,
      "gitbutler:branch:feature%2Ftop%20lane",
      "src/new.ts",
      "src/old.ts",
      ROOT,
    )).resolves.toEqual({
      oldContent: `content:${LOWER_TIP}:src/old.ts`,
      newContent: `content:${TOP_TIP}:src/new.ts`,
    });
  });

  test("does not expand oversized committed GitButler blobs", async () => {
    const fixture = createRuntime();
    const originalRunGit = fixture.runtime.runGit.bind(fixture.runtime);
    let showCalls = 0;
    fixture.runtime.runGit = async (args, options) => {
      if (args[0] === "cat-file" && args[1] === "-s") {
        return commandResult(`${MAX_REVIEW_FILE_CONTENT_BYTES + 1}\n`);
      }
      if (args[0] === "show") showCalls++;
      return originalRunGit(args, options);
    };

    await expect(getGitButlerFileContentsForDiff(
      fixture.runtime,
      "gitbutler:branch:feature%2Ftop%20lane",
      "src/new.ts",
      "src/old.ts",
      ROOT,
    )).resolves.toEqual({ oldContent: null, newContent: null });
    expect(showCalls).toBe(0);
  });

  test("fingerprints the exact visible patch content", async () => {
    const fixture = createRuntime();
    const first = await getGitButlerDiffFingerprint(
      fixture.runtime,
      GITBUTLER_WORKSPACE_DIFF,
      ROOT,
    );
    fixture.setPatch("diff --git a/file.txt b/file.txt\n-old\n+newer\n");
    const second = await getGitButlerDiffFingerprint(
      fixture.runtime,
      GITBUTLER_WORKSPACE_DIFF,
      ROOT,
    );
    expect(second).not.toBe(first);
    expect(fixture.gitCalls.some((args) => args[0] === "diff")).toBe(true);
  });

  test("fingerprints committed selectors from their exact authoritative patch", async () => {
    const fixture = createRuntime();
    await getGitButlerDiffFingerprint(
      fixture.runtime,
      "gitbutler:branch:feature%2Ftop%20lane",
      ROOT,
    );
    expect(fixture.gitCalls.some((args) => args[0] === "diff")).toBe(true);
  });

  test("pins a committed patch, context, and fingerprint to one status revision across the cache TTL", async () => {
    const fixture = createRuntime();
    const committedDiffType = "gitbutler:branch:feature%2Ftop%20lane" as const;
    const originalRunBut = fixture.runtime.runBut.bind(fixture.runtime);
    const originalRunGit = fixture.runtime.runGit.bind(fixture.runtime);
    const newerMergeBase = "dddddddddddddddddddddddddddddddddddddddd";
    const newerStatus = JSON.parse(statusJson()) as {
      mergeBase: { commitId: string };
    };
    newerStatus.mergeBase.commitId = newerMergeBase;
    let currentStatus = statusJson();
    let releaseDiff: (() => void) | undefined;
    let markDiffStarted: (() => void) | undefined;
    const diffStarted = new Promise<void>((resolve) => {
      markDiffStarted = resolve;
    });
    const diffGate = new Promise<void>((resolve) => {
      releaseDiff = resolve;
    });
    let blockNextDiff = true;

    fixture.runtime.runBut = async (args, options) => {
      if (args.join(" ") !== "--format json status") return originalRunBut(args, options);
      fixture.butCalls.push(args);
      return commandResult(currentStatus);
    };
    fixture.runtime.runGit = async (args, options) => {
      if (args[0] === "diff" && blockNextDiff) {
        blockNextDiff = false;
        markDiffStarted?.();
        await diffGate;
      }
      return originalRunGit(args, options);
    };

    const oldSnapshotPromise = runGitButlerDiff(
      fixture.runtime,
      committedDiffType,
      ROOT,
    );
    await diffStarted;
    await Bun.sleep(1_050);
    currentStatus = JSON.stringify(newerStatus);
    const newContext = await getGitButlerContext(fixture.runtime, ROOT);
    expect(newContext.defaultBranch).toBe(newerMergeBase);
    releaseDiff?.();

    const oldSnapshot = await oldSnapshotPromise;
    expect(oldSnapshot.gitContext?.defaultBranch).toBe(MERGE_BASE);
    expect(oldSnapshot.fingerprint).toBe(getGitButlerPatchFingerprint(
      committedDiffType,
      oldSnapshot.patch,
      oldSnapshot.gitContext,
    ));
    await expect(getGitButlerDiffFingerprint(
      fixture.runtime,
      committedDiffType,
      ROOT,
    )).resolves.not.toBe(oldSnapshot.fingerprint);
    expect(fixture.butCalls.filter((args) => args.includes("status"))).toHaveLength(2);
  });
});
