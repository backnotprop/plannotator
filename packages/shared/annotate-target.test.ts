import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  ANNOTATE_BUNDLE_HINT,
  annotateInputNamesExistingTarget,
  annotatePathExists,
  buildAmbiguousAnnotateArgsMessage,
  buildUnresolvedAnnotateArgsMessage,
  probeAnnotateBundlePath,
  probeAnnotateToken,
  resolveAnnotateBundleFiles,
  selectAnnotateTokenTarget,
} from "./annotate-target";
import { PLANNOTATOR_BUNDLE_HINT_LINE } from "./plannotator-tool";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "plannotator-annotate-target-"));
  mkdirSync(join(root, "docs"), { recursive: true });
  mkdirSync(join(root, "notes/deep"), { recursive: true });
  writeFileSync(join(root, "plan.md"), "# Plan");
  writeFileSync(join(root, "docs/spec.md"), "# Spec");
  writeFileSync(join(root, "docs/page.html"), "<p>hi</p>");
  writeFileSync(join(root, "notes/deep/nested.md"), "# Nested");
  // Same basename twice for the ambiguous case.
  writeFileSync(join(root, "docs/dup.md"), "# A");
  writeFileSync(join(root, "notes/dup.md"), "# B");
  // Existing but not annotatable.
  writeFileSync(join(root, "script.py"), "print()");
  // Exists so that a wrongly split quoted token ("my notes.md" -> "notes.md")
  // would resolve if token boundaries were not preserved.
  writeFileSync(join(root, "notes.md"), "# Notes");
  // Wider plain-text set (guards ANNOTATABLE_DOC_REGEX breadth, which the
  // probe's no-walk cheapness for word tokens relies on).
  writeFileSync(join(root, "notes.txt"), "notes");
  writeFileSync(join(root, "config.yaml"), "a: 1");
  // Real scoped-package-style directory for the literal-@ fallback.
  mkdirSync(join(root, "@scope"), { recursive: true });
  writeFileSync(join(root, "@scope/README.md"), "# scoped");
  // Whole-string preference: the un-split input names this file even though
  // its second token also names an annotatable file on its own.
  writeFileSync(join(root, "Meeting Notes.md"), "# Meeting Notes");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const probe = (token: string) => probeAnnotateToken(token, root);

describe("probeAnnotateToken", () => {
  test("accepts URLs by shape without fetching", () => {
    expect(probe("https://example.com/page")).toBe("https://example.com/page");
    expect(probe("HTTP://example.com")).toBe("HTTP://example.com");
  });

  test("recognizes wrapped URLs: `@`-prefixed and quoted", () => {
    // The pipeline strips the `@` reference marker and wrapping quotes
    // before its own URL check, so the probe must unwrap the same way or
    // `annotate @https://example.com/page and summarize it` hands off
    // instead of opening the URL.
    expect(probe("@https://example.com/page")).toBe("https://example.com/page");
    expect(probe('"https://example.com/page"')).toBe("https://example.com/page");
  });

  test("resolves folders to absolute paths", () => {
    expect(probe("docs")).toBe(join(root, "docs"));
    expect(probe("docs/")).toBe(join(root, "docs"));
  });

  test("resolves HTML files to absolute paths", () => {
    expect(probe("docs/page.html")).toBe(join(root, "docs/page.html"));
  });

  test("resolves documents, including fuzzy basename matches", () => {
    expect(probe("plan.md")).toBe(join(root, "plan.md"));
    expect(probe("nested.md")).toBe(join(root, "notes/deep/nested.md"));
    expect(probe("@plan.md")).toBe(join(root, "plan.md"));
  });

  test("resolves an absolute path", () => {
    expect(probe(join(root, "plan.md"))).toBe(join(root, "plan.md"));
  });

  test("resolves the wider plain-text set (.txt, .yaml)", () => {
    expect(probe("notes.txt")).toBe(join(root, "notes.txt"));
    expect(probe("config.yaml")).toBe(join(root, "config.yaml"));
  });

  test("resolves a scoped-package-style literal `@` path", () => {
    // The strip half of the `@` handling is covered above (@plan.md); this
    // covers the literal fallback: no `scope/README.md` exists, so only the
    // literal `@scope/README.md` path can match.
    expect(probe("@scope/README.md")).toBe(join(root, "@scope/README.md"));
  });

  test("returns the token itself for ambiguous document names", () => {
    expect(probe("dup.md")).toBe("dup.md");
  });

  test("accepts existing-but-unsupported files so the pipeline owns their errors", () => {
    expect(probe("script.py")).toBe(join(root, "script.py"));
  });

  test("rejects natural-language words and missing files", () => {
    expect(probe("the")).toBeNull();
    expect(probe("aim")).toBeNull();
    expect(probe("missing.md")).toBeNull();
    expect(probe("")).toBeNull();
  });

  test("bare directory names only resolve when bareDirectories is allowed", () => {
    expect(probeAnnotateToken("docs", root, { bareDirectories: false })).toBeNull();
    expect(probeAnnotateToken(".", root, { bareDirectories: false })).toBeNull();
    // Explicit paths keep resolving: a separator marks intent.
    expect(probeAnnotateToken("docs/", root, { bareDirectories: false })).toBe(join(root, "docs"));
    // Default (sole-argument semantics) is unchanged.
    expect(probeAnnotateToken("docs", root)).toBe(join(root, "docs"));
  });
});

describe("annotateInputNamesExistingTarget", () => {
  test("true for anything the pipeline reaches a verdict on", () => {
    expect(annotateInputNamesExistingTarget("plan.md", root)).toBe(true);
    expect(annotateInputNamesExistingTarget("docs", root)).toBe(true);
    expect(annotateInputNamesExistingTarget("https://example.com", root)).toBe(true);
    // Exists but unsupported: pipeline owns its specific error.
    expect(annotateInputNamesExistingTarget("script.py", root)).toBe(true);
  });

  test("false for natural language and empty input", () => {
    expect(annotateInputNamesExistingTarget("the aim doc", root)).toBe(false);
    expect(annotateInputNamesExistingTarget("", root)).toBe(false);
    expect(annotateInputNamesExistingTarget("   ", root)).toBe(false);
  });

  test("the whole un-split string wins over its own tokens", () => {
    // "Meeting Notes.md" names a real file whose second token ("Notes.md")
    // also resolves on its own; the pre-pass must prefer the whole string so
    // OpenCode/Pi keep supporting unquoted paths with spaces.
    expect(probeAnnotateToken("Notes.md", root)).not.toBeNull();
    expect(annotateInputNamesExistingTarget("Meeting Notes.md", root)).toBe(true);
    expect(probeAnnotateToken("Meeting Notes.md", root)).toBe(join(root, "Meeting Notes.md"));
  });
});

describe("selectAnnotateTokenTarget", () => {
  test("fast path: exactly one token resolves, trailing words ignored", () => {
    const selection = selectAnnotateTokenTarget("docs/spec.md please", probe);
    expect(selection.kind).toBe("single");
    if (selection.kind === "single") {
      expect(selection.candidate.token).toBe("docs/spec.md");
      expect(selection.candidate.value).toBe(join(root, "docs/spec.md"));
    }
  });

  test("fast path: a wrapped URL among natural language is the candidate", () => {
    const selection = selectAnnotateTokenTarget(
      "@https://example.com/page and summarize it",
      probe,
    );
    expect(selection.kind).toBe("single");
    if (selection.kind === "single") {
      expect(selection.candidate.value).toBe("https://example.com/page");
    }
  });

  test("fast path works with leading natural language", () => {
    const selection = selectAnnotateTokenTarget("annotate the plan.md for me", probe);
    expect(selection.kind).toBe("single");
    if (selection.kind === "single") {
      expect(selection.candidate.value).toBe(join(root, "plan.md"));
    }
  });

  test("two resolving tokens report ambiguity naming both candidates", () => {
    const selection = selectAnnotateTokenTarget("plan.md docs/spec.md", probe);
    expect(selection.kind).toBe("multiple");
    if (selection.kind === "multiple") {
      expect(selection.candidates.map((c) => c.token)).toEqual([
        "plan.md",
        "docs/spec.md",
      ]);
    }
  });

  test("duplicate tokens are probed once and stay a single candidate", () => {
    const selection = selectAnnotateTokenTarget("plan.md plan.md", probe);
    expect(selection.kind).toBe("single");
  });

  test("unrecognized dash tokens disable tolerance instead of being skipped", () => {
    // Known flags are stripped before selection, so any dash token here is a
    // typo'd flag; skipping it would change behavior (e.g. --no-jna
    // silently fetching via Jina).
    const typoFlag = selectAnnotateTokenTarget("the aim doc --markdwn", probe);
    expect(typoFlag.kind).toBe("flagged");
    if (typoFlag.kind === "flagged") {
      expect(typoFlag.flagTokens).toEqual(["--markdwn"]);
    }

    const noJinaTypo = selectAnnotateTokenTarget("--no-jna https://example.com/doc", probe);
    expect(noJinaTypo.kind).toBe("flagged");
    if (noJinaTypo.kind === "flagged") {
      expect(noJinaTypo.flagTokens).toEqual(["--no-jna"]);
    }
  });

  test("pre-split argv tokens keep quoted arguments whole", () => {
    // "my notes.md" arrived as ONE argv token; it must be probed as one
    // token, never re-split so that "notes.md" silently resolves.
    const selection = selectAnnotateTokenTarget(["my notes.md", "runme"], probe);
    expect(selection.kind).toBe("none");
    if (selection.kind === "none") {
      expect(selection.words).toEqual(["my notes.md", "runme"]);
    }
  });

  test("nothing resolves reports the words tried", () => {
    const selection = selectAnnotateTokenTarget("and give me the URL for it", probe);
    expect(selection.kind).toBe("none");
    if (selection.kind === "none") {
      expect(selection.words).toContain("give");
      expect(selection.words).not.toContain("and give");
    }
  });
});

describe("message builders", () => {
  test("ambiguity message names every candidate and its resolution", () => {
    const message = buildAmbiguousAnnotateArgsMessage([
      { token: "a.md", value: "/repo/a.md" },
      { token: "b.md", value: "/repo/b.md" },
    ]);
    expect(message).toContain("a.md -> /repo/a.md");
    expect(message).toContain("b.md -> /repo/b.md");
    expect(message).toContain("exactly one target");
  });

  test("unresolved message echoes the words and usage", () => {
    const message = buildUnresolvedAnnotateArgsMessage({
      words: ["the", "aim", "doc"],
    });
    expect(message).toContain("the aim doc");
    expect(message).toContain("plannotator annotate <file.md | file.txt | file.html | https://... | folder/>");
    expect(message).not.toContain("If you are an agent");
  });

  test("agent handoff adds the re-run instruction and preserves flags", () => {
    const message = buildUnresolvedAnnotateArgsMessage({
      words: ["the", "aim", "doc"],
      flags: ["--markdown", "--no-jina"],
      agentHandoff: true,
    });
    expect(message).toContain("If you are an agent reading this");
    expect(message).toContain("plannotator annotate <path-or-url> --markdown --no-jina");
  });
});

// The bundle rule (0.29): several arguments that are ALL existing files named
// by their paths open as one review. The failure these guard: prose, a URL,
// a folder or a searched name turning into a bundle (opening something the
// user did not name), or several real paths still answered with the
// ambiguity error.
describe("bundle rule", () => {
  const select = (input: string | string[]) =>
    selectAnnotateTokenTarget(input, (token) => probeAnnotateToken(token, root, { bareDirectories: false }), {
      bundlePath: (token) => probeAnnotateBundlePath(token, root),
      pathExists: (token) => annotatePathExists(token, root),
    });

  test("several existing paths open as a bundle, in the typed order", () => {
    const selection = select(["notes.md", "docs/page.html", "plan.md"]);
    expect(selection.kind).toBe("bundle");
    if (selection.kind !== "bundle") return;
    expect(selection.files.map((file) => file.value)).toEqual([
      join(root, "notes.md"),
      join(root, "docs/page.html"),
      join(root, "plan.md"),
    ]);
  });

  test("absolute and @ paths count; duplicates of one file are dropped", () => {
    const selection = select([join(root, "plan.md"), "@notes.md", "./plan.md", "notes.md"]);
    expect(selection.kind).toBe("bundle");
    if (selection.kind !== "bundle") return;
    expect(selection.files.map((file) => file.value)).toEqual([join(root, "plan.md"), join(root, "notes.md")]);
  });

  test("the same file twice is one file, not a bundle", () => {
    const selection = select(["plan.md", "./plan.md"]);
    expect(selection.kind).toBe("single");
    if (selection.kind === "single") expect(selection.candidate.value).toBe(join(root, "plan.md"));
  });

  test("prose plus one file keeps the single-target fast path", () => {
    const selection = select("look at notes.md please");
    expect(selection.kind).toBe("single");
    if (selection.kind === "single") expect(selection.candidate.value).toBe(join(root, "notes.md"));
  });

  test("prose plus two files keeps the ambiguity error", () => {
    expect(select("compare notes.md and plan.md").kind).toBe("multiple");
  });

  test("a URL, a folder, or a name found only by search among the paths is the ambiguity error", () => {
    expect(select(["notes.md", "https://example.com/page"]).kind).toBe("multiple");
    expect(select(["notes.md", "docs/"]).kind).toBe("multiple");
    // nested.md exists only as notes/deep/nested.md: found by search, a guess.
    expect(select(["plan.md", "nested.md"]).kind).toBe("multiple");
  });

  // The failure: `annotate a.md typo.md` opened only a.md (the tolerant
  // fast path), and the host said "Opened 2 files".
  test("a list of file paths with a missing one fails naming it, never narrows", () => {
    expect(select(["notes.md", "typo.md"])).toEqual({ kind: "missing", missing: ["typo.md"] });
    expect(select(["nope/a.md", "plan.md", "~/nope-b.md"])).toEqual({ kind: "missing", missing: ["nope/a.md", "~/nope-b.md"] });
    // Prose around a path is still the fast path, a folder still the
    // ambiguity error, and a searched name is not "missing".
    expect(select("look at notes.md please").kind).toBe("single");
    expect(select(["notes.md", "docs/"]).kind).toBe("multiple");
    expect(select(["plan.md", "nested.md"]).kind).toBe("multiple");
  });

  // The failure (#1718 re-review): `annotate . a.md` said "File not found: ."
  // for a directory that exists. An existing path is never missing: a stray
  // `.` / `..` keeps the #1182 fast path, an existing folder the ambiguity.
  test("an existing directory among file paths is never reported missing", () => {
    for (const input of [[".", "notes.md"], ["notes.md", ".."], ["docs", "notes.md"]]) {
      const selection = select(input);
      expect(selection.kind).not.toBe("missing");
    }
    const dot = select([".", "notes.md"]);
    expect(dot.kind === "single" && dot.candidate.value).toBe(join(root, "notes.md"));
    const parent = select(["notes.md", ".."]);
    expect(parent.kind === "single" && parent.candidate.value).toBe(join(root, "notes.md"));
    expect(select(["docs/", "notes.md"]).kind).toBe("multiple");
    // With a real typo beside the directory, only the typo is named.
    expect(select([".", "notes.md", "typo.md"])).toEqual({ kind: "missing", missing: ["typo.md"] });
  });

  test("an existing unsupported file still makes a bundle, so it fails naming itself", () => {
    const selection = select(["plan.md", "script.py"]);
    expect(selection.kind).toBe("bundle");
    if (selection.kind !== "bundle") return;
    const resolved = resolveAnnotateBundleFiles(selection.files.map((file) => file.value));
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.message).toContain(join(root, "script.py"));
  });

  test("without a bundle probe the #1182 tiers are unchanged", () => {
    const selection = selectAnnotateTokenTarget(["notes.md", "plan.md"], (token) =>
      probeAnnotateToken(token, root, { bareDirectories: false }),
    );
    expect(selection.kind).toBe("multiple");
  });

  test("dash tokens still disable tolerance before the bundle rule", () => {
    expect(select(["notes.md", "plan.md", "--bogus"]).kind).toBe("flagged");
  });

  test("the probe names files by path only", () => {
    expect(probeAnnotateBundlePath("plan.md", root)).toBe(join(root, "plan.md"));
    expect(probeAnnotateBundlePath("nested.md", root)).toBeNull();
    expect(probeAnnotateBundlePath("docs", root)).toBeNull();
    expect(probeAnnotateBundlePath("https://example.com/a.md", root)).toBeNull();
    expect(probeAnnotateBundlePath("@scope/README.md", root)).toBe(join(root, "@scope/README.md"));
  });
});

describe("resolveAnnotateBundleFiles", () => {
  test("names each file's render mode in order; --markdown converts HTML", () => {
    const paths = [join(root, "docs/page.html"), join(root, "plan.md"), join(root, "config.yaml")];
    expect(resolveAnnotateBundleFiles(paths)).toEqual({
      ok: true,
      files: [
        { path: paths[0], renderAs: "html" },
        { path: paths[1], renderAs: "markdown" },
        { path: paths[2], renderAs: "markdown" },
      ],
    });
    const converted = resolveAnnotateBundleFiles(paths, { convertHtml: true });
    expect(converted.ok && converted.files[0]?.renderAs).toBe("markdown");
  });

  test("diagram sources render through the diagram engine", () => {
    const mmd = join(root, "flow.mmd");
    writeFileSync(mmd, "graph TD; A-->B");
    const resolved = resolveAnnotateBundleFiles([mmd, join(root, "plan.md")]);
    expect(resolved.ok && resolved.files[0]?.renderAs).toBe("mermaid");
  });

  test("a .env file is named as refused, not as an unknown type", () => {
    const env = join(root, ".env");
    writeFileSync(env, "SECRET=1");
    const resolved = resolveAnnotateBundleFiles([join(root, "plan.md"), env]);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.message).toContain(`File refused: ${env}`);
      expect(resolved.message).not.toContain("no extension");
    }
  });

  test("a file over the annotate cap fails naming it", () => {
    const big = join(root, "big.md");
    writeFileSync(big, "x".repeat(2 * 1024 * 1024 + 1));
    const resolved = resolveAnnotateBundleFiles([join(root, "plan.md"), big]);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.message).toContain(big);
  });

  test("the ambiguity error gains the bundle hint only when asked", () => {
    const candidates = [{ token: "a.md", value: "/r/a.md" }, { token: "https://x", value: "https://x" }];
    expect(buildAmbiguousAnnotateArgsMessage(candidates)).not.toContain(ANNOTATE_BUNDLE_HINT);
    expect(buildAmbiguousAnnotateArgsMessage(candidates, { bundleHint: true })).toContain(ANNOTATE_BUNDLE_HINT);
  });

  test("the tool contract's copy of the hint matches, so hosts can tell an older CLI apart", () => {
    expect(PLANNOTATOR_BUNDLE_HINT_LINE).toBe(ANNOTATE_BUNDLE_HINT);
  });
});
