/**
 * Pi (Node) mirror of the Bun "OpenCode runs in the review's cwd" launch test
 * (packages/server/agent-jobs-launch.test.ts, #1609).
 *
 * OpenCode v2's `run` rejects `--dir`, so the review directory reaches OpenCode
 * ONLY as the spawned process's cwd. A fake `opencode` on PATH prints its
 * physical working directory and argv; the job must run in the review cwd (not
 * the server's) and receive no `--dir`.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMarkerCommand, MARKER_ENGINES } from "../generated/marker-review.ts";
import { createAgentJobHandler } from "./agent-jobs.ts";
import { requestUrl } from "./helpers.ts";

describe("pi agent jobs: OpenCode runs in the review's cwd (#1609)", () => {
	test("the opencode job spawns with the build result's cwd and no --dir", async () => {
		if (process.platform === "win32") return; // the fake binary is a POSIX shell script

		const root = mkdtempSync(join(tmpdir(), "plannotator-pi-opencode-cwd-"));
		const binDir = join(root, "bin");
		const reviewCwd = join(root, "review-checkout");
		const serverCwd = join(root, "server-cwd");
		for (const dir of [binDir, reviewCwd, serverCwd]) mkdirSync(dir);
		const fake = join(binDir, "opencode");
		writeFileSync(fake, '#!/bin/sh\necho "CWD:$(pwd -P)"\nfor a in "$@"; do echo "ARG:$a"; done\n');
		chmodSync(fake, 0o755);

		const realPath = process.env.PATH;
		// Capability detection (`which opencode`) runs when the handler is
		// created, so PATH must already carry the fake binary.
		process.env.PATH = `${binDir}:${realPath ?? ""}`;
		const server = createServer();
		try {
			let stdout: string | undefined;
			let done: (() => void) | undefined;
			const completed = new Promise<void>((resolve) => {
				done = resolve;
			});
			const handler = createAgentJobHandler({
				mode: "review",
				getServerUrl: () => "http://localhost:1234",
				getCwd: () => serverCwd,
				async buildCommand() {
					// The shape serverReview.ts's marker-engine branch returns.
					const { command } = buildMarkerCommand(MARKER_ENGINES.opencode, "review this", undefined, reviewCwd);
					return { command, prompt: "review this", cwd: reviewCwd, captureStdout: true };
				},
				async onJobComplete(_job, meta) {
					stdout = meta.stdout;
					done?.();
				},
			});
			server.on("request", async (req, res) => {
				if (!(await handler.handle(req, res, requestUrl(req)))) {
					res.writeHead(404);
					res.end();
				}
			});
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("no port");

			const res = await fetch(`http://127.0.0.1:${address.port}/api/agents/jobs`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ provider: "opencode" }),
			});
			expect(res.status).toBe(201);
			await completed;
			const lines = (stdout ?? "").trim().split("\n");
			expect(lines[0]).toBe(`CWD:${realpathSync(reviewCwd)}`);
			const args = lines.slice(1).map((line) => line.replace(/^ARG:/, ""));
			expect(args[0]).toBe("run");
			expect(args).not.toContain("--dir");
			expect(args[args.length - 1]).toBe("review this");
			handler.killAll();
		} finally {
			process.env.PATH = realPath;
			await new Promise<void>((resolve) => server.close(() => resolve()));
			rmSync(root, { recursive: true, force: true });
		}
	});
});
