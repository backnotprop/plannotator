import { describe, expect, test } from "bun:test";
import {
	annotateDiagramRenderKind,
	ANNOTATABLE_EXTENSIONS_HINT,
	diagramRenderKindForPath,
	isAnnotatableDocPath,
	isAnnotatableTextPath,
	isDiagramRenderKind,
	normalizeMarkdownExtensions,
	shouldStripFrontmatter,
} from "./annotatable";

describe("diagramRenderKindForPath", () => {
	test("maps the four diagram extensions onto their engine", () => {
		expect(diagramRenderKindForPath("flow.mmd")).toBe("mermaid");
		expect(diagramRenderKindForPath("flow.mermaid")).toBe("mermaid");
		expect(diagramRenderKindForPath("/abs/graph.dot")).toBe("graphviz");
		expect(diagramRenderKindForPath("graph.GV")).toBe("graphviz");
	});

	test("is not fooled by a lookalike name or another text extension", () => {
		expect(diagramRenderKindForPath("notes.md")).toBeNull();
		expect(diagramRenderKindForPath("deploy.yaml")).toBeNull();
		// .mmd must match the extension, not an infix.
		expect(diagramRenderKindForPath("flow.mmd.bak")).toBeNull();
		expect(diagramRenderKindForPath("dotfiles")).toBeNull();
		expect(diagramRenderKindForPath(".env")).toBeNull();
	});

	test("isDiagramRenderKind guards untrusted values", () => {
		expect(isDiagramRenderKind("mermaid")).toBe(true);
		expect(isDiagramRenderKind("graphviz")).toBe(true);
		expect(isDiagramRenderKind("html")).toBe(false);
		expect(isDiagramRenderKind(undefined)).toBe(false);
	});
});

describe("annotatable sets", () => {
	test("diagram sources are annotatable as text (resolution, size cap, history)", () => {
		for (const path of ["flow.mmd", "flow.mermaid", "graph.dot", "graph.gv"]) {
			expect(isAnnotatableTextPath(path)).toBe(true);
			expect(isAnnotatableDocPath(path)).toBe(true);
		}
	});

	test("the error hint names them so an unsupported-type message stays truthful", () => {
		for (const ext of [".mmd", ".mermaid", ".dot", ".gv"]) {
			expect(ANNOTATABLE_EXTENSIONS_HINT).toContain(ext);
		}
	});

	test("they cannot be re-registered as extra markdown extensions", () => {
		expect(normalizeMarkdownExtensions([".mmd", ".dot"])).toEqual([]);
	});
});

describe("shouldStripFrontmatter", () => {
	test("never strips a diagram source — Mermaid's --- config block is content", () => {
		expect(shouldStripFrontmatter("flow.mmd")).toBe(false);
		expect(shouldStripFrontmatter("flow.mermaid")).toBe(false);
		expect(shouldStripFrontmatter("graph.dot")).toBe(false);
		// The markdown branch is unchanged.
		expect(shouldStripFrontmatter("notes.md")).toBe(true);
	});
});

describe("annotateDiagramRenderKind", () => {
	test("a plain local diagram file renders as a diagram", () => {
		expect(annotateDiagramRenderKind({ filePath: "/p/flow.mmd" })).toBe("mermaid");
		expect(annotateDiagramRenderKind({ filePath: "/p/g.dot", mode: "annotate" })).toBe("graphviz");
	});

	test("raw HTML, converted sources, URLs and non-annotate modes keep their rendering", () => {
		expect(annotateDiagramRenderKind({ filePath: "/p/flow.mmd", renderHtml: true })).toBeNull();
		expect(annotateDiagramRenderKind({ filePath: "/p/flow.mmd", sourceConverted: true })).toBeNull();
		expect(annotateDiagramRenderKind({ filePath: "https://example.com/a/graph.dot" })).toBeNull();
		expect(annotateDiagramRenderKind({ filePath: "/p/flow.mmd", mode: "annotate-folder" })).toBeNull();
		expect(annotateDiagramRenderKind({ filePath: "/p/flow.mmd", mode: "annotate-last" })).toBeNull();
		expect(annotateDiagramRenderKind({ filePath: "/p/flow.mmd", mode: "annotate-app" })).toBeNull();
	});
});
