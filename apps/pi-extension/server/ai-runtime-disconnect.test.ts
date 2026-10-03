import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("handlePiAIRequest client disconnect", () => {
	// Pi runs this server under Node, and Bun's node:http shim does not report
	// a client disconnect on the response, so the check runs in a real Node.
	const node = Bun.which("node");

	test.skipIf(!node)("cancels the endpoint's stream when the browser goes away mid-answer", async () => {
		const dir = mkdtempSync(join(tmpdir(), "plannotator-pi-ai-disconnect-"));
		tempDirs.push(dir);
		const runner = join(dir, "runner.mjs");
		const runtimeUrl = pathToFileURL(join(import.meta.dir, "ai-runtime.ts")).href;
		writeFileSync(runner, `
			import { createServer } from "node:http";
			import { handlePiAIRequest } from ${JSON.stringify(runtimeUrl)};
			let cancelled = false;
			const runtime = {
				dispose() {},
				endpoints: {
					"/api/ai/query": async () => new Response(new ReadableStream({
						start(controller) { controller.enqueue(new TextEncoder().encode("data: {}\\n\\n")); },
						cancel() { cancelled = true; },
					}), { headers: { "Content-Type": "text/event-stream" } }),
				},
			};
			const server = createServer((req, res) => {
				void handlePiAIRequest(req, res, new URL(req.url, "http://localhost"), runtime);
			});
			await new Promise((r) => server.listen(0, "127.0.0.1", r));
			const controller = new AbortController();
			const res = await fetch("http://127.0.0.1:" + server.address().port + "/api/ai/query", {
				method: "POST", body: "{}", signal: controller.signal,
			});
			await res.body.getReader().read();
			controller.abort();
			for (let i = 0; i < 100 && !cancelled; i++) await new Promise((r) => setTimeout(r, 10));
			console.log(JSON.stringify({ cancelled }));
			server.close();
			process.exit(0);
		`);
		const proc = Bun.spawn([node!, runner], { stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(exitCode, stderr).toBe(0);
		expect(JSON.parse(stdout.trim().split("\n").at(-1)!)).toEqual({ cancelled: true });
	}, 20_000);
});
