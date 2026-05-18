import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { handleFileBrowserFiles } from "./reference-handlers";

let tempDirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "plannotator-reference-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
	tempDirs = [];
});

describe("handleFileBrowserFiles", () => {
	test("resolves relative directories against the session project root", async () => {
		const root = tempDir();
		const project = join(root, "project");
		const docs = join(project, "docs");
		mkdirSync(docs, { recursive: true });
		writeFileSync(join(docs, "guide.md"), "# Guide\n", "utf-8");

		const res = await handleFileBrowserFiles(
			new Request("http://localhost/api/file-browser/files?dirPath=docs"),
			project,
		);
		const bodyText = JSON.stringify(await res.json());

		expect(res.status).toBe(200);
		expect(bodyText).toContain("guide.md");
	});
});
