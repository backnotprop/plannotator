/**
 * The `/api/doc` containment gate. Normalization has to be two-sided: macOS
 * `tmpdir()` is a symlink, so
 * realpath containment against a non-realpathed root would deny legitimate
 * reads for anyone whose root sits under one.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAllowedRootPaths, isPathAllowed } from "./doc-resolve";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("isPathAllowed", () => {
	test("serves a file inside the root and denies one outside it", () => {
		const root = makeTempDir("plannotator-gate-root-");
		const outside = makeTempDir("plannotator-gate-outside-");
		writeFileSync(join(root, "note.md"), "note\n");
		writeFileSync(join(outside, "secret.md"), "secret\n");
		const roots = getAllowedRootPaths({ rootPaths: [root] });

		expect(isPathAllowed(join(root, "note.md"), roots)).toBe(true);
		expect(isPathAllowed(join(outside, "secret.md"), roots)).toBe(false);
	});

	test("denies a symlink that escapes the root, and a file reached through a symlinked directory", () => {
		const root = makeTempDir("plannotator-gate-link-root-");
		const outside = makeTempDir("plannotator-gate-link-outside-");
		writeFileSync(join(outside, "secret.md"), "secret\n");
		symlinkSync(join(outside, "secret.md"), join(root, "link.md"));
		symlinkSync(outside, join(root, "linkdir"));
		const roots = getAllowedRootPaths({ rootPaths: [root] });

		expect(isPathAllowed(join(root, "link.md"), roots)).toBe(false);
		expect(isPathAllowed(join(root, "linkdir", "secret.md"), roots)).toBe(false);
	});

	test("allows a symlinked root under either spelling", () => {
		const realFolder = makeTempDir("plannotator-gate-real-");
		const linkParent = makeTempDir("plannotator-gate-linkparent-");
		const linkFolder = join(linkParent, "docs");
		writeFileSync(join(realFolder, "note.md"), "note\n");
		symlinkSync(realFolder, linkFolder);
		const roots = getAllowedRootPaths({ rootPaths: [linkFolder] });

		expect(isPathAllowed(join(linkFolder, "note.md"), roots)).toBe(true);
		expect(isPathAllowed(realpathSync(join(realFolder, "note.md")), roots)).toBe(true);
	});

	test("judges a path whose leaf does not exist by its deepest existing ancestor", () => {
		const root = makeTempDir("plannotator-gate-missing-root-");
		const outside = makeTempDir("plannotator-gate-missing-outside-");
		symlinkSync(outside, join(root, "linkdir"));
		mkdirSync(join(root, "real"), { recursive: true });
		const roots = getAllowedRootPaths({ rootPaths: [root] });

		expect(isPathAllowed(join(root, "real", "absent.md"), roots)).toBe(true);
		expect(isPathAllowed(join(root, "absent", "deeper", "absent.md"), roots)).toBe(true);
		expect(isPathAllowed(join(root, "linkdir", "absent.md"), roots)).toBe(false);
	});
});
