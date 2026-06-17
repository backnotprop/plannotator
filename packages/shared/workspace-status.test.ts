import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { getGitMetadataWatchPaths, getWorkspaceStatusForDirectory, getWorkspaceStatusRelativePaths } from "./workspace-status";

const tempDirs: string[] = [];

function tempRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "plannotator-workspace-status-"));
	tempDirs.push(dir);
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

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("workspace status", () => {
	test("reports git changes under the requested directory and clears after commit", () => {
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

		const status = getWorkspaceStatusForDirectory(docs);
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

		const afterCommit = getWorkspaceStatusForDirectory(docs);
		expect(afterCommit.available).toBe(true);
		expect(afterCommit.totals.files).toBe(0);
		expect(afterCommit.files).toEqual({});
	});

	test("keeps line counts for renamed files with edits", () => {
		const repo = tempRepo();
		const docs = join(repo, "docs");
		mkdirSync(docs);
		writeFileSync(join(docs, "old.md"), "one\ntwo\nthree\n");
		git(repo, "add", "-A");
		git(repo, "commit", "-m", "init");

		git(repo, "mv", join("docs", "old.md"), join("docs", "new.md"));
		writeFileSync(join(docs, "new.md"), "one\nTWO\nthree\nfour\n");

		const status = getWorkspaceStatusForDirectory(docs);
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

	test("counts staged and unstaged changes when the net diff against HEAD is empty", () => {
		const repo = tempRepo();
		const docs = join(repo, "docs");
		mkdirSync(docs);
		writeFileSync(join(docs, "plan.md"), "one\ntwo\n");
		git(repo, "add", "-A");
		git(repo, "commit", "-m", "init");

		writeFileSync(join(docs, "plan.md"), "ONE\ntwo\n");
		git(repo, "add", join("docs", "plan.md"));
		writeFileSync(join(docs, "plan.md"), "one\ntwo\n");

		const status = getWorkspaceStatusForDirectory(docs);
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
});
