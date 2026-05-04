import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resolveCodeFile } from "./resolve-file";

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
