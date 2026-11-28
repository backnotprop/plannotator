import { describe, expect, test } from "bun:test";
import { REVIEW_OPEN_DIFF_TYPES, formatIgnoredReviewWords, parseReviewArgs, resolveReviewTarget, withReviewDirectory } from "./review-args";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { GIT_DIFF_TYPES } from "./vcs-core";

describe("parseReviewArgs", () => {
  test("defaults to auto VCS and local PR checkout", () => {
    expect(parseReviewArgs("")).toEqual({
      prUrl: undefined,
      vcsType: undefined,
      useLocal: true,
      errors: [],
    });
  });

  test("parses --git without a PR URL", () => {
    expect(parseReviewArgs("--git")).toEqual({
      prUrl: undefined,
      vcsType: "git",
      useLocal: true,
      errors: [],
    });
  });

  test("parses --gitbutler without a PR URL", () => {
    expect(parseReviewArgs("--gitbutler")).toEqual({
      prUrl: undefined,
      vcsType: "gitbutler",
      useLocal: true,
      errors: [],
    });
  });

  test("parses PR URLs before or after --git", () => {
    expect(parseReviewArgs("--git https://github.com/acme/repo/pull/12")).toEqual({
      prUrl: "https://github.com/acme/repo/pull/12",
      vcsType: "git",
      useLocal: true,
      errors: [],
    });
    expect(parseReviewArgs("https://github.com/acme/repo/pull/12 --git")).toEqual({
      prUrl: "https://github.com/acme/repo/pull/12",
      vcsType: "git",
      useLocal: true,
      errors: [],
    });
  });

  test("preserves --no-local for PR review mode", () => {
    expect(parseReviewArgs("--no-local https://github.com/acme/repo/pull/12")).toEqual({
      prUrl: "https://github.com/acme/repo/pull/12",
      vcsType: undefined,
      useLocal: false,
      errors: [],
    });
  });

  // #1907: `plannotator review --gate` (an agent waiting for the sign-off) must
  // not be refused as an unknown option on hosts that run the CLI as written.
  test("--gate is accepted, marked, and absent otherwise", () => {
    expect(parseReviewArgs("--gate")).toMatchObject({ gate: true, errors: [] });
    expect(parseReviewArgs(["--gate", "../wt"])).toMatchObject({ gate: true, words: ["../wt"], errors: [] });
    expect("gate" in parseReviewArgs("")).toBe(false);
  });

  test("--no-git-remote-check sets the opt-out bit and is absent otherwise", () => {
    // #1553: every host (CLI, OpenCode, Pi) forwards this bit to the review
    // server. It must be absent — not `true` — when the flag is not typed, or
    // it would outrank PLANNOTATOR_GIT_REMOTE_CHECK and config.gitRemoteCheck and
    // make the env/config opt-out unreachable.
    expect(parseReviewArgs("--no-git-remote-check").gitRemoteCheck).toBe(false);
    expect(parseReviewArgs(["--no-git-remote-check"]).gitRemoteCheck).toBe(false);
    expect(parseReviewArgs("--no-git-remote-check").errors).toEqual([]);
    expect("gitRemoteCheck" in parseReviewArgs("")).toBe(false);
    expect("gitRemoteCheck" in parseReviewArgs("--git")).toBe(false);
  });

  test("--no-git-remote-check composes with the other review selectors", () => {
    const parsed = parseReviewArgs("--git --base develop --no-git-remote-check");
    expect(parsed).toEqual({
      prUrl: undefined,
      patchFile: undefined,
      vcsType: "git",
      useLocal: true,
      base: "develop",
      diffType: undefined,
      gitRemoteCheck: false,
      errors: [],
    });
  });

  test("accepts argv arrays from the compiled CLI", () => {
    expect(parseReviewArgs(["--git", "--no-local", "https://github.com/acme/repo/pull/12"])).toEqual({
      prUrl: "https://github.com/acme/repo/pull/12",
      vcsType: "git",
      useLocal: false,
      errors: [],
    });
  });

  test("strips wrapping quotes from string and argv inputs", () => {
    expect(parseReviewArgs(`--git "https://github.com/acme/repo/pull/12"`).prUrl)
      .toBe("https://github.com/acme/repo/pull/12");
    expect(parseReviewArgs(["--git", "\"https://github.com/acme/repo/pull/12\""]).prUrl)
      .toBe("https://github.com/acme/repo/pull/12");
  });

  test("keeps non-URL positional words for the host's directory resolution", () => {
    // Slash-command hosts forward raw user prose verbatim, so the parser never
    // rejects words; resolveReviewTarget decides what they name.
    expect(parseReviewArgs("--git not-a-url")).toEqual({
      prUrl: undefined,
      words: ["not-a-url"],
      vcsType: "git",
      useLocal: true,
      errors: [],
    });
  });

  test("reports unknown dash-prefixed tokens instead of silently dropping them", () => {
    // The pre-existing silent-swallow bug: `--bse main` used to land in
    // `positional`, be ignored, and the session opened as if nothing happened —
    // on every host. A typo'd flag must fail loudly, exactly as on annotate.
    const parsed = parseReviewArgs("--bse main");
    expect(parsed.errors).toEqual(["Unknown review option: --bse"]);
    // The stray value is a directory candidate, but the option error prevents launch.
    expect(parsed.prUrl).toBeUndefined();
  });

  test("reports every unknown dashed token, including = forms", () => {
    // `--base=main` is not a supported value syntax (space-separated only), so
    // it must surface as an unknown option rather than being half-parsed.
    const parsed = parseReviewArgs("--verbose --base=main");
    expect(parsed.errors).toEqual([
      "Unknown review option: --verbose",
      "Unknown review option: --base=main",
    ]);
  });

  test("parses --base and --diff-type values into the struct", () => {
    // Failure caught: the value never reaching the struct at all (the
    // pre-PR silent swallow, or a broken value-consuming loop).
    const parsed = parseReviewArgs("--base feature/part-1 --diff-type merge-base");
    expect(parsed.base).toBe("feature/part-1");
    expect(parsed.diffType).toBe("merge-base");
    expect(parsed.errors).toEqual([]);
  });

  test("--base's value cannot shadow a following PR URL", () => {
    // Failure caught: the value token landing in positional[0] and shadowing
    // the URL — a real regression path since only positional[0] is a URL
    // candidate.
    const parsed = parseReviewArgs("--base main https://github.com/acme/repo/pull/12");
    expect(parsed.base).toBe("main");
    expect(parsed.prUrl).toBe("https://github.com/acme/repo/pull/12");
    expect(parsed.errors).toEqual([]);
  });

  test("--base at end of argv reports a missing value", () => {
    // Failure caught: a silently-undefined base that then diffs against the
    // detected default as if the flag had worked.
    expect(parseReviewArgs("--base").errors).toEqual(["Missing value for --base"]);
    expect(parseReviewArgs("--base --git").errors).toEqual(["Missing value for --base"]);
    expect(parseReviewArgs("--diff-type").errors).toEqual(["Missing value for --diff-type"]);
  });

  test("--base twice is an error, not last-wins", () => {
    const parsed = parseReviewArgs("--base a --base b");
    expect(parsed.errors).toEqual(["--base may only be specified once"]);
    // The second value must not silently replace the first.
    expect(parsed.base).toBe("a");
  });

  test("--diff-type rejects unknown ids, listing the valid set", () => {
    // Failure caught: an unowned diff type reaching resolveRequestedDiffType,
    // which silently falls back to the configured default.
    const parsed = parseReviewArgs("--diff-type nonsense");
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]).toContain("Unknown diff type: nonsense");
    for (const id of REVIEW_OPEN_DIFF_TYPES) {
      expect(parsed.errors[0]).toContain(id);
    }
    expect(parsed.diffType).toBeUndefined();
  });

  test("rejects base refs carrying range syntax", () => {
    // Defense in depth ahead of the rev-parse probe: `..` is range syntax,
    // never a single compare target.
    expect(parseReviewArgs("--base main..feature").errors).toEqual([
      "Invalid base ref: main..feature",
    ]);
  });

  test("REVIEW_OPEN_DIFF_TYPES is exactly GIT_DIFF_TYPES", () => {
    // Failure caught: a git diff type added to one set and not the other,
    // making a valid mode unreachable from (or falsely advertised by) the CLI.
    expect(new Set(REVIEW_OPEN_DIFF_TYPES)).toEqual(GIT_DIFF_TYPES);
  });

  test("an unknown dashed token cannot shadow a PR URL", () => {
    // Before the errors[] contract, `--bse` landed in positional[0] and the
    // real PR URL in positional[1] was never inspected — the PR silently
    // became a local review. Now the invocation refuses instead.
    const parsed = parseReviewArgs("--bse https://github.com/acme/repo/pull/12");
    expect(parsed.errors).toEqual(["Unknown review option: --bse"]);
    expect(parsed.prUrl).toBe("https://github.com/acme/repo/pull/12");
  });

  test("parses one external patch file", () => {
    // given
    const input = ["--patch-file", "reading.diff"];

    // when
    const result = parseReviewArgs(input);

    // then
    expect(result.patchFile).toBe("reading.diff");
    expect(result.prUrl).toBeUndefined();
    expect(result.errors).toEqual([]);
  });

  test("rejects patch file combined with VCS/PR selectors", () => {
    // given
    const withPrUrl = ["https://github.com/acme/repo/pull/12", "--patch-file", "reading.diff"];
    const withBase = ["--patch-file", "reading.diff", "--base", "main"];
    const withDiffType = ["--patch-file", "reading.diff", "--diff-type", "staged"];
    const withProvider = ["--patch-file", "reading.diff", "--git"];
    const withLocal = ["--patch-file", "reading.diff", "--local"];
    // --no-local is a PR-review selector exactly like --local, and useLocal
    // defaults to true — so presence, not value, decides the conflict.
    const withNoLocal = ["--patch-file", "reading.diff", "--no-local"];

    // when / then
    expect(parseReviewArgs(withPrUrl).errors).toContain("--patch-file cannot be combined with a PR/MR URL");
    expect(parseReviewArgs(withBase).errors).toContain("--patch-file cannot be combined with --base");
    expect(parseReviewArgs(withDiffType).errors).toContain("--patch-file cannot be combined with --diff-type");
    expect(parseReviewArgs(withProvider).errors).toContain("--patch-file cannot be combined with --git/--gitbutler");
    expect(parseReviewArgs(withLocal).errors).toContain("--patch-file cannot be combined with --local/--no-local");
    expect(parseReviewArgs(withNoLocal).errors).toContain("--patch-file cannot be combined with --local/--no-local");
  });

  test("leaves --no-local alone without a patch file", () => {
    // given / when
    const result = parseReviewArgs(["https://github.com/acme/repo/pull/12", "--no-local"]);

    // then
    expect(result.errors).toEqual([]);
    expect(result.useLocal).toBe(false);
  });

  test("rejects a missing or duplicate patch file", () => {
    // given
    const missingPath = ["--patch-file"];
    const duplicatePath = ["--patch-file", "one.diff", "--patch-file", "two.diff"];

    // when / then
    expect(parseReviewArgs(missingPath).errors).toEqual(["--patch-file requires a path or -"]);
    expect(parseReviewArgs(duplicatePath).errors).toEqual(["--patch-file may only be specified once"]);
  });
});

describe("review directory targets", () => {
  test("keeps quoted paths intact and consumes flag values separately", () => {
    for (const input of [
      '--base main "../feature worktree" --diff-type last-commit',
      ["--base", "main", "../feature worktree", "--diff-type", "last-commit"],
    ]) {
      expect(parseReviewArgs(input)).toMatchObject({
        words: ["../feature worktree"], base: "main", diffType: "last-commit", errors: [],
      });
    }
  });

  test("finds a PR/MR URL anywhere among the words and refuses two", () => {
    expect(parseReviewArgs("please review https://github.com/a/b/pull/1")).toMatchObject({
      prUrl: "https://github.com/a/b/pull/1", words: ["please", "review"], errors: [],
    });
    expect(parseReviewArgs("https://github.com/a/b/pull/1 https://github.com/a/b/pull/2").errors).toHaveLength(1);
  });

  function withTree(run: (root: string) => void) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "review-directory-")));
    const originalCwd = process.cwd();
    try {
      mkdirSync(join(root, "repo with spaces"));
      mkdirSync(join(root, "backend"));
      mkdirSync(join(root, "myproject"));
      mkdirSync(join(root, "src", "components"), { recursive: true });
      writeFileSync(join(root, "file"), "not a directory");
      symlinkSync(join(root, "repo with spaces"), join(root, "link"), "dir");
      run(root);
      expect(process.cwd()).toBe(originalCwd);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  const target = (input: string, cwd: string) => resolveReviewTarget(parseReviewArgs(input), cwd);

  test("resolves against the caller, accepts symlinked directories, and refuses files", () => {
    withTree((root) => {
      expect(target('"repo with spaces"', root).directory).toBe(join(root, "repo with spaces"));
      expect(target(`"${join(root, "repo with spaces")}"`, "/elsewhere").directory).toBe(join(root, "repo with spaces"));
      expect(target("link", root).directory).toBe(join(root, "link"));
      expect(target("backend", root).directory).toBe(join(root, "backend"));
      expect(target("~", root).directory).toBe(homedir());
      expect(target("", root)).toEqual({ ignored: [] });
      expect(() => target("file", root)).toThrow(
        `${join(root, "file")} is a file, not a folder; nothing was opened.\n` +
          "To comment on the file, run: plannotator annotate file\n" +
          "To review the current project instead, run: plannotator review",
      );
    });
  });

  test("a sole path-shaped typo fails loudly instead of reviewing the caller's repo", () => {
    withTree((root) => {
      for (const input of ["./missing", "../missing", "missing/sub"]) {
        expect(() => target(input, root)).toThrow(`No folder "${input}" in ${root}; nothing was opened.`);
      }
      const home = join(homedir(), "plannotator-missing-dir-xyz");
      expect(() => target("~/plannotator-missing-dir-xyz", root)).toThrow(`No folder at ${home}; nothing was opened.`);
      expect(() => target("./file", root)).toThrow("is a file, not a folder");
    });
  });

  test("a sole bare word that names no folder stops with commands that recover in one step", () => {
    withTree((root) => {
      // The reported case: a folder name that is not there must not review the caller's repo.
      expect(() => target("myproj", root)).toThrow(
        `No folder "myproj" in ${root}; nothing was opened.\n` +
          "Did you mean myproject? Run: plannotator review myproject\n" +
          "To review the current project instead, run: plannotator review",
      );
      expect(() => target("please", root)).toThrow(
        `No folder "please" in ${root}; nothing was opened.\n` +
          "To review another folder, run: plannotator review <path to an existing folder>\n" +
          "To review the current project instead, run: plannotator review",
      );
      // Flags are not words: the folder is still the sole word.
      expect(() => target("--diff-type uncommitted myproj", root)).toThrow("Did you mean myproject?");
      expect(() => target("staged", root)).toThrow("run: plannotator review --diff-type staged");
      expect(() => target("1483", root)).toThrow("pass its URL: plannotator review https://github.com/<owner>/<repo>/pull/1483");
    });
  });

  test("did you mean: a typo'd segment is matched against its parent's folders, as typed", () => {
    withTree((root) => {
      expect(() => target("src/componnets", root)).toThrow("Did you mean src/components? Run: plannotator review src/components");
      expect(() => target("./src/compnents/", root)).toThrow("Did you mean ./src/components?");
      expect(() => target("srx/components", root)).toThrow("Did you mean src/components?");
      expect(() => target(join(root, "backnd"), root)).toThrow(`Did you mean ${join(root, "backend")}?`);
      expect(() => target('"repo with spacs/"', root)).toThrow('Run: plannotator review "repo with spaces"');
      // A file is not offered as a folder, and a far name is not offered at all.
      expect(() => target("fil/", root)).toThrow("To review another folder");
      expect(() => target("zzzzzz", root)).toThrow("To review another folder");
    });
  });

  test("path-shaped prose among several words is ignored, not fatal (v0.27.23 regression)", () => {
    withTree((root) => {
      expect(target("review the frontend/backend split", root)).toEqual({
        ignored: ["review", "the", "frontend/backend", "split"],
      });
      expect(target("look at the api/users code", root)).toEqual({
        ignored: ["look", "at", "the", "api/users", "code"],
      });
      // A path-shaped word naming a file is prose too.
      expect(target("look at ./file please", root)).toEqual({ ignored: ["look", "at", "./file", "please"] });
      // An existing directory among the words still selects it.
      expect(target("look at ./backend please", root)).toEqual({
        directory: join(root, "backend"),
        ignored: ["look", "at", "please"],
      });
      expect(target("./missing ./backend", root)).toEqual({ directory: join(root, "backend"), ignored: ["./missing"] });
      // A path word next to a PR URL is not a sole target either.
      expect(target("https://github.com/a/b/pull/1 ./missing", root)).toEqual({ ignored: ["./missing"] });
    });
  });

  test("prose that names no directory falls back to the invoking cwd (#1483)", () => {
    withTree((root) => {
      expect(target("please review my changes", root)).toEqual({ ignored: ["please", "review", "my", "changes"] });
      // A quoted sentence is one word, still prose; a sole bare word is a target.
      expect(target('"please review my changes"', root)).toEqual({ ignored: ["please review my changes"] });
      expect(() => target("focus", root)).toThrow('No folder "focus"');
      // In prose a bare word that happens to match a directory never hijacks
      // the review; a path-shaped word is the target.
      expect(target("please review backend", root)).toEqual({ ignored: ["please", "review", "backend"] });
      expect(target("please review ./backend", root)).toEqual({ directory: join(root, "backend"), ignored: ["please", "review"] });
      expect(target("review https://github.com/a/b/pull/1 now", root)).toEqual({ ignored: ["review", "now"] });
      expect(formatIgnoredReviewWords(target("please review", root))).toContain("please review");
      expect(formatIgnoredReviewWords(target("backend", root))).toBeUndefined();
    });
  });

  test("refuses two targets and a directory combined with --patch-file", () => {
    withTree((root) => {
      expect(() => target("./backend ./link", root)).toThrow("only one directory");
      expect(() => target("./backend https://github.com/a/b/pull/1", root)).toThrow("only one directory");
      expect(() => target("backend --patch-file change.patch", root)).toThrow("--patch-file cannot be combined with a review directory");
      // Prose alongside --patch-file stays tolerated.
      expect(target("please --patch-file change.patch", root)).toEqual({ ignored: ["please"] });
    });
  });

  test("labels targeted feedback without turning a bare approval into approval-with-notes", () => {
    expect(withReviewDirectory("Fix this", "/other/repo")).toContain("/other/repo\n\nFix this");
    expect(withReviewDirectory("", "/other/repo")).toBe("");
    expect(withReviewDirectory("Fix this")).toBe("Fix this");
  });
});
