import { describe, expect, test } from "bun:test";
import {
	annotateDiagramRenderKind,
	annotateDocumentRenderKind,
	documentRenderKindForPath,
	isAnnotatableTextPath,
	isDocumentRenderKind,
	normalizeMarkdownExtensions,
	shouldStripFrontmatter,
} from "./annotatable";
import { fileKind } from "./file-kind";

describe("LaTeX in the annotatable seam", () => {
	test("both extensions are annotatable text with the latex render kind", () => {
		for (const path of ["paper.tex", "/abs/Manuscript.LTX"]) {
			expect(isAnnotatableTextPath(path)).toBe(true);
			expect(documentRenderKindForPath(path)).toBe("latex");
			expect(fileKind(path)).toBe("docs");
		}
		expect(documentRenderKindForPath("paper.tex.bak")).toBeNull();
		expect(documentRenderKindForPath("notes.md")).toBeNull();
		expect(documentRenderKindForPath("guide.adoc")).toBe("asciidoc");
	});

	test("isDocumentRenderKind accepts latex", () => {
		expect(isDocumentRenderKind("latex")).toBe(true);
		expect(isDocumentRenderKind("asciidoc")).toBe(true);
		expect(isDocumentRenderKind("markdown")).toBe(false);
		expect(isDocumentRenderKind("html")).toBe(false);
	});

	test("a LaTeX session needs a local file opened as itself", () => {
		expect(annotateDocumentRenderKind({ filePath: "/papers/main.tex" })).toBe("latex");
		expect(annotateDocumentRenderKind({ filePath: "https://x.dev/main.tex" })).toBeNull();
		expect(annotateDocumentRenderKind({ filePath: "/papers/main.tex", sourceConverted: true })).toBeNull();
		expect(annotateDocumentRenderKind({ filePath: "/papers", mode: "annotate-folder" })).toBeNull();
		expect(annotateDiagramRenderKind({ filePath: "/papers/main.tex" })).toBeNull();
	});

	test("LaTeX is never markdown: no frontmatter strip, not re-registrable", () => {
		expect(shouldStripFrontmatter("paper.tex")).toBe(false);
		expect(shouldStripFrontmatter("chapter.ltx")).toBe(false);
		expect(normalizeMarkdownExtensions([".tex", ".ltx"])).toEqual([]);
	});
});
