import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { jjRuntime } from "./vcs.ts";
import { useScratchJjConfig } from "../../../tests/helpers/jj-scratch-config.ts";

const jjConfig = useScratchJjConfig();

describe("pi jj runtime output ceiling", () => {
	const testIfJj = spawnSync("jj", ["--version"], { encoding: "utf-8" }).status === 0
		? test
		: test.skip;
	let workspace = "";

	afterEach(() => {
		if (workspace) rmSync(workspace, { recursive: true, force: true });
		workspace = "";
	});

	testIfJj("stops reading and flags truncation once maxOutputBytes is passed", async () => {
		workspace = mkdtempSync(join(tmpdir(), "plannotator-pi-jj-cap-"));
		const jj = (args: string[]) => {
			const result = spawnSync("jj", args, { cwd: workspace, encoding: "utf-8", env: jjConfig.env() });
			if (result.status !== 0) throw new Error(result.stderr || `jj ${args.join(" ")} failed`);
		};
		jj(["git", "init", "."]);
		jj(["config", "set", "--repo", "user.name", "Cap Test"]);
		jj(["config", "set", "--repo", "user.email", "cap-test@example.invalid"]);
		writeFileSync(join(workspace, "big.ts"), "export const line = 1;\n".repeat(4000));
		jj(["commit", "-m", "big"]);

		const args = ["--ignore-working-copy", "diff", "--git", "--from", "root()", "--to", "@-"];
		const uncapped = await jjRuntime.runJj(args, { cwd: workspace });
		expect(uncapped.truncated).toBeUndefined();
		expect(uncapped.stdout.length).toBeGreaterThan(10_000);

		const capped = await jjRuntime.runJj(args, { cwd: workspace, maxOutputBytes: 64 });
		expect(capped.truncated).toBe(true);
		expect(capped.stdout.length).toBeLessThanOrEqual(64);
	});
});
