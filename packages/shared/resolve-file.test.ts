import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
	getFileBrowserMaxFiles,
	hasMarkdownFiles,
	isAnnotatableDocPath,
	isAnnotatableTextPath,
	resolveCodeFile,
	resolveMarkdownFile,
	warmFileListCache,
} from "./resolve-file";

let root: string;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "plannotator-resolve-"));
	mkdirSync(join(root, "packages/editor"), { recursive: true });
	mkdirSync(join(root, "packages/review-editor"), { recursive: true });
	mkdirSync(join(root, "packages/ui/components"), { recursive: true });
	mkdirSync(join(root, "node_modules/junk"), { recursive: true });
	writeFileSync(join(root, "packages/editor/App.tsx"), "// editor");
	writeFileSync(join(root, "packages/review-editor/App.tsx"), "// review");
	writeFileSync(join(root, "packages/ui/components/Button.tsx"), "// btn");
	writeFileSync(join(root, "packages/ui/index.ts"), "// idx");
	writeFileSync(join(root, "node_modules/junk/App.tsx"), "// junk");
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("resolveCodeFile", () => {
	test("resolves an exact relative path", async () => {
		const r = await resolveCodeFile("packages/editor/App.tsx", root);
		expect(r.kind).toBe("found");
		if (r.kind === "found") {
			expect(r.path).toBe(join(root, "packages/editor/App.tsx"));
		}
	});

	test("resolves an abbreviated path via suffix match", async () => {
		const r = await resolveCodeFile("editor/App.tsx", root);
		expect(r.kind).toBe("found");
		if (r.kind === "found") {
			expect(r.path).toBe(join(root, "packages/editor/App.tsx"));
		}
	});

	test("returns ambiguous when basename matches multiple files", async () => {
		const r = await resolveCodeFile("App.tsx", root);
		expect(r.kind).toBe("ambiguous");
		if (r.kind === "ambiguous") {
			expect(r.matches).toHaveLength(2);
		}
	});

	test("returns not_found for a non-existent path", async () => {
		const r = await resolveCodeFile("packages/ui/shortcuts/core.ts", root);
		expect(r.kind).toBe("not_found");
	});

	test("ignores node_modules", async () => {
		const r = await resolveCodeFile("junk/App.tsx", root);
		expect(r.kind).toBe("not_found");
	});

	test("does not match similarly-named directories", async () => {
		// myeditor/App.tsx must NOT match packages/editor/App.tsx — segment boundary required.
		const r = await resolveCodeFile("myeditor/App.tsx", root);
		expect(r.kind).toBe("not_found");
	});

	test("returns found for a single-segment input that uniquely exists", async () => {
		// `index.ts` is bare basename; only one in tree.
		const r = await resolveCodeFile("index.ts", root);
		expect(r.kind).toBe("found");
		if (r.kind === "found") {
			expect(r.path).toBe(join(root, "packages/ui/index.ts"));
		}
	});

	test("strips leading ./ before suffix matching", async () => {
		// Earlier this fell through to step 3 with target='./editor/app.tsx'
		// and never matched any real file. The cleanup makes it work.
		const r = await resolveCodeFile("./editor/App.tsx", root);
		expect(r.kind).toBe("found");
		if (r.kind === "found") {
			expect(r.path).toBe(join(root, "packages/editor/App.tsx"));
		}
	});

	test("does NOT strip leading ../ — without baseDir, refuses to fabricate", async () => {
		// `../foo.tsx` is meaningful (escape parent). With no baseDir context,
		// we can't honor it, so we must fail rather than silently returning
		// an unrelated file with the same basename from inside cwd.
		const r = await resolveCodeFile("../editor/App.tsx", root);
		expect(r.kind).toBe("not_found");
	});

	test("resolves via baseDir when input is relative to active doc", async () => {
		// Linked doc at `<root>/packages/review-editor/...` references `../editor/App.tsx`
		const baseDir = join(root, "packages/review-editor");
		const r = await resolveCodeFile("../editor/App.tsx", root, baseDir);
		expect(r.kind).toBe("found");
		if (r.kind === "found") {
			expect(r.path).toBe(join(root, "packages/editor/App.tsx"));
		}
	});

	test("baseDir miss falls through to suffix walk", async () => {
		// baseDir doesn't have the file, but cwd tree does — walk catches it.
		const baseDir = join(root, "packages/review-editor");
		const r = await resolveCodeFile("ui/components/Button.tsx", root, baseDir);
		expect(r.kind).toBe("found");
		if (r.kind === "found") {
			expect(r.path).toBe(join(root, "packages/ui/components/Button.tsx"));
		}
	});
});

describe("bounded file traversal", () => {
	test("parses the shared file limit with the established fallback semantics", () => {
		const previousLimit = process.env.PLANNOTATOR_FILE_BROWSER_MAX_FILES;
		try {
			for (const invalid of ["", "0", "-1", "not-a-number"]) {
				process.env.PLANNOTATOR_FILE_BROWSER_MAX_FILES = invalid;
				expect(getFileBrowserMaxFiles()).toBe(5_000);
			}

			process.env.PLANNOTATOR_FILE_BROWSER_MAX_FILES = "12files";
			expect(getFileBrowserMaxFiles()).toBe(12);
		} finally {
			if (previousLimit === undefined) {
				delete process.env.PLANNOTATOR_FILE_BROWSER_MAX_FILES;
			} else {
				process.env.PLANNOTATOR_FILE_BROWSER_MAX_FILES = previousLimit;
			}
		}
	});

	test("caps the async code-file cache warm", async () => {
		const limitedRoot = mkdtempSync(join(tmpdir(), "plannotator-code-limit-"));
		const previousLimit = process.env.PLANNOTATOR_FILE_BROWSER_MAX_FILES;
		try {
			for (let index = 0; index < 5; index += 1) {
				writeFileSync(join(limitedRoot, `file-${index}.ts`), "export {};\n");
			}
			process.env.PLANNOTATOR_FILE_BROWSER_MAX_FILES = "2";

			const files = await warmFileListCache(limitedRoot, "code");
			expect(files).not.toBeNull();
			expect(files).toHaveLength(2);
		} finally {
			if (previousLimit === undefined) {
				delete process.env.PLANNOTATOR_FILE_BROWSER_MAX_FILES;
			} else {
				process.env.PLANNOTATOR_FILE_BROWSER_MAX_FILES = previousLimit;
			}
			rmSync(limitedRoot, { recursive: true, force: true });
		}
	});

	test("caps fallback markdown discovery", () => {
		const limitedRoot = mkdtempSync(join(tmpdir(), "plannotator-markdown-limit-"));
		const previousLimit = process.env.PLANNOTATOR_FILE_BROWSER_MAX_FILES;
		try {
			for (const directory of ["one", "two", "three"]) {
				mkdirSync(join(limitedRoot, directory));
				writeFileSync(join(limitedRoot, directory, "plan.md"), `# ${directory}\n`);
			}
			process.env.PLANNOTATOR_FILE_BROWSER_MAX_FILES = "2";

			const result = resolveMarkdownFile("plan.md", limitedRoot);
			expect(result.kind).toBe("ambiguous");
			if (result.kind === "ambiguous") {
				expect(result.matches).toHaveLength(2);
			}
		} finally {
			if (previousLimit === undefined) {
				delete process.env.PLANNOTATOR_FILE_BROWSER_MAX_FILES;
			} else {
				process.env.PLANNOTATOR_FILE_BROWSER_MAX_FILES = previousLimit;
			}
			rmSync(limitedRoot, { recursive: true, force: true });
		}
	});

	test("caps folder-target discovery even when no files match", () => {
		const limitedRoot = mkdtempSync(join(tmpdir(), "plannotator-folder-limit-"));
		const previousLimit = process.env.PLANNOTATOR_FILE_BROWSER_MAX_FILES;
		class CountingRegExp extends RegExp {
			calls = 0;

			override test(value: string): boolean {
				this.calls += 1;
				return super.test(value);
			}
		}

		try {
			for (let index = 0; index < 5; index += 1) {
				writeFileSync(join(limitedRoot, `file-${index}.txt`), "not markdown\n");
			}
			process.env.PLANNOTATOR_FILE_BROWSER_MAX_FILES = "2";
			const extensions = new CountingRegExp("^never-match$");

			expect(hasMarkdownFiles(limitedRoot, [], extensions)).toBe(false);
			expect(extensions.calls).toBe(2);
		} finally {
			if (previousLimit === undefined) {
				delete process.env.PLANNOTATOR_FILE_BROWSER_MAX_FILES;
			} else {
				process.env.PLANNOTATOR_FILE_BROWSER_MAX_FILES = previousLimit;
			}
			rmSync(limitedRoot, { recursive: true, force: true });
		}
	});

	test("keeps exact and in-budget bare markdown resolution working", () => {
		const exactRoot = mkdtempSync(join(tmpdir(), "plannotator-markdown-exact-"));
		const bareRoot = mkdtempSync(join(tmpdir(), "plannotator-markdown-bare-"));
		const previousLimit = process.env.PLANNOTATOR_FILE_BROWSER_MAX_FILES;
		try {
			mkdirSync(join(exactRoot, "docs"));
			writeFileSync(join(exactRoot, "docs", "plan.md"), "# Exact\n");
			mkdirSync(join(bareRoot, "notes"));
			writeFileSync(join(bareRoot, "notes", "Architecture.MD"), "# Bare\n");
			process.env.PLANNOTATOR_FILE_BROWSER_MAX_FILES = "1";

			expect(resolveMarkdownFile("docs/plan.md", exactRoot)).toEqual({
				kind: "found",
				path: join(exactRoot, "docs", "plan.md"),
			});
			expect(resolveMarkdownFile("architecture.md", bareRoot)).toEqual({
				kind: "found",
				path: join(bareRoot, "notes", "Architecture.MD"),
			});
		} finally {
			if (previousLimit === undefined) {
				delete process.env.PLANNOTATOR_FILE_BROWSER_MAX_FILES;
			} else {
				process.env.PLANNOTATOR_FILE_BROWSER_MAX_FILES = previousLimit;
			}
			rmSync(exactRoot, { recursive: true, force: true });
			rmSync(bareRoot, { recursive: true, force: true });
		}
	});
});

describe("explicit parent-relative markdown paths (#1085)", () => {
	test("resolves a ../ path that escapes the project root", () => {
		const parent = mkdtempSync(join(tmpdir(), "plannotator-md-parent-"));
		try {
			mkdirSync(join(parent, "docs", "radio"), { recursive: true });
			writeFileSync(join(parent, "docs", "radio", "plan.md"), "# Plan\n");
			const cwd = join(parent, "work");
			mkdirSync(cwd);

			expect(resolveMarkdownFile("../docs/radio/plan.md", cwd)).toEqual({
				kind: "found",
				path: join(parent, "docs", "radio", "plan.md"),
			});
		} finally {
			rmSync(parent, { recursive: true, force: true });
		}
	});

	test("resolves a ./ explicit path within the root", () => {
		const cwd = mkdtempSync(join(tmpdir(), "plannotator-md-dot-"));
		try {
			mkdirSync(join(cwd, "sub"));
			writeFileSync(join(cwd, "sub", "notes.md"), "# Notes\n");
			expect(resolveMarkdownFile("./sub/notes.md", cwd)).toEqual({
				kind: "found",
				path: join(cwd, "sub", "notes.md"),
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("a bare filename does NOT escape into a parent directory", () => {
		const parent = mkdtempSync(join(tmpdir(), "plannotator-md-bare-esc-"));
		try {
			writeFileSync(join(parent, "secret.md"), "# Parent\n");
			const cwd = join(parent, "work");
			mkdirSync(cwd);
			expect(resolveMarkdownFile("secret.md", cwd)).toEqual({
				kind: "not_found",
				input: "secret.md",
			});
		} finally {
			rmSync(parent, { recursive: true, force: true });
		}
	});

	test("a ../ path to a missing file is still not_found", () => {
		const cwd = mkdtempSync(join(tmpdir(), "plannotator-md-missing-"));
		try {
			expect(resolveMarkdownFile("../nope/absent.md", cwd)).toEqual({
				kind: "not_found",
				input: "../nope/absent.md",
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

describe("annotatable plain-text files (#1029)", () => {
	test("resolves an exact relative .yaml path", () => {
		const cwd = mkdtempSync(join(tmpdir(), "plannotator-annotatable-yaml-"));
		try {
			mkdirSync(join(cwd, "config"));
			writeFileSync(join(cwd, "config", "app.yaml"), "key: value\n");
			expect(resolveMarkdownFile("config/app.yaml", cwd)).toEqual({
				kind: "found",
				path: join(cwd, "config", "app.yaml"),
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("resolves a bare filename in-root for a config format", () => {
		const cwd = mkdtempSync(join(tmpdir(), "plannotator-annotatable-bare-"));
		try {
			mkdirSync(join(cwd, "nested"));
			writeFileSync(join(cwd, "nested", "Cargo.toml"), "[package]\n");
			expect(resolveMarkdownFile("cargo.toml", cwd)).toEqual({
				kind: "found",
				path: join(cwd, "nested", "Cargo.toml"),
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("accepts each newly supported extension", () => {
		const cwd = mkdtempSync(join(tmpdir(), "plannotator-annotatable-all-"));
		try {
			const names = [
				"a.yaml", "b.yml", "c.json", "d.jsonc", "e.json5", "f.toml",
				"g.ini", "h.cfg", "i.conf", "j.properties", "k.csv", "l.tsv",
				"m.log", "n.xml", "sample.env.example",
			];
			for (const name of names) {
				writeFileSync(join(cwd, name), "content\n");
			}
			for (const name of names) {
				expect(resolveMarkdownFile(name, cwd)).toEqual({
					kind: "found",
					path: join(cwd, name),
				});
			}
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("still rejects source-code extensions", () => {
		const cwd = mkdtempSync(join(tmpdir(), "plannotator-annotatable-code-"));
		try {
			writeFileSync(join(cwd, "script.py"), "print('hi')\n");
			expect(resolveMarkdownFile("script.py", cwd)).toEqual({
				kind: "not_found",
				input: "script.py",
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("rejects .env but accepts .env.example", () => {
		const cwd = mkdtempSync(join(tmpdir(), "plannotator-annotatable-env-"));
		try {
			writeFileSync(join(cwd, ".env"), "SECRET=1\n");
			writeFileSync(join(cwd, ".env.example"), "SECRET=\n");
			expect(resolveMarkdownFile(".env", cwd)).toEqual({
				kind: "not_found",
				input: ".env",
			});
			expect(resolveMarkdownFile(".env.example", cwd)).toEqual({
				kind: "found",
				path: join(cwd, ".env.example"),
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("predicates classify text vs doc vs unsupported paths", () => {
		expect(isAnnotatableTextPath("notes.yaml")).toBe(true);
		expect(isAnnotatableTextPath("notes.txt")).toBe(true);
		expect(isAnnotatableTextPath("page.html")).toBe(false);
		expect(isAnnotatableTextPath("app.ts")).toBe(false);
		expect(isAnnotatableTextPath(".env")).toBe(false);
		expect(isAnnotatableDocPath("page.html")).toBe(true);
		expect(isAnnotatableDocPath("config.json5")).toBe(true);
		expect(isAnnotatableDocPath("binary.png")).toBe(false);
	});
});
