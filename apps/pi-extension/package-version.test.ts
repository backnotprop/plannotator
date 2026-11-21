/**
 * The package updated under a running host (#2085): the lazy imports must
 * stop with "restart" instead of linking new files against old ones.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	checkPackageVersion,
	importFresh,
	isPlannotatorUpdatedError,
	isStaleModuleLinkError,
	launchFailureText,
	loadedPackageVersion,
	PlannotatorUpdatedError,
	readPackageVersion,
} from "./package-version.ts";

const LINK_ERROR = "Export named 'agentSwitchConfigToSave' not found in module '/home/u/.omp/plugins/node_modules/@plannotator/pi-extension/generated/config.ts?mtime=1792683472048'";

describe("checkPackageVersion", () => {
	test("same version on disk: nothing to say", () => {
		expect(checkPackageVersion("0.28.26", "0.28.26", "oh-my-pi")).toBeNull();
	});

	test("an unreadable version on either side is not a reason to refuse", () => {
		expect(checkPackageVersion(null, "0.28.26", "pi")).toBeNull();
		expect(checkPackageVersion("0.28.26", null, "pi")).toBeNull();
	});

	// The wording is pinned on purpose: it is the one instruction the person
	// gets when an upgrade under a running host breaks a launch (#2085).
	test("a different version names both versions and the host", () => {
		expect(checkPackageVersion("0.28.25", "0.28.26", "oh-my-pi")).toBe(
			"Plannotator was updated from 0.28.25 to 0.28.26 while Oh My Pi was running. Type /restart to load the new version.",
		);
		expect(checkPackageVersion("0.28.25", "0.28.26", "pi")).toBe(
			"Plannotator was updated from 0.28.25 to 0.28.26 while Pi was running. Type /reload to load the new version.",
		);
	});
});

describe("readPackageVersion", () => {
	test("the loaded version is this package's own", () => {
		const pkg = JSON.parse(readFileSync(join(import.meta.dir, "package.json"), "utf-8")) as { version: string };
		expect(loadedPackageVersion()).toBe(pkg.version);
		expect(readPackageVersion()).toBe(pkg.version);
	});

	test("missing or malformed package.json reads as null", () => {
		const dir = mkdtempSync(join(tmpdir(), "pn-pkgver-"));
		try {
			expect(readPackageVersion(join(dir, "package.json"))).toBeNull();
			writeFileSync(join(dir, "package.json"), "{ not json");
			expect(readPackageVersion(join(dir, "package.json"))).toBeNull();
			writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "1.2.3" }));
			expect(readPackageVersion(join(dir, "package.json"))).toBe("1.2.3");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("importFresh", () => {
	test("same version: the import runs and its module is returned", async () => {
		const mod = await importFresh(async () => ({ value: 42 }), { loaded: "0.28.26", readOnDisk: () => "0.28.26", host: "pi" });
		expect(mod.value).toBe(42);
	});

	test("a different version on disk: the import never runs", async () => {
		let ran = false;
		const result = importFresh(
			async () => {
				ran = true;
				return {};
			},
			{ loaded: "0.28.25", readOnDisk: () => "0.28.26", host: "oh-my-pi" },
		);
		await expect(result).rejects.toBeInstanceOf(PlannotatorUpdatedError);
		await expect(result).rejects.toThrow("Type /restart to load the new version.");
		expect(ran).toBe(false);
	});

	test("Bun's link error after a raced check becomes the restart message", async () => {
		const reads = ["0.28.25", "0.28.26"];
		const result = importFresh(
			async () => {
				throw new SyntaxError(LINK_ERROR);
			},
			{ loaded: "0.28.25", readOnDisk: () => reads.shift() ?? "0.28.26", host: "oh-my-pi" },
		);
		await expect(result).rejects.toThrow(
			"Plannotator was updated from 0.28.25 to 0.28.26 while Oh My Pi was running. Type /restart to load the new version.",
		);
	});

	test("a link error with no version change still says to reload", async () => {
		const result = importFresh(
			async () => {
				throw new SyntaxError(LINK_ERROR);
			},
			{ loaded: "0.28.26", readOnDisk: () => "0.28.26", host: "pi" },
		);
		let caught: unknown;
		try {
			await result;
		} catch (error) {
			caught = error;
		}
		expect(isPlannotatorUpdatedError(caught)).toBe(true);
		// Restart is still the advice, and Bun's own error is kept: it may be a packaging bug.
		expect((caught as Error).message).toContain("Type /reload");
		expect((caught as Error).message).toContain(LINK_ERROR);
		expect((caught as Error).cause).toBeInstanceOf(SyntaxError);
	});

	test("any other import failure passes through unchanged", async () => {
		const boom = new Error("ENOENT: no such file");
		const result = importFresh(
			async () => {
				throw boom;
			},
			{ loaded: "0.28.26", readOnDisk: () => "0.28.26", host: "pi" },
		);
		await expect(result).rejects.toBe(boom);
	});

	test("a real Bun link failure: new file on disk imports a name its cached dependency lacks", async () => {
		// The #2085 shape: the dependency was loaded at startup and stays in the
		// registry; the lazily imported module on disk is newer and asks for a
		// name the cached one never had.
		const dir = mkdtempSync(join(tmpdir(), "pn-pkgver-link-"));
		try {
			writeFileSync(join(dir, "config.ts"), "export const loadConfig = () => ({});\n");
			// Both files exist before the first import, as in an installed package
			// (Bun keeps the folder listing it read then).
			writeFileSync(join(dir, "browser.ts"), "export const value = 0;\n");
			const config = await import(join(dir, "config.ts"));
			expect(typeof config.loadConfig).toBe("function");
			writeFileSync(join(dir, "config.ts"), "export const loadConfig = () => ({});\nexport const agentSwitchConfigToSave = 1;\n");
			writeFileSync(join(dir, "browser.ts"), 'import { agentSwitchConfigToSave } from "./config.ts";\nexport const value = agentSwitchConfigToSave;\n');

			const reads = ["0.28.25", "0.28.26"];
			let caught: unknown;
			try {
				await importFresh(() => import(join(dir, "browser.ts")), {
					loaded: "0.28.25",
					readOnDisk: () => reads.shift() ?? "0.28.26",
					host: "oh-my-pi",
				});
			} catch (error) {
				caught = error;
			}
			expect(isPlannotatorUpdatedError(caught)).toBe(true);
			expect((caught as Error).message).toBe(
				"Plannotator was updated from 0.28.25 to 0.28.26 while Oh My Pi was running. Type /restart to load the new version.",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("messages", () => {
	test("isStaleModuleLinkError matches Bun's link error only", () => {
		expect(isStaleModuleLinkError(new SyntaxError(LINK_ERROR))).toBe(true);
		expect(isStaleModuleLinkError(new Error("Cannot find module './x.ts'"))).toBe(false);
		expect(isStaleModuleLinkError(undefined)).toBe(false);
	});

	test("launchFailureText keeps the prefix except for an update", () => {
		expect(launchFailureText("Failed to start annotation UI", new Error("port in use"))).toBe("Failed to start annotation UI: port in use");
		expect(launchFailureText("Failed to start annotation UI", "x")).toBe("Failed to start annotation UI: Unknown error");
		expect(launchFailureText("Failed to start annotation UI", new PlannotatorUpdatedError("Restart Pi."))).toBe("Restart Pi.");
	});
});
