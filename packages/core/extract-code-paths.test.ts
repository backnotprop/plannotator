import { describe, test, expect } from "bun:test";
import { extractCandidateCodePaths } from "./extract-code-paths";

describe("extractCandidateCodePaths", () => {
	test("extracts backtick code-file paths", () => {
		const md = "Open `packages/editor/App.tsx` to see the code.";
		expect(extractCandidateCodePaths(md)).toEqual(["packages/editor/App.tsx"]);
	});

	test("extracts bare-prose paths", () => {
		const md = "see editor/App.tsx and review-editor/App.tsx";
		const out = extractCandidateCodePaths(md);
		expect(out).toContain("editor/App.tsx");
		expect(out).toContain("review-editor/App.tsx");
	});

	test("dedupes repeated references", () => {
		const md = "`src/foo.ts` and src/foo.ts again";
		expect(extractCandidateCodePaths(md)).toEqual(["src/foo.ts"]);
	});

	test("strips line anchors", () => {
		const md = "see `src/foo.ts#L42`";
		expect(extractCandidateCodePaths(md)).toEqual(["src/foo.ts"]);
	});

	test("rejects shell brace expansion", () => {
		const md = "files in packages/ui/{a,b}.ts";
		expect(extractCandidateCodePaths(md)).toEqual([]);
	});

	test("ignores fenced code blocks", () => {
		const md = "```ts\nimport foo from 'src/foo.ts';\n```";
		expect(extractCandidateCodePaths(md)).toEqual([]);
	});

	test("ignores HTML comments", () => {
		const md = "<!-- src/foo.ts is a placeholder -->";
		expect(extractCandidateCodePaths(md)).toEqual([]);
	});

	test("URLs do not produce path-shaped substrings", () => {
		const md = "see https://github.com/foo/bar.ts in the docs";
		expect(extractCandidateCodePaths(md)).toEqual([]);
	});

	test("URL on same line as a real path keeps the path", () => {
		const md = "https://github.com/example.com docs and editor/App.tsx";
		const out = extractCandidateCodePaths(md);
		expect(out).toContain("editor/App.tsx");
	});

	test("URLs containing parens or brackets do not leak path-shaped substrings", () => {
		// Wikipedia-style URL ends in `).ts` — earlier extractor erroneously
		// stopped its URL match at `(`, leaving `bar).ts` as a path candidate.
		const md = "see https://en.wikipedia.org/wiki/Foo_(bar).ts in the docs";
		expect(extractCandidateCodePaths(md)).toEqual([]);
	});

	test("a four-backtick fence ends at its own closing fence, not at an inner ``` line", () => {
		// The renderer (codeFenceCloseIndex) closes this fence at "````", so the
		// prose after it renders and its path must be validated, not demoted.
		const md = "````md\n```ts\n````\n\nSee `src/real.ts`.\n\n```sh\nls\n```\n";
		expect(extractCandidateCodePaths(md)).toEqual(["src/real.ts"]);
	});

	test("an unclosed fence runs to the end of the document, as the renderer shows it", () => {
		const md = "See `src/real.ts`.\n\n```ts\nimport x from \"src/inside.ts\";\n";
		expect(extractCandidateCodePaths(md)).toEqual(["src/real.ts"]);
	});

	test("a ~~~ line is ordinary text, as it is for the renderer", () => {
		const md = "~~~\nSee `src/real.ts`.\n~~~\n";
		expect(extractCandidateCodePaths(md)).toEqual(["src/real.ts"]);
	});
});
