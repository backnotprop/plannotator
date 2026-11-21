/**
 * No npm package Plannotator publishes may declare an engines floor npm acts
 * on (#902). For a bare name or a range (`pi install npm:@plannotator/pi-extension`,
 * a saved `^0.28.31`) npm passes over a release whose `engines.node` (or
 * `engines.npm`) the running runtime misses and installs an older one with no
 * error, so 0.28.32's Node floor silently kept Pi on an older Node at 0.28.31
 * for every later release. The runtime is warned about in the extension
 * instead (runtime-tls.ts). `engines.bun` (the OpenCode plugin) is not read by
 * npm and Bun ignores it when installing.
 *
 * A floor that is truly wanted is a deliberate decision: add the package to
 * DELIBERATE_FLOORS with the reason, knowing it can freeze installs.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const PUBLISHED = ["apps/pi-extension/package.json", "apps/opencode-plugin/package.json"];
const DELIBERATE_FLOORS: Record<string, string> = {};

describe("published packages declare no engines floor npm honours", () => {
	for (const path of PUBLISHED) {
		test(path, () => {
			const pkg = JSON.parse(readFileSync(join(root, path), "utf8")) as { engines?: Record<string, string> };
			if (DELIBERATE_FLOORS[path]) return;
			expect(pkg.engines?.node).toBeUndefined();
			expect(pkg.engines?.npm).toBeUndefined();
		});
	}
});
