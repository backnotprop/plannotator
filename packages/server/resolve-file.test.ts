/**
 * File Resolution Tests
 *
 * Run: bun test packages/server/resolve-file.test.ts
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	expandHomePath,
	isAbsoluteUserPath,
	normalizeUserPathInput,
	resolveMarkdownFile,
	resolveUserPath,
} from "@plannotator/shared/resolve-file";

const tempDirs: string[] = [];

function createTempProject(
  files: Record<string, string> = {},
  baseDir = join(tmpdir(), "plannotator-resolve-file-"),
): string {
  const root = mkdtempSync(baseDir);
  tempDirs.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    const full = join(root, relativePath);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- User path normalization ---

describe("normalizeUserPathInput", () => {
	test("expands tilde paths before normalization", () => {
		expect(normalizeUserPathInput("~/test-plan.md")).toBe(
			join(homedir(), "test-plan.md"),
		);
	});

	test("strips wrapping quotes", () => {
		expect(normalizeUserPathInput('"~/test-plan.md"')).toBe(
			join(homedir(), "test-plan.md"),
		);
	});

  test("converts MSYS paths on Windows", () => {
    expect(normalizeUserPathInput("/c/Users/dev/test-plan.md", "win32")).toBe(
      "C:/Users/dev/test-plan.md",
    );
  });

  test("converts Cygwin paths on Windows", () => {
    expect(normalizeUserPathInput("/cygdrive/c/Users/dev/test-plan.md", "win32")).toBe(
      "C:/Users/dev/test-plan.md",
    );
  });

  test("leaves non-Windows paths unchanged", () => {
    expect(normalizeUserPathInput("/Users/dev/test-plan.md", "darwin")).toBe(
      "/Users/dev/test-plan.md",
    );
  });
});

describe("expandHomePath", () => {
	test("expands bare home alias", () => {
		expect(expandHomePath("~", "/tmp/home")).toBe("/tmp/home");
	});

	test("expands home-relative paths", () => {
		expect(expandHomePath("~/docs/plan.md", "/tmp/home")).toBe(
			join("/tmp/home", "docs/plan.md"),
		);
	});

	test("does not expand tilde usernames", () => {
		expect(expandHomePath("~alice/docs/plan.md", "/tmp/home")).toBe(
			"~alice/docs/plan.md",
		);
	});
});

describe("isAbsoluteUserPath", () => {
  test("detects Windows drive letter paths", () => {
    expect(isAbsoluteUserPath("C:\\Users\\dev\\test-plan.md", "win32")).toBe(true);
    expect(isAbsoluteUserPath("C:/Users/dev/test-plan.md", "win32")).toBe(true);
  });

  test("detects converted MSYS paths as absolute on Windows", () => {
    expect(isAbsoluteUserPath("/c/Users/dev/test-plan.md", "win32")).toBe(true);
  });
});

describe("resolveUserPath", () => {
	test("resolves relative paths against a base directory", () => {
		expect(resolveUserPath("docs/plan.md", "/tmp/project")).toBe(
			resolve("/tmp/project", "docs/plan.md"),
		);
	});

	test("resolves quoted tilde paths", () => {
		expect(resolveUserPath('"~/docs/plan.md"')).toBe(
			resolve(homedir(), "docs/plan.md"),
		);
	});

	test("returns empty string for whitespace-only input", () => {
		expect(resolveUserPath("   ", "/tmp/project")).toBe("");
		expect(resolveUserPath("", "/tmp/project")).toBe("");
	});
});

// --- Core resolution strategies ---

describe("resolveMarkdownFile", () => {
  // Strategy 1: Absolute paths

  test("resolves absolute path to existing file", async () => {
    const root = createTempProject({ "plan.md": "# Plan" });
    const absPath = resolve(root, "plan.md");
    const result = resolveMarkdownFile(absPath, root);
    expect(result).toEqual({ kind: "found", path: absPath });
  });

	test("resolves tilde-prefixed absolute paths", async () => {
		const homeRoot = createTempProject({}, join(homedir(), ".plannotator-resolve-file-"));
		const absPath = resolve(homeRoot, "plan.md");
		writeFileSync(absPath, "# Plan");
		const relativeToHome = absPath.slice(homedir().length + 1).replace(/\\/g, "/");
		const result = resolveMarkdownFile(`~/${relativeToHome}`, "/unused");
		expect(result).toEqual({ kind: "found", path: absPath });
	});

  test("returns not_found for absolute path that doesn't exist", async () => {
    const root = createTempProject();
    const result = resolveMarkdownFile("/nonexistent/path.md", root);
    expect(result.kind).toBe("not_found");
  });

  // Strategy 2: Exact relative paths

  test("resolves exact relative path", async () => {
    const root = createTempProject({ "docs/guide.md": "# Guide" });
    const result = resolveMarkdownFile("docs/guide.md", root);
    expect(result).toEqual({
      kind: "found",
      path: resolve(root, "docs/guide.md"),
    });
  });

  test("resolves bare filename in root", async () => {
    const root = createTempProject({ "README.md": "# Hello" });
    const result = resolveMarkdownFile("README.md", root);
    expect(result).toEqual({
      kind: "found",
      path: resolve(root, "README.md"),
    });
  });

  test("resolves @ filename via fallback when @ file does not exist", async () => {
    const root = createTempProject({ "README.md": "# Hello" });
    const result = resolveMarkdownFile("@README.md", root);
    expect(result).toEqual({
      kind: "found",
      path: resolve(root, "README.md"),
    });
  });

  test("prioritizes real @ filename before fallback", async () => {
    const root = createTempProject({ "@README.md": "# At" });
    const result = resolveMarkdownFile("@README.md", root);
    expect(result).toEqual({
      kind: "found",
      path: resolve(root, "@README.md"),
    });
  });

  test("resolves quoted @ filename", async () => {
    const root = createTempProject({ "README.md": "# Hello" });
    const result = resolveMarkdownFile('"@README.md"', root);
    expect(result).toEqual({
      kind: "found",
      path: resolve(root, "README.md"),
    });
  });

  test("resolves relative paths with Windows separators", async () => {
    const root = createTempProject({ "docs/test-plan.md": "# Test plan\n" });
    const result = resolveMarkdownFile("docs\\test-plan.md", root);
    expect(result).toEqual({
      kind: "found",
      path: resolve(root, "docs/test-plan.md"),
    });
  });

  // Strategy 3: Case-insensitive search

  test("finds bare filenames case-insensitively", async () => {
    const root = createTempProject({ "notes/Architecture.MD": "# Architecture\n" });
    const result = resolveMarkdownFile("architecture.md", root);
    expect(result).toEqual({
      kind: "found",
      path: resolve(root, "notes/Architecture.MD"),
    });
  });

  test("finds relative paths case-insensitively", async () => {
    const root = createTempProject({ "Docs/Specs/Design.MDX": "# Design\n" });
    const result = resolveMarkdownFile("docs/specs/design.mdx", root);
    expect(result.kind).toBe("found");
    if (result.kind === "found") {
      expect(await Bun.file(result.path).text()).toBe("# Design\n");
    }
  });

  test("returns ambiguous when bare filename matches multiple files", async () => {
    const root = createTempProject({
      "docs/plan.md": "# Plan 1",
      "api/plan.md": "# Plan 2",
    });
    const result = resolveMarkdownFile("plan.md", root);
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(result.matches).toHaveLength(2);
    }
  });

  test("returns ambiguous in @ fallback when target exists multiple times", async () => {
    const root = createTempProject({
      "docs/plan.md": "# Plan 1",
      "api/plan.md": "# Plan 2",
    });
    const result = resolveMarkdownFile("@plan.md", root);
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(result.input).toBe("@plan.md");
      expect(result.matches).toHaveLength(2);
    }
  });

  // Ignored directories

  test("skips node_modules", async () => {
    const root = createTempProject({
      "node_modules/pkg/README.md": "# Pkg",
    });
    const result = resolveMarkdownFile("readme.md", root);
    expect(result.kind).toBe("not_found");
  });

  test("skips .git directory", async () => {
    const root = createTempProject({
      ".git/hooks/pre-commit.md": "# hook",
    });
    const result = resolveMarkdownFile("pre-commit.md", root);
    expect(result.kind).toBe("not_found");
  });

  // Extension filtering

  test("rejects non-markdown files", async () => {
    const root = createTempProject({ "script.ts": "export {}" });
    const result = resolveMarkdownFile("script.ts", root);
    expect(result.kind).toBe("not_found");
  });

  test("accepts .mdx files", async () => {
    const root = createTempProject({ "page.mdx": "# Page" });
    const result = resolveMarkdownFile("page.mdx", root);
    expect(result).toEqual({
      kind: "found",
      path: resolve(root, "page.mdx"),
    });
  });

  // Edge cases

  test("returns not_found for nonexistent file", async () => {
    const root = createTempProject();
    const result = resolveMarkdownFile("nope.md", root);
    expect(result.kind).toBe("not_found");
  });

  test("returns not_found for @ path that cannot be resolved", async () => {
    const root = createTempProject();
    const result = resolveMarkdownFile("@nope.md", root);
    expect(result).toEqual({ kind: "not_found", input: "@nope.md" });
  });

  test("handles deeply nested files", async () => {
    const root = createTempProject({
      "a/b/c/d/deep.md": "# Deep",
    });
    const result = resolveMarkdownFile("deep.md", root);
    expect(result).toEqual({
      kind: "found",
      path: resolve(root, "a/b/c/d/deep.md"),
    });
  });
});
