import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import {
	createSourceSaveCapability,
	createSourceSaveCapabilityFromSnapshot,
	createSourceSaveCapabilityFromText,
	readSourceFileSnapshot,
	resolveFolderSourceFile,
	resolveFolderSourceFileForSave,
	saveSourceFileAtomic,
} from "./source-save-node";

const tempDirs: string[] = [];

function tempRoot(): string {
	const dir = mkdtempSync(join(tmpdir(), "plannotator-source-save-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("source-save node helpers", () => {
	test("creates source-save capability for local text files", () => {
		const root = tempRoot();
		const filePath = join(root, "notes.txt");
		writeFileSync(filePath, "plain text\n");

		const capability = createSourceSaveCapability("single-file", filePath);

		expect(capability.enabled).toBe(true);
		if (capability.enabled) {
			expect(capability.kind).toBe("local-text-file");
			expect(capability.language).toBe("text");
			expect(capability.basename).toBe("notes.txt");
			expect(capability.hash).toMatch(/^sha256:/);
		}
	});

	test("creates source-save capability from the same snapshot used for displayed text", () => {
		const root = tempRoot();
		const filePath = join(root, "notes.md");
		writeFileSync(filePath, "old\n");
		const snapshot = readSourceFileSnapshot(filePath);
		writeFileSync(filePath, "new\n");

		const capability = createSourceSaveCapabilityFromSnapshot("single-file", filePath, snapshot);

		expect(capability.enabled).toBe(true);
		if (!capability.enabled) throw new Error("expected source-save capability");
		expect(capability.hash).toBe(snapshot.hash);
		expect(capability.size).toBe(snapshot.size);
	});

	test("creates source-save capability from in-memory text for a missing file", () => {
		const root = tempRoot();
		const filePath = join(root, "missing.md");

		const capability = createSourceSaveCapabilityFromText("single-file", filePath, "Recovered\r\n");

		expect(capability.enabled).toBe(true);
		if (!capability.enabled) throw new Error("expected source-save capability");
		expect(capability.path).toBe(join(realpathSync(root), "missing.md"));
		expect(capability.hash).toMatch(/^sha256:/);
		expect(capability.eol).toBe("crlf");
		expect(capability.size).toBe(Buffer.byteLength("Recovered\r\n", "utf8"));
	});

	test("saves atomically when the base hash matches", () => {
		const root = tempRoot();
		const filePath = join(root, "plan.md");
		writeFileSync(filePath, "# Plan\n\nBefore\n");
		const before = readSourceFileSnapshot(filePath);

		const result = saveSourceFileAtomic(filePath, "# Plan\n\nAfter\n", before.hash);

		expect(result.ok).toBe(true);
		expect(readFileSync(filePath, "utf8")).toBe("# Plan\n\nAfter\n");
	});

	test("preserves CRLF files on save", () => {
		const root = tempRoot();
		const filePath = join(root, "plan.md");
		writeFileSync(filePath, "# Plan\r\n\r\nBefore\r\n");
		const before = readSourceFileSnapshot(filePath);

		const result = saveSourceFileAtomic(filePath, "# Plan\n\nAfter\n", before.hash);

		expect(result.ok).toBe(true);
		expect(readFileSync(filePath, "utf8")).toBe("# Plan\r\n\r\nAfter\r\n");
	});

	test("detects hash conflicts instead of clobbering external edits", () => {
		const root = tempRoot();
		const filePath = join(root, "plan.md");
		writeFileSync(filePath, "Before\n");
		const before = readSourceFileSnapshot(filePath);
		writeFileSync(filePath, "External change\n");

		const result = saveSourceFileAtomic(filePath, "My change\n", before.hash);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe("conflict");
			if (result.code !== "conflict") throw new Error("expected conflict");
			expect(result.currentText).toBe("External change\n");
			expect(result.currentHash).toMatch(/^sha256:/);
			expect(typeof result.currentMtimeMs).toBe("number");
			expect(result.currentSize).toBe("External change\n".length);
			expect(result.currentEol).toBe("lf");
		}
		expect(readFileSync(filePath, "utf8")).toBe("External change\n");
	});

	test("recreates a missing source file only when explicitly allowed", () => {
		const root = tempRoot();
		const filePath = join(root, "plan.md");
		writeFileSync(filePath, "Before\r\n");
		const before = readSourceFileSnapshot(filePath);
		unlinkSync(filePath);

		const blocked = saveSourceFileAtomic(filePath, "After\n", before.hash);
		expect(blocked.ok).toBe(false);
		expect(() => readFileSync(filePath, "utf8")).toThrow();

		const recreated = saveSourceFileAtomic(filePath, "After\n", before.hash, {
			allowMissingBase: true,
			missingBaseEol: before.eol,
			allowedRoot: root,
		});

		expect(recreated.ok).toBe(true);
		expect(readFileSync(filePath, "utf8")).toBe("After\r\n");
	});

	test("refuses to save or recreate files outside the allowed root", () => {
		const root = tempRoot();
		const outside = tempRoot();
		const existingPath = join(outside, "existing.md");
		const missingPath = join(outside, "missing.md");
		writeFileSync(existingPath, "Before\n");
		const before = readSourceFileSnapshot(existingPath);

		const existing = saveSourceFileAtomic(existingPath, "After\n", before.hash, {
			allowedRoot: root,
		});
		const missing = saveSourceFileAtomic(missingPath, "After\n", "sha256:missing-base", {
			allowMissingBase: true,
			allowedRoot: root,
		});

		expect(existing.ok).toBe(false);
		if (!existing.ok) expect(existing.code).toBe("not-writable");
		expect(readFileSync(existingPath, "utf8")).toBe("Before\n");
		expect(missing.ok).toBe(false);
		if (!missing.ok) expect(missing.code).toBe("not-writable");
		expect(() => readFileSync(missingPath, "utf8")).toThrow();
	});

	test.skipIf(process.platform === "win32")("does not replace an occupied missing path while recreating a file", () => {
		const root = tempRoot();
		const filePath = join(root, "plan.md");
		symlinkSync(join(root, "missing-target.md"), filePath);

		const result = saveSourceFileAtomic(filePath, "After\n", "sha256:missing-base", {
			allowMissingBase: true,
			allowedRoot: root,
		});

		expect(result.ok).toBe(false);
		expect(lstatSync(filePath).isSymbolicLink()).toBe(true);
		expect(() => readFileSync(filePath, "utf8")).toThrow();
	});

	test.skipIf(process.platform === "win32")("does not treat an unreadable existing file as missing", () => {
		const root = tempRoot();
		const filePath = join(root, "plan.md");
		writeFileSync(filePath, "Before\n");
		const before = readSourceFileSnapshot(filePath);

		try {
			chmodSync(filePath, 0o000);
			const result = saveSourceFileAtomic(filePath, "After\n", before.hash, {
				allowMissingBase: true,
				missingBaseEol: before.eol,
			});

			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.code).toBe("not-writable");
		} finally {
			chmodSync(filePath, 0o600);
		}

		expect(readFileSync(filePath, "utf8")).toBe("Before\n");
	});

	test("rejects folder source paths that resolve outside the folder through a symlink", () => {
		const root = tempRoot();
		const folder = join(root, "docs");
		const outside = join(root, "outside");
		mkdirSync(folder);
		mkdirSync(outside);
		writeFileSync(join(outside, "secret.md"), "secret\n");
		symlinkSync(outside, join(folder, "linked"));

		const resolved = resolveFolderSourceFile(resolve(folder, "linked/secret.md"), folder);

		expect(resolved).toBeNull();
	});

	test("resolves missing folder source leaves without following symlinked parents outside the folder", () => {
		const root = tempRoot();
		const folder = join(root, "docs");
		const outside = join(root, "outside");
		mkdirSync(folder);
		mkdirSync(outside);
		symlinkSync(outside, join(folder, "linked"));

		expect(resolveFolderSourceFileForSave(join(folder, "new.md"), folder)).toBe(join(realpathSync(folder), "new.md"));
		expect(resolveFolderSourceFileForSave(join(folder, "linked", "new.md"), folder)).toBeNull();
	});
});
