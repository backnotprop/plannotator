import { describe, expect, test } from "bun:test";
import {
  buildEslintCheckInput,
  extractChangedLines,
  getEslintCheckAvailability,
  isEslintCheckCompatibleReviewView,
  runEslintCheck,
  type EslintCheckRuntime,
} from "./eslint-check";

function makeRuntime(options: {
  files?: string[];
  contents?: Record<string, string>;
  result?: { stdout?: string; stderr?: string; exitCode?: number; timedOut?: boolean; outputLimitExceeded?: boolean };
  onRunCommand?: (callIndex: number) => void;
  now?: () => number;
} = {}): EslintCheckRuntime & {
  calls: Array<{ command: string; args: string[]; cwd: string; timeoutMs: number }>;
} {
  const files = new Set(options.files ?? []);
  const contents = options.contents ?? {};
  const calls: Array<{ command: string; args: string[]; cwd: string; timeoutMs: number }> = [];

  return {
    calls,
    nodePath: "/usr/bin/node",
    now: options.now ?? (() => 0),
    fileExists: (path) => files.has(path),
    readTextFile: (path) => contents[path] ?? "",
    async runCommand(command, args, runOptions) {
      calls.push({ command, args, cwd: runOptions.cwd, timeoutMs: runOptions.timeoutMs });
      options.onRunCommand?.(calls.length - 1);
      return {
        stdout: options.result?.stdout ?? "[]",
        stderr: options.result?.stderr ?? "",
        exitCode: options.result?.exitCode ?? 0,
        ...(options.result?.timedOut && { timedOut: true }),
        ...(options.result?.outputLimitExceeded && { outputLimitExceeded: true }),
      };
    },
  };
}

const patch = [
  "diff --git a/src/app.tsx b/src/app.tsx",
  "--- a/src/app.tsx",
  "+++ b/src/app.tsx",
  "@@ -8,2 +8,3 @@",
  " const count = 1;",
  "+useEffect(() => console.log(count), []);",
  "+const other = true;",
  " unchanged();",
  "",
].join("\n");

function configuredRuntime(result?: Parameters<typeof makeRuntime>[0]["result"]) {
  return makeRuntime({
    files: [
      "/repo/src/app.tsx",
      "/repo/eslint.config.js",
      "/repo/node_modules/eslint/package.json",
      "/repo/node_modules/eslint/bin/eslint.js",
    ],
    contents: {
      "/repo/node_modules/eslint/package.json": JSON.stringify({ version: "9.12.0", bin: { eslint: "bin/eslint.js" } }),
    },
    result,
  });
}

describe("ESLint review check", () => {
  test("limits ESLint checks to working-tree-backed local review views", () => {
    expect(isEslintCheckCompatibleReviewView({
      isPRMode: true,
      isWorkspaceMode: false,
      diffType: "uncommitted",
    })).toBe(false);
    expect(isEslintCheckCompatibleReviewView({
      isPRMode: false,
      isWorkspaceMode: false,
      diffType: "uncommitted",
    })).toBe(true);
    expect(isEslintCheckCompatibleReviewView({
      isPRMode: false,
      isWorkspaceMode: false,
      diffType: "last-commit",
    })).toBe(false);
    expect(isEslintCheckCompatibleReviewView({
      isPRMode: false,
      isWorkspaceMode: true,
      diffType: "workspace-current",
    })).toBe(true);
  });

  test("extracts added new-side line numbers per file", () => {
    expect([...extractChangedLines(patch).get("src/app.tsx") ?? []]).toEqual([9, 10]);
  });

  test("maps workspace-prefixed patch paths back to child repositories", () => {
    const workspacePatch = patch.replaceAll("src/app.tsx", "web/src/app.tsx");
    expect(buildEslintCheckInput(workspacePatch, "/workspace", [
      { label: "web", cwd: "/workspace/apps/web" },
      { label: "api", cwd: "/workspace/apps/api" },
    ])).toEqual({
      rawPatch: workspacePatch,
      roots: [{
        cwd: "/workspace/apps/web",
        files: [{ path: "src/app.tsx", displayPath: "web/src/app.tsx" }],
      }],
    });
  });

  test("advertises only reviewed files with config and project-local ESLint", () => {
    const runtime = configuredRuntime();
    expect(getEslintCheckAvailability({
      roots: [{ cwd: "/repo", files: [{ path: "src/app.tsx" }] }],
      rawPatch: patch,
    }, runtime)).toEqual({ available: true, fileCount: 1, projectCount: 1 });
  });

  test("does not advertise a globally available or unconfigured ESLint", () => {
    const runtime = makeRuntime({ files: ["/repo/src/app.tsx"] });
    expect(getEslintCheckAvailability({
      roots: [{ cwd: "/repo", files: [{ path: "src/app.tsx" }] }],
      rawPatch: patch,
    }, runtime)).toMatchObject({ available: false, reason: "eslint-not-configured" });
    expect(runtime.calls).toEqual([]);
  });

  test("runs the local ESLint entry with argv and maps structured findings", async () => {
    const runtime = configuredRuntime({
      exitCode: 1,
      stdout: JSON.stringify([{
        filePath: "/repo/src/app.tsx",
        messages: [
          {
            ruleId: "react-hooks/exhaustive-deps",
            severity: 1,
            message: "React Hook useEffect has a missing dependency: 'count'.",
            line: 9,
            column: 1,
            endLine: 9,
            endColumn: 45,
            suggestions: [{ desc: "Update dependencies" }],
          },
          {
            ruleId: "no-unused-vars",
            severity: 2,
            message: "Unused value.",
            line: 8,
            column: 7,
          },
        ],
      }]),
    });

    const response = await runEslintCheck({
      roots: [{ cwd: "/repo", files: [{ path: "src/app.tsx" }] }],
      rawPatch: patch,
    }, runtime);

    expect(response).toMatchObject({
      status: "ok",
      summary: { errors: 1, warnings: 1, changedLineErrors: 0, changedLineWarnings: 1 },
      eslintVersions: ["9.12.0"],
      diagnostics: [
        { filePath: "src/app.tsx", line: 8, severity: 2, onChangedLine: false },
        { filePath: "src/app.tsx", line: 9, severity: 1, onChangedLine: true, fixable: true },
      ],
    });
    expect(runtime.calls).toEqual([{
      command: "/usr/bin/node",
      cwd: "/repo",
      timeoutMs: 30_000,
      args: [
        "/repo/node_modules/eslint/bin/eslint.js",
        "--format",
        "json",
        "--no-color",
        "--",
        "src/app.tsx",
      ],
    }]);
  });

  test("uses the nearest package config and a hoisted root ESLint", async () => {
    const runtime = makeRuntime({
      files: [
        "/repo/packages/web/src/app.tsx",
        "/repo/packages/web/eslint.config.mjs",
        "/repo/node_modules/eslint/package.json",
        "/repo/node_modules/eslint/bin/eslint.js",
      ],
      contents: {
        "/repo/node_modules/eslint/package.json": JSON.stringify({ version: "9.0.0", bin: "bin/eslint.js" }),
      },
      result: { stdout: "[]" },
    });

    await runEslintCheck({
      roots: [{ cwd: "/repo", files: [{ path: "packages/web/src/app.tsx" }] }],
      rawPatch: "",
    }, runtime);

    expect(runtime.calls[0]).toMatchObject({
      cwd: "/repo/packages/web",
      args: expect.arrayContaining(["src/app.tsx"]),
    });
  });

  test("preserves workspace-prefixed display paths", async () => {
    const runtime = configuredRuntime({
      stdout: JSON.stringify([{
        filePath: "/repo/src/app.tsx",
        messages: [{ ruleId: "rules-of-hooks", severity: 2, message: "Invalid hook call.", line: 9, column: 1 }],
      }]),
      exitCode: 1,
    });

    const response = await runEslintCheck({
      roots: [{ cwd: "/repo", files: [{ path: "src/app.tsx", displayPath: "web/src/app.tsx" }] }],
      rawPatch: patch.replaceAll("src/app.tsx", "web/src/app.tsx"),
    }, runtime);

    expect(response).toMatchObject({
      status: "ok",
      diagnostics: [{ filePath: "web/src/app.tsx", onChangedLine: true }],
    });
  });

  test("distinguishes ESLint findings from configuration failures", async () => {
    const findings = await runEslintCheck({
      roots: [{ cwd: "/repo", files: [{ path: "src/app.tsx" }] }],
      rawPatch: patch,
    }, configuredRuntime({ exitCode: 1, stdout: "[]" }));
    expect(findings.status).toBe("ok");

    const failure = await runEslintCheck({
      roots: [{ cwd: "/repo", files: [{ path: "src/app.tsx" }] }],
      rawPatch: patch,
    }, configuredRuntime({ exitCode: 2, stderr: "Could not find config" }));
    expect(failure).toMatchObject({ status: "error", reason: "eslint-exit", exitCode: 2 });
  });

  test("fails safely on timeout, oversized output, and invalid JSON", async () => {
    await expect(runEslintCheck({
      roots: [{ cwd: "/repo", files: [{ path: "src/app.tsx" }] }], rawPatch: patch,
    }, configuredRuntime({ timedOut: true }))).resolves.toMatchObject({ status: "error", reason: "timeout" });

    await expect(runEslintCheck({
      roots: [{ cwd: "/repo", files: [{ path: "src/app.tsx" }] }], rawPatch: patch,
    }, configuredRuntime({ outputLimitExceeded: true }))).resolves.toMatchObject({ status: "error", reason: "output-limit" });

    await expect(runEslintCheck({
      roots: [{ cwd: "/repo", files: [{ path: "src/app.tsx" }] }], rawPatch: patch,
    }, configuredRuntime({ stdout: "not json" }))).resolves.toMatchObject({ status: "error", reason: "invalid-json" });
  });

  test("shares one 30-second execution budget across config groups", async () => {
    let now = 1_000;
    const runtime = makeRuntime({
      files: [
        "/repo/packages/a/src/a.ts",
        "/repo/packages/a/eslint.config.js",
        "/repo/packages/b/src/b.ts",
        "/repo/packages/b/eslint.config.js",
        "/repo/node_modules/eslint/package.json",
        "/repo/node_modules/eslint/bin/eslint.js",
      ],
      contents: {
        "/repo/node_modules/eslint/package.json": JSON.stringify({
          version: "9.12.0",
          bin: { eslint: "bin/eslint.js" },
        }),
      },
      onRunCommand: () => {
        now += 5_000;
      },
      now: () => now,
    });

    const response = await runEslintCheck({
      roots: [{
        cwd: "/repo",
        files: [
          { path: "packages/a/src/a.ts" },
          { path: "packages/b/src/b.ts" },
        ],
      }],
      rawPatch: "",
    }, runtime);

    expect(response.status).toBe("ok");
    expect(runtime.calls.map((call) => call.timeoutMs)).toEqual([30_000, 25_000]);
  });

  test("rejects paths that escape the reviewed root", () => {
    const runtime = makeRuntime({
      files: [
        "/outside.ts",
        "/repo/eslint.config.js",
        "/repo/node_modules/eslint/package.json",
        "/repo/node_modules/eslint/bin/eslint.js",
      ],
      contents: {
        "/repo/node_modules/eslint/package.json": JSON.stringify({ version: "9.0.0", bin: "bin/eslint.js" }),
      },
    });
    expect(getEslintCheckAvailability({
      roots: [{ cwd: "/repo", files: [{ path: "../outside.ts" }] }], rawPatch: "",
    }, runtime)).toMatchObject({ available: false });
  });
});
