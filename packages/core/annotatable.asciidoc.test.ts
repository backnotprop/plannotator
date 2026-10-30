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

describe("AsciiDoc in the annotatable seam", () => {
	test("both extensions are annotatable text with the asciidoc render kind", () => {
		for (const path of ["guide.adoc", "/abs/Legacy.ASCIIDOC"]) {
			expect(isAnnotatableTextPath(path)).toBe(true);
			expect(documentRenderKindForPath(path)).toBe("asciidoc");
		}
		expect(documentRenderKindForPath("guide.adoc.bak")).toBeNull();
		expect(documentRenderKindForPath("notes.md")).toBeNull();
		expect(documentRenderKindForPath("flow.mmd")).toBe("mermaid");
	});

	test("isDocumentRenderKind accepts diagram kinds and asciidoc only", () => {
		expect(isDocumentRenderKind("asciidoc")).toBe(true);
		expect(isDocumentRenderKind("graphviz")).toBe(true);
		expect(isDocumentRenderKind("markdown")).toBe(false);
		expect(isDocumentRenderKind("html")).toBe(false);
	});

	test("an AsciiDoc session needs a local file opened as itself", () => {
		expect(annotateDocumentRenderKind({ filePath: "/docs/guide.adoc" })).toBe("asciidoc");
		expect(annotateDocumentRenderKind({ filePath: "https://x.dev/guide.adoc" })).toBeNull();
		expect(annotateDocumentRenderKind({ filePath: "/docs/guide.adoc", sourceConverted: true })).toBeNull();
		expect(annotateDocumentRenderKind({ filePath: "/docs", mode: "annotate-folder" })).toBeNull();
		// The diagram-only predicate is unchanged for AsciiDoc.
		expect(annotateDiagramRenderKind({ filePath: "/docs/guide.adoc" })).toBeNull();
	});

	test("AsciiDoc is never markdown: no frontmatter strip, not re-registrable", () => {
		expect(shouldStripFrontmatter("guide.adoc")).toBe(false);
		expect(normalizeMarkdownExtensions([".adoc", ".asciidoc"])).toEqual([]);
	});
});
