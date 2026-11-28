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

  testIfUnix("opens an available changelist, expands its diff, and disables staging", async () => {
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
      '    case "${PLANNOTATOR_TEST_P4_OPENED:-mixed}:$3" in',
      "      empty:*|numbered:default) ;;",
      '      *) echo "//depot/file.txt#1 - edit $3 change (text) by test-user@test-client" ;;',
      "    esac",
      "    ;;",
      "  changes)",
      '    echo "Change 987 on 2026/11/18 by test-user@test-client *pending* \'Review this change\'"',
      '    echo "Change 421 on 2026/11/17 by test-user@test-client *pending* \'Older change\'"',
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
      "const selected = await prepareLocalReviewDiff({ cwd, configuredDiffType: 'since-base', requestedDiffType: 'p4-changelist:421' });",
      "process.env.PLANNOTATOR_TEST_P4_OPENED = 'numbered';",
      "const numbered = await prepareLocalReviewDiff({ cwd, configuredDiffType: 'since-base' });",
      "process.env.PLANNOTATOR_TEST_P4_OPENED = 'empty';",
      "const empty = await prepareLocalReviewDiff({ cwd, configuredDiffType: 'since-base' });",
      "console.log(JSON.stringify({ prepared, canStage, contents, selected, numbered, empty }));",
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
    const fileDiff = expect.stringContaining("diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new");
    const numberedOptions = [
      { id: "p4-changelist:987", label: "CL 987: Review this change" },
      { id: "p4-changelist:421", label: "CL 421: Older change" },
    ];
    expect(payload).toMatchObject({
      prepared: {
        diffType: "p4-default",
        rawPatch: fileDiff,
        gitContext: {
          vcsType: "p4",
          currentBranch: "test-client",
          diffOptions: [
            { id: "p4-default", label: "Default changelist" },
            ...numberedOptions,
          ],
        },
      },
      canStage: false,
      contents: { oldContent: "old\n", newContent: "new\n" },
      selected: { diffType: "p4-changelist:421", rawPatch: fileDiff },
      numbered: {
        diffType: "p4-changelist:987",
        rawPatch: fileDiff,
        gitContext: { vcsType: "p4", diffOptions: numberedOptions },
      },
      empty: { diffType: "p4-default", rawPatch: "", gitContext: { diffOptions: [] } },
    });
  });
});
