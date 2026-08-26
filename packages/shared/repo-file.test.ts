import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	MAX_REPO_FILE_BYTES,
	isContainedPath,
	readRepoFile,
	resolveRepoFilePath,
	validateRepoFilePath,
} from "./repo-file";

/**
 * Every test here guards a way the review side could hand out a file it must
 * not, or read one it cannot afford. The lexical `validateFilePath` these
 * replace passed the symlink cases below.
 */

let root = "";
let outside = "";

beforeAll(() => {
	// realpath the temp dir: on macOS /tmp is itself a symlink to /private/tmp,
	// so an un-resolved root would make every containment check fail.
	const base = realpathSync(mkdtempSync(join(tmpdir(), "pn-repo-file-")));
	root = join(base, "repo");
	outside = join(base, "outside");
	mkdirSync(join(root, "src"), { recursive: true });
	mkdirSync(outside, { recursive: true });

	writeFileSync(join(root, "src", "alpha.ts"), "export const a = 1;\n");
	writeFileSync(join(root, "README.md"), "# repo\n");
	writeFileSync(join(outside, "secret.txt"), "TOP SECRET\n");

	// A symlink whose destination escapes the root. Lexically it is a perfectly
	// ordinary relative path with no "..".
	symlinkSync(join(outside, "secret.txt"), join(root, "escape.txt"));
	// A directory symlink pointing out, so "escape-dir/secret.txt" also has no
	// ".." anywhere in it.
	symlinkSync(outside, join(root, "escape-dir"));
	// A symlink that stays inside: this one must keep working.
	symlinkSync(join(root, "src", "alpha.ts"), join(root, "inside-link.ts"));
	// A dangling symlink.
	symlinkSync(join(outside, "nope.txt"), join(root, "dangling.txt"));
});

afterAll(() => {
	if (root) rmSync(join(root, ".."), { recursive: true, force: true });
});

describe("validateRepoFilePath", () => {
	test("accepts and normalizes an ordinary relative path", () => {
		const result = validateRepoFilePath("./src//alpha.ts");
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.path).toBe("src/alpha.ts");
	});

	test("rejects absolute paths", () => {
		const result = validateRepoFilePath("/etc/passwd");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("invalid-path");
	});

	test("rejects parent-directory segments", () => {
		for (const candidate of ["../secret", "src/../../secret", "a/b/.."]) {
			const result = validateRepoFilePath(candidate);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.reason).toBe("invalid-path");
		}
	});

	test("rejects backslash-spelled parent segments", () => {
		// Guards the normalization step: a Windows-style path must not smuggle
		// a ".." past a check that only splits on "/".
		const result = validateRepoFilePath("..\\secret");
		expect(result.ok).toBe(false);
	});

	test("does not treat a filename merely containing dots as traversal", () => {
		// The old substring check rejected this legitimate filename.
		const result = validateRepoFilePath("src/foo..bar.ts");
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.path).toBe("src/foo..bar.ts");
	});

	test("rejects NUL bytes and empty input", () => {
		expect(validateRepoFilePath("src/a\0.ts").ok).toBe(false);
		expect(validateRepoFilePath("").ok).toBe(false);
		expect(validateRepoFilePath(undefined).ok).toBe(false);
		expect(validateRepoFilePath(".").ok).toBe(false);
	});

	test("rejects Windows drive-qualified paths", () => {
		expect(validateRepoFilePath("C:/Windows/win.ini").ok).toBe(false);
	});
});

describe("isContainedPath", () => {
	test("a sibling sharing a name prefix is not contained", () => {
		// The bug a naive startsWith() containment check has.
		expect(isContainedPath("/repo-evil/x", "/repo")).toBe(false);
		expect(isContainedPath("/repo/x", "/repo")).toBe(true);
		expect(isContainedPath("/repo", "/repo")).toBe(true);
	});
});

describe("readRepoFile containment", () => {
	test("reads a file inside the root", () => {
		const result = readRepoFile(root, "src/alpha.ts");
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.content).toBe("export const a = 1;\n");
			expect(result.filePath).toBe("src/alpha.ts");
			expect(result.size).toBe("export const a = 1;\n".length);
		}
	});

	test("refuses a symlink that escapes the root", () => {
		// The headline case: no ".." anywhere, lexically clean, still denied.
		const result = readRepoFile(root, "escape.txt");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("outside-root");
	});

	test("refuses a path through a directory symlink that escapes", () => {
		const result = readRepoFile(root, "escape-dir/secret.txt");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("outside-root");
	});

	test("never returns content from outside the root", () => {
		for (const candidate of ["escape.txt", "escape-dir/secret.txt"]) {
			const result = readRepoFile(root, candidate);
			const body = result.ok ? result.content : "";
			expect(body).not.toContain("TOP SECRET");
		}
	});

	test("allows a symlink that stays inside the root", () => {
		const result = readRepoFile(root, "inside-link.ts");
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.content).toBe("export const a = 1;\n");
	});

	test("reports a dangling symlink as not-found, not as an escape", () => {
		const result = readRepoFile(root, "dangling.txt");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("not-found");
	});

	test("rejects traversal attempts before touching the filesystem", () => {
		for (const candidate of [
			"../outside/secret.txt",
			"src/../../outside/secret.txt",
			"/etc/passwd",
		]) {
			const result = readRepoFile(root, candidate);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.reason).toBe("invalid-path");
		}
	});

	test("reports a directory as not-a-file", () => {
		const result = readRepoFile(root, "src");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("not-a-file");
	});

	test("reports a missing file as not-found", () => {
		const result = readRepoFile(root, "src/nope.ts");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("not-found");
	});
});

describe("readRepoFile size cap", () => {
	test("refuses a file over the cap without reading it into memory", () => {
		const big = join(root, "big.bin");
		// One byte over the cap is the boundary that matters.
		writeFileSync(big, Buffer.alloc(MAX_REPO_FILE_BYTES + 1, 0x61));
		try {
			const result = readRepoFile(root, "big.bin");
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reason).toBe("too-large");
				expect(result.size).toBe(MAX_REPO_FILE_BYTES + 1);
			}
		} finally {
			rmSync(big, { force: true });
		}
	});

	test("accepts a file exactly at the cap", () => {
		const atCap = join(root, "atcap.bin");
		writeFileSync(atCap, Buffer.alloc(MAX_REPO_FILE_BYTES, 0x62));
		try {
			const result = readRepoFile(root, "atcap.bin");
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.size).toBe(MAX_REPO_FILE_BYTES);
		} finally {
			rmSync(atCap, { force: true });
		}
	});
});

describe("resolveRepoFilePath", () => {
	test("returns the canonical path for an inside symlink", () => {
		const result = resolveRepoFilePath(root, "inside-link.ts");
		expect(result.ok).toBe(true);
		if (result.ok) {
			// Canonical, i.e. the link is resolved to its target.
			expect(result.absolutePath).toBe(realpathSync(join(root, "src", "alpha.ts")));
		}
	});

	test("fails closed when the root itself does not exist", () => {
		const result = resolveRepoFilePath(join(root, "no-such-root"), "a.ts");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("not-found");
	});
});
