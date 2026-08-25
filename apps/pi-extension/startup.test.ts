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

	test("ships the lazy runtime and todo providers in the npm package", () => {
		const manifest = JSON.parse(
			readFileSync(join(extensionDirectory, "package.json"), "utf-8"),
		) as { files?: unknown };

		expect(Array.isArray(manifest.files)).toBe(true);
		expect(manifest.files).toContain("plannotator-browser-runtime.ts");
		expect(manifest.files).toContain("todo-providers/");
	});

	test("ships the plannotator knowledge skill through the pi manifest", () => {
		// #1377 install reach: Pi users got the extension but none of the CLI
		// reference every other host installs as a skill. Three things have to
		// line up or it silently stops shipping again: vendor.sh must make the
		// copy, `files` must include it, and `pi.skills` must name it (Pi
		// resolves non-glob manifest entries relative to the package root).
		const manifest = JSON.parse(
			readFileSync(join(extensionDirectory, "package.json"), "utf-8"),
		) as { files?: unknown; pi?: { skills?: unknown } };

		expect(manifest.files).toContain("skills/");
		expect(manifest.pi?.skills).toEqual(["skills/plannotator/SKILL.md"]);

		// Assert the vendor step rather than the vendored file: a fresh checkout
		// has not run vendor.sh yet, and this must not depend on build order.
		const vendorScript = readFileSync(
			join(extensionDirectory, "vendor.sh"),
			"utf-8",
		);
		expect(vendorScript).toContain(
			"cp -R ../skills/core/plannotator skills/plannotator",
		);
	});

	test("requires a Pi host that exposes the resolved project-trust decision", () => {
		const manifest = JSON.parse(
			readFileSync(join(extensionDirectory, "package.json"), "utf-8"),
		) as {
			peerDependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
		};

		// Deliberate security/API floor: lowering it re-admits the four Pi
		// advisories and removes the project-trust context API this extension uses.
		expect(manifest.peerDependencies?.["@earendil-works/pi-coding-agent"]).toBe(">=0.79.1");
		for (const packageName of [
			"@earendil-works/pi-coding-agent",
			"@earendil-works/pi-agent-core",
			"@earendil-works/pi-ai",
			"@earendil-works/pi-tui",
		]) {
			expect(manifest.devDependencies?.[packageName]).toBe(">=0.79.1");
		}
	});
});
