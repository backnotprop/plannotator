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

function createTempProject(): string {
  const tempDir = mkdtempSync(join(tmpdir(), "plannotator-resolve-file-"));
  tempDirs.push(tempDir);
  return tempDir;
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

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

describe("resolveMarkdownFile", () => {
  test("resolves relative paths that use Windows separators", async () => {
    const projectRoot = createTempProject();
    const docsDir = join(projectRoot, "docs");
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(docsDir, "test-plan.md"), "# Test plan\n");

    const result = await resolveMarkdownFile("docs\\test-plan.md", projectRoot);

    expect(result).toEqual({
      kind: "found",
      path: resolve(projectRoot, "docs/test-plan.md"),
    });
  });

  test("finds bare filenames case-insensitively", async () => {
    const projectRoot = createTempProject();
    mkdirSync(join(projectRoot, "notes"), { recursive: true });
    writeFileSync(join(projectRoot, "notes", "Architecture.MD"), "# Architecture\n");

    const result = await resolveMarkdownFile("architecture.md", projectRoot);

    expect(result).toEqual({
      kind: "found",
      path: resolve(projectRoot, "notes/Architecture.MD"),
    });
  });

  test("finds relative paths case-insensitively", async () => {
    const projectRoot = createTempProject();
    mkdirSync(join(projectRoot, "Docs", "Specs"), { recursive: true });
    writeFileSync(join(projectRoot, "Docs", "Specs", "Design.MDX"), "# Design\n");

    const result = await resolveMarkdownFile("docs/specs/design.mdx", projectRoot);

    expect(result.kind).toBe("found");
    if (result.kind !== "found") {
      throw new Error("Expected markdown file to resolve");
    }

    expect(await Bun.file(result.path).text()).toBe("# Design\n");
  });
});
