import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import {
	createSourceSaveCapability,
	readSourceFileSnapshot,
	resolveFolderSourceFile,
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
});
