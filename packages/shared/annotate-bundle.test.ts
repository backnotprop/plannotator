import { describe, expect, test } from "bun:test";
import {
	annotateBundleDocumentCounts,
	annotateBundleRelativePath,
	annotateBundleRoot,
	parseAnnotateBundle,
} from "./annotate-bundle";

describe("annotateBundleRoot", () => {
	// The failure: a string-prefix comparison makes /repo/doc the root of
	// /repo/docs/a.md and /repo/doc/b.md, so labels lose a path segment.
	test("is the deepest directory holding every file, compared by segment", () => {
		expect(annotateBundleRoot(["/repo/docs/a.md", "/repo/docs/sub/b.md"])).toBe("/repo/docs");
		expect(annotateBundleRoot(["/repo/docs/a.md", "/repo/doc/b.md"])).toBe("/repo");
		expect(annotateBundleRoot(["/a/x.md", "/b/y.md"])).toBe("/");
		expect(annotateBundleRoot(["C:\\work\\a.md", "C:\\work\\ui\\b.html"])).toBe("C:/work");
	});

	test("labels stay relative to it, and absolute outside it", () => {
		expect(annotateBundleRelativePath("/repo/docs/sub/b.md", "/repo/docs")).toBe("sub/b.md");
		expect(annotateBundleRelativePath("/a/x.md", "")).toBe("a/x.md");
	});
});

describe("parseAnnotateBundle", () => {
	test("accepts two or more distinct files with known render modes, and nothing else", () => {
		const files = [
			{ path: "/r/a.md", renderAs: "markdown" },
			{ path: "/r/b.html", renderAs: "html" },
		];
		expect(parseAnnotateBundle(files)).toEqual(files as never);
		expect(parseAnnotateBundle([files[0]])).toBeNull();
		expect(parseAnnotateBundle([files[0], files[0]])).toBeNull();
		expect(parseAnnotateBundle([files[0], { path: "/r/c.pdf", renderAs: "pdf" }])).toBeNull();
		expect(parseAnnotateBundle("nope")).toBeNull();
	});
});

describe("annotateBundleDocumentCounts", () => {
	test("counts each file's comments in bundle order; bundle-level notes count toward none", () => {
		expect(
			annotateBundleDocumentCounts(["/r/b.md", "/r/a.md"], [
				{ documentPath: "/r/a.md" },
				{ documentPath: "/r/a.md" },
				{ id: "bundle-note" },
				null,
			]),
		).toEqual([
			{ path: "/r/b.md", annotationCount: 0 },
			{ path: "/r/a.md", annotationCount: 2 },
		]);
	});
});
