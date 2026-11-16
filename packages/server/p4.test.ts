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

test.skipIf(process.platform === "win32")("Perforce adds use the same physical line count as their source files", async () => {
  const workspace = makeTempDir("plannotator-p4-adds-");
  const binDir = makeTempDir("plannotator-p4-adds-bin-");
  writeFileSync(join(workspace, "terminated.txt"), "a\n");
  writeFileSync(join(workspace, "unterminated.txt"), "b");
  writeFileSync(join(workspace, "empty.txt"), "");
  writeFileSync(join(binDir, "p4"), [
    "#!/bin/sh",
    'case "$1" in',
    'info) echo "Client name: tests"; printf "Client root: %s\\n" "$PWD" ;;',
    'opened) for file in terminated.txt unterminated.txt empty.txt; do echo "//depot/$file#1 - add default change (text)"; done ;;',
    '-ztag) for file in terminated.txt unterminated.txt empty.txt; do printf "... depotFile //depot/%s\\n... path %s/%s\\n\\n" "$file" "$PWD" "$file"; done ;;',
    '*) exit 1 ;;',
    'esac',
  ].join("\n"), { mode: 0o755 });

  const module = join(import.meta.dir, "p4.ts");
  const run = Bun.spawn([process.execPath, "-e",
    `const { runP4Diff } = await import(${JSON.stringify(module)}); process.stdout.write((await runP4Diff("p4-default", process.cwd())).patch);`
  ], { cwd: workspace, env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` }, stdout: "pipe", stderr: "pipe" });
  const [patch, stderr, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);
  expect(code, stderr).toBe(0);
  expect(patch).toContain("@@ -0,0 +1,1 @@\n+a\n");
  expect(patch).not.toContain("+a\n+\n");
  expect(patch).toContain("+b\n\\ No newline at end of file\n");
  expect(patch.trimEnd().split("diff --git a/empty.txt b/empty.txt").at(-1)?.trim()).toBe("new file mode 100644");
});
