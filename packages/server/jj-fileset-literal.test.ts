/**
 * jj reads a file by a LITERAL path, never as a fileset expression.
 *
 * `jj file show -- <path>` parses `<path>` as a fileset expression, so a file
 * named `a|b.png` read that way returns the union of `a` and `b.png`, and `~`,
 * `&` or `"` in a name change what is read too. Paths reach these reads from
 * the diff and, for the Markdown preview's images, from a Markdown file the
 * review shows (`/api/review-markdown-image`, `/api/review-image`, and the
 * full-file contents behind expansion and the preview). Both runtimes run the
 * shared reader over their own jj spawner, so both are exercised.
 *
 * Skipped when `jj` is not installed (CI runners do not ship it).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getJjFileBytesForDiff, getJjFileContentsForDiff, jjRootFileFileset } from "@plannotator/shared/jj-core";
import { runtime as bunJjRuntime } from "./jj";
import { jjRuntime as piJjRuntime } from "../../apps/pi-extension/server/vcs.ts";

const hasJj = (() => {
  try {
    return spawnSync("jj", ["--version"], { encoding: "utf-8" }).status === 0;
  } catch {
    return false;
  }
})();

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** Files whose names are fileset operators, beside the files those operators would also match. */
const FILES: Record<string, string> = {
  "a|b.png": "PIPE",
  a: "DECOY-A",
  "b.png": "DECOY-B",
  "x~y.png": "TILDE",
  x: "DECOY-X",
  "q\"uote\\back&amp.png": "QUOTE",
  "sp ace.png": "SPACE",
};

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-jj-fileset-"));
  tempDirs.push(dir);
  const jj = (args: string[]) => {
    const result = spawnSync("jj", args, { cwd: dir, encoding: "utf-8" });
    if (result.status !== 0) throw new Error(result.stderr || `jj ${args.join(" ")} failed`);
  };
  jj(["git", "init", "."]);
  jj(["config", "set", "--repo", "user.name", "Fileset Test"]);
  jj(["config", "set", "--repo", "user.email", "fileset-test@example.invalid"]);
  for (const [name, body] of Object.entries(FILES)) writeFileSync(join(dir, name), body);
  return dir;
}

describe("jjRootFileFileset", () => {
  test("quotes the path as one root-relative literal, escaping what jj's string literal needs", () => {
    expect(jjRootFileFileset("docs/a|b.png")).toBe('root-file:"docs/a|b.png"');
    expect(jjRootFileFileset('q"x\\y.png')).toBe('root-file:"q\\"x\\\\y.png"');
    expect(jjRootFileFileset("tab\there.png")).toBe('root-file:"tab\\x09here.png"');
  });
});

describe.each([
  ["Bun", bunJjRuntime],
  ["Pi", piJjRuntime],
] as const)("%s jj runtime reads one literal path", (_name, runtime) => {
  const testIfJj = hasJj ? test : test.skip;

  testIfJj("image bytes and full contents come from exactly the named file", async () => {
    const repo = initRepo();
    const decoder = new TextDecoder();
    for (const name of ["a|b.png", "x~y.png", "q\"uote\\back&amp.png", "sp ace.png"]) {
      const read = await getJjFileBytesForDiff(runtime, "jj-current", "", name, undefined, "new", 1024, repo);
      expect([name, read.kind === "ok" ? decoder.decode(read.bytes) : read.kind]).toEqual([name, FILES[name]]);
      const contents = await getJjFileContentsForDiff(runtime, "jj-current", "", name, undefined, repo);
      expect([name, contents.newContent]).toEqual([name, FILES[name]]);
    }
    // A name the working copy does not hold reads as missing, not as anything else.
    const missing = await getJjFileBytesForDiff(runtime, "jj-current", "", "a|nope.png", undefined, "new", 1024, repo);
    expect(missing.kind).toBe("missing");
  });
});
