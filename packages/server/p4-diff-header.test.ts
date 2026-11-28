import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDiffToFiles } from "@plannotator/core/diff-files";

test.skipIf(process.platform === "win32")("P4 review lists an edited file once when both diff headers are present", () => {
  const fixture = mkdtempSync(join(tmpdir(), "plannotator-p4-headers-"));

  try {
    const bin = join(fixture, "bin");
    const workspace = join(fixture, "workspace");
    mkdirSync(bin);
    mkdirSync(workspace);
    writeFileSync(join(bin, "p4"), [
      "#!/bin/sh",
      'case "$1" in',
      '  info) printf "Client name: test-client\\nClient root: %s\\n" "$PLANNOTATOR_TEST_P4_WORKSPACE" ;;',
      "  opened)",
      '    printf "%s\\n" "//depot/both.txt#1 - edit" "//depot/separator.txt#1 - edit" "//depot/unified.txt#1 - edit" ;;',
      '  diff) test "$2" = -du && printf "%s\\n" "$PLANNOTATOR_TEST_P4_PATCH" ;;',
      "  *) exit 1 ;;",
      "esac",
      "",
    ].join("\n"), { mode: 0o755 });

    const mockPatch = [
      `==== //depot/both.txt#1 - ${join(workspace, "both.txt")} ====`,
      "--- //depot/both.txt#1",
      `+++ ${join(workspace, "both.txt")}`,
      "@@ -1 +1 @@",
      "-old",
      "+new",
      `==== //depot/separator.txt#1 - ${join(workspace, "separator.txt")} ====`,
      "@@ -1 +1 @@",
      "-before",
      "+after",
      "--- //depot/unified.txt#1",
      `+++ ${join(workspace, "unified.txt")}`,
      "@@ -1 +1 @@",
      "-previous",
      "+current",
    ].join("\n");

    const moduleUrl = new URL("./p4.ts", import.meta.url);
    const child = Bun.spawnSync([process.execPath, "--no-env-file", "-e", [
      `const { runP4Diff } = await import(${JSON.stringify(moduleUrl.href)});`,
      `console.log(JSON.stringify(await runP4Diff("p4-default", ${JSON.stringify(workspace)})));`,
    ].join("\n")], {
      cwd: workspace,
      env: {
        ...process.env,
        PATH: bin,
        PLANNOTATOR_TEST_P4_WORKSPACE: workspace,
        PLANNOTATOR_TEST_P4_PATCH: mockPatch,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    const result: { patch: string; error?: string } = JSON.parse(child.stdout.toString());
    expect(result.error).toBeUndefined();
    expect(parseDiffToFiles(result.patch).map(({ path, additions, deletions }) => ({ path, additions, deletions }))).toEqual([
      { path: "both.txt", additions: 1, deletions: 1 },
      { path: "separator.txt", additions: 1, deletions: 1 },
      { path: "unified.txt", additions: 1, deletions: 1 },
    ]);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
