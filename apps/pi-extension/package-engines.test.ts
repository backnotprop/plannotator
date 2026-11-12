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
