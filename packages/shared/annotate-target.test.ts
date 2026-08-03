import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	annotateInputExists,
	annotateTokenResolves,
	formatAmbiguousAnnotateTargetError,
	formatNoAnnotateTargetError,
	isAnnotateTargetCandidate,
	isAnnotateUrlToken,
	resolveAnnotateTargetArg,
	selectAnnotateTarget,
	selectAnnotateTargetFromRaw,
} from "./annotate-target";

// --- Pure selection, with an injected predicate -----------------------------

/** Stand-in for the filesystem: these tokens "resolve", nothing else does. */
function resolvesOneOf(...resolvable: string[]) {
	return (token: string) => resolvable.includes(token);
}

describe("selectAnnotateTarget", () => {
	const cases: Array<{
		name: string;
		tokens: string[];
		resolvable: string[];
		expected: ReturnType<typeof selectAnnotateTarget>;
	}> = [
		{
			name: "one valid path plus trailing prose",
			tokens: ["the", "aim", "doc.md"],
			resolvable: ["doc.md"],
			expected: { kind: "resolved", token: "doc.md" },
		},
		{
			name: "path first, prose after",
			tokens: ["docs/spec.md", "and", "give", "me", "the", "URL", "for", "it"],
			resolvable: ["docs/spec.md"],
			expected: { kind: "resolved", token: "docs/spec.md" },
		},
		{
			name: "URL plus prose",
			tokens: ["https://example.com/page", "and", "summarize", "it"],
			resolvable: ["https://example.com/page"],
			expected: { kind: "resolved", token: "https://example.com/page" },
		},
		{
			name: "folder plus prose",
			tokens: ["review", "docs/"],
			resolvable: ["docs/"],
			expected: { kind: "resolved", token: "docs/" },
		},
		{
			name: "two valid paths is ambiguous — both named, neither guessed",
			tokens: ["spec.md", "and", "notes.md"],
			resolvable: ["spec.md", "notes.md"],
			expected: { kind: "ambiguous", candidates: ["spec.md", "notes.md"] },
		},
		{
			name: "three valid paths are all named",
			tokens: ["a.md", "b.md", "c.md"],
			resolvable: ["a.md", "b.md", "c.md"],
			expected: { kind: "ambiguous", candidates: ["a.md", "b.md", "c.md"] },
		},
		{
			name: "the same path twice is one target, not an ambiguity",
			tokens: ["spec.md", "spec.md"],
			resolvable: ["spec.md"],
			expected: { kind: "resolved", token: "spec.md" },
		},
		{
			name: "zero valid tokens reports everything it tried",
			tokens: ["the", "aim", "doc"],
			resolvable: [],
			expected: { kind: "none", tried: ["the", "aim", "doc"] },
		},
		{
			name: "flag-shaped tokens are never candidates",
			tokens: ["--unknown", "-x", "spec.md"],
			resolvable: ["spec.md"],
			expected: { kind: "resolved", token: "spec.md" },
		},
		{
			name: "flag-shaped tokens stay out of the tried list",
			tokens: ["--unknown", "prose"],
			resolvable: [],
			expected: { kind: "none", tried: ["prose"] },
		},
		{
			name: "empty tokens are dropped",
			tokens: ["", "  ", "spec.md"],
			resolvable: ["spec.md"],
			expected: { kind: "resolved", token: "spec.md" },
		},
	];

	for (const { name, tokens, resolvable, expected } of cases) {
		test(name, () => {
			expect(selectAnnotateTarget(tokens, resolvesOneOf(...resolvable))).toEqual(
				expected,
			);
		});
	}

	test("no tokens at all resolves to nothing tried", () => {
		expect(selectAnnotateTarget([], resolvesOneOf())).toEqual({
			kind: "none",
			tried: [],
		});
	});
});

describe("selectAnnotateTargetFromRaw", () => {
	test("prefers the whole un-split string so paths with spaces still win", () => {
		expect(
			selectAnnotateTargetFromRaw(
				"My Notes.md",
				resolvesOneOf("My Notes.md", "Notes.md"),
			),
		).toEqual({ kind: "resolved", token: "My Notes.md" });
	});

	test("falls back to per-token selection when the whole string misses", () => {
		expect(
			selectAnnotateTargetFromRaw("the aim doc.md", resolvesOneOf("doc.md")),
		).toEqual({ kind: "resolved", token: "doc.md" });
	});

	test("ambiguity is still refused after splitting", () => {
		expect(
			selectAnnotateTargetFromRaw(
				"spec.md and notes.md",
				resolvesOneOf("spec.md", "notes.md"),
			),
		).toEqual({ kind: "ambiguous", candidates: ["spec.md", "notes.md"] });
	});

	test("reports what it tried when nothing resolves", () => {
		expect(
			selectAnnotateTargetFromRaw("the aim doc", resolvesOneOf()),
		).toEqual({ kind: "none", tried: ["the", "aim", "doc"] });
	});
});

describe("token shape helpers", () => {
	test("recognizes URL tokens, `@`-prefixed included", () => {
		expect(isAnnotateUrlToken("https://example.com")).toBe(true);
		expect(isAnnotateUrlToken("HTTP://example.com")).toBe(true);
		expect(isAnnotateUrlToken("@https://example.com")).toBe(true);
		expect(isAnnotateUrlToken("example.com")).toBe(false);
		expect(isAnnotateUrlToken("the")).toBe(false);
	});

	test("excludes flag-shaped and blank tokens from candidacy", () => {
		expect(isAnnotateTargetCandidate("spec.md")).toBe(true);
		expect(isAnnotateTargetCandidate("--gate")).toBe(false);
		expect(isAnnotateTargetCandidate("-x")).toBe(false);
		expect(isAnnotateTargetCandidate("")).toBe(false);
		expect(isAnnotateTargetCandidate("   ")).toBe(false);
	});
});

// --- Error message wording --------------------------------------------------

describe("error messages", () => {
	test("ambiguity names every candidate and refuses to pick", () => {
		expect(
			formatAmbiguousAnnotateTargetError(["spec.md", "notes.md"]),
		).toBe(
			[
				"Ambiguous annotate target — 2 arguments name something annotatable:",
				"  spec.md",
				"  notes.md",
				"Pass exactly one path, URL, or folder.",
			].join("\n"),
		);
	});

	test("no-target names what was tried and states the accepted shapes", () => {
		const message = formatNoAnnotateTargetError(["the", "aim", "doc"]);
		expect(message).toBe(
			[
				"No annotate target found. Tried: the, aim, doc",
				"plannotator annotate accepts a path, URL, or folder — e.g. docs/spec.md, ./docs/, or https://example.com/page.",
			].join("\n"),
		);
		// The shape hint is most of this change's value: today's bare
		// "File not found: and" gave no clue the real problem was the
		// slash command's argument shape.
		expect(message).toContain("path, URL, or folder");
	});
});

// --- Real filesystem resolution --------------------------------------------

describe("annotateTokenResolves", () => {
	let root: string;

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "plannotator-annotate-target-"));
		mkdirSync(join(root, "docs"));
		writeFileSync(join(root, "docs", "spec.md"), "# Spec\n");
		writeFileSync(join(root, "notes.txt"), "notes\n");
		writeFileSync(join(root, "config.yaml"), "a: 1\n");
		writeFileSync(join(root, "page.html"), "<p>hi</p>\n");
		writeFileSync(join(root, "report.pdf"), "not really a pdf\n");
		mkdirSync(join(root, "@scope"));
		writeFileSync(join(root, "@scope", "README.md"), "# scoped\n");
	});

	afterAll(() => {
		rmSync(root, { recursive: true, force: true });
	});

	test("resolves a relative markdown path", () => {
		expect(annotateTokenResolves("docs/spec.md", root)).toBe(true);
	});

	test("resolves a bare filename found inside the project", () => {
		expect(annotateTokenResolves("spec.md", root)).toBe(true);
	});

	test("resolves an absolute path", () => {
		expect(annotateTokenResolves(join(root, "notes.txt"), root)).toBe(true);
	});

	test("resolves the wider plain-text set (.txt, .yaml)", () => {
		expect(annotateTokenResolves("notes.txt", root)).toBe(true);
		expect(annotateTokenResolves("config.yaml", root)).toBe(true);
	});

	test("resolves an HTML file", () => {
		expect(annotateTokenResolves("page.html", root)).toBe(true);
	});

	test("resolves a folder, with or without a trailing slash", () => {
		expect(annotateTokenResolves("docs", root)).toBe(true);
		expect(annotateTokenResolves("docs/", root)).toBe(true);
	});

	test("resolves a URL without touching the filesystem", () => {
		expect(annotateTokenResolves("https://example.com/page", root)).toBe(true);
	});

	test("resolves an `@`-reference and its scoped-package literal form", () => {
		expect(annotateTokenResolves("@docs/spec.md", root)).toBe(true);
		expect(annotateTokenResolves("@scope/README.md", root)).toBe(true);
	});

	test("rejects bare prose", () => {
		for (const word of ["the", "aim", "doc", "and", "give", "me", "URL", "it"]) {
			expect(annotateTokenResolves(word, root)).toBe(false);
		}
	});

	test("rejects a file that exists but isn't annotatable", () => {
		expect(annotateTokenResolves("report.pdf", root)).toBe(false);
	});

	test("rejects a plausible-looking path that doesn't exist", () => {
		expect(annotateTokenResolves("docs/missing.md", root)).toBe(false);
	});

	test("annotateInputExists sees on-disk entries regardless of type", () => {
		expect(annotateInputExists("report.pdf", root)).toBe(true);
		expect(annotateInputExists("docs", root)).toBe(true);
		expect(annotateInputExists("@scope/README.md", root)).toBe(true);
		expect(annotateInputExists("nope", root)).toBe(false);
	});

	test("end-to-end: prose around a real file picks the file", () => {
		const decision = resolveAnnotateTargetArg({
			raw: "the",
			tokens: ["the", "aim", "docs/spec.md"],
			resolves: (token) => annotateTokenResolves(token, root),
			inputExists: (input) => annotateInputExists(input, root),
		});
		expect(decision).toEqual({ kind: "target", token: "docs/spec.md" });
	});
});

// --- The decision, including the strict bypass ------------------------------

describe("resolveAnnotateTargetArg", () => {
	const resolves = resolvesOneOf("spec.md", "notes.md");
	const existsOnDisk = (input: string) =>
		["spec.md", "notes.md", "report.pdf"].includes(input);

	test("passes the single resolving token through", () => {
		expect(
			resolveAnnotateTargetArg({
				raw: "the",
				tokens: ["the", "aim", "spec.md"],
				resolves,
				inputExists: existsOnDisk,
			}),
		).toEqual({ kind: "target", token: "spec.md" });
	});

	test("errors on ambiguity", () => {
		const decision = resolveAnnotateTargetArg({
			raw: "spec.md",
			tokens: ["spec.md", "notes.md"],
			resolves,
			inputExists: existsOnDisk,
		});
		expect(decision.kind).toBe("error");
		if (decision.kind !== "error") throw new Error("unreachable");
		expect(decision.message).toContain("spec.md");
		expect(decision.message).toContain("notes.md");
		expect(decision.message).toContain("Ambiguous annotate target");
	});

	test("errors when nothing resolves and there was prose to sift", () => {
		const decision = resolveAnnotateTargetArg({
			raw: "the",
			tokens: ["the", "aim", "doc"],
			resolves,
			inputExists: existsOnDisk,
		});
		expect(decision.kind).toBe("error");
		if (decision.kind !== "error") throw new Error("unreachable");
		expect(decision.message).toContain("Tried: the, aim, doc");
		expect(decision.message).toContain("path, URL, or folder");
	});

	test("a lone unresolvable token keeps the caller's specific error", () => {
		// One candidate means there was no prose to sift — the caller's
		// "File not found: typo.md" says more than a shape hint would.
		expect(
			resolveAnnotateTargetArg({
				raw: "typo.md",
				tokens: ["typo.md"],
				resolves,
				inputExists: existsOnDisk,
			}),
		).toEqual({ kind: "target", token: "typo.md" });
	});

	test("an argument that exists but isn't annotatable keeps the caller's error", () => {
		// Would otherwise trade "File type not supported: .pdf" for a
		// vaguer hint.
		expect(
			resolveAnnotateTargetArg({
				raw: "report.pdf",
				tokens: ["report.pdf", "please"],
				resolves,
				inputExists: existsOnDisk,
			}),
		).toEqual({ kind: "target", token: "report.pdf" });
	});

	test("strict invocations bypass tolerance entirely", () => {
		// Requirement 4. Even though `spec.md` resolves, a strict invocation
		// must keep annotating exactly what it was handed — otherwise a
		// typo'd first argument could publish "approved" for some other file.
		expect(
			resolveAnnotateTargetArg({
				raw: "typo.md",
				tokens: ["typo.md", "spec.md"],
				strict: true,
				resolves,
				inputExists: existsOnDisk,
			}),
		).toEqual({ kind: "target", token: "typo.md" });
	});

	test("strict invocations never emit a tolerant error", () => {
		for (const tokens of [
			["the", "aim", "doc"], // would be "none"
			["spec.md", "notes.md"], // would be "ambiguous"
		]) {
			expect(
				resolveAnnotateTargetArg({
					raw: tokens[0],
					tokens,
					strict: true,
					resolves,
					inputExists: existsOnDisk,
				}),
			).toEqual({ kind: "target", token: tokens[0] });
		}
	});
});
