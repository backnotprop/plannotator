import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import { getGitMetadataWatchPaths, getWorkspaceStatusForDirectory, getWorkspaceStatusRelativePaths } from "./workspace-status";

const tempDirs: string[] = [];
const originalPath = process.env.PATH;
const originalGitTimeout = process.env.PLANNOTATOR_GIT_TIMEOUT_MS;

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function tempRepo(): string {
	const dir = makeTempDir("plannotator-workspace-status-");
	git(dir, "init", "-b", "main");
	git(dir, "config", "user.email", "test@test");
	git(dir, "config", "user.name", "Test");
	return dir;
}

function git(cwd: string, ...args: string[]): void {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	}
}

function findGit(): string {
	const command = process.platform === "win32" ? "where.exe" : "which";
	const result = spawnSync(command, ["git"], { encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(result.stderr || "Unable to find git");
	}
	return result.stdout.split(/\r?\n/).find(Boolean)?.trim() ?? "";
}

async function waitForFile(path: string): Promise<void> {
	for (let i = 0; i < 50; i++) {
		if (existsSync(path)) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`Timed out waiting for ${path}`);
}

function installDelayedStatusGitWrapper(wrapperDir: string, signalPath: string): void {
	const realGit = findGit();
	const scriptPath = join(wrapperDir, "git-wrapper.mjs");
	const releasePath = `${signalPath}.release`;
	writeFileSync(
		scriptPath,
		[
			'import { spawnSync } from "node:child_process";',
			'import { existsSync, writeFileSync } from "node:fs";',
			`const realGit = ${JSON.stringify(realGit)};`,
			`const signal = ${JSON.stringify(signalPath)};`,
			`const release = ${JSON.stringify(releasePath)};`,
			"const args = process.argv.slice(2);",
			"const result = spawnSync(realGit, args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });",
			"if (result.error) {",
			"  process.stderr.write(result.error.message);",
			"  process.exit(1);",
			"}",
			"if (args.includes('status')) {",
			"  writeFileSync(signal, 'done');",
			"  const started = Date.now();",
			"  while (!existsSync(release) && Date.now() - started < 2000) {",
			"    await Bun.sleep(10);",
			"  }",
			"}",
			"process.stdout.write(result.stdout ?? '');",
			"process.stderr.write(result.stderr ?? '');",
			"process.exit(result.status ?? 1);",
			"",
		].join("\n"),
	);
	const gitPath = join(wrapperDir, "git");
	writeFileSync(gitPath, ["#!/usr/bin/env sh", `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)} "$@"`, ""].join("\n"));
	chmodSync(gitPath, 0o755);
	writeFileSync(join(wrapperDir, "git.cmd"), [`@echo off`, `"${process.execPath}" "${scriptPath}" %*`, ""].join("\r\n"));
	process.env.PATH = [wrapperDir, originalPath].filter(Boolean).join(delimiter);
}

function installHangingOnceStatusGitWrapper(wrapperDir: string, markerPath: string): void {
	const realGit = findGit();
	const scriptPath = join(wrapperDir, "git-wrapper.mjs");
	writeFileSync(
		scriptPath,
		[
			'import { spawnSync } from "node:child_process";',
			'import { existsSync, writeFileSync } from "node:fs";',
			`const realGit = ${JSON.stringify(realGit)};`,
			`const marker = ${JSON.stringify(markerPath)};`,
			"const args = process.argv.slice(2);",
			"if (args.includes('status') && !existsSync(marker)) {",
			"  writeFileSync(marker, 'hung');",
			"  await new Promise(() => {});",
			"}",
			"const result = spawnSync(realGit, args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });",
			"if (result.error) {",
			"  process.stderr.write(result.error.message);",
			"  process.exit(1);",
			"}",
			"process.stdout.write(result.stdout ?? '');",
			"process.stderr.write(result.stderr ?? '');",
			"process.exit(result.status ?? 1);",
			"",
		].join("\n"),
	);
	const gitPath = join(wrapperDir, "git");
	writeFileSync(gitPath, ["#!/usr/bin/env sh", `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)} "$@"`, ""].join("\n"));
	chmodSync(gitPath, 0o755);
	writeFileSync(join(wrapperDir, "git.cmd"), [`@echo off`, `"${process.execPath}" "${scriptPath}" %*`, ""].join("\r\n"));
	process.env.PATH = [wrapperDir, originalPath].filter(Boolean).join(delimiter);
}

afterEach(() => {
	if (originalPath === undefined) {
		delete process.env.PATH;
	} else {
		process.env.PATH = originalPath;
	}
	if (originalGitTimeout === undefined) {
		delete process.env.PLANNOTATOR_GIT_TIMEOUT_MS;
	} else {
		process.env.PLANNOTATOR_GIT_TIMEOUT_MS = originalGitTimeout;
	}
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("workspace status", () => {
	test("reports git changes under the requested directory and clears after commit", async () => {
		const repo = tempRepo();
		const docs = join(repo, "docs");
		mkdirSync(docs);
		writeFileSync(join(docs, "plan.md"), "one\ntwo\n");
		writeFileSync(join(docs, "gone.md"), "remove me\n");
		writeFileSync(join(repo, "outside.md"), "outside\n");
		git(repo, "add", "-A");
		git(repo, "commit", "-m", "init");

		writeFileSync(join(docs, "plan.md"), "one\nTWO\nthree\n");
		unlinkSync(join(docs, "gone.md"));
		writeFileSync(join(docs, "new.md"), "alpha\nbeta\n");
		writeFileSync(join(repo, "outside.md"), "outside changed\n");

		const status = await getWorkspaceStatusForDirectory(docs);
		const realDocs = realpathSync(docs);

		expect(status.available).toBe(true);
		expect(Object.keys(status.files).sort()).toEqual([
			join(realDocs, "gone.md"),
			join(realDocs, "new.md"),
			join(realDocs, "plan.md"),
		].sort());
		expect(status.files[join(realDocs, "plan.md")]?.status).toBe("modified");
		expect(status.files[join(realDocs, "plan.md")]?.additions).toBe(2);
		expect(status.files[join(realDocs, "plan.md")]?.deletions).toBe(1);
		expect(status.files[join(realDocs, "gone.md")]?.status).toBe("deleted");
		expect(status.files[join(realDocs, "gone.md")]?.deletions).toBe(1);
		expect(status.files[join(realDocs, "new.md")]?.status).toBe("untracked");
		expect(status.files[join(realDocs, "new.md")]?.additions).toBe(2);
		expect(getWorkspaceStatusRelativePaths(status, docs).sort()).toEqual([
			"gone.md",
			"new.md",
			"plan.md",
		]);

		git(repo, "add", "-A");
		git(repo, "commit", "-m", "changes");

		const afterCommit = await getWorkspaceStatusForDirectory(docs);
		expect(afterCommit.available).toBe(true);
		expect(afterCommit.totals.files).toBe(0);
		expect(afterCommit.files).toEqual({});
	});

	test("keeps line counts for renamed files with edits", async () => {
		const repo = tempRepo();
		const docs = join(repo, "docs");
		mkdirSync(docs);
		writeFileSync(join(docs, "old.md"), "one\ntwo\nthree\n");
		git(repo, "add", "-A");
		git(repo, "commit", "-m", "init");

		git(repo, "mv", join("docs", "old.md"), join("docs", "new.md"));
		writeFileSync(join(docs, "new.md"), "one\nTWO\nthree\nfour\n");

		const status = await getWorkspaceStatusForDirectory(docs);
		const realDocs = realpathSync(docs);
		const change = status.files[join(realDocs, "new.md")];

		expect(status.available).toBe(true);
		expect(change?.status).toBe("renamed");
		expect(change?.oldPath).toBe(join(realDocs, "old.md"));
		expect(change?.additions).toBe(2);
		expect(change?.deletions).toBe(1);
		expect(status.totals.additions).toBe(2);
		expect(status.totals.deletions).toBe(1);
	});

	test("resolves git metadata paths when watching a repository subdirectory", () => {
		const repo = tempRepo();
		const subdir = join(repo, "docs", "sub");
		mkdirSync(subdir, { recursive: true });
		writeFileSync(join(subdir, "plan.md"), "# Plan\n");
		git(repo, "add", "-A");
		git(repo, "commit", "-m", "init");

		const paths = getGitMetadataWatchPaths(subdir);
		const realRepo = realpathSync(repo);

		expect(paths).toContain(join(realRepo, ".git", "refs"));
	});

	test("counts staged and unstaged changes when the net diff against HEAD is empty", async () => {
		const repo = tempRepo();
		const docs = join(repo, "docs");
		mkdirSync(docs);
		writeFileSync(join(docs, "plan.md"), "one\ntwo\n");
		git(repo, "add", "-A");
		git(repo, "commit", "-m", "init");

		writeFileSync(join(docs, "plan.md"), "ONE\ntwo\n");
		git(repo, "add", join("docs", "plan.md"));
		writeFileSync(join(docs, "plan.md"), "one\ntwo\n");

		const status = await getWorkspaceStatusForDirectory(docs);
		const realDocs = realpathSync(docs);
		const change = status.files[join(realDocs, "plan.md")];

		expect(status.available).toBe(true);
		expect(change?.status).toBe("modified");
		expect(change?.staged).toBe(true);
		expect(change?.unstaged).toBe(true);
		expect(change?.additions).toBe(2);
		expect(change?.deletions).toBe(2);
		expect(status.totals.additions).toBe(2);
		expect(status.totals.deletions).toBe(2);
	});

	test("runs a trailing status when a request arrives during an active status", async () => {
		const repo = tempRepo();
		const docs = join(repo, "docs");
		mkdirSync(docs);
		writeFileSync(join(docs, "plan.md"), "one\n");
		git(repo, "add", "-A");
		git(repo, "commit", "-m", "init");

		const wrapperDir = makeTempDir("plannotator-git-wrapper-");
		const signalPath = join(wrapperDir, "status-started");
		installDelayedStatusGitWrapper(wrapperDir, signalPath);

		const first = getWorkspaceStatusForDirectory(docs);
		await waitForFile(signalPath);
		writeFileSync(join(docs, "new.md"), "new\n");
		const second = getWorkspaceStatusForDirectory(docs);
		writeFileSync(`${signalPath}.release`, "go");

		const status = await second;
		const realDocs = realpathSync(docs);

		expect(status.files[join(realDocs, "new.md")]?.status).toBe("untracked");
		expect(await first).toBe(status);
	});

	test("clears the in-flight status after git times out", async () => {
		const repo = tempRepo();
		const docs = join(repo, "docs");
		mkdirSync(docs);
		writeFileSync(join(docs, "plan.md"), "one\n");
		git(repo, "add", "-A");
		git(repo, "commit", "-m", "init");

		const wrapperDir = makeTempDir("plannotator-git-timeout-");
		const markerPath = join(wrapperDir, "status-hung");
		installHangingOnceStatusGitWrapper(wrapperDir, markerPath);
		process.env.PLANNOTATOR_GIT_TIMEOUT_MS = "1000";

		const timedOut = await getWorkspaceStatusForDirectory(docs);
		expect(timedOut.available).toBe(false);
		expect(timedOut.error).toContain("git timed out");

		const retried = await getWorkspaceStatusForDirectory(docs);
		expect(retried.available).toBe(true);
		expect(retried.totals.files).toBe(0);
	});
});
