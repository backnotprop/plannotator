import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(path);
  return path;
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("P4 provider non-regression", () => {
  const testIfUnix = process.platform === "win32" ? test.skip : test;

  testIfUnix("still detects, diffs, expands, and disables staging after GitButler registration", async () => {
    const workspace = makeTempDir("plannotator-p4-workspace-");
    const binDir = makeTempDir("plannotator-p4-bin-");
    const localFile = join(workspace, "file.txt");
    writeFileSync(localFile, "new\n", "utf-8");

    const p4Path = join(binDir, "p4");
    writeFileSync(p4Path, [
      "#!/bin/sh",
      'case "${1:-}" in',
      "  info)",
      '    echo "User name: test-user"',
      '    echo "Client name: test-client"',
      `    echo "Client root: ${workspace}"`,
      '    echo "Server address: perforce:1666"',
      "    ;;",
      "  opened)",
      '    echo "//depot/file.txt#1 - edit default change (text) by test-user@test-client"',
      "    ;;",
      "  changes)",
      "    ;;",
      "  diff)",
      '    printf "%s\\n" "--- //depot/file.txt#1"',
      `    printf "%s\\n" "+++ ${localFile}"`,
      '    printf "%s\\n" "@@ -1 +1 @@" "-old" "+new"',
      "    ;;",
      "  print)",
      '    printf "old\\n"',
      "    ;;",
      "  *)",
      '    echo "unexpected p4 command" >&2',
      "    exit 1",
      "    ;;",
      "esac",
      "",
    ].join("\n"), "utf-8");
    chmodSync(p4Path, 0o755);
    const vcsPath = join(import.meta.dir, "vcs.ts");
    const script = [
      `const { prepareLocalReviewDiff, canStageFiles, getVcsFileContentsForDiff } = await import(${JSON.stringify(vcsPath)});`,
      `const cwd = ${JSON.stringify(workspace)};`,
      "const prepared = await prepareLocalReviewDiff({ cwd, configuredDiffType: 'since-base' });",
      "const canStage = await canStageFiles('p4-default', cwd);",
      "const contents = await getVcsFileContentsForDiff('p4-default', '', 'file.txt', undefined, cwd);",
      "console.log(JSON.stringify({ prepared, canStage, contents }));",
    ].join("\n");
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: import.meta.dir,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode, stderr).toBe(0);
    const payload: unknown = JSON.parse(stdout);
    expect(payload).toMatchObject({
      prepared: {
        diffType: "p4-default",
        gitContext: {
          vcsType: "p4",
          currentBranch: "test-client",
          diffOptions: [{ id: "p4-default", label: "Default changelist" }],
        },
      },
      canStage: false,
      contents: { oldContent: "old\n", newContent: "new\n" },
    });
    expect(stdout).toContain("diff --git a/file.txt b/file.txt");
    expect(stdout).toContain("-old\\n+new");
  });
});
