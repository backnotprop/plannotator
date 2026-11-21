import { describe, expect, test } from "bun:test";
import { siblingDependencyGaps } from "./check-sibling-deps";

// The registry is injected: these never touch the network.
const repo = [
	{ name: "@plannotator/core", version: "0.25.14" },
	{ name: "@plannotator/ui", version: "0.53.1", dependencies: { "@plannotator/core": "0.25.14", react: "^19" } },
	{ name: "@plannotator/shared", version: "0.0.1", private: true },
	{ name: "@plannotator/pi-extension", version: "1.0.0", dependencies: { "@plannotator/shared": "workspace:*" } },
	{ name: "@plannotator/editor", version: "0.0.1", dependencies: { "@plannotator/core": "workspace:^" } },
];
const npm = (published: Record<string, string[]>) => (name: string) => published[name] ?? [];

describe("sibling dependencies of a release", () => {
	test("ui pinned to a core npm doesn't have fails unless core ships in the same release", () => {
		const registry = npm({ "@plannotator/core": ["0.25.13"] });
		expect(siblingDependencyGaps(repo, ["@plannotator/ui"], registry).map((gap) => gap.dependency)).toEqual([
			"@plannotator/core",
		]);
		expect(siblingDependencyGaps(repo, ["@plannotator/core", "@plannotator/ui"], registry)).toEqual([]);
		expect(siblingDependencyGaps(repo, ["@plannotator/ui"], npm({ "@plannotator/core": ["0.25.14"] }))).toEqual([]);
	});

	test("a dependency on a private sibling always fails", () => {
		const gaps = siblingDependencyGaps(repo, ["@plannotator/pi-extension", "@plannotator/shared"], npm({}));
		expect(gaps.map((gap) => gap.dependency)).toEqual(["@plannotator/shared"]);
	});

	test("workspace:^ is read as a caret on the sibling's repo version", () => {
		expect(siblingDependencyGaps(repo, ["@plannotator/editor"], npm({ "@plannotator/core": ["0.25.13"] }))).toHaveLength(1);
		expect(siblingDependencyGaps(repo, ["@plannotator/editor"], npm({ "@plannotator/core": ["0.25.15"] }))).toEqual([]);
	});
});
