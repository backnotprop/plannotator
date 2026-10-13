import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRepoInfo } from "./project.ts";

const originalCwd = process.cwd();
const tempDirs: string[] = [];

afterEach(() => {
	process.chdir(originalCwd);
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("getRepoInfo", () => {
	test("reports the origin host so refs link to the right forge (#1596)", () => {
		const repoDir = mkdtempSync(join(tmpdir(), "plannotator-pi-repoinfo-"));
		tempDirs.push(repoDir);
		execFileSync("git", ["init", "-q"], { cwd: repoDir });
		execFileSync("git", ["remote", "add", "origin", "git@gitlab.com:group/subgroup/project.git"], { cwd: repoDir });
		process.chdir(repoDir);

		const info = getRepoInfo();
		expect(info?.display).toBe("group/subgroup/project");
		expect(info?.host).toBe("gitlab.com");
	});
});
