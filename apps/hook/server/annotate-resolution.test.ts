import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resolveAnnotateTarget } from "./annotate-resolution";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "plannotator-annotate-resolution-"));
  mkdirSync(join(root, "docs"), { recursive: true });
  mkdirSync(join(root, "notes"), { recursive: true });
  mkdirSync(join(root, "empty"), { recursive: true });
  writeFileSync(join(root, "plan.md"), "# Plan body");
  writeFileSync(join(root, "docs/page.html"), "<p>hi</p>");
  writeFileSync(join(root, "docs/dup.md"), "# A");
  writeFileSync(join(root, "notes/dup.md"), "# B");
  writeFileSync(join(root, "script.py"), "print()");
  writeFileSync(join(root, "big.md"), "x".repeat(2 * 1024 * 1024 + 1));
  mkdirSync(join(root, "notebooks"), { recursive: true });
  writeFileSync(join(root, "notebooks/tour.livemd"), "# Livebook tour");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function resolve(
  rawFilePath: string,
  overrides: { renderMarkdown?: boolean; extraMarkdownExtensions?: readonly string[] } = {},
) {
  return resolveAnnotateTarget({
    rawFilePath,
    projectRoot: root,
    noJina: true,
    renderMarkdown: overrides.renderMarkdown ?? false,
    extraMarkdownExtensions: overrides.extraMarkdownExtensions ?? [],
    log: () => {},
  });
}

describe("resolveAnnotateTarget", () => {
  test("resolves a markdown file and reads its content", async () => {
    const result = await resolve("plan.md");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.absolutePath).toBe(join(root, "plan.md"));
      expect(result.markdown).toBe("# Plan body");
      expect(result.annotateMode).toBe("annotate");
      expect(result.isUrl).toBe(false);
    }
  });

  test("resolves a folder into folder mode", async () => {
    const result = await resolve("docs");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.annotateMode).toBe("annotate-folder");
      expect(result.folderPath).toBe(join(root, "docs"));
    }
  });

  test("resolves an HTML file as raw HTML by default and markdown with --markdown", async () => {
    const raw = await resolve("docs/page.html");
    expect(raw.ok).toBe(true);
    if (raw.ok) {
      expect(raw.rawHtml).toBe("<p>hi</p>");
      expect(raw.markdown).toBe("");
    }
    const converted = await resolve("docs/page.html", { renderMarkdown: true });
    expect(converted.ok).toBe(true);
    if (converted.ok) {
      expect(converted.rawHtml).toBeUndefined();
      expect(converted.sourceConverted).toBe(true);
    }
  });

  // #1307: an extension listed in config.json's `markdownExtensions` must be
  // accepted everywhere .md is — single file, folder discovery, and reading.
  test("a configured extra extension opens as a document and its folder is annotatable", async () => {
    const configured = { extraMarkdownExtensions: [".livemd"] };

    const file = await resolve("notebooks/tour.livemd", configured);
    expect(file.ok).toBe(true);
    if (file.ok) {
      expect(file.absolutePath).toBe(join(root, "notebooks/tour.livemd"));
      expect(file.markdown).toBe("# Livebook tour");
      expect(file.annotateMode).toBe("annotate");
    }

    const folder = await resolve("notebooks", configured);
    expect(folder.ok).toBe(true);
    if (folder.ok) expect(folder.annotateMode).toBe("annotate-folder");
  });

  test("without configuration the same file is an unsupported type and its folder is empty", async () => {
    const file = await resolve("notebooks/tour.livemd");
    expect(file.ok).toBe(false);
    if (!file.ok) {
      expect(file.notFound).toBe(false);
      expect(file.message).toContain("File type not supported: .livemd");
    }

    const folder = await resolve("notebooks");
    expect(folder.ok).toBe(false);
    if (!folder.ok) expect(folder.message).toContain("No annotatable files");
  });

  test("only the missing-target terminal reports notFound", async () => {
    const missing = await resolve("missing.md");
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.notFound).toBe(true);
      expect(missing.message).toBe("File not found: missing.md");
    }

    const word = await resolve("the");
    expect(word.ok).toBe(false);
    if (!word.ok) {
      expect(word.notFound).toBe(true);
    }
  });

  test("target-specific failures keep notFound false and their messages", async () => {
    const ambiguous = await resolve("dup.md");
    expect(ambiguous.ok).toBe(false);
    if (!ambiguous.ok) {
      expect(ambiguous.notFound).toBe(false);
      expect(ambiguous.message).toContain('Ambiguous filename "dup.md"');
      expect(ambiguous.message).toContain("2 matches");
    }

    const unsupported = await resolve("script.py");
    expect(unsupported.ok).toBe(false);
    if (!unsupported.ok) {
      expect(unsupported.notFound).toBe(false);
      expect(unsupported.message).toContain("File type not supported: .py");
    }

    const oversized = await resolve("big.md");
    expect(oversized.ok).toBe(false);
    if (!oversized.ok) {
      expect(oversized.notFound).toBe(false);
      expect(oversized.message).toContain("File too large to annotate (max 2MB)");
    }

    const emptyFolder = await resolve("empty");
    expect(emptyFolder.ok).toBe(false);
    if (!emptyFolder.ok) {
      expect(emptyFolder.notFound).toBe(false);
      expect(emptyFolder.message).toContain("No annotatable files");
    }
  });
});
