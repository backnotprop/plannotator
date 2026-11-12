import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	type FloorAllowance,
	findPublishablePackages,
	staleAllowances,
	updateBlockingFields,
} from "./helpers/published-packages";

const repoRoot = resolve(import.meta.dir, "..");

const ALLOWED: readonly FloorAllowance[] = [
	{
		package: "plannotator-webview",
		field: "engines.vscode",
		value: "^1.85.0",
		reason:
			"vsce requires engines.vscode. ^1.85.0 is the floor the extension has shipped with on the VS Code Marketplace and Open VSX; raising it silently stops updates for Cursor, Windsurf and older VS Code.",
	},
	{
		package: "@plannotator/opencode",
		field: "engines.bun",
		value: ">=1.4.4",
		reason:
			"OpenCode's Arborist install ignores engines.bun, so it blocks no install today; pinned so a raise is reviewed.",
	},
];

const packages = findPublishablePackages(repoRoot);

describe("published packages carry no field that blocks updates", () => {
	for (const { path, manifest } of packages) {
		test(path, () => {
			expect(updateBlockingFields(manifest, ALLOWED)).toEqual([]);
		});
	}

	test("every allowance still matches a field exactly", () => {
		expect(staleAllowances(packages, ALLOWED)).toEqual([]);
	});

	test("the scan covers every package release.yml packs for npm", () => {
		const workflow = readFileSync(join(repoRoot, ".github/workflows/release.yml"), "utf8");
		const packed = [...workflow.matchAll(/working-directory:\s*(\S+)\s*\n\s*run:\s*bun pm pack\b/g)].map(
			(match) => `${match[1]}/package.json`,
		);
		expect(packed.length).toBeGreaterThanOrEqual(2);
		const scanned = packages.map((pkg) => pkg.path);
		for (const path of packed) expect(scanned).toContain(path);
	});

	test("the root package.json stays private", () => {
		const root = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { private?: boolean };
		expect(root.private).toBe(true);
	});
});

describe("the floor check catches each gated field", () => {
	const name = "@plannotator/example";
	const fields = (manifest: object, allowlist: readonly FloorAllowance[] = []) =>
		updateBlockingFields({ name, ...manifest }, allowlist).map((finding) => finding.field);

	test("engines.node, engines.npm, engines.opencode, engines.vscode and engines.bun", () => {
		expect(
			fields({ engines: { node: ">=22", npm: ">=10", opencode: ">=1", vscode: "^1.85.0", bun: ">=1.4.4" } }),
		).toEqual(["engines.node", "engines.npm", "engines.opencode", "engines.vscode", "engines.bun"]);
	});

	test("os, cpu and libc", () => {
		expect(fields({ os: ["darwin"], cpu: ["arm64"], libc: ["glibc"] })).toEqual(["os", "cpu", "libc"]);
	});

	test("a raised engines.vscode or engines.bun fails despite the pinned allowance", () => {
		const pinned = (field: string, value: string): FloorAllowance => ({ package: name, field, value, reason: "test" });
		const allowlist = [pinned("engines.vscode", "^1.85.0"), pinned("engines.bun", ">=1.4.4")];
		expect(fields({ engines: { vscode: "^1.85.0", bun: ">=1.4.4" } }, allowlist)).toEqual([]);
		expect(fields({ engines: { vscode: "^1.105.0", bun: ">=1.5.0" } }, allowlist)).toEqual([
			"engines.vscode",
			"engines.bun",
		]);
	});

	test("an OpenCode peer under any of its names", () => {
		expect(
			fields({
				peerDependencies: { "@opencode-ai/plugin": "*", "@opencode/cli": "*", "opencode-ai": "*", react: "^19" },
			}),
		).toEqual(["peerDependencies.@opencode-ai/plugin", "peerDependencies.@opencode/cli", "peerDependencies.opencode-ai"]);
	});

	test("a Pi peer outside @earendil-works/pi-*", () => {
		expect(
			fields({
				peerDependencies: {
					"@earendil-works/pi-coding-agent": ">=0.79.1",
					"@mariozechner/pi-coding-agent": ">=0.60.0",
					"pi-coding-agent": "*",
				},
			}),
		).toEqual(["peerDependencies.@mariozechner/pi-coding-agent", "peerDependencies.pi-coding-agent"]);
	});

	test("an allowance admits only its exact value", () => {
		const allowance: FloorAllowance = { package: name, field: "engines.node", value: ">=22", reason: "test" };
		expect(fields({ engines: { node: ">=22" } }, [allowance])).toEqual([]);
		expect(fields({ engines: { node: ">=24" } }, [allowance])).toEqual(["engines.node"]);
		expect(fields({ engines: { node: ">=22", npm: ">=10" } }, [allowance])).toEqual(["engines.npm"]);
	});

	test("an allowance that matches nothing is reported", () => {
		const allowance: FloorAllowance = { package: name, field: "os", value: ["linux"], reason: "test" };
		const published = [{ path: "x/package.json", manifest: { name, os: ["darwin"] } }];
		expect(staleAllowances(published, [allowance])).toEqual([allowance]);
	});
});
