import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlannotatorBrowser } from "./plannotator-browser-runtime.ts";

const extensionDirectory = dirname(fileURLToPath(import.meta.url));

function scanImports(filename: string): { eager: Set<string>; dynamic: Set<string> } {
	const source = readFileSync(join(extensionDirectory, filename), "utf-8");
	const imports = new Bun.Transpiler({ loader: "ts" }).scan(source).imports;
	return {
		eager: new Set(imports.filter((entry) => entry.kind === "import-statement").map((entry) => entry.path)),
		dynamic: new Set(imports.filter((entry) => entry.kind === "dynamic-import").map((entry) => entry.path)),
	};
}

describe("Pi extension startup boundary", () => {
	test("keeps invocation-only modules out of the eager index graph", () => {
		const imports = scanImports("index.ts");
		const invocationOnlyModules = [
			"./generated/annotate-args.ts",
			"./generated/at-reference.ts",
			"./generated/html-to-markdown.ts",
			"./generated/prompts.ts",
			"./generated/reference-common.ts",
			"./generated/resolve-file.ts",
			"./generated/review-args.ts",
			"./generated/url-to-markdown.ts",
		];

		for (const modulePath of invocationOnlyModules) {
			expect(imports.eager).not.toContain(modulePath);
			expect(imports.dynamic).toContain(modulePath);
		}
	});

	test("loads the browser/server graph only through the shared dynamic boundary", () => {
		const eventImports = scanImports("plannotator-events.ts");
		const runtimeImports = scanImports("plannotator-browser-runtime.ts");

		expect(eventImports.eager).not.toContain("./plannotator-browser.ts");
		expect(eventImports.eager).toContain("./plannotator-browser-runtime.ts");
		expect(runtimeImports.eager).not.toContain("./plannotator-browser.ts");
		expect(runtimeImports.dynamic).toContain("./plannotator-browser.ts");
	});

	test("coalesces concurrent first-use browser imports", async () => {
		const first = loadPlannotatorBrowser();
		const second = loadPlannotatorBrowser();

		expect(second).toBe(first);
		const browser = await first;
		expect(browser.startPlanReviewBrowserSession).toBeFunction();
		expect(browser.startCodeReviewBrowserSession).toBeFunction();
		expect(browser.startMarkdownAnnotationSession).toBeFunction();
	});

	test("ships the lazy runtime in the npm package", () => {
		const manifest = JSON.parse(
			readFileSync(join(extensionDirectory, "package.json"), "utf-8"),
		) as { files?: unknown };

		expect(Array.isArray(manifest.files)).toBe(true);
		expect(manifest.files).toContain("plannotator-browser-runtime.ts");
	});
});
