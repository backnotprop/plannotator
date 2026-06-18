import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { handleDoc, handleDocExists, handleFileBrowserFiles } from "./reference-handlers";
import type { VaultNode } from "@plannotator/shared/reference-common";
import type { WorkspaceStatusPayload } from "@plannotator/shared/workspace-status";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function writeTempFile(root: string, relativePath: string, content = "x"): string {
	const full = join(root, relativePath);
	mkdirSync(join(full, ".."), { recursive: true });
	writeFileSync(full, content);
	return full;
}

function git(cwd: string, ...args: string[]): void {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	}
}

function flattenTree(nodes: VaultNode[]): string[] {
	const paths: string[] = [];
	for (const node of nodes) {
		if (node.type === "file") paths.push(node.path);
		else paths.push(...flattenTree(node.children ?? []));
	}
	return paths;
}

async function postDocExists(body: unknown, options: { rootPath?: string; rootPaths?: string[] }) {
	const res = await handleDocExists(
		new Request("http://localhost/api/doc/exists", {
			method: "POST",
			body: JSON.stringify(body),
		}),
		options,
	);
	return res.json() as Promise<{
		results: Record<string, { status: "found"; resolved: string } | { status: "missing" }>;
	}>;
}

async function getDoc(path: string, options: { base?: string; rootPaths?: string[]; sourceSaveFilePath?: string }) {
	const url = new URL("http://localhost/api/doc");
	url.searchParams.set("path", path);
	if (options.base) url.searchParams.set("base", options.base);
	return handleDoc(new Request(url.toString()), {
		rootPaths: options.rootPaths,
		sourceSaveFilePath: options.sourceSaveFilePath,
	});
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("handleDocExists", () => {
	test("does not reveal absolute files outside the allowed root", async () => {
		const root = makeTempDir("plannotator-doc-exists-root-");
		const outside = makeTempDir("plannotator-doc-exists-outside-");
		const secret = writeTempFile(outside, "secret.ts", "secret");

		const data = await postDocExists({ paths: [secret] }, { rootPath: root });

		expect(data.results[secret]).toEqual({ status: "missing" });
	});

	test("allows absolute files inside the allowed root", async () => {
		const root = makeTempDir("plannotator-doc-exists-root-");
		const file = writeTempFile(root, "src/app.ts", "app");

		const data = await postDocExists({ paths: [file] }, { rootPath: root });

		expect(data.results[file]).toEqual({ status: "found", resolved: file });
	});

	test("ignores an out-of-root base directory", async () => {
		const root = makeTempDir("plannotator-doc-exists-root-");
		const outside = makeTempDir("plannotator-doc-exists-outside-");
		writeTempFile(outside, "secret.ts", "secret");

		const data = await postDocExists({ base: outside, paths: ["secret.ts"] }, { rootPath: root });

		expect(data.results["secret.ts"]).toEqual({ status: "missing" });
	});

	test("resolves relative paths from an in-root base directory", async () => {
		const root = makeTempDir("plannotator-doc-exists-root-");
		const app = writeTempFile(root, "src/app.ts", "app");
		const base = resolve(root, "docs/nested");
		mkdirSync(base, { recursive: true });

		const data = await postDocExists({ base, paths: ["../../src/app.ts"] }, { rootPath: root });

		expect(data.results["../../src/app.ts"]).toEqual({ status: "found", resolved: app });
	});

	test("single-file annotate can validate repo paths outside the source file directory", async () => {
		const root = makeTempDir("plannotator-doc-exists-root-");
		const app = writeTempFile(root, "src/app.ts", "app");
		const sourceDir = join(root, "docs");
		mkdirSync(sourceDir, { recursive: true });

		const data = await postDocExists(
			{ base: sourceDir, paths: ["src/app.ts"] },
			{ rootPaths: [root, sourceDir] },
		);

		expect(data.results["src/app.ts"]).toEqual({ status: "found", resolved: app });
	});

	test("does not read a document through an out-of-root base directory", async () => {
		const root = makeTempDir("plannotator-doc-root-");
		const outside = makeTempDir("plannotator-doc-outside-");
		writeTempFile(outside, "secret.md", "secret");

		const res = await getDoc("secret.md", { base: outside, rootPaths: [root] });

		expect(res.status).toBe(404);
	});

	test("single-file source document returns current source-save metadata", async () => {
		const root = makeTempDir("plannotator-doc-root-");
		const source = writeTempFile(root, "docs/source.md", "source\n");

		const res = await getDoc(source, {
			rootPaths: [root],
			sourceSaveFilePath: source,
		});
		const data = await res.json() as { markdown?: string; sourceSave?: { enabled: boolean; scope?: string; path?: string; hash?: string } };

		expect(res.status).toBe(200);
		expect(data.markdown).toBe("source\n");
		expect(data.sourceSave?.enabled).toBe(true);
		expect(data.sourceSave?.scope).toBe("single-file");
		expect(data.sourceSave?.path).toBe(realpathSync(source));
		expect(data.sourceSave?.hash).toStartWith("sha256:");
	});

	test("single-file source-save metadata is not added to other linked documents", async () => {
		const root = makeTempDir("plannotator-doc-root-");
		const source = writeTempFile(root, "docs/source.md", "source\n");
		const linked = writeTempFile(root, "docs/linked.md", "linked\n");

		const res = await getDoc(linked, {
			rootPaths: [root],
			sourceSaveFilePath: source,
		});
		const data = await res.json() as { markdown?: string; sourceSave?: unknown };

		expect(res.status).toBe(200);
		expect(data.markdown).toBe("linked\n");
		expect(data.sourceSave).toBeUndefined();
	});
});

describe("handleFileBrowserFiles", () => {
	test("returns git workspace status and keeps deleted tracked files in the tree", async () => {
		const root = makeTempDir("plannotator-files-root-");
		git(root, "init", "-b", "main");
		git(root, "config", "user.email", "test@test");
		git(root, "config", "user.name", "Test");
		writeTempFile(root, "docs/plan.md", "one\ntwo\n");
		writeTempFile(root, "docs/gone.md", "remove me\n");
		git(root, "add", "-A");
		git(root, "commit", "-m", "init");

		writeTempFile(root, "docs/plan.md", "one\nTWO\nthree\n");
		unlinkSync(join(root, "docs/gone.md"));
		writeTempFile(root, "docs/new.md", "new\n");

		const url = new URL("http://localhost/api/reference/files");
		url.searchParams.set("dirPath", join(root, "docs"));
		const res = await handleFileBrowserFiles(new Request(url.toString()));
		const data = await res.json() as { tree: VaultNode[]; workspaceStatus: WorkspaceStatusPayload };
		const realDocs = realpathSync(join(root, "docs"));

		expect(res.status).toBe(200);
		expect(flattenTree(data.tree).sort()).toEqual(["gone.md", "new.md", "plan.md"]);
		expect(data.workspaceStatus.totals.files).toBe(3);
		expect(data.workspaceStatus.files[join(realDocs, "gone.md")]?.status).toBe("deleted");
		expect(data.workspaceStatus.files[join(realDocs, "new.md")]?.status).toBe("untracked");
		expect(data.workspaceStatus.files[join(realDocs, "plan.md")]?.additions).toBe(2);
	});

	test("does not reintroduce git changes from excluded folders", async () => {
		const root = makeTempDir("plannotator-files-excluded-");
		git(root, "init", "-b", "main");
		git(root, "config", "user.email", "test@test");
		git(root, "config", "user.name", "Test");
		writeTempFile(root, "docs/visible.md", "visible\n");
		writeTempFile(root, "dist/generated.md", "before\n");
		git(root, "add", "-A");
		git(root, "commit", "-m", "init");

		writeTempFile(root, "dist/generated.md", "after\n");
		writeTempFile(root, "packages/app/node_modules/pkg/readme.md", "hidden\n");

		const url = new URL("http://localhost/api/reference/files");
		url.searchParams.set("dirPath", root);
		const res = await handleFileBrowserFiles(new Request(url.toString()));
		const data = await res.json() as { tree: VaultNode[]; workspaceStatus: WorkspaceStatusPayload };

		expect(res.status).toBe(200);
		expect(flattenTree(data.tree).sort()).toEqual(["docs/visible.md"]);
		expect(data.workspaceStatus.totals.files).toBe(0);
		expect(data.workspaceStatus.files).toEqual({});
	});
});
