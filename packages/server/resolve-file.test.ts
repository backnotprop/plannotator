/**
 * File Resolution Tests
 *
 * Run: bun test packages/server/resolve-file.test.ts
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  isAbsoluteMarkdownPath,
  normalizeMarkdownPathInput,
  resolveMarkdownFile,
} from "./resolve-file";

const tempDirs: string[] = [];

function createTempProject(
  files: Record<string, string> = {},
): string {
  const root = mkdtempSync(join(tmpdir(), "plannotator-resolve-file-"));
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

// --- Windows path normalization (PR #267) ---

describe("normalizeMarkdownPathInput", () => {
  test("converts MSYS paths on Windows", () => {
    expect(normalizeMarkdownPathInput("/c/Users/dev/test-plan.md", "win32")).toBe(
      "C:/Users/dev/test-plan.md",
    );
  });

  test("converts Cygwin paths on Windows", () => {
    expect(normalizeMarkdownPathInput("/cygdrive/c/Users/dev/test-plan.md", "win32")).toBe(
      "C:/Users/dev/test-plan.md",
    );
  });

  test("leaves non-Windows paths unchanged", () => {
    expect(normalizeMarkdownPathInput("/Users/dev/test-plan.md", "darwin")).toBe(
      "/Users/dev/test-plan.md",
    );
  });
});

describe("isAbsoluteMarkdownPath", () => {
  test("detects Windows drive letter paths", () => {
    expect(isAbsoluteMarkdownPath("C:\\Users\\dev\\test-plan.md", "win32")).toBe(true);
    expect(isAbsoluteMarkdownPath("C:/Users/dev/test-plan.md", "win32")).toBe(true);
  });

  test("detects converted MSYS paths as absolute on Windows", () => {
    expect(isAbsoluteMarkdownPath("/c/Users/dev/test-plan.md", "win32")).toBe(true);
  });
});

// --- Core resolution strategies ---

describe("resolveMarkdownFile", () => {
  // Strategy 1: Absolute paths

  test("resolves absolute path to existing file", async () => {
    const root = createTempProject({ "plan.md": "# Plan" });
    const absPath = resolve(root, "plan.md");
    const result = await resolveMarkdownFile(absPath, root);
    expect(result).toEqual({ kind: "found", path: absPath });
  });

  test("returns not_found for absolute path that doesn't exist", async () => {
    const root = createTempProject();
    const result = await resolveMarkdownFile("/nonexistent/path.md", root);
    expect(result.kind).toBe("not_found");
  });

  // Strategy 2: Exact relative paths

  test("resolves exact relative path", async () => {
    const root = createTempProject({ "docs/guide.md": "# Guide" });
    const result = await resolveMarkdownFile("docs/guide.md", root);
    expect(result).toEqual({
      kind: "found",
      path: resolve(root, "docs/guide.md"),
    });
  });

  test("resolves bare filename in root", async () => {
    const root = createTempProject({ "README.md": "# Hello" });
    const result = await resolveMarkdownFile("README.md", root);
    expect(result).toEqual({
      kind: "found",
      path: resolve(root, "README.md"),
    });
  });

  test("resolves relative paths with Windows separators", async () => {
    const root = createTempProject({ "docs/test-plan.md": "# Test plan\n" });
    const result = await resolveMarkdownFile("docs\\test-plan.md", root);
    expect(result).toEqual({
      kind: "found",
      path: resolve(root, "docs/test-plan.md"),
    });
  });

  // Strategy 3: Case-insensitive search

  test("finds bare filenames case-insensitively", async () => {
    const root = createTempProject({ "notes/Architecture.MD": "# Architecture\n" });
    const result = await resolveMarkdownFile("architecture.md", root);
    expect(result).toEqual({
      kind: "found",
      path: resolve(root, "notes/Architecture.MD"),
    });
  });

  test("finds relative paths case-insensitively", async () => {
    const root = createTempProject({ "Docs/Specs/Design.MDX": "# Design\n" });
    const result = await resolveMarkdownFile("docs/specs/design.mdx", root);
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
    const result = await resolveMarkdownFile("plan.md", root);
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(result.matches).toHaveLength(2);
    }
  });

  // Ignored directories

  test("skips node_modules", async () => {
    const root = createTempProject({
      "node_modules/pkg/README.md": "# Pkg",
    });
    const result = await resolveMarkdownFile("readme.md", root);
    expect(result.kind).toBe("not_found");
  });

  test("skips .git directory", async () => {
    const root = createTempProject({
      ".git/hooks/pre-commit.md": "# hook",
    });
    const result = await resolveMarkdownFile("pre-commit.md", root);
    expect(result.kind).toBe("not_found");
  });

  // Extension filtering

  test("rejects non-markdown files", async () => {
    const root = createTempProject({ "script.ts": "export {}" });
    const result = await resolveMarkdownFile("script.ts", root);
    expect(result.kind).toBe("not_found");
  });

  test("accepts .mdx files", async () => {
    const root = createTempProject({ "page.mdx": "# Page" });
    const result = await resolveMarkdownFile("page.mdx", root);
    expect(result).toEqual({
      kind: "found",
      path: resolve(root, "page.mdx"),
    });
  });

  // Edge cases

  test("returns not_found for nonexistent file", async () => {
    const root = createTempProject();
    const result = await resolveMarkdownFile("nope.md", root);
    expect(result.kind).toBe("not_found");
  });

  test("handles deeply nested files", async () => {
    const root = createTempProject({
      "a/b/c/d/deep.md": "# Deep",
    });
    const result = await resolveMarkdownFile("deep.md", root);
    expect(result).toEqual({
      kind: "found",
      path: resolve(root, "a/b/c/d/deep.md"),
    });
  });
});
