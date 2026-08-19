import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getJjDiffArgs,
  jjLineBaseRevset,
  runtime as jjRuntime,
  selectDefaultJjCompareTarget,
} from "./jj";

describe("jj diff args", () => {
  test("builds git-format diff args for each jj mode", () => {
    expect(getJjDiffArgs("jj-current", "trunk()")).toEqual({
      args: ["diff", "--git", "-r", "@"],
      label: "Current change",
    });

    expect(getJjDiffArgs("jj-last", "trunk()")).toEqual({
      args: ["diff", "--git", "-r", "@-"],
      label: "Last change",
    });

    expect(getJjDiffArgs("jj-line", "trunk()")).toEqual({
      args: ["diff", "--git", "--from", "heads(::@ & ::(trunk()))", "--to", "@"],
      label: "Line of work vs trunk()",
    });

    expect(getJjDiffArgs("jj-all", "trunk()")).toEqual({
      args: ["diff", "--git", "--from", "root()", "--to", "@"],
      label: "All files",
    });
  });

  test("preserves hide-whitespace in every jj diff mode", () => {
    expect(getJjDiffArgs("jj-current", "trunk()", { hideWhitespace: true })?.args)
      .toEqual(["diff", "--git", "-w", "-r", "@"]);
    expect(getJjDiffArgs("jj-last", "trunk()", { hideWhitespace: true })?.args)
      .toEqual(["diff", "--git", "-w", "-r", "@-"]);
    expect(getJjDiffArgs("jj-line", "trunk()", { hideWhitespace: true })?.args)
      .toEqual(["diff", "--git", "-w", "--from", "heads(::@ & ::(trunk()))", "--to", "@"]);
    expect(getJjDiffArgs("jj-all", "trunk()", { hideWhitespace: true })?.args)
      .toEqual(["diff", "--git", "-w", "--from", "root()", "--to", "@"]);
  });
});

describe("jj compare targets", () => {
  test("resolves default target from jj trunk bookmarks", async () => {
    await expect(selectDefaultJjCompareTarget({
      async runJj() {
        return { stdout: '[{"name":"main"},{"name":"main","remote":"origin"}]\n', stderr: "", exitCode: 0 };
      },
    })).resolves.toBe("main@origin");

    await expect(selectDefaultJjCompareTarget({
      async runJj() {
        return { stdout: '[{"name":"main"}]\n', stderr: "", exitCode: 0 };
      },
    })).resolves.toBe("main");

    await expect(selectDefaultJjCompareTarget({
      async runJj() {
        return { stdout: "[]\n", stderr: "", exitCode: 0 };
      },
    })).resolves.toBe("trunk()");
  });

  test("treats bookmarks and revsets correctly in line-of-work revsets", () => {
    expect(jjLineBaseRevset("main")).toBe('heads(::@ & ::(bookmarks(exact:"main")))');
    expect(jjLineBaseRevset("main@origin")).toBe('heads(::@ & ::(remote_bookmarks(exact:"main", exact:"origin")))');
    expect(jjLineBaseRevset("trunk()")).toBe("heads(::@ & ::(trunk()))");
  });
});

/**
 * Snapshot materialization asks jj for a whole repository tree, so the runtime
 * has to stop READING at the ceiling. Measuring the output after buffering it
 * bounds nothing: the memory is already spent by the time the check runs.
 *
 * Skipped when `jj` is not installed (CI runners do not ship it).
 */
describe("jj runtime output ceiling", () => {
  // Bun.spawnSync throws when the executable is missing entirely (ENOENT),
  // which is exactly the case this gate exists for on CI runners without jj.
  const testIfJj = (() => {
    try {
      return Bun.spawnSync(["jj", "--version"], { stdout: "pipe", stderr: "pipe" }).exitCode === 0;
    } catch {
      return false;
    }
  })()
    ? test
    : test.skip;
  let workspace = "";

  afterEach(() => {
    if (workspace) rmSync(workspace, { recursive: true, force: true });
    workspace = "";
  });

  testIfJj("stops reading and flags truncation once maxOutputBytes is passed", async () => {
    workspace = mkdtempSync(join(tmpdir(), "plannotator-jj-cap-"));
    const jj = (args: string[]) => {
      const result = Bun.spawnSync(["jj", ...args], { cwd: workspace, stdout: "pipe", stderr: "pipe" });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    };
    jj(["git", "init", "."]);
    jj(["config", "set", "--repo", "user.name", "Cap Test"]);
    jj(["config", "set", "--repo", "user.email", "cap-test@example.invalid"]);
    writeFileSync(join(workspace, "big.ts"), "export const line = 1;\n".repeat(4000));
    jj(["commit", "-m", "big"]);

    const args = ["--ignore-working-copy", "diff", "--git", "--from", "root()", "--to", "@-"];
    const uncapped = await jjRuntime.runJj(args, { cwd: workspace });
    expect(uncapped.truncated).toBeUndefined();
    expect(uncapped.stdout.length).toBeGreaterThan(10_000);

    const capped = await jjRuntime.runJj(args, { cwd: workspace, maxOutputBytes: 64 });
    expect(capped.truncated).toBe(true);
    expect(capped.stdout.length).toBeLessThanOrEqual(64);
  });
});
