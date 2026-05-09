import { describe, expect, test } from "bun:test";
import {
  getJjDiffArgs,
  jjLineBaseRevset,
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
