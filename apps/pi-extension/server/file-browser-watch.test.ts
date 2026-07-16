import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isFileBrowserWatchIgnoredPath } from "./file-browser-watch";

describe("Pi file browser watcher", () => {
	test("ignores nested excluded folders for watcher paths", () => {
		const root = join(tmpdir(), "plannotator-pi-watch-root");

		expect(isFileBrowserWatchIgnoredPath(join(root, "packages", "app", "node_modules"), root)).toBe(true);
		expect(isFileBrowserWatchIgnoredPath(join(root, "packages", "app", "node_modules", "pkg", "readme.md"), root)).toBe(true);
		expect(isFileBrowserWatchIgnoredPath(join(root, "docs", "dist", "generated.md"), root)).toBe(true);
		expect(isFileBrowserWatchIgnoredPath(join(root, "docs", "plan.md"), root)).toBe(false);
		expect(isFileBrowserWatchIgnoredPath(root, root)).toBe(false);
		expect(isFileBrowserWatchIgnoredPath(join(dirname(root), "outside", "node_modules"), root)).toBe(false);
	});
});
